"""Paths and settings shared by the server and the install scripts."""

import json
import os
import secrets
from pathlib import Path

HOST = "127.0.0.1"
PORT = int(os.environ.get("MURMUR_PORT", "47811"))

SUPPORT_DIR = Path(os.environ.get("MURMUR_HOME", Path.home() / "Library/Application Support/Murmur"))
TOKEN_FILE = SUPPORT_DIR / "token"
CONFIG_FILE = SUPPORT_DIR / "config.json"

TTS_MODEL = "mlx-community/Kokoro-82M-bf16"
STT_MODEL = "mlx-community/parakeet-tdt-0.6b-v2"

# American (a*) and British (b*) English voices, best first per Kokoro's VOICES.md grades.
VOICES = {
    "af_heart": "Heart (US, warm)",
    "af_bella": "Bella (US, bright)",
    "af_nicole": "Nicole (US, soft)",
    "af_aoede": "Aoede (US)",
    "af_kore": "Kore (US)",
    "af_sarah": "Sarah (US)",
    "am_fenrir": "Fenrir (US, male)",
    "am_michael": "Michael (US, male)",
    "am_puck": "Puck (US, male)",
    "bf_emma": "Emma (UK)",
    "bf_isabella": "Isabella (UK)",
    "bm_george": "George (UK, male)",
    "bm_fable": "Fable (UK, male)",
}
DEFAULT_VOICE = "af_heart"
SPEED_MIN, SPEED_MAX = 0.6, 1.6


def load_token() -> str:
    """Return the shared secret, creating it (mode 0600) on first run."""
    SUPPORT_DIR.mkdir(parents=True, exist_ok=True)
    if TOKEN_FILE.exists():
        tok = TOKEN_FILE.read_text().strip()
        if tok:
            return tok
    tok = secrets.token_urlsafe(32)
    fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(tok)
    return tok


def load_extension_ids() -> set[str]:
    """Extension IDs allowed to call the server (written by scripts/install.sh)."""
    ids = set(filter(None, os.environ.get("MURMUR_EXTENSION_IDS", "").split(",")))
    if CONFIG_FILE.exists():
        try:
            ids.update(json.loads(CONFIG_FILE.read_text()).get("extension_ids", []))
        except (OSError, ValueError):
            pass
    return ids
