# stt_offline_mp3_realtimestt.py
# Decode MP3 -> 16kHz mono -> INT16 frames 20ms -> RealtimeSTT.AudioToTextRecorder
# In transcript ra stdout và lưu toàn bộ log vào stt_offline_mp3_run.txt
# CHỈ dùng RealtimeSTT (không faster_whisper)

import os
import sys
import time
import math
import logging
import inspect
from typing import List, Dict, Any

import numpy as np

# ====== CẤU HÌNH ======
PATH_MP3 = r"/home/truong/EXE/my-tab-audio-ext/Introductions  Beginner English  How to Introduce yourself in English - Learn English by Pocket Passport.mp3"
LOG_PATH = "stt_offline_mp3_run.txt"

SRC_SR = 48000
TGT_SR = 16000
FRAME_MS = 20             # 20ms @16kHz => 320 mẫu/khung
TAIL_SILENCE_SEC = 1.2    # đuôi im lặng để chốt VAD

FORCE_LANG = os.getenv("STT_LANGUAGE", "en")
STT_MODEL = os.getenv("STT_MODEL", "/home/truong/models/fw-small")
STT_DEVICE = os.getenv("STT_DEVICE", "cpu").strip().lower()
STT_COMPUTE_TYPE = os.getenv("STT_COMPUTE_TYPE", "int8")

# ====== LOGGING ======
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_PATH, mode="w", encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger("stt-offline")

# ====== IO & RESAMPLE ======
try:
    from pydub import AudioSegment
except Exception as e:
    raise RuntimeError("Cần pydub + ffmpeg (pip install pydub, cài ffmpeg).") from e

_USE_SCIPY = True
try:
    from scipy.signal import resample_poly
except Exception:
    _USE_SCIPY = False
    try:
        import librosa
    except Exception as e:
        raise RuntimeError("Thiếu scipy & librosa cho resample (cần một trong hai).") from e

def decode_mp3_to_mono_48k(path: str) -> np.ndarray:
    seg = AudioSegment.from_file(path)
    seg = seg.set_channels(1).set_frame_rate(SRC_SR).set_sample_width(2)  # int16 @48k mono
    pcm16 = np.array(seg.get_array_of_samples(), dtype=np.int16)
    f32 = (pcm16.astype(np.float32) / 32768.0)
    log.info("[DECODE] %s -> %d samples @ %d Hz (mono float32)", path, f32.size, SRC_SR)
    return f32

def resample_48k_to_16k(f32_48k: np.ndarray) -> np.ndarray:
    if f32_48k.size == 0:
        return f32_48k.astype(np.float32)
    if _USE_SCIPY and SRC_SR == 48000 and TGT_SR == 16000:
        f32_16k = resample_poly(f32_48k, up=1, down=3).astype(np.float32, copy=False)
    else:
        import librosa
        f32_16k = librosa.resample(f32_48k, orig_sr=SRC_SR, target_sr=TGT_SR).astype(np.float32, copy=False)
    f32_16k = np.nan_to_num(np.clip(f32_16k, -1.0, 1.0)).astype(np.float32, copy=False)
    log.info("[RESAMPLE] -> %d samples @ %d Hz", f32_16k.size, TGT_SR)
    return f32_16k

def apply_agc(f32: np.ndarray, target_peak=0.95, max_gain=8.0) -> np.ndarray:
    if f32.size == 0:
        return f32
    peak = float(np.max(np.abs(f32)))
    if peak < 1e-6:
        return f32
    gain = min(max_gain, target_peak / peak)
    if gain > 1.2:
        log.info("[AGC] peak=%.4f → gain=%.2fx", peak, gain)
    return np.clip(f32 * gain, -1.0, 1.0).astype(np.float32, copy=False)

def float_to_int16(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, -1.0, 1.0)
    return (x * 32767.0).astype(np.int16)

# ====== RealtimeSTT ======
from RealtimeSTT import AudioToTextRecorder

class TranscriptCatcher:
    def __init__(self):
        self.latest_stable: str = ""
        self.last_update: str = ""

    def on_update(self, text: str):
        t = (text or "").strip()
        if t:
            self.last_update = t
            log.info("[UPDATE] %s", t)

    def on_stable(self, text: str):
        t = (text or "").strip()
        if t:
            self.latest_stable = t  # STABLE của lib thường là bản lũy kế
            log.info("[STABLE] %s", t)

def safe_recorder_kwargs(**kwargs) -> Dict[str, Any]:
    sig = inspect.signature(AudioToTextRecorder.__init__)
    valid = {}
    for k, v in kwargs.items():
        if k in sig.parameters:
            valid[k] = v
    return valid

