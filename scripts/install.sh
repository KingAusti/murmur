#!/usr/bin/env bash
# Installs the Murmur server as a per-user launchd agent. Safe to re-run.
# Usage: scripts/install.sh
set -euo pipefail
# CDPATH makes `cd` echo, which would corrupt REPO; a foreign UV_PROJECT_ENVIRONMENT
# would put the venv somewhere other than server/.venv, which the plist points at.
unset CDPATH UV_PROJECT_ENVIRONMENT

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$REPO/server"
PY="$SERVER_DIR/.venv/bin/python"
LABEL="com.murmur.server"
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/Murmur"
LOG_FILE="$LOG_DIR/server.log"
PORT="${MURMUR_PORT:-47811}"
# Pin every location explicitly: launchd starts the server with a bare environment.
export MURMUR_HOME="${MURMUR_HOME:-$HOME/Library/Application Support/Murmur}"
export HF_HOME="${HF_HOME:-$HOME/.cache/huggingface}"
export HF_HUB_CACHE="${HF_HUB_CACHE:-$HF_HOME/hub}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
# murmur_server is not an installed package (uv package=false), so run from server/.
py()   { (cd "$SERVER_DIR" && "$PY" "$@"); }

step "Checking prerequisites"
[[ "$(uname -s)" == Darwin ]] || die "Murmur needs macOS."
# hw.optional.arm64 is 1 on Apple silicon even when this shell runs under Rosetta.
[[ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" == 1 ]] \
  || die "Murmur needs an Apple silicon Mac (M1 or later); MLX does not run on Intel."
command -v uv >/dev/null || die "uv not found. Install it with:  brew install uv"
echo "macOS on Apple silicon, uv $(uv --version | awk '{print $2}')"
case "$REPO/" in
  "$HOME/Desktop/"* | "$HOME/Documents/"* | "$HOME/Downloads/"* | "$HOME/Library/Mobile Documents/"*)
    warn "The repo is in a privacy-protected folder. macOS may stop the background server from" \
      "reading it (\"Operation not permitted\" in the log); if so, move it (e.g. to ~/src/murmur) and re-run." ;;
esac

# Stop a running copy first so uv never swaps the venv out from under it. If we
# fail before loading the new one, put the old one back rather than leave none.
restore_old=0
if launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null; then restore_old=1; fi
trap '(( restore_old )) && [[ -f "$PLIST" ]] && launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; true' EXIT

step "Installing Python dependencies (uv sync)"
(cd "$SERVER_DIR" && uv sync)
[[ -x "$PY" ]] || die "uv sync did not create $PY."

step "Fetching voice and dictation models (~3 GB, first run only)"
# Online first: it resumes partial downloads (an offline check would accept a
# half-fetched snapshot). The cache-only retry lets re-runs work without a network.
(unset HF_HUB_OFFLINE; py -m murmur_server.download) \
  || HF_HUB_OFFLINE=1 py -m murmur_server.download >/dev/null 2>&1 \
  || die "Model download failed. Check your network and re-run."
echo "Models cached in $HF_HUB_CACHE"

step "Pairing configuration"
if command -v node >/dev/null; then
  EXT_ID="$(node "$REPO/scripts/gen-key.mjs")"
else
  # Same derivation as gen-key.mjs, for machines without Node (needs an existing key).
  EXT_ID="$(py -c '
import base64, hashlib, json, sys
key = json.load(open(sys.argv[1])).get("key") or sys.exit("manifest.json has no key; install Node and re-run")
print("".join(chr(97 + int(c, 16)) for c in hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]))
' "$REPO/extension/manifest.json")"
fi
[[ "$EXT_ID" =~ ^[a-p]{32}$ ]] || die "Could not derive the extension ID (got '$EXT_ID')."

# Merge the ID into config.json without clobbering other keys, then ensure the token exists.
TOKEN="$(py -c '
import json, sys
from murmur_server.config import CONFIG_FILE, SUPPORT_DIR, load_token
SUPPORT_DIR.mkdir(parents=True, exist_ok=True)
try:
    cfg = json.loads(CONFIG_FILE.read_text())
except (OSError, ValueError):
    cfg = {}
cfg = cfg if isinstance(cfg, dict) else {}
ids = cfg.get("extension_ids")
ids = [i for i in ids if isinstance(i, str)] if isinstance(ids, list) else []
if sys.argv[1] not in ids:
    ids.append(sys.argv[1])
