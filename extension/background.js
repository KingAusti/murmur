// Murmur service worker: routes messages between reader contexts (content
// scripts / extension pages), the offscreen audio document, and the server.
// See docs/ARCHITECTURE.md for the protocol.

importScripts("lib/segment.js", "lib/normalize.js");

const SERVER = "http://127.0.0.1:47811";
const OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");
const VIEWER_URL = chrome.runtime.getURL("pdfjs/web/viewer.html");
const IDLE_MINUTES = 5;
const DEFAULTS = { voice: "af_heart", speed: 1.0, skipCitations: true, altClick: true, openPdfs: true };
const READER_FILES = ["lib/segment.js", "lib/normalize.js", "lib/align.js", "content/reader.js", "content/player.js"];
const DICTATE_FILES = ["content/dictate.js"];

// ---------- settings & token ----------

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(Object.keys(DEFAULTS))) };
}

async function currentToken() {
  return (await chrome.storage.local.get("token")).token || "";
}

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

// ---------- offscreen document ----------

let creating = null;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [OFFSCREEN_URL],
  });
  if (!existing.length) {
    creating ??= chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ["AUDIO_PLAYBACK", "USER_MEDIA", "CLIPBOARD"],
        justification: "Play synthesized speech, record dictation, and copy dictated text.",
      })
      .catch((e) => {
        if (!String(e).includes("single offscreen")) throw e;
      })
      .finally(() => (creating = null));
    await creating;
  }
  chrome.alarms.create("offscreen-idle", { delayInMinutes: IDLE_MINUTES });
}

// Every message carries the current token, so a re-pair takes effect immediately.
async function toOffscreen(msg) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: "offscreen", token: await currentToken(), ...msg });
}

async function offscreenExists() {
  return (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }).catch(() => [])).length > 0;
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "offscreen-idle") return;
  if (!(await offscreenExists())) return;
  const busy = await chrome.runtime.sendMessage({ target: "offscreen", type: "busy?" }).catch(() => false);
  if (busy) chrome.alarms.create("offscreen-idle", { delayInMinutes: IDLE_MINUTES });
  else chrome.offscreen.closeDocument().catch(() => {});
});

// ---------- reader ports ----------
// Each reader context opens a "murmur-reader" port. Only one session plays at a time.

const ports = new Map(); // id -> {port, tabId, frameId}
let nextPortId = 1;
let active = null; // port id of the session currently loaded in the offscreen doc
let headless = null; // {tabId} when reading text without a page reader (e.g. native PDF viewer)

function post(id, msg) {
  try {
    ports.get(id)?.port.postMessage(msg);
  } catch {
    ports.delete(id);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "murmur-reader") return;
  const id = nextPortId++;
  ports.set(id, { port, tabId: port.sender?.tab?.id, frameId: port.sender?.frameId ?? 0 });

  port.onMessage.addListener(async (msg) => {
    if (msg.type === "load") {
      if (active && active !== id) post(active, { type: "state", state: "stopped" });
      active = id;
      headless = null;
      const s = await settings();
      await toOffscreen({
        type: "load",
        port: id,
        sentences: msg.sentences,
        start: msg.start ?? 0,
        voice: msg.voice ?? s.voice,
        speed: msg.speed ?? s.speed,
      });
    } else if (active === id) {
      await toOffscreen({ ...msg, port: id });
    }
  });

  port.onDisconnect.addListener(() => {
    ports.delete(id);
    if (active === id) {
      active = null;
      toOffscreen({ type: "stop", port: id }).catch(() => {});
    }
  });
});

// Read plain text with no page highlighting (context menu on pages we can't script).
async function readHeadless(text, tabId) {
  const s = await settings();
  const sentences = Murmur.segment
    .splitSentences(text)
    .map(({ start, end }) => Murmur.normalize.normalize(text.slice(start, end), s).spoken)
    .filter(Boolean);
  if (!sentences.length) return;
  if (active) post(active, { type: "state", state: "stopped" });
  active = 0; // 0 = headless session (no port)
  headless = { tabId };
  await toOffscreen({ type: "load", port: 0, sentences, start: 0, voice: s.voice, speed: s.speed });
}

// ---------- tab messaging ----------

// Without the "tabs" permission tab.url is hidden for our own pages, so ask
// the runtime whether this tab hosts one of our extension pages.
async function isExtensionTab(tabId) {
  const c = await chrome.runtime.getContexts({ contextTypes: ["TAB"], tabIds: [tabId] }).catch(() => []);
  return c.length > 0;
}

async function sendToFrame(tabId, frameId, msg) {
  if (await isExtensionTab(tabId)) return chrome.runtime.sendMessage({ ...msg, __tab: tabId }).catch(() => undefined);
  return chrome.tabs.sendMessage(tabId, msg, { frameId }).catch(() => undefined);
}

