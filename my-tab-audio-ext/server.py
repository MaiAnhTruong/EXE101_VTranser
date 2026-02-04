# server.py
# Realtime STT WebSocket server (Windows / RealtimeSTT / faster-whisper + CTranslate2)
#
# Goals:
# - Single-user capacity: only 1 active WS session at a time. Others get "Hệ thống bận" (BUSY) and close 1013.
# - Robust cleanup: add idle-timeout so slot is released if client stops sending data (tab crash / network stall).
# - Optional auth for product: ticket query (?ticket=...) and/or first auth message {"type":"auth","token":"..."}.
#   (Disabled by default; enable via env REQUIRE_AUTH=1 and set WS_TICKET_SECRET / ACCESS_JWT_SECRET)
#
# Input:
#   - Binary: PCM int16 LE (default SRC_SAMPLE_RATE)
#   - JSON: {"event":"start|stop"} or {"audio":base64,"sr":48000,"dtype":"i16|f32"}
#   - (Optional) auth message: {"type":"auth","token":"..."}  (if AUTH_MODE=message/either)
#
# Output:
#   - {"type":"hello"...}
#   - {"type":"auth_ok"...} / {"type":"error", "code":"BUSY|..."}
#   - {"type":"patch","delete":N,"insert":"..."}  (micro delta)
#   - {"type":"stable","full":"..."}
#   - {"type":"status","stage":"FEED","detail":{...}}
#
# Notes for WSS:
# - Production typically terminates TLS at a reverse proxy (Caddy/Nginx) and forwards to this WS server.

import os
import sys
import json
import time
import base64
import asyncio
import logging
import re
import traceback
import platform
import ctypes
import threading
import multiprocessing as mp
import hmac
import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Literal, List, Tuple, Any, Dict
from collections import deque
from urllib.parse import urlparse, parse_qs

# ──────────────────────────────────────────────────────────────────────────────
# Windows DLL bootstrap (MUST be before importing ctranslate2/torch/RealtimeSTT)
# ──────────────────────────────────────────────────────────────────────────────
def _is_main_process() -> bool:
    try:
        return mp.current_process().name == "MainProcess"
    except Exception:
        return True

_MAIN_PROCESS = _is_main_process()

WIN_DLL_BOOTSTRAP = os.getenv("WIN_DLL_BOOTSTRAP", "1").strip().lower() in {"1", "true", "yes"}
KMP_DUPLICATE_LIB_OK = os.getenv("KMP_DUPLICATE_LIB_OK", "TRUE").strip()

def _prepend_path(p: str) -> None:
    if not p:
        return
    cur = os.environ.get("PATH", "")
    if cur.lower().startswith(p.lower() + ";"):
        return
    os.environ["PATH"] = p + ";" + cur

def _safe_add_dll_dir(p: str, logs: List[str]) -> None:
    if not p:
        return
    try:
        if os.path.isdir(p) and hasattr(os, "add_dll_directory"):
            os.add_dll_directory(p)  # py3.8+
            logs.append(f"[DLL] Added: {p}")
    except Exception as e:
        logs.append(f"[DLL] add_dll_directory failed: {p} -> {e!r}")

def _try_preload_dlls(dirs: List[str], names: List[str], logs: List[str]) -> Tuple[int, int]:
    loaded = 0
    total = 0
    for name in names:
        total += 1
        found = None
        for d in dirs:
            cand = os.path.join(d, name)
            if os.path.isfile(cand):
                found = cand
                break
        if not found:
            continue
        try:
            ctypes.WinDLL(found)
            loaded += 1
        except Exception:
            pass
    return loaded, total

def _win_bootstrap_dlls_early() -> None:
    if sys.platform != "win32" or not WIN_DLL_BOOTSTRAP:
        return

    os.environ.setdefault("KMP_DUPLICATE_LIB_OK", KMP_DUPLICATE_LIB_OK or "TRUE")

    logs: List[str] = []

    conda_prefix = os.environ.get("CONDA_PREFIX") or sys.prefix
    conda_bin = os.path.join(conda_prefix, "Library", "bin")
    torch_lib = os.path.join(sys.prefix, "Lib", "site-packages", "torch", "lib")

    # PATH priority: conda Library\bin first, then torch\lib
    if os.path.isdir(conda_bin):
        _prepend_path(conda_bin)
    if os.path.isdir(torch_lib):
        _prepend_path(torch_lib)

    # add DLL dirs
    _safe_add_dll_dir(torch_lib if os.path.isdir(torch_lib) else "", logs)
    _safe_add_dll_dir(conda_bin if os.path.isdir(conda_bin) else "", logs)

    # preload common CUDA DLLs (best-effort)
    preload_names = [
        "cudart64_12.dll",
        "nvrtc64_120_0.dll",
        "nvJitLink_120_0.dll",
        "cublas64_12.dll",
        "cublasLt64_12.dll",
        "cudnn64_9.dll",
        "cufft64_11.dll",
        "curand64_10.dll",
        "cusolver64_11.dll",
        "cusparse64_12.dll",
        "libiomp5md.dll",
    ]
    scan_dirs = [d for d in [torch_lib, conda_bin] if os.path.isdir(d)]
    loaded, total = _try_preload_dlls(scan_dirs, preload_names, logs)
    logs.append(f"[DLL] Preload summary: {loaded}/{total} loaded | added_dirs={len(scan_dirs)} | scanned_dirs={len(scan_dirs)}")

    if _MAIN_PROCESS:
        for line in logs:
            print(line, file=sys.stderr)

_win_bootstrap_dlls_early()

# ──────────────────────────────────────────────────────────────────────────────
# LOGGING
# ──────────────────────────────────────────────────────────────────────────────
LOG_LEVEL = (os.getenv("LOG_LEVEL", "DEBUG") or "DEBUG").upper()
LOG_TO_FILE = (os.getenv("LOG_TO_FILE", "1").strip().lower() in {"1", "true", "yes"})
LOG_FILE = os.getenv("LOG_FILE", "stt_server_debug.log")
LOG_STDERR = (os.getenv("LOG_STDERR", "1").strip().lower() in {"1", "true", "yes"})
LOG_WS_EVERY_N = int(os.getenv("LOG_WS_EVERY_N", "25"))
LOG_AUDIO_EVERY_N = int(os.getenv("LOG_AUDIO_EVERY_N", "50"))
LOG_STATUS_EVERY = float(os.getenv("LOG_STATUS_EVERY", "2.0"))

def _setup_logging():
    level = getattr(logging, LOG_LEVEL, logging.DEBUG)
    logger = logging.getLogger("stt-server")
    logger.setLevel(level)
    logger.propagate = False

    fmt = logging.Formatter(
        fmt="%(asctime)s.%(msecs)03d | %(levelname)s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S"
    )

    if not logger.handlers:
        if LOG_STDERR:
            sh = logging.StreamHandler(sys.stderr)
            sh.setLevel(level)
            sh.setFormatter(fmt)
            logger.addHandler(sh)
        if LOG_TO_FILE:
            try:
                fh = logging.FileHandler(LOG_FILE, encoding="utf-8")
                fh.setLevel(level)
                fh.setFormatter(fmt)
                logger.addHandler(fh)
            except Exception:
                pass

    noisy = [
        "websockets", "websockets.server", "websockets.client", "websockets.protocol",
        "asyncio", "urllib3", "httpcore", "httpx", "numba"
    ]
    for name in noisy:
        try:
            logging.getLogger(name).setLevel(max(level, logging.WARNING))
        except Exception:
            pass

    return logger

logger = _setup_logging()

def _pkg_version(dist_name: str) -> Optional[str]:
    try:
        from importlib.metadata import version
        return version(dist_name)
    except Exception:
        return None

def _log_system_banner():
    if not _MAIN_PROCESS:
        return
    try:
        logger.info("===== STT SERVER START =====")
        logger.info("Python: %s", sys.version.replace("\n", " "))
        logger.info("Executable: %s", sys.executable)
        logger.info("OS: %s | platform=%s", platform.platform(), sys.platform)
        logger.info("CWD: %s", os.getcwd())
        logger.info("PID: %s", os.getpid())
        logger.info("LOG_LEVEL=%s LOG_TO_FILE=%s LOG_FILE=%s LOG_STDERR=%s", LOG_LEVEL, LOG_TO_FILE, LOG_FILE, LOG_STDERR)
        logger.info("ENV: CONDA_PREFIX=%s", os.getenv("CONDA_PREFIX"))
        ph = os.getenv("PATH", "")
        logger.info("ENV: PATH(head)=%s", (ph[:220] + "...") if len(ph) > 220 else ph)
        logger.info("pkg: websockets=%s numpy=%s", _pkg_version("websockets") or "?", _pkg_version("numpy") or "?")
        logger.info("pkg: RealtimeSTT=%s faster-whisper=%s ctranslate2=%s torch=%s",
                    _pkg_version("RealtimeSTT") or "-",
                    _pkg_version("faster-whisper") or "-",
                    _pkg_version("ctranslate2") or "-",
                    _pkg_version("torch") or "-")
    except Exception:
        pass