def make_recorder(catcher: TranscriptCatcher) -> AudioToTextRecorder:
    compute_type = STT_COMPUTE_TYPE
    if STT_DEVICE == "cpu" and compute_type.lower() in {"float16", "int8_float16"}:
        compute_type = "int8"

    base = dict(
        use_microphone=False,
        device=STT_DEVICE,
        model=STT_MODEL,
        compute_type=compute_type,
        enable_realtime_transcription=True,
        language=FORCE_LANG,
        normalize_audio=True,                # QUAN TRỌNG: để lib scale đúng trước VAD
        post_speech_silence_duration=0.35,  # chốt câu nhanh
        sample_rate=TGT_SR,
        on_realtime_transcription_update=catcher.on_update,
        on_realtime_transcription_stabilized=catcher.on_stable,
    )
    # nếu phiên bản hỗ trợ VAD knobs, các khoá này sẽ có hiệu lực
    maybe = dict(
        webrtc_sensitivity=1,               # 0/1 ít khắt khe hơn 2/3
        silero_sensitivity=0.5,
        silero_deactivity_detection=False,
    )
    merged = {**base, **maybe}
    kwargs = safe_recorder_kwargs(**merged)
    log.info("[STT] init model=%s device=%s compute_type=%s lang=%s kwargs=%s",
             STT_MODEL, STT_DEVICE, compute_type, FORCE_LANG, sorted(kwargs.keys()))
    rec = AudioToTextRecorder(**kwargs)
    if hasattr(rec, "start") and callable(rec.start):
        try:
            rec.start()
            log.info("[STT] recorder.start() called")
        except Exception as e:
            log.warning("[STT] start() error: %s", e)
    return rec

def feed_stream(recorder: AudioToTextRecorder, audio_f32_16k: np.ndarray):
    # Chuyển sang INT16 từ đầu và feed bằng **bytes little-endian**
    audio_i16 = float_to_int16(audio_f32_16k)
    step = int(TGT_SR * FRAME_MS / 1000)  # 320 mẫu/khung
    cut = (audio_i16.size // step) * step
    frames = 0
    rms_acc = []

    log.info("[FEED-i16-bytes] frame=%d samples (%d ms), total_frames=%d", step, FRAME_MS, cut // step)

    for i in range(0, cut, step):
        frame_i16 = audio_i16[i:i+step]
        frame_f32 = audio_f32_16k[i:i+step]  # chỉ để log RMS nếu cần

        pushed = False
        # ƯU TIÊN: bytes int16
        try:
            recorder.feed_audio(frame_i16.tobytes())
            pushed = True
        except Exception:
            pushed = False
        # Fallback: mảng int16
        if not pushed:
            try:
                recorder.feed_audio(frame_i16)
                pushed = True
            except Exception:
                pushed = False
        # Fallback cuối: float32 (ít khi cần)
        if not pushed:
            recorder.feed_audio(frame_f32.astype(np.float32, copy=False))

        frames += 1
        if frames % 50 == 0:
            rms = math.sqrt(float(np.mean(frame_f32*frame_f32))) if frame_f32.size else 0.0
            log.info("[FEED] frames=%d avgRMS=%.4f", frames, rms)

        # Nhường CPU cho thread xử lý bên trong
        if frames % 10 == 0:
            time.sleep(0.004)

    # Đuôi im lặng để VAD chốt nốt câu cuối cùng
    tail_i16 = np.zeros(step, dtype=np.int16)
    tail_frames = max(1, int((TAIL_SILENCE_SEC * TGT_SR) // step))
    for _ in range(tail_frames):
        try:
            recorder.feed_audio(tail_i16.tobytes())
        except Exception:
            try:
                recorder.feed_audio(tail_i16)
            except Exception:
                recorder.feed_audio(np.zeros(step, dtype=np.float32).tobytes())
    log.info("[FEED] DONE ~%.2fs (+%.2fs tail)", cut / TGT_SR, tail_frames * (step / TGT_SR))

def end_stream(recorder: AudioToTextRecorder):
    # Gọi tuần tự các API nếu có
    for name in ("end_stream", "feed_audio_end", "finish", "stop"):
        fn = getattr(recorder, name, None)
        if callable(fn):
            try:
                fn()
                log.info("[STT] %s() called", name)
                break
            except Exception as e:
                log.warning("[STT] %s() error: %s", name, e)
    if hasattr(recorder, "shutdown") and callable(recorder.shutdown):
        try:
            recorder.shutdown()
            log.info("[STT] recorder.shutdown() called")
        except Exception as e:
            log.warning("[STT] shutdown() error: %s", e)

def main():
    log.info("[Config] LOG_PATH=%s", LOG_PATH)
    log.info("[Input] %s", PATH_MP3)

    if not os.path.isfile(PATH_MP3):
        log.error("Không tìm thấy file: %s", PATH_MP3)
        print("(empty)")
        return

    # Decode → Resample → AGC
    a48 = decode_mp3_to_mono_48k(PATH_MP3)
    a16 = resample_48k_to_16k(a48)
    a16 = apply_agc(a16, target_peak=0.95, max_gain=8.0)

    catcher = TranscriptCatcher()
    rec = make_recorder(catcher)

    t0 = time.time()
    feed_stream(rec, a16)

    # Đợi nền xử lý nốt
    time.sleep(1.0)
    end_stream(rec)

    wall = time.time() - t0
    log.info("[DONE] total_wall_time=%.2fs", wall)

    # Lấy transcript cuối: ưu tiên STABLE mới nhất
    final_text = (catcher.latest_stable or catcher.last_update or "").strip()

    print("\n=== TRANSCRIPT (final) ===\n", final_text or "(empty)", "\n")
    log.info("[TRANSCRIPT_FINAL] %s", final_text or "(empty)")

if __name__ == "__main__":
    main()
