import base64
import io
import os
import threading
import time

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from murmur_server.app import create_app
from murmur_server.auth import Gate

EXT = "abcdefghijklmnopabcdefghijklmnop"
ORIGIN = f"chrome-extension://{EXT}"
TOKEN = "test-token"
H = {"Origin": ORIGIN, "X-Murmur-Token": TOKEN}


class FakeTTS:
    ready = True

    def __init__(self, delay=0.0):
        self.delay = delay
        self.calls = []

    def synthesize(self, text, voice, speed):
        self.calls.append(text)
        time.sleep(self.delay)
        pcm = np.zeros(2400, dtype=np.float32)
        return {"sr": 24000, "pcm": base64.b64encode(pcm.astype("<i2").tobytes()).decode(),
                "words": [{"t": w, "s": i * 0.1, "e": i * 0.1 + 0.1} for i, w in enumerate(text.split())],
                "dur": 0.1, "_float": pcm}


class FakeSTT:
    ready = True

    def transcribe_wav(self, data):
        y, sr = sf.read(io.BytesIO(data))
        return f"{len(y)} samples at {sr}"


def make(tts=None):
    return TestClient(create_app(tts or FakeTTS(), FakeSTT(), Gate(TOKEN, {EXT}), load_models=False))


def wav_bytes(n=8000, sr=16000):
    buf = io.BytesIO()
    sf.write(buf, np.zeros(n, dtype=np.float32), sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def test_health_open_but_origin_checked():
    c = make()
    assert c.get("/health").json()["ok"]
    assert c.get("/health", headers={"Origin": ORIGIN}).status_code == 200
    assert c.get("/health", headers={"Origin": "https://evil.example"}).status_code == 403


def test_pair_requires_exact_extension_origin():
    c = make()
    assert c.post("/pair").status_code == 403
    assert c.post("/pair", headers={"Origin": "https://evil.example"}).status_code == 403
    assert c.post("/pair", headers={"Origin": "chrome-extension://someoneelse"}).status_code == 403
    assert c.post("/pair", headers={"Origin": ORIGIN}).json() == {"token": TOKEN}


def test_tts_auth():
    c = make()
    body = {"text": "hello world"}
    assert c.post("/tts", json=body).status_code == 401
    assert c.post("/tts", json=body, headers={"X-Murmur-Token": "nope"}).status_code == 401
    assert c.post("/tts", json=body, headers={**H, "Origin": "https://evil.example"}).status_code == 403
    r = c.post("/tts", json=body, headers=H)
    assert r.status_code == 200
    j = r.json()
    assert j["sr"] == 24000 and "_float" not in j and [w["t"] for w in j["words"]] == ["hello", "world"]


def test_tts_rejects_oversize_and_empty():
    c = make()
    assert c.post("/tts", json={"text": ""}, headers=H).status_code == 422
    assert c.post("/tts", json={"text": "a" * 5000}, headers=H).status_code == 422


def test_stale_generation_rejected_and_dropped_from_queue():
    tts = FakeTTS(delay=0.3)
    c = make(tts)
    results = {}

    def go(name, gen):
        results[name] = c.post("/tts", json={"text": name, "session": "s1", "gen": gen}, headers=H).status_code

    t1 = threading.Thread(target=go, args=("first", 1)); t1.start(); time.sleep(0.05)
    t2 = threading.Thread(target=go, args=("queued", 1)); t2.start(); time.sleep(0.05)
    t3 = threading.Thread(target=go, args=("skip", 2)); t3.start()
    for t in (t1, t2, t3):
        t.join()
    assert results == {"first": 200, "queued": 409, "skip": 200}
    assert "queued" not in tts.calls  # never synthesized
    # an old generation arriving late is refused outright
    assert c.post("/tts", json={"text": "late", "session": "s1", "gen": 1}, headers=H).status_code == 409


def test_stt():
    c = make()
    assert c.post("/stt", content=wav_bytes()).status_code == 401
    r = c.post("/stt", content=wav_bytes(), headers=H)
    assert r.json() == {"text": "8000 samples at 16000"}
    assert c.post("/stt", content=b"", headers=H).status_code == 400


@pytest.mark.skipif(not os.environ.get("MURMUR_REAL_MODELS"), reason="set MURMUR_REAL_MODELS=1 to run real models")
def test_real_roundtrip():
    from murmur_server.stt import ParakeetSTT
    from murmur_server.tts import KokoroTTS

    tts = KokoroTTS(); tts.load()
    out = tts.synthesize("The mitochondria's inner membrane is highly folded.")
    starts = [w["s"] for w in out["words"]]
    assert starts == sorted(starts) and out["dur"] > 1
    stt = ParakeetSTT()
    text = stt.transcribe(out["_float"], 24000)
    assert "mitochondria" in text.lower() and "folded" in text.lower()


def test_dns_rebinding_host_rejected():
    c = make()
    assert c.get("/health", headers={"Host": "attacker.example:47811"}).status_code == 400
    assert c.get("/health", headers={"Host": "127.0.0.1:47811"}).status_code == 200


def test_tts_load_failure_is_reported_not_retried():
    class Broken(FakeTTS):
        ready = False

        def load(self):
            raise RuntimeError("boom")

    app = create_app(Broken(), FakeSTT(), Gate(TOKEN, {EXT}), load_models=True)
    with TestClient(app) as c:
        for _ in range(50):
            if c.get("/health").json()["tts_error"]:
                break
            time.sleep(0.02)
        r = c.post("/tts", json={"text": "hi"}, headers=H)
        assert r.status_code == 500 and "failed to load" in r.json()["detail"]
