"""Pre-fetch both models into the Hugging Face cache (run once by install.sh)."""

from huggingface_hub import snapshot_download

from .config import STT_MODEL, TTS_MODEL

if __name__ == "__main__":
    for repo in (TTS_MODEL, STT_MODEL):
        print(f"Downloading {repo} …", flush=True)
        print("  ->", snapshot_download(repo))
