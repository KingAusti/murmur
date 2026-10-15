# Murmur architecture & internal contracts

Murmur = MV3 extension (Dia / Chromium) + local server (`server/`, FastAPI on `127.0.0.1:47811`).
Extension ID is fixed by `manifest.json#key`: `fhclfpkjgiaghbagldighhljljobfijc`.

```
reader context ──Port "murmur-reader"──► background SW ──runtime msg──► offscreen doc ──fetch──► server
 (content script,                         (router, commands,              (Web Audio playback,
  reader view page,                        menus, DNR, inject)             prefetch, mic, clipboard)
  pdf viewer page)
```

## Shared code style
- **No build step.** Every file under `extension/lib/` and `extension/content/` is a *classic script*:
  - no `import`/`export`;
  - it attaches to `globalThis.Murmur` (`globalThis.Murmur = globalThis.Murmur || {}`);
  - it is wrapped in an IIFE and is idempotent (safe to inject twice).
- Node tests (`node --test extension/tests`) load these files with `await import(path)` for their side effects, then read `globalThis.Murmur`.
- Each lib must be pure: it uses no DOM and needs only `Intl.Segmenter` (available in Node 16 and later).

## lib contracts (pure functions)

### `Murmur.segment.splitSentences(text) → Array<{start, end}>`
- Offsets index into `text`. Each span is trimmed (no leading or trailing whitespace) and never empty.
- `\n\n` is a hard boundary; a span never crosses it. Single `\n` is treated as a space.
- Uses `Intl.Segmenter('en', {granularity: 'sentence'})`, followed by a merge pass for false splits after abbreviations:
  - titles and labels: Dr. Mr. Mrs. Ms. Prof. St. Jr. Sr.
  - references: Fig. Figs. Eq. Eqs. Sec. Ch. Vol. No. p. pp. Ref. Refs.
  - Latin and comparisons: vs. etc.(only when followed by lowercase) e.g. i.e. et al. cf. approx.
  - initials (`J. R. R. Tolkien`) and single capital letters followed by `.`
- Also merges when the next segment starts with a lowercase letter, a digit, `)` or `]`.
- Spans longer than about 300 chars are split near the middle. It prefers `; ` and `: `, then `, `, then any whitespace. No piece may be shorter than about 40 chars.

### `Murmur.normalize.normalize(text, opts?) → {spoken, words}`
- `opts.skipCitations` defaults to `true`.
- `spoken` is the string sent to TTS.
- `words` is `Array<{text, srcStart, srcEnd}>`, with one entry per word-like token of `spoken` in order. A token is a run of non-space characters containing at least one letter or digit, with surrounding punctuation stripped.
- `srcStart`/`srcEnd` are offsets into the input `text` covering the source the word came from. All words from one substitution share the same source span: "for example" → both map to "e.g.".
- Rules:
  - When citations are skipped, these are deleted from `spoken`:
    - numeric brackets `[12]`, `[3–5, 8]`;
    - parenthetical author-year citations `(Smith, 2019)`, `(Smith et al., 2019, p. 34)`, `(Smith & Lee, 2020; Wu, 2021)`.
  - Substitutions:
    - Latin: e.g. → for example, i.e. → that is, et al. → and colleagues, cf. → compare, etc. → et cetera, vs. → versus, approx. → approximately, ca. → about.
    - Labels: Fig./Figs. → Figure/Figures, Eq./Eqs. → Equation/Equations, Sec. → Section, Ch. → Chapter, Vol. → Volume, No. (before a digit) → Number, p./pp. (before a digit) → page/pages.
  - URLs and emails → "link".
  - Collapse whitespace.
  - Leave numbers, units and symbols to the TTS engine (misaki handles `1,250`, `3.5%`, `$20.50`, `25°C`).
- If nothing speakable remains, return `{spoken: '', words: []}`.

### `Murmur.align.align(serverWords, normWords) → Array<{s, e, srcStart, srcEnd}> | null`
- `serverWords`: `[{t, s, e}]` from `/tts`. Tokens can be punctuation (`","`, `"."`, `"—"`) and words can be split (`"H2O"` → `"H"`, `"2"`, `"O"`; `"$20.50"` → `"$"`, `"20.50"`).
- Algorithm (character-level):
  1. Lowercase and keep only `[\p{L}\p{N}]` characters from each normWord, concatenated into one stream that remembers which word owns each char.
  2. Walk the serverWords, consuming each token's alnum chars against the stream. A token whose chars all belong to word k contributes its `s`/`e` to word k; take the min `s` and max `e`.
  3. Tolerate small mismatches by resyncing with a lookahead of a few chars.