_log_system_banner()

# ──────────────────────────────────────────────────────────────────────────────
# Optional uvloop
# ──────────────────────────────────────────────────────────────────────────────
try:
    if os.getenv("USE_UVLOOP", "0").lower() in {"1","true","yes"}:
        import uvloop  # type: ignore
        uvloop.install()
        logger.info("uvloop installed")
except Exception as e:
    logger.debug("uvloop not installed/usable: %r", e)

# ──────────────────────────────────────────────────────────────────────────────
# Resampler availability
# ──────────────────────────────────────────────────────────────────────────────
_RESAMPLE_USES_SCIPY = True
try:
    from scipy.signal import resample_poly  # type: ignore
    logger.info("resample: scipy.signal.resample_poly OK")
except Exception as e:
    _RESAMPLE_USES_SCIPY = False
    logger.warning("resample_poly unavailable: %r", e)
    try:
        import librosa  # type: ignore
        logger.info("resample: librosa OK")
    except Exception as e2:
        librosa = None
        logger.warning("librosa unavailable: %r", e2)

# HF/cache behavior
os.environ.setdefault("HF_HUB_OFFLINE", os.getenv("HF_HUB_OFFLINE", "0"))
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import numpy as np
import websockets

# ──────────────────────────────────────────────────────────────────────────────
# WS Server config
# ──────────────────────────────────────────────────────────────────────────────
WS_HOST = os.getenv("WS_HOST", "0.0.0.0")
WS_PORT = int(os.getenv("WS_PORT", "8765"))

# IMPORTANT: idle timeout to release single-user slot if client stalls
IDLE_TIMEOUT_SEC = float(os.getenv("IDLE_TIMEOUT_SEC", "20"))  # seconds without any message => close

DEFAULT_SRC_SR = int(os.getenv("SRC_SAMPLE_RATE", "48000"))
TGT_SR = int(os.getenv("TARGET_SAMPLE_RATE", "16000"))

# ──────────────────────────────────────────────────────────────────────────────
# MODEL (Distill-Whisper default)
# ──────────────────────────────────────────────────────────────────────────────
STT_MODEL = os.getenv("STT_MODEL", "Systran/faster-distil-whisper-small.en")
STT_DEVICE = os.getenv("STT_DEVICE", "cuda").strip().lower()  # "cuda"|"cpu"|"auto"
STT_COMPUTE_TYPE = os.getenv("STT_COMPUTE_TYPE", "float16").strip().lower()
STT_COMPUTE_FALLBACK = os.getenv("STT_COMPUTE_FALLBACK", "float32").strip().lower()
STT_LANGUAGE = (os.getenv("STT_LANGUAGE", "en") or "").strip() or None

REQUIRE_GPU = os.getenv("REQUIRE_GPU", "1").strip().lower() in {"1","true","yes"}

WEBRTC_SENSITIVITY = int(os.getenv("WEBRTC_SENSITIVITY", "3"))
SILERO_SENSITIVITY = float(os.getenv("SILERO_SENSITIVITY", "0.6"))
SILERO_DEACTIVITY = os.getenv("SILERO_DEACTIVITY", "0").strip().lower() in {"1","true","yes"}
POST_SPEECH_SILENCE = float(os.getenv("POST_SPEECH_SILENCE", "0.25"))

FRAME_MS = float(os.getenv("FRAME_MS", "20"))
TAIL_SILENCE_SEC = float(os.getenv("TAIL_SILENCE_SEC", "1.0"))
FRAME_SAMPLES_BASE = int(TGT_SR * (FRAME_MS / 1000.0))

# Queue / guards
QUEUE_MAX = int(os.getenv("QUEUE_MAX", "16"))
DROP_OLDEST_ON_FULL = os.getenv("DROP_OLDEST_ON_FULL", "1").strip().lower() in {"1","true","yes"}
DROP_GUARD_Q = int(os.getenv("DROP_GUARD_Q", str(max(1, QUEUE_MAX - 1))))
QBYTES_HARD_CAP = int(os.getenv("QBYTES_HARD_CAP", str(48 * 1024)))

ENABLE_AGC = os.getenv("ENABLE_AGC", "1").strip().lower() in {"1","true","yes"}
AGC_TARGET_PEAK = float(os.getenv("AGC_TARGET_PEAK", "0.95"))
AGC_MAX_GAIN = float(os.getenv("AGC_MAX_GAIN", "6.0"))

AUTO_START = os.getenv("AUTO_START", "1").strip().lower() in {"1","true","yes"}
WARMUP_SILENCE_SEC = float(os.getenv("WARMUP_SILENCE_SEC", "0.2"))

# Real-time pacer + buffer drop
FORCE_REALTIME_PACE = os.getenv("FORCE_REALTIME_PACE", "1").strip().lower() in {"1","true","yes"}
MAX_BUF_MS = float(os.getenv("MAX_BUF_MS", "900"))
DROP_BUF_TO_MS = float(os.getenv("DROP_BUF_TO_MS", "450"))

# micro delta chunking (still supported, but now we do end-diff based patch)
UI_MICRO_DELTA_ENABLE = os.getenv("UI_MICRO_DELTA_ENABLE", "1").strip().lower() in {"1","true","yes"}
UI_MICRO_DELTA_MAX_CHARS = int(os.getenv("UI_MICRO_DELTA_MAX_CHARS", "48"))
UI_MICRO_DELTA_MIN_SLICE_CHARS = int(os.getenv("UI_MICRO_DELTA_MIN_SLICE_CHARS", "12"))

# patch/stable tracing (debug overlay jumps)
TRACE_PATCH = os.getenv("TRACE_PATCH", "0").strip().lower() in {"1", "true", "yes"}
TRACE_PATCH_EVERY = int(os.getenv("TRACE_PATCH_EVERY", "1"))   # log every N updates
TRACE_PATCH_MAX_TAIL = int(os.getenv("TRACE_PATCH_MAX_TAIL", "80"))  # tail chars in logs

# ──────────────────────────────────────────────────────────────────────────────
# STABILIZER (YouTube-like: append-mostly, confirm rewrites, rate-limit patches)
# ──────────────────────────────────────────────────────────────────────────────
STAB_ENABLE = os.getenv("STAB_ENABLE", "1").strip().lower() in {"1","true","yes"}
PATCH_MAX_HZ = float(os.getenv("PATCH_MAX_HZ", "15"))  # max patch sends per second
REWRITE_CONFIRM_N = int(os.getenv("REWRITE_CONFIRM_N", "2"))
MAX_ROLLBACK_CHARS = int(os.getenv("MAX_ROLLBACK_CHARS", "18"))
MIN_REWRITE_INTERVAL_MS = int(os.getenv("MIN_REWRITE_INTERVAL_MS", "120"))
IGNORE_SHRINK = os.getenv("IGNORE_SHRINK", "1").strip().lower() in {"1","true","yes"}
ALLOW_PUNCT_STRIP_APPEND = os.getenv("ALLOW_PUNCT_STRIP_APPEND", "1").strip().lower() in {"1","true","yes"}

# ──────────────────────────────────────────────────────────────────────────────
# Optional AUTH (disabled by default)
# ──────────────────────────────────────────────────────────────────────────────
REQUIRE_AUTH = os.getenv("REQUIRE_AUTH", "0").strip().lower() in {"1","true","yes"}
AUTH_MODE = os.getenv("AUTH_MODE", "ticket").strip().lower()  # ticket|message|either|none
AUTH_TIMEOUT_SEC = float(os.getenv("AUTH_TIMEOUT_SEC", "5"))

WS_TICKET_SECRET = (os.getenv("WS_TICKET_SECRET", "") or "").encode("utf-8")   # for ?ticket=...
ACCESS_JWT_SECRET = (os.getenv("ACCESS_JWT_SECRET", "") or "").encode("utf-8") # for auth-message token (optional)

