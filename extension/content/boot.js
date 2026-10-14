// Murmur bootstrap: tiny, always-present script (every frame, plus our own
// Reader view / PDF viewer pages). Loads the full reader only on first use.
(() => {
  if (globalThis.__murmurBoot) return;
  globalThis.__murmurBoot = true;
  const M = (globalThis.Murmur = globalThis.Murmur || {});

  const isExtPage = location.protocol === "chrome-extension:";
  let myTab = null; // extension pages: commands arrive via runtime.sendMessage tagged with __tab
  if (isExtPage) chrome.runtime.sendMessage({ type: "tab-id" }).then((id) => (myTab = id), () => {});

  const prefs = { altClick: true };
  chrome.storage.sync.get(["altClick"]).then((s) => Object.assign(prefs, s), () => {});
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === "sync" && c.altClick) prefs.altClick = c.altClick.newValue;
  });

  async function need(what) {
    const loaded = what === "dictate" ? M.dictate : M.reader;
    if (loaded) return loaded;
    if (!isExtPage) await chrome.runtime.sendMessage({ type: "inject", what });
    return what === "dictate" ? M.dictate : M.reader;
  }

  function deepActive() {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  const TEXT_INPUTS = /^(text|search|email|url|tel|password|number|)$/i;
  function isEditable(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === "TEXTAREA") return !el.readOnly && !el.disabled;
    if (el.tagName === "INPUT") return TEXT_INPUTS.test(el.type) && !el.readOnly && !el.disabled;
    return false;
  }
  M.isEditable = isEditable;
  M.deepActive = deepActive;

  // Text selected inside a textarea/input (window selection doesn't see it). Never passwords.
  function controlSelection() {
    const el = deepActive();
    const ok = el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && TEXT_INPUTS.test(el.type) && el.type !== "password"));
    if (!ok) return "";
    const { selectionStart: a, selectionEnd: b } = el;
    return a != null && b > a ? el.value.slice(a, b) : "";
  }
  M.controlSelection = controlSelection;

  // Last right-click position, for the "Read from here" context-menu item.
  let lastContext = null;
  // Only real user input (isTrusted) may drive the reader; pages can't synthesize it.
  const shadowRootsOf = (e) => e.composedPath().filter((n) => n instanceof Element && n.shadowRoot).map((n) => n.shadowRoot);
  addEventListener(
    "contextmenu",
    (e) => {
      if (e.isTrusted) lastContext = { x: e.clientX, y: e.clientY, shadowRoots: shadowRootsOf(e) };
    },
    true,
  );

  function caretAt(x, y, shadowRoots = []) {
    const pos = document.caretPositionFromPoint?.(x, y, { shadowRoots });
    if (pos) return { node: pos.offsetNode, offset: pos.offset };
    const r = document.caretRangeFromPoint?.(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }

  async function readFrom(point) {
    const from = point && caretAt(point.x, point.y, point.shadowRoots);
    if (!from) return;
    if (M.pdf?.isViewer) return M.pdf.readFrom(from.node, from.offset);
    (await need("reader"))?.start({ mode: "from", from });
  }

  // ⌥-click: read from here. Capture phase + preventDefault so the page (and
  // Chromium's ⌥-click-to-download on links) never sees the click.
  addEventListener(
    "click",
    (e) => {
      if (!e.isTrusted || !prefs.altClick || !e.altKey || e.shiftKey || e.metaKey || e.ctrlKey || e.button !== 0) return;
      if (isEditable(e.target) || e.target.closest?.("[data-murmur-ui]")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      readFrom({ x: e.clientX, y: e.clientY, shadowRoots: shadowRootsOf(e) });
    },
    true,
  );

  // ⌥⇧←/→: previous/next sentence while reading (not while typing: that's "select word").
  addEventListener(
    "keydown",
    (e) => {
      if (!e.isTrusted || e.repeat || !M.reader?.isActive() || !e.altKey || !e.shiftKey || e.metaKey || e.ctrlKey) return;
      if (e.code !== "ArrowLeft" && e.code !== "ArrowRight") return;
      if (isEditable(deepActive())) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      e.code === "ArrowLeft" ? M.reader.prev() : M.reader.next();
    },
    true,
  );

  async function onCommand(cmd) {
    if (cmd === "read-from-context") return readFrom(lastContext);
    if (M.pdf?.isViewer && !M.reader?.isActive()) {
      if (cmd === "read-page") return M.pdf.readFromHere();
      if (cmd === "read-selection") return (await M.pdf.readSelection()) || M.pdf.readFromHere();
    }
    const reader = await need("reader");
    if (!reader) return;
    if (cmd === "read-selection") reader.start({ mode: "selection" });
    else if (cmd === "read-page") reader.start({ mode: "page" });
    else if (cmd === "toggle") reader.toggle();
    else if (cmd === "stop") reader.stop();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (isExtPage ? msg.__tab === undefined || msg.__tab !== myTab : msg.__tab !== undefined) return false;
    switch (msg.type) {
      case "probe": {
        const sel = getSelection();
        sendResponse({
          selection: (!!sel && !sel.isCollapsed && sel.toString().trim().length > 0) || controlSelection().trim().length > 0,
          focused: document.hasFocus(),
          editable: isEditable(deepActive()),
          reading: !!M.reader?.isActive(),
        });
        return false;
      }
      case "cmd":
        onCommand(msg.cmd).then(() => sendResponse(true), () => sendResponse(false));
        return true;
      case "dictate":
        need("dictate")
          .then((d) => d?.handle(msg))
          .then((res) => sendResponse(res ?? {}), () => sendResponse({}));
        return true;
    }
    return false;
  });
})();