- Return one entry per normWord that received timing, in order, with merged `srcStart`/`srcEnd`.
- Return `null` when fewer than 60% of normWords got timing; the caller then falls back to sentence-only highlighting.

## Server API (see `server/murmur_server/app.py`)
- `GET /health` → `{ok, version, tts_ready, tts_error, stt_ready, voices:{id:label}, default_voice}`.
- `POST /pair` → `{token}`. Only allowed when `Origin: chrome-extension://<our id>`.
- `POST /tts` JSON body `{text, voice, speed, session, gen}` → `{sr: 24000, pcm: base64 s16le mono, words: [{t, s, e}], dur}`.
  - Errors: `409` stale (silently drop), `503` loading, `401` bad token.
- `POST /stt` raw WAV body (16 kHz mono s16) → `{text}`.
- Every call except `/health` and `/pair` needs the `X-Murmur-Token` header.

## Reader runtime (`content/reader.js`, `content/player.js`)
- A **source** is `{ text, toRange(start, end) → Range|null, reveal?(start) → Promise<void> }`.
  - `reader.js` provides `Murmur.reader.domSource(root, {from?: {node, offset}})`.
  - The PDF viewer hook provides its own source.
- `Murmur.reader.start({mode: 'selection'|'page'|'from'|'source', root?, from?, source?})`.
- Other calls: `.toggle()`, `.stop()`, `.next()`, `.prev()`, `.isActive()`.
- Highlights use the CSS Custom Highlight API names `murmur-sentence` and `murmur-word`, styled with `::highlight()`.
  - In content scripts these styles are injected via a `<style>` in `document.head`. Page CSP never blocks a style element added by an extension's isolated world.

### Port protocol (`chrome.runtime.connect({name: 'murmur-reader'})`)
reader → background:
- `{type: 'load', sentences: [spokenText], start, voice?, speed?}`
- `{type: 'pause' | 'resume' | 'toggle' | 'stop'}`
- `{type: 'seek', index}`
- `{type: 'settings', voice?, speed?}`

background → reader:
- `{type: 'state', state: 'loading'|'playing'|'paused'|'ended'|'stopped'|'error', index?, error?}`
- `{type: 'sentence', index, words: [{t, s, e}], at}`: `at` is the wall-clock `Date.now()` time at which offset 0 of this sentence's audio is heard. Used to schedule word highlights; it is re-sent on resume.

Only one reading session plays at a time. A new `load` from another port stops the previous one, which gets `state: 'stopped'`.

## Commands & routing
- `chrome.commands`:
  - `read` (⌥⇧R): read the selection; if none, the page; if already reading, toggle pause.
  - `reader-view` (⌥⇧E).
  - `dictate` (⌥⇧D).
- Context menu "Read with Murmur" (selection).
- `boot.js` (declared content script, all frames) receives `{type: 'cmd', cmd}` from the background.
  - It loads the reader on demand: it sends `{type: 'inject'}` and the background runs `chrome.scripting.executeScript` for `lib/*` and `content/*` into that frame.
- Extension pages (reader view, PDF viewer) load these scripts statically.
  - Commands reach them through `chrome.runtime.sendMessage({..., __tab: tabId})`, and each page filters on its own tab ID.

## Robustness notes
- **Keeping the service worker awake.**
  - MV3 service workers sleep after about 30 s idle, which drops reader ports and in-memory state.
  - While a session exists (including paused), or while dictation is starting, recording or transcribing, the offscreen document sends a `keepalive` runtime message every 20 s.
  - The offscreen document reports `busy?` for those same states, so the 5-minute idle alarm never closes it mid-session.
- **Dictation routing.**
  - `{tabId, frameId}` travels with the recording (`dictate-start` → every dictate event's `route`) and is mirrored to `chrome.storage.session`. A restarted worker can still deliver the transcript.
  - ⌥⇧D decides start or stop by asking the offscreen document (`dictating?`), not from worker memory.
- **Trust boundaries.**
  - The offscreen document only accepts messages whose `sender.url` is `background.js`.
  - The server URL is hard-coded, and the token rides on every message, so a re-pair takes effect immediately.
  - The background only accepts `inject`, `tab-id`, `dictate-stop` and `status` from content scripts.
  - Content scripts act only on `isTrusted` input events.
- **Playback.**
  - `play()` is single-flight: a per-session `playTok` lets only the newest call start audio.
  - Guards are re-checked after `await ctx.resume()`.
  - `toggle` after an error retries.
- **Server.** `TrustedHostMiddleware` rejects DNS-rebinding hosts. A permanent model-load failure returns 500 (shown to the user), and "still loading" is 503 (retried).