def _b64url_decode(s: str) -> bytes:
    s = (s or "").strip().replace("-", "+").replace("_", "/")
    s += "=" * (-len(s) % 4)
    return base64.b64decode(s)

def _jwt_hs256_verify(token: str, secret: bytes) -> Optional[dict]:
    """Verify HS256 JWT without external libs. Return payload dict if ok."""
    try:
        if not token or not secret:
            return None
        parts = token.split(".")
        if len(parts) != 3:
            return None
        h_b64, p_b64, sig_b64 = parts
        signing_input = (h_b64 + "." + p_b64).encode("utf-8")
        sig = _b64url_decode(sig_b64)

        mac = hmac.new(secret, signing_input, hashlib.sha256).digest()
        if not hmac.compare_digest(mac, sig):
            return None

        payload = json.loads(_b64url_decode(p_b64))
        exp = payload.get("exp")
        if isinstance(exp, (int, float)) and time.time() > float(exp):
            return None
        return payload
    except Exception:
        return None

def _extract_query_ticket(websocket) -> str:
    path = getattr(websocket, "path", None)
    req = getattr(websocket, "request", None)
    if not path and req is not None:
        path = getattr(req, "path", None)
    if not path:
        return ""
    try:
        q = parse_qs(urlparse(path).query)
        return (q.get("ticket", [""])[0] or "").strip()
    except Exception:
        return ""

# ──────────────────────────────────────────────────────────────────────────────
# psutil / nvml (optional)
# ──────────────────────────────────────────────────────────────────────────────
try:
    import psutil  # type: ignore
    _PROC = psutil.Process()
    logger.info("psutil OK")
except Exception as e:
    psutil = None
    _PROC = None
    logger.warning("psutil unavailable: %r", e)

_nvml_ok = False
_nvml_handle = None
try:
    import pynvml  # type: ignore
    pynvml.nvmlInit()
    _nvml_handle = pynvml.nvmlDeviceGetHandleByIndex(int(os.getenv("GPU_ID", "0")))
    _nvml_ok = True
    try:
        name = pynvml.nvmlDeviceGetName(_nvml_handle)
        drv = pynvml.nvmlSystemGetDriverVersion()
        logger.info("pynvml OK | name=%s | driver=%s", name, drv)
    except Exception:
        logger.info("pynvml OK")
except Exception as e:
    _nvml_ok = False
    logger.warning("pynvml unavailable: %r", e)

def _nvml_mem_mb():
    if not _nvml_ok or _nvml_handle is None:
        return None
    try:
        info = pynvml.nvmlDeviceGetMemoryInfo(_nvml_handle)
        return float(info.used / (1024.0*1024.0)), float(info.total / (1024.0*1024.0))
    except Exception:
        return None

def _human_bytes(n: int) -> str:
    try:
        n = int(n)
    except Exception:
        return f"{n} B"
    units = ["B","KB","MB","GB","TB"]
    s = 0
    f = float(n)
    while f >= 1024.0 and s < len(units) - 1:
        f /= 1024.0
        s += 1
    return f"{f:.2f} {units[s]}"

# ──────────────────────────────────────────────────────────────────────────────
# CTranslate2 GPU PROBE
# ──────────────────────────────────────────────────────────────────────────────
_CT2_OK = False
_CT2_VER = None
_CT2_CUDA_COUNT = 0
_CT2_CUDA_COMPUTE_TYPES = None
_CT2_ERR = None

try:
    import ctranslate2  # type: ignore
    _CT2_OK = True
    _CT2_VER = getattr(ctranslate2, "__version__", None)
    try:
        _CT2_CUDA_COUNT = int(ctranslate2.get_cuda_device_count())
    except Exception:
        _CT2_CUDA_COUNT = 0
    try:
        fn = getattr(ctranslate2, "get_supported_compute_types", None)
        if callable(fn):
            _CT2_CUDA_COMPUTE_TYPES = list(fn("cuda"))
    except Exception:
        _CT2_CUDA_COMPUTE_TYPES = None

    logger.info("ctranslate2 OK | version=%s | cuda_device_count=%d | cuda_compute_types=%s",
                _CT2_VER, _CT2_CUDA_COUNT, _CT2_CUDA_COMPUTE_TYPES if _CT2_CUDA_COMPUTE_TYPES is not None else "-")
except Exception as e:
    _CT2_OK = False
    _CT2_ERR = repr(e)
    logger.error("ctranslate2 import failed: %s", _CT2_ERR)
    if _MAIN_PROCESS:
        logger.error("Fix Windows: ensure torch\\lib + conda Library\\bin are in PATH or set WIN_DLL_BOOTSTRAP=1.")

# torch (optional)
GPU_NAME = "cpu"
_torch_available = False
_torch_err = None
try:
    import torch as _torch  # type: ignore
    import torch.nn.functional as _F  # type: ignore
    _torch_available = True
    logger.info("torch OK | version=%s | cuda_is_available=%s",
                getattr(_torch, "__version__", "?"),
                bool(getattr(_torch.cuda, "is_available", lambda: False)()))
except Exception as e:
    _torch_available = False
    _torch_err = repr(e)
    logger.warning("torch unavailable (OK): %s", _torch_err)

def _init_gpu_or_fail():
    """
    GPU requirement:
    - If REQUIRE_GPU=1, require ctranslate2 cuda_device_count > 0 and device resolved to cuda.
    - Do NOT use torch to decide STT GPU.
    """
    global STT_DEVICE, GPU_NAME

    want = (STT_DEVICE or "cuda").strip().lower()
    if want not in {"cuda","cpu","auto"}:
        logger.warning("Invalid STT_DEVICE=%s -> force 'cuda'", want)
        want = "cuda"

    logger.info("Model config: STT_MODEL=%s | DEVICE=%s | REQUIRE_GPU=%s | CT=%s | CT_FALLBACK=%s | LANG=%s",
                STT_MODEL, want, REQUIRE_GPU, STT_COMPUTE_TYPE, STT_COMPUTE_FALLBACK, STT_LANGUAGE)
    logger.info("FORCE_REALTIME_PACE=%s MAX_BUF_MS=%s DROP_BUF_TO_MS=%s", FORCE_REALTIME_PACE, MAX_BUF_MS, DROP_BUF_TO_MS)
    logger.info("AUTH: REQUIRE_AUTH=%s AUTH_MODE=%s", REQUIRE_AUTH, AUTH_MODE)
    logger.info("STAB: enable=%s patch_max_hz=%s rewrite_confirm_n=%s max_rollback_chars=%s min_rewrite_ms=%s ignore_shrink=%s",
                STAB_ENABLE, PATCH_MAX_HZ, REWRITE_CONFIRM_N, MAX_ROLLBACK_CHARS, MIN_REWRITE_INTERVAL_MS, IGNORE_SHRINK)

    if not _CT2_OK:
        logger.error("ctranslate2 is required for faster-whisper. Import failed: %s", _CT2_ERR)
        sys.exit(1)

    if want == "auto":
        want = "cuda" if _CT2_CUDA_COUNT > 0 else "cpu"

    if REQUIRE_GPU:
        if want != "cuda":
            logger.error("REQUIRE_GPU=1 but STT_DEVICE resolved to %s (not cuda) -> exit", want)
            sys.exit(1)
        if _CT2_CUDA_COUNT <= 0:
            logger.error("REQUIRE_GPU=1 but ctranslate2 reports cuda_device_count=0 -> cannot run STT on GPU.")
            sys.exit(1)

    STT_DEVICE = want
    if STT_DEVICE == "cuda":
        GPU_NAME = "cuda"
        if _nvml_ok and _nvml_handle is not None:
            try:
                GPU_NAME = str(pynvml.nvmlDeviceGetName(_nvml_handle))
            except Exception:
                GPU_NAME = "cuda"
        logger.info("STT will run on GPU via ctranslate2 | cuda_device_count=%d | gpu_name=%s",
                    _CT2_CUDA_COUNT, GPU_NAME)
    else:
        GPU_NAME = "cpu"

_init_gpu_or_fail()

# Import RealtimeSTT after bootstrap
from RealtimeSTT import AudioToTextRecorder  # type: ignore

# ──────────────────────────────────────────────────────────────────────────────
# Tokenizer (still used for chunking inserts)
# ──────────────────────────────────────────────────────────────────────────────
try:
    import regex as _re_u  # type: ignore
    _TK = _re_u.compile(r"([\p{L}\p{M}\p{N}’'_]+|[.,!?…;:]+|[\"“”()–—-])(\s*)", _re_u.UNICODE)
    def _token_units(s: str):
        out = []
        for m in _TK.finditer(s or ""):
            tok, ws = m.group(1), m.group(2)
            out.append((tok + ws, tok))
        return out