async function frameIds(tabId) {
  if (await isExtensionTab(tabId)) return [0];
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
  return frames?.length ? frames.map((f) => f.frameId) : [0];
}

// Ask every frame something; returns [{frameId, res}] for frames that answered.
async function probeFrames(tabId, msg) {
  const ids = await frameIds(tabId);
  const answers = await Promise.all(ids.map(async (frameId) => ({ frameId, res: await sendToFrame(tabId, frameId, msg) })));
  return answers.filter((a) => a.res);
}

async function injectReader(tabId, frameId, files) {
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files });
}

// ---------- commands ----------

async function readCommand(tab) {
  if (!tab?.id) return;
  const a = active ? ports.get(active) : null;
  if (a && a.tabId === tab.id) return toOffscreen({ type: "toggle", port: active });
  if (active === 0 && headless?.tabId === tab.id) return toOffscreen({ type: "toggle", port: 0 });

  const answers = await probeFrames(tab.id, { type: "probe" });
  if (!answers.length) {
    if (/\.pdf($|[?#])/i.test(tab.url || "")) return openPdfViewer(tab);
    return { restricted: true }; // chrome://, the Web Store, other extensions' pages, …
  }
  const withSel = answers.find((a) => a.res.selection && a.res.focused) || answers.find((a) => a.res.selection);
  const target = withSel || answers.find((a) => a.frameId === 0) || answers[0];
  await sendToFrame(tab.id, target.frameId, { type: "cmd", cmd: withSel ? "read-selection" : "read-page" });
}

async function openReaderView(tab) {
  if (!tab?.id || (await isExtensionTab(tab.id))) return;
  chrome.tabs.create({ url: chrome.runtime.getURL(`reader/reader.html?tab=${tab.id}`), index: tab.index + 1 });
}

function openPdfViewer(tab) {
  chrome.tabs.update(tab.id, { url: `${VIEWER_URL}?file=${encodeURIComponent(tab.url)}` });
}

// ---------- dictation ----------
// The target frame travels with the recording through the offscreen doc (and
// is mirrored to session storage), so nothing is lost if this worker restarts.

async function dictateCommand(tab) {
  if ((await offscreenExists()) && (await toOffscreen({ type: "dictating?" }).catch(() => false))) {
    return toOffscreen({ type: "dictate-stop" });
  }
  if (!tab?.id) return;
  const answers = await probeFrames(tab.id, { type: "probe" });
  if (!answers.length) return { restricted: true };
  // hasFocus() is true for the focused frame and its ancestors; frames come parents-first.
  const focused = answers.filter((a) => a.res.focused);
  const target =
    focused.find((a) => a.res.editable) ||
    focused.at(-1) ||
    answers.find((a) => a.res.editable) ||
    answers.find((a) => a.frameId === 0);
  const route = { tabId: tab.id, frameId: target ? target.frameId : null };
  await chrome.storage.session.set({ dictation: route });
  if (target) await sendToFrame(tab.id, target.frameId, { type: "dictate", state: "starting" });
  await toOffscreen({ type: "dictate-start", route });
}

async function onDictateEvent(msg) {
  const route = msg.route || (await chrome.storage.session.get("dictation")).dictation;
  if (!route) return;
  const { tabId, frameId } = route;
  if (msg.state === "done" || msg.state === "error") chrome.storage.session.remove("dictation");
  if (msg.state === "error" && msg.error === "mic-permission") {
    chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html#mic") });
  }
  let inserted = false;
  if (frameId !== null) {
    const res = await sendToFrame(tabId, frameId, { type: "dictate", ...msg });
    inserted = !!res?.inserted;
  }
  if (msg.state === "done" && msg.text && !inserted) {
    await toOffscreen({ type: "copy", text: msg.text });
    if (frameId !== null) await sendToFrame(tabId, frameId, { type: "dictate", state: "copied", text: msg.text });
  }
}

// ---------- runtime messages ----------

const EXT_PAGE_PREFIX = chrome.runtime.getURL("");
// Messages content scripts may send; everything else must come from our own pages.
const CONTENT_ALLOWED = new Set(["inject", "tab-id", "dictate-stop", "status"]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === "offscreen" || sender.id !== chrome.runtime.id) return false;

  if (msg.from === "offscreen") {
    if (sender.url !== OFFSCREEN_URL) return false;
    if (msg.kind === "reader") {
      if (msg.port === 0) {
        if (["ended", "stopped", "error"].includes(msg.msg?.state)) {
          headless = null;
          if (active === 0) {
            active = null;
            if (msg.msg.state !== "stopped") toOffscreen({ type: "stop", port: 0 }).catch(() => {});
          }
        }
      } else post(msg.port, msg.msg);
    } else if (msg.kind === "dictate") onDictateEvent(msg.msg);
    else if (msg.kind === "unauthorized") pair();
    return false; // "keepalive" just wakes us
  }

  const fromExtPage = !sender.tab || (sender.url || "").startsWith(EXT_PAGE_PREFIX);
  if (!fromExtPage && !CONTENT_ALLOWED.has(msg.type)) return false;

  const handlers = {
    inject: () =>
      sender.tab ? injectReader(sender.tab.id, sender.frameId, msg.what === "dictate" ? DICTATE_FILES : READER_FILES).then(() => true) : false,
    "reader-fetch": () => fetchPageForReader(msg.tab),
    "open-reader-view": async () => openReaderView(await chrome.tabs.get(msg.tab)),
    "open-pdf": async () => openPdfViewer(await chrome.tabs.get(msg.tab)),
    "read-tab": async () => readCommand(await chrome.tabs.get(msg.tab)),
    "dictate-tab": async () => dictateCommand(await chrome.tabs.get(msg.tab)),
    "dictate-stop": () => toOffscreen({ type: "dictate-stop" }),
    "stop-all": async () => {
      if (active) post(active, { type: "state", state: "stopped" });
      active = null;
      headless = null;
      return toOffscreen({ type: "stop" });
    },
    status: async () => ({ ...(await serverStatus()), reading: active !== null }),
    pair: () => pair(),
    "tab-id": async () => sender.tab?.id ?? null,
  };
  const h = handlers[msg.type];
  if (!h) return false;
  Promise.resolve(h())
    .then(sendResponse)
    .catch((e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});

async function serverStatus() {
  const { token } = await chrome.storage.local.get("token");
  try {
    const r = await fetch(`${SERVER}/health`, { signal: AbortSignal.timeout(2000) });
    const h = await r.json();
    return { server: true, paired: !!token, ...h };
  } catch {
    return { server: false, paired: !!token };
  }
}

async function fetchPageForReader(tabId) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({ html: document.documentElement.outerHTML, url: location.href, title: document.title }),
  });
  return res?.result;
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "read") readCommand(tab);
  else if (command === "reader-view") openReaderView(tab);
  else if (command === "dictate") dictateCommand(tab);
});

