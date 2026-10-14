"""Murmur local server: POST /tts, POST /stt, POST /pair, GET /health."""

import asyncio
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request
from starlette.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel, Field

from . import __version__
from .auth import Gate
from .config import DEFAULT_VOICE, VOICES, load_extension_ids, load_token
from .stt import ParakeetSTT
from .tts import KokoroTTS

log = logging.getLogger("murmur")

MAX_TEXT = 2000
MAX_WAV_BYTES = 20 * 1024 * 1024  # ~10 min of 16 kHz mono PCM


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT)
    voice: str = DEFAULT_VOICE
    speed: float = 1.0
    session: str = Field(default="", max_length=64)
    gen: int = 0


def create_app(tts=None, stt=None, gate: Gate | None = None, load_models: bool = True) -> FastAPI:
    tts = tts or KokoroTTS()
    stt = stt or ParakeetSTT()
    gate = gate or Gate(load_token(), load_extension_ids())
    # One worker: MLX work is serialized, and queued jobs run in arrival order.
    tts_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="tts")
    stt_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="stt")
    latest_gen: dict[str, int] = {}
    state = {"tts_error": None}

    def _load_tts():
        try:
            tts.load()
        except Exception as e:  # surfaced via /health
            state["tts_error"] = str(e)
            log.exception("TTS failed to load")

    @asynccontextmanager
    async def lifespan(app):
        if load_models:
            threading.Thread(target=_load_tts, daemon=True).start()
        yield
        tts_pool.shutdown(wait=False, cancel_futures=True)
        stt_pool.shutdown(wait=False, cancel_futures=True)

    app = FastAPI(title="Murmur", version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.gate = gate
    # Reject DNS-rebinding requests (Host: attacker.example) outright.
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "testserver"])

    def authed(request: Request):
        gate.check(request)

    @app.get("/health")
    def health(request: Request):
        gate.check_origin(request)
        return {
            "ok": True,
            "version": __version__,
            "tts_ready": tts.ready,
            "tts_error": "failed to load; see server log" if state["tts_error"] else None,
            "stt_ready": stt.ready,
            "voices": VOICES,
            "default_voice": DEFAULT_VOICE,
        }

    @app.post("/pair")
    def pair(request: Request):
        if not gate.can_pair(request):
            raise HTTPException(403, "pairing is only allowed from the Murmur extension")
        return {"token": gate.token}

    @app.post("/tts", dependencies=[Depends(authed)])
    async def synth(body: TTSRequest, request: Request):
        if state["tts_error"]:
            raise HTTPException(500, "The voice failed to load. See ~/Library/Logs/Murmur/server.log")
        if not tts.ready:
            raise HTTPException(503, "voice model is still loading")
        if body.session:
            if body.gen < latest_gen.get(body.session, 0):
                raise HTTPException(409, "stale")
            latest_gen[body.session] = body.gen
            if len(latest_gen) > 256:  # bound memory across many tabs/sessions
                latest_gen.pop(next(iter(latest_gen)))

        def job():
            # Dropped here if the reader skipped/changed speed while we were queued.
            if body.session and body.gen < latest_gen.get(body.session, 0):
                return None
            return tts.synthesize(body.text, body.voice, body.speed)

        if await request.is_disconnected():
            raise HTTPException(409, "client gone")
        out = await asyncio.get_running_loop().run_in_executor(tts_pool, job)
        if out is None:
            raise HTTPException(409, "stale")
        out.pop("_float", None)
        return out

    @app.post("/stt", dependencies=[Depends(authed)])
    async def transcribe(request: Request):
        data = await request.body()
        if not data:
            raise HTTPException(400, "empty body")
        if len(data) > MAX_WAV_BYTES:
            raise HTTPException(413, "recording too long")
        try:
            text = await asyncio.get_running_loop().run_in_executor(stt_pool, stt.transcribe_wav, data)
        except (RuntimeError, ValueError) as e:  # soundfile raises these for non-WAV input
            raise HTTPException(400, f"could not decode audio: {e}")
        return {"text": text}

    return app
