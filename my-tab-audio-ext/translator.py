#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
translator.py — Realtime EN→VI translator (CTranslate2) theo STABLE stream,
áp dụng cơ chế 2 tầng DRAFT + COMMIT để overlay ổn định kiểu subtitle.

PATCH (2026-02-06) — FIX DUPLICATE COMMIT + CLEAN DRAFT
P0) Never rollback committed boundary on any non-prefix stable rewrite:
    - lock min_start = old buf_start (committed boundary)
    - re-anchor/overlap/hard-rewrite must start >= min_start
    -> prevents re-committing already committed EN => VI no longer repeats long segments.

P1) Stronger re-anchor that ignores punctuation:
    - match last N cleaned words with spans in new_full
    -> reduces hard-rewrite frequency on punctuation edits (",", "though," ...).

P2) Draft quality filter:
    - if draft VI looks like garbage (too repetitive / low unique ratio) => clear draft.

P3) Stronger VI postprocess for short outputs (collapse consecutive duplicates earlier).

Keep: delay-by-N-words + tail release, draft epoch gating, robust input parsing.
"""

import os
import sys
import asyncio
import logging
import time
import json
import re
import threading
from typing import List, Optional, Dict, Any, Tuple, Union

import websockets

# ---------- Logging ----------
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
logger = logging.getLogger("rt-translator")
logger.setLevel(getattr(logging, LOG_LEVEL, logging.INFO))
_sh = logging.StreamHandler(sys.stderr)
_sh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
if not logger.handlers:
    logger.addHandler(_sh)


def _bool_env(name: str, default: bool = False) -> bool:
    v = os.getenv(name, "")
    if not v:
        return default
    return v.strip().lower() in {"1", "true", "yes", "y", "on"}


def _float_env(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, "").strip() or default)
    except Exception:
        return default


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "").strip() or default)
    except Exception:
        return default


LOG_RX_EVERY_MS = _int_env("LOG_RX_EVERY_MS", 900)
LOG_STATUS_EVERY_S = _float_env("LOG_STATUS_EVERY_S", 0.2)
LOG_SEG_PREVIEW_CHARS = _int_env("LOG_SEG_PREVIEW_CHARS", 90)
LOG_MT_EVERY_MS = _int_env("LOG_MT_EVERY_MS", 900)
LOG_Q_DROP_EVERY_MS = _int_env("LOG_Q_DROP_EVERY_MS", 800)

MT_RETRY_AFTER_S = _float_env("MT_RETRY_AFTER_S", 3.0)
MT_WARMUP_ON_START = _bool_env("MT_WARMUP_ON_START", False)

SEND_VI_DELTA_COMPAT = _bool_env("SEND_VI_DELTA_COMPAT", True)

# Optional: tiny whitelist word-fix for common ASR split-inside-word patterns (off by default)
FIX_BROKEN_WORDS = _bool_env("FIX_BROKEN_WORDS", False)

# Optional: serialize CT2 translate calls (safer when commit/draft concurrently)
MT_SERIALIZE = _bool_env("MT_SERIALIZE", True)

# Beam knobs (match your log)
BEAM_COMMIT = _int_env("BEAM_COMMIT", 2)
BEAM_DRAFT = _int_env("BEAM_DRAFT", 1)

# Draft garbage filter knobs
DRAFT_GARBAGE_FILTER = _bool_env("DRAFT_GARBAGE_FILTER", True)
DRAFT_GARBAGE_MIN_TOKENS = _int_env("DRAFT_GARBAGE_MIN_TOKENS", 4)
DRAFT_GARBAGE_UNIQUE_RATIO = _float_env("DRAFT_GARBAGE_UNIQUE_RATIO", 0.45)
DRAFT_GARBAGE_MAX_CONSEC_REP = _int_env("DRAFT_GARBAGE_MAX_CONSEC_REP", 2)

_rate_last: Dict[str, int] = {}


def _now_ms_wall() -> int:
    return int(time.time() * 1000)


def _rl_ok(key: str, every_ms: int) -> bool:
    if every_ms <= 0:
        return True
    now = _now_ms_wall()
    last = _rate_last.get(key, 0)
    if now - last >= every_ms:
        _rate_last[key] = now
        return True
    return False


def _preview(s: str, n: int = 80) -> str:
    s = (s or "").strip()
    if len(s) <= n:
        return s
    return s[:n].rstrip() + "…"


# ---------- Config ----------
TR_HOST = os.getenv("TR_HOST", "0.0.0.0")
TR_PORT = int(os.getenv("TR_PORT", "8766"))

CT2_MODEL = os.getenv("CT2_MODEL", "").strip()
TRANSLATOR_FORCE_CPU = os.getenv("TRANSLATOR_FORCE_CPU", "1").strip().lower() in {"1", "true", "yes"}
CT2_DEVICE = os.getenv("CT2_DEVICE", "cpu").strip().lower()
CT2_COMPUTE = os.getenv("CT2_COMPUTE", "int8").strip().lower()

CPU_COUNT = os.cpu_count() or 4
CT2_INTER_THREADS = _int_env("CT2_INTER_THREADS", 1)
CT2_INTRA_THREADS = _int_env("CT2_INTRA_THREADS", min(4, max(1, CPU_COUNT // 2)))

SPM_SRC = os.getenv("SPM_SRC", "").strip()
SPM_TGT = os.getenv("SPM_TGT", "").strip()
MT_PREFIX = os.getenv("MT_PREFIX", "").strip()

VI_OUTPUT_PATH = os.getenv("VI_OUTPUT_PATH", "").strip()
VI_TRUNCATE_ON_START = os.getenv("VI_TRUNCATE_ON_START", "1").strip().lower() in {"1", "true", "yes"}
VI_TRUNCATE_ON_RESET = os.getenv("VI_TRUNCATE_ON_RESET", "0").strip().lower() in {"1", "true", "yes"}

SEG_PAUSE_MS = float(os.getenv("SEG_PAUSE_MS", "520"))
SEG_BEAT_MS = float(os.getenv("SEG_BEAT_MS", "420"))
SEG_MIN_WORDS = int(os.getenv("SEG_MIN_WORDS", "3"))
SEG_MAX_WORDS = int(os.getenv("SEG_MAX_WORDS", "12"))
SEG_MAX_CHARS = int(os.getenv("SEG_MAX_CHARS", "140"))

DRAFT_MIN_WORDS = _int_env("DRAFT_MIN_WORDS", max(4, SEG_MIN_WORDS + 1))
DRAFT_MAX_CHARS = _int_env("DRAFT_MAX_CHARS", SEG_MAX_CHARS)
DRAFT_SEND_EVERY_MS = _int_env("DRAFT_SEND_EVERY_MS", 220)

# ===== translate on stable text but lag by N words =====
TR_DELAY_WORDS = _int_env("TR_DELAY_WORDS", 2)
TR_DELAY_RELEASE_MS = _int_env("TR_DELAY_RELEASE_MS", int(max(900, SEG_PAUSE_MS * 1.4)))

ENABLE_BEAT_COMMIT = _bool_env("ENABLE_BEAT_COMMIT", True)
BEAT_STABLE_COUNT = _int_env("BEAT_STABLE_COUNT", 2)
BEAT_COMMIT_MIN_WORDS = _int_env("BEAT_COMMIT_MIN_WORDS", max(7, SEG_MIN_WORDS + 4))
BEAT_COMMIT_MIN_CHARS = _int_env("BEAT_COMMIT_MIN_CHARS", 28)

STABLE_NONPREFIX_LOG_EVERY_MS = int(os.getenv("STABLE_NONPREFIX_LOG_EVERY_MS", "1200"))
STABLE_OVERLAP_MAX_CHARS = int(os.getenv("STABLE_OVERLAP_MAX_CHARS", "220"))
STABLE_OVERLAP_MIN_CHARS = int(os.getenv("STABLE_OVERLAP_MIN_CHARS", "10"))

HARD_REWRITE_TAIL_CHARS = _int_env("HARD_REWRITE_TAIL_CHARS", STABLE_OVERLAP_MAX_CHARS)
PUNCT_STABLE_COUNT = _int_env("PUNCT_STABLE_COUNT", BEAT_STABLE_COUNT if ENABLE_BEAT_COMMIT else 1)
PUNCT_MAX_WAIT_MS = _int_env("PUNCT_MAX_WAIT_MS", int(SEG_PAUSE_MS))

AUTO_BASELINE_ON_TRUNC = _bool_env("AUTO_BASELINE_ON_TRUNC", True)
AUTO_BASELINE_TRUNC_RATIO = _float_env("AUTO_BASELINE_TRUNC_RATIO", 0.65)
AUTO_BASELINE_MIN_OLD_LEN = _int_env("AUTO_BASELINE_MIN_OLD_LEN", 180)
AUTO_BASELINE_ON_ELLIPSIS = _bool_env("AUTO_BASELINE_ON_ELLIPSIS", True)

REANCHOR_ENABLE = _bool_env("REANCHOR_ENABLE", True)
REANCHOR_MIN_COMMITTED = _int_env("REANCHOR_MIN_COMMITTED", 60)
REANCHOR_MAX_TAIL_CHARS = _int_env("REANCHOR_MAX_TAIL_CHARS", 160)
REANCHOR_MIN_TAIL_CHARS = _int_env("REANCHOR_MIN_TAIL_CHARS", 40)
REANCHOR_ADVANCE_MAX = _int_env("REANCHOR_ADVANCE_MAX", 64)


# ---------- Lazy MT init (with backoff + lock) ----------
_ct2 = None
_sp_src = None
_sp_tgt = None

_mt_init_lock = threading.Lock()
_mt_run_lock = threading.Lock()

_mt_disabled_until_mono: float = 0.0
_mt_last_err: str = ""
_mt_logged_omp_once: bool = False


def _log_omp_env_once():
    global _mt_logged_omp_once
    if _mt_logged_omp_once:
        return
    _mt_logged_omp_once = True
    k1 = os.getenv("KMP_DUPLICATE_LIB_OK", "")
    k2 = os.getenv("KMP_WARNINGS", "")
    logger.info("[OMP] KMP_DUPLICATE_LIB_OK=%s | KMP_WARNINGS=%s", (k1 or "<unset>"), (k2 or "<unset>"))


def _model_bin_path() -> str:
    if not CT2_MODEL:
        return ""
    return os.path.join(CT2_MODEL, "model.bin")


def _detect_spm_paths() -> Tuple[Optional[str], Optional[str]]:
    def _pick(path: str) -> Optional[str]:
        if not path:
            return None
        if os.path.isabs(path):
            return path if os.path.isfile(path) else None

        if CT2_MODEL and os.path.isdir(CT2_MODEL):
            cand = os.path.join(CT2_MODEL, path)
            if os.path.isfile(cand):
                return cand

        cand2 = os.path.abspath(path)
        if os.path.isfile(cand2):
            return cand2
        return None

    src = _pick(SPM_SRC)
    tgt = _pick(SPM_TGT)

    if (not src or not tgt) and CT2_MODEL and os.path.isdir(CT2_MODEL):
        cand_src = os.path.join(CT2_MODEL, "source.spm")
        cand_tgt = os.path.join(CT2_MODEL, "target.spm")
        if not src and os.path.isfile(cand_src):
            src = cand_src
        if not tgt and os.path.isfile(cand_tgt):
            tgt = cand_tgt

    if src and not tgt:
        tgt = src
    return src, tgt


def _explain_missing_files() -> str:
    msg = []
    msg.append("Thiếu file tokenizer SentencePiece (source.spm/target.spm) hoặc CT2 model.")
    msg.append(f"CT2_MODEL='{CT2_MODEL}'")
    mb = _model_bin_path()
    msg.append(f"model.bin exists={bool(mb and os.path.isfile(mb))} path='{mb}'")
    src, tgt = _detect_spm_paths()
    msg.append(f"source.spm exists={bool(src and os.path.isfile(src))} path='{src or ''}'")
    msg.append(f"target.spm exists={bool(tgt and os.path.isfile(tgt))} path='{tgt or ''}'")
    if CT2_MODEL and os.path.isdir(CT2_MODEL):
        shared_vocab = os.path.join(CT2_MODEL, "shared_vocabulary.json")
        msg.append(f"shared_vocabulary.json exists={os.path.isfile(shared_vocab)}")
    msg.append("Gợi ý: convert lại và copy tokenizer files:")
    msg.append(
        "  ct2-transformers-converter --model Helsinki-NLP/opus-mt-en-vi --output_dir <OUT> "
        "--quantization int8 --force --copy_files source.spm target.spm"
    )
    return " | ".join(msg)


def _lazy_init_mt():
    global _ct2, _sp_src, _sp_tgt, _mt_disabled_until_mono, _mt_last_err

    if _ct2 is not None and _sp_src is not None and _sp_tgt is not None:
        return

    with _mt_init_lock:
        if _ct2 is not None and _sp_src is not None and _sp_tgt is not None:
            return

        now = time.monotonic()
        if now < _mt_disabled_until_mono:
            raise RuntimeError(f"MT init disabled until {(_mt_disabled_until_mono - now):.1f}s (last_err={_mt_last_err})")

        if not CT2_MODEL:
            _mt_last_err = "CT2_MODEL chưa được cấu hình."
            _mt_disabled_until_mono = now + MT_RETRY_AFTER_S
            raise RuntimeError(_mt_last_err)

        if not os.path.isdir(CT2_MODEL):
            _mt_last_err = f"CT2_MODEL không tồn tại hoặc không phải folder: {CT2_MODEL}"
            _mt_disabled_until_mono = now + MT_RETRY_AFTER_S
            raise RuntimeError(_mt_last_err)

        mb = _model_bin_path()
        if not (mb and os.path.isfile(mb)):
            _mt_last_err = f"Không thấy model.bin trong CT2_MODEL: {mb}"
            _mt_disabled_until_mono = now + MT_RETRY_AFTER_S
            raise RuntimeError(_mt_last_err)

        src_path, tgt_path = _detect_spm_paths()
        if not (src_path and os.path.isfile(src_path)) or not (tgt_path and os.path.isfile(tgt_path)):
            _mt_last_err = _explain_missing_files()
            _mt_disabled_until_mono = now + MT_RETRY_AFTER_S
            raise RuntimeError(_mt_last_err)

        _log_omp_env_once()

        import ctranslate2
        import sentencepiece as spm

        device_final = "cpu" if TRANSLATOR_FORCE_CPU else ("cuda" if CT2_DEVICE == "cuda" else "cpu")
        compute_final = CT2_COMPUTE

        logger.info("[CT2] init start | model=%s", CT2_MODEL)
        try:
            _ct2 = ctranslate2.Translator(
                CT2_MODEL,
                device=device_final,
                compute_type=compute_final,
                inter_threads=CT2_INTER_THREADS,
                intra_threads=CT2_INTRA_THREADS,
            )
            logger.info("[CT2] ready | device=%s compute=%s inter=%d intra=%d",
                        device_final, compute_final, CT2_INTER_THREADS, CT2_INTRA_THREADS)
        except Exception as e:
            _ct2 = None
            logger.warning("[CT2] init failed (%s). Falling back to CPU/int8.", e)
            try:
                _ct2 = ctranslate2.Translator(
                    CT2_MODEL,
                    device="cpu",
                    compute_type="int8",
                    inter_threads=CT2_INTER_THREADS,
                    intra_threads=CT2_INTRA_THREADS,
                )
                logger.info("[CT2] fallback ready | device=cpu compute=int8")
            except Exception as e2:
                _mt_last_err = f"Không khởi tạo được CTranslate2: {e2}"
                _mt_disabled_until_mono = time.monotonic() + MT_RETRY_AFTER_S
                raise RuntimeError(_mt_last_err)

        try:
            _sp_src = spm.SentencePieceProcessor(model_file=src_path)
            _sp_tgt = spm.SentencePieceProcessor(model_file=tgt_path)
            logger.info("[SPM] src=%s | tgt=%s | prefix=%s",
                        src_path, tgt_path, (MT_PREFIX or "<none>"))
        except Exception as e:
            _sp_src = None
            _sp_tgt = None
            _mt_last_err = f"Không load được SentencePiece: {e} | { _explain_missing_files() }"
            _mt_disabled_until_mono = time.monotonic() + MT_RETRY_AFTER_S
            raise RuntimeError(_mt_last_err)


# ---------- Helpers ----------
_PUNCT_END = set(".!?…;:")
_PUNCT_CHARS = ".,!?…;:"
_WS = re.compile(r"\s+")
_SPACE_BEFORE_PUNCT = re.compile(r"\s+([,.;:!?…])")
_MULTI_DOTS = re.compile(r"\.{3,}")

_LEADING_PUNCT_NOISE = re.compile(r"^[\s\.,;:!?…]+")
_ELLIPSIS_END = re.compile(r"(?:\.\.\.|…)\s*$", re.UNICODE)

_BROKEN_WORD_WHITELIST = {
    ("a", "mazing"): "amazing",
    ("b", "usy"): "busy",
    ("ti", "red"): "tired",
    ("qui", "et"): "quiet",
    ("a", "fternoon"): "afternoon",
    ("to", "day"): "today",
}

_DRAFT_TRAIL_STOPWORDS = {
    "with", "to", "of", "and", "but", "or", "so", "for", "from", "in", "on", "at",
    "into", "about", "as", "by", "than", "then", "that", "which", "who", "whom",
    "because", "while", "when", "where", "if", "though", "although", "before", "after",
}

_STRIP_PUNCT = " ,.;:!?…\"'()[]{}<>“”‘’"


def _fix_broken_words_whitelist(s: str) -> str:
    if not s:
        return s
    toks = s.split()
    if len(toks) < 2:
        return s
    out: List[str] = []
    i = 0
    while i < len(toks):
        if i + 1 < len(toks):
            key = (toks[i].lower(), toks[i + 1].lower())
            rep = _BROKEN_WORD_WHITELIST.get(key)
            if rep:
                if toks[i].istitle():
                    rep = rep.title()
                out.append(rep)
                i += 2
                continue
        out.append(toks[i])
        i += 1
    return " ".join(out)


def _norm_spaces(s: str) -> str:
    s = (s or "").replace("\r", " ").replace("\n", " ")
    s = _WS.sub(" ", s).strip()
    if not s:
        return ""
    s = _SPACE_BEFORE_PUNCT.sub(r"\1", s)
    s = _MULTI_DOTS.sub("...", s)
    if FIX_BROKEN_WORDS:
        s = _fix_broken_words_whitelist(s)
    return s


def _word_count(s: str) -> int:
    s = (s or "").strip()
    if not s:
        return 0
    return len(s.split())


def _has_alnum(s: str) -> bool:
    return any(ch.isalnum() for ch in (s or ""))


def _is_punct_only(s: str) -> bool:
    s = (s or "").strip()
    if not s:
        return False
    return not _has_alnum(s)


# ===== delay-by-N-words helpers =====
def _is_word_token(tok: str) -> bool:
    if not tok:
        return False
    return any(ch.isalnum() for ch in tok)


def _drop_last_n_word_tokens(text: str, n_words: int) -> Tuple[str, str]:
    s = (text or "")
    if n_words <= 0:
        return s.rstrip(), ""

    toks = list(re.finditer(r"\S+", s))
    if not toks:
        return "", s.strip()

    need = n_words
    cut_at = None
    for i in range(len(toks) - 1, -1, -1):
        tok = s[toks[i].start():toks[i].end()]
        if _is_word_token(tok):
            need -= 1
            if need == 0:
                cut_at = toks[i].start()
                break

    if cut_at is None:
        return "", s.strip()

    kept = s[:cut_at].rstrip()
    tail = s[cut_at:].lstrip()
    return kept, tail


def _apply_delay_words(full_norm: str, delay_words: int, force_release: bool = False) -> str:
    t = (full_norm or "").strip()
    if not t:
        return ""
    if force_release or delay_words <= 0:
        return t
    kept, _ = _drop_last_n_word_tokens(t, delay_words)
    return kept.strip()


def _first_punct_boundary(s: str) -> int:
    if not s:
        return -1
    for i, ch in enumerate(s):
        if ch in _PUNCT_END:
            j = i + 1
            while j < len(s) and s[j].isspace():
                j += 1
            return j
    return -1


def _lcp_len(a: str, b: str) -> int:
    n = min(len(a), len(b))
    i = 0
    while i < n and a[i] == b[i]:
        i += 1
    return i


def _suffix_prefix_overlap(old: str, new: str, max_chars: int) -> int:
    if not old or not new:
        return 0
    max_k = min(max_chars, len(old), len(new))
    if max_k <= 0:
        return 0
    for k in range(max_k, 0, -1):
        if old[-k:] == new[:k]:
            return k
    return 0


def _safe_json_send(ws, obj: dict):
    return ws.send(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))


def _last_space_before(s: str, idx: int) -> int:
    if idx <= 0:
        return -1
    for i in range(min(idx - 1, len(s) - 1), -1, -1):
        if s[i].isspace():
            return i
    return -1


def _next_space_after(s: str, idx: int, max_forward: int = 32) -> int:
    if idx < 0:
        idx = 0
    end = min(len(s), idx + max_forward + 1)
    for i in range(idx, end):
        if s[i].isspace():
            return i
    return -1


def _cut_rel_by_words(s: str, max_words: int) -> int:
    if max_words <= 0:
        return -1
    words = list(re.finditer(r"\S+", s))
    if len(words) <= max_words:
        return len(s)
    return words[max_words - 1].end()


def _cut_rel_by_chars(s: str, max_chars: int) -> int:
    if max_chars <= 0:
        return -1
    if len(s) <= max_chars:
        return len(s)
    target = max_chars
    b = _last_space_before(s, target)
    if b >= 0 and b >= max(6, int(max_chars * 0.55)):
        return b
    f = _next_space_after(s, target, max_forward=32)
    if f >= 0:
        return f
    return target


def _safe_draft_text(buf: str, max_chars: int) -> str:
    b = (buf or "")
    if not b.strip():
        return ""
    b = b.strip()
    if len(b) > max_chars:
        b = b[:max_chars].rstrip()
        if b and (not b[-1].isspace()) and (b[-1] not in _PUNCT_CHARS):
            cut = _last_space_before(b, len(b))
            if cut > 0:
                b = b[:cut].strip()
            else:
                b = ""
    if not b:
        return ""
    if b[-1].isspace() or (b[-1] in _PUNCT_CHARS):
        return b.strip()
    cut = _last_space_before(b, len(b))
    if cut > 0:
        return b[:cut].strip()
    return ""


def _safe_prefix_by_limits(buf: str, max_chars: int, max_words: int) -> str:
    t = (buf or "")
    if not t.strip():
        return ""
    t2 = t.lstrip()
    if not t2:
        return ""

    cut_w = _cut_rel_by_words(t2, max_words) if max_words > 0 else len(t2)
    cut_c = _cut_rel_by_chars(t2, max_chars) if max_chars > 0 else len(t2)

    cut = min(cut_w if cut_w > 0 else len(t2), cut_c if cut_c > 0 else len(t2))
    if cut <= 0:
        cut = min(len(t2), max_chars) if max_chars > 0 else len(t2)

    if cut < len(t2) and cut > 0:
        if (not t2[cut].isspace()) and (not t2[cut - 1].isspace()):
            b = _last_space_before(t2, cut)
            if b >= 0 and b >= max(6, int(max_chars * 0.45)):
                cut = b
            else:
                f = _next_space_after(t2, cut, max_forward=24)
                if f >= 0:
                    cut = f

    out = t2[:cut].strip()
    return out if out else ""


def _advance_to_boundary(s: str, idx: int, max_forward: int = 64) -> int:
    if not s:
        return max(0, idx)
    idx = max(0, min(idx, len(s)))
    if idx <= 0 or idx >= len(s):
        return idx
    if s[idx - 1].isalnum() and s[idx].isalnum():
        end = min(len(s), idx + max_forward)
        for i in range(idx, end):
            if s[i].isspace() or s[i] in _PUNCT_CHARS:
                j = i + 1
                while j < len(s) and s[j].isspace():
                    j += 1
                return j
    return idx


def _draft_ok_for_translate(s: str) -> bool:
    s = (s or "").strip()
    if not s:
        return False

    wc = _word_count(s)
    if wc <= 0:
        return False

    if _ELLIPSIS_END.search(s):
        return wc >= max(1, DRAFT_MIN_WORDS)

    if s[-1] not in _PUNCT_END:
        last = s.split()[-1].strip(_STRIP_PUNCT).lower()
        if last in _DRAFT_TRAIL_STOPWORDS:
            return False

    if wc >= max(1, DRAFT_MIN_WORDS):
        return True

    if wc >= 2 and len(s) >= 8 and (s[-1] in _PUNCT_END):
        return True

    return False


def _collapse_consecutive_tokens(tokens: List[str], max_keep: int) -> List[str]:
    if not tokens:
        return []
    out: List[str] = []
    i = 0
    while i < len(tokens):
        j = i + 1
        ti = tokens[i]
        while j < len(tokens) and tokens[j].lower() == ti.lower():
            j += 1
        cnt = j - i
        out.extend([ti] * min(cnt, max_keep))
        i = j
    return out


def _collapse_repeated_patterns(tokens: List[str], max_pat_len: int = 4, min_reps: int = 4) -> List[str]:
    """
    Collapse if the entire sequence starts with a repeated short pattern many times.
    Ex: ["ở","nhà","ở","nhà","ở","nhà","ở","nhà", ...] => ["ở","nhà"].
    """
    n = len(tokens)
    if n < max(8, min_reps * 2):
        return tokens
    for p in range(1, max_pat_len + 1):
        if n < p * min_reps:
            continue
        pattern = tokens[:p]
        reps = 0
        k = 0
        while k + p <= n and tokens[k:k + p] == pattern:
            reps += 1
            k += p
        if reps >= min_reps:
            return pattern
    return tokens


def _postprocess_vi(text: str, max_chars: Optional[int] = None, is_draft: bool = False) -> str:
    t = (text or "").strip()
    if not t:
        return ""

    t = _WS.sub(" ", t).strip()

    t = re.sub(r"([!?])\1{3,}", r"\1\1\1", t)
    t = re.sub(r"(\.)\1{2,}", r"..", t)
    t = re.sub(r"(…){2,}", "…", t)
    t = re.sub(r"(-){4,}", "---", t)

    tokens = t.split()

    # Stronger duplicate collapse for short outputs too
    if tokens:
        tokens = _collapse_consecutive_tokens(tokens, max_keep=(1 if is_draft else 2))
        tokens = _collapse_repeated_patterns(tokens, max_pat_len=4, min_reps=4)
        t = " ".join(tokens).strip()

    if max_chars and len(t) > max_chars:
        t = t[:max_chars].rstrip()

    return t


def _vi_draft_looks_garbage(vi: str) -> bool:
    if not DRAFT_GARBAGE_FILTER:
        return False
    toks = (vi or "").split()
    if len(toks) < max(1, DRAFT_GARBAGE_MIN_TOKENS):
        return False

    # unique ratio
    uniq = len(set([x.lower() for x in toks]))
    ratio = uniq / max(1, len(toks))
    if ratio < DRAFT_GARBAGE_UNIQUE_RATIO:
        return True

    # consecutive repetition
    consec = 1
    worst = 1
    for i in range(1, len(toks)):
        if toks[i].lower() == toks[i - 1].lower():
            consec += 1
            worst = max(worst, consec)
        else:
            consec = 1
    if worst > max(1, DRAFT_GARBAGE_MAX_CONSEC_REP):
        return True

    # too many tiny tokens (often indicates degenerate decode)
    tiny = sum(1 for x in toks if len(x) <= 1)
    if tiny >= max(3, len(toks) // 2):
        return True

    return False


# ---------- Translate batch ----------
def _choose_decoding_params(src_tok_batch: List[List[str]], is_draft: bool) -> Dict[str, Any]:
    max_src_len = max((len(t) for t in src_tok_batch), default=0)

    if is_draft:
        max_dec_len = int(max(24, min(96, max_src_len * 2.0 + 10)))
    else:
        max_dec_len = int(max(32, min(128, max_src_len * 2.4 + 12)))

    if max_src_len <= 12:
        rep = 1.18 if is_draft else 1.15
    elif max_src_len <= 24:
        rep = 1.12 if is_draft else 1.10
    else:
        rep = 1.08 if is_draft else 1.06

    return {
        "beam_size": max(1, (BEAM_DRAFT if is_draft else BEAM_COMMIT)),
        "max_decoding_length": max_dec_len,
        "repetition_penalty": rep,
        "disable_unk": True,
        "return_scores": False,
    }


def _mt_translate_many(src_segments: List[str], is_draft: bool = False) -> List[str]:
    if not src_segments:
        return []
    _lazy_init_mt()

    src_tok: List[List[str]] = []
    kept_src: List[str] = []
    for s in src_segments:
        s2 = _norm_spaces(s)
        if not s2 or _is_punct_only(s2):
            continue
        toks = _sp_src.encode(s2, out_type=str)
        if MT_PREFIX:
            toks = [MT_PREFIX] + toks
        src_tok.append(toks)
        kept_src.append(s2)

    if not src_tok:
        return []

    params = _choose_decoding_params(src_tok, is_draft=is_draft)

    if MT_SERIALIZE:
        with _mt_run_lock:
            results = _ct2.translate_batch(src_tok, **params)
    else:
        results = _ct2.translate_batch(src_tok, **params)

    outs: List[str] = []
    for r in results:
        hyp = r.hypotheses[0] if hasattr(r, "hypotheses") else r[0]
        vi = _sp_tgt.decode(hyp)
        vi = _postprocess_vi(vi, max_chars=(DRAFT_MAX_CHARS if is_draft else None), is_draft=is_draft)
        outs.append(vi)
    return outs


# ---------- File output ----------
def _prepare_output_file(path: str, truncate: bool = True):
    if not path:
        return
    try:
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    except Exception:
        pass
    if truncate:
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write("")
            logger.info("[File] truncated: %s", path)
        except Exception as e:
            logger.warning("Không thể truncate file dịch: %s", e)


_prepare_output_file(VI_OUTPUT_PATH, truncate=VI_TRUNCATE_ON_START)


async def _write_vi_append(text: str):
    if not text or not VI_OUTPUT_PATH:
        return
    try:
        with open(VI_OUTPUT_PATH, "a", encoding="utf-8") as f:
            f.write(text)
    except Exception as e:
        logger.warning("Ghi file dịch lỗi: %s", e)


def _join_vi(prev_vi: str, new_vi: str) -> str:
    new_vi = (new_vi or "").strip()
    if not new_vi:
        return ""
    tail_space = " "
    if not prev_vi:
        return new_vi + tail_space
    prev_last = prev_vi[-1]
    if prev_last.isspace():
        return new_vi + tail_space
    if prev_last in _PUNCT_CHARS:
        return " " + new_vi + tail_space
    return " " + new_vi + tail_space


# ---------- Robust message parsing ----------
def _get_first_str(*vals: Any) -> str:
    for v in vals:
        if isinstance(v, str) and v.strip():
            return v
    return ""


def _get_first_num(*vals: Any) -> Optional[Union[int, float]]:
    for v in vals:
        if isinstance(v, (int, float)):
            return v
        if isinstance(v, str):
            vv = v.strip()
            if not vv:
                continue
            try:
                if "." in vv:
                    return float(vv)
                return int(vv)
            except Exception:
                continue
    return None


def _as_dict_first(obj: Any) -> Optional[Dict[str, Any]]:
    if isinstance(obj, dict):
        return obj
    if isinstance(obj, list) and len(obj) == 1 and isinstance(obj[0], dict):
        return obj[0]
    return None


def _iter_candidate_dicts(msg: Dict[str, Any]) -> List[Dict[str, Any]]:
    out = []
    if isinstance(msg, dict):
        out.append(msg)
        for k in ("payload", "data", "detail", "msg"):
            sub = msg.get(k)
            if isinstance(sub, dict):
                out.append(sub)
    return out


def _extract_text(msg: Dict[str, Any]) -> str:
    if not isinstance(msg, dict):
        return ""
    for d in _iter_candidate_dicts(msg):
        direct = _get_first_str(
            d.get("full"),
            d.get("text"),
            d.get("stable_full"),
            d.get("stableFull"),
            d.get("stableText"),
            d.get("stable_text"),
            d.get("transcript"),
            d.get("en"),
            d.get("en_full"),
            d.get("enFull"),
        )
        if direct:
            return direct
    return ""


def _extract_delta(msg: Dict[str, Any]) -> str:
    if not isinstance(msg, dict):
        return ""
    for d in _iter_candidate_dicts(msg):
        dd = _get_first_str(d.get("delta"), d.get("append"))
        if dd:
            return dd
    return ""


def _extract_seq_int(msg: Dict[str, Any]) -> Optional[int]:
    if not isinstance(msg, dict):
        return None
    for d in _iter_candidate_dicts(msg):
        v = _get_first_num(d.get("seq"), d.get("en_seq"), d.get("enSeq"))
        if isinstance(v, (int, float)):
            try:
                return int(v)
            except Exception:
                pass
    return None


def _extract_t_ms_int(msg: Dict[str, Any]) -> Optional[int]:
    if not isinstance(msg, dict):
        return None
    for d in _iter_candidate_dicts(msg):
        v = _get_first_num(d.get("t_ms"), d.get("tMs"), d.get("t"))
        if isinstance(v, (int, float)):
            try:
                return int(v)
            except Exception:
                pass
    return None


def _infer_mtype(msg: Dict[str, Any]) -> str:
    raw = ""
    for d in _iter_candidate_dicts(msg):
        raw = (
            (d.get("type") or "")
            or (d.get("event") or "")
            or (d.get("kind") or "")
            or (d.get("op") or "")
            or (d.get("action") or "")
        )
        raw = str(raw).strip()
        if raw:
            break

    raw = raw.strip().lower().replace("_", "-")

    if not raw:
        stable_keys = {
            "stable_full", "stableFull", "stableText", "stable_text",
            "full", "text", "transcript", "en", "en_full", "enFull"
        }
        patch_keys = {"delta", "append"}
        baseline_keys = {"baseline_full", "baselineFull", "baselineText", "baseline_text"}

        has_stable = any(any(k in d for k in stable_keys) for d in _iter_candidate_dicts(msg))
        has_patch = any(any(k in d for k in patch_keys) for d in _iter_candidate_dicts(msg))
        has_base = any(any(k in d for k in baseline_keys) for d in _iter_candidate_dicts(msg))

        if has_base:
            raw = "baseline"
        elif has_stable:
            raw = "stable"
        elif has_patch:
            raw = "patch"

    if raw in {"enstable", "en-stable"}:
        raw = "stable"
    if raw in {"enpatch", "en-patch"}:
        raw = "patch"
    if raw in {"stablefull", "stable-full", "stable-full-update", "stable-update", "stabletext", "stable-text"}:
        raw = "stable"
    if raw in {"append", "delta"}:
        raw = "patch"
    if raw in {"baselinefull", "baseline-full", "baseline-update"}:
        raw = "baseline"
    if raw in {"restart"}:
        raw = "reset"

    return raw


# ---------- Segmenter (COMMIT + DRAFT) ----------
class Segmenter:
    """
    - COMMIT: punctuation / pause / max / (optional) beat-commit with stability gate.
    - DRAFT: safe tail preview (word-boundary), for low-latency overlay (replace).

    Invariant:
    - self.buf luôn không có leading spaces
    - self.buf_start trỏ đúng vị trí bắt đầu của buf trong base_full
    """
    def __init__(self, tag: str = ""):
        self.tag = tag
        self.base_full: str = ""
        self.buf: str = ""
        self.buf_start: int = 0
        self.last_rx_mono: float = time.monotonic()
        self.last_emit_mono: float = time.monotonic()
        self.last_rx_tms: Optional[int] = None
        self.last_emit_tms: Optional[int] = None

        self.nonprefix_cnt: int = 0
        self._last_nonprefix_log_ms: int = 0

        self._last_safe_for_gate: str = ""
        self._safe_same_cnt: int = 0

        self._punct_gate_text: str = ""
        self._punct_gate_cnt: int = 0
        self._punct_gate_since_mono: float = time.monotonic()

        self.dbg: Dict[str, int] = {
            "flush_punct": 0,
            "flush_pause": 0,
            "flush_max": 0,
            "flush_beat": 0,
            "enqueue_segs": 0,
            "drop_punct_only": 0,
        }

    def _set_base(self, full: str):
        self.base_full = full
        self.buf = ""
        self.buf_start = len(full)

    def _set_buf_from_full(self, full: str, start: int):
        start = max(0, min(int(start), len(full)))
        sub = full[start:]
        lstrip_n = len(sub) - len(sub.lstrip())
        start2 = start + lstrip_n
        self.buf_start = max(0, min(start2, len(full)))
        self.buf = sub.lstrip()

    def _set_tail_window_from_full(self, full: str, tail_chars: int, min_start: int) -> int:
        """
        Choose a tail window start so that:
        - it keeps only last `tail_chars` chars,
        - BUT NEVER starts before min_start (committed boundary).
        Returns chosen start.
        """
        full = full or ""
        n = len(full)
        if tail_chars <= 0 or n <= tail_chars:
            start = 0
        else:
            start = max(0, n - tail_chars)
        start = max(start, max(0, min_start))
        start = _advance_to_boundary(full, start, max_forward=REANCHOR_ADVANCE_MAX)
        self._set_buf_from_full(full, start)
        return start

    def reset(self):
        now = time.monotonic()
        self.base_full = ""
        self.buf = ""
        self.buf_start = 0
        self.last_rx_mono = now
        self.last_emit_mono = now
        self.last_rx_tms = None
        self.last_emit_tms = None
        self.nonprefix_cnt = 0
        self._last_nonprefix_log_ms = 0
        self._last_safe_for_gate = ""
        self._safe_same_cnt = 0

        self._punct_gate_text = ""
        self._punct_gate_cnt = 0
        self._punct_gate_since_mono = now

        for k in self.dbg:
            self.dbg[k] = 0

    def baseline(self, full: str):
        full = _norm_spaces(full)
        now = time.monotonic()
        self._set_base(full)
        self.last_rx_mono = now
        self.last_emit_mono = now
        self.last_rx_tms = None
        self.last_emit_tms = None
        self._last_safe_for_gate = ""
        self._safe_same_cnt = 0

        self._punct_gate_text = ""
        self._punct_gate_cnt = 0
        self._punct_gate_since_mono = now

        if logger.isEnabledFor(logging.DEBUG):
            logger.debug("[%s][SEG] baseline set | base_len=%d", self.tag, len(full))

    def _append_to_buf(self, delta: str):
        if not delta:
            return
        if not self.buf:
            d2 = delta.lstrip()
            self.buf_start += (len(delta) - len(d2))
            self.buf = d2
        else:
            self.buf += delta

    def _split_at_cut(self, cut: int) -> Tuple[str, str, int]:
        cut = max(0, min(cut, len(self.buf)))
        head = self.buf[:cut].strip()
        tail = self.buf[cut:]
        removed = cut
        tail_l = len(tail)
        tail2 = tail.lstrip()
        removed += (tail_l - len(tail2))
        return head, tail2, removed

    def _reset_punct_gate(self):
        self._punct_gate_text = ""
        self._punct_gate_cnt = 0
        self._punct_gate_since_mono = time.monotonic()

    def _punct_gate_allow(self, head: str, now_mono: float) -> bool:
        if PUNCT_STABLE_COUNT <= 1:
            return True

        if head == self._punct_gate_text and head:
            self._punct_gate_cnt += 1
        else:
            self._punct_gate_text = head
            self._punct_gate_cnt = 1
            self._punct_gate_since_mono = now_mono

        held_ms = (now_mono - self._punct_gate_since_mono) * 1000.0
        if self._punct_gate_cnt >= PUNCT_STABLE_COUNT:
            return True
        if held_ms >= max(0, PUNCT_MAX_WAIT_MS):
            return True
        return False

    def _auto_baseline_should_trigger(self, old: str, new: str) -> bool:
        if not old or not new:
            return False
        if AUTO_BASELINE_ON_ELLIPSIS and ("…" in new or new.endswith("...")):
            return True
        if AUTO_BASELINE_ON_TRUNC and len(old) >= AUTO_BASELINE_MIN_OLD_LEN:
            if len(new) < int(len(old) * AUTO_BASELINE_TRUNC_RATIO):
                return True
        return False

    def _strip_leading_noise(self, s: str) -> str:
        s2 = (s or "").strip()
        if not s2:
            return ""
        s2 = _LEADING_PUNCT_NOISE.sub("", s2).strip()
        return s2

    def _chunk_by_limits(self, text: str, allow_short: bool) -> List[str]:
        t = _norm_spaces(text)
        t = self._strip_leading_noise(t)
        if not t or _is_punct_only(t):
            return []

        out: List[str] = []
        cur = t
        while cur:
            cur = self._strip_leading_noise(cur)
            wc = _word_count(cur)
            if wc <= 0:
                break

            if (wc <= SEG_MAX_WORDS) and (len(cur) <= SEG_MAX_CHARS):
                out.append(cur.strip())
                break

            cut_w = _cut_rel_by_words(cur, SEG_MAX_WORDS) if SEG_MAX_WORDS > 0 else len(cur)
            cut_c = _cut_rel_by_chars(cur, SEG_MAX_CHARS) if SEG_MAX_CHARS > 0 else len(cur)
            cut = min(cut_w if cut_w > 0 else len(cur), cut_c if cut_c > 0 else len(cur))
            cut = max(1, min(cut, len(cur)))

            if not allow_short:
                need = max(1, SEG_MIN_WORDS)
                if _word_count(cur[:cut]) < need:
                    cut_need = _cut_rel_by_words(cur, need)
                    if 0 < cut_need <= len(cur) and cut_need <= SEG_MAX_CHARS:
                        cut = max(cut, cut_need)

            head = self._strip_leading_noise(cur[:cut])
            tail = cur[cut:].strip()

            if head and not _is_punct_only(head):
                if allow_short:
                    if _word_count(head) >= 1:
                        out.append(head)
                else:
                    if _word_count(head) >= max(1, SEG_MIN_WORDS):
                        out.append(head)

            if not tail or tail == cur:
                break
            cur = tail

        return [x for x in out if x and not _is_punct_only(x)]

    def _cut_index_for_buf_limits(self) -> int:
        if not self.buf or not self.buf.strip():
            return -1

        lead = len(self.buf) - len(self.buf.lstrip())
        t = self.buf.lstrip()

        if _word_count(t) <= SEG_MAX_WORDS and len(t) <= SEG_MAX_CHARS:
            return len(self.buf)

        cut_w = _cut_rel_by_words(t, SEG_MAX_WORDS) if SEG_MAX_WORDS > 0 else len(t)
        cut_c = _cut_rel_by_chars(t, SEG_MAX_CHARS) if SEG_MAX_CHARS > 0 else len(t)

        cut_rel = min(cut_w if cut_w > 0 else len(t), cut_c if cut_c > 0 else len(t))
        cut_rel = max(1, min(cut_rel, len(t)))

        if cut_rel < len(t) and cut_rel > 0:
            if (not t[cut_rel].isspace()) and (not t[cut_rel - 1].isspace()):
                b = _last_space_before(t, cut_rel)
                if b >= 0 and b >= max(6, int(SEG_MAX_CHARS * 0.45)):
                    cut_rel = b
                else:
                    f = _next_space_after(t, cut_rel, max_forward=24)
                    if f >= 0:
                        cut_rel = f

        return lead + cut_rel

    # --- NEW robust word-span anchor (ignore punctuation) ---
    def _word_spans_clean(self, text: str) -> List[Tuple[str, int, int]]:
        """
        Return list of (clean_lower_word, start, end) based on \S+ spans,
        cleaned by stripping punctuation. Keeps only non-empty words.
        """
        out: List[Tuple[str, int, int]] = []
        if not text:
            return out
        for m in re.finditer(r"\S+", text):
            raw = text[m.start():m.end()]
            clean = raw.strip(_STRIP_PUNCT).lower()
            if clean:
                out.append((clean, m.start(), m.end()))
        return out

    def _reanchor_by_committed_tail(self, committed_old: str, new_full: str) -> Optional[Tuple[int, int, int]]:
        if not REANCHOR_ENABLE:
            return None

        committed_old = (committed_old or "").strip()
        new_full = (new_full or "").strip()
        if len(committed_old) < REANCHOR_MIN_COMMITTED or len(new_full) < REANCHOR_MIN_TAIL_CHARS:
            return None

        # 1) exact char tail match (fast)
        max_tail = min(REANCHOR_MAX_TAIL_CHARS, len(committed_old), STABLE_OVERLAP_MAX_CHARS)
        min_tail = min(REANCHOR_MIN_TAIL_CHARS, max_tail)

        cand_lens: List[int] = []
        for k in (max_tail, 140, 120, 100, 80, 60, 50, 40):
            kk = min(max_tail, k)
            if kk >= min_tail and kk not in cand_lens:
                cand_lens.append(kk)

        for k in cand_lens:
            tail = committed_old[-k:]
            pos = new_full.rfind(tail)
            if pos != -1:
                end = pos + len(tail)
                end2 = _advance_to_boundary(new_full, end, max_forward=REANCHOR_ADVANCE_MAX)
                return (end2, k, pos)

        # 2) word-span cleaned match (robust to punctuation edits)
        old_ws = self._word_spans_clean(committed_old)
        new_ws = self._word_spans_clean(new_full)
        if not old_ws or not new_ws:
            return None

        old_words = [w for (w, _, _) in old_ws]
        new_words = [w for (w, _, _) in new_ws]

        for n in (16, 14, 12, 10, 8, 7, 6):
            if len(old_words) < n:
                continue
            tail_seq = old_words[-n:]

            # search from the end (prefer last occurrence)
            for i in range(len(new_words) - n, -1, -1):
                if new_words[i:i + n] == tail_seq:
                    end_pos = new_ws[i + n - 1][2]  # end span in original new_full
                    end2 = _advance_to_boundary(new_full, end_pos, max_forward=REANCHOR_ADVANCE_MAX)
                    approx_tail_chars = min(len(new_full), end2)  # info only
                    return (end2, approx_tail_chars, new_ws[i][1])

        return None

    def update_stable(self, full: str, t_ms: Optional[int] = None) -> Tuple[List[str], str]:
        full = _norm_spaces(full)

        now_mono = time.monotonic()
        if isinstance(t_ms, int) and self.last_rx_tms is not None:
            gap_ms = float(t_ms - self.last_rx_tms)
        else:
            gap_ms = (now_mono - self.last_rx_mono) * 1000.0

        self.last_rx_mono = now_mono
        if isinstance(t_ms, int):
            self.last_rx_tms = t_ms

        old = self.base_full

        if not old:
            self.base_full = full
            self._set_buf_from_full(full, 0)

        elif full.startswith(old):
            delta = full[len(old):]
            self.base_full = full
            self._append_to_buf(delta)

        else:
            # --- P0: lock committed boundary (never rollback) ---
            self.nonprefix_cnt += 1
            reason = "resync"
            lcp = _lcp_len(old, full)
            rollback = len(old) - lcp

            # committed boundary in old coordinates
            bs_old = max(0, min(self.buf_start, len(old)))

            if self._auto_baseline_should_trigger(old, full):
                self.base_full = full
                chosen = self._set_tail_window_from_full(full, HARD_REWRITE_TAIL_CHARS, min_start=bs_old)
                reason = f"auto-baseline(window start={chosen} min_start={bs_old})"
                self._last_safe_for_gate = ""
                self._safe_same_cnt = 0
                self._reset_punct_gate()

            elif lcp >= self.buf_start:
                # rewrite inside current buf region; safe because start is current buf_start (>= bs_old)
                self.base_full = full
                self._set_buf_from_full(full, self.buf_start)
                reason = f"rewrite-in-buf(rebuild start={self.buf_start})"
                self._reset_punct_gate()

            else:
                committed_old = old[:bs_old]
                anch = self._reanchor_by_committed_tail(committed_old, full)
                if anch is not None:
                    new_bs, matched_len, pos = anch
                    # enforce no rollback
                    if new_bs < bs_old:
                        new_bs = bs_old
                    new_bs = _advance_to_boundary(full, new_bs, max_forward=REANCHOR_ADVANCE_MAX)
                    self.base_full = full
                    self._set_buf_from_full(full, new_bs)
                    reason = f"re-anchor(comm_tail~={matched_len} pos={pos} start={self.buf_start} min_start={bs_old})"
                    self._last_safe_for_gate = ""
                    self._safe_same_cnt = 0
                    self._reset_punct_gate()
                else:
                    ov = _suffix_prefix_overlap(old, full, max_chars=STABLE_OVERLAP_MAX_CHARS)
                    if ov >= STABLE_OVERLAP_MIN_CHARS and (full[ov - 1].isspace() or full[ov - 1] in _PUNCT_CHARS):
                        start = max(ov, bs_old)
                        start = _advance_to_boundary(full, start, max_forward=REANCHOR_ADVANCE_MAX)
                        self.base_full = full
                        self._set_buf_from_full(full, start)
                        reason = f"rolling-window(overlap_old={ov} start={self.buf_start} min_start={bs_old})"
                        self._reset_punct_gate()
                    else:
                        committed_old2 = old[:bs_old]
                        ov2 = _suffix_prefix_overlap(committed_old2, full, max_chars=STABLE_OVERLAP_MAX_CHARS)
                        if ov2 >= STABLE_OVERLAP_MIN_CHARS and (full[ov2 - 1].isspace() or full[ov2 - 1] in _PUNCT_CHARS):
                            start = max(ov2, bs_old)
                            start = _advance_to_boundary(full, start, max_forward=REANCHOR_ADVANCE_MAX)
                            self.base_full = full
                            self._set_buf_from_full(full, start)
                            reason = f"rolling-window(overlap_committed={ov2} start={self.buf_start} min_start={bs_old})"
                            self._reset_punct_gate()
                        else:
                            # hard rewrite but NEVER start before committed boundary
                            self.base_full = full
                            chosen = self._set_tail_window_from_full(full, HARD_REWRITE_TAIL_CHARS, min_start=bs_old)
                            reason = f"hard-rewrite(window start={chosen} min_start={bs_old})"
                            self._reset_punct_gate()

            now_ms = _now_ms_wall()
            if STABLE_NONPREFIX_LOG_EVERY_MS > 0 and (now_ms - self._last_nonprefix_log_ms) >= STABLE_NONPREFIX_LOG_EVERY_MS:
                logger.warning(
                    "[%s][SEG] stable not prefix -> %s | old_len=%d new_len=%d lcp=%d rollback=%d buf_len=%d buf_start=%d | old='%s' new='%s'",
                    self.tag, reason, len(old), len(full), lcp, rollback, len(self.buf), self.buf_start,
                    _preview(old, LOG_SEG_PREVIEW_CHARS),
                    _preview(full, LOG_SEG_PREVIEW_CHARS),
                )
                self._last_nonprefix_log_ms = now_ms

        if not self.buf or not self.buf.strip():
            self.buf = ""
            self.buf_start = len(self.base_full)
            self._last_safe_for_gate = ""
            self._safe_same_cnt = 0
            self._reset_punct_gate()
            return [], ""

        commit: List[str] = []

        # 1) punctuation flush (strong commit) WITH GATE
        while True:
            pidx = _first_punct_boundary(self.buf)
            if pidx <= 0:
                break

            head_raw = self._strip_leading_noise(self.buf[:pidx].strip())

            if head_raw and not self._punct_gate_allow(head_raw, now_mono):
                break

            tail = self.buf[pidx:]
            removed = pidx
            tail_l = len(tail)
            tail2 = tail.lstrip()
            removed += (tail_l - len(tail2))

            if head_raw:
                if _is_punct_only(head_raw):
                    self.dbg["drop_punct_only"] += 1
                else:
                    commit.extend(self._chunk_by_limits(head_raw, allow_short=True))

            self.buf = tail2
            self.buf_start += removed

            self.last_emit_mono = now_mono
            if isinstance(t_ms, int):
                self.last_emit_tms = t_ms

            self._reset_punct_gate()

            if not self.buf or not self.buf.strip():
                self.buf = ""
                self.buf_start = len(self.base_full)
                break

        if commit:
            self.dbg["flush_punct"] += len(commit)
            if logger.isEnabledFor(logging.DEBUG) and _rl_ok(f"{self.tag}:flush-punct", 450):
                logger.debug("[%s][SEG] flush punct | n=%d gap_ms=%.0f | seg0='%s'",
                             self.tag, len(commit), gap_ms, _preview(commit[0], LOG_SEG_PREVIEW_CHARS))

        wc = _word_count(self.buf)
        if wc <= 0:
            self.buf = ""
            self._last_safe_for_gate = ""
            self._safe_same_cnt = 0
            return commit, ""

        # 2) pause flush
        if gap_ms >= SEG_PAUSE_MS and wc >= max(1, SEG_MIN_WORDS):
            cut = self._cut_index_for_buf_limits()
            if cut > 0:
                head, tail2, removed = self._split_at_cut(cut)
                head = self._strip_leading_noise(head)
                if head and (not _is_punct_only(head)) and _word_count(head) >= max(1, SEG_MIN_WORDS):
                    chunks = self._chunk_by_limits(head, allow_short=False)
                    if chunks:
                        commit.extend(chunks)
                        self.dbg["flush_pause"] += 1
                        if logger.isEnabledFor(logging.DEBUG) and _rl_ok(f"{self.tag}:flush-pause", 450):
                            logger.debug("[%s][SEG] flush pause | gap_ms=%.0f buf_words=%d | head='%s'",
                                         self.tag, gap_ms, wc, _preview(chunks[0], LOG_SEG_PREVIEW_CHARS))
                        self.buf = tail2
                        self.buf_start += removed
                        self.last_emit_mono = now_mono
                        if isinstance(t_ms, int):
                            self.last_emit_tms = t_ms

        wc = _word_count(self.buf)
        if wc <= 0:
            self.buf = ""
            self.buf_start = len(self.base_full)
            self._last_safe_for_gate = ""
            self._safe_same_cnt = 0
            return commit, ""

        # 3) max limits (allow cut == len(buf) to flush all)
        while True:
            wc = _word_count(self.buf)
            if wc <= 0:
                self.buf = ""
                self.buf_start = len(self.base_full)
                break

            if wc < SEG_MAX_WORDS and len(self.buf.strip()) < SEG_MAX_CHARS:
                break

            cut = self._cut_index_for_buf_limits()
            if cut <= 0:
                break

            if cut >= len(self.buf):
                cut = len(self.buf)

            head, tail2, removed = self._split_at_cut(cut)
            head = self._strip_leading_noise(head)
            if head and (not _is_punct_only(head)):
                chunks = self._chunk_by_limits(head, allow_short=True)
                if chunks:
                    commit.extend(chunks)
                    self.dbg["flush_max"] += 1
                    if logger.isEnabledFor(logging.DEBUG) and _rl_ok(f"{self.tag}:flush-max", 450):
                        logger.debug("[%s][SEG] flush max | buf_words=%d buf_len=%d | head='%s'",
                                     self.tag, wc, len(self.buf), _preview(chunks[0], LOG_SEG_PREVIEW_CHARS))

            self.buf = tail2
            self.buf_start += removed
            self.last_emit_mono = now_mono
            if isinstance(t_ms, int):
                self.last_emit_tms = t_ms

            if not self.buf:
                break

        wc = _word_count(self.buf)
        if wc <= 0:
            self.buf = ""
            self.buf_start = len(self.base_full)
            self._last_safe_for_gate = ""
            self._safe_same_cnt = 0
            return commit, ""

        # 4) beat-commit
        if ENABLE_BEAT_COMMIT:
            if isinstance(t_ms, int) and self.last_emit_tms is not None:
                since_emit_ms = float(t_ms - self.last_emit_tms)
            else:
                since_emit_ms = (now_mono - self.last_emit_mono) * 1000.0

            safe_for_gate = _safe_prefix_by_limits(self.buf, max_chars=SEG_MAX_CHARS, max_words=SEG_MAX_WORDS)
            safe_for_gate = self._strip_leading_noise(safe_for_gate)

            if safe_for_gate and safe_for_gate == self._last_safe_for_gate:
                self._safe_same_cnt += 1
            else:
                self._last_safe_for_gate = safe_for_gate
                self._safe_same_cnt = 1 if safe_for_gate else 0

            if (
                since_emit_ms >= SEG_BEAT_MS
                and self._safe_same_cnt >= max(1, BEAT_STABLE_COUNT)
                and safe_for_gate
                and (not _is_punct_only(safe_for_gate))
                and _word_count(safe_for_gate) >= max(1, BEAT_COMMIT_MIN_WORDS)
                and len(safe_for_gate) >= max(1, BEAT_COMMIT_MIN_CHARS)
            ):
                buf_strip = self.buf.lstrip()
                if buf_strip.startswith(safe_for_gate):
                    lead = len(self.buf) - len(buf_strip)
                    cut = lead + len(safe_for_gate)

                    head, tail2, removed = self._split_at_cut(cut)
                    head = self._strip_leading_noise(head)

                    chunks = self._chunk_by_limits(head, allow_short=True)
                    if chunks:
                        commit.extend(chunks)
                        self.dbg["flush_beat"] += 1

                        self.buf = tail2
                        self.buf_start += removed
                        self.last_emit_mono = now_mono
                        if isinstance(t_ms, int):
                            self.last_emit_tms = t_ms

                    self._last_safe_for_gate = ""
                    self._safe_same_cnt = 0

        draft = _safe_draft_text(self.buf, max_chars=DRAFT_MAX_CHARS)
        draft = self._strip_leading_noise(draft)
        if draft and _is_punct_only(draft):
            draft = ""
        return commit, draft


class StreamState:
    def __init__(self, tag: str = ""):
        self.tag = tag
        self.seg = Segmenter(tag=tag)

        self.vi_full: str = ""
        self.vi_seq: int = 0

        self.vi_draft: str = ""
        self.vi_draft_seq: int = 0
        self.last_draft_en: str = ""
        self.last_draft_send_ms: int = 0

        self.last_en_seq: int = -1
        self.en_seq_local: int = 0

        self.draft_req_id: int = 0

        self.raw_full: str = ""
        self.raw_eff_seq: int = -1
        self.last_rx_mono: float = time.monotonic()
        self.release_token: int = 0

        self.last_status_t: float = time.monotonic()

        self.rx_cnt: int = 0
        self.rx_stable: int = 0
        self.rx_baseline: int = 0
        self.rx_reset: int = 0
        self.drop_dup_seq: int = 0
        self.q_drop: int = 0
        self.draft_drop: int = 0

    def reset(self):
        self.seg.reset()
        self.vi_full = ""
        self.vi_seq = 0
        self.vi_draft = ""
        self.vi_draft_seq = 0
        self.last_draft_en = ""
        self.last_draft_send_ms = 0
        self.last_en_seq = -1
        self.en_seq_local = 0
        self.draft_req_id = 0

        self.raw_full = ""
        self.raw_eff_seq = -1
        self.last_rx_mono = time.monotonic()
        self.release_token = 0

        self.last_status_t = time.monotonic()
        self.rx_cnt = 0
        self.rx_stable = 0
        self.rx_baseline = 0
        self.rx_reset = 0
        self.drop_dup_seq = 0
        self.q_drop = 0
        self.draft_drop = 0

    def next_effective_en_seq(self, seq_i: Optional[int]) -> int:
        if seq_i is not None:
            self.last_en_seq = max(self.last_en_seq, seq_i)
            return seq_i
        self.en_seq_local += 1
        eff = self.en_seq_local
        self.last_en_seq = max(self.last_en_seq, eff)
        return eff

    def bump_draft_req(self) -> int:
        self.draft_req_id += 1
        return self.draft_req_id


# ---------- WS Handler ----------
_CONN_COUNTER = 0


async def handler(websocket, *args):
    global _CONN_COUNTER
    _CONN_COUNTER += 1
    cid = _CONN_COUNTER
    tag = f"CID{cid}"

    state = StreamState(tag=tag)

    commit_queue: asyncio.Queue = asyncio.Queue(maxsize=64)
    draft_queue: asyncio.Queue = asyncio.Queue(maxsize=1)

    send_lock = asyncio.Lock()

    remote = getattr(websocket, "remote_address", None)
    logger.info("[%s][Conn] open from %s", tag, remote)

    async def send_obj(obj: dict):
        try:
            async with send_lock:
                await _safe_json_send(websocket, obj)
        except Exception as e:
            if logger.isEnabledFor(logging.DEBUG):
                logger.debug("[%s][WS] send failed: %r", tag, e)

    async def send_draft_clear(en_seq: Optional[int] = None, req_id: Optional[int] = None):
        state.vi_draft = ""
        state.vi_draft_seq += 1
        await send_obj({"type": "vi-draft", "text": "", "seq": state.vi_draft_seq, "en_seq": en_seq, "req_id": req_id})

    async def _drain_draft_queue():
        try:
            while True:
                try:
                    _ = draft_queue.get_nowait()
                except asyncio.QueueEmpty:
                    break
        except Exception:
            pass

    async def invalidate_and_clear_draft(en_seq: Optional[int] = None):
        rid = state.bump_draft_req()
        state.last_draft_en = ""
        state.last_draft_send_ms = 0
        await _drain_draft_queue()
        await send_draft_clear(en_seq=en_seq, req_id=rid)

    async def commit_worker():
        last_send_err_ms = 0
        while True:
            item = await commit_queue.get()
            if item is None:
                break

            batch = [item]
            try:
                while len(batch) < 4:
                    nxt = commit_queue.get_nowait()
                    if nxt is None:
                        await commit_queue.put(None)
                        break
                    batch.append(nxt)
            except asyncio.QueueEmpty:
                pass

            pairs: List[Tuple[int, str]] = []
            for it in batch:
                try:
                    en_seq_i, seg = it
                except Exception:
                    continue
                seg2 = _norm_spaces(seg)
                if not seg2 or _is_punct_only(seg2):
                    continue
                pairs.append((int(en_seq_i) if en_seq_i is not None else state.last_en_seq, seg2))

            if not pairs:
                continue

            src_list = [s for _, s in pairs]

            t0 = time.perf_counter()
            try:
                vi_list = await asyncio.to_thread(_mt_translate_many, src_list, False)
            except Exception as e:
                now_ms = _now_ms_wall()
                if now_ms - last_send_err_ms > 1200:
                    await send_obj({"type": "error", "error": f"MT failed (commit): {str(e)}"})
                    last_send_err_ms = now_ms
                if _rl_ok(f"{tag}:mtfail-commit", 900):
                    logger.error("[%s][MT] commit translate/init failed: %s", tag, str(e))
                continue
            dt_ms = (time.perf_counter() - t0) * 1000.0

            if logger.isEnabledFor(logging.DEBUG) and _rl_ok(f"{tag}:mt-commit", LOG_MT_EVERY_MS):
                src_chars = sum(len(x) for x in src_list)
                logger.debug("[%s][MT] COMMIT beam=%d batch=%d dt=%.1fms src_chars=%d q=%d | s0='%s'",
                             tag, BEAM_COMMIT, len(src_list), dt_ms, src_chars, commit_queue.qsize(),
                             _preview(src_list[0], LOG_SEG_PREVIEW_CHARS))

            n = min(len(pairs), len(vi_list))
            for i in range(n):
                en_seq_i, _seg = pairs[i]
                vi = vi_list[i]
                vi = _postprocess_vi(vi, is_draft=False)
                app = _join_vi(state.vi_full, vi)
                if not app:
                    continue

                state.vi_full += app
                state.vi_seq += 1
                await _write_vi_append(app)

                await send_obj({"type": "vi-commit", "append": app, "seq": state.vi_seq, "en_seq": en_seq_i})
                if SEND_VI_DELTA_COMPAT:
                    await send_obj({"type": "vi-delta", "append": app, "seq": state.vi_seq, "en_seq": en_seq_i})

                if logger.isEnabledFor(logging.DEBUG) and _rl_ok(f"{tag}:vi-commit", 900):
                    logger.debug("[%s][VI] COMMIT seq=%d len=%d en_seq=%s | '%s'",
                                 tag, state.vi_seq, len(app), str(en_seq_i), _preview(app, LOG_SEG_PREVIEW_CHARS))

    async def draft_worker():
        last_send_err_ms = 0
        while True:
            item = await draft_queue.get()
            if item is None:
                break

            try:
                en_seq_i, draft_en, req_id = item
            except Exception:
                continue

            draft_en = (draft_en or "").strip()

            if req_id is not None and int(req_id) != int(state.draft_req_id):
                continue

            if not draft_en:
                if req_id is None or int(req_id) == int(state.draft_req_id):
                    await send_draft_clear(en_seq=en_seq_i, req_id=req_id)
                continue

            if (not _draft_ok_for_translate(draft_en)) or _is_punct_only(draft_en):
                if req_id is None or int(req_id) == int(state.draft_req_id):
                    await send_draft_clear(en_seq=en_seq_i, req_id=req_id)
                continue

            t0 = time.perf_counter()
            try:
                vi = await asyncio.to_thread(_mt_translate_many, [draft_en], True)
                vi = vi[0] if vi else ""
            except Exception as e:
                now_ms = _now_ms_wall()
                if now_ms - last_send_err_ms > 1200:
                    await send_obj({"type": "error", "error": f"MT failed (draft): {str(e)}"})
                    last_send_err_ms = now_ms
                if _rl_ok(f"{tag}:mtfail-draft", 900):
                    logger.error("[%s][MT] draft translate/init failed: %s", tag, str(e))
                continue
            dt_ms = (time.perf_counter() - t0) * 1000.0

            if req_id is not None and int(req_id) != int(state.draft_req_id):
                continue

            vi = _postprocess_vi(vi, max_chars=DRAFT_MAX_CHARS, is_draft=True)

            # NEW: draft garbage filter (if looks degenerate -> clear)
            if _vi_draft_looks_garbage(vi):
                if logger.isEnabledFor(logging.DEBUG) and _rl_ok(f"{tag}:draft-garbage", 900):
                    logger.debug("[%s][MT] DRAFT garbage -> clear | en='%s' vi='%s'",
                                 tag, _preview(draft_en, 80), _preview(vi, 80))
                if req_id is None or int(req_id) == int(state.draft_req_id):
                    await send_draft_clear(en_seq=en_seq_i, req_id=req_id)
                continue

            if not vi:
                if req_id is None or int(req_id) == int(state.draft_req_id):
                    await send_draft_clear(en_seq=en_seq_i, req_id=req_id)
                continue

            state.vi_draft = vi
            state.vi_draft_seq += 1

            if logger.isEnabledFor(logging.DEBUG) and _rl_ok(f"{tag}:mt-draft", LOG_MT_EVERY_MS):
                logger.debug("[%s][MT] DRAFT beam=%d dt=%.1fms | en='%s' -> vi='%s'",
                             tag, BEAM_DRAFT, dt_ms, _preview(draft_en, 80), _preview(vi, 80))

            await send_obj({"type": "vi-draft", "text": vi, "seq": state.vi_draft_seq, "en_seq": en_seq_i, "req_id": req_id})

    commit_task = asyncio.create_task(commit_worker())
    draft_task = asyncio.create_task(draft_worker())

    async def _schedule_tail_release(full_norm: str, eff_seq: int):
        state.release_token += 1
        tok = state.release_token
        rx_mark = state.last_rx_mono
        raw_snapshot = full_norm

        async def _job():
            try:
                await asyncio.sleep(max(0, TR_DELAY_RELEASE_MS) / 1000.0)
                if tok != state.release_token:
                    return
                if state.last_rx_mono != rx_mark:
                    return
                if state.raw_full != raw_snapshot:
                    return
                await _process_en_update(
                    full_norm=raw_snapshot,
                    eff_seq=eff_seq,
                    t_ms=None,
                    force_release=True,
                    schedule_release=False,
                )
            except Exception:
                return

        asyncio.create_task(_job())

    async def _process_en_update(
        full_norm: str,
        eff_seq: int,
        t_ms: Optional[int],
        force_release: bool,
        schedule_release: bool,
    ):
        src_full = _apply_delay_words(full_norm, TR_DELAY_WORDS, force_release=force_release)
        commit_segs, draft_en = state.seg.update_stable(src_full, t_ms=t_ms)

        if commit_segs:
            await invalidate_and_clear_draft(en_seq=eff_seq)

        for s in commit_segs:
            if not s or _is_punct_only(s):
                continue
            try:
                commit_queue.put_nowait((eff_seq, s))
                state.seg.dbg["enqueue_segs"] += 1
            except asyncio.QueueFull:
                state.q_drop += 1
                try:
                    dropped = commit_queue.get_nowait()
                    if dropped is None:
                        commit_queue.put_nowait(None)
                    commit_queue.put_nowait((eff_seq, s))
                except Exception:
                    pass
                if _rl_ok(f"{tag}:qdrop", LOG_Q_DROP_EVERY_MS):
                    logger.warning("[%s][Q] COMMIT FULL -> drop+replace | q=%d dropped_cnt=%d | seg='%s'",
                                   tag, commit_queue.qsize(), state.q_drop, _preview(s, LOG_SEG_PREVIEW_CHARS))

        draft_en = (draft_en or "").strip()
        now_ms = _now_ms_wall()

        if draft_en != state.last_draft_en:
            if (now_ms - state.last_draft_send_ms) >= max(0, DRAFT_SEND_EVERY_MS):
                state.last_draft_en = draft_en
                state.last_draft_send_ms = now_ms

                payload = draft_en if (_draft_ok_for_translate(draft_en) and (not _is_punct_only(draft_en))) else ""
                rid = state.bump_draft_req()

                try:
                    await _drain_draft_queue()
                    draft_queue.put_nowait((eff_seq, payload, rid))
                except asyncio.QueueFull:
                    state.draft_drop += 1
        else:
            if (not draft_en) and state.vi_draft and (now_ms - state.last_draft_send_ms) >= max(250, DRAFT_SEND_EVERY_MS):
                state.last_draft_send_ms = now_ms
                rid = state.bump_draft_req()
                try:
                    await _drain_draft_queue()
                    draft_queue.put_nowait((eff_seq, "", rid))
                except asyncio.QueueFull:
                    state.draft_drop += 1

        if schedule_release:
            await _schedule_tail_release(full_norm, eff_seq)

    await send_obj({
        "type": "hello",
        "detail": {
            "mode": "stable->draft+commit",
            "lang_src": "en",
            "lang_tgt": "vi",
            "commit_append_only": True,
            "draft_replace": True,
            "seg_pause_ms": int(SEG_PAUSE_MS),
            "seg_beat_ms": int(SEG_BEAT_MS),
            "min_words": int(SEG_MIN_WORDS),
            "max_words": int(SEG_MAX_WORDS),
            "max_chars": int(SEG_MAX_CHARS),
            "draft_min_words": int(DRAFT_MIN_WORDS),
            "draft_max_chars": int(DRAFT_MAX_CHARS),
            "draft_send_every_ms": int(DRAFT_SEND_EVERY_MS),
            "enable_beat_commit": bool(ENABLE_BEAT_COMMIT),
            "beat_stable_count": int(BEAT_STABLE_COUNT),
            "beat_commit_min_words": int(BEAT_COMMIT_MIN_WORDS),
            "beat_commit_min_chars": int(BEAT_COMMIT_MIN_CHARS),
            "stable_overlap_max_chars": int(STABLE_OVERLAP_MAX_CHARS),
            "stable_overlap_min_chars": int(STABLE_OVERLAP_MIN_CHARS),
            "hard_rewrite_tail_chars": int(HARD_REWRITE_TAIL_CHARS),
            "punct_stable_count": int(PUNCT_STABLE_COUNT),
            "punct_max_wait_ms": int(PUNCT_MAX_WAIT_MS),
            "auto_baseline_on_trunc": bool(AUTO_BASELINE_ON_TRUNC),
            "auto_baseline_trunc_ratio": float(AUTO_BASELINE_TRUNC_RATIO),
            "auto_baseline_on_ellipsis": bool(AUTO_BASELINE_ON_ELLIPSIS),
            "send_vi_delta_compat": bool(SEND_VI_DELTA_COMPAT),
            "fix_broken_words": bool(FIX_BROKEN_WORDS),
            "reanchor_enable": bool(REANCHOR_ENABLE),
            "reanchor_min_committed": int(REANCHOR_MIN_COMMITTED),
            "reanchor_max_tail_chars": int(REANCHOR_MAX_TAIL_CHARS),
            "mt_serialize": bool(MT_SERIALIZE),
            "draft_epoch": True,
            "delay_words": int(TR_DELAY_WORDS),
            "delay_release_ms": int(TR_DELAY_RELEASE_MS),
            "beam_commit": int(BEAM_COMMIT),
            "beam_draft": int(BEAM_DRAFT),
            "draft_garbage_filter": bool(DRAFT_GARBAGE_FILTER),
        }
    })

    try:
        async for raw in websocket:
            state.rx_cnt += 1

            if isinstance(raw, (bytes, bytearray)):
                try:
                    raw = raw.decode("utf-8", errors="ignore")
                except Exception:
                    continue

            if not isinstance(raw, str) or not raw:
                continue

            try:
                parsed = json.loads(raw)
            except Exception:
                if logger.isEnabledFor(logging.DEBUG) and _rl_ok(f"{tag}:badjson", 1200):
                    logger.debug("[%s][RX] bad json | raw='%s'", tag, _preview(raw, 140))
                continue

            msg = _as_dict_first(parsed)
            if not msg:
                continue

            mtype = _infer_mtype(msg)
            seq_i = _extract_seq_int(msg)

            if logger.isEnabledFor(logging.DEBUG) and _rl_ok(f"{tag}:rx", LOG_RX_EVERY_MS):
                prev = ""
                if mtype in {"baseline", "stable"}:
                    prev = _preview(_extract_text(msg), LOG_SEG_PREVIEW_CHARS)
                elif mtype == "patch":
                    prev = _preview(_extract_delta(msg) or _extract_text(msg), LOG_SEG_PREVIEW_CHARS)
                logger.debug("[%s][RX] type=%s seq=%s text='%s'",
                             tag, mtype, str(seq_i) if seq_i is not None else "-", prev)

            if mtype == "reset":
                state.rx_reset += 1
                logger.info("[%s][Ctrl] reset | prev_vi_len=%d prev_vi_seq=%d prev_en_seq=%d",
                            tag, len(state.vi_full), state.vi_seq, state.last_en_seq)
                state.reset()
                state.release_token += 1
                if VI_TRUNCATE_ON_RESET:
                    _prepare_output_file(VI_OUTPUT_PATH, truncate=True)
                await invalidate_and_clear_draft(en_seq=seq_i)
                continue

            if mtype == "baseline":
                state.rx_baseline += 1
                full = _extract_text(msg)
                full_n = _norm_spaces(full)
                logger.info("[%s][Ctrl] baseline | len=%d seq=%s | '%s'",
                            tag, len(full_n), str(seq_i) if seq_i is not None else "-",
                            _preview(full_n, LOG_SEG_PREVIEW_CHARS))

                state.raw_full = full_n
                eff_seq = state.next_effective_en_seq(seq_i)
                state.raw_eff_seq = eff_seq
                state.last_rx_mono = time.monotonic()

                base_src = _apply_delay_words(full_n, TR_DELAY_WORDS, force_release=False)
                state.seg.baseline(base_src)

                await invalidate_and_clear_draft(en_seq=eff_seq)
                await _schedule_tail_release(full_n, eff_seq)
                continue

            if mtype not in {"stable", "patch"}:
                continue

            state.rx_stable += 1

            if seq_i is not None and seq_i <= state.last_en_seq:
                state.drop_dup_seq += 1
                if logger.isEnabledFor(logging.DEBUG) and _rl_ok(f"{tag}:dupseq", 900):
                    logger.debug("[%s][RX] drop old/dup seq | got=%d last=%d",
                                 tag, seq_i, state.last_en_seq)
                continue

            eff_seq = state.next_effective_en_seq(seq_i)

            full = _extract_text(msg)
            if not full.strip():
                d = _extract_delta(msg)
                if d:
                    base_raw = state.raw_full or ""
                    full = (base_raw + str(d)) if base_raw else str(d)

            full_n = _norm_spaces(full)
            state.raw_full = full_n
            state.raw_eff_seq = eff_seq
            state.last_rx_mono = time.monotonic()

            t_ms_i = _extract_t_ms_int(msg)

            await _process_en_update(
                full_norm=full_n,
                eff_seq=eff_seq,
                t_ms=t_ms_i,
                force_release=False,
                schedule_release=True,
            )

            now = time.monotonic()
            if now - state.last_status_t >= LOG_STATUS_EVERY_S:
                await send_obj({
                    "type": "status",
                    "detail": {
                        "en_base_len": len(state.seg.base_full),
                        "en_buf_words": _word_count(state.seg.buf),
                        "en_buf_start": int(state.seg.buf_start),
                        "commit_q": commit_queue.qsize(),
                        "draft_q": draft_queue.qsize(),
                        "vi_len": len(state.vi_full),
                        "vi_seq": state.vi_seq,
                        "vi_draft_seq": state.vi_draft_seq,
                        "en_seq": state.last_en_seq,
                        "nonprefix_cnt": int(state.seg.nonprefix_cnt),
                        "commit_q_drop": int(state.q_drop),
                        "draft_drop": int(state.draft_drop),
                        "drop_punct_only": int(state.seg.dbg["drop_punct_only"]),
                        "draft_req_id": int(state.draft_req_id),
                        "delay_words": int(TR_DELAY_WORDS),
                        "delay_release_ms": int(TR_DELAY_RELEASE_MS),
                        "beam_commit": int(BEAM_COMMIT),
                        "beam_draft": int(BEAM_DRAFT),
                    }
                })
                if logger.isEnabledFor(logging.DEBUG) and _rl_ok(f"{tag}:statuslog", 1000):
                    logger.debug("[%s][STAT] rx=%d stable=%d base=%d reset=%d dup=%d commit_q=%d draft_q=%d | flush(punct=%d pause=%d max=%d beat=%d) drop_punct=%d draft_req=%d | delay_words=%d release_ms=%d",
                                 tag,
                                 state.rx_cnt, state.rx_stable, state.rx_baseline, state.rx_reset,
                                 state.drop_dup_seq, commit_queue.qsize(), draft_queue.qsize(),
                                 state.seg.dbg["flush_punct"], state.seg.dbg["flush_pause"],
                                 state.seg.dbg["flush_max"], state.seg.dbg["flush_beat"],
                                 state.seg.dbg["drop_punct_only"],
                                 state.draft_req_id,
                                 int(TR_DELAY_WORDS), int(TR_DELAY_RELEASE_MS))
                state.last_status_t = now

    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as e:
        logger.error("[%s][WS] error: %s", tag, e, exc_info=True)
    finally:
        try:
            await commit_queue.put(None)
        except Exception:
            pass
        try:
            await draft_queue.put(None)
        except Exception:
            pass
        try:
            await asyncio.wait_for(commit_task, timeout=5.0)
        except Exception:
            pass
        try:
            await asyncio.wait_for(draft_task, timeout=5.0)
        except Exception:
            pass
        logger.info("[%s][Conn] close | vi_len=%d vi_seq=%d vi_draft_seq=%d en_seq=%d nonprefix=%d commit_drop=%d draft_drop=%d",
                    tag, len(state.vi_full), state.vi_seq, state.vi_draft_seq, state.last_en_seq,
                    state.seg.nonprefix_cnt, state.q_drop, state.draft_drop)


# ---------- Entrypoint ----------
async def main():
    mb = _model_bin_path()
    src_path, tgt_path = _detect_spm_paths()
    kmp = os.getenv("KMP_DUPLICATE_LIB_OK", "")
    logger.info(
        "[Startup] Translator WS at ws://%s:%d (output: %s) "
        "[force_cpu=%s, inter=%d, intra=%d, compute=%s] "
        "[pause=%d beat=%d min_words=%d max_words=%d max_chars=%d] "
        "[draft_min_words=%d draft_max_chars=%d draft_every_ms=%d] "
        "[beat_commit=%s stable_n=%d beat_min_words=%d beat_min_chars=%d] "
        "[punct_stable=%d punct_wait=%d hard_tail=%d] "
        "[auto_baseline_trunc=%s ratio=%.2f min_old=%d ellipsis=%s] "
        "[reanchor=%s min_committed=%d max_tail=%d] "
        "[beam_commit=%d beam_draft=%d] "
        "[delay_words=%d delay_release_ms=%d] "
        "[draft_garbage_filter=%s] "
        "[rx_log_every_ms=%d mt_log_every_ms=%d status_every_s=%.2f] "
        "[send_vi_delta_compat=%s] "
        "[fix_broken_words=%s] "
        "[mt_serialize=%s] "
        "[KMP_DUPLICATE_LIB_OK=%s]",
        TR_HOST, TR_PORT, VI_OUTPUT_PATH, str(TRANSLATOR_FORCE_CPU),
        CT2_INTER_THREADS, CT2_INTRA_THREADS, CT2_COMPUTE,
        int(SEG_PAUSE_MS), int(SEG_BEAT_MS), int(SEG_MIN_WORDS), int(SEG_MAX_WORDS), int(SEG_MAX_CHARS),
        int(DRAFT_MIN_WORDS), int(DRAFT_MAX_CHARS), int(DRAFT_SEND_EVERY_MS),
        str(ENABLE_BEAT_COMMIT), int(BEAT_STABLE_COUNT), int(BEAT_COMMIT_MIN_WORDS), int(BEAT_COMMIT_MIN_CHARS),
        int(PUNCT_STABLE_COUNT), int(PUNCT_MAX_WAIT_MS), int(HARD_REWRITE_TAIL_CHARS),
        str(AUTO_BASELINE_ON_TRUNC), float(AUTO_BASELINE_TRUNC_RATIO), int(AUTO_BASELINE_MIN_OLD_LEN), str(AUTO_BASELINE_ON_ELLIPSIS),
        str(REANCHOR_ENABLE), int(REANCHOR_MIN_COMMITTED), int(REANCHOR_MAX_TAIL_CHARS),
        int(BEAM_COMMIT), int(BEAM_DRAFT),
        int(TR_DELAY_WORDS), int(TR_DELAY_RELEASE_MS),
        str(DRAFT_GARBAGE_FILTER),
        LOG_RX_EVERY_MS, LOG_MT_EVERY_MS, LOG_STATUS_EVERY_S,
        str(SEND_VI_DELTA_COMPAT),
        str(FIX_BROKEN_WORDS),
        str(MT_SERIALIZE),
        (kmp or "<unset>")
    )
    logger.info("[Check] CT2_MODEL='%s' exists=%s | model.bin=%s",
                CT2_MODEL, bool(CT2_MODEL and os.path.isdir(CT2_MODEL)), bool(mb and os.path.isfile(mb)))
    logger.info("[Check] SPM src=%s | tgt=%s",
                (src_path if src_path else "<missing>"),
                (tgt_path if tgt_path else "<missing>"))

    if MT_WARMUP_ON_START:
        try:
            _lazy_init_mt()
        except Exception as e:
            logger.error("[Warmup] MT init failed: %s", str(e))

    async with websockets.serve(
        handler,
        TR_HOST,
        TR_PORT,
        max_size=None,
        ping_interval=20,
        ping_timeout=20,
    ):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
