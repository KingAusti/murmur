// Murmur player: a small floating control bar in a closed shadow root, so
// page CSS can't touch it and it can't touch the page.
(() => {
  const M = (globalThis.Murmur = globalThis.Murmur || {});
  if (M.player) return;

  const SPEEDS = [0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6];
  const FALLBACK_VOICES = {
    af_heart: "Heart (US, warm)",
    af_bella: "Bella (US, bright)",
    am_michael: "Michael (US, male)",
    bf_emma: "Emma (UK)",
    bm_george: "George (UK, male)",
  };

  // SVG path data; DOM is built with createElement (no innerHTML: pages with
  // Trusted Types would reject it).
  const ICON = {
    play: "M8 5.5v13a1 1 0 0 0 1.5.86l10.2-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z",
    pause: "M7.7 5h1.6c.66 0 1.2.54 1.2 1.2v11.6c0 .66-.54 1.2-1.2 1.2H7.7c-.66 0-1.2-.54-1.2-1.2V6.2c0-.66.54-1.2 1.2-1.2zm7 0h1.6c.66 0 1.2.54 1.2 1.2v11.6c0 .66-.54 1.2-1.2 1.2h-1.6c-.66 0-1.2-.54-1.2-1.2V6.2c0-.66.54-1.2 1.2-1.2z",
    prev: "M6 6h2v12H6zM19 6.9v10.2a.9.9 0 0 1-1.38.76L10 13a1.2 1.2 0 0 1 0-2l7.62-4.86A.9.9 0 0 1 19 6.9z",
    next: "M16 6h2v12h-2zM5 6.9v10.2a.9.9 0 0 0 1.38.76L14 13a1.2 1.2 0 0 0 0-2L6.38 6.14A.9.9 0 0 0 5 6.9z",
    close: "M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z",
  };
  const SVG_NS = "http://www.w3.org/2000/svg";

  function h(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "text") n.textContent = v;
      else n.setAttribute(k, v);
    }
    n.append(...children.filter(Boolean));
    return n;
  }

  function icon(name) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", ICON[name]);
    svg.append(path);
    return svg;
  }

  function setIcon(button, name) {
    button.replaceChildren(icon(name));
  }

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap {
      position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
      font: 500 13px/1.2 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
      color: var(--fg); --fg: #1d1d1f; --muted: #6e6e73; --bg: rgba(255,255,255,.86); --line: rgba(0,0,0,.08);
      --accent: #ff9f0a; --chip: rgba(0,0,0,.05); --chip-hover: rgba(0,0,0,.09);
      animation: rise .22s cubic-bezier(.2,.8,.2,1);
    }
    @media (prefers-color-scheme: dark) {
      .wrap { --fg: #f5f5f7; --muted: #a1a1a6; --bg: rgba(30,30,32,.86); --line: rgba(255,255,255,.1);
              --chip: rgba(255,255,255,.08); --chip-hover: rgba(255,255,255,.14); }
    }
    @keyframes rise { from { opacity: 0; transform: translateY(8px) scale(.98); } }
    .bar {
      display: flex; align-items: center; gap: 6px; padding: 6px 8px 6px 6px;
      background: var(--bg); backdrop-filter: saturate(180%) blur(20px); -webkit-backdrop-filter: saturate(180%) blur(20px);
      border: 1px solid var(--line); border-radius: 999px;
      box-shadow: 0 8px 30px rgba(0,0,0,.14), 0 1px 3px rgba(0,0,0,.08);
    }
    button {
      all: unset; cursor: pointer; display: grid; place-items: center; border-radius: 999px; color: var(--fg);
      transition: background .15s, transform .1s;
    }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    button:active { transform: scale(.94); }
    .icon { width: 32px; height: 32px; }
    .icon:hover { background: var(--chip-hover); }
    .icon svg { width: 18px; height: 18px; fill: currentColor; }
    .main { width: 40px; height: 40px; background: var(--fg); color: var(--bg); }
    .main svg { width: 20px; height: 20px; fill: currentColor; }
    .main:hover { opacity: .88; }
    .main.loading { animation: pulse 1.1s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: .45; } }
    .chip { height: 28px; padding: 0 10px; background: var(--chip); font-variant-numeric: tabular-nums; }
    .chip:hover { background: var(--chip-hover); }
    .meta { display: flex; flex-direction: column; gap: 4px; min-width: 64px; padding: 0 4px; }
    .count { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .track { height: 3px; border-radius: 3px; background: var(--chip-hover); overflow: hidden; }
    .fill { height: 100%; width: 0; background: var(--accent); transition: width .3s; }
    .sep { width: 1px; height: 20px; background: var(--line); margin: 0 2px; }
    .menu {
      position: absolute; bottom: calc(100% + 8px); right: 0; min-width: 200px; max-height: 320px; overflow: auto;
      padding: 6px; background: var(--bg); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 10px 30px rgba(0,0,0,.16);
    }
    .menu[hidden] { display: none; }
    .menu button { display: flex; justify-content: space-between; width: 100%; padding: 8px 10px; border-radius: 8px; }
    .menu button:hover, .menu button[aria-checked="true"] { background: var(--chip-hover); }
    .menu button[aria-checked="true"]::after { content: "✓"; color: var(--accent); }
    .note {
      position: absolute; bottom: calc(100% + 8px); right: 8px; max-width: 320px; padding: 8px 12px;
      background: var(--bg); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 6px 20px rgba(0,0,0,.12);
      color: var(--fg); font-size: 12.5px; line-height: 1.4;
    }
    .note[hidden] { display: none; }
    .note.error { border-color: rgba(255,59,48,.5); }
    .toast { position: fixed; right: 20px; bottom: 84px; }
    .note.static { position: static; }
  `;

  let host = null;
  let root = null;
  let ctl = null;
  let ui = null;
  let voices = FALLBACK_VOICES;
  let state = { voice: "af_heart", speed: 1.0 };

  function ensureHost() {
    if (host?.isConnected) return;
    host = document.createElement("murmur-player");
    host.setAttribute("data-murmur-ui", "");
    root = host.attachShadow({ mode: "closed" });
    // Constructed stylesheets aren't subject to the page's style-src CSP.
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } catch {
      root.append(h("style", { text: CSS }));
    }
    document.documentElement.append(host);
  }

  function fmtSpeed(s) {
    return `${(+s).toFixed(s % 0.1 === 0 ? 1 : 2).replace(/0$/, "")}×`;
  }

  function mount(controls, init) {
    ctl = controls;
    state = { ...state, ...init };
    ensureHost();
    ui?.wrap.remove();
    const btn = (cls, act, label, ic) => {
      const b = h("button", { class: cls, "data-act": act, "aria-label": label, title: label });
      if (ic) setIcon(b, ic);
      return b;
    };
    const wrap = h(
      "div",
      { class: "wrap", role: "region", "aria-label": "Murmur read-aloud controls" },
      h("div", { class: "note", role: "status", "aria-live": "polite", hidden: "" }),
      h("div", { class: "menu", role: "menu", hidden: "" }),
      h(
        "div",
        { class: "bar" },
        btn("icon", "prev", "Previous sentence (⌥⇧←)", "prev"),
        btn("main", "toggle", "Play/pause (⌥⇧R)", "pause"),
        btn("icon", "next", "Next sentence (⌥⇧→)", "next"),
        h("div", { class: "meta" }, h("span", { class: "count" }), h("div", { class: "track" }, h("div", { class: "fill" }))),
        h("div", { class: "sep" }),
        h("button", { class: "chip", "data-act": "speed", "aria-haspopup": "menu", "aria-expanded": "false", title: "Reading speed" }),
        h("button", { class: "chip", "data-act": "voice", "aria-haspopup": "menu", "aria-expanded": "false", title: "Voice" }),
        btn("icon", "stop", "Stop", "close"),
      ),
    );
    root.append(wrap);
    ui = {
      wrap,
      main: wrap.querySelector(".main"),
      count: wrap.querySelector(".count"),
      fill: wrap.querySelector(".fill"),
      speed: wrap.querySelector('[data-act="speed"]'),
      voice: wrap.querySelector('[data-act="voice"]'),
      menu: wrap.querySelector(".menu"),
      note: wrap.querySelector(".note"),
    };
    renderChips();
    wrap.addEventListener("click", onClick);
    wrap.addEventListener("keydown", onKey);
    chrome.runtime
      .sendMessage({ type: "status" })
      .then((s) => {
        if (s?.voices) {
          voices = s.voices;
          renderChips();
        }
      })
      .catch(() => {});
  }

  function renderChips() {
    if (!ui) return;
    ui.speed.textContent = fmtSpeed(state.speed);
    ui.voice.textContent = (voices[state.voice] || state.voice).split(" (")[0];
  }

  function openMenu(kind) {
    const m = ui.menu;
    if (!m.hidden && m.dataset.kind === kind) return closeMenu();
    m.dataset.kind = kind;
    m.replaceChildren();
    const entries = kind === "speed" ? SPEEDS.map((s) => [s, fmtSpeed(s)]) : Object.entries(voices);
    for (const [value, label] of entries) {
      const b = h("button", { role: "menuitemradio", text: label });
      b.dataset.value = value;
      b.setAttribute("aria-checked", String(String(value) === String(state[kind])));
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        const v = kind === "speed" ? +value : value;
        state[kind] = v;
        renderChips();
        closeMenu(true);
        kind === "speed" ? ctl.setSpeed(v) : ctl.setVoice(v);
      });
      m.append(b);
    }
    m.hidden = false;
    ui.speed.setAttribute("aria-expanded", String(kind === "speed"));
    ui.voice.setAttribute("aria-expanded", String(kind === "voice"));
    const checked = m.querySelector('[aria-checked="true"]') || m.firstElementChild;
    checked?.scrollIntoView({ block: "nearest" });
    checked?.focus();
  }

  function closeMenu(returnFocus) {
    if (!ui) return;
    const kind = ui.menu.dataset.kind;
    ui.menu.hidden = true;
    ui.speed.setAttribute("aria-expanded", "false");
    ui.voice.setAttribute("aria-expanded", "false");
    if (returnFocus && kind) ui[kind]?.focus();
  }

  function onKey(e) {
    if (e.key === "Escape") return closeMenu(true);
    if (ui.menu.hidden || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    const items = [...ui.menu.children];
    const i = items.indexOf(e.target);
    if (i < 0) return;
    e.preventDefault();
    items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
  }

  function onClick(e) {
    const act = e.target.closest("button")?.dataset.act;
    if (!act) return;
    if (act === "speed" || act === "voice") return openMenu(act);
    closeMenu();
    ctl?.[act]?.();
  }

  function update({ state: s, index = 0, total = 0, error, note }) {
    if (!ui) return;
    const playing = s === "playing";
    setIcon(ui.main, playing || s === "loading" ? "pause" : "play");
    ui.main.classList.toggle("loading", s === "loading");
    ui.main.setAttribute("aria-label", playing ? "Pause (⌥⇧R)" : "Play (⌥⇧R)");
    ui.count.textContent = total ? `${Math.min(index + 1, total)} / ${total}` : "";
    ui.fill.style.width = total ? `${((index + 1) / total) * 100}%` : "0";
    if (s === "error") showNote(error || "Something went wrong.", true);
    else if (s === "loading" && note) showNote(note);
    else hideNote();
  }

  function showNote(text, isError) {
    ui.note.setAttribute("role", isError ? "alert" : "status");
    ui.note.textContent = text;
    ui.note.classList.toggle("error", !!isError);
    ui.note.hidden = false;
  }

  function hideNote() {
    if (ui) ui.note.hidden = true;
  }

  function unmount() {
    ui?.wrap.remove();
    ui = null;
    ctl = null;
  }

  let toastTimer = 0;
  function toast(text, ms = 3200) {
    ensureHost();
    root.querySelector(".toast")?.remove();
    const n = h("div", { class: "note static", role: "status", text });
    const t = h("div", { class: "wrap toast" }, n);
    root.append(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), ms);
  }

  M.player = { mount, update, unmount, toast };
})();
