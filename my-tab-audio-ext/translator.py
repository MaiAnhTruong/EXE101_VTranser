#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
translator.py — Realtime EN→VI translator (CTranslate2) với luật gom cụm 2 từ/1 lần, mặc định chạy CPU (INT8).

Giao thức WS (client <-> server):
- Client gửi:
    {"type":"patch", "delete": <int>, "insert": "<str>"}   # áp thay đổi lên đuôi tiếng Anh
    {"type":"stable","full":"<str>"}                       # bản đầy đủ ổn định (tùy chọn)
    {"type":"reset"}                                       # xoá trạng thái

- Server trả:
    {"type":"vi-delta","append":"<vi_text>"}               # CHỈ append (không rút lại)
    {"type":"hello","detail":{...}}
    {"type":"status","detail":{...}}
    {"type":"error","error":"<msg>"}

Luật cắt cụm:
- Trong 1 run không dấu câu: ghép theo cặp (w1 w2), (w3 w4), ...
- Nếu còn 1 từ lẻ ở CUỐI run (chưa có từ kế tiếp) → CHƯA dịch.
- Ngoại lệ: nếu ngay sau từ có dấu câu (.,!?…;:) → CHO PHÉP phát 1 cụm đơn (vd "Hello,").
- Dịch EN→VI bằng CTranslate2 + SentencePiece. Output luôn append-only.

ENV (khuyên dùng để tách GPU cho STT và CPU cho dịch):
  TR_HOST=0.0.0.0
  TR_PORT=8766

  # Model & thiết bị
  CT2_MODEL=/path/to/ctranslate2/model
  TRANSLATOR_FORCE_CPU=1          # <== Mặc định 1: luôn chạy CPU, bỏ qua CT2_DEVICE
  CT2_DEVICE=cpu                  # vẫn nên đặt là cpu cho rõ ràng
  CT2_COMPUTE=int8                # int8 nhanh trên CPU, giữ độ trễ thấp

  # Threads (tối ưu độ trễ real-time)
  CT2_INTER_THREADS=1             # pipeline song song cấp cao (để 1 cho latency thấp)
  CT2_INTRA_THREADS=4             # số thread toán học (chọn 3-6 tuỳ CPU)
  OMP_NUM_THREADS=4               # (tùy) đồng bộ với INTRA để tránh oversubscribe

  # SentencePiece (nếu model không kèm spm.model)
  SPM_SRC=/path/to/source.spm
  SPM_TGT=/path/to/target.spm
  MT_PREFIX=">>vie<<"             # nếu model yêu cầu; mặc định rỗng

  # Ghi file
  VI_OUTPUT_PATH=translator_vi.txt
  VI_TRUNCATE_ON_START=1
