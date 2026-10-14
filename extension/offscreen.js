// Murmur offscreen document: the only place that talks to the local server.
// Plays synthesized sentences gaplessly with prefetch, records dictation, and
// writes to the clipboard. Only chrome.runtime is available here.

const SERVER = "http://127.0.0.1:47811";
const BACKGROUND_URL = chrome.runtime.getURL("background.js");
const PREFETCH = 3;
const SESSION = crypto.randomUUID();

let audioCtx = null;
const ctx = () => (audioCtx ??= new AudioContext({ latencyHint: "playback" }));
let token = "";

function emit(kind, port, msg) {
  chrome.runtime.sendMessage({ from: "offscreen", kind, port, msg }).catch(() => {});
}

// MV3 service workers sleep after ~30 s without events, dropping reader ports
// and in-memory routing. Keep it awake while anything is in progress (incl. paused).
setInterval(() => {
  if (S || rec || starting || transcribing) emit("keepalive");
}, 20000);

// ---------- server ----------

class ServerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function call(path, init, signal) {
  let r;
  try {
    r = await fetch(SERVER + path, { ...init, headers: { "X-Murmur-Token": token, ...init.headers }, signal });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new ServerError("offline", "Can't reach the Murmur server. Is it running? (See Setup & help in the Murmur popup.)");
  }
  if (r.status === 401 || r.status === 403) {
    emit("unauthorized");
    throw new ServerError("unpaired", "Murmur lost its connection to the server. Reconnecting, so press play to try again.");
  }
  if (r.status === 409) throw new ServerError("stale", "stale");
  if (r.status === 503) throw new ServerError("loading", "The voice is still loading…");
  if (!r.ok) {
    const detail = await r.json().then((j) => j?.detail, () => null);
    throw new ServerError("server", typeof detail === "string" ? detail : `Server error ${r.status}`);
  }
  return r.json();
}

// ---------- read-aloud ----------
// Natural sentence-to-sentence advance keeps the prefetch cache. A seek bumps
// `gen` (so the server drops queued stale work) and aborts in-flight requests
// but keeps finished ones; a voice/speed change discards everything.

let S = null; // current session
let gen = 0;

function newSession(msg) {
  if (S) {
    stopSource();
    invalidate(false);
  }
  S = {
    port: msg.port,
    sentences: msg.sentences,
    index: msg.start,
    voice: msg.voice,
    speed: msg.speed,
    cache: new Map(), // index -> {p: Promise<{buffer, words}>, done}
    abort: new AbortController(),
    source: null,
    startedAt: 0, // ctx time when the current sentence started
    words: [],
    paused: false,
    errored: false,
    playTok: 0, // only the latest play() call may start audio
  };
}

function stopSource() {
  if (!S?.source) return;
  S.source.onended = null;
  try {
    S.source.stop();
  } catch {}
  S.source = null;
}

function invalidate(keepDone) {
  gen++;
  S.abort.abort();
  S.abort = new AbortController();
  for (const [k, e] of S.cache) if (!keepDone || !e.done) S.cache.delete(k);
}

function readerEmit(msg) {
  if (S) emit("reader", S.port, msg);
}

async function synthesize(s, i, myGen, signal) {
  const body = JSON.stringify({ text: s.sentences[i], voice: s.voice, speed: s.speed, session: SESSION, gen: myGen });
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await call("/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body }, signal);
      const bytes = Uint8Array.from(atob(out.pcm), (c) => c.charCodeAt(0));
      const pcm = new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1);
      const buffer = ctx().createBuffer(1, Math.max(pcm.length, 1), out.sr);
      const ch = buffer.getChannelData(0);
      for (let k = 0; k < pcm.length; k++) ch[k] = pcm[k] / 32768;
      return { buffer, words: out.words };
    } catch (e) {
      if (e.code === "loading" && attempt < 90 && myGen === gen) {
        if (S?.index === i) readerEmit({ type: "state", state: "loading", index: i, note: e.message });
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      throw e;
    }
  }
}

function fetchSentence(i) {
  if (!S || i < 0 || i >= S.sentences.length) return null;
  if (!S.cache.has(i)) {
    const s = S;
    const entry = { done: false };
    entry.p = synthesize(s, i, gen, s.abort.signal).then((v) => ((entry.done = true), v));
    entry.p.catch(() => s.cache.get(i) === entry && s.cache.delete(i)); // failures are retried on demand
    s.cache.set(i, entry);
  }
  return S.cache.get(i).p;
}

function prefetch(from) {
  for (let i = from; i <= from + PREFETCH; i++) fetchSentence(i);
  for (const k of S.cache.keys()) if (k < from - 1) S.cache.delete(k);
}

