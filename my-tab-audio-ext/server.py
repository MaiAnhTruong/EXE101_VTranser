import os, sys, json, time, math, base64, asyncio, logging, re
from pathlib import Path
from typing import Optional, Literal, Dict, Any, List, Tuple
from collections import deque
import numpy as np
import websockets

logging.disable(logging.CRITICAL)
logger = logging.getLogger("stt-server") 

try:
    if os.getenv("USE_UVLOOP", "1").lower() in {"1","true","yes"}:
        import uvloop  
        uvloop.install()
except Exception:
    pass

_RESAMPLE_USES_SCIPY = True
try:
    from scipy.signal import resample_poly
except Exception:
    _RESAMPLE_USES_SCIPY = False
    try:
        import librosa  
    except Exception:
        librosa = None  

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

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
TAIL_SILENCE_SEC = float(os.getenv("TAIL_SILENCE_SEC", "1.0"))
FRAME_SAMPLES_BASE = int(TGT_SR * (FRAME_MS / 1000.0))

PACE_MODE = os.getenv("PACE_MODE", "auto").strip().lower()
if PACE_MODE not in {"auto","on","off"}:
    PACE_MODE = "auto"
PACE_REALTIME_LEGACY = os.getenv("PACE_REALTIME", "").strip().lower() in {"1","true","yes"}

PACE_DISABLE_Q = int(os.getenv("PACE_DISABLE_Q", os.getenv("BACKLOG_DISABLE_PACING", "4")))
PACE_RESUME_Q  = int(os.getenv("PACE_RESUME_Q",  os.getenv("BACKLOG_RESUME_PACING", "3")))
PACE_MIN_DWELL_MS = int(os.getenv("PACE_MIN_DWELL_MS", "800"))
GRACE_SEC = float(os.getenv("GRACE_SEC", "1.5"))
EMA_TAU_SEC = float(os.getenv("EMA_TAU_SEC", "0.6"))
PACE_MIN_HOLD_DASHES = int(os.getenv("PACE_MIN_HOLD_DASHES", "1"))
PACE_CRIT_STAGE_MS = float(os.getenv("PACE_CRIT_STAGE_MS", "120"))

EARLYCUT_P90_MARGIN_MS = float(os.getenv("EARLYCUT_P90_MARGIN_MS", "20"))
STAGE_EWMA_TAU_SEC = float(os.getenv("STAGE_EWMA_TAU_SEC", "0.8"))

PREBUF_LO_MS_BASE = float(os.getenv("PREBUF_LO_MS", "20"))
PREBUF_HI_MS_BASE = float(os.getenv("PREBUF_HI_MS", "60"))
ADAPT_PREBUF = os.getenv("ADAPT_PREBUF", "1").strip().lower() in {"1","true","yes"}

PREBUF_UP_UI_P90_MS = float(os.getenv("PREBUF_UP_UI_P90_MS", "85"))
PREBUF_UP_AVG_Q = float(os.getenv("PREBUF_UP_AVG_Q", "1.8"))
PREBUF_UP_CONSEC_WINDOWS = int(os.getenv("PREBUF_UP_CONSEC_WINDOWS", "2"))

PREBUF_DOWN_UI_P90_MS = float(os.getenv("PREBUF_DOWN_UI_P90_MS", "60"))
PREBUF_DOWN_AVG_Q = float(os.getenv("PREBUF_DOWN_AVG_Q", "1.0"))
PREBUF_DOWN_CONSEC_WINDOWS = int(os.getenv("PREBUF_DOWN_CONSEC_WINDOWS", "2"))

PREBUF_BUMP_MAX = float(os.getenv("PREBUF_BUMP_MAX", "10"))
DERAMP_LOG = os.getenv("DERAMP_LOG", "1").strip().lower() in {"1","true","yes"}
SPEAKING_PREBUF_HI_DELTA_MS = float(os.getenv("SPEAKING_PREBUF_HI_DELTA_MS", "8"))

ADAPT_PACE = os.getenv("ADAPT_PACE", "1").strip().lower() in {"1","true","yes"}
TOGGLE_HIGH = int(os.getenv("TOGGLE_HIGH", "6"))
DWELL_BUMP_MS = int(os.getenv("DWELL_BUMP_MS", "200"))

COALESCE_ENABLE = os.getenv("COALESCE_ENABLE", "1").strip().lower() in {"1","true","yes"}
COALESCE_MAX = max(1, int(os.getenv("COALESCE_MAX", "3")))
E2E_COALESCE_TRIG_MS = float(os.getenv("E2E_COALESCE_TRIG_MS", "28"))
Q_COALESCE_TRIG = float(os.getenv("Q_COALESCE_TRIG", "2.0"))
COALESCE_HYST_DOWN_WINDOWS = int(os.getenv("COALESCE_HYST_DOWN_WINDOWS", "3"))
FAST_STRIDE_DROP_P90_MS = float(os.getenv("FAST_STRIDE_DROP_P90_MS", "50"))
SPEECH_STRIDE_CAP = int(os.getenv("SPEECH_STRIDE_CAP", "2"))

COALESCE_OVERLOAD_Q_CAP = float(os.getenv("COALESCE_OVERLOAD_Q_CAP", "6.0"))
COALESCE_OVERLOAD_P90_CAP_MS = float(os.getenv("COALESCE_OVERLOAD_P90_CAP_MS", "180"))
PREBUF_COMPUTE_WARN_Q = float(os.getenv("PREBUF_COMPUTE_WARN_Q", "3.0"))
PREBUF_COMPUTE_WARN_P90_MS = float(os.getenv("PREBUF_COMPUTE_WARN_P90_MS", "150"))

SEVERE_OVERLOAD_Q = float(os.getenv("SEVERE_OVERLOAD_Q", "10.0"))
SEVERE_OVERLOAD_P90_MS = float(os.getenv("SEVERE_OVERLOAD_P90_MS", "300"))
SEVERE_OVERLOAD_STRIDE1_HOLD_DASHES = int(os.getenv("SEVERE_OVERLOAD_STRIDE1_HOLD_DASHES", "2"))

RMS_SPEECH_THRESH = float(os.getenv("RMS_SPEECH_THRESH", "0.015"))
SPEECH_RATIO_UP = float(os.getenv("SPEECH_RATIO_UP", "0.5"))
SPEECH_RATIO_DOWN = float(os.getenv("SPEECH_RATIO_DOWN", "0.2"))

QUEUE_MAX = int(os.getenv("QUEUE_MAX", "16"))
DROP_OLDEST_ON_FULL = os.getenv("DROP_OLDEST_ON_FULL", "1").strip().lower() in {"1","true","yes"}
QGUARD_HARD_DROP = os.getenv("QGUARD_HARD_DROP", "0").strip().lower() in {"1","true","yes"}
DROP_GUARD_Q = int(os.getenv("DROP_GUARD_Q", str(max(1, QUEUE_MAX - 1))))
QGUARD_SOFT_TRIM_MS = int(os.getenv("QGUARD_SOFT_TRIM_MS", "12"))
QGUARD_SOFT_TRIM_RMS = float(os.getenv("QGUARD_SOFT_TRIM_RMS", "0.010"))
TRIMS_WINDOW_HIGH = int(os.getenv("TRIMS_WINDOW_HIGH", "30"))

QBYTES_HARD_CAP = int(os.getenv("QBYTES_HARD_CAP", str(48 * 1024)))
NEAR_DROP_RATIO = float(os.getenv("NEAR_DROP_RATIO", "0.7"))
QBYTES_TALKING_MULT = float(os.getenv("QBYTES_TALKING_MULT", "2.1"))
TALK_SPEAK_RATIO_THRESH = float(os.getenv("TALK_SPEAK_RATIO_THRESH", "0.5"))