except Exception:
    _TK = re.compile(r"([A-Za-zÀ-ÖØ-öø-ÿ0-9’'_]+|[.,!?…;:]+|[\"“”()–—-])(\s*)", re.UNICODE)
    def _token_units(s: str):
        out = []
        for m in _TK.finditer(s or ""):
            tok, ws = m.group(1), m.group(2)
            out.append((tok + ws, tok))
        return out

async def _ws_send(ws, obj: dict):
    try:
        await ws.send(json.dumps(obj, ensure_ascii=False))
    except websockets.exceptions.ConnectionClosed:
        logger.debug("ws_send: connection closed")
    except Exception as e:
        logger.debug("ws_send error: %r", e)

# ──────────────────────────────────────────────────────────────────────────────
# Audio helpers
# ──────────────────────────────────────────────────────────────────────────────
def _apply_agc_peak_cpu(x: np.ndarray) -> np.ndarray:
    if x.size == 0:
        return x
    peak = float(np.max(np.abs(x)))
    if peak <= 1e-6 or peak >= AGC_TARGET_PEAK:
        return x
    gain = min(AGC_MAX_GAIN, AGC_TARGET_PEAK / max(peak, 1e-6))
    return np.clip(x * gain, -1.0, 1.0)

def _resample_cpu_to_16k(f32: np.ndarray, src_sr: int) -> np.ndarray:
    if f32.size == 0:
        return f32
    if src_sr == TGT_SR:
        return f32.astype(np.float32, copy=False)

    if _RESAMPLE_USES_SCIPY and src_sr == 48000 and TGT_SR == 16000:
        y = resample_poly(f32, up=1, down=3).astype(np.float32, copy=False)
    elif _RESAMPLE_USES_SCIPY and src_sr % TGT_SR == 0:
        y = resample_poly(f32, up=1, down=src_sr // TGT_SR).astype(np.float32, copy=False)
    else:
        if 'librosa' not in globals() or globals().get("librosa") is None:
            r = TGT_SR / float(src_sr)
            tgt_len = max(1, int(round(len(f32) * r)))
            xp = np.linspace(0, 1, len(f32), endpoint=False)
            xq = np.linspace(0, 1, tgt_len, endpoint=False)
            y = np.interp(xq, xp, f32).astype(np.float32, copy=False)
        else:
            y = globals()["librosa"].resample(f32, orig_sr=src_sr, target_sr=TGT_SR).astype(np.float32, copy=False)

    return np.nan_to_num(y, nan=0.0, posinf=1.0, neginf=-1.0)

def _resample_to_16k(f32: np.ndarray, src_sr: int) -> np.ndarray:
    if f32.size == 0:
        return f32
    y = _resample_cpu_to_16k(f32, src_sr)
    if ENABLE_AGC and y.size:
        y = _apply_agc_peak_cpu(y)
    return y

def _bytes_to_f32_auto(b: bytes, force_dtype: Optional[Literal["i16","f32"]] = None) -> np.ndarray:
    if not b:
        return np.empty(0, dtype=np.float32)

    if force_dtype == "i16":
        f = np.frombuffer(b, dtype=np.int16).astype(np.float32) / 32768.0
        return np.nan_to_num(f, nan=0.0, posinf=1.0, neginf=-1.0)
    if force_dtype == "f32":
        f = np.frombuffer(b, dtype=np.float32)
        return np.nan_to_num(f, nan=0.0, posinf=1.0, neginf=-1.0)

    # heuristic
    if len(b) % 4 == 0:
        f32 = np.frombuffer(b, dtype=np.float32)
        if f32.size and float(np.mean(np.abs(f32) <= 1.5)) > 0.9:
            return np.nan_to_num(f32, nan=0.0, posinf=1.0, neginf=-1.0)

    i16 = np.frombuffer(b, dtype=np.int16)
    f = i16.astype(np.float32) / 32768.0
    return np.nan_to_num(f, nan=0.0, posinf=1.0, neginf=-1.0)

def _f32_to_bytes_i16(x: np.ndarray) -> bytes:
    if x.size == 0:
        return b""
    x = np.nan_to_num(x, nan=0.0, posinf=1.0, neginf=-1.0)
    return (np.clip(x, -1.0, 1.0) * 32767.0).astype(np.int16, copy=False).tobytes()

# history sentences splitter
SENT_RE = re.compile(r'[^.!?…]*[.!?…]+(?:["”’\']+)?(?:\s+|$)')
def split_sentences_and_tail(text: str):
    sents = []
    last_end = 0
    for m in SENT_RE.finditer(text):
        sents.append(m.group(0))
        last_end = m.end()
    tail = text[last_end:]
    return sents, tail

# ──────────────────────────────────────────────────────────────────────────────
# Stabilizer helpers
# ──────────────────────────────────────────────────────────────────────────────
_TRAIL_PUNCT = " \t\r\n.,!?;:"

def _norm_spaces(s: str) -> str:
    return " ".join((s or "").strip().split())

def _strip_trailing_punct(s: str) -> str:
    return (s or "").rstrip(_TRAIL_PUNCT)

def _lcp_len(a: str, b: str) -> int:
    n = min(len(a), len(b))
    i = 0
    while i < n and a[i] == b[i]:
        i += 1
    return i

def _make_end_patch(old: str, new: str) -> Tuple[int, str, int]:
    c = _lcp_len(old, new)
    delete_n = len(old) - c
    insert = new[c:]
    return delete_n, insert, c

def _now_ms() -> int:
    return int(time.time() * 1000)

@dataclass
class StabilizerDecision:
    action: str      # append | rewrite | ignore | noop
    shown: str
    raw: str
    rollback_chars: int
    lcp: int
    pending: Optional[str]
    pending_count: int

class TranscriptStabilizer:
    """
    Append-mostly stabilizer:
      - Accept pure append immediately.
      - Accept small tail rewrite only after repeating N times.
      - Ignore shrink to avoid "text disappears".
      - Throttle rewrite frequency.
    """
    def __init__(
        self,
        rewrite_confirm_n: int,
        max_rollback_chars: int,
        min_rewrite_interval_ms: int,
        ignore_shrink: bool,
        allow_punct_strip_append: bool
    ):
        self.rewrite_confirm_n = max(1, int(rewrite_confirm_n))
        self.max_rollback_chars = max(0, int(max_rollback_chars))
        self.min_rewrite_interval_ms = max(0, int(min_rewrite_interval_ms))
        self.ignore_shrink = bool(ignore_shrink)
        self.allow_punct_strip_append = bool(allow_punct_strip_append)

        self.shown = ""
        self.pending = None
        self.pending_count = 0
        self.last_rewrite_ms = 0

    def reset(self, shown: str = ""):
        self.shown = _norm_spaces(shown)
        self.pending = None
        self.pending_count = 0
        self.last_rewrite_ms = 0

    def update(self, raw_text: str) -> StabilizerDecision:
        raw = _norm_spaces(raw_text)
        if raw == self.shown:
            return StabilizerDecision("noop", self.shown, raw, 0, len(self.shown), self.pending, self.pending_count)

        # ignore shrink (prefix shrink)
        if self.ignore_shrink and len(raw) < len(self.shown) and self.shown.startswith(raw):
            return StabilizerDecision("ignore", self.shown, raw, len(self.shown) - len(raw), len(raw), self.pending, self.pending_count)

        # pure append
        if raw.startswith(self.shown) and len(raw) > len(self.shown):
            self.shown = raw
            self.pending = None
            self.pending_count = 0
            return StabilizerDecision("append", self.shown, raw, 0, len(self.shown), self.pending, self.pending_count)

        # tolerant append with punctuation strip
        if self.allow_punct_strip_append:
            core_shown = _strip_trailing_punct(self.shown)
            core_raw = _strip_trailing_punct(raw)
            if core_raw.startswith(core_shown) and len(raw) > len(self.shown):
                self.shown = raw
                self.pending = None
                self.pending_count = 0
                return StabilizerDecision("append", self.shown, raw, 0, len(core_shown), self.pending, self.pending_count)

        # rewrite candidate
        c = _lcp_len(self.shown, raw)
        rollback = len(self.shown) - c
        if rollback > self.max_rollback_chars:
            return StabilizerDecision("ignore", self.shown, raw, rollback, c, self.pending, self.pending_count)

        tms = _now_ms()
        if (tms - self.last_rewrite_ms) < self.min_rewrite_interval_ms:
            return StabilizerDecision("ignore", self.shown, raw, rollback, c, self.pending, self.pending_count)

        if self.pending == raw:
            self.pending_count += 1
        else:
            self.pending = raw
            self.pending_count = 1

        if self.pending_count >= self.rewrite_confirm_n:
            self.shown = raw
            self.last_rewrite_ms = tms
            self.pending = None
            self.pending_count = 0
            return StabilizerDecision("rewrite", self.shown, raw, rollback, c, self.pending, self.pending_count)

        return StabilizerDecision("ignore", self.shown, raw, rollback, c, self.pending, self.pending_count)

# ──────────────────────────────────────────────────────────────────────────────
# Single-client lock (ONLY 1 USER AT A TIME)
# ──────────────────────────────────────────────────────────────────────────────
_client_lock: Optional[asyncio.Lock] = None
_active_client: Optional[str] = None

# ──────────────────────────────────────────────────────────────────────────────
# Real-time pacer (prevents burst feeding)
# ──────────────────────────────────────────────────────────────────────────────
class _RealTimePacer:
    def __init__(self, sr: int):
        self.sr = sr
        self.t0 = time.perf_counter()
        self.playhead = self.t0

    async def sleep_for_samples(self, nsamp: int):
        if not FORCE_REALTIME_PACE:
            return
        dur = float(nsamp) / float(self.sr)
        self.playhead += dur
        now = time.perf_counter()
        delay = self.playhead - now
        if delay > 0:
            await asyncio.sleep(delay)
        else:
            self.playhead = now

async def handler(websocket):
    global _active_client, _client_lock

    client = websocket.remote_address
    sess_id = f"{client[0]}:{client[1]}" if isinstance(client, (tuple, list)) and len(client) >= 2 else str(client)
    logger.info("[%s] connect", sess_id)

    if _client_lock is None:
        _client_lock = asyncio.Lock()

    # ---- SINGLE ACTIVE SESSION ----
    async with _client_lock:
        if _active_client is not None:
            logger.warning("[%s] reject: busy (active=%s)", sess_id, _active_client)
            await _ws_send(websocket, {"type": "error", "error": "Hệ thống bận", "code": "BUSY"})
            await websocket.close(code=1013, reason="busy")
            return
        _active_client = sess_id

    loop = asyncio.get_running_loop()

    # helper to schedule async safely from callback threads
    def _submit(coro):
        try:
            asyncio.run_coroutine_threadsafe(coro, loop)
        except Exception:
            logger.debug("[%s] schedule failed:\n%s", sess_id, traceback.format_exc())

    # ---- OPTIONAL AUTH ----
    authed_user: Optional[str] = None

    async def _auth_fail(reason="unauthorized"):
        await _ws_send(websocket, {"type":"error","error":"Unauthorized", "code":"UNAUTHORIZED"})
        try:
            await websocket.close(code=1008, reason=reason)
        except Exception:
            pass

    async def _authenticate() -> bool:
        nonlocal authed_user

        if not REQUIRE_AUTH or AUTH_MODE == "none":
            return True

        # 1) ticket in query ?ticket=...
        ticket = _extract_query_ticket(websocket)
        if ticket and AUTH_MODE in {"ticket","either"}:
            payload = _jwt_hs256_verify(ticket, WS_TICKET_SECRET)
            if payload:
                authed_user = str(payload.get("sub") or payload.get("user_id") or "user")
                await _ws_send(websocket, {"type":"auth_ok","user_id":authed_user,"mode":"ticket"})
                return True

        # 2) auth message first
        if AUTH_MODE in {"message","either"}:
            try:
                raw = await asyncio.wait_for(websocket.recv(), timeout=AUTH_TIMEOUT_SEC)
            except asyncio.TimeoutError:
                await _auth_fail("auth-timeout")
                return False
            except Exception:
                await _auth_fail("auth-failed")
                return False

            if not isinstance(raw, str):
                await _auth_fail("auth-required")
                return False

            try:
                obj = json.loads(raw)
            except Exception:
                await _auth_fail("auth-invalid-json")
                return False

            typ = (obj.get("type") or obj.get("event") or "").strip().lower()
            if typ not in {"auth"}:
                await _auth_fail("auth-required")
                return False

            token = (obj.get("token") or "").strip()
            if not token:
                await _auth_fail("auth-missing-token")
                return False

            if ACCESS_JWT_SECRET:
                payload = _jwt_hs256_verify(token, ACCESS_JWT_SECRET)
                if not payload:
                    await _auth_fail("auth-bad-token")
                    return False
                authed_user = str(payload.get("sub") or payload.get("user_id") or "user")
            else:
                # WARNING: no verification; do not use this for real production security.
                authed_user = "user"

            await _ws_send(websocket, {"type":"auth_ok","user_id":authed_user,"mode":"message"})
            return True

        await _auth_fail("auth-required")
        return False

    try:
        ok = await _authenticate()
        if not ok:
            return

        # transcript state (append-mostly)
        last_emitted: str = ""
        stable_snapshot: str = ""

        # debug counters for transcript behavior
        patch_seq = 0
        stable_seq = 0
        last_update_ts = time.monotonic()

        # patch rate limiting
        patch_min_interval_ms = int(1000.0 / max(1e-6, float(PATCH_MAX_HZ))) if PATCH_MAX_HZ > 0 else 0
        last_patch_send_ms = 0

        # thread-safety (callbacks come from RealtimeSTT threads)
        patch_lock = threading.Lock()

        # stabilizer (per session)
        stabilizer = TranscriptStabilizer(
            rewrite_confirm_n=REWRITE_CONFIRM_N,
            max_rollback_chars=MAX_ROLLBACK_CHARS,
            min_rewrite_interval_ms=MIN_REWRITE_INTERVAL_MS,
            ignore_shrink=IGNORE_SHRINK,
            allow_punct_strip_append=ALLOW_PUNCT_STRIP_APPEND,
        )

        ui_e2e_samples: List[float] = []
        ui_e2e_last_ms: float = 0.0
        last_audio_enq_ts: Optional[float] = None
        fed_enq_watermark_ts: Optional[float] = None

        warming_until_ts = time.monotonic() + max(0.0, WARMUP_SILENCE_SEC)

        # ──────────────────────────────────────────────────────────────────────
        # History (disable by default for product; enable explicitly)
        # ──────────────────────────────────────────────────────────────────────
        HISTORY_ENABLE = os.getenv("HISTORY_ENABLE", "0").lower() in {"1","true","yes"}
        CHAT_HISTORY_PATH: Optional[Path] = None
        history_q: Optional[asyncio.Queue] = None
        history_task: Optional[asyncio.Task] = None
        written_sent_count = 0

        if HISTORY_ENABLE:
            HISTORY_DIR = Path(os.getenv("HISTORY_DIR", "history")).expanduser()
            HISTORY_DIR.mkdir(parents=True, exist_ok=True)
            safe_id = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(authed_user or sess_id))
            CHAT_HISTORY_PATH = HISTORY_DIR / f"history_{safe_id}_{int(time.time())}.txt"
            history_q = asyncio.Queue()

            async def _history_writer():
                nonlocal written_sent_count
                try:
                    while True:
                        full_stable = await history_q.get()
                        if full_stable is None:
                            break
                        if not isinstance(full_stable, str):
                            continue

                        sents, _tail = split_sentences_and_tail(full_stable)
                        target = max(0, len(sents) - 1)  # keep last tail uncommitted

                        if target > written_sent_count and CHAT_HISTORY_PATH is not None:
                            new_sents = sents[written_sent_count:target]
                            try:
                                with open(CHAT_HISTORY_PATH, "a", encoding="utf-8") as f:
                                    for s in new_sents:
                                        s = s.strip()
                                        if s:
                                            f.write(s + "\n")
                                    f.flush()
                                    os.fsync(f.fileno())
                                written_sent_count = target
                            except Exception as e:
                                logger.debug("[%s] history write failed: %r", sess_id, e)
                except Exception as e:
                    logger.debug("[%s] history writer crashed: %r", sess_id, e)

            history_task = asyncio.create_task(_history_writer())

        # ──────────────────────────────────────────────────────────────────────
        # Patch emitter (end-diff) + optional chunking
        # ──────────────────────────────────────────────────────────────────────
        async def _emit_patch_insert_chunked(delete_chars: int, insert_text: str, seq: int, dbg: Optional[Dict[str, Any]] = None):
            """
            Send patch using end-diff semantics: delete N chars from end, then insert.
            We optionally chunk insert_text into smaller pieces (micro delta) to smooth UI.
            """
            t_ms = int(time.time() * 1000)

            if not insert_text:
                if delete_chars:
                    msg = {"type": "patch", "delete": int(delete_chars), "insert": "", "seq": int(seq), "t_ms": t_ms}
                    if dbg:
                        msg["_dbg"] = dbg
                    await _ws_send(websocket, msg)
                return

            if not UI_MICRO_DELTA_ENABLE:
                msg = {"type": "patch", "delete": int(delete_chars), "insert": insert_text, "seq": int(seq), "t_ms": t_ms}
                if dbg:
                    msg["_dbg"] = dbg
                await _ws_send(websocket, msg)
                return

            maxc = max(8, int(UI_MICRO_DELTA_MAX_CHARS))
            minc = max(1, min(int(UI_MICRO_DELTA_MIN_SLICE_CHARS), maxc))

            units = _token_units(insert_text)  # list[(emit, core)]
            buf = []
            cur_len = 0
            first = True

            for emit, _core in units:
                l = len(emit)
                if buf and (cur_len + l > maxc) and (cur_len >= minc):
                    chunk = "".join(x[0] for x in buf)
                    msg = {"type": "patch", "delete": int(delete_chars if first else 0), "insert": chunk, "seq": int(seq), "t_ms": t_ms}
                    if dbg:
                        msg["_dbg"] = dbg if first else {"cont": True}
                    await _ws_send(websocket, msg)
                    first = False
                    buf = [(emit, _core)]
                    cur_len = l
                else:
                    buf.append((emit, _core))
                    cur_len += l

            if buf:
                chunk = "".join(x[0] for x in buf)
                msg = {"type": "patch", "delete": int(delete_chars if first else 0), "insert": chunk, "seq": int(seq), "t_ms": t_ms}
                if dbg:
                    msg["_dbg"] = dbg if first else {"cont": True}
                await _ws_send(websocket, msg)

        def _patch_from_model_text(raw_text: str):
            """
            Called from RealtimeSTT thread.
            We stabilize raw_text -> shown_text, then do end-diff patch against last_emitted.
            """
            nonlocal last_emitted, patch_seq, last_update_ts, last_patch_send_ms
            nonlocal ui_e2e_last_ms, last_audio_enq_ts, ui_e2e_samples, fed_enq_watermark_ts, warming_until_ts

            if time.monotonic() < warming_until_ts:
                return

            raw = _norm_spaces(raw_text or "")
            if not raw:
                return

            # e2e sample for debug
            _ref_ts = fed_enq_watermark_ts if fed_enq_watermark_ts is not None else last_audio_enq_ts
            if _ref_ts is not None:
                ui_e2e_last_ms = (time.monotonic() - _ref_ts) * 1000.0
                if 0.0 < ui_e2e_last_ms < 3000.0:
                    ui_e2e_samples.append(ui_e2e_last_ms)

            with patch_lock:
                # Stabilize
                if STAB_ENABLE:
                    dec = stabilizer.update(raw)
                    shown = dec.shown
                else:
                    dec = StabilizerDecision("noop", raw, raw, 0, 0, None, 0)
                    shown = raw

                if shown == last_emitted:
                    return

                # rate limit patch output
                now_ms = _now_ms()
                if patch_min_interval_ms > 0 and (now_ms - last_patch_send_ms) < patch_min_interval_ms:
                    return

                # compute end-diff
                delete_chars, insert_text, lcp = _make_end_patch(last_emitted, shown)

                patch_seq += 1
                seq = patch_seq
                last_patch_send_ms = now_ms

                # update local state immediately (avoid race)
                prev = last_emitted
                last_emitted = shown

            # tracing outside lock
            now_ts = time.monotonic()
            dt_ms = (now_ts - last_update_ts) * 1000.0
            last_update_ts = now_ts

            if TRACE_PATCH and (seq % max(1, TRACE_PATCH_EVERY) == 0):
                tail = shown[-TRACE_PATCH_MAX_TAIL:]
                logger.info(
                    "[%s] PATCH#%d dt=%.1fms action=%s rollback=%d del=%d ins=%d lcp=%d prev_tail=%r new_tail=%r",
                    sess_id, seq, dt_ms, dec.action, int(dec.rollback_chars),
                    int(delete_chars), len(insert_text), int(lcp),
                    prev[-min(len(prev), TRACE_PATCH_MAX_TAIL):],
                    tail
                )

            dbg = {
                "action": dec.action,
                "rollback": int(dec.rollback_chars),
                "lcp": int(lcp),
                "raw_len": int(len(dec.raw)),
                "shown_len": int(len(shown)),
                "del": int(delete_chars),
                "ins_len": int(len(insert_text)),
                "pending_n": int(dec.pending_count),
            }

            _submit(_emit_patch_insert_chunked(int(delete_chars), insert_text, int(seq), dbg))

        # Callbacks (called from RealtimeSTT threads!)
        def _on_update_cb(text: str):
            _patch_from_model_text(text)

        def _on_stable_cb(text: str):
            nonlocal stable_snapshot, warming_until_ts, stable_seq, last_emitted, last_patch_send_ms

            if time.monotonic() < warming_until_ts:
                return
            t = _norm_spaces(text or "")
            if not t:
                return

            # stable should be monotonic
            if len(t) >= len(stable_snapshot):
                stable_snapshot = t

            stable_seq += 1
            t_ms = int(time.time() * 1000)

            # Reset stabilizer to stable snapshot, and also sync last_emitted (avoid extra jumps)
            with patch_lock:
                stabilizer.reset(stable_snapshot)
                last_emitted = stable_snapshot
                last_patch_send_ms = _now_ms()

            if TRACE_PATCH and (stable_seq % max(1, TRACE_PATCH_EVERY) == 0):
                logger.info("[%s] STABLE#%d len=%d tail=%r", sess_id, stable_seq, len(stable_snapshot), stable_snapshot[-TRACE_PATCH_MAX_TAIL:])

            _submit(_ws_send(websocket, {
                "type": "stable",
                "full": stable_snapshot,
                "seq": int(stable_seq),
                "t_ms": t_ms,
            }))

            if HISTORY_ENABLE and history_q is not None:
                try:
                    history_q.put_nowait(stable_snapshot)
                except Exception:
                    pass

        def _make_recorder(ct: str) -> AudioToTextRecorder:
            logger.info("[%s] init recorder: model=%s device=%s compute_type=%s lang=%s",
                        sess_id, STT_MODEL, STT_DEVICE, ct, STT_LANGUAGE)
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

        # ──────────────────────────────────────────────────────────────────────
        # Init recorder
        # ──────────────────────────────────────────────────────────────────────
        try:
            try:
                recorder = _make_recorder(STT_COMPUTE_TYPE)
            except ValueError as e:
                logger.warning("[%s] compute_type=%s failed (%r) -> fallback=%s",
                               sess_id, STT_COMPUTE_TYPE, e, STT_COMPUTE_FALLBACK)
                recorder = _make_recorder(STT_COMPUTE_FALLBACK)

            if hasattr(recorder, "start"):
                recorder.start()
                logger.info("[%s] recorder.start OK", sess_id)

            if WARMUP_SILENCE_SEC > 0:
                logger.info("[%s] warmup silence %.3fs", sess_id, WARMUP_SILENCE_SEC)
                silence = np.zeros(int(WARMUP_SILENCE_SEC * TGT_SR), dtype=np.float32)
                t0 = 0
                while t0 + FRAME_SAMPLES_BASE <= silence.size:
                    frame = silence[t0:t0+FRAME_SAMPLES_BASE]
                    recorder.feed_audio(_f32_to_bytes_i16(frame))
                    t0 += FRAME_SAMPLES_BASE

        except Exception as e:
            logger.error("[%s] INIT FAILED: %r\n%s", sess_id, e, traceback.format_exc())
            await _ws_send(websocket, {"type": "error", "error": f"Init lỗi: {e}", "code":"INIT_FAILED"})
            await websocket.close(code=1011, reason="init failed")
            return

        # ──────────────────────────────────────────────────────────────────────
        # Session vars
        # ──────────────────────────────────────────────────────────────────────
        session_src_sr = DEFAULT_SRC_SR
        session_force_dtype: Optional[Literal["i16","f32"]] = None
        session_started = False

        queue: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAX)
        queue_bytes_total = 0
        qbytes_max = 0

        items_enqueued = 0
        items_processed = 0
        frames_fed_total = 0

        # Float buffer + segment timestamps for e2e watermark
        bufq: deque = deque()
        buf_samples: int = 0
        pending_segments = deque()  # each: [nsamp, enq_ts]

        def _bufq_append(arr: np.ndarray, enq_ts: float):
            nonlocal buf_samples
            if arr.size == 0:
                return
            bufq.append(arr)
            buf_samples += int(arr.size)
            pending_segments.append([int(arr.size), float(enq_ts)])

        def _bufq_available() -> int:
            return buf_samples

        def _bufq_consume_samples(n: int) -> np.ndarray:
            nonlocal buf_samples
            n = int(n)
            if n <= 0:
                return np.empty(0, dtype=np.float32)
            out = np.empty(n, dtype=np.float32)
            off = 0
            while off < n and bufq:
                head = bufq[0]
                take = min(n - off, head.size)
                out[off:off+take] = head[:take]
                if take == head.size:
                    bufq.popleft()
                else:
                    bufq[0] = head[take:]
                off += take
                buf_samples -= take
            return out

        def _consume_segments(samples_to_consume: int):
            nonlocal fed_enq_watermark_ts
            remain = int(max(0, samples_to_consume))
            last_ts = None
            while remain > 0 and pending_segments:
                seg_len, seg_ts = pending_segments[0]
                if seg_len <= remain:
                    remain -= seg_len
                    last_ts = seg_ts
                    pending_segments.popleft()
                else:
                    pending_segments[0][0] = seg_len - remain
                    last_ts = seg_ts
                    remain = 0
            if last_ts is not None:
                fed_enq_watermark_ts = last_ts

        def _buf_ms_now() -> float:
            return (_bufq_available() / float(TGT_SR)) * 1000.0

        def _buf_drop_oldest_to_ms(target_ms: float):
            nonlocal buf_samples
            target_ms = max(0.0, float(target_ms))
            target_samples = int((target_ms / 1000.0) * TGT_SR)
            cur = _bufq_available()
            if cur <= target_samples:
                return
            drop = cur - target_samples
            while drop > 0 and bufq:
                head = bufq[0]
                take = min(drop, head.size)
                if take == head.size:
                    bufq.popleft()
                else:
                    bufq[0] = head[take:]
                drop -= take
                buf_samples -= take
                _consume_segments(take)

        # Feed worker (real-time pacing)
        async def feed_worker():
            nonlocal queue_bytes_total, qbytes_max, items_processed, frames_fed_total

            pacer = _RealTimePacer(TGT_SR)
            last_log_t = time.monotonic()
            last_status_t = time.monotonic()

            try:
                while True:
                    item = await queue.get()
                    if item is None:
                        hop = FRAME_SAMPLES_BASE
                        while _bufq_available() >= hop:
                            frame = _bufq_consume_samples(hop)
                            recorder.feed_audio(_f32_to_bytes_i16(frame))
                            _consume_segments(hop)
                            frames_fed_total += 1
                            await pacer.sleep_for_samples(hop)

                        tail = np.zeros(int(TAIL_SILENCE_SEC * TGT_SR), dtype=np.float32)
                        t0 = 0
                        while t0 + hop <= tail.size:
                            frame = tail[t0:t0+hop]
                            recorder.feed_audio(_f32_to_bytes_i16(frame))
                            frames_fed_total += 1
                            await pacer.sleep_for_samples(hop)
                            t0 += hop

                        logger.info("[%s] feed_worker EOS", sess_id)
                        break

                    nbytes_item = int(item.get("nbytes", 0))
                    enq_ts = float(item.get("enq_ts", time.monotonic()))
                    if nbytes_item > 0:
                        queue_bytes_total = max(0, queue_bytes_total - nbytes_item)
                    qbytes_max = max(qbytes_max, queue_bytes_total)

                    buf = item.get("buf", b"")
                    sr = int(item.get("sr", DEFAULT_SRC_SR))
                    dt = item.get("dtype", None)

                    if isinstance(buf, bytes):
                        f32_src = _bytes_to_f32_auto(buf, force_dtype=dt)
                    elif isinstance(buf, np.ndarray):
                        f32_src = np.nan_to_num(buf.astype(np.float32, copy=False), nan=0.0, posinf=1.0, neginf=-1.0)
                    else:
                        f32_src = np.empty(0, dtype=np.float32)

                    f32_16k = _resample_to_16k(f32_src, sr) if f32_src.size else f32_src
                    if f32_16k.size:
                        _bufq_append(f32_16k, enq_ts)

                    if MAX_BUF_MS > 0 and _buf_ms_now() > MAX_BUF_MS:
                        _buf_drop_oldest_to_ms(DROP_BUF_TO_MS)

                    hop = FRAME_SAMPLES_BASE
                    while _bufq_available() >= hop:
                        frame = _bufq_consume_samples(hop)
                        recorder.feed_audio(_f32_to_bytes_i16(frame))
                        _consume_segments(hop)
                        frames_fed_total += 1

                        await pacer.sleep_for_samples(hop)

                        if (frames_fed_total % 8) == 0:
                            await asyncio.sleep(0)

                    items_processed += 1

                    now_m = time.monotonic()
                    if now_m - last_log_t >= LOG_STATUS_EVERY:
                        logger.info("[%s] feed: q=%d bytes=%s buf_ms=%.1f frames=%d ui_e2e=%.1f",
                                    sess_id, queue.qsize(), _human_bytes(queue_bytes_total),
                                    _buf_ms_now(), frames_fed_total, ui_e2e_last_ms)
                        last_log_t = now_m

                    if now_m - last_status_t >= float(os.getenv("STATUS_INTERVAL_SEC", "0.5")):
                        rss_mb = (_PROC.memory_info().rss / (1024.0*1024.0)) if _PROC else None
                        nvml_pair = _nvml_mem_mb()

                        detail = {
                            "device": STT_DEVICE,
                            "gpu_name": GPU_NAME,
                            "ct2_cuda_device_count": int(_CT2_CUDA_COUNT),
                            "frames_total": int(frames_fed_total),
                            "queue": int(queue.qsize()),
                            "bytes_in_queue": int(queue_bytes_total),
                            "qbytes_cap": int(QBYTES_HARD_CAP),
                            "qbytes_max": int(qbytes_max),
                            "buf_ms": float(round(_buf_ms_now(), 2)),
                            "ui_e2e_ms_last": float(round(ui_e2e_last_ms, 3)),
                            "force_realtime_pace": bool(FORCE_REALTIME_PACE),
                            "max_buf_ms": float(MAX_BUF_MS),
                            "drop_buf_to_ms": float(DROP_BUF_TO_MS),
                            "stabilizer": {
                                "enable": bool(STAB_ENABLE),
                                "patch_max_hz": float(PATCH_MAX_HZ),
                                "rewrite_confirm_n": int(REWRITE_CONFIRM_N),
                                "max_rollback_chars": int(MAX_ROLLBACK_CHARS),
                                "min_rewrite_interval_ms": int(MIN_REWRITE_INTERVAL_MS),
                                "ignore_shrink": bool(IGNORE_SHRINK),
                            }
                        }
                        if rss_mb is not None:
                            detail["rss_mb"] = float(rss_mb)
                        if nvml_pair is not None:
                            detail["gpu_nvml_mb"] = {"used": nvml_pair[0], "total": nvml_pair[1]}

                        await _ws_send(websocket, {"type": "status", "stage": "FEED", "detail": detail})
                        last_status_t = now_m

            except Exception as e:
                logger.error("[%s] feed_worker crashed: %r\n%s", sess_id, e, traceback.format_exc())

        worker_task = asyncio.create_task(feed_worker())

        # hello
        await _ws_send(websocket, {
            "type": "hello",
            "detail": {
                "sample_rate_in_default": DEFAULT_SRC_SR,
                "sample_rate_out": TGT_SR,
                "frame_ms": FRAME_MS,
                "tail_silence_sec": TAIL_SILENCE_SEC,
                "queue_max": QUEUE_MAX,
                "patch": True,
                "device": STT_DEVICE,
                "gpu_name": GPU_NAME,
                "ct2_cuda_device_count": int(_CT2_CUDA_COUNT),
                "compute_type": STT_COMPUTE_TYPE,
                "model": STT_MODEL,
                "hf_offline": os.getenv("HF_HUB_OFFLINE"),
                "qbytes_cap": int(QBYTES_HARD_CAP),
                "hint_client_frame_48k": 960,
                "force_realtime_pace": bool(FORCE_REALTIME_PACE),
                "max_buf_ms": float(MAX_BUF_MS),
                "drop_buf_to_ms": float(DROP_BUF_TO_MS),
                "idle_timeout_sec": float(IDLE_TIMEOUT_SEC),
                "auth_required": bool(REQUIRE_AUTH),
                "stabilizer": {
                    "enable": bool(STAB_ENABLE),
                    "patch_max_hz": float(PATCH_MAX_HZ),
                    "rewrite_confirm_n": int(REWRITE_CONFIRM_N),
                    "max_rollback_chars": int(MAX_ROLLBACK_CHARS),
                    "min_rewrite_interval_ms": int(MIN_REWRITE_INTERVAL_MS),
                    "ignore_shrink": bool(IGNORE_SHRINK),
                    "allow_punct_strip_append": bool(ALLOW_PUNCT_STRIP_APPEND),
                }
            }
        })

        logger.info("[%s] hello sent", sess_id)

        def _drop_oldest_until_under(cap: int):
            nonlocal queue_bytes_total
            if cap <= 0:
                return
            try:
                while queue_bytes_total >= cap and not queue.empty():
                    old = queue.get_nowait()
                    if isinstance(old, dict):
                        queue_bytes_total = max(0, queue_bytes_total - int(old.get("nbytes", 0)))
            except Exception:
                pass

        ws_recv_count = 0

        try:
            while True:
                try:
                    # IMPORTANT: idle timeout so single-user slot is released
                    msg = await asyncio.wait_for(websocket.recv(), timeout=IDLE_TIMEOUT_SEC)
                    ws_recv_count += 1
                except asyncio.TimeoutError:
                    logger.info("[%s] idle-timeout (%ss) -> close", sess_id, IDLE_TIMEOUT_SEC)
                    await _ws_send(websocket, {"type":"error","error":"Hết thời gian chờ (idle)","code":"IDLE_TIMEOUT"})
                    break
                except websockets.exceptions.ConnectionClosed as e:
                    logger.info("[%s] disconnected: %r", sess_id, e)
                    break
                except Exception as e:
                    logger.error("[%s] websocket.recv error: %r\n%s", sess_id, e, traceback.format_exc())
                    break

                if ws_recv_count % max(1, LOG_WS_EVERY_N) == 0:
                    logger.debug("[%s] recv #%d type=%s", sess_id, ws_recv_count, type(msg).__name__)

                # Binary audio
                if isinstance(msg, (bytes, bytearray)):
                    if not session_started:
                        if AUTO_START:
                            session_started = True
                            await _ws_send(websocket, {"type":"ack","detail":{
                                "src_sr": DEFAULT_SRC_SR,
                                "dtype": session_force_dtype or "auto",
                                "auto_started": True
                            }})
                            logger.info("[%s] auto-start (binary)", sess_id)
                        else:
                            continue

                    raw = bytes(msg)

                    if raw and (items_enqueued % max(1, LOG_AUDIO_EVERY_N) == 0):
                        logger.debug("[%s] binary audio len=%d q=%d bytes_in_q=%s",
                                     sess_id, len(raw), queue.qsize(), _human_bytes(queue_bytes_total))

                    if DROP_OLDEST_ON_FULL and queue.qsize() >= DROP_GUARD_Q:
                        try:
                            old = queue.get_nowait()
                            if isinstance(old, dict):
                                queue_bytes_total = max(0, queue_bytes_total - int(old.get("nbytes", 0)))
                        except Exception:
                            pass

                    nbytes = len(raw)
                    await queue.put({
                        "kind":"audio","buf":raw,"sr":session_src_sr,"dtype":session_force_dtype,
                        "nbytes": nbytes, "enq_ts": time.monotonic()
                    })
                    last_audio_enq_ts = time.monotonic()
                    queue_bytes_total += nbytes

                    if QBYTES_HARD_CAP > 0 and queue_bytes_total >= QBYTES_HARD_CAP:
                        _drop_oldest_until_under(QBYTES_HARD_CAP)

                    qbytes_max = max(qbytes_max, queue_bytes_total)
                    items_enqueued += 1
                    continue

                # JSON messages
                if isinstance(msg, str):
                    try:
                        obj = json.loads(msg)
                    except Exception:
                        logger.debug("[%s] recv non-json str: %s", sess_id, (msg[:120] + "..." if len(msg) > 120 else msg))
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
                        logger.info("[%s] start event | sr=%d dtype=%s", sess_id, session_src_sr, session_force_dtype or "auto")
                        continue

                    if event in {"stop","eos","end"}:
                        logger.info("[%s] stop event=%s", sess_id, event)
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
                                logger.info("[%s] auto-start (json audio)", sess_id)
                            else:
                                continue

                        try:
                            raw = base64.b64decode(obj["audio"])
                            sr = int(obj.get("sr", session_src_sr))
                            dt = obj.get("dtype", session_force_dtype)
                            dt = (dt.lower() if isinstance(dt, str) else None)

                            if items_enqueued % max(1, LOG_AUDIO_EVERY_N) == 0:
                                logger.debug("[%s] json audio len=%d sr=%d dtype=%s q=%d bytes_in_q=%s",
                                             sess_id, len(raw), sr, dt or "auto", queue.qsize(), _human_bytes(queue_bytes_total))

                            if DROP_OLDEST_ON_FULL and queue.qsize() >= DROP_GUARD_Q:
                                try:
                                    old = queue.get_nowait()
                                    if isinstance(old, dict):
                                        queue_bytes_total = max(0, queue_bytes_total - int(old.get("nbytes", 0)))
                                except Exception:
                                    pass

                            nbytes = len(raw)
                            await queue.put({
                                "kind":"audio","buf":raw,"sr":sr,
                                "dtype": (dt if dt in {"i16","f32"} else None),
                                "nbytes": nbytes, "enq_ts": time.monotonic()
                            })
                            last_audio_enq_ts = time.monotonic()
                            queue_bytes_total += nbytes

                            if QBYTES_HARD_CAP > 0 and queue_bytes_total >= QBYTES_HARD_CAP:
                                _drop_oldest_until_under(QBYTES_HARD_CAP)

                            qbytes_max = max(qbytes_max, queue_bytes_total)
                            items_enqueued += 1

                        except Exception as e:
                            logger.error("[%s] json audio handling error: %r\n%s", sess_id, e, traceback.format_exc())
                        continue

        finally:
            logger.info("[%s] closing session...", sess_id)
            try:
                await queue.put(None)
            except Exception:
                pass
            try:
                await asyncio.wait_for(worker_task, timeout=12.0)
            except asyncio.TimeoutError:
                logger.warning("[%s] worker_task timeout", sess_id)
            except Exception as e:
                logger.debug("[%s] worker_task join error: %r", sess_id, e)

            try:
                if 'recorder' in locals() and hasattr(recorder, "stop"):
                    recorder.stop()
                if 'recorder' in locals() and hasattr(recorder, "shutdown"):
                    recorder.shutdown()
                logger.info("[%s] recorder stopped", sess_id)
            except Exception as e:
                logger.warning("[%s] recorder stop/shutdown error: %r", sess_id, e)

            if HISTORY_ENABLE and history_q is not None and history_task is not None:
                try:
                    await history_q.put(None)
                    await asyncio.wait_for(history_task, timeout=3.0)
                except Exception:
                    pass

    finally:
        # ALWAYS release single-user slot
        if _client_lock is None:
            _client_lock = asyncio.Lock()
        async with _client_lock:
            if _active_client == sess_id:
                _active_client = None
        logger.info("[%s] disconnected/cleanup done (slot released)", sess_id)

async def main():
    host = WS_HOST
    port = WS_PORT
    logger.info("Serving WS on %s:%d", host, port)

    compression = os.getenv("WS_COMPRESSION", "deflate").strip().lower()
    compression = None if compression in {"0","none","off","false"} else "deflate"

    async with websockets.serve(
        handler, host, port,
        max_size=None,
        ping_interval=20, ping_timeout=20,
        compression=compression,
    ):
        await asyncio.Future()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("KeyboardInterrupt -> exit")
    except Exception as e:
        logger.error("FATAL: %r\n%s", e, traceback.format_exc())
        raise
