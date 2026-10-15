#!/usr/bin/env bash
# Stops and removes the Murmur launch agent. Needs nothing but macOS built-ins.
# Usage: scripts/uninstall.sh [--purge] [--purge-models]
#   --purge          also delete the token, config and logs
#   --purge-models   also delete Murmur's two models from the Hugging Face cache (~3 GB)
set -euo pipefail

LABEL="com.murmur.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
MODELS=(models--mlx-community--Kokoro-82M-bf16 models--mlx-community--parakeet-tdt-0.6b-v2)

purge=0 purge_models=0
for arg in "$@"; do
  case "$arg" in
    --purge) purge=1 ;;
    --purge-models) purge_models=1 ;;
    -h|--help) sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# Prefer the paths the installed agent actually uses over this shell's environment.
from_plist() { [[ -f "$PLIST" ]] && plutil -extract "$1" raw -o - "$PLIST" 2>/dev/null; }
SUPPORT_DIR="$(from_plist EnvironmentVariables.MURMUR_HOME || echo "${MURMUR_HOME:-$HOME/Library/Application Support/Murmur}")"
HF_HUB_CACHE="$(from_plist EnvironmentVariables.HF_HUB_CACHE || echo "${HF_HUB_CACHE:-${HF_HOME:-$HOME/.cache/huggingface}/hub}")"
LOG_FILE="$(from_plist StandardOutPath || echo "$HOME/Library/Logs/Murmur/server.log")"
LOG_DIR="$(dirname "$LOG_FILE")"

# Refuse to rm -rf anything that is obviously not a Murmur-owned folder.
safe_rm() {
  local p="${1%/}"
  case "$p" in
    "" | / | "$HOME" | "$HOME/Library" | "$HOME/Library/Application Support" | "$HOME/Library/Logs")
      echo "Refusing to delete '$1'; remove it by hand if you really mean to." >&2; return 1 ;;
  esac
  rm -rf "$p"
}

if launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null; then
  echo "Stopped $LABEL"
else
  echo "$LABEL was not running"
fi
if [[ -f "$PLIST" ]]; then rm "$PLIST"; echo "Removed $PLIST"; fi

if (( purge )); then
  safe_rm "$SUPPORT_DIR" && echo "Removed $SUPPORT_DIR"
  safe_rm "$LOG_DIR" && echo "Removed $LOG_DIR"
fi

if (( purge_models )) && [[ ! -d "${HF_HUB_CACHE:?}" ]]; then
  echo "No Hugging Face cache at $HF_HUB_CACHE; nothing to purge"
elif (( purge_models )); then
  # Only Murmur's own model folders; the rest of the cache may belong to other tools.
  # Newer huggingface_hub keeps file contents in a shared, content-addressed $HF_HUB_CACHE/blobs
  # and the model folders only hold symlinks into it, so delete the targets too, except any that
  # another model in the cache still points at.
  is_murmur() { local m; for m in "${MODELS[@]}"; do [[ "$1" == "$m" ]] && return 0; done; return 1; }
  shared_root="$(cd "${HF_HUB_CACHE:?}" 2>/dev/null && pwd -P)/blobs"
  keep="$(for d in "$HF_HUB_CACHE"/models--*/blobs; do
            if [[ ! -d "$d" ]] || is_murmur "$(basename "$(dirname "$d")")"; then continue; fi
            for l in "$d"/*; do [[ -L "$l" ]] && readlink -f "$l"; done
          done | sort -u)"
  for m in "${MODELS[@]}"; do
    for l in "$HF_HUB_CACHE/$m"/blobs/*; do
      [[ -L "$l" ]] || continue
      t="$(readlink -f "$l")" || continue
      [[ "$t" == "$shared_root"/* ]] && ! grep -qxF "$t" <<<"$keep" && rm -f "$t"
    done
    rm -rf "${HF_HUB_CACHE:?}/$m"
  done
  echo "Removed Murmur models from $HF_HUB_CACHE"
fi

cat <<'EOF'

Done. To finish, remove the extension in Dia at chrome://extensions.
The repo (including server/.venv) is untouched; delete it yourself if you no longer need it.
EOF
