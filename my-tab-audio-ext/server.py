#/home/truong/EXE/my-tab-audio-ext/server.py:
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Realtime STT WebSocket server (RealtimeSTT only)

Yêu cầu & hành vi:
- Chỉ sửa trong cửa sổ N token cuối (MUTABLE_WINDOW_TOKENS, mặc định 7; khuyến nghị 5–7).
- Thuật toán patch trong cửa sổ:
  * Tính overlap l giữa đuôi-cũ và đầu-mới (so theo token chuẩn hoá).
  * Nếu l > 0: XOÁ phần đuôi-cũ sau l (đúng số ký tự đã emit) + APPEND phần mới sau l.
    (ví dụ “… you speak , the more” + “… the more comfortable” → xoá “you speak,” → chèn “comfortable”)
  * Nếu l == 0: COI NHƯ ĐOẠN MỚI → KHÔNG XOÁ, chỉ APPEND (có SPACE_GUARD tránh dính chữ).
- Ghi transcript **real-time theo patch**: mỗi patch sẽ **truncate đúng số bytes UTF-8 ở cuối file + append** phần chèn.
- Không ghi transcript theo từng bước; chỉ log hệ thống tối thiểu.

ENV:
  WS_HOST/WS_PORT; SRC_SAMPLE_RATE (default 48000) → TARGET_SAMPLE_RATE=16000
  STT_MODEL/STT_DEVICE/STT_COMPUTE_TYPE/…/STT_LANGUAGE
  QUEUE_MAX=12; PACE_MODE=auto; BACKLOG_DISABLE_PACING=2; BACKLOG_RESUME_PACING=1
  FULL_TRANSCRIPT_PATH, FULL_TRUNCATE_ON_START=1
  MUTABLE_WINDOW_TOKENS=7
  SPACE_GUARD=1