ENABLE_AGC = os.getenv("ENABLE_AGC", "1").strip().lower() in {"1","true","yes"}
AGC_TARGET_PEAK = float(os.getenv("AGC_TARGET_PEAK", "0.95"))
AGC_MAX_GAIN = float(os.getenv("AGC_MAX_GAIN", "6.0"))

AUTO_START = os.getenv("AUTO_START", "1").strip().lower() in {"1","true","yes"}

OVERLOAD_Q = float(os.getenv("OVERLOAD_Q", "4.0"))
OVERLOAD_P90_MS = float(os.getenv("OVERLOAD_P90_MS", "120"))
DOWNSHIFT_MIN_HOLD_DASHES = int(os.getenv("DOWNSHIFT_MIN_HOLD_DASHES", "12"))
OVERLOAD_CONSEC_WINDOWS = int(os.getenv("OVERLOAD_CONSEC_WINDOWS", "1"))

UI_MICRO_DELTA_ENABLE = os.getenv("UI_MICRO_DELTA_ENABLE", "1").strip().lower() in {"1","true","yes"}
UI_MICRO_DELTA_MAX_CHARS = int(os.getenv("UI_MICRO_DELTA_MAX_CHARS", "48"))
UI_MICRO_DELTA_MIN_SLICE_CHARS = int(os.getenv("UI_MICRO_DELTA_MIN_SLICE_CHARS", "12"))

WARMUP_SILENCE_SEC = float(os.getenv("WARMUP_SILENCE_SEC", "0.2"))

try:
    import psutil
    _PROC = psutil.Process()
except Exception:
    psutil = None
    _PROC = None

_nvml_ok = False
try:
    import pynvml  
    pynvml.nvmlInit()
    _nvml_handle = pynvml.nvmlDeviceGetHandleByIndex(int(os.getenv("GPU_ID", "0")))
    _nvml_ok = True
except Exception:
    _nvml_ok = False

def _nvml_mem_mb():
    if not _nvml_ok:
        return None
    try:
        info = pynvml.nvmlDeviceGetMemoryInfo(_nvml_handle)
        return float(info.used / (1024.0*1024.0)), float(info.total / (1024.0*1024.0))
    except Exception:
        return None

def _nvml_stats_all():
    if not _nvml_ok:
        return None
    out: Dict[str, Any] = {}
    try:
        util = pynvml.nvmlDeviceGetUtilizationRates(_nvml_handle)
        out["util"] = {"gpu": float(util.gpu), "mem": float(util.memory)}
    except Exception:
        pass
    try:
        temp = pynvml.nvmlDeviceGetTemperature(_nvml_handle, pynvml.NVML_TEMPERATURE_GPU)
        out["tempC"] = float(temp)
    except Exception:
        pass
    try:
        out["clocks"] = {
            "graphics": float(pynvml.nvmlDeviceGetClockInfo(_nvml_handle, pynvml.NVML_CLOCK_GRAPHICS)),
            "sm": float(pynvml.nvmlDeviceGetClockInfo(_nvml_handle, pynvml.NVML_CLOCK_SM)),
            "mem": float(pynvml.nvmlDeviceGetClockInfo(_nvml_handle, pynvml.NVML_CLOCK_MEM)),
        }
    except Exception:
        pass
    return out or None

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

GPU_NAME = "cpu"
try:
    import torch as _torch
    import torch.nn.functional as _F
    _torch_available = True
except Exception:
    _torch_available = False

def _init_gpu_or_fail():
    global STT_DEVICE, GPU_NAME
    if STT_DEVICE == "cuda":
        if not _torch_available or not hasattr(_torch, "cuda") or not _torch.cuda.is_available():
            if os.getenv("REQUIRE_GPU", "1").lower() in {"1","true","yes"}:
                sys.exit(1)
            else:
                STT_DEVICE = "cpu"
                return
        try: _torch.cuda.set_device(int(os.getenv("GPU_ID","0")))
        except Exception: pass
        try:
            if os.getenv("ENABLE_TF32","1").lower() in {"1","true","yes"} and hasattr(_torch.backends,"cuda") and hasattr(_torch.backends.cuda,"matmul"):
                _torch.backends.cuda.matmul.allow_tf32 = True
            if hasattr(_torch, "set_float32_matmul_precision"):
                _torch.set_float32_matmul_precision("high")
        except Exception: pass
        try:
            a = _torch.ones((256,256), device="cuda"); b = _torch.ones((256,256), device="cuda")
            _ = a @ b; _torch.cuda.synchronize()
            del a,b,_
        except Exception: pass
        try:
            GPU_NAME = _torch.cuda.get_device_name()
        except Exception:
            GPU_NAME = "cuda"
    else:
        if os.getenv("REQUIRE_GPU","1").lower() in {"1","true","yes"}:
            sys.exit(1)

_init_gpu_or_fail()

_client_lock: Optional[asyncio.Lock] = None
_active_client = None

from RealtimeSTT import AudioToTextRecorder

try:
    import regex as _re_u
    _TK = _re_u.compile(r"([\p{L}\p{M}\p{N}’'_]+|[.,!?…;:]+|[\"“”()–—-])(\s*)", _re_u.UNICODE)
    def _token_units(s: str):
        out = []
        for m in _TK.finditer(s or ""):
            tok, ws = m.group(1), m.group(2)
            out.append((tok+ws, tok))
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

def _overlap_suffix_prefix(a_norms: List[str], b_norms: List[str]) -> int:
    maxl = min(len(a_norms), len(b_norms))
    for l in range(maxl, -1, -1):
        if l == 0: return 0
        if a_norms[-l:] == b_norms[:l]:
            return l
    return 0

async def _ws_send(ws, obj: dict):
    try:
        await ws.send(json.dumps(obj, ensure_ascii=False))
    except websockets.exceptions.ConnectionClosed:
        pass

def _apply_agc_peak_cpu(x: np.ndarray) -> np.ndarray:
    if x.size == 0: return x
    peak = float(np.max(np.abs(x)))
    if peak <= 1e-6 or peak >= AGC_TARGET_PEAK: return x
    gain = min(AGC_MAX_GAIN, AGC_TARGET_PEAK / max(peak, 1e-6))
    return np.clip(x * gain, -1.0, 1.0)

