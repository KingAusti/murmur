// Murmur hook for the vendored pdf.js generic viewer (pdfjs-6.4.299-dist).
//
// Classic script, loaded by web/viewer.html after the pdf.js module tags. It runs during
// parsing, i.e. *before* the deferred viewer.mjs evaluates, so the `webviewerloaded`
// listener below is in place when the viewer boots.
//
// 1. Opening: the generic viewer refuses cross-origin `?file=` (validateFileURL) and has no
//    AppOption for `withCredentials`. Instead of patching viewer.mjs we rename `file` to
//    `src` before `run()` reads the query (reloads keep working), blank `defaultUrl`, and call
//    PDFViewerApplication.open({url, withCredentials: true}) ourselves.
// 2. Text: Murmur.pdf.buildSource() extracts the whole document into one flat string
//    (artifacts / running heads dropped, hyphenated line breaks joined) with a map back to
//    (page, text item, char) so the reader can highlight in the rendered .textLayer.
//
// The extraction core (Murmur.pdf._extract / _locate) is pure and runs in Node for tests.
(() => {
  const M = (globalThis.Murmur = globalThis.Murmur || {});
  if (M.pdf) return;

  // ---------------------------------------------------------------------------------------
  // Pure extraction
  // ---------------------------------------------------------------------------------------

  const HYPHEN_END = /\p{L}[-\u00ad\u2010]\s*$/u;
  const SOFT_HYPHEN_END = /\u00ad\s*$/;
  const KEPT_HYPHEN_END = /[\p{L}\p{N}][-\u2010]\s*$/u;
  const TERMINAL_END = /[.!?:;…]["'”’)\]]*\s*$/;
  const STARTS_LOWER = /^\s*\p{Ll}/u;
  const STARTS_UPPER = /^\s*\p{Lu}/u;
  const ROMAN = /^(?=[mdclxvi])m*(c[md]|d?c{0,3})(x[cl]|l?x{0,3})(i[xv]|v?i{0,3})$/i;
  const MARGIN = 0.08; // top/bottom band for running heads, as a fraction of page height

  const isPageNumber = (t) => {
    t = t.trim().replace(/^[-–—\s]+|[-–—\s]+$/g, "");
    return /^(page\s+)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i.test(t) || ROMAN.test(t);
  };
  const headKey = (t) => t.toLowerCase().replace(/\d+/g, "").replace(/\s+/g, " ").trim();
  const median = (xs) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[s.length >> 1];
  };

  // Group one page's text items into lines. `i` counts items with a `str` (the index into
  // pdf.js TextLayer#textDivs); `d` counts non-empty ones (the order of spans in the DOM).
  function pageLines({ items, view }) {
    const lines = [];
    const stack = [];
    let line = null;
    let prev = null;
    let i = -1;
    let d = -1;
    let artifacts = false;
    let chars = 0;
    let rotChars = 0;
    for (const it of items) {
      if (it.str === undefined) {
        if (it.type === "beginMarkedContent" || it.type === "beginMarkedContentProps") stack.push(it.tag);
        else if (it.type === "endMarkedContent") stack.pop();
        continue;
      }
      i++;
      if (it.str !== "") d++;
      const [a, b, c, dd, x, y] = it.transform;
      const h = Math.hypot(c, dd) || it.height || 0;
      const rot = Math.abs(b) > Math.abs(a);
      const art = stack.includes("Artifact");
      if (art) artifacts = true;
      const visible = it.str.trim() !== "";
      if (visible) {
        chars += it.str.length;
        if (rot) rotChars += it.str.length;
      }
      const e = { i, d: it.str ? d : -1, str: it.str, x, y, w: it.width || 0, h, rot, art };
      const jumped = visible && line?.h && Math.abs(y - line.y) > 0.8 * Math.max(h, line.h);
      if (!line || prev?.eol || jumped) {
        line = { items: [], y: NaN, h: 0 };
        lines.push(line);
      }
      line.items.push(e);
      if (visible && !art) {
        if (Number.isNaN(line.y)) line.y = y;
        line.h = Math.max(line.h, h);
      }
      prev = { eol: it.hasEOL };
    }
    // Vertical margin stamps (e.g. arXiv's) are noise, unless the whole page is rotated text.
    const dropRot = rotChars < 0.2 * chars;
    for (const l of lines) {
      l.items = l.items.filter((e) => !e.art && !(dropRot && e.rot));
      l.text = l.items.map((e) => e.str).join("");
    }
    const kept = lines.filter((l) => l.text.trim() && !Number.isNaN(l.y));
    const [, y0, , y1] = view;
    const H = y1 - y0 || 1;
    for (const l of kept) {
      // Top band: the line's top edge is in it; bottom band: its baseline is.
      l.margin = (l.y + l.h - y0) / H > 1 - MARGIN || (l.y - y0) / H < MARGIN;
    }
    return { lines: kept, artifacts };
  }

  const romanValue = (t) => {
    if (!ROMAN.test(t)) return 0;
    const v = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
    let n = 0;
    const s = t.toLowerCase();
    for (let k = 0; k < s.length; k++) n += v[s[k]] < (v[s[k + 1]] || 0) ? -v[s[k]] : v[s[k]];
    return n;
  };
  // Page-number candidates at either end of a line: "12 Chapter 2. Variables" / "2.4. Script mode 11".
  function edgeNumbers(text) {
    const toks = text.trim().split(/\s+/);
    const out = [];
    for (const t of new Set([toks[0], toks.at(-1)])) {
      if (/^\d{1,4}$/.test(t)) out.push(["a", +t]);
      else if (romanValue(t)) out.push(["r", romanValue(t)]);
    }
    return out;
  }

  // Drop running heads in the top/bottom bands: lines that repeat (digits ignored) on >= 50% of
  // pages, bare page numbers, and lines carrying the page number (a number at either end
  // that tracks the page index with an offset seen on >= 3 pages — catches per-chapter heads).
  function dropRunningHeads(pages) {
    const n = pages.length;
    if (n < 2) return;
    const need = Math.max(2, Math.ceil(n * 0.5));
    const count = new Map();
    const offsets = new Map();
    const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
    pages.forEach((p, idx) => {
      const margin = p.lines.filter((l) => l.margin);
      for (const k of new Set(margin.map((l) => headKey(l.text)))) bump(count, k);
      const offs = new Set(margin.flatMap((l) => edgeNumbers(l.text).map(([kind, v]) => kind + (v - idx))));
      for (const k of offs) bump(offsets, k);
    });
    const minOff = Math.min(3, need);
    pages.forEach((p, idx) => {
      p.lines = p.lines.filter(
        (l) =>
          !(
            l.margin &&
            ((count.get(headKey(l.text)) || 0) >= need ||
              isPageNumber(l.text) ||
              edgeNumbers(l.text).some(([kind, v]) => (offsets.get(kind + (v - idx)) || 0) >= minOff))
          ),
      );
    });
  }

  // Words and hyphenated pairs seen within a line ("a-b-c" → "a", "b", "c", "a-b", "b-c"), to
  // settle line-break hyphens by the document's own usage. The pieces of a word broken across
  // lines ("infor-" / "mation") are left out.
  const WORD = /[\p{L}\p{N}]+(?:[-\u2010][\p{L}\p{N}]+)*/gu;
  function vocabulary(parsed) {
    const vocab = new Set();
    let broken = false;
    for (const { lines } of parsed)
      for (const l of lines) {
        const words = l.text.toLowerCase().match(WORD) || [];
        if (broken) words.shift();
        broken = HYPHEN_END.test(l.text);
        if (broken) words.pop();
        for (const w of words) {
          const parts = w.split(/[-\u2010]/);
          for (const part of parts) vocab.add(part);
          for (let k = 1; k < parts.length; k++) vocab.add(`${parts[k - 1]}-${parts[k]}`);
        }
      }
    return vocab;
  }
  // Short words that typically sit inside compound chains: "English-" + "to-German".
  const CHAIN_WORD = /^(a|an|and|as|at|by|for|from|in|of|off|on|or|out|over|per|the|to|under|up|vs|with)$/;
  // Line ends in "left-", next line starts with "right". Should the hyphen go? For a lowercase
  // continuation, by default yes ("infor-" + "mation"), unless the document never has the
  // joined word and writes the pair hyphenated, or both halves are words of their own
  // ("attention-" + "based"), or it's a compound chain. In caps ("AN-" + "NUAL") only when the
  // document has the joined word.
  function joinHyphen(vocab, tailText, nextText) {
    const left = /([\p{L}\p{N}]+)[-\u2010]\s*$/u.exec(tailText)?.[1];
    const right = /^\s*([\p{L}\p{N}]+)/u.exec(nextText)?.[1];
    if (!left || !right) return false;
    const [l, r] = [left.toLowerCase(), right.toLowerCase()];
    if (!STARTS_LOWER.test(right)) return /^\p{Lu}+$/u.test(left + right) && vocab.has(l + r) && !vocab.has(`${l}-${r}`);
    if (vocab.has(l + r)) return true;
    if (vocab.has(`${l}-${r}`)) return false;
    if (/[-\u2010][\p{L}\p{N}]+[-\u2010]\s*$/u.test(tailText)) return false; // "state-of-the-" + "art"
    if (l.length > 3 && r.length > 3 && vocab.has(l) && vocab.has(r)) return false; // two words: a compound
    return !(CHAIN_WORD.test(r) && /^\s*[\p{L}\p{N}]+[-\u2010]\S/u.test(nextText));
  }

  /**
   * pages: [{items: TextContent.items (includeMarkedContent + disableNormalization), view: [x0,y0,x1,y1]}]
   * opts.tagged: document has MarkInfo.Marked (then Artifact tags are trusted when present)
   * opts.normalize: char normalizer (pdfjsLib.normalizeUnicode) to expand ligatures etc.
   * → {text, runs, pageStarts}
   *   runs: [{s, len, p, i, d, o, n}] — flat [s, s+len) comes from item i (DOM span d) of page p,
   *   chars [o, o+n). len !== n only for single expanded chars (ligatures).
   */
  function extract(pages, { tagged = false, normalize = null } = {}) {
    const parsed = pages.map(pageLines);
    if (!(tagged && parsed.some((p) => p.artifacts))) dropRunningHeads(parsed);
    const vocab = vocabulary(parsed);

    // Output is built in chunks; regex checks only ever look at the tail (no O(n²) flattening).
    const parts = [];
    let len = 0;
    const runs = [];
    const pageStarts = [];
    const put = (str) => {
      parts.push(str);
      len += str.length;
    };
    const tail = (k = 64) => {
      let t = "";
      for (let j = parts.length - 1; j >= 0 && t.length < k; j--) t = parts[j] + t;
      return t.slice(-k);
    };
    const trimmedLen = () => {
      const t = tail();
      return len - (t.length - t.trimEnd().length);
    };
    const truncate = (to) => {
      while (len > to) {
        const last = parts.pop();
        len -= last.length;
        if (len < to) put(last.slice(0, to - len));
      }
      while (runs.length && runs.at(-1).s >= to) runs.pop();
      const r = runs.at(-1);
      if (r && r.s + r.len > to && r.len === r.n) r.len = r.n = to - r.s;
    };
    const emit = (p, e) => {
      const str = e.str;
      const base = { p, i: e.i, d: e.d };
      if (!normalize || normalize(str) === str) {
        runs.push({ s: len, len: str.length, ...base, o: 0, n: str.length });
        put(str);
        return;
      }
      let o = 0;
      let plain = "";
      const flush = () => {
        if (!plain) return;
        runs.push({ s: len, len: plain.length, ...base, o: o - plain.length, n: plain.length });
        put(plain);
        plain = "";
      };
      for (const ch of str) {
        const nch = normalize(ch);
        if (nch === ch) plain += ch;
        else {
          flush();
          runs.push({ s: len, len: nch.length, ...base, o, n: ch.length });
          put(nch);
        }
        o += ch.length;
      }
      flush();
    };
    // Join the next line onto what we have so far: dehyphenate, or pick ' ' vs '\n\n'.
    const join = (nextText, paragraph) => {
      if (!len) return;
      const t = tail();
      if (SOFT_HYPHEN_END.test(t) || (HYPHEN_END.test(t) && joinHyphen(vocab, t, nextText))) {
        truncate(trimmedLen() - 1);
        return;
      }
      // Page breaks and column jumps split paragraphs only after a full stop; otherwise the
      // sentence most likely continues ("…See" ‖ "Moving Expenses in Pub. 3…").
      if (paragraph === "flow") paragraph = TERMINAL_END.test(t);
      if (paragraph) {
        truncate(trimmedLen());
        put("\n\n");
      } else if (KEPT_HYPHEN_END.test(t)) {
        truncate(trimmedLen()); // "English-to-German", "COVID-19": no space after the hyphen
      } else if (!/\s$/.test(t)) put(" ");
    };

    parsed.forEach(({ lines }, p) => {
      const gaps = [];
      for (let j = 1; j < lines.length; j++) {
        const dy = lines[j - 1].y - lines[j].y;
        if (dy > 0 && dy < 3 * lines[j].h) gaps.push(dy);
      }
      const lineGap = median(gaps);
      lines.forEach((l, j) => {
        if (j === 0) {
          join(l.text, "flow");
          pageStarts[p] = len;
        } else {
          const a = lines[j - 1];
          const dy = a.y - l.y;
          let para;
          if (dy < -0.5 * l.h) para = "flow"; // jumped up: next column
          else para = lineGap ? dy > 1.5 * lineGap : dy > 2 * l.h;
          // Headings set larger than the body: "2.9 Glossary" after body text, or body after it.
          const short = (x) => x.trim().length < 80;
          if (para === false && a.h > 1.15 * l.h && short(a.text) && !TERMINAL_END.test(a.text) && STARTS_UPPER.test(l.text)) para = true;
          if (para === false && l.h > 1.15 * a.h && short(l.text) && /^\s*[\p{Lu}\d]/u.test(l.text)) para = true;
          join(l.text, para);
        }
        let last = null;
        for (const e of l.items) {
          if (!e.str) continue;
          if (last && !/\s$/.test(tail(1)) && !/^\s/.test(e.str) && e.x - (last.x + last.w) > 0.15 * Math.max(e.h, last.h)) put(" ");
          emit(p, e);
          last = e;
        }
      });
      if (pageStarts[p] === undefined) pageStarts[p] = len;
    });
    return { text: parts.join(""), runs, pageStarts };
  }

  // Binary search: index of the last run with s <= pos.
  function runIndex(runs, pos) {
    let lo = 0;
    let hi = runs.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (runs[mid].s <= pos) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  // Flat offset → {p, i, d, off}. As a range start, offsets in virtual text (inserted spaces,
  // dropped hyphens) snap forward; as an exclusive end, they snap back.
  function locate(runs, pos, isEnd = false) {
    if (!runs.length) return null;
    if (isEnd) {
      const k = runIndex(runs, pos - 1);
      if (k < 0) return null;
      const r = runs[k];
      const inside = pos - r.s;
      const off = inside >= r.len ? r.o + r.n : r.len === r.n ? r.o + inside : r.o + r.n;
      return { p: r.p, i: r.i, d: r.d, off, k };
    }
    let k = runIndex(runs, pos);
    if (k < 0 || pos >= runs[k].s + runs[k].len) k++;
    if (k >= runs.length) return null;
    const r = runs[k];
    const inside = Math.max(0, pos - r.s);
    return { p: r.p, i: r.i, d: r.d, off: r.len === r.n ? r.o + inside : r.o, k };
  }

  // (page, item, char offset) → flat offset; items we dropped snap to the next kept text.
  function offsetOf(runs, p, i, off) {
    for (const r of runs) {
      if (r.p < p || (r.p === p && r.i < i)) continue;
      if (r.p === p && r.i === i) {
        if (off >= r.o + r.n) continue;
        return r.s + (off <= r.o ? 0 : r.len === r.n ? off - r.o : 0);
      }
      return r.s;
    }
    return runs.length ? runs.at(-1).s + runs.at(-1).len : 0;
  }

  M.pdf = { _extract: extract, _locate: locate, _offsetOf: offsetOf };

  if (typeof document === "undefined" || typeof window === "undefined") return;

  // ---------------------------------------------------------------------------------------
  // Viewer integration
  // ---------------------------------------------------------------------------------------

  const ALLOWED = /^(https?|file|ftp):/i;
  let fileUrl = null;

  // `?file=` arrives two ways: raw from the DNR redirect (`?file=\0`, so the PDF URL's own
  // `&`s are unescaped — take everything after `file=`) or encodeURIComponent'd by
  // background.js / a reload of our own `?src=`.
  function fileFromQuery(search, depth = 0) {
    const m = /[?&](?:file|src)=(.*)$/s.exec(search);
    if (!m) return null;
    let v = m[1];
    if (/^[a-z][a-z0-9+.-]*%3A/i.test(v)) {
      try {
        v = decodeURIComponent(v.split("&")[0]);
      } catch {
        return null;
      }
    }
    // Our own viewer URL wrapped in another (a "*.pdf" tab re-routed to the viewer): unwrap.
    const self = location.origin + location.pathname;
    if (depth < 3 && v.startsWith(self + "?")) return fileFromQuery(v.slice(self.length), depth + 1);
    return ALLOWED.test(v) ? v : null;
  }

  document.addEventListener("webviewerloaded", () => {
    const opts = window.PDFViewerApplicationOptions;
    opts.set("disablePreferences", true);
    opts.set("defaultUrl", "");
    opts.set("enableScripting", false); // no PDF JavaScript in a privileged extension page
    fileUrl = fileFromQuery(location.search);
    // Our redirect only targets top-level navigations. Framed, the viewer would let any site
    // make us fetch (with the user's cookies) or display an arbitrary URL, so don't auto-open.
    if (window.top !== window) fileUrl = null;
    if (location.search) {
      const q = fileUrl ? `?src=${encodeURIComponent(fileUrl)}` : "";
      history.replaceState(history.state, "", location.pathname + q + location.hash);
    }
  });

  const app = () => window.PDFViewerApplication;
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));

  async function boot() {
    await new Promise((r) => (app() ? r() : document.addEventListener("webviewerloaded", r, { once: true })));
    const A = app();
    await A.initializedPromise;
    const bus = A.eventBus;
    // `documentloaded` precedes setInitialView (hash/stored zoom and page), which would undo an
    // early scroll from reveal(). `documentinit` follows it but is skipped on an error path.
    let initDoc = null;
    let onInit = null;
    bus.on("documentinit", () => {
      initDoc = A.pdfDocument;
      onInit?.();
    });
    bus.on("documentloaded", async () => {
      const doc = A.pdfDocument;
      hideNotice();
      if (M.reader?.isActive?.()) M.reader.stop(); // its source maps into the previous document
      if (initDoc !== doc) await new Promise((r) => ((onInit = r), setTimeout(r, 2000)));
      onInit = null;
      if (A.pdfDocument !== doc) return;
      button.hidden = false;
      resolveReady(A);
      prefetch();
    });
    bus.on("documenterror", () => showNotice(true));
    if (!fileUrl) return showNotice(false);
    A.open({ url: fileUrl, originalUrl: fileUrl, withCredentials: true }).catch(() => showNotice(true));
  }

  // ---- notice (load failure / empty viewer) ----

  let notice = null;
  function showNotice(failed) {
    button.hidden = true;
    if (!notice) {
      notice = document.createElement("div");
      notice.id = "murmurNotice";
      notice.innerHTML = '<p></p><button type="button" class="murmur-btn">Open…</button>';
      notice.querySelector("button").addEventListener("click", () => app()?.eventBus.dispatch("openfile", { source: window }));
      document.getElementById("viewerContainer")?.append(notice);
    }
    notice.querySelector("p").textContent = failed ? "Couldn't load this PDF — drag it here or use Open" : "Drag a PDF here or use Open";
    notice.hidden = false;
  }
  const hideNotice = () => notice && (notice.hidden = true);

  // ---- source ----

  let cache = null; // {doc, promise}
  const progress = new Set();

  function extractDocument(doc) {
    if (cache?.doc === doc) return cache.promise;
    const promise = (async () => {
      const n = doc.numPages;
      const pages = new Array(n);
      let done = 0;
      const BATCH = 8;
      for (let s = 0; s < n; s += BATCH) {
        await Promise.all(
          Array.from({ length: Math.min(BATCH, n - s) }, async (_, k) => {
            const page = await doc.getPage(s + k + 1);
            const tc = await page.getTextContent({ includeMarkedContent: true, disableNormalization: true });
            pages[s + k] = { items: tc.items, view: page.view };
            done++;
          }),
        );
        for (const fn of progress) fn(done / n);
      }
      const mark = await doc.getMarkInfo().catch(() => null);
      const tagged = !!(mark instanceof Map ? mark.get("Marked") : mark?.Marked); // a Map in pdf.js 6
      return extract(pages, { tagged, normalize: globalThis.pdfjsLib?.normalizeUnicode });
    })();
    cache = { doc, promise };
    promise.catch(() => cache?.promise === promise && (cache = null));
    return promise;
  }

  function prefetch() {
    const doc = app()?.pdfDocument;
    if (!doc || doc.numPages > 400) return; // big books: extract on first use instead
    (window.requestIdleCallback || setTimeout)(() => extractDocument(doc).catch(() => {}));
  }

  // The rendered span for item i on page p, or null if that text layer isn't (fully) rendered.
  function textDiv(p, i, d) {
    const view = app()?.pdfViewer?.getPageView(p);
    const layer = view?.textLayer?.div;
    if (!layer?.isConnected || !layer.querySelector(":scope > .endOfContent")) return null;
    const div = view._textHighlighter?.textDivs?.[i];
    if (div?.isConnected && layer.contains(div)) return div;
    // Fallback: spans in DOM order, skipping markedContent wrappers and struct-tree images.
    if (d < 0) return null;
    const sel = "span:not(.markedContent):not([role=img])";
    return layer.querySelectorAll(`:scope > ${sel}, .markedContent > ${sel}`)[d] || null;
  }
  const layerReady = (p) => !!app()?.pdfViewer?.getPageView(p)?.textLayer?.div?.querySelector(":scope > .endOfContent");

  // Text node + offset at char `off` inside a span (find-highlighting may split it).
  function nodeAt(div, off, isEnd) {
    const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
    let node;
    let last = null;
    while ((node = walker.nextNode())) {
      const len = node.data.length;
      if (off < len || (isEnd && off === len)) return [node, off];
      off -= len;
      last = node;
    }
    return last ? [last, last.data.length] : [div, 0];
  }

  function makeSource({ text, runs }) {
    const toRange = (start, end) => {
      if (end <= start) return null;
      const a = locate(runs, start);
      let b = locate(runs, end, true);
      if (!a || !b || b.k < a.k) return null;
      const da = textDiv(a.p, a.i, a.d);
      if (!da) return null;
      let db = textDiv(b.p, b.i, b.d);
      if (!db && b.p !== a.p) {
        // Sentence runs onto a page that isn't rendered: clamp to the end of a's page.
        let k = b.k;
        while (k > a.k && runs[k].p !== a.p) k--;
        b = locate(runs, runs[k].s + runs[k].len, true);
        db = textDiv(b.p, b.i, b.d);
      }
      if (!db) return null;
      const range = document.createRange();
      range.setStart(...nodeAt(da, a.off, false));
      range.setEnd(...nodeAt(db, b.off, true));
      return range;
    };
    // Scroll to the page and wait for its text layer; one retry in case something else
    // (initial view, a zoom change) moved the viewer meanwhile.
    const reveal = async (start) => {
      const loc = locate(runs, start);
      const A = app();
      if (!loc || !A?.pdfViewer) return;
      const pageNumber = loc.p + 1;
      for (let attempt = 0; attempt < 2 && !layerReady(loc.p); attempt++) {
        await new Promise((resolve) => {
          const done = () => {
            A.eventBus.off("textlayerrendered", on);
            clearTimeout(timer);
            clearInterval(poll);
            resolve();
          };
          const on = (e) => e.pageNumber === pageNumber && done();
          const timer = setTimeout(done, 2500);
          const poll = setInterval(() => layerReady(loc.p) && done(), 150); // renders can be cancelled and redone
          A.eventBus.on("textlayerrendered", on);
          A.pdfViewer.scrollPageIntoView({ pageNumber });
          if (layerReady(loc.p)) done();
        });
      }
    };
    return { text, toRange, reveal };
  }

  // A window [from, to) of a source, re-based to offset 0.
  function slice(src, from, to = src.text.length) {
    if (from <= 0 && to >= src.text.length) return src;
    return {
      text: src.text.slice(from, to),
      toRange: (s, e) => src.toRange(s + from, e + from),
      reveal: (s) => src.reveal(s + from),
    };
  }

  async function buildSource(onProgress) {
    const A = await ready;
    if (onProgress) progress.add(onProgress);
    try {
      return makeSource(await extractDocument(A.pdfDocument));
    } finally {
      progress.delete(onProgress);
    }
  }

  // A DOM boundary point → {p, i, off} (page, text item, char), or null when it isn't in a
  // rendered text layer. Points between spans (<br>, .markedContent, .endOfContent, the layer
  // itself — common for drag-selections and caret hits in pdf.js) snap to the next span as a
  // start, or to the end of the previous one as an end.
  function resolvePoint(node, offset, isEnd) {
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const pageEl = el?.closest(".page[data-page-number]");
    if (!pageEl) return null;
    const p = +pageEl.dataset.pageNumber - 1;
    const view = app()?.pdfViewer?.getPageView(p);
    const layer = view?.textLayer?.div;
    const divs = view?._textHighlighter?.textDivs;
    if (!divs || !layer?.contains(node)) return null;
    for (let e = el; e && e !== layer; e = e.parentElement) {
      const i = divs.indexOf(e);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(e, 0);
      r.setEnd(node, offset);
      return { p, i, off: r.toString().length };
    }
    const at = document.createRange();
    at.setStart(node, offset);
    if (isEnd) {
      for (let i = divs.length - 1; i >= 0; i--) {
        const d = divs[i];
        if (d.isConnected && at.comparePoint(d, d.childNodes.length) <= 0) return { p, i, off: d.textContent.length };
      }
      return { p, i: -1, off: 0 }; // before the page's first span: snaps to the page start
    }
    const i = divs.findIndex((d) => d.isConnected && at.comparePoint(d, 0) >= 0);
    return { p, i: i < 0 ? divs.length : i, off: 0 }; // past the last span: snaps to the next page
  }

  // First/last rendered text span a range touches, for endpoints outside any text layer.
  function touchedSpans(range) {
    const viewer = app()?.pdfViewer;
    let first = null;
    let last = null;
    for (let p = 0; p < (viewer?.pagesCount || 0); p++) {
      const view = viewer.getPageView(p);
      const layer = view?.textLayer?.div;
      if (!layer?.isConnected || !range.intersectsNode(layer)) continue;
      (view._textHighlighter?.textDivs || []).forEach((d, i) => {
        if (!d.isConnected || !range.intersectsNode(d)) return;
        first ??= { p, i, off: 0 };
        last = { p, i, off: d.textContent.length };
      });
    }
    return first && { first, last };
  }

  // The selection as flat offsets {start, end}, or null if it doesn't cover PDF text.
  function selectionSpan(runs) {
    const sel = document.getSelection();
    if (!sel?.rangeCount || sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    let a = resolvePoint(r.startContainer, r.startOffset, false);
    let b = resolvePoint(r.endContainer, r.endOffset, true);
    if (!a || !b) {
      const hit = touchedSpans(r);
      if (!hit) return null;
      a ||= hit.first;
      b ||= hit.last;
    }
    const start = offsetOf(runs, a.p, a.i, a.off);
    const end = offsetOf(runs, b.p, b.i, b.off);
    return end > start ? { start, end } : null;
  }

  // Start of the sentence visible at the top of the current page.
  function currentPageStart({ text, pageStarts }) {
    const p = (app()?.page || 1) - 1;
    const at = pageStarts[p] ?? 0;
    // Sentences never cross '\n\n', so segmenting from the paragraph start is enough.
    const from = Math.max(text.lastIndexOf("\n\n", at - 1) + 1, at - 5000, 0);
    const spans = M.segment?.splitSentences?.(text.slice(from, at + 2000));
    const hit = spans?.find((s) => from + s.end > at);
    return hit && from + hit.start <= at ? from + hit.start : at;
  }

  function start(source, startOffset = 0) {
    if (!M.reader?.start) throw new Error("Murmur reader is not loaded");
    return M.reader.start({ mode: "source", source, startOffset });
  }

  const loadedDoc = () => {
    const doc = app()?.pdfDocument;
    if (!doc) throw new Error("No PDF loaded");
    return doc;
  };

  // ⌥⇧R / button: from the selection start (else the current page) to the end of the document.
  async function readFromHere() {
    const data = await extractDocument(loadedDoc());
    const sel = selectionSpan(data.runs);
    document.getSelection()?.removeAllRanges();
    return start(makeSource(data), sel ? sel.start : currentPageStart(data));
  }

  // ⌥-click / "Read from here" on a text-layer point. Resolves false if it isn't on PDF text.
  async function readFrom(node, offset) {
    const data = await extractDocument(loadedDoc());
    const loc = resolvePoint(node, offset, false);
    if (!loc) return false;
    let at = offsetOf(data.runs, loc.p, loc.i, loc.off);
    while (at > 0 && /\S/.test(data.text[at - 1])) at--; // back up to the word start
    await start(makeSource(data), at);
    return true;
  }

  // Selection only. Resolves false when nothing is selected in the text layer.
  async function readSelection() {
    const data = await extractDocument(loadedDoc());
    const sel = selectionSpan(data.runs);
    if (!sel) return false;
    document.getSelection()?.removeAllRanges();
    // The reader takes no end offset, so hand it just the selected window.
    await start(slice(makeSource(data), sel.start, sel.end));
    return true;
  }

  // ---- floating "Read aloud" button ----

  const button = document.createElement("button");
  button.id = "murmurRead";
  button.type = "button";
  button.className = "murmur-btn";
  button.hidden = true;
  button.title = "Read aloud with Murmur (⌥⇧R) — starts at your selection or the current page";
  const LABEL = "▶ Read aloud";
  button.textContent = LABEL;
  button.addEventListener("mousedown", (e) => e.preventDefault()); // keep the text selection
  button.addEventListener("click", async () => {
    if (M.reader?.isActive?.()) return M.reader.toggle();
    const show = (f) => (button.textContent = `Preparing… ${Math.round(f * 100)}%`);
    progress.add(show);
    button.disabled = true;
    try {
      await readFromHere();
    } catch (err) {
      console.error("[murmur-pdf]", err);
    } finally {
      progress.delete(show);
      button.disabled = false;
      button.textContent = LABEL;
    }
  });

  const mount = () => {
    (document.getElementById("mainContainer") || document.body).append(button);
    boot().catch((err) => console.error("[murmur-pdf]", err));
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();

  Object.assign(M.pdf, { ready, buildSource, readFromHere, readSelection, readFrom, isViewer: true });
})();
