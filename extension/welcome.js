// Murmur onboarding: server check, pairing, mic grant, shortcut check, demo.
const SERVER = "http://127.0.0.1:47811";
const $ = (id) => document.getElementById(id);

function setStep(id, cls, text, { help } = {}) {
  const li = $(id);
  li.classList.remove("ok", "bad", "wait");
  if (cls) li.classList.add(cls);
  if (text !== undefined) li.querySelector(".state").textContent = text;
  const h = li.querySelector(".help");
  if (h && help !== undefined) h.hidden = !help;
}

async function health() {
  try {
    const r = await fetch(`${SERVER}/health`, { signal: AbortSignal.timeout(2000) });
    return await r.json();
  } catch {
    return null;
  }
}

// Pair from this visible page, so a Local Network Access prompt (if any) can appear.
async function pair() {
  try {
    const r = await fetch(`${SERVER}/pair`, { method: "POST" });
    if (!r.ok) return false;
    const { token } = await r.json();
    await chrome.storage.local.set({ token });
    return true;
  } catch {
    return false;
  }
}

async function tokenWorks(token) {
  try {
    const r = await fetch(`${SERVER}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Murmur-Token": token },
      body: JSON.stringify({ text: "Hi." }),
    });
    return r.status !== 401 && r.status !== 403;
  } catch {
    return false;
  }
}

let connected = false;
async function checkServer() {
  const h = await health();
  if (!h) {
    setStep("step-server", "bad", "The Murmur server isn't running yet.", { help: true });
    setStep("step-connect", "", "Waiting for the server…", { help: false });
    connected = false;
  } else {
    const voice = h.tts_error ? `The voice failed to load: ${h.tts_error}` : h.tts_ready ? "Running. The voice is ready." : "Running. The voice is loading (about 5 seconds)…";
    setStep("step-server", h.tts_error ? "bad" : h.tts_ready ? "ok" : "wait", voice, { help: false });
    if (!connected) {
      const { token } = await chrome.storage.local.get("token");
      connected = (token && (await tokenWorks(token))) || (await pair());
      setStep("step-connect", connected ? "ok" : "bad", connected ? "Connected." : "Couldn't pair automatically.", { help: !connected });
    }
  }
  setTimeout(checkServer, h?.tts_ready && connected ? 10000 : 2000);
}

$("copyInstall").onclick = async () => {
  await navigator.clipboard.writeText($("installCmd").textContent);
  $("copyInstall").textContent = "Copied ✓";
};

$("saveToken").onclick = async () => {
  const token = $("token").value.trim();
  if (!token) return;
  if (await tokenWorks(token)) {
    await chrome.storage.local.set({ token });
    connected = true;
    setStep("step-connect", "ok", "Connected.", { help: false });
  } else setStep("step-connect", "bad", "That token didn't work. Check it and try again.", { help: true });
};

async function checkMic() {
  try {
    const p = await navigator.permissions.query({ name: "microphone" });
    const render = () => {
      if (p.state === "granted") setStep("step-mic", "ok");
      else if (p.state === "denied") setStep("step-mic", "bad", "The microphone is blocked for Murmur. Click the icon at the right of the address bar to allow it.");
    };
    render();
    p.onchange = render;
  } catch {}
}

$("allowMic").onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    setStep("step-mic", "ok", "Microphone allowed. Dictation is ready.");
  } catch (e) {
    setStep("step-mic", "bad", `Microphone not available (${e.name}). Check System Settings → Privacy & Security → Microphone → Dia.`);
  }
};

async function checkShortcuts() {
  const cmds = await chrome.commands.getAll();
  const names = { read: "Read selection or page / pause", "reader-view": "Reader view", dictate: "Dictate (start/stop)" };
  const ul = $("shortcuts");
  ul.replaceChildren();
  let missing = 0;
  for (const c of cmds) {
    if (!names[c.name]) continue;
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = names[c.name];
    const key = document.createElement("kbd");
    key.textContent = c.shortcut || "not set";
    if (!c.shortcut) {
      key.className = "unbound";
      missing++;
    }
    li.append(label, key);
    ul.append(li);
  }
  const extra = document.createElement("li");
  extra.innerHTML = "<span>Read from here</span><span><kbd>⌥</kbd> + click</span>";
  const nav = document.createElement("li");
  nav.innerHTML = "<span>Previous / next sentence</span><kbd>⌥⇧← / →</kbd>";
  ul.append(extra, nav);
  setStep(
    "step-keys",
    missing ? "bad" : "ok",
    missing ? "Some shortcuts clash with another app or extension. Choose your own keys." : "All set.",
  );
  $("fixKeys").hidden = !missing;
}
$("fixKeys").onclick = () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" });

$("listen").onclick = () => Murmur.reader.start({ mode: "page", root: $("sample") });

checkServer();
checkMic();
checkShortcuts();
if (location.hash === "#mic") $("step-mic").scrollIntoView({ block: "center" });