def _resample_cpu_to_16k(f32: np.ndarray, src_sr: int) -> np.ndarray:
    if f32.size == 0: return f32
    if src_sr == TGT_SR: return f32.astype(np.float32, copy=False)
    if _RESAMPLE_USES_SCIPY and src_sr == 48000 and TGT_SR == 16000:
        y = resample_poly(f32, up=1, down=3).astype(np.float32, copy=False)
    elif _RESAMPLE_USES_SCIPY and src_sr % TGT_SR == 0:
        y = resample_poly(f32, up=1, down=src_sr // TGT_SR).astype(np.float32, copy=False)
    else:
        if librosa is None:
            r = TGT_SR / float(src_sr)
            tgt_len = max(1, int(round(len(f32) * r)))
            xp = np.linspace(0, 1, len(f32), endpoint=False)
            xq = np.linspace(0, 1, tgt_len, endpoint=False)
            y = np.interp(xq, xp, f32).astype(np.float32, copy=False)
        else:
            y = librosa.resample(f32, orig_sr=src_sr, target_sr=TGT_SR).astype(np.float32, copy=False)
    return np.nan_to_num(y, nan=0.0, posinf=1.0, neginf=-1.0)

def _resample_agc_gpu(f32: np.ndarray, src_sr: int) -> np.ndarray:
    if not _torch_available or STT_DEVICE != "cuda" or f32.size == 0:
        return f32
    try:
        t = _torch.from_numpy(f32.astype(np.float32, copy=False)).to("cuda", non_blocking=True)
        t = t.unsqueeze(0).unsqueeze(0)  # [1,1,L]
        L_in = t.shape[-1]
        L_out = L_in if src_sr == TGT_SR else max(1, int(round(L_in * (TGT_SR / float(src_sr)))))
        if L_out != L_in:
            t = _F.interpolate(t, size=L_out, mode="linear", align_corners=False)
        t = t.squeeze(0).squeeze(0)
        if ENABLE_AGC:
            peak = _torch.max(_torch.abs(t))
            if float(peak) > 1e-6 and float(peak) < AGC_TARGET_PEAK:
                gain = min(AGC_MAX_GAIN, AGC_TARGET_PEAK / float(peak))
                t = _torch.clamp(t * gain, -1.0, 1.0)
        y = t.detach().to("cpu", non_blocking=True).numpy().astype(np.float32, copy=False)
        return np.nan_to_num(y, nan=0.0, posinf=1.0, neginf=-1.0)
    except Exception:
        if ENABLE_AGC:
            return _apply_agc_peak_cpu(_resample_cpu_to_16k(f32, src_sr))
        return _resample_cpu_to_16k(f32, src_sr)

def _resample_to_16k(f32: np.ndarray, src_sr: int) -> np.ndarray:
    if f32.size == 0: return f32
    if _torch_available and STT_DEVICE == "cuda" and os.getenv("GPU_AUDIO_PIPELINE","1").lower() in {"1","true","yes"}:
        return _resample_agc_gpu(f32, src_sr)
    y = _resample_cpu_to_16k(f32, src_sr)
    if ENABLE_AGC and y.size:
        y = _apply_agc_peak_cpu(y)
    return y

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

def _encode_f32_to_dtype(x: np.ndarray, dtype: Optional[Literal["i16","f32"]]) -> bytes:
    if x.size == 0: return b""
    x = np.nan_to_num(x, nan=0.0, posinf=1.0, neginf=-1.0)
    if dtype == "f32":
        return x.astype(np.float32, copy=False).tobytes()
    return (np.clip(x, -1.0, 1.0) * 32767.0).astype(np.int16, copy=False).tobytes()

def _guess_dtype_from_bytes(b: bytes) -> Literal["i16","f32"]:
    if len(b) % 4 == 0:
        f32 = np.frombuffer(b, dtype=np.float32)
        if f32.size and float(np.mean(np.abs(f32) <= 1.5)) > 0.9:
            return "f32"
    return "i16"

def _edge_trim_low_rms(raw: bytes, sr: int, dtype_hint: Optional[Literal["i16","f32"]], max_trim_ms: int, rms_thresh: float) -> Tuple[bytes, int]:
    if not raw or max_trim_ms <= 0:
        return raw, 0
    dt = dtype_hint or _guess_dtype_from_bytes(raw)
    x = _bytes_to_f32_auto(raw, force_dtype=dt)
    n = x.size
    seg = max(1, int(sr * max_trim_ms / 1000.0))
    if n < seg * 2:
        return raw, 0
    head = x[:seg]; tail = x[-seg:]
    def _rms(a: np.ndarray) -> float:
        if a.size == 0: return 0.0
        r = float(np.sqrt(np.mean(a*a)))
        return 0.0 if (math.isnan(r) or math.isinf(r)) else r
    rms_h = _rms(head); rms_t = _rms(tail)
    if rms_h < rms_t and rms_h <= rms_thresh:
        y = x[seg:]
        trimmed = _encode_f32_to_dtype(y, dt)
        return trimmed, len(raw) - len(trimmed)
    if rms_t <= rms_thresh:
        y = x[:-seg]
        trimmed = _encode_f32_to_dtype(y, dt)
        return trimmed, len(raw) - len(trimmed)
    return raw, 0

def _f32_to_bytes_i16(x: np.ndarray) -> bytes:
    if x.size == 0: return b""
    x = np.nan_to_num(x, nan=0.0, posinf=1.0, neginf=-1.0)
    return (np.clip(x, -1.0, 1.0) * 32767.0).astype(np.int16, copy=False).tobytes()

SENT_RE = re.compile(r'[^.!?…]*[.!?…]+(?:["”’\']+)?(?:\s+|$)')

def split_sentences_and_tail(text: str):
    sents = []
    last_end = 0
    for m in SENT_RE.finditer(text):
        sents.append(m.group(0))
        last_end = m.end()
    tail = text[last_end:]
    return sents, tail

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

    loop = asyncio.get_running_loop()
    conn_t0 = time.monotonic()

    last_emitted: str = ""
    emitted_units: List[tuple] = []
    stable_snapshot = ""        

    ui_e2e_samples: List[float] = []
    ui_e2e_last_ms: float = 0.0
    last_audio_enq_ts: Optional[float] = None
    fed_enq_watermark_ts: Optional[float] = None

    warming_until_ts = time.monotonic() + max(0.0, WARMUP_SILENCE_SEC)

    CHAT_HISTORY_PATH = Path(os.getenv("CHAT_HISTORY_PATH", "conversation_history.txt")).expanduser()
    CHAT_HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    truncate = os.getenv("HISTORY_TRUNCATE_ON_START", "1").lower() in {"1","true","yes"}
    if truncate:
        try:
            CHAT_HISTORY_PATH.write_text("", encoding="utf-8")
        except Exception:
            pass
    else:
        CHAT_HISTORY_PATH.touch(exist_ok=True)

    history_q: asyncio.Queue = asyncio.Queue()
    written_sent_count = 0  

    async def _history_writer():
        nonlocal written_sent_count
        if not truncate:
            try:
                existing = CHAT_HISTORY_PATH.read_text("utf-8")
                if "\n" in existing:
                    written_sent_count = sum(1 for ln in existing.splitlines() if ln.strip())
                else:
                    sents, _ = split_sentences_and_tail(existing)
                    written_sent_count = len(sents)
            except Exception:
                written_sent_count = 0

        try:
            while True:
                full_stable = await history_q.get()
                if full_stable is None:
                    break
                if not isinstance(full_stable, str):
                    continue

                sents, _tail = split_sentences_and_tail(full_stable)
                target = max(0, len(sents) - 1) 

                if target > written_sent_count:
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
                    except Exception:
                        pass
        except Exception:
            pass

    history_task = asyncio.create_task(_history_writer())

    async def _emit_patch_chunked(delete_chars: int, units: List[tuple]):
        nonlocal last_emitted, emitted_units
        if not units:
            if delete_chars:
                await _ws_send(websocket, {"type": "patch", "delete": int(delete_chars), "insert": ""})
                last_emitted = last_emitted[:-delete_chars]
            return

        if not UI_MICRO_DELTA_ENABLE:
            insert_text = "".join(u[0] for u in units)
            await _ws_send(websocket, {"type": "patch", "delete": int(delete_chars), "insert": insert_text})
            if delete_chars:
                last_emitted = last_emitted[:-delete_chars]
            last_emitted += insert_text
            emitted_units.extend(units)
            return

        maxc = max(8, UI_MICRO_DELTA_MAX_CHARS)
        minc = max(1, min(UI_MICRO_DELTA_MIN_SLICE_CHARS, maxc))

        buf: List[tuple] = []
        cur_len = 0
        for u in units:
            l = len(u[0])
            if buf and cur_len + l > maxc and cur_len >= minc:
                insert_text = "".join(x[0] for x in buf)
                await _ws_send(websocket, {"type": "patch", "delete": int(delete_chars), "insert": insert_text})
                if delete_chars:
                    last_emitted = last_emitted[:-delete_chars]
                    delete_chars = 0
                last_emitted += insert_text
                emitted_units.extend(buf)
                buf = [u]; cur_len = l
            else:
                buf.append(u); cur_len += l

        if buf:
            insert_text = "".join(x[0] for x in buf)
            await _ws_send(websocket, {"type": "patch", "delete": int(delete_chars), "insert": insert_text})
            if delete_chars:
                last_emitted = last_emitted[:-delete_chars]
            last_emitted += insert_text
            emitted_units.extend(buf)

    def _patch_from_model_text(t: str, window: int = int(os.getenv("MUTABLE_WINDOW_TOKENS", "7"))):
        nonlocal last_emitted, emitted_units, ui_e2e_last_ms, last_audio_enq_ts, ui_e2e_samples, warming_until_ts, fed_enq_watermark_ts
        SPACE_GUARD = os.getenv("SPACE_GUARD", "1").strip().lower() in {"1","true","yes"}

        if time.monotonic() < warming_until_ts:
            return

        t = (t or "").strip()
        if not t: return
        _ref_ts = fed_enq_watermark_ts if fed_enq_watermark_ts is not None else last_audio_enq_ts
        if _ref_ts is not None:
            ui_e2e_last_ms = (time.monotonic() - _ref_ts) * 1000.0
            if 0.0 < ui_e2e_last_ms < 2000.0:
                ui_e2e_samples.append(ui_e2e_last_ms)

        new_units = _units_with_norms(t)

        if not emitted_units:
            loop.call_soon_threadsafe(asyncio.create_task, _emit_patch_chunked(0, list(new_units)))
            return

        window = max(1, int(window))
        old_tail_units = emitted_units[-min(window, len(emitted_units)):]
        new_tail_units = new_units[-min(window, len(new_units)):]

        old_tail_norms = [u[2] for u in old_tail_units]
        new_tail_norms = [u[2] for u in new_tail_units]
        l = _overlap_suffix_prefix(old_tail_norms, new_tail_norms)

        if l > 0:
            to_delete_units = old_tail_units[l:]
            chars_to_delete = sum(len(u[0]) for u in to_delete_units)
            to_insert_units = new_tail_units[l:]

            if SPACE_GUARD and to_insert_units:
                if last_emitted and last_emitted[-1].isalnum():
                    first_emit = to_insert_units[0][0]
                    if first_emit and first_emit[0].isalnum():
                        fe = to_insert_units[0]
                        to_insert_units[0] = (" " + fe[0], fe[1], fe[2])

            prefix_keep = emitted_units[:len(emitted_units) - len(old_tail_units)]
            keep_suffix = old_tail_units[:l]
            emitted_units[:] = prefix_keep + keep_suffix
            loop.call_soon_threadsafe(asyncio.create_task, _emit_patch_chunked(chars_to_delete, to_insert_units))
        else:
            to_insert_units = list(new_units)
            if SPACE_GUARD and to_insert_units:
                if last_emitted and last_emitted[-1].isalnum():
                    first_emit = to_insert_units[0][0]
                    if first_emit and first_emit[0].isalnum():
                        fe = to_insert_units[0]
                        to_insert_units[0] = (" " + fe[0], fe[1], fe[2])
            loop.call_soon_threadsafe(asyncio.create_task, _emit_patch_chunked(0, to_insert_units))

    def _on_update_cb(text: str):
        _patch_from_model_text(text)

    def _on_stable_cb(text: str):
        nonlocal stable_snapshot, warming_until_ts
        if time.monotonic() < warming_until_ts:
            return
        t = (text or "").strip()
        if not t: return
        if len(t) >= len(stable_snapshot):
            stable_snapshot = t
        loop.call_soon_threadsafe(asyncio.create_task,
            _ws_send(websocket, {"type": "stable", "full": stable_snapshot})
        )
        try:
            history_q.put_nowait(stable_snapshot)
        except Exception:
            pass
        _patch_from_model_text(t)

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
        if WARMUP_SILENCE_SEC > 0:
            silence = np.zeros(int(WARMUP_SILENCE_SEC * TGT_SR), dtype=np.float32)
            t = 0
            while t + FRAME_SAMPLES_BASE <= silence.size:
                frame = silence[t:t+FRAME_SAMPLES_BASE]
                recorder.feed_audio(_f32_to_bytes_i16(frame))
                t += FRAME_SAMPLES_BASE
    except Exception as e:
        await _ws_send(websocket, {"type": "error", "error": f"Init lỗi: {e}"})
        await websocket.close(code=1011, reason="init failed")
        if _client_lock is None:
            pass
        else:
            async with _client_lock:
                if _active_client == client: _active_client = None
        try:
            await history_q.put(None)
            await asyncio.wait_for(history_task, timeout=3.0)
        except Exception:
            pass
        return

    session_src_sr = DEFAULT_SRC_SR
    session_force_dtype: Optional[Literal["i16","f32"]] = None
    session_started = False
    queue: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAX)

    queue_bytes_total = 0
    qbytes_max = 0

    items_processed = 0
    items_enqueued = 0
    frames_fed_total = 0
    pace_toggles = 0
    last_pace_state_change = time.monotonic()
    pace_hold_dashes = 0

    qsize_ema = 0.0
    last_ema_t = time.monotonic()

    stage_ms_ema = 0.0
    last_stage_ema_t = time.monotonic()

    cur_disable_q = PACE_DISABLE_Q
    cur_resume_q  = PACE_RESUME_Q
    cur_dwell_ms  = PACE_MIN_DWELL_MS

    cur_prebuf_lo = PREBUF_LO_MS_BASE
    cur_prebuf_hi = PREBUF_HI_MS_BASE
    _EPS = 1e-6

    feed_stride = 1
    coalesce_easy_ok_windows = 0

    cur_qbytes_cap = QBYTES_HARD_CAP

    near_drop_count_total = 0
    near_drop_count_prev = 0
    near_drop_max_pct_window = 0.0

    net_bytes_enq_total = 0
    near_drop_last_ts = 0.0
    near_drop_last_bytes = 0
    NEAR_DROP_COOLDOWN = 1.0

    dash_id = 0
    dash_start_t = time.monotonic()
    dash_frames0 = 0
    dash_bytes_enq0 = 0
    dash_bytes_deq0 = 0
    bytes_enq_cum = 0
    bytes_deq_cum = 0
    qsize_min = 10**9
    qsize_max = 0
    qsize_sum = 0
    qsize_samples = 0
    e2e_lat_sum = 0.0
    e2e_lat_max = 0.0
    e2e_samples: List[float] = []

    rms_total_frames = 0
    rms_speech_frames = 0

    drops_qguard = 0
    drops_qbytes = 0
    trims_qguard = 0
    drops_qguard_prev = 0
    drops_qbytes_prev = 0
    trims_qguard_prev = 0

    low_latency_mode = False
    low_latency_hold = 0
    overload_hit_windows = 0

    prebuf_up_windows = 0
    prebuf_down_windows = 0

    severe_stride1_hold = 0
    recent_p90_stage_ms = 0.0

    STATUS_INTERVAL_SEC = float(os.getenv("STATUS_INTERVAL_SEC", "0.5"))
    DASH_INTERVAL_SEC = float(os.getenv("DASH_INTERVAL_SEC", "5"))
    LOG_ITEM_EVERY_N = int(os.getenv("LOG_ITEM_EVERY_N", "10")) 

    bufq: deque = deque()
    buf_samples: int = 0

    def _bufq_append(arr: np.ndarray):
        nonlocal buf_samples
        if arr.size == 0: return
        bufq.append(arr)
        buf_samples += int(arr.size)

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

    def _buf_ms_now() -> float:
        return (_bufq_available() / float(TGT_SR)) * 1000.0

    def _buf_clear():
        nonlocal bufq, buf_samples
        bufq.clear()
        buf_samples = 0

    def _percentiles(vals: List[float], ps: List[float]) -> List[float]:
        if not vals: return [0.0 for _ in ps]
        v = np.array(vals, dtype=np.float64)
        return [float(np.percentile(v, p)) for p in ps]

    def _try_set_low_latency(rec, enable: bool):
        nonlocal low_latency_mode
        if enable and not low_latency_mode:
            ok = False
            try:
                if hasattr(rec, "set_realtime_options"):
                    rec.set_realtime_options(beam_size=1); ok = True
                elif hasattr(rec, "set_decode_options"):
                    rec.set_decode_options(beam_size=1); ok = True
                elif hasattr(rec, "beam_size"):
                    setattr(rec, "beam_size", 1); ok = True
            except Exception:
                ok = False
            low_latency_mode = ok or low_latency_mode
        elif (not enable) and low_latency_mode:
            ok = False
            try:
                if hasattr(rec, "set_realtime_options"):
                    rec.set_realtime_options(beam_size=2); ok = True
                elif hasattr(rec, "set_decode_options"):
                    rec.set_decode_options(beam_size=2); ok = True
                elif hasattr(rec, "beam_size"):
                    setattr(rec, "beam_size", 2); ok = True
            except Exception:
                ok = False
            if ok:
                low_latency_mode = False

    async def feed_worker():
        nonlocal queue_bytes_total, qbytes_max, cur_qbytes_cap
        nonlocal items_processed, frames_fed_total, pace_toggles
        nonlocal dash_id, dash_start_t, dash_frames0, dash_bytes_enq0, dash_bytes_deq0
        nonlocal bytes_enq_cum, bytes_deq_cum
        nonlocal qsize_min, qsize_max, qsize_sum, qsize_samples, e2e_lat_sum, e2e_lat_max, e2e_samples
        nonlocal last_pace_state_change, qsize_ema, last_ema_t, pace_hold_dashes
        nonlocal cur_disable_q, cur_resume_q, cur_dwell_ms
        nonlocal cur_prebuf_lo, cur_prebuf_hi, _EPS
        nonlocal feed_stride, coalesce_easy_ok_windows
        nonlocal rms_total_frames, rms_speech_frames
        nonlocal low_latency_mode, low_latency_hold, overload_hit_windows
        nonlocal ui_e2e_last_ms, ui_e2e_samples
        nonlocal drops_qguard_prev, drops_qbytes_prev, trims_qguard_prev
        nonlocal near_drop_count_total, near_drop_count_prev, near_drop_max_pct_window
        nonlocal severe_stride1_hold
        nonlocal fed_enq_watermark_ts
        nonlocal prebuf_up_windows, prebuf_down_windows
        nonlocal recent_p90_stage_ms
        nonlocal stage_ms_ema, last_stage_ema_t

        fed_frames = 0
        pending_segments = deque() 

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

        last_status_t = time.monotonic()
        last_dash_t = last_status_t

        if PACE_MODE == "on":
            pace_realtime = True
        elif PACE_MODE == "off":
            pace_realtime = False
        else:
            pace_realtime = True if not PACE_REALTIME_LEGACY else True

        qsize_ema = float(queue.qsize())
        last_ema_t = time.monotonic()

        try:
            while True:
                now_m = time.monotonic()

                q_inst = queue.qsize()
                dt_ema = max(1e-6, now_m - last_ema_t)
                if EMA_TAU_SEC <= 1e-6:
                    qsize_ema = float(q_inst)
                else:
                    alpha = math.exp(-dt_ema / EMA_TAU_SEC)
                    qsize_ema = alpha * qsize_ema + (1.0 - alpha) * float(q_inst)
                last_ema_t = now_m

                in_grace = (now_m - conn_t0) < GRACE_SEC
                if PACE_MODE == "auto":
                    hold_base = 2 if qsize_ema < 0.5 else 1
                    dwell_ok = (now_m - last_pace_state_change) * 1000.0 >= cur_dwell_ms
                    can_toggle = (pace_hold_dashes == 0)
                    if in_grace:
                        if pace_realtime and can_toggle:
                            pace_realtime = False
                            pace_toggles += 1
                            last_pace_state_change = now_m
                            pace_hold_dashes = hold_base
                    else:
                        if pace_realtime and dwell_ok and can_toggle and qsize_ema >= cur_disable_q:
                            pace_realtime = False
                            pace_toggles += 1
                            last_pace_state_change = now_m
                            pace_hold_dashes = hold_base
                        elif (not pace_realtime) and dwell_ok and can_toggle and qsize_ema <= cur_resume_q:
                            pace_realtime = True
                            pace_toggles += 1
                            last_pace_state_change = now_m
                            pace_hold_dashes = hold_base

                item = await queue.get()
                if item is None:
                    hop = FRAME_SAMPLES_BASE * max(1, feed_stride)
                    while _bufq_available() >= hop:
                        frame = _bufq_consume_samples(hop)
                        recorder.feed_audio(_f32_to_bytes_i16(frame))
                        _consume_segments(hop)
                        step_frames = max(1, hop // FRAME_SAMPLES_BASE)
                        fed_frames += step_frames; frames_fed_total += step_frames
                    _buf_clear()

                    tail = np.zeros(int(TAIL_SILENCE_SEC * TGT_SR), dtype=np.float32)
                    t = 0
                    while t + FRAME_SAMPLES_BASE <= tail.size:
                        frame = tail[t:t+FRAME_SAMPLES_BASE]
                        recorder.feed_audio(_f32_to_bytes_i16(frame))
                        fed_frames += 1; frames_fed_total += 1
                        t += FRAME_SAMPLES_BASE
                    break

                nbytes_item = int(item.get("nbytes", 0))
                enq_ts = float(item.get("enq_ts", time.monotonic()))
                if nbytes_item > 0:
                    queue_bytes_total = max(0, queue_bytes_total - nbytes_item)
                    bytes_deq_cum += nbytes_item
                qbytes_max = max(qbytes_max, queue_bytes_total)

                stage_ms = max(0.0, (time.monotonic() - enq_ts) * 1000.0)
                e2e_lat_sum += stage_ms
                e2e_lat_max = max(e2e_lat_max, stage_ms)
                e2e_samples.append(stage_ms)

                dt_stage = max(1e-6, now_m - last_stage_ema_t)
                if STAGE_EWMA_TAU_SEC <= 1e-6:
                    stage_ms_ema = stage_ms
                else:
                    alpha_s = math.exp(-dt_stage / STAGE_EWMA_TAU_SEC)
                    stage_ms_ema = alpha_s * stage_ms_ema + (1.0 - alpha_s) * stage_ms
                last_stage_ema_t = now_m

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

                if f32_16k.size:
                    rms = float(np.sqrt(np.mean(f32_16k * f32_16k)))
                    rms = 0.0 if (math.isnan(rms) or math.isinf(rms)) else rms
                    rms_total_frames += 1
                    if rms >= RMS_SPEECH_THRESH:
                        rms_speech_frames += 1

                if f32_16k.size:
                    _bufq_append(f32_16k)
                    pending_segments.append([int(f32_16k.size), enq_ts])

                leave_samples = int(max(0.0, cur_prebuf_lo) / 1000.0 * TGT_SR) if ('pace_realtime' in locals() and pace_realtime) else 0
                hop = FRAME_SAMPLES_BASE * max(1, feed_stride)

                while (_bufq_available() - leave_samples) >= hop:
                    frame = _bufq_consume_samples(hop)
                    recorder.feed_audio(_f32_to_bytes_i16(frame))
                    _consume_segments(hop)
                    step_frames = max(1, hop // FRAME_SAMPLES_BASE)
                    fed_frames += step_frames; frames_fed_total += step_frames

                    if PACE_MODE != "off" and ('pace_realtime' in locals() and pace_realtime):
                        remaining = _bufq_available()
                        buf_ms_after = (remaining / float(TGT_SR)) * 1000.0
                        if buf_ms_after <= cur_prebuf_hi:
                            await asyncio.sleep(FRAME_MS * max(1, feed_stride) / 1000.0)
                    elif (fed_frames % 16) == 0:
                        await asyncio.sleep(0)

                items_processed += 1

                if PACE_MODE == "auto" and ('pace_realtime' in locals() and pace_realtime):
                    dynamic_base = max(recent_p90_stage_ms, stage_ms_ema)
                    dynamic_thresh = max(PACE_CRIT_STAGE_MS, dynamic_base + EARLYCUT_P90_MARGIN_MS)
                    if stage_ms >= dynamic_thresh and qsize_ema >= (cur_disable_q - 0.5):
                        if pace_hold_dashes > 0:
                            pace_hold_dashes = 0
                        pace_realtime = False
                        pace_toggles += 1
                        last_pace_state_change = now_m
                        hold_base = 2 if qsize_ema < 0.5 else 1
                        pace_hold_dashes = hold_base

                qsize_now = queue.qsize()
                qsize_min = min(qsize_min, qsize_now)
                qsize_max = max(qsize_max, qsize_now)
                qsize_sum += qsize_now; qsize_samples += 1

                buf_ms_now = _buf_ms_now()
                rss_mb = (_PROC.memory_info().rss / (1024.0*1024.0)) if _PROC else None

                if now_m - last_status_t >= STATUS_INTERVAL_SEC:
                    gpu_alloc = gpu_resv = None
                    try:
                        if STT_DEVICE == "cuda" and _torch_available and _torch.cuda.is_available():
                            gpu_alloc = float(_torch.cuda.memory_allocated() / (1024.0*1024.0))
                            gpu_resv  = float(_torch.cuda.memory_reserved() / (1024.0*1024.0))
                    except Exception:
                        pass

                    nvml_pair = _nvml_mem_mb()
                    nvml_extra = _nvml_stats_all()

                    detail = {
                        "device": STT_DEVICE,
                        "gpu_name": GPU_NAME,
                        "frames_total": int(frames_fed_total),
                        "queue": qsize_now,
                        "queue_ema": float(qsize_ema),
                        "bytes_in_queue": int(queue_bytes_total),
                        "qbytes_cap": int(cur_qbytes_cap),
                        "qbytes_max": int(qbytes_max),
                        "buf_ms": float(buf_ms_now),
                        "pace": "on" if ('pace_realtime' in locals() and pace_realtime) else "off",
                        "toggles": int(pace_toggles),
                        "pace_hold": int(pace_hold_dashes),
                        "toggled_ago_ms": int((now_m - last_pace_state_change) * 1000.0),
                        "stage_ms_last": float(round(stage_ms, 3)),
                        "stage_ms_ema": float(round(stage_ms_ema, 3)),
                        "ui_e2e_ms_last": float(round(ui_e2e_last_ms, 3)),
                        "in_grace": bool((time.monotonic() - conn_t0) < GRACE_SEC),
                        "prebuf_ms": [float(cur_prebuf_lo), float(cur_prebuf_hi)],
                        "stride": int(feed_stride),
                        "drops": {"qguard": int(drops_qguard), "qbytes": int(drops_qbytes),
                                  "trims_qguard": int(trims_qguard),
                                  "total": int(drops_qguard + drops_qbytes)},
                    }
                    if rss_mb is not None: detail["rss_mb"] = float(rss_mb)
                    if gpu_alloc is not None: detail["gpu_mb"] = {"alloc": gpu_alloc, "reserv": gpu_resv}
                    if nvml_pair is not None: detail["gpu_nvml_mb"] = {"used": nvml_pair[0], "total": nvml_pair[1]}
                    if nvml_extra is not None: detail["gpu_nvml_extra"] = nvml_extra
                    await _ws_send(websocket, {"type": "status", "stage": "FEED", "detail": detail})
                    last_status_t = now_m

                if now_m - last_dash_t >= DASH_INTERVAL_SEC:
                    dash_id += 1
                    dt = now_m - dash_start_t
                    frames_in = frames_fed_total - dash_frames0
                    bytes_in = bytes_enq_cum - dash_bytes_enq0
                    bytes_out = bytes_deq_cum - dash_bytes_deq0
                    avg_q = (qsize_sum / max(1, qsize_samples))
                    e2e_avg = (e2e_lat_sum / max(1, qsize_samples))
                    p50, p90, p99 = _percentiles(e2e_samples, [50, 90, 99])
                    recent_p90_stage_ms = p90

                    ui_e2e_dash_samples = ui_e2e_samples[:]
                    ui_p50, ui_p90, ui_p99 = _percentiles(ui_e2e_dash_samples, [50,90,99])

                    speak_ratio = (rms_speech_frames / max(1, rms_total_frames)) if rms_total_frames else 0.0

                    drops_window_q = max(0, drops_qguard - drops_qguard_prev)
                    drops_window_qb = max(0, drops_qbytes - drops_qbytes_prev)
                    trims_window_q = max(0, trims_qguard - trims_qguard_prev)
                    drops_qguard_prev = drops_qguard
                    drops_qbytes_prev = drops_qbytes
                    trims_qguard_prev = trims_qguard

                    if ADAPT_PACE:
                        if pace_toggles >= TOGGLE_HIGH:
                            cur_dwell_ms = min(cur_dwell_ms + DWELL_BUMP_MS, 2500)
                            cur_disable_q = min(cur_disable_q + 1, max(2, QUEUE_MAX - 1))
                            cur_resume_q  = max(1, cur_resume_q - 1)
                        else:
                            if avg_q < 0.5 and cur_dwell_ms < 1200:
                                cur_dwell_ms = 1200
                            elif cur_dwell_ms > PACE_MIN_DWELL_MS:
                                cur_dwell_ms = max(PACE_MIN_HOLD_DASHES * 200, PACE_MIN_DWELL_MS)
                            if cur_disable_q > PACE_DISABLE_Q:
                                cur_disable_q -= 1
                            if cur_resume_q < PACE_RESUME_Q:
                                cur_resume_q += 1
                    if avg_q < 0.5:
                        pace_hold_dashes = max(pace_hold_dashes, 2)
                    elif pace_hold_dashes > 0:
                        pace_hold_dashes -= 1

                    if ADAPT_PREBUF:
                        compute_warn = (avg_q >= PREBUF_COMPUTE_WARN_Q) or (p90 >= PREBUF_COMPUTE_WARN_P90_MS)
                        if (ui_p90 >= PREBUF_UP_UI_P90_MS and avg_q >= PREBUF_UP_AVG_Q and not compute_warn):
                            prebuf_up_windows += 1
                        else:
                            prebuf_up_windows = 0
                        if (ui_p90 <= PREBUF_DOWN_UI_P90_MS and avg_q <= PREBUF_DOWN_AVG_Q):
                            prebuf_down_windows += 1
                        else:
                            prebuf_down_windows = 0
                        if prebuf_up_windows >= PREBUF_UP_CONSEC_WINDOWS:
                            new_lo = min(PREBUF_LO_MS_BASE + PREBUF_BUMP_MAX, cur_prebuf_lo + 2.0)
                            gap = max(5.0, PREBUF_HI_MS_BASE - PREBUF_LO_MS_BASE)
                            new_hi = min(PREBUF_HI_MS_BASE + PREBUF_BUMP_MAX, max(cur_prebuf_hi, new_lo + gap))
                            cur_prebuf_lo, cur_prebuf_hi = new_lo, new_hi
                            prebuf_up_windows = 0
                        if prebuf_down_windows >= PREBUF_DOWN_CONSEC_WINDOWS:
                            deramp_step = 3.0 if (avg_q < 0.5 and ui_p90 < 40.0) else 1.0
                            if cur_prebuf_lo > PREBUF_LO_MS_BASE: cur_prebuf_lo = max(PREBUF_LO_MS_BASE, cur_prebuf_lo - deramp_step)
                            if cur_prebuf_hi > PREBUF_HI_MS_BASE: cur_prebuf_hi = max(PREBUF_HI_MS_BASE, cur_prebuf_hi - deramp_step)
                            prebuf_down_windows = 0
                        if (rms_total_frames > 0) and (rms_speech_frames / max(1, rms_total_frames)) >= SPEECH_RATIO_UP:
                            if cur_prebuf_hi > PREBUF_HI_MS_BASE:
                                cur_prebuf_hi = max(PREBUF_HI_MS_BASE, cur_prebuf_hi - SPEAKING_PREBUF_HI_DELTA_MS)

                    speak_ratio_now = (rms_speech_frames / max(1, rms_total_frames)) if rms_total_frames else 0.0
                    if COALESCE_ENABLE:
                        if (avg_q >= SEVERE_OVERLOAD_Q and p90 >= SEVERE_OVERLOAD_P90_MS):
                            feed_stride = 1
                            severe_stride1_hold = max(severe_stride1_hold, SEVERE_OVERLOAD_STRIDE1_HOLD_DASHES)
                        elif severe_stride1_hold > 0:
                            feed_stride = 1
                            severe_stride1_hold -= 1
                        else:
                            compute_warn = (avg_q >= PREBUF_COMPUTE_WARN_Q) or (p90 >= PREBUF_COMPUTE_WARN_P90_MS)
                            inc_gate_ok = (p90 < 60.0) and (avg_q < 1.5) and (speak_ratio_now < 0.35) and (not compute_warn)
                            inc_trigger_raw = (e2e_avg > E2E_COALESCE_TRIG_MS and avg_q >= Q_COALESCE_TRIG) or \
                                              (p90 > E2E_COALESCE_TRIG_MS) or \
                                              (rms_total_frames and speak_ratio_now < SPEECH_RATIO_DOWN and avg_q >= 1.0)
                            inc_trigger = inc_trigger_raw and inc_gate_ok
                            if inc_trigger:
                                target = min(feed_stride + 1, COALESCE_MAX)
                                if SPEECH_STRIDE_CAP > 0 and speak_ratio_now >= SPEECH_RATIO_UP:
                                    target = min(target, SPEECH_STRIDE_CAP)
                                if target > feed_stride:
                                    feed_stride = target
                                    coalesce_easy_ok_windows = 0
                            else:
                                cond_easy = (e2e_avg < E2E_COALESCE_TRIG_MS * 0.9 and avg_q < Q_COALESCE_TRIG * 0.9)
                                cond_speech = (speak_ratio_now >= SPEECH_RATIO_UP and p90 < (E2E_COALESCE_TRIG_MS*1.2))
                                if feed_stride > 1 and (cond_easy or cond_speech):
                                    if cond_easy:
                                        coalesce_easy_ok_windows += 1
                                    else:
                                        coalesce_easy_ok_windows = COALESCE_HYST_DOWN_WINDOWS
                                    if coalesce_easy_ok_windows >= COALESCE_HYST_DOWN_WINDOWS:
                                        feed_stride = max(1, feed_stride - 1)
                                        coalesce_easy_ok_windows = 0
                                else:
                                    coalesce_easy_ok_windows = 0
                                if speak_ratio_now >= SPEECH_RATIO_UP and p90 >= FAST_STRIDE_DROP_P90_MS and feed_stride > 1:
                                    new_stride = max(1, feed_stride - 1)
                                    if SPEECH_STRIDE_CAP > 0:
                                        new_stride = min(new_stride, SPEECH_STRIDE_CAP)
                                    if new_stride < feed_stride:
                                        feed_stride = new_stride
                                        coalesce_easy_ok_windows = 0
                                if speak_ratio_now >= SPEECH_RATIO_UP and p90 >= 220.0 and feed_stride > 1:
                                    feed_stride = 1
                                    coalesce_easy_ok_windows = 0
                                if SPEECH_STRIDE_CAP > 0 and speak_ratio_now >= SPEECH_RATIO_UP and feed_stride > SPEECH_STRIDE_CAP:
                                    feed_stride = SPEECH_STRIDE_CAP
                            compute_bound_q = (avg_q >= COALESCE_OVERLOAD_Q_CAP) or (p90 >= COALESCE_OVERLOAD_P90_CAP_MS)
                            if compute_bound_q and feed_stride > 2:
                                feed_stride = 2
                                coalesce_easy_ok_windows = 0

                    if (avg_q >= OVERLOAD_Q and p90 >= OVERLOAD_P90_MS):
                        overload_hit_windows += 1
                    else:
                        overload_hit_windows = 0
                    if overload_hit_windows >= OVERLOAD_CONSEC_WINDOWS:
                        _try_set_low_latency(recorder, True)
                        low_latency_hold = max(low_latency_hold, DOWNSHIFT_MIN_HOLD_DASHES)
                    else:
                        if low_latency_hold > 0:
                            low_latency_hold -= 1
                        elif low_latency_mode:
                            _try_set_low_latency(recorder, False)

                    if QBYTES_HARD_CAP > 0:
                        if ((rms_speech_frames / max(1, rms_total_frames)) if rms_total_frames else 0.0) >= TALK_SPEAK_RATIO_THRESH:
                            cur_qbytes_cap = int(QBYTES_HARD_CAP * QBYTES_TALKING_MULT)
                        else:
                            cur_qbytes_cap = QBYTES_HARD_CAP

                    if trims_window_q > TRIMS_WINDOW_HIGH and ADAPT_PREBUF:
                        cur_prebuf_lo = min(PREBUF_LO_MS_BASE + PREBUF_BUMP_MAX, cur_prebuf_lo + 2.0)

                    near_drop_count_prev = near_drop_count_total
                    near_drop_max_pct_window = 0.0
                    dash_start_t = now_m
                    dash_frames0 = frames_fed_total
                    dash_bytes_enq0 = bytes_enq_cum
                    dash_bytes_deq0 = bytes_deq_cum
                    qsize_min = 10**9; qsize_max = 0; qsize_sum = 0; qsize_samples = 0
                    e2e_lat_sum = 0.0; e2e_lat_max = 0.0; e2e_samples = []
                    ui_e2e_samples = []
                    rms_total_frames = 0; rms_speech_frames = 0
                    pace_toggles = 0
                    last_dash_t = now_m

        except Exception:
            pass

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
            "mutable_window_tokens": int(os.getenv("MUTABLE_WINDOW_TOKENS", "7")),
            "device": STT_DEVICE,
            "gpu_name": GPU_NAME,
            "compute_type": STT_COMPUTE_TYPE,
            "qbytes_cap": int(QBYTES_HARD_CAP),
            "hint_client_frame_48k": 960
        }
    })

    def _drop_oldest_until_under(cap: int):
        nonlocal queue_bytes_total, drops_qbytes
        if cap <= 0: return
        try:
            while queue_bytes_total >= cap and not queue.empty():
                old = queue.get_nowait()
                if isinstance(old, dict):
                    queue_bytes_total = max(0, queue_bytes_total - int(old.get("nbytes", 0)))
                    drops_qbytes += 1
        except Exception:
            pass

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

                raw = bytes(msg)
                if DROP_OLDEST_ON_FULL and queue.qsize() >= DROP_GUARD_Q:
                    if not QGUARD_HARD_DROP:
                        trimmed, cut = _edge_trim_low_rms(raw, session_src_sr, session_force_dtype, QGUARD_SOFT_TRIM_MS, QGUARD_SOFT_TRIM_RMS)
                        if cut > 0:
                            raw = trimmed
                            trims_qguard += 1
                    else:
                        try:
                            old = queue.get_nowait()
                            if isinstance(old, dict):
                                queue_bytes_total = max(0, queue_bytes_total - int(old.get("nbytes", 0)))
                                drops_qguard += 1
                        except Exception:
                            pass

                nbytes = len(raw)
                await queue.put({
                    "kind":"audio","buf":raw,"sr":session_src_sr,"dtype":session_force_dtype,
                    "nbytes": nbytes, "enq_ts": time.monotonic()
                })
                last_audio_enq_ts = time.monotonic()
                queue_bytes_total += nbytes
                bytes_enq_cum += nbytes
                net_bytes_enq_total += nbytes

                cap_use = cur_qbytes_cap if QBYTES_HARD_CAP > 0 else 0
                if cap_use > 0:
                    now = time.monotonic()
                    if queue_bytes_total >= cap_use * NEAR_DROP_RATIO and (now - near_drop_last_ts) >= NEAR_DROP_COOLDOWN:
                        dt = now - near_drop_last_ts if near_drop_last_ts > 0 else NEAR_DROP_COOLDOWN
                        dbytes = net_bytes_enq_total - near_drop_last_bytes
                        rate_kbps = (dbytes / max(dt, 1e-6)) / 1024.0
                        pct = (100.0 * queue_bytes_total / float(cap_use))
                        await _ws_send(websocket, {
                            "type":"near_drop",
                            "cap":int(cap_use),
                            "bytes":int(queue_bytes_total),
                            "pct":round(pct,2),
                            "enq_rate_kbps":round(rate_kbps,2),
                            "cap_source":"speaking" if cap_use != QBYTES_HARD_CAP else "base"
                        })
                        near_drop_last_ts = now
                        near_drop_last_bytes = net_bytes_enq_total
                        near_drop_count_total += 1
                        near_drop_max_pct_window = max(near_drop_max_pct_window, float(round(pct,2)))
                    if queue_bytes_total >= cap_use:
                        _drop_oldest_until_under(cap_use)

                qbytes_max = max(qbytes_max, queue_bytes_total)
                items_enqueued += 1
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

                if event == "ui_resume_hint":
                    pace_hold_dashes = 0
                    cur_resume_q = max(1, cur_resume_q - 1)
                    await _ws_send(websocket, {"type":"ack","detail":{"ui_resume_hint":"ok"}})
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

                        if DROP_OLDEST_ON_FULL and queue.qsize() >= DROP_GUARD_Q:
                            if not QGUARD_HARD_DROP:
                                trimmed, cut = _edge_trim_low_rms(raw, sr, dt, QGUARD_SOFT_TRIM_MS, QGUARD_SOFT_TRIM_RMS)
                                if cut > 0:
                                    raw = trimmed
                                    trims_qguard += 1
                            else:
                                try:
                                    old = queue.get_nowait()
                                    if isinstance(old, dict):
                                        queue_bytes_total = max(0, queue_bytes_total - int(old.get("nbytes", 0)))
                                        drops_qguard += 1
                                except Exception:
                                    pass

                        nbytes = len(raw)
                        await queue.put({
                            "kind":"audio","buf":raw,"sr":sr,"dtype": (dt if dt in {"i16","f32"} else None),
                            "nbytes": nbytes, "enq_ts": time.monotonic()
                        })
                        last_audio_enq_ts = time.monotonic()
                        queue_bytes_total += nbytes
                        bytes_enq_cum += nbytes
                        net_bytes_enq_total += nbytes

                        cap_use = cur_qbytes_cap if QBYTES_HARD_CAP > 0 else 0
                        if cap_use > 0:
                            now = time.monotonic()
                            if queue_bytes_total >= cap_use * NEAR_DROP_RATIO and (now - near_drop_last_ts) >= NEAR_DROP_COOLDOWN:
                                dtc = now - near_drop_last_ts if near_drop_last_ts > 0 else NEAR_DROP_COOLDOWN
                                dbytes = net_bytes_enq_total - near_drop_last_bytes
                                rate_kbps = (dbytes / max(dtc, 1e-6)) / 1024.0
                                pct = (100.0 * queue_bytes_total / float(cap_use))
                                await _ws_send(websocket, {
                                    "type":"near_drop",
                                    "cap":int(cap_use),
                                    "bytes":int(queue_bytes_total),
                                    "pct":round(pct,2),
                                    "enq_rate_kbps":round(rate_kbps,2),
                                    "cap_source":"speaking" if cap_use != QBYTES_HARD_CAP else "base"
                                })
                                near_drop_last_ts = now
                                near_drop_last_bytes = net_bytes_enq_total
                                near_drop_count_total += 1
                                near_drop_max_pct_window = max(near_drop_max_pct_window, float(round(pct,2)))
                            if queue_bytes_total >= cap_use:
                                _drop_oldest_until_under(cap_use)

                        qbytes_max = max(qbytes_max, queue_bytes_total)
                        items_enqueued += 1
                    except Exception:
                        pass
                    continue
    finally:
        try: await queue.put(None)
        except Exception: pass
        try: await asyncio.wait_for(worker_task, timeout=12.0)
        except asyncio.TimeoutError: pass
        try:
            if 'recorder' in locals() and hasattr(recorder, "stop"): recorder.stop()
            if 'recorder' in locals() and hasattr(recorder, "shutdown"): recorder.shutdown()
        except Exception: pass

        try:
            await history_q.put(None)
            await asyncio.wait_for(history_task, timeout=3.0)
        except Exception:
            pass

        if _client_lock is None: _client_lock = asyncio.Lock()
        async with _client_lock:
            if _active_client == client: _active_client = None

async def main():
    host = WS_HOST
    port = WS_PORT
    async with websockets.serve(
        handler, host, port,
        max_size=None, ping_interval=20, ping_timeout=20,
        compression="deflate"
    ):
        await asyncio.Future()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
