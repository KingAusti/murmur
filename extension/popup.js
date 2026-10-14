// Murmur toolbar popup: status, quick actions, and settings.
const $ = (id) => document.getElementById(id);
const DEFAULTS = { voice: "af_heart", speed: 1.0, skipCitations: true, altClick: true, openPdfs: true };

let tab = null;

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const s = await chrome.storage.sync.get(DEFAULTS);
  $("speed").value = s.speed;
  $("speedOut").textContent = `${(+s.speed).toFixed(2).replace(/0$/, "")}×`;
  for (const k of ["skipCitations", "altClick", "openPdfs"]) $(k).checked = s[k];
  fillVoices({ af_heart: "Heart (US, warm)" }, s.voice);
  $("openPdf").hidden = !/\.pdf($|[?#])/i.test(tab?.url || "") || tab.url.startsWith(chrome.runtime.getURL(""));
  refreshStatus(s.voice);
}

function fillVoices(voices, current) {
  const sel = $("voice");
  sel.replaceChildren(
    ...Object.entries(voices).map(([id, label]) => {
      const o = document.createElement("option");
      o.value = id;
      o.textContent = label;
      o.selected = id === current;
      return o;
    }),
  );
}

async function refreshStatus(voice) {
  const st = await chrome.runtime.sendMessage({ type: "status" }).catch(() => null);
  const el = $("status");
  const dot = (cls, text) => {
    el.replaceChildren(Object.assign(document.createElement("span"), { className: `dot ${cls}` }), ` ${text}`);
  };
  $("connect").hidden = true;
  if (!st?.server) dot("bad", "Server not running");
  else if (!st.paired) {
    dot("wait", "Not connected");
    $("connect").hidden = false;
  } else if (st.tts_error) dot("bad", "Voice failed to load");
  else if (!st.tts_ready) dot("wait", "Voice loading…");
  else dot("ok", "Ready · on-device");
  if (st?.voices) fillVoices(st.voices, voice || $("voice").value);
  $("stop").hidden = !st?.reading;
}

async function send(type) {
  const r = await chrome.runtime.sendMessage({ type, tab: tab.id }).catch(() => null);
  if (r?.restricted) {
    const el = $("status");
    el.replaceChildren(Object.assign(document.createElement("span"), { className: "dot bad" }), " Browsers don't let extensions read or type on this page.");
    return;
  }
  window.close();
}

$("read").onclick = () => send("read-tab");
$("readerView").onclick = () => send("open-reader-view");
$("dictate").onclick = () => send("dictate-tab");
$("openPdf").onclick = () => send("open-pdf");
$("stop").onclick = () => chrome.runtime.sendMessage({ type: "stop-all" }).finally(() => window.close());
$("connect").onclick = async () => {
  const ok = await chrome.runtime.sendMessage({ type: "pair" });
  if (!ok) return chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html#connect") });
  refreshStatus();
};

$("voice").onchange = (e) => chrome.storage.sync.set({ voice: e.target.value });
$("speed").oninput = (e) => {
  $("speedOut").textContent = `${(+e.target.value).toFixed(2).replace(/0$/, "")}×`;
};
$("speed").onchange = (e) => chrome.storage.sync.set({ speed: +e.target.value });
for (const k of ["skipCitations", "altClick", "openPdfs"]) $(k).onchange = (e) => chrome.storage.sync.set({ [k]: e.target.checked });

init();