// ---------- context menu ----------

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "murmur-read") {
    const res = tab?.id >= 0 ? await sendToFrame(tab.id, info.frameId ?? 0, { type: "cmd", cmd: "read-selection" }) : undefined;
    if (!res && info.selectionText) readHeadless(info.selectionText, tab?.id);
  } else if (info.menuItemId === "murmur-from-here") {
    sendToFrame(tab.id, info.frameId ?? 0, { type: "cmd", cmd: "read-from-context" });
  } else if (info.menuItemId === "murmur-reader-view") openReaderView(tab);
});

// ---------- PDFs ----------
// Redirect PDF navigations to our pdf.js viewer (pattern from mozilla/pdf.js
// extensions/chromium/pdfHandler.js). Downloads (Content-Disposition: attachment) are left alone.

const PDF_RULE_ID = 1;

async function syncPdfRules() {
  const { openPdfs } = await settings();
  const addRules = openPdfs
    ? [
        {
          id: PDF_RULE_ID,
          priority: 1,
          action: { type: "redirect", redirect: { regexSubstitution: `${VIEWER_URL}?file=\\0` } },
          condition: {
            regexFilter: "^(https?|ftp)://.*$",
            resourceTypes: ["main_frame"],
            excludedRequestMethods: ["post"],
            responseHeaders: [{ header: "content-type", values: ["application/pdf", "application/pdf;*"] }],
            excludedResponseHeaders: [{ header: "content-disposition", values: ["attachment*"] }],
          },
        },
      ]
    : [];
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [PDF_RULE_ID], addRules });
}

// Local file:// PDFs (needs "Allow access to file URLs").
chrome.webNavigation.onBeforeNavigate.addListener(
  async (d) => {
    if (d.frameId !== 0 || !(await settings()).openPdfs) return;
    chrome.tabs.update(d.tabId, { url: `${VIEWER_URL}?file=${encodeURIComponent(d.url)}` });
  },
  { url: [{ urlPrefix: "file://", pathSuffix: ".pdf" }, { urlPrefix: "file://", pathSuffix: ".PDF" }] },
);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && "openPdfs" in changes) syncPdfRules();
});

// ---------- install ----------

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "murmur-read", title: "Read with Murmur", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "murmur-from-here", title: "Read from here", contexts: ["page", "link"] });
    chrome.contextMenus.create({ id: "murmur-reader-view", title: "Open in Murmur Reader view", contexts: ["page"] });
  });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  setupMenus();
  await syncPdfRules();
  if (reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
});

chrome.runtime.onStartup.addListener(syncPdfRules);
