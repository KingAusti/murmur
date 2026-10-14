// Murmur dictation (page side): remembers where you were typing, shows a
// small "listening" pill, and inserts the transcript there when it arrives.
(() => {
  const M = (globalThis.Murmur = globalThis.Murmur || {});
  if (M.dictate) return;

  const CSS = `
    :host { all: initial; }
    .pill {
      position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 2147483647;
      display: flex; align-items: center; gap: 10px; padding: 8px 10px 8px 14px; border-radius: 999px;
      font: 500 13px/1.2 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      color: #f5f5f7; background: rgba(28,28,30,.9); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
      box-shadow: 0 8px 30px rgba(0,0,0,.25); animation: rise .2s cubic-bezier(.2,.8,.2,1);
    }
    @keyframes rise { from { opacity: 0; transform: translate(-50%, 8px); } }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #ff453a; animation: pulse 1.2s ease-in-out infinite; }
    .dot.busy { background: #ff9f0a; }
    .dot.ok { background: #30d158; animation: none; }
    @keyframes pulse { 50% { transform: scale(.7); opacity: .6; } }
    button { all: unset; cursor: pointer; padding: 4px 10px; border-radius: 999px; background: rgba(255,255,255,.14); }
    button:hover { background: rgba(255,255,255,.22); }
    button:focus-visible { outline: 2px solid #ff9f0a; }
    kbd { font: inherit; opacity: .7; }
  `;

  let target = null; // {el, start, end} — where to insert
  let host = null;
  let root = null;
  let hideTimer = 0;

  function ensureHost() {
    if (host?.isConnected) return;
    host = document.createElement("murmur-dictate");
    host.setAttribute("data-murmur-ui", "");
    root = host.attachShadow({ mode: "closed" });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement("style");
      style.textContent = CSS;
      root.append(style);
    }
    document.documentElement.append(host);
  }

  function pill(text, { dot = "", stop = false, ms = 0 } = {}) {
    ensureHost();
    clearTimeout(hideTimer);
    root.querySelector(".pill")?.remove();
    const p = document.createElement("div");
    p.className = "pill";
    p.setAttribute("role", "status");
    const d = document.createElement("span");
    d.className = `dot ${dot}`;
    const label = document.createElement("span");
    label.textContent = text;
    p.append(d, label);
    if (stop) {
      const b = document.createElement("button");
      b.textContent = "Done";
      b.title = "Stop dictation (⌥⇧D)";
      b.addEventListener("click", () => chrome.runtime.sendMessage({ type: "dictate-stop" }));
      p.append(b);
    }
    root.append(p);
    if (ms) hideTimer = setTimeout(() => p.remove(), ms);
  }

  function hide() {
    root?.querySelector(".pill")?.remove();
  }

  function remember() {
    const el = M.deepActive?.();
    if (!M.isEditable?.(el)) return (target = null);
    target = { el };
    if ("selectionStart" in el && el.selectionStart !== null) {
      target.start = el.selectionStart;
      target.end = el.selectionEnd;
    } else {
      const sel = el.getRootNode().getSelection?.() || getSelection();
      if (sel?.rangeCount) target.range = sel.getRangeAt(0).cloneRange();
    }
  }

  function snapshot(el) {
    return el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? el.value : el.textContent;
  }

  // Leading space when continuing a sentence; nothing at the start of a field.
  function withSpacing(el, text) {
    let before = "";
    if ("selectionStart" in el && el.selectionStart !== null) before = el.value.slice(0, el.selectionStart);
    else {
      const sel = getSelection();
      if (sel?.rangeCount) {
        const r = sel.getRangeAt(0).cloneRange();
        r.collapse(true);
        r.setStart(el, 0);
        before = r.toString();
      }
    }
    return before && !/\s$/.test(before) && !/^[,.;:!?)]/.test(text) ? ` ${text}` : text;
  }

  function insert(text) {
    const t = target;
    if (!t?.el?.isConnected) return false;
    const el = t.el;
    el.focus({ preventScroll: true });
    if (t.start !== undefined && "setSelectionRange" in el) {
      try {
        el.setSelectionRange(t.start, t.end);
      } catch {}
    } else if (t.range) {
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(t.range);
    }
    const before = snapshot(el);
    // insertText keeps the editor's undo stack and fires the input events frameworks listen to.
    const ok = document.execCommand("insertText", false, withSpacing(el, text));
    if (/(^|\.)docs\.google\.com$/.test(location.hostname)) return ok;
    return ok && snapshot(el) !== before;
  }

  function handle(msg) {
    switch (msg.state) {
      case "starting":
        remember();
        pill("Starting microphone…", { dot: "busy" });
        return {};
      case "listening":
        pill("Listening…", { stop: true });
        return {};
      case "transcribing":
        pill("Transcribing…", { dot: "busy" });
        return {};
      case "done": {
        if (!msg.text) {
          pill("Didn't catch that.", { dot: "busy", ms: 2200 });
          return { inserted: true }; // nothing to copy
        }
        const inserted = insert(msg.text);
        if (inserted) pill("Inserted", { dot: "ok", ms: 1200 });
        return { inserted };
      }
      case "copied":
        pill(target ? "Couldn't type here. Copied, so press ⌘V to paste." : "Copied. Press ⌘V to paste.", { dot: "ok", ms: 4000 });
        return {};
      case "error":
        pill(
          msg.error === "mic-permission" ? "Microphone access needed. Finish setup in the tab that just opened." : msg.error || "Dictation failed.",
          { dot: "busy", ms: 5000 },
        );
        return {};
    }
    hide();
    return {};
  }

  M.dictate = { handle };
})();