"""
import os, sys, json, time, math, base64, asyncio, logging, re
from pathlib import Path
from typing import Optional, Literal, Dict, Any, List, Union
import numpy as np
import websockets

# ---------- Resampler ----------
_RESAMPLE_USES_SCIPY = True
try:
    from scipy.signal import resample_poly
except Exception:
    _RESAMPLE_USES_SCIPY = False
    import librosa

# ---------- Env ----------
os.environ.setdefault("HF_HUB_OFFLINE", "1")

WS_HOST = os.getenv("WS_HOST", "0.0.0.0")
WS_PORT = int(os.getenv("WS_PORT", "8765"))

DEFAULT_SRC_SR = int(os.getenv("SRC_SAMPLE_RATE", "48000"))
TGT_SR = int(os.getenv("TARGET_SAMPLE_RATE", "16000"))

STT_MODEL = os.getenv("STT_MODEL", "/home/truong/models/fw-small")
STT_DEVICE = os.getenv("STT_DEVICE", "cuda").strip().lower()
STT_COMPUTE_TYPE = os.getenv("STT_COMPUTE_TYPE", "float16").strip().lower()
STT_COMPUTE_FALLBACK = os.getenv("STT_COMPUTE_FALLBACK", "float32").strip().lower()
STT_LANGUAGE = (os.getenv("STT_LANGUAGE", "en") or "").strip() or None

WEBRTC_SENSITIVITY = int(os.getenv("WEBRTC_SENSITIVITY", "3"))
SILERO_SENSITIVITY = float(os.getenv("SILERO_SENSITIVITY", "0.6"))
SILERO_DEACTIVITY = os.getenv("SILERO_DEACTIVITY", "0").strip().lower() in {"1","true","yes"}
POST_SPEECH_SILENCE = float(os.getenv("POST_SPEECH_SILENCE", "0.25"))

FRAME_MS = float(os.getenv("FRAME_MS", "20"))
FRAME_SAMPLES = int(TGT_SR * (FRAME_MS / 1000.0))
TAIL_SILENCE_SEC = float(os.getenv("TAIL_SILENCE_SEC", "1.0"))

PACE_REALTIME_LEGACY = os.getenv("PACE_REALTIME", "").strip().lower() in {"1","true","yes"}
PACE_MODE = os.getenv("PACE_MODE", "auto").strip().lower()
if PACE_MODE not in {"auto","on","off"}: PACE_MODE = "auto"
BACKLOG_DISABLE_PACING = int(os.getenv("BACKLOG_DISABLE_PACING", "2"))
BACKLOG_RESUME_PACING  = int(os.getenv("BACKLOG_RESUME_PACING", "1"))
QUEUE_MAX = int(os.getenv("QUEUE_MAX", "12"))

ENABLE_AGC = os.getenv("ENABLE_AGC", "1").strip().lower() in {"1","true","yes"}
AGC_TARGET_PEAK = float(os.getenv("AGC_TARGET_PEAK", "0.95"))
AGC_MAX_GAIN = float(os.getenv("AGC_MAX_GAIN", "6.0"))

AUTO_START = os.getenv("AUTO_START", "1").strip().lower() in {"1","true","yes"}

# NEW: Mutable window + space guard
MUTABLE_WINDOW_TOKENS = int(os.getenv("MUTABLE_WINDOW_TOKENS", "7"))  # 5..7
SPACE_GUARD = os.getenv("SPACE_GUARD", "1").strip().lower() in {"1","true","yes"}

# Transcript file (real-time patch)
FULL_TRANSCRIPT_PATH = Path(os.getenv("FULL_TRANSCRIPT_PATH", "stt_full_transcript.txt")).expanduser()
FULL_TRANSCRIPT_PATH.parent.mkdir(parents=True, exist_ok=True)
FULL_TRUNCATE_ON_START = os.getenv("FULL_TRUNCATE_ON_START", "1").strip().lower() in {"1","true","yes"}

LOG_PATH = Path(os.getenv("STT_LOG_PATH", "stt_realtime_server.txt")).expanduser()
LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()

# ---------- Logging (system only) ----------
logger = logging.getLogger("stt-server")
logger.setLevel(getattr(logging, LOG_LEVEL, logging.INFO))
fh = logging.FileHandler(LOG_PATH, encoding="utf-8")
fh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
fh.setLevel(getattr(logging, LOG_LEVEL, logging.INFO))
sh = logging.StreamHandler(sys.stderr)
sh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
sh.setLevel(getattr(logging, LOG_LEVEL, logging.INFO))
logger.addHandler(fh); logger.addHandler(sh)
logger.info("[Config] device=%s model=%s compute=%s fallback=%s lang=%s",
            STT_DEVICE, STT_MODEL, STT_COMPUTE_TYPE, STT_COMPUTE_FALLBACK, STT_LANGUAGE or "auto")
logger.info("[Config] PACE=%s DISABLE=%d RESUME=%d QUEUE_MAX=%d WINDOW=%d SPACE_GUARD=%s",
            PACE_MODE, BACKLOG_DISABLE_PACING, BACKLOG_RESUME_PACING,
            QUEUE_MAX, MUTABLE_WINDOW_TOKENS, SPACE_GUARD)

# ---------- GPU detection ----------
try:
    import torch
    if STT_DEVICE == "cuda" and not torch.cuda.is_available():
        logger.warning("[GPU] CUDA không khả dụng → fallback CPU")
        STT_DEVICE = "cpu"
        if os.getenv("STT_COMPUTE_TYPE") is None:
            STT_COMPUTE_TYPE = "int8"
except Exception:
    if STT_DEVICE == "cuda":
        logger.warning("[GPU] Không kiểm tra được CUDA")

# ---------- Single client ----------
_client_lock: Optional[asyncio.Lock] = None
_active_client = None

# ---------- RealtimeSTT ----------
from RealtimeSTT import AudioToTextRecorder

# ---------- Tokenizer (word/punct + trailing spaces) ----------
try:
    import regex as _re_u
    _TK = _re_u.compile(r"([\p{L}\p{M}\p{N}’'_]+|[.,!?…;:]+|[\"“”()–—-])(\s*)", _re_u.UNICODE)
    def _token_units(s: str):
        out = []
        for m in _TK.finditer(s or ""):
            tok, ws = m.group(1), m.group(2)
            out.append((tok+ws, tok))  # (emit, core)
        return out
except Exception:
    _TK = re.compile(r"([A-Za-zÀ-ÖØ-öø-ÿ0-9’'_]+|[.,!?…;:]+|[\"“”()–—-])(\s*)", re.UNICODE)
    def _token_units(s: str):
        out = []
        for m in _TK.finditer(s or ""):
            tok, ws = m.group(1), m.group(2)
            out.append((tok+ws, tok))
        return out

def _norm_core(core: str) -> str:
    t = core
    t = t.replace("’","'").replace("‘","'").replace("“",'"').replace("”",'"').replace("…","...")
    t = re.sub(r"\.{2,}", "...", t)
    return t.lower()

def _is_punct(core: str) -> bool:
    return bool(re.fullmatch(r"[.,!?…;:]+|[\"“”()–—-]", core))

def _units_with_norms(s: str):
    units = _token_units(s)
    out = []
    for emit, core in units:
        if _is_punct(core):
            norm = core.replace("…","...")
        else:
            norm = _norm_core(re.sub(r"[.,!?…;:]+$", "", core))
        out.append((emit, core, norm))
    return out

# ---------- Overlap: suffix(old) vs prefix(new) ----------
def _overlap_suffix_prefix(a_norms: List[str], b_norms: List[str]) -> int:
    maxl = min(len(a_norms), len(b_norms))
    for l in range(maxl, -1, -1):
        if l == 0: return 0
        if a_norms[-l:] == b_norms[:l]:
            return l
    return 0

# ---------- WS helper ----------
async def _ws_send(ws, obj: dict):
    try:
        await ws.send(json.dumps(obj, ensure_ascii=False))
    except websockets.exceptions.ConnectionClosed:
        pass

# ---------- Audio utils (đặt TRƯỚC handler) ----------
def _resample_to_16k(f32: np.ndarray, src_sr: int) -> np.ndarray:
    if f32.size == 0: return f32
    if src_sr == TGT_SR: return f32.astype(np.float32, copy=False)
    if _RESAMPLE_USES_SCIPY and src_sr == 48000 and TGT_SR == 16000:
        y = resample_poly(f32, up=1, down=3).astype(np.float32, copy=False)
    else:
        if _RESAMPLE_USES_SCIPY and src_sr % TGT_SR == 0:
            y = resample_poly(f32, up=1, down=src_sr // TGT_SR).astype(np.float32, copy=False)
        else:
            y = librosa.resample(f32, orig_sr=src_sr, target_sr=TGT_SR).astype(np.float32, copy=False)
    return np.nan_to_num(y, nan=0.0, posinf=1.0, neginf=-1.0)

def _apply_agc_peak(x: np.ndarray) -> np.ndarray:
    if x.size == 0: return x
    peak = float(np.max(np.abs(x)))
    if peak <= 1e-6 or peak >= AGC_TARGET_PEAK: return x
    gain = min(AGC_MAX_GAIN, AGC_TARGET_PEAK / max(peak, 1e-6))
    return np.clip(x * gain, -1.0, 1.0)

def _bytes_to_f32_auto(b: bytes, force_dtype: Optional[Literal["i16","f32"]]=None) -> np.ndarray:
    if not b: return np.empty(0, dtype=np.float32)
    if force_dtype == "i16":
        f = np.frombuffer(b, dtype=np.int16).astype(np.float32) / 32768.0
        return np.nan_to_num(f, nan=0.0, posinf=1.0, neginf=-1.0)
    if force_dtype == "f32":
        f = np.frombuffer(b, dtype=np.float32)
        return np.nan_to_num(f, nan=0.0, posinf=1.0, neginf=-1.0)
    if len(b) % 4 == 0:
        f32 = np.frombuffer(b, dtype=np.float32)
        if f32.size and float(np.mean(np.abs(f32) <= 1.5)) > 0.9:
            return np.nan_to_num(f32, nan=0.0, posinf=1.0, neginf=-1.0)
    i16 = np.frombuffer(b, dtype=np.int16)
    f = i16.astype(np.float32) / 32768.0
    return np.nan_to_num(f, nan=0.0, posinf=1.0, neginf=-1.0)

def _f32_to_bytes_i16(x: np.ndarray) -> bytes:
    if x.size == 0: return b""
    x = np.nan_to_num(x, nan=0.0, posinf=1.0, neginf=-1.0)
    return (np.clip(x, -1.0, 1.0) * 32767.0).astype(np.int16, copy=False).tobytes()

# ---------- Handler ----------
async def handler(websocket):
    global _active_client, _client_lock

    client = websocket.remote_address
    if _client_lock is None:
        _client_lock = asyncio.Lock()

    async with _client_lock:
        if _active_client is not None:
            await _ws_send(websocket, {"type": "error", "error": "Server bận"})
            await websocket.close(code=1013, reason="busy")
            return
        _active_client = client

    logger.info("[Conn] open: %s", client)
    loop = asyncio.get_running_loop()

    # --- State (UI + file) ---
    last_emitted: str = ""          # chuỗi hiện đang hiển thị
    emitted_units: List[tuple] = [] # [(emit, core, norm)] đã phát
    stable_snapshot = ""

    # --- File patch writer (real-time truncate+append) ---
    file_patch_q: asyncio.Queue = asyncio.Queue()
    file_writer_stop = asyncio.Event()

    # init file
    if FULL_TRUNCATE_ON_START:
        try:
            FULL_TRANSCRIPT_PATH.write_text("", encoding="utf-8")
        except Exception as e:
            logger.warning("[Full] truncate fail: %s", e)
    else:
        FULL_TRANSCRIPT_PATH.touch(exist_ok=True)

    async def _file_patch_writer():
        file_text_state = ""
        if not FULL_TRUNCATE_ON_START:
            try:
                file_text_state = FULL_TRANSCRIPT_PATH.read_text("utf-8")
            except Exception:
                file_text_state = ""
        try:
            while True:
                item = await file_patch_q.get()
                if item is None: break
                del_chars, ins_text = item
                if del_chars < 0: del_chars = 0
                if del_chars > len(file_text_state):
                    del_chars = len(file_text_state)

                del_bytes = len(file_text_state[-del_chars:].encode("utf-8"))
                try:
                    with open(FULL_TRANSCRIPT_PATH, "rb+") as f:
                        f.seek(0, os.SEEK_END)
                        end = f.tell()
                        f.truncate(max(0, end - del_bytes))
                        if ins_text:
                            f.seek(0, os.SEEK_END)
                            f.write(ins_text.encode("utf-8"))
                            f.flush()
                            os.fsync(f.fileno())
                    file_text_state = file_text_state[:-del_chars] + ins_text
                except Exception as e:
                    logger.error("[FullPatch] file write error: %s", e)
        except Exception as e:
            logger.error("[FullPatch] writer task error: %s", e, exc_info=True)

    file_writer_task = asyncio.create_task(_file_patch_writer())
    def _schedule_file_patch(delete_chars: int, insert_text: str):
        try:
            file_patch_q.put_nowait((int(delete_chars), insert_text))
        except Exception:
            pass

    # ---- Patcher (cửa sổ N token cuối) ----
    def _patch_from_model_text(t: str, window: int = MUTABLE_WINDOW_TOKENS):
        """
        - Tính overlap trong cửa sổ ≤ N token cuối.
        - l>0: xoá đuôi-cũ sau l + chèn phần mới sau l.
        - l==0: coi là đoạn mới → không xoá gì, chỉ append toàn bộ đoạn mới.
        """
        nonlocal last_emitted, emitted_units

        t = (t or "").strip()
        if not t:
            return

        new_units = _units_with_norms(t)

        # lần đầu
        if not emitted_units:
            insert_text = "".join(u[0] for u in new_units)
            last_emitted = insert_text
            emitted_units = list(new_units)
            loop.call_soon_threadsafe(asyncio.create_task,
                _ws_send(websocket, {"type": "patch", "delete": 0, "insert": insert_text})
            )
            _schedule_file_patch(0, insert_text)
            return

        window = max(1, int(window))
        old_tail_units = emitted_units[-min(window, len(emitted_units)):]
        new_tail_units = new_units[-min(window, len(new_units)):]

        old_tail_norms = [u[2] for u in old_tail_units]
        new_tail_norms = [u[2] for u in new_tail_units]
        l = _overlap_suffix_prefix(old_tail_norms, new_tail_norms)

        if l > 0:
            # xoá phần khác biệt trong đuôi cũ
            to_delete_units = old_tail_units[l:]
            chars_to_delete = sum(len(u[0]) for u in to_delete_units)
            # chèn phần mới sau overlap
            to_insert_units = new_tail_units[l:]

            # space guard nếu cần
            if SPACE_GUARD and to_insert_units:
                if last_emitted and last_emitted[-1].isalnum():
                    first_emit = to_insert_units[0][0]
                    if first_emit and first_emit[0].isalnum():
                        fe = to_insert_units[0]
                        to_insert_units[0] = (" " + fe[0], fe[1], fe[2])

            insert_text = "".join(u[0] for u in to_insert_units)

            # cập nhật chuỗi
            if chars_to_delete:
                last_emitted = last_emitted[:-chars_to_delete]
            if insert_text:
                last_emitted += insert_text

            # cập nhật token list
            prefix_keep = emitted_units[:len(emitted_units) - len(old_tail_units)]
            keep_suffix = old_tail_units[:l]
            emitted_units = prefix_keep + keep_suffix + to_insert_units

            if chars_to_delete or insert_text:
                loop.call_soon_threadsafe(asyncio.create_task,
                    _ws_send(websocket, {"type": "patch", "delete": int(chars_to_delete), "insert": insert_text})
                )
                _schedule_file_patch(int(chars_to_delete), insert_text)
        else:
            # l == 0 → đoạn mới: không xoá, chỉ append TOÀN BỘ đoạn mới
            to_insert_units = new_units

            # space guard giữa đoạn cũ và đoạn mới (nếu cần)
            if SPACE_GUARD and to_insert_units:
                if last_emitted and last_emitted[-1].isalnum():
                    first_emit = to_insert_units[0][0]
                    if first_emit and first_emit[0].isalnum():
                        fe = to_insert_units[0]
                        to_insert_units[0] = (" " + fe[0], fe[1], fe[2])

            insert_text = "".join(u[0] for u in to_insert_units)

            # cập nhật chuỗi & tokens
            if insert_text:
                last_emitted += insert_text
                emitted_units.extend(to_insert_units)

                loop.call_soon_threadsafe(asyncio.create_task,
                    _ws_send(websocket, {"type": "patch", "delete": 0, "insert": insert_text})
                )
                _schedule_file_patch(0, insert_text)

    # ---- Callbacks ----
    def _on_update_cb(text: str):
        _patch_from_model_text(text)

    def _on_stable_cb(text: str):
        nonlocal stable_snapshot
        t = (text or "").strip()
        if not t: return
        if len(t) >= len(stable_snapshot):
            stable_snapshot = t
        _patch_from_model_text(t)
        loop.call_soon_threadsafe(asyncio.create_task,
            _ws_send(websocket, {"type": "stable", "full": stable_snapshot})
        )

    # ---- Recorder ----
    def _make_recorder(ct: str) -> AudioToTextRecorder:
        return AudioToTextRecorder(
            use_microphone=False,
            device=STT_DEVICE,
            model=STT_MODEL,
            compute_type=ct,
            enable_realtime_transcription=True,
            language=STT_LANGUAGE,
            normalize_audio=True,
            sample_rate=TGT_SR,
            webrtc_sensitivity=WEBRTC_SENSITIVITY,
            silero_sensitivity=SILERO_SENSITIVITY,
            silero_deactivity_detection=SILERO_DEACTIVITY,
            post_speech_silence_duration=POST_SPEECH_SILENCE,
            on_realtime_transcription_update=_on_update_cb,
            on_realtime_transcription_stabilized=_on_stable_cb,
        )

    try:
        try:
            recorder = _make_recorder(STT_COMPUTE_TYPE)
        except ValueError:
            recorder = _make_recorder(STT_COMPUTE_FALLBACK)
        if hasattr(recorder, "start"):
            recorder.start()
    except Exception as e:
        await _ws_send(websocket, {"type": "error", "error": f"Init lỗi: {e}"})
        await websocket.close(code=1011, reason="init failed")
        async with _client_lock:
            if _active_client == client: _active_client = None
        try:
            await file_patch_q.put(None)
            await asyncio.wait_for(file_writer_task, timeout=3.0)
        except Exception:
            pass
        return

    # ---- Feed worker ----
    session_src_sr = DEFAULT_SRC_SR
    session_force_dtype: Optional[Literal["i16","f32"]] = None
    session_started = False
    queue: asyncio.Queue[Optional[Dict[str, Any]]] = asyncio.Queue(maxsize=QUEUE_MAX)

    async def feed_worker():
        fed_frames = 0
        buf_16k = np.empty(0, dtype=np.float32)
        last_status_t = time.monotonic()
        if PACE_MODE == "on":
            pace_realtime = True
        elif PACE_MODE == "off":
            pace_realtime = False
        else:
            pace_realtime = True if not PACE_REALTIME_LEGACY else True
        try:
            while True:
                if PACE_MODE == "auto":
                    qs = queue.qsize()
                    if pace_realtime and qs >= BACKLOG_DISABLE_PACING:
                        pace_realtime = False
                    elif (not pace_realtime) and qs <= BACKLOG_RESUME_PACING:
                        pace_realtime = True

                item = await queue.get()
                if item is None:
                    # flush phần dư + tail im lặng
                    start = 0
                    n = buf_16k.size
                    while start + FRAME_SAMPLES <= n:
                        frame = buf_16k[start:start+FRAME_SAMPLES]
                        recorder.feed_audio(_f32_to_bytes_i16(frame))
                        fed_frames += 1
                        if pace_realtime: await asyncio.sleep(FRAME_MS / 1000.0)
                        start += FRAME_SAMPLES
                    buf_16k = buf_16k[start:]

                    tail = np.zeros(int(TAIL_SILENCE_SEC * TGT_SR), dtype=np.float32)
                    t = 0
                    while t + FRAME_SAMPLES <= tail.size:
                        frame = tail[t:t+FRAME_SAMPLES]
                        recorder.feed_audio(_f32_to_bytes_i16(frame))
                        fed_frames += 1
                        if pace_realtime: await asyncio.sleep(FRAME_MS / 1000.0)
                        t += FRAME_SAMPLES

                    for m in ("end_stream","feed_audio_end","finish","stop"):
                        fn = getattr(recorder, m, None)
                        if callable(fn):
                            try: fn(); break
                            except Exception: pass
                    break

                buf = item.get("buf", b"")
                sr  = int(item.get("sr", DEFAULT_SRC_SR))
                dt  = item.get("dtype", None)

                if isinstance(buf, bytes):
                    f32_src = _bytes_to_f32_auto(buf, force_dtype=dt)
                elif isinstance(buf, np.ndarray):
                    f32_src = np.nan_to_num(buf.astype(np.float32, copy=False), nan=0.0, posinf=1.0, neginf=-1.0)
                else:
                    f32_src = np.empty(0, dtype=np.float32)

                f32_16k = _resample_to_16k(f32_src, sr) if f32_src.size else f32_src
                if ENABLE_AGC and f32_16k.size:
                    f32_16k = _apply_agc_peak(f32_16k)

                if buf_16k.size == 0: buf_16k = f32_16k
                else: buf_16k = np.concatenate([buf_16k, f32_16k])

                start = 0
                n = buf_16k.size
                while start + FRAME_SAMPLES <= n:
                    frame = buf_16k[start:start+FRAME_SAMPLES]
                    recorder.feed_audio(_f32_to_bytes_i16(frame))
                    fed_frames += 1
                    if PACE_MODE != "off" and pace_realtime:
                        await asyncio.sleep(FRAME_MS / 1000.0)
                    elif (fed_frames % 16) == 0:
                        await asyncio.sleep(0)
                    start += FRAME_SAMPLES
                buf_16k = buf_16k[start:]

                now_m = time.monotonic()
                if now_m - last_status_t >= 0.25:
                    rms = float(np.sqrt(np.mean(f32_16k * f32_16k))) if f32_16k.size else 0.0
                    rms = 0.0 if math.isnan(rms) or math.isinf(rms) else rms
                    await _ws_send(websocket, {
                        "type": "status",
                        "stage": "FEED",
                        "detail": {
                            "frames": int(fed_frames),
                            "rms": rms,
                            "queue": queue.qsize(),
                            "pace": "on" if pace_realtime else "off"
                        }
                    })
                    last_status_t = now_m
        except Exception as e:
            logger.error("[FEED] worker error: %s", e, exc_info=True)

    worker_task = asyncio.create_task(feed_worker())

    await _ws_send(websocket, {
        "type": "hello",
        "detail": {
            "sample_rate_in_default": DEFAULT_SRC_SR,
            "sample_rate_out": TGT_SR,
            "frame_ms": FRAME_MS,
            "tail_silence_sec": TAIL_SILENCE_SEC,
            "queue_max": QUEUE_MAX,
            "patch": True,
            "mutable_window_tokens": MUTABLE_WINDOW_TOKENS
        }
    })

    try:
        while True:
            try:
                msg = await websocket.recv()
            except websockets.exceptions.ConnectionClosed:
                break

            if isinstance(msg, (bytes, bytearray)):
                if not session_started:
                    if AUTO_START:
                        session_started = True
                        await _ws_send(websocket, {"type":"ack","detail":{
                            "src_sr": DEFAULT_SRC_SR,
                            "dtype": session_force_dtype or "auto",
                            "auto_started": True
                        }})
                    else:
                        continue
                await queue.put({"kind":"audio","buf":bytes(msg),"sr":session_src_sr,"dtype":session_force_dtype})
                continue

            if isinstance(msg, str):
                try:
                    obj = json.loads(msg)
                except Exception:
                    continue
                event = (obj.get("event") or "").lower().strip()

                if event == "start":
                    if "sample_rate" in obj:
                        session_src_sr = int(obj["sample_rate"])
                    dt = obj.get("dtype")
                    if isinstance(dt, str) and dt.lower() in {"i16","f32"}:
                        session_force_dtype = dt.lower()
                    session_started = True
                    await _ws_send(websocket, {"type":"ack","detail":{
                        "src_sr": session_src_sr,
                        "dtype": session_force_dtype or "auto",
                        "auto_started": False
                    }})
                    continue

                if event in {"stop","eos","end"}:
                    break

                if "audio" in obj:
                    if not session_started:
                        if AUTO_START:
                            session_started = True
                            await _ws_send(websocket, {"type":"ack","detail":{
                                "src_sr": session_src_sr,
                                "dtype": session_force_dtype or "auto",
                                "auto_started": True
                            }})
                        else:
                            continue
                    try:
                        raw = base64.b64decode(obj["audio"])
                        sr = int(obj.get("sr", session_src_sr))
                        dt = obj.get("dtype", session_force_dtype)
                        dt = (dt.lower() if isinstance(dt, str) else None)
                        await queue.put({"kind":"audio","buf":raw,"sr":sr,"dtype": dt if dt in {"i16","f32"} else None})
                    except Exception:
                        pass
                    continue
    finally:
        # kết thúc feed
        try: await queue.put(None)
        except Exception: pass
        try: await asyncio.wait_for(worker_task, timeout=12.0)
        except asyncio.TimeoutError: pass
        try:
            if 'recorder' in locals() and hasattr(recorder, "stop"): recorder.stop()
            if 'recorder' in locals() and hasattr(recorder, "shutdown"): recorder.shutdown()
        except Exception: pass

        # dừng file writer
        try:
            await file_patch_q.put(None)
            await asyncio.wait_for(file_writer_task, timeout=3.0)
        except Exception:
            pass

        if _client_lock is None: _client_lock = asyncio.Lock()
        async with _client_lock:
            if _active_client == client: _active_client = None

# ---------- Entrypoint ----------
async def main():
    logger.info("[Startup] WS server at ws://%s:%d", WS_HOST, WS_PORT)
    async with websockets.serve(handler, WS_HOST, WS_PORT, max_size=None, ping_interval=20, ping_timeout=20):
        await asyncio.Future()

if __name__ == "__main__":
    try: asyncio.run(main())
    except KeyboardInterrupt: pass