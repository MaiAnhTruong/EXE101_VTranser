import os
import logging
from datetime import datetime
from pathlib import Path
import asyncio
import json
import numpy as np
import websockets

_RESAMPLE_USES_SCIPY = True
try:
    from scipy.signal import resample_poly
except Exception:
    _RESAMPLE_USES_SCIPY = False
    import librosa 

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("CT2_VERBOSE", "1") 

WS_HOST = os.getenv("WS_HOST", "0.0.0.0")
WS_PORT = int(os.getenv("WS_PORT", "8765"))

SRC_SR = int(os.getenv("SRC_SAMPLE_RATE", "48000")) 
TGT_SR = int(os.getenv("TARGET_SAMPLE_RATE", "16000"))

STT_MODEL = os.getenv("STT_MODEL", "/home/truong/models/fw-small") 
STT_DEVICE = os.getenv("STT_DEVICE", "cpu").strip().lower()        
STT_COMPUTE_TYPE = os.getenv("STT_COMPUTE_TYPE", "int8")
STT_COMPUTE_FALLBACK = os.getenv("STT_COMPUTE_FALLBACK", "float32")

STT_LANGUAGE = os.getenv("STT_LANGUAGE", "vi").strip()

LOG_PATH = Path(os.getenv("STT_LOG_PATH", "stt_transcript.log")).expanduser()
LOG_PATH.parent.mkdir(parents=True, exist_ok=True)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("stt-server")
logger.info("[Config] LOG_PATH=%s", LOG_PATH)

if STT_DEVICE == "cpu" and STT_COMPUTE_TYPE.lower() in {"float16", "int8_float16"}:
    STT_COMPUTE_TYPE = "int8"

_client_lock: asyncio.Lock | None = None
_active_client = None

from RealtimeSTT import AudioToTextRecorder  

def _write_transcript(text: str, kind: str) -> None:
    text = (text or "").strip()
    if not text:
        return
    try:
        with LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(f"[{datetime.now().isoformat()}] [{kind.upper()}] {text}\n")
    except Exception as ex:
        logger.error("[Log] lỗi: %s", ex)


async def _ws_send(ws, obj: dict) -> None:
    try:
        await ws.send(json.dumps(obj, ensure_ascii=False))
    except websockets.exceptions.ConnectionClosed:
        pass  


def _resample_48k_to_16k(f32: np.ndarray) -> np.ndarray:
    if f32.size == 0:
        return f32
    if _RESAMPLE_USES_SCIPY and SRC_SR == 48000 and TGT_SR == 16000:
        return resample_poly(f32, up=1, down=3).astype(np.float32, copy=False)
    else:
        return librosa.resample(f32, orig_sr=SRC_SR, target_sr=TGT_SR).astype(np.float32, copy=False)


async def handler(websocket):
    global _active_client, _client_lock

    client = websocket.remote_address
    if _client_lock is None:
        _client_lock = asyncio.Lock()

    async with _client_lock:
        if _active_client is not None:
            logger.warning("[Conn] reject %s, busy with %s", client, _active_client)
            await _ws_send(websocket, {"type": "error", "error": "Server bận"})
            await websocket.close(code=1013, reason="busy")
            return
        _active_client = client

    logger.info("[Conn] open: %s", client)
    logger.info("[STT] init: model=%s device=%s type=%s", STT_MODEL, STT_DEVICE, STT_COMPUTE_TYPE)

    async def _on_update(text: str):
        await _ws_send(websocket, {"type": "update", "text": text})
        _write_transcript(text, "update")

    async def _on_stable(text: str):
        await _ws_send(websocket, {"type": "stable", "text": text})
        _write_transcript(text, "final")

    def _make_recorder(ct: str) -> AudioToTextRecorder:
        logger.info("[STT] creating recorder compute_type=%s", ct)
        return AudioToTextRecorder(
            use_microphone=False,
            device=STT_DEVICE,       
            model=STT_MODEL,          
            compute_type=ct,     
            enable_realtime_transcription=True,
            language=(STT_LANGUAGE or None),
            normalize_audio=True,
            webrtc_sensitivity=3,    
            silero_sensitivity=0.5,       
            silero_deactivity_detection=True,
            post_speech_silence_duration=0.25,
            on_realtime_transcription_update=lambda t: asyncio.create_task(_on_update(t)),
            on_realtime_transcription_stabilized=lambda t: asyncio.create_task(_on_stable(t)),
        )

    try:
        try:
            recorder = _make_recorder(STT_COMPUTE_TYPE)
        except ValueError as ve:
            logger.warning("[STT] compute_type=%s không hỗ trợ → fallback %s (%s)",
                           STT_COMPUTE_TYPE, STT_COMPUTE_FALLBACK, ve)
            recorder = _make_recorder(STT_COMPUTE_FALLBACK)
    except Exception as e:
        logger.error("[STT] init error: %s", e, exc_info=True)
        await _ws_send(websocket, {"type": "error", "error": f"Init lỗi: {e}"})
        await websocket.close(code=1011, reason="init failed")
        async with _client_lock:
            if _active_client == client:
                _active_client = None
        return

    try:
        while True:
            try:
                msg = await websocket.recv()
            except websockets.exceptions.ConnectionClosedOK:
                logger.info("[Conn] closed by client %s", client)
                break
            except websockets.exceptions.ConnectionClosedError:
                logger.info("[Conn] error close by client %s", client)
                break

            if not isinstance(msg, (bytes, bytearray)):
                continue

            arr_i16 = np.frombuffer(msg, dtype=np.int16)
            if arr_i16.size == 0:
                continue

            f32 = arr_i16.astype(np.float32) / 32768.0

            rs = _resample_48k_to_16k(f32)

            rs = np.clip(rs, -1.0, 1.0)
            chunk_bytes = (rs * 32767.0).astype(np.int16).tobytes()

            try:
                rms = float(np.sqrt(np.mean(rs * rs))) if rs.size else 0.0
                await _ws_send(websocket, {
                    "type": "status",
                    "stage": "FEED",
                    "detail": {"samples": int(rs.size), "rms": rms}
                })
            except Exception:
                pass

            try:
                recorder.feed_audio(chunk_bytes)
            except Exception as e:
                logger.error("[Feed] feed_audio error: %s", e, exc_info=True)

    finally:
        try:
            recorder.shutdown()
        except Exception:
            pass
        if _client_lock is None:
            _client_lock = asyncio.Lock()
        async with _client_lock:
            if _active_client == client:
                _active_client = None
        logger.info("[Shutdown] client released: %s", client)


async def main():
    logger.info("[Startup] WS server at ws://%s:%d (device=%s, model=%s, type=%s)",
                WS_HOST, WS_PORT, STT_DEVICE, STT_MODEL, STT_COMPUTE_TYPE)
    async with websockets.serve(handler, WS_HOST, WS_PORT, max_size=None, ping_interval=20, ping_timeout=20):
        await asyncio.Future()


if __name__ == "__main__":
    print("Loaded")
    asyncio.run(main())