cfg["extension_ids"] = ids
tmp = CONFIG_FILE.with_suffix(".tmp")
tmp.write_text(json.dumps(cfg, indent=2) + "\n")
tmp.replace(CONFIG_FILE)
print(load_token())
' "$EXT_ID")"
echo "Extension ID $EXT_ID allowed in $MURMUR_HOME/config.json"

step "Installing launch agent"
mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"
# Render and lint off to the side so a bad render never replaces a working plist.
PLIST_NEW="$(mktemp -t murmur-plist)"
py -c '
import sys
from xml.sax.saxutils import escape
src, dst, *pairs = sys.argv[1:]
text = open(src).read()
for k, v in zip(pairs[::2], pairs[1::2]):
    text = text.replace("@" + k + "@", escape(v))
open(dst, "w").write(text)
' "$REPO/scripts/$LABEL.plist.tmpl" "$PLIST_NEW" \
  PYTHON "$PY" SERVER_DIR "$SERVER_DIR" HF_HOME "$HF_HOME" HF_HUB_CACHE "$HF_HUB_CACHE" \
  MURMUR_HOME "$MURMUR_HOME" PORT "$PORT" LOG_FILE "$LOG_FILE"
if grep -q '@[A-Z_]*@' "$PLIST_NEW"; then die "Unrendered placeholder in $PLIST_NEW"; fi
plutil -lint -s "$PLIST_NEW" || die "Rendered plist is invalid: $PLIST_NEW"
# launchd refuses job files that are group- or world-writable (e.g. under umask 002).
chmod 644 "$PLIST_NEW"
mv -f "$PLIST_NEW" "$PLIST"

# The old server may take a moment to exit after bootout; anything else on the port is a conflict.
for attempt in $(seq 10); do
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
  if [[ $attempt == 10 ]]; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2 || true
    restore_old=0  # a restored agent would only crash-loop on the taken port
    die "Port $PORT is in use by the process above. Stop it and re-run."
  fi
  sleep 1
done

# Clear any "disabled" override (e.g. from an old `launchctl unload -w`); bootstrap fails otherwise.
launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true
# bootstrap can briefly fail with "5: Input/output error" right after a bootout.
for attempt in 1 2 3 4 5; do
  if [[ $attempt == 5 ]]; then
    launchctl bootstrap "$DOMAIN" "$PLIST" \
      || die "launchctl bootstrap failed (see above). If Murmur is switched off in System Settings > General > Login Items, switch it on and re-run."
  elif launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; then
    break
  fi
  sleep 1
done
# shellcheck disable=SC2034  # read by the EXIT trap
restore_old=0
echo "Loaded $LABEL (logs: $LOG_FILE)"

step "Waiting for the server to load the voice model"
health="" status="unreachable"
for _ in $(seq 60); do
  if body="$(curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" 2>/dev/null)"; then
    health="$body"
    status="$(printf '%s' "$body" | py -c '
import json, sys
try:
    d = json.load(sys.stdin)
except ValueError:
    d = {}
d = d if isinstance(d, dict) else {}
print("ready" if d.get("tts_ready") else "error: " + str(d["tts_error"]) if d.get("tts_error") else "loading")
')" || status=loading
    [[ "$status" == loading ]] || break
  fi
  sleep 1
done

if [[ -z "$health" ]]; then
  tail -n 30 "$LOG_FILE" >&2 2>/dev/null || true
  die "Server did not answer on http://127.0.0.1:$PORT/health within 60s (log tail above)."
elif [[ "$status" == error:* ]]; then
  tail -n 30 "$LOG_FILE" >&2 2>/dev/null || true
  die "Server is up but the voice failed to load: ${status#error: }"
elif [[ "$status" == loading ]]; then
  echo "Server is up; the voice is still warming up (the extension popup will show when it's ready)."
else
  echo "Server is up and the voice is ready."
fi

cat <<EOF

$(bold "Murmur server installed.") It starts automatically at login.

Pairing token (only needed if the welcome page asks you to paste it):
  $TOKEN

$(bold "Last steps, in Dia:")
  1. Open  chrome://extensions  and turn on "Developer mode" (top right).
  2. Click "Load unpacked" and choose:  $REPO/extension
     The Murmur welcome page opens and finishes pairing and microphone setup.
  3. On Murmur's "Details" page, turn on "Allow access to file URLs" to read local PDFs.
  4. For dictation, allow Dia in System Settings > Privacy & Security > Microphone.

Shortcuts: ⌥⇧R read/pause · ⌥⇧E Reader view · ⌥⇧D dictate · ⌥-click read from here
EOF
