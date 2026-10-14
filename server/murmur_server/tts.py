"""Kokoro-82M text-to-speech via mlx-audio, with per-word timings."""

import base64
import logging
import threading
from pathlib import Path

import numpy as np

from .config import DEFAULT_VOICE, SPEED_MAX, SPEED_MIN, TTS_MODEL, VOICES

log = logging.getLogger("murmur.tts")
SAMPLE_RATE = 24000


class KokoroTTS:
    def __init__(self, model_id: str = TTS_MODEL):
        self.model_id = model_id
        self.pipeline = None
        self.voice_files: dict[str, str] = {}
        self.ready = False
        self._lock = threading.Lock()  # MLX is not thread-safe

    def load(self) -> None:
        from huggingface_hub import snapshot_download
        from mlx_audio.tts.utils import load_model

        model = load_model(self.model_id)
        # Voices ship inside the model snapshot; pass explicit file paths so the
        # pipeline never reaches for its default (different) repo or the network.
        snap = Path(snapshot_download(self.model_id))
        self.voice_files = {v: str(snap / "voices" / f"{v}.safetensors") for v in VOICES}
        # Private API (version pinned): the pipeline exposes per-token timings
        # that the public generate() drops.
        self.pipeline = model._get_pipeline("a")
        for f in self.voice_files.values():  # preload so switching voices is instant
            self.pipeline.load_voice(f)
        out = self.synthesize("Ready when you are.")
        pcm = out["_float"]
        if not np.isfinite(pcm).all() or np.abs(pcm).max() < 1e-3:
            raise RuntimeError("Kokoro warm-up produced NaN or silent audio")
        self.ready = True
        log.info("Kokoro ready")

    def synthesize(self, text: str, voice: str = DEFAULT_VOICE, speed: float = 1.0) -> dict:
        voice = voice if voice in VOICES else DEFAULT_VOICE
        speed = float(min(max(speed, SPEED_MIN), SPEED_MAX))
        words, chunks, offset = [], [], 0.0
        with self._lock:
            # split_pattern=None: the extension already sends one sentence.
            for r in self.pipeline(text, voice=self.voice_files[voice], speed=speed, split_pattern=None):
                if r.audio is None:
                    continue
                audio = np.asarray(r.audio, dtype=np.float32).reshape(-1)
                for tk in r.tokens or []:
                    if tk.start_ts is None or tk.end_ts is None:
                        continue
                    words.append({"t": tk.text, "s": round(tk.start_ts + offset, 3), "e": round(tk.end_ts + offset, 3)})
                offset += audio.shape[0] / SAMPLE_RATE
                chunks.append(audio)
        pcm = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
        s16 = (np.clip(pcm, -1.0, 1.0) * 32767).astype("<i2")
        return {
            "sr": SAMPLE_RATE,
            "pcm": base64.b64encode(s16.tobytes()).decode("ascii"),
            "words": words,
            "dur": round(offset, 3),
            "_float": pcm,
        }