"""

import os
import sys
import re
import asyncio
import logging
import time
from dataclasses import dataclass
from typing import List, Tuple, Optional

import websockets

# ---------- Logging ----------
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
logger = logging.getLogger("rt-translator")
logger.setLevel(getattr(logging, LOG_LEVEL, logging.INFO))
_sh = logging.StreamHandler(sys.stderr)
_sh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
logger.addHandler(_sh)

# ---------- Config ----------
TR_HOST = os.getenv("TR_HOST", "0.0.0.0")
TR_PORT = int(os.getenv("TR_PORT", "8766"))

CT2_MODEL = os.getenv("CT2_MODEL", "").strip()

# Quan trọng: mặc định ép CPU để tránh tranh chấp GPU với STT
TRANSLATOR_FORCE_CPU = os.getenv("TRANSLATOR_FORCE_CPU", "1").strip().lower() in {"1","true","yes"}

# Nếu vẫn muốn linh hoạt, vẫn đọc CT2_DEVICE/COMPUTE, nhưng default nghiêng về CPU+INT8
CT2_DEVICE = os.getenv("CT2_DEVICE", "cpu").strip().lower()
CT2_COMPUTE = os.getenv("CT2_COMPUTE", "int8").strip().lower()

# Threads cho CT2 (giảm độ trễ)
def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "").strip() or default)
    except Exception:
        return default

CPU_COUNT = os.cpu_count() or 4
CT2_INTER_THREADS = _int_env("CT2_INTER_THREADS", 1)
CT2_INTRA_THREADS = _int_env("CT2_INTRA_THREADS", min(4, max(1, CPU_COUNT // 2)))

SPM_SRC = os.getenv("SPM_SRC", "").strip()
SPM_TGT = os.getenv("SPM_TGT", "").strip()
MT_PREFIX = os.getenv("MT_PREFIX", "").strip()

VI_OUTPUT_PATH = os.getenv("VI_OUTPUT_PATH", "translator_vi.txt").strip()
VI_TRUNCATE_ON_START = os.getenv("VI_TRUNCATE_ON_START", "1").strip().lower() in {"1","true","yes"}

# ---------- Lazy MT init ----------
_ct2 = None
_sp_src = None
_sp_tgt = None

def _lazy_init_mt():
    """Khởi tạo CTranslate2 + SentencePiece khi lần đầu cần dịch."""
    global _ct2, _sp_src, _sp_tgt
    if _ct2 is not None:
        return
    if not CT2_MODEL:
        raise RuntimeError("CT2_MODEL chưa được cấu hình.")

    import ctranslate2
    # Quyết định thiết bị cuối cùng
    device_final = "cpu" if TRANSLATOR_FORCE_CPU else ("cpu" if CT2_DEVICE != "cuda" else "cuda")
    compute_final = CT2_COMPUTE
    try:
        _ct2 = ctranslate2.Translator(
            CT2_MODEL,
            device=device_final,
            compute_type=compute_final,
            inter_threads=CT2_INTER_THREADS,
            intra_threads=CT2_INTRA_THREADS,
        )
        logger.info("[CT2] device=%s compute=%s inter=%d intra=%d",
                    device_final, compute_final, CT2_INTER_THREADS, CT2_INTRA_THREADS)
    except Exception as e:
        # Fallback an toàn: CPU + int8
        if device_final != "cpu" or compute_final != "int8":
            logger.warning("[CT2] init failed (%s). Falling back to CPU/int8.", e)
            _ct2 = ctranslate2.Translator(
                CT2_MODEL,
                device="cpu",
                compute_type="int8",
                inter_threads=CT2_INTER_THREADS,
                intra_threads=CT2_INTRA_THREADS,
            )
        else:
            raise RuntimeError(f"Không khởi tạo được CTranslate2: {e}")

    # SentencePiece
    import sentencepiece as spm
    def _pick(*names: str) -> Optional[str]:
        for name in names:
            if not name:
                continue
            if os.path.isabs(name) and os.path.isfile(name):
                return name
            cand = os.path.join(CT2_MODEL, name)
            if os.path.isfile(cand):
                return cand
        return None

    src_path = SPM_SRC or _pick("source.spm", "src.spm", "spm.model")
    tgt_path = SPM_TGT or _pick("target.spm", "tgt.spm", "spm.model") or src_path
    if not src_path or not os.path.isfile(src_path):
        raise RuntimeError("Không tìm thấy SentencePiece SRC model.")
    if not tgt_path or not os.path.isfile(tgt_path):
        raise RuntimeError("Không tìm thấy SentencePiece TGT model.")

    _sp_src = spm.SentencePieceProcessor(model_file=src_path)
    _sp_tgt = spm.SentencePieceProcessor(model_file=tgt_path)

# ---------- Unicode regex ----------
try:
    import regex as reu
    _HAS_REGEX = True
    WORD = r"[\p{L}\p{M}\p{N}’'_]+"
    PUNCT = r"[.,!?…;:]+|[\"“”()–—-]"
    W_RE = reu.compile(f"({WORD})|({PUNCT})", reu.UNICODE)
except Exception:
    _HAS_REGEX = False
    WORD = r"[A-Za-z0-9’'_]+"
    PUNCT = r"[.,!?;:]+|[\"()\-]"
    W_RE = re.compile(f"({WORD})|({PUNCT})", re.UNICODE)

@dataclass
class Unit:
    start: int
    end: int
    text: str  # raw substring EN

def _segment_units(en_text: str) -> List[Unit]:
    """
    Convert EN text -> Units theo luật 2 từ/1 lần (punct cho phép 1 từ đơn).
    """
    tokens = list(W_RE.finditer(en_text or ""))
    units: List[Unit] = []
    run: List[Tuple[int, int]] = []

    def flush_run(allow_single_last: bool):
        nonlocal run, units
        if not run:
            return
        n = len(run)
        last_single = (n % 2 == 1)
        limit = n if (allow_single_last or not last_single) else n - 1
        i = 0
        while i + 1 < limit:
            s1, e1 = run[i]
            s2, e2 = run[i + 1]
            units.append(Unit(start=s1, end=e2, text=en_text[s1:e2]))
            i += 2
        if allow_single_last and i < n:
            s, e = run[i]
            units.append(Unit(start=s, end=e, text=en_text[s:e]))
        run.clear()

    for m in tokens:
        if m.group(1):  # word
            s, e = m.span(1)
            run.append((s, e))
        elif m.group(2):  # punct
            flush_run(allow_single_last=True)

    flush_run(allow_single_last=False)  # end: no single
    return units

# ---------- Stream state ----------
class StreamState:
    def __init__(self):
        self.en_text: str = ""
        self.units_emitted: int = 0
        self.vi_text_full: str = ""
        self.last_status_t: float = time.monotonic()

    def apply_patch(self, delete: int, insert: str):
        if delete > 0:
            self.en_text = self.en_text[:-min(delete, len(self.en_text))]
        if insert:
            self.en_text += insert

    def set_full(self, full: str):
        if isinstance(full, str) and len(full) >= len(self.en_text):
            self.en_text = full

# ---------- Translate batch ----------
def _mt_translate_many(src_segments: List[str]) -> List[str]:
    if not src_segments:
        return []
    _lazy_init_mt()

    # tokenize
    src_tok = []
    for s in src_segments:
        toks = _sp_src.encode(s, out_type=str)
        if MT_PREFIX:
            toks = [MT_PREFIX] + toks
        src_tok.append(toks)

    # Dịch: beam_size=1 để latency thấp; tắt score
    results = _ct2.translate_batch(
        src_tok,
        beam_size=1,
        max_decoding_length=128,
        repetition_penalty=1.05,
        disable_unk=True,
        return_scores=False,
    )

    outs = []
    for r in results:
        hyp = r.hypotheses[0] if hasattr(r, "hypotheses") else r[0]
        outs.append(_sp_tgt.decode(hyp))
    return outs

def _json_str(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'

# ---------- File output ----------
def _prepare_output_file(path: str, truncate: bool = True):
    try:
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    except Exception:
        pass
    if truncate:
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write("")
        except Exception as e:
            logger.warning("Không thể truncate file dịch: %s", e)

_prepare_output_file(VI_OUTPUT_PATH, truncate=VI_TRUNCATE_ON_START)

async def _write_vi_append(text: str):
    if not text:
        return
    try:
        with open(VI_OUTPUT_PATH, "a", encoding="utf-8") as f:
            f.write(text)
    except Exception as e:
        logger.warning("Ghi file dịch lỗi: %s", e)

# ---------- WS Handler ----------
async def handler(websocket):
    state = StreamState()
    logger.info("[Conn] open from %s", getattr(websocket, "remote_address", None))
    await websocket.send(
        '{"type":"hello","detail":{"lang_src":"en","lang_tgt":"vi","pair_size":2,"append_only":true}}'
    )

    try:
        async for raw in websocket:
            if isinstance(raw, bytes):
                continue
            try:
                import json
                msg = json.loads(raw)
            except Exception:
                continue

            mtype = (msg.get("type") or msg.get("event") or "").lower().strip()
            if mtype == "reset":
                state = StreamState()
                continue
            elif mtype == "patch":
                delete = int(msg.get("delete") or 0)
                insert = str(msg.get("insert") or "")
                state.apply_patch(delete, insert)
            elif mtype == "stable":
                full = str(msg.get("full") or "")
                state.set_full(full)
            else:
                continue

            # Segment & emit units mới
            units = _segment_units(state.en_text)
            new_units = units[state.units_emitted:] if state.units_emitted < len(units) else []
            state.units_emitted = len(units)

            if new_units:
                en_batch = [u.text for u in new_units]
                try:
                    vi_batch = _mt_translate_many(en_batch)
                except Exception as e:
                    await websocket.send(
                        '{"type":"error","error":"Translation failed: ' + str(e).replace('"','\\"') + '"}'
                    )
                    vi_batch = []

                if vi_batch:
                    vi_append = "".join(v + (" " if not v.endswith(('.', '!', '?')) else "") for v in vi_batch)
                    state.vi_text_full += vi_append
                    await _write_vi_append(vi_append)
                    await websocket.send('{"type":"vi-delta","append":' + _json_str(vi_append) + "}")

            # status ~200ms
            now = time.monotonic()
            if now - state.last_status_t >= 0.2:
                try:
                    await websocket.send(
                        '{"type":"status","detail":{"en_len":%d,"units":%d,"vi_len":%d}}'
                        % (len(state.en_text), state.units_emitted, len(state.vi_text_full))
                    )
                except Exception:
                    pass
                state.last_status_t = now

    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as e:
        logger.error("WS error: %s", e, exc_info=True)
    finally:
        logger.info("[Conn] close")

# ---------- Entrypoint ----------
async def main():
    logger.info(
        "[Startup] Translator WS at ws://%s:%d (output: %s) [force_cpu=%s, inter=%d, intra=%d, compute=%s]",
        TR_HOST, TR_PORT, VI_OUTPUT_PATH, str(TRANSLATOR_FORCE_CPU),
        CT2_INTER_THREADS, CT2_INTRA_THREADS, CT2_COMPUTE
    )
    async with websockets.serve(handler, TR_HOST, TR_PORT, max_size=None, ping_interval=20, ping_timeout=20):
        await asyncio.Future()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