// Wall-clock time at which offset 0 of the current sentence is/was audible.
function sentenceEpoch() {
  const c = ctx();
  const latency = (c.outputLatency || c.baseLatency || 0) * 1000;
  return Date.now() + (S.startedAt - c.currentTime) * 1000 + latency;
}

async function play(i) {
  if (!S) return;
  const s = S;
  const myGen = gen;
  const tok = ++s.playTok;
  const current = () => myGen === gen && S === s && tok === s.playTok;
  s.index = i;
  s.errored = false;
  if (i >= s.sentences.length) {
    readerEmit({ type: "state", state: "ended" });
    return;
  }
  prefetch(i);
  if (!s.cache.get(i)?.done) readerEmit({ type: "state", state: "loading", index: i });
  let item;
  try {
    item = await fetchSentence(i);
  } catch (e) {
    if (!current() || e.name === "AbortError" || e.code === "stale") return;
    s.errored = true;
    readerEmit({ type: "state", state: "error", index: i, error: e.message });
    return;
  }
  if (!current() || s.paused) return; // superseded, or paused while loading (resume() restarts it)
  const c = ctx();
  if (c.state === "suspended") {
    await c.resume();
    if (!current() || s.paused) return;
  }
  const src = c.createBufferSource();
  src.buffer = item.buffer;
  src.connect(c.destination);
  src.onended = () => {
    if (myGen === gen && S === s && s.source === src) {
      s.source = null;
      play(s.index + 1);
    }
  };
  s.source = src;
  s.words = item.words;
  s.startedAt = c.currentTime + 0.02;
  src.start(s.startedAt);
  readerEmit({ type: "sentence", index: i, words: item.words, at: sentenceEpoch() });
  readerEmit({ type: "state", state: "playing", index: i });
}

function seek(i) {
  if (!S) return;
  stopSource();
  invalidate(true);
  S.paused = false;
  return play(Math.max(0, Math.min(i, S.sentences.length - 1)));
}

async function pause() {
  if (!S || S.paused) return;
  S.paused = true;
  if (S.source) await ctx().suspend();
  readerEmit({ type: "state", state: "paused", index: S.index });
}

async function resume() {
  if (!S) return;
  if (!S.source) {
    S.paused = false;
    return play(S.index);
  }
  if (!S.paused) return;
  S.paused = false;
  await ctx().resume();
  readerEmit({ type: "sentence", index: S.index, words: S.words, at: sentenceEpoch() });
  readerEmit({ type: "state", state: "playing", index: S.index });
}

async function stop(port) {
  if (!S || (port !== undefined && port !== S.port)) return;
  stopSource();
  invalidate(false);
  S = null;
  if (audioCtx?.state === "suspended") await audioCtx.resume();
}

function onReaderMessage(msg) {
  switch (msg.type) {
    case "load":
      newSession(msg);
      return play(msg.start);
    case "pause":
      return pause();
    case "resume":
      return resume();
    case "toggle":
      return S?.paused || S?.errored ? resume() : pause();
    case "seek":
      return seek(msg.index);
    case "settings": {
      if (!S) return;
      if (msg.voice) S.voice = msg.voice;
      if (msg.speed) S.speed = msg.speed;
      const wasPaused = S.paused;
      stopSource();
      invalidate(false);
      if (wasPaused) {
        // Re-render the current sentence on resume with the new settings.
        if (audioCtx?.state === "suspended") audioCtx.resume();
        return;
      }
      return play(S.index);
    }
    case "stop":
      return stop(msg.port);
  }
}

// ---------- dictation ----------
// The page target ({tabId, frameId}) travels with the recording and is echoed
// on every event, so routing survives a service-worker restart.

const MIC_SR = 16000;
const SILENCE_STOP_MS = 2500;
const NO_SPEECH_STOP_MS = 8000;
const MAX_MS = 4 * 60 * 1000; // stays under the server's 20 MB WAV limit
let rec = null;
let starting = null; // {cancelled, route} while the mic is opening
let transcribing = 0;

function dictateEmit(route, msg) {
  emit("dictate", null, { ...msg, route });
}

async function micGranted() {
  try {
    return (await navigator.permissions.query({ name: "microphone" })).state === "granted";
  } catch {
    return true; // let getUserMedia decide
  }
}

