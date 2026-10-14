// Murmur reader: turns a DOM region (or any "source") into sentences, sends
// them to the background for synthesis, and highlights the sentence + word
// being spoken. Loaded on demand into pages, statically into extension pages.
(() => {
  const M = (globalThis.Murmur = globalThis.Murmur || {});
  if (M.reader) return;

  // ---------- DOM source ----------

  const SKIP_ALWAYS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "VIDEO", "AUDIO", "IFRAME", "OBJECT", "SELECT", "TEXTAREA", "INPUT", "HEAD"]);
  // Not FORM: quiz questions on LMSes live inside forms (controls are skipped anyway).
  const SKIP_PAGE = new Set(["NAV", "ASIDE", "FOOTER", "HEADER", "BUTTON", "DIALOG", "MENU", "SEARCH"]);
  const INLINE = new Set(["A", "SPAN", "EM", "STRONG", "B", "I", "U", "S", "SUB", "SUP", "CODE", "MARK", "SMALL", "ABBR", "CITE", "Q", "TIME", "LABEL", "FONT", "DFN", "VAR", "KBD", "SAMP", "BDI", "BDO", "WBR", "INS", "DEL", "RUBY", "RT"]);
  const FOOTNOTE_CLASS = /(^|[\s_-])(reference|footnote|fn|cite|citation|noteref)([\s_-]|$)/i;
  const MATH_WRAPPER = ".mwe-math-element, mjx-container, .MathJax, .katex";

  function isFootnoteMarker(el) {
    if (el.tagName !== "SUP") return false;
    if (FOOTNOTE_CLASS.test(el.className) || el.getAttribute("role") === "doc-noteref") return true;
    const a = el.querySelector("a[href^='#']");
    return !!a && el.textContent.trim().length <= 6;
  }

  // Spoken form of a formula: alttext, else TeX annotation, else aria-label.
  function mathSpeech(math, wrapper) {
    let t =
      math?.getAttribute("alttext") ||
      math?.querySelector("annotation[encoding='application/x-tex']")?.textContent ||
      wrapper?.getAttribute("aria-label") ||
      math?.getAttribute("aria-label") ||
      wrapper?.querySelector("img[alt]")?.getAttribute("alt") ||
      "";
    t = t.trim();
    const m = t.match(/^\{\\(?:display|text)style\s*([^]*)\}$/); // MediaWiki wrapper
    if (m) {
      let depth = 0;
      let balanced = true;
      for (const ch of m[1]) {
        depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
        if (depth < 0) balanced = false;
      }
      if (balanced && depth === 0) t = m[1].trim();
    }
    return t || "equation";
  }

  // Builds {text, segs}: a flat string plus a map from flat offsets back to DOM nodes.
  // Text nodes contribute their data 1:1 (newlines/tabs → spaces, same length);
  // block boundaries contribute a virtual "\n\n" with no node.
  function flatten(root, { strict }) {
    const segs = []; // {node, start, len, el?}
    const parts = [];
    let len = 0;
    let tail = ""; // last two chars, so we never rescan the growing text
    const append = (str) => {
      parts.push(str);
      len += str.length;
      tail = (tail + str).slice(-2);
    };
    const push = (str, node, el) => {
      if (node || el) segs.push({ node, el, start: len, len: str.length });
      append(str);
    };
    const breakBlock = () => {
      if (len && tail !== "\n\n") append(tail.endsWith("\n") ? "\n" : "\n\n");
    };
    const children = (el) => {
      if (el.tagName === "SLOT") {
        const assigned = el.assignedNodes({ flatten: true });
        if (assigned.length) return assigned;
      }
      const shadow = el.shadowRoot || (chrome.dom?.openOrClosedShadowRoot?.(el) ?? null);
      return (shadow || el).childNodes;
    };

    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.data) push(node.data.replace(/[\n\r\t\f\v]/g, " "), node);
        return;
      }
      if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        for (const c of node.childNodes) visit(c);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node;
      const tag = el.tagName.toUpperCase();
      if (SKIP_ALWAYS.has(tag) || el.hasAttribute("data-murmur-ui")) return;
      if (strict && (SKIP_PAGE.has(tag) || el.getAttribute("aria-hidden") === "true" || el.hidden)) return;
      if (strict && /^(navigation|search)$/.test(el.getAttribute("role") || "")) return;
      if (isFootnoteMarker(el)) return;
      if (tag === "MATH" || el.matches(MATH_WRAPPER)) {
        push(` ${mathSpeech(tag === "MATH" ? el : el.querySelector("math"), el)} `, null, el);
        return;
      }
      if (tag === "BR") return push(" ", null, el);
      if (tag === "IMG") return;
      const display = getComputedStyle(el).display;
      if (display === "none") return;
      if (strict && display !== "contents" && el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return;
      const block = !INLINE.has(tag) && !/^(inline|contents)/.test(display);
      if (block) breakBlock();
      for (const c of children(el)) visit(c);
      if (block) breakBlock();
    };
    visit(root);
    return { text: parts.join(""), segs };
  }

  function segAt(segs, i, preferEnd) {
    // Binary search for the segment containing flat offset i.
    let lo = 0;
    let hi = segs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = segs[mid];
      if (i < s.start) hi = mid - 1;
      else if (i > s.start + s.len || (i === s.start + s.len && !preferEnd)) lo = mid + 1;
      else return s;
    }
    return segs[Math.min(lo, segs.length - 1)];
  }

  function domPoint(segs, i, isEnd) {
    const s = segAt(segs, i, isEnd);
    if (!s) return null;
    if (s.node) return [s.node, Math.max(0, Math.min(i - s.start, s.len))];
    // Virtual element segment (math, br): snap to the element boundary.
    const r = document.createRange();
    r.selectNode(s.el);
    return isEnd ? [r.endContainer, r.endOffset] : [r.startContainer, r.startOffset];
  }

  function domSource(root, { strict = true } = {}) {
    const { text, segs } = flatten(root, { strict });
    return {
      text,
      segs,
      toRange(start, end) {
        const a = domPoint(segs, start, false);
        const b = domPoint(segs, end, true);
        if (!a || !b || !a[0].isConnected || !b[0].isConnected) return null;
        try {
          const r = document.createRange();
          r.setStart(a[0], a[1]);
          r.setEnd(b[0], b[1]);
          return r;
        } catch {
          return null;
        }
      },
      // Flat offset of a DOM boundary point (for ⌥-click / selections).
      offsetOf(node, offset) {
        for (const s of segs) {
          if (s.node === node) return s.start + Math.min(offset, s.len);
        }
        const point = document.createRange();
        try {
          point.setStart(node, offset);
        } catch {
          return 0;
        }
        // comparePoint throws across shadow trees, so compare against the
        // segment's ancestor that lives in the same tree as the point.
        const pRoot = node.getRootNode();
        for (const s of segs) {
          let n = s.node || s.el;
          while (n && n.getRootNode() !== pRoot) n = n.getRootNode().host;
          if (!n) continue;
          try {
            if (point.comparePoint(n, 0) >= 0) return s.start;
          } catch {}
        }
        return text.length;
      },
    };
  }

  function pickRoot() {
    const own = location.protocol === "chrome-extension:" && document.querySelector("#article");
    if (own) return own;
    const candidates = [...document.querySelectorAll("main, article, [role=main], #content, .content, #main")];
    let best = null;
    let bestLen = 0;
    for (const el of candidates) {
      const len = [...el.querySelectorAll("p, li")].reduce((n, p) => n + p.textContent.length, 0);
      if (len > bestLen * 1.2) {
        best = el;
        bestLen = len;
      }
    }
    return bestLen > 400 ? best : document.body;
  }

  // ---------- sentences ----------

  function buildItems(text, from, to, opts) {
    const slice = text.slice(from, to);
    const items = [];
    for (const { start, end } of M.segment.splitSentences(slice)) {
      const raw = slice.slice(start, end);
      const n = M.normalize.normalize(raw, opts);
      if (!n.spoken) continue;
      items.push({
        start: from + start,
        end: from + end,
        spoken: n.spoken,
        words: n.words.map((w) => ({ text: w.text, srcStart: from + start + w.srcStart, srcEnd: from + start + w.srcEnd })),
      });
    }
    return items;
  }

  // ---------- highlighting ----------

  const hasHighlights = typeof CSS !== "undefined" && CSS.highlights && typeof Highlight === "function";
  const hlSentence = hasHighlights ? new Highlight() : null;
  const hlWord = hasHighlights ? new Highlight() : null;
  if (hasHighlights) {
    hlSentence.priority = 0;
    hlWord.priority = 1;
  }

  let stylesInstalled = false;
  function installStyles() {
    if (stylesInstalled) return;
    stylesInstalled = true;
    // Our own extension pages style the highlights themselves.
    if (location.protocol === "chrome-extension:") return;
    const css = `
      ::highlight(murmur-sentence) { background-color: rgba(255, 214, 102, 0.32); }
      ::highlight(murmur-word) { background-color: rgba(255, 166, 0, 0.55); color: inherit; }
      @media (prefers-color-scheme: dark) {
        ::highlight(murmur-sentence) { background-color: rgba(255, 214, 102, 0.22); }
        ::highlight(murmur-word) { background-color: rgba(255, 176, 32, 0.5); }
      }`;
    // A constructed stylesheet sidesteps the page's style-src CSP.
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } catch {
      const style = document.createElement("style");
      style.textContent = css;
      (document.head || document.documentElement).append(style);
    }
  }

  function showHighlights(on) {
    if (!hasHighlights) return;
    if (on) {
      CSS.highlights.set("murmur-sentence", hlSentence);
      CSS.highlights.set("murmur-word", hlWord);
    } else {
      hlSentence.clear();
      hlWord.clear();
      CSS.highlights.delete("murmur-sentence");
      CSS.highlights.delete("murmur-word");
    }
  }

  // Don't fight the user: skip auto-scroll for a few seconds after they scroll.
  let userScrolledAt = 0;
  for (const ev of ["wheel", "touchmove"]) addEventListener(ev, () => (userScrolledAt = Date.now()), { passive: true, capture: true });
  addEventListener(
    "keydown",
    (e) => {
      if (["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End", "Space"].includes(e.code)) userScrolledAt = Date.now();
    },
    true,
  );

  function keepInView(range) {
    if (Date.now() - userScrolledAt < 4000) return;
    const rect = range.getBoundingClientRect();
    if (!rect.height && !rect.width) return;
    const vh = innerHeight;
    if (rect.top >= 64 && rect.bottom <= vh - 140) return;
    const el = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
    el?.scrollIntoView({ block: rect.height > vh * 0.6 ? "start" : "center", behavior: "smooth" });
  }

  // ---------- session ----------

  let R = null; // {port, source, items, index, state, timing, raf}
  let startGen = 0; // overlapping start() calls: only the newest may connect
  const isExtPage = location.protocol === "chrome-extension:";

  function settings() {
    return chrome.storage.sync
      .get({ voice: "af_heart", speed: 1.0, skipCitations: true })
      .catch(() => ({ voice: "af_heart", speed: 1.0, skipCitations: true }));
  }

  async function start({ mode = "page", root, from, source, startOffset } = {}) {
    if (!M.segment || !M.normalize) throw new Error("Murmur libs not loaded");
    const my = ++startGen;
    stop();
    const s = await settings();
    if (my !== startGen) return;
    let src = source;
    let lo = 0;
    let hi;
    let first = 0;

    const ctl = mode === "selection" ? M.controlSelection?.() : "";
    if (ctl?.trim()) {
      // Selected text inside a textarea/input: read it, no page highlighting.
      src = { text: ctl, toRange: () => null };
    } else if (mode === "selection") {
      const sel = getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return start({ mode: "page" });
      const range = sel.getRangeAt(0);
      let container = range.commonAncestorContainer;
      if (container.nodeType !== Node.ELEMENT_NODE) container = container.parentElement;
      src = domSource(container, { strict: false });
      lo = src.offsetOf(range.startContainer, range.startOffset);
      hi = src.offsetOf(range.endContainer, range.endOffset);
      sel.removeAllRanges();
    } else if (mode === "from") {
      const host = from.node.nodeType === Node.ELEMENT_NODE ? from.node : from.node.parentElement;
      const article = host?.closest("article, main, [role=main]");
      const pageRoot = root || pickRoot();
      const r = article || (pageRoot.contains(from.node) ? pageRoot : document.body);
      src = domSource(r);
      lo = src.offsetOf(from.node, from.offset);
      // Back up to the start of the word that was clicked.
      while (lo > 0 && /\S/.test(src.text[lo - 1])) lo--;
    } else if (mode === "page") {
      src = domSource(root || pickRoot());
    } else if (mode === "source") {
      lo = startOffset || 0;
    }

    const items = buildItems(src.text, lo, hi ?? src.text.length, s);
    if (!items.length) {
      M.player?.toast("Nothing readable here. Try selecting some text.");
      return;
    }
    if (mode === "page" && !root) first = firstVisibleItem(src, items);

    installStyles();
    showHighlights(true);
    const port = chrome.runtime.connect({ name: "murmur-reader" });
    R = { port, source: src, items, index: first, state: "loading", timing: null, raf: 0, aligned: new Map() };
    port.onMessage.addListener((m) => R?.port === port && onMessage(m));
    port.onDisconnect.addListener(() => R?.port === port && cleanup());
    M.player?.mount(controls, { voice: s.voice, speed: s.speed, total: items.length });
    M.player?.update({ state: "loading", index: first, total: items.length });
    highlightSentence(first);
    port.postMessage({ type: "load", sentences: items.map((it) => it.spoken), start: first, voice: s.voice, speed: s.speed });
  }

  // If the page is scrolled into the content, start at the first sentence on screen.
  function firstVisibleItem(src, items) {
    if (scrollY < 200) return 0;
    for (let i = 0; i < items.length; i++) {
      const r = src.toRange(items[i].start, items[i].end);
      const rect = r?.getBoundingClientRect();
      if (rect && (rect.width || rect.height) && rect.bottom > 0) return rect.top < innerHeight ? i : 0;
    }
    return 0;
  }

  async function highlightSentence(i) {
    const item = R?.items[i];
    if (!item) return;
    if (R.source.reveal) await R.source.reveal(item.start);
    if (!R || R.items[i] !== item) return;
    const range = R.source.toRange(item.start, item.end);
    hlWord?.clear();
    hlSentence?.clear();
    if (!range) return;
    hlSentence?.add(range);
    if (isExtPage) document.dispatchEvent(new CustomEvent("murmur:sentence", { detail: { range, index: i } }));
    keepInView(range);
  }

  function onMessage(msg) {
    if (!R) return;
    if (msg.type === "sentence") {
      const changed = R.index !== msg.index;
      R.index = msg.index;
      if (changed || !R.timing) highlightSentence(msg.index);
      const item = R.items[msg.index];
      let spans = R.aligned.get(msg.index);
      if (spans === undefined) {
        spans = M.align ? M.align.align(msg.words, item.words) : null;
        R.aligned.set(msg.index, spans);
      }
      R.timing = spans ? { at: msg.at, spans, cur: -1, index: msg.index } : null;
      tick();
    } else if (msg.type === "state") {
      R.state = msg.state;
      if (msg.index !== undefined && msg.index !== R.index) {
        R.index = msg.index;
        highlightSentence(msg.index);
      }
      M.player?.update({ state: msg.state, index: R.index, total: R.items.length, error: msg.error, note: msg.note });
      if (msg.state === "paused") cancelAnimationFrame(R.raf);
      else if (msg.state === "playing" && R.timing) tick(); // the sentence event may have arrived while still "paused"
      if (msg.state === "ended" || msg.state === "stopped") cleanup(msg.state === "ended" ? 1500 : 0);
    }
  }

  // Word highlight follows the audio clock (wall-clock epoch from the offscreen doc).
  function tick() {
    cancelAnimationFrame(R.raf);
    const step = () => {
      if (!R || !R.timing || R.state === "paused") return;
      const t = (Date.now() - R.timing.at) / 1000;
      const { spans } = R.timing;
      let k = R.timing.cur;
      while (k + 1 < spans.length && spans[k + 1].s <= t) k++;
      if (k !== R.timing.cur && k >= 0) {
        R.timing.cur = k;
        const range = R.source.toRange(spans[k].srcStart, spans[k].srcEnd);
        hlWord?.clear();
        if (range) hlWord?.add(range);
      }
      if (k < spans.length - 1 || t < spans[spans.length - 1].e) R.raf = requestAnimationFrame(step);
    };
    R.raf = requestAnimationFrame(step);
  }

  function cleanup(delay = 0) {
    const r = R;
    if (!r) return;
    R = null;
    cancelAnimationFrame(r.raf);
    try {
      r.port.disconnect();
    } catch {}
    const finish = () => {
      if (R) return; // a new session started meanwhile
      showHighlights(false);
      if (isExtPage) document.dispatchEvent(new CustomEvent("murmur:sentence", { detail: { range: null } }));
      M.player?.unmount();
    };
    delay ? setTimeout(finish, delay) : finish();
  }

  function send(msg) {
    try {
      R?.port.postMessage(msg);
    } catch {
      cleanup();
    }
  }

  function stop() {
    if (!R) return;
    send({ type: "stop" });
    cleanup();
  }

  const seek = (i) => R && send({ type: "seek", index: Math.max(0, Math.min(i, R.items.length - 1)) });

  // Callbacks for the player bar.
  const controls = {
    toggle: () => send({ type: "toggle" }),
    prev: () => R && seek(R.index - 1),
    next: () => R && seek(R.index + 1),
    stop,
    setSpeed: (speed) => {
      R?.aligned.clear(); // timings change with speed
      chrome.storage.sync.set({ speed }).catch(() => {});
      send({ type: "settings", speed });
    },
    setVoice: (voice) => {
      R?.aligned.clear();
      chrome.storage.sync.set({ voice }).catch(() => {});
      send({ type: "settings", voice });
    },
  };

  M.reader = {
    start: (opts) => start(opts).catch((e) => M.player?.toast(String(e.message || e))),
    stop,
    toggle: () => (R ? controls.toggle() : start({ mode: "page" })),
    next: controls.next,
    prev: controls.prev,
    isActive: () => !!R,
    domSource,
    pickRoot,
  };
})();
