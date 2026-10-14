# Murmur

Murmur reads web pages and PDFs aloud in a natural voice and lets you dictate into any text field. It is a browser extension for Dia (and other Chromium browsers) backed by a small server on your own Mac.

- **Voice:** [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M). It doesn't skip, repeat or invent words, even on long textbook passages.
- **Dictation:** [Parakeet TDT 0.6B](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2), with punctuation and capitalization included.
- **Runtime:** both models run on the GPU through MLX.

## Features

- **Read anything.**
  - Read your selection.
  - Read the whole page.
  - **⌥-click** any paragraph to start reading from that spot.
  - Right-click a selection and choose **Read with Murmur**.
- **Follow along.** The current sentence is highlighted, and so is each word as it's spoken. The page scrolls only when the reading moves off screen.
- **Reader view.** Opens a clean, large-type copy of a cluttered page, such as a Canvas or Blackboard page or a news site, with adjustable font size and line spacing.
- **PDFs.** PDFs open in Murmur's viewer and are read the same way. Running headers, footers and words hyphenated across lines are cleaned up before reading.
- **Speech that sounds like a person reading.**
  - Citations such as `[12]` and `(Smith et al., 2019)` are skipped.
  - "e.g." is read as "for example" and "Fig. 3" as "Figure 3".
  - URLs are read as "link".
- **Speeds and voices.**
  - Speed runs from 0.7× to 1.6× without changing pitch.
  - There are 13 US and UK voices.
  - Change either mid-sentence from the player bar or the popup. Your choice is remembered.
- **Dictation.**
  - Press a shortcut, speak, then press it again or just stop talking.
  - The text is typed into the focused field, and undo works as usual.

## Install

Requirements:
- An Apple silicon Mac (M1 or later).
- Dia or another Chromium browser.
- [uv](https://docs.astral.sh/uv/): `brew install uv`.
- Node is optional.

```sh
git clone <this repo> ~/src/murmur
~/src/murmur/scripts/install.sh
```

Keep the repo outside `~/Desktop`, `~/Documents`, `~/Downloads` and iCloud Drive. macOS privacy protections can stop the background server from reading files in those folders.

The installer does the following, and is safe to re-run:
- Installs Python 3.12 and the server's dependencies into `server/.venv`.
- Downloads both models (about 3 GB, first run only).
- Creates a pairing token.
- Registers the server as a login item (`launchd`), so it is always running. macOS may show a "Background Items Added" notice; that's Murmur.

Then, in Dia:

1. Open `chrome://extensions` (Dia also accepts `dia://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and choose the repo's `extension/` folder. The welcome page opens and finishes setup: it pairs with the server, asks for microphone access and checks your shortcuts.
3. To read PDFs saved on your Mac, open Murmur's **Details** page and turn on **Allow access to file URLs**.
4. To dictate, allow Dia in **System Settings → Privacy & Security → Microphone**.

## Shortcuts

| Keys | Action |
| --- | --- |
| ⌥⇧R | Read the selection, or the whole page if nothing is selected. Press again to pause or resume. |
| ⌥⇧E | Open Reader view |
| ⌥⇧D | Start or stop dictation |
| ⌥⇧← / ⌥⇧→ | Previous or next sentence. Works only while reading, and not inside text fields, where these keys select words. |
| ⌥-click | Read from here |

You can change the first three at `chrome://extensions/shortcuts`.

## Troubleshooting

**The popup says "Server not running".** Check the service:

```sh
launchctl print gui/$(id -u)/com.murmur.server | head -20   # state = running?
curl -s http://127.0.0.1:47811/health                         # tts_ready should be true
tail -f ~/Library/Logs/Murmur/server.log
```

- Restart it with `launchctl kickstart -k gui/$(id -u)/com.murmur.server`.
- If that doesn't help, re-run `scripts/install.sh`.
- If you switched Murmur off under **System Settings → General → Login Items**, switch it back on and re-run `scripts/install.sh`.
- If the log shows `Operation not permitted`, the repo is in a protected folder (Desktop, Documents, Downloads or iCloud Drive). Move it, for example to `~/src/murmur`, and re-run the installer.
- The voice takes a few seconds to load after login. Until then, `/health` shows `"tts_ready": false`.

**The popup says "Not connected"**, or reading fails with an authorization error. Click **Connect** in the popup. If pairing still fails, paste the token from:

```sh
cat ~/Library/Application\ Support/Murmur/token
```

**A shortcut does nothing.** Another extension or app may have claimed it. Assign a new one at `chrome://extensions/shortcuts`.

**Dictation in Google Docs.** Google Docs doesn't accept typed-in text from extensions, so Murmur copies the text to your clipboard instead and shows **⌘V to paste**.

**Dictation hears nothing.** Check that Dia is allowed under **System Settings → Privacy & Security → Microphone**, then reload the extension.

**A course PDF won't load in Murmur's viewer.** Some sites hand out short-lived download links. Download the PDF and drop it onto the viewer, or switch off **Open PDFs in Murmur** in the popup to use Dia's built-in viewer. Selecting text there and choosing **Read with Murmur** still works.

**Uninstall:**

```sh
scripts/uninstall.sh                  # stop and remove the background service
scripts/uninstall.sh --purge          # also delete the token, settings and logs
scripts/uninstall.sh --purge-models   # also delete the downloaded models (~3 GB)
```

Then remove the extension at `chrome://extensions`.

## Privacy

Everything runs on your Mac. The internet is used only once, at install, to download the models from Hugging Face. After that the server runs with `HF_HUB_OFFLINE=1` and never goes online.

Page text and your voice recordings never leave the machine.

The server only listens on `127.0.0.1`. It rejects requests from web pages, and it requires a secret token that only the extension holds.

## Development

```
server/      FastAPI + MLX server (uv project)
extension/   MV3 extension, no build step
scripts/     install / uninstall / launchd template / gen-key.mjs
docs/        ARCHITECTURE.md — message protocols and module contracts
```

```sh
cd server && uv run pytest             # server tests
cd extension && node --test tests/     # segmentation / normalization / alignment tests
cd e2e && npm install && node run.mjs  # end-to-end: real extension + live server in headless Chromium
```

- **Running the server by hand.** Stop the service first so the port is free: `launchctl bootout gui/$(id -u)/com.murmur.server`. Then start the server: `cd server && uv run python -m murmur_server`. Run `scripts/install.sh` again when you're done.
- **Changing the extension.** Reload Murmur at `chrome://extensions` after editing it.
- **The extension ID.** The ID is fixed by the `key` in `extension/manifest.json`. `node scripts/gen-key.mjs` prints it.
- **Allowed extension IDs.** The server reads the allowed IDs from `~/Library/Application Support/Murmur/config.json` at startup. After you change that file, restart the server with `launchctl kickstart -k …`.
- **Contracts.** See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

The end-to-end test needs the server running (`scripts/install.sh`). If the Chrome for Testing that puppeteer downloads won't start, point `CHROME` at another Chromium binary, for example Playwright's. Headless Chromium on macOS can't open a microphone without a system prompt, so the test feeds synthesized speech to dictation as its microphone stream. Everything after capture is real.