async function startDictation(route) {
  if (rec || starting) return;
  const st = (starting = { cancelled: false, route });
  let stream = null;
  let mic = null;
  const release = () => {
    stream?.getTracks().forEach((t) => t.stop());
    mic?.close().catch(() => {});
  };
  try {
    if (!(await micGranted())) return dictateEmit(route, { state: "error", error: "mic-permission" });
    if (st.cancelled) return dictateEmit(route, { state: "done", text: "" });
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      mic = new AudioContext();
      await mic.audioWorklet.addModule("mic-worklet.js");
    } catch {
      release();
      return dictateEmit(route, { state: "error", error: "mic-permission" });
    }
    if (st.cancelled) {
      release();
      return dictateEmit(route, { state: "done", text: "" });
    }
    const node = new AudioWorkletNode(mic, "mic-tap");
    mic.createMediaStreamSource(stream).connect(node);
    const started = performance.now();
    const r = { route, stream, mic, node, chunks: [], heardSpeech: false, lastLoud: started, started, noiseFloor: 0.005 };
    rec = r;
    node.port.onmessage = ({ data }) => {
      if (rec !== r) return;
      r.chunks.push(data);
      let sum = 0;
      for (let k = 0; k < data.length; k++) sum += data[k] * data[k];
      const rms = Math.sqrt(sum / data.length);
      const now = performance.now();
      // Calibrate on the first 300 ms, but never let a loud block (speech) raise the floor much.
      if (now - r.started < 300) r.noiseFloor = Math.min(0.03, Math.max(r.noiseFloor, Math.min(rms, r.noiseFloor * 2)));
      if (rms > Math.max(0.02, r.noiseFloor * 2.5)) {
        r.heardSpeech = true;
        r.lastLoud = now;
      }
      const elapsed = now - r.started;
      if ((r.heardSpeech && now - r.lastLoud > SILENCE_STOP_MS) || (!r.heardSpeech && elapsed > NO_SPEECH_STOP_MS) || elapsed > MAX_MS) {
        stopDictation();
      }
    };
    dictateEmit(route, { state: "listening" });
  } finally {
    if (starting === st) starting = null;
  }
}

async function stopDictation({ user = false } = {}) {
  if (!rec) {
    if (starting) starting.cancelled = true;
    return;
  }
  const r = rec;
  rec = null;
  r.node.port.onmessage = null;
  r.stream.getTracks().forEach((t) => t.stop());
  const inputRate = r.mic.sampleRate;
  r.mic.close().catch(() => {});
  // An explicit "Done" after real recording time is sent even if our level
  // detector missed the speech; the server decides whether anything was said.
  const longEnough = performance.now() - r.started > 600;
  if (!r.heardSpeech && !(user && longEnough)) return dictateEmit(r.route, { state: "done", text: "" });
  transcribing++;
  dictateEmit(r.route, { state: "transcribing" });
  try {
    const samples = concat(r.chunks);
    const pcm16k = await resample(samples, inputRate, MIC_SR);
    const out = await call("/stt", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav(pcm16k, MIC_SR) });
    dictateEmit(r.route, { state: "done", text: out.text });
  } catch (e) {
    dictateEmit(r.route, { state: "error", error: e.message });
  } finally {
    transcribing--;
  }
}

function concat(chunks) {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

async function resample(samples, from, to) {
  if (from === to) return samples;
  const length = Math.ceil((samples.length * to) / from);
  const off = new OfflineAudioContext(1, length, to);
  const buf = off.createBuffer(1, samples.length, from);
  buf.copyToChannel(samples, 0);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0);
}

function wav(samples, sr) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (o, s) => [...s].forEach((ch, k) => view.setUint8(o + k, ch.charCodeAt(0)));
  str(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let k = 0; k < samples.length; k++) {
    const v = Math.max(-1, Math.min(1, samples[k]));
    view.setInt16(44 + k * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return view.buffer;
}

// ---------- clipboard ----------

function copy(text) {
  const ta = document.getElementById("clip");
  ta.value = text;
  ta.select();
  const ok = document.execCommand("copy");
  ta.value = "";
  return ok;
}

// ---------- router (service worker only) ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "offscreen" || sender.url !== BACKGROUND_URL) return false;
  if (msg.token !== undefined) token = msg.token;
  switch (msg.type) {
    case "busy?":
      sendResponse(!!(S || rec || starting || transcribing));
      return false;
    case "dictating?":
      sendResponse(!!(rec || starting));
      return false;
    case "dictate-start":
      startDictation(msg.route);
      break;
    case "dictate-stop":
      stopDictation({ user: true });
      break;
    case "copy":
      sendResponse(copy(msg.text));
      return false;
    case "token":
      break;
    default:
      onReaderMessage(msg);
  }
  sendResponse(true);
  return false;
});
