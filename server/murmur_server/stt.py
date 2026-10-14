"""Parakeet-TDT speech-to-text via parakeet-mlx (no ffmpeg: we decode WAV ourselves)."""

import io
import logging
import threading

import numpy as np
import soundfile as sf

from .config import STT_MODEL

log = logging.getLogger("murmur.stt")


class ParakeetSTT:
    def __init__(self, model_id: str = STT_MODEL):
        self.model_id = model_id
        self.model = None
        self._lock = threading.Lock()

    @property
    def ready(self) -> bool:
        return self.model is not None

    def load(self) -> None:
        with self._lock:
            if self.model is not None:
                return
            from parakeet_mlx import from_pretrained

            self.model = from_pretrained(self.model_id)
            log.info("Parakeet ready")

    def transcribe_wav(self, wav_bytes: bytes) -> str:
        y, sr = sf.read(io.BytesIO(wav_bytes), dtype="float32", always_2d=False)
        if y.ndim > 1:
            y = y.mean(axis=1)
        return self.transcribe(y, sr)

    def transcribe(self, audio: np.ndarray, sr: int) -> str:
        import mlx.core as mx
        from parakeet_mlx.audio import get_logmel

        self.load()
        cfg = self.model.preprocessor_config
        if sr != cfg.sample_rate:
            import librosa

            audio = librosa.resample(audio, orig_sr=sr, target_sr=cfg.sample_rate)
        if audio.size < cfg.sample_rate // 4:  # < 0.25 s: accidental tap
            return ""
        with self._lock:
            # Never model.transcribe(path): that shells out to ffmpeg.
            mel = get_logmel(mx.array(np.ascontiguousarray(audio, dtype=np.float32)), cfg)
            return self.model.generate(mel)[0].text.strip()
