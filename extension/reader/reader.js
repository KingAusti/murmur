// Murmur Reader view: fetches the source tab's DOM through the background,
// extracts the article (Readability), sanitizes it (DOMPurify) and renders it
// for long, comfortable reading and listening.
//
// Opened as reader/reader.html?tab=<sourceTabId>.
(() => {
  'use strict';

  const PREFS_KEY = 'readerPrefs';
  const DEFAULTS = Object.freeze({ theme: 'auto', font: 'sans', size: 20, leading: 1.7, width: 'normal', focus: false });
  const THEMES = ['auto', 'light', 'sepia', 'dark'];
  const FONTS = ['sans', 'serif'];
  const WIDTHS = ['narrow', 'normal', 'wide'];
  const SIZES = [15, 16, 17, 18, 19, 20, 21, 22, 24, 26, 28, 32];
  const LEADINGS = [1.4, 1.55, 1.7, 1.85, 2, 2.2];
  const WPM = 165;
  const FETCH_TIMEOUT_MS = 15000;

  // ---------- pure helpers (also exercised by node tests) ----------

  function countWords(text) {
    const m = String(text || '').match(/\S*[\p{L}\p{N}]\S*/gu);
    return m ? m.length : 0;
  }

  function listenMinutes(words) {
    return Math.max(1, Math.round(words / WPM));
  }

  function nearest(list, value) {
    let best = list[0];
    for (const v of list) if (Math.abs(v - value) < Math.abs(best - value)) best = v;
    return best;
  }

  function stepIn(list, value, dir) {
    const i = list.indexOf(nearest(list, value));
    return list[Math.min(list.length - 1, Math.max(0, i + dir))];
  }

  function sanitizePrefs(raw) {
    const p = raw && typeof raw === 'object' ? raw : {};
    const num = (v, list, d) => (Number.isFinite(+v) && v !== null && v !== '' ? nearest(list, +v) : d);
    return {
      theme: THEMES.includes(p.theme) ? p.theme : DEFAULTS.theme,
      font: FONTS.includes(p.font) ? p.font : DEFAULTS.font,
      size: num(p.size, SIZES, DEFAULTS.size),
      leading: num(p.leading, LEADINGS, DEFAULTS.leading),
      width: WIDTHS.includes(p.width) ? p.width : DEFAULTS.width,
      focus: p.focus === true,
    };
  }

  // Splits pasted plain text into paragraphs; single newlines are soft wraps.
  function textToParagraphs(text) {
    return String(text || '')
      .replace(/\r\n?/g, '\n')
      .split(/\n\s*\n/)
      .map((s) => s.replace(/\s*\n\s*/g, ' ').replace(/[ \t]+/g, ' ').trim())
      .filter(Boolean);
  }

  function absolutize(value, base) {
    try { return new URL(value, base).href; } catch { return value; }
  }

  // polish() rewrites URLs after DOMPurify has checked them, so it re-checks the result.
  const LINK_SCHEMES = /^(https?|mailto|tel):/i;
  function isSafeImageUrl(url) {
    return /^(https?:|data:image\/)/i.test(url);
  }

  // Per the srcset grammar a URL is a whitespace-free run, so commas inside URLs survive.
  function absolutizeSrcset(value, base) {
    const out = [];
    for (const [, rawUrl, desc = ''] of String(value).matchAll(/\s*(\S+)(\s+[^,]*)?,?/g)) {
      const url = absolutize(rawUrl.replace(/,+$/, ''), base);
      if (url && isSafeImageUrl(url)) out.push(url + desc.replace(/\s+/g, ' ').trimEnd());
    }
    return out.join(', ');
  }

  function classifySourceError(message) {
    if (/no tab with id|tab was closed|frame with id .* (was removed|is not found)/i.test(message)) return 'gone';
    if (/error page/i.test(message)) return 'source'; // e.g. offline: reloading the tab can fix it
    if (/cannot access|cannot be scripted|chrome:\/\/|chrome-extension:\/\/|must request permission/i.test(message)) return 'restricted';
    return 'source';
  }

  const helpers = {
    countWords, listenMinutes, stepIn, sanitizePrefs, textToParagraphs, absolutizeSrcset, classifySourceError,
    isSafeImageUrl, LINK_SCHEMES,
    DEFAULTS, SIZES, LEADINGS, WPM,
  };
  globalThis.MurmurReaderView = helpers;
  if (typeof document === 'undefined') return;

  // ---------- page ----------

  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const article = $('article');
  const content = $('content');
  const sourceTab = Number.parseInt(new URLSearchParams(location.search).get('tab') ?? '', 10);

  let prefs = { ...DEFAULTS };
  let saveTimer = 0;
  let lastSavedJson = '';

  class ReaderError extends Error {
    constructor(kind, detail) {
      super(detail || kind);
      this.kind = kind;
      this.detail = detail || '';
    }
  }

  // ---------- prefs ----------

  function applyPrefs() {
    root.dataset.theme = prefs.theme;
    root.dataset.font = prefs.font;
    root.dataset.width = prefs.width;
    root.dataset.focus = prefs.focus ? 'on' : 'off';
    root.style.setProperty('--reading-size', `${prefs.size}px`);
    root.style.setProperty('--reading-leading', String(prefs.leading));

    for (const name of ['theme', 'font', 'width']) {
      for (const input of document.querySelectorAll(`input[name="${name}"]`)) input.checked = input.value === prefs[name];
    }
    $('size-value').textContent = String(prefs.size);
    $('leading-value').textContent = String(prefs.leading);
    for (const btn of document.querySelectorAll('[data-step]')) {
      const list = btn.dataset.step === 'size' ? SIZES : LEADINGS;
      const value = prefs[btn.dataset.step];
      btn.disabled = +btn.dataset.dir < 0 ? value <= list[0] : value >= list[list.length - 1];
    }
    $('focus-toggle').setAttribute('aria-pressed', String(prefs.focus));
  }

  function setPrefs(patch) {
    prefs = sanitizePrefs({ ...prefs, ...patch });
    applyPrefs();
    // storage.sync has per-minute write quotas; coalesce rapid +/- clicks.
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      lastSavedJson = JSON.stringify(prefs);
      chrome.storage.sync.set({ [PREFS_KEY]: prefs }).catch((err) => console.warn('[murmur] saving reader prefs failed', err));
    }, 350);
  }

  async function loadPrefs() {
    try {
      const got = await chrome.storage.sync.get(PREFS_KEY);
      prefs = sanitizePrefs(got[PREFS_KEY]);
    } catch (err) {
      console.warn('[murmur] reading reader prefs failed', err);
    }
    applyPrefs();
    chrome.storage.onChanged.addListener((changes, area) => {
      const change = changes[PREFS_KEY];
      // A pending local edit wins; so does our own echo (storage may reorder keys, so compare canonically).
      if (area !== 'sync' || !change || saveTimer) return;
      const incoming = sanitizePrefs(change.newValue);
      if (JSON.stringify(incoming) === lastSavedJson) return;
      prefs = incoming;
      applyPrefs();
    });
  }

  // ---------- fetching the source page ----------

  async function fetchSource() {
    if (!Number.isInteger(sourceTab) || sourceTab < 0) {
      throw new ReaderError('no-tab');
    }
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ReaderError('timeout')), FETCH_TIMEOUT_MS);
    });
    const request = chrome.runtime.sendMessage({ type: 'reader-fetch', tab: sourceTab }).then(
      (res) => {
        if (!res) throw new ReaderError('no-response');
        if (res.error) throw new ReaderError(classifySourceError(String(res.error)), String(res.error));
        if (typeof res.html !== 'string' || !res.html.trim()) throw new ReaderError('empty');
        return { html: res.html, url: String(res.url || ''), title: String(res.title || '') };
      },
      (err) => {
        throw new ReaderError('unreachable', err?.message);
      },
    );
    try {
      return await Promise.race([request, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  const ERROR_COPY = {
    timeout: ['The page took too long to respond', 'It may still be loading. Give it a moment, then try again.'],
    'no-response': ['Couldn’t open this page in Reader view', 'Murmur didn’t get the page back. Try reloading the original tab first.'],
    unreachable: ['Couldn’t open this page in Reader view', 'Murmur’s background service didn’t answer. Try again in a second.'],
    restricted: ['This page can’t be opened in Reader view', 'Browser pages, the Web Store, other extensions and the built-in PDF viewer are off-limits. You can still paste text in.'],
    gone: ['The original tab is gone', 'It was closed or moved on. Open Reader view again from the page you want to read, or paste text in.'],
    source: ['Couldn’t read this page', 'Something went wrong while grabbing the page. Try again, or paste the text in.'],
    empty: ['This page looks empty', 'There was no text to pull out. If it’s still loading, try again.'],
    parse: ['Couldn’t find the article on this page', 'The layout was too unusual to clean up. You can paste the text in instead.'],
  };

  // ---------- extraction ----------

  const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';
  // Math renderers ship a visual rendering next to (or instead of) MathML. Keep only
  // the MathML: Chromium renders it natively and the speech pipeline reads its alttext.
  const MATH_OUTER = '.katex-display, .MathJax_Display, .MathJax_SVG_Display, mjx-container, .mwe-math-element';
  const MATH_INNER = '.katex, .MathJax, .MathJax_SVG, .MathJax_CHTML';
  const MATHJAX_VISUAL = '.MathJax, .MathJax_Display, .MathJax_SVG, .MathJax_SVG_Display, .MathJax_CHTML';

  function setBase(doc, pageUrl) {
    let href = pageUrl;
    const existing = doc.querySelector('base[href]');
    if (existing) {
      try {
        const u = new URL(existing.getAttribute('href'), pageUrl);
        // A page-supplied javascript:/data: base would turn relative links into script URLs.
        if (/^(https?|file):$/.test(u.protocol)) href = u.href;
      } catch { /* keep pageUrl */ }
    }
    doc.querySelectorAll('base').forEach((b) => b.remove());
    if (href) {
      const base = doc.createElement('base');
      base.setAttribute('href', href);
      doc.head.prepend(base);
    }
    return href;
  }

  function isDisplayMath(wrapper, math) {
    return math.getAttribute('display') === 'block'
      || wrapper.matches('.katex-display, .MathJax_Display, .MathJax_SVG_Display, .mwe-math-element-block, mjx-container[display="true"]')
      || !!wrapper.querySelector('.mwe-math-fallback-image-display');
  }

  function bracesBalanced(tex) {
    let depth = 0;
    for (const ch of tex.replace(/\\./g, '')) {
      if (ch === '{') depth++;
      else if (ch === '}' && --depth < 0) return false;
    }
    return depth === 0;
  }

  function prepareMath(doc) {
    for (const math of [...doc.querySelectorAll('math')]) {
      const wrapper = math.parentElement?.closest(MATH_OUTER) || math.parentElement?.closest(MATH_INNER);
      if (!math.getAttribute('alttext')) {
        const tex = math.querySelector('annotation[encoding="application/x-tex"], annotation[encoding="TeX"]');
        const alt = tex?.textContent.trim() || math.getAttribute('aria-label') || wrapper?.getAttribute('aria-label');
        if (alt) math.setAttribute('alttext', alt);
      }
      // Wikipedia wraps every formula in {\displaystyle …}; it is noise when spoken.
      const bare = /^\{\\(?:display|text)style\s*([^]*)\}$/.exec((math.getAttribute('alttext') || '').trim());
      if (bare && bracesBalanced(bare[1])) math.setAttribute('alttext', bare[1].trim());
      // Annotations hold source TeX; once unwrapped by the sanitizer it would render as text.
      math.querySelectorAll('annotation, annotation-xml').forEach((n) => n.remove());
      math.querySelectorAll('semantics').forEach((s) => s.replaceWith(...s.childNodes));

      if (wrapper) {
        if (isDisplayMath(wrapper, math)) math.setAttribute('display', 'block');
        wrapper.replaceWith(math);
      }
    }
    // MathJax 2 without assistive MathML: only the TeX source survives, in a script tag.
    for (const script of [...doc.querySelectorAll('script[type^="math/tex"]')]) {
      const prev = script.previousElementSibling;
      if (prev && prev.localName !== 'math' && prev.matches(MATHJAX_VISUAL)) {
        const tex = script.textContent.trim();
        const math = doc.createElementNS(MATHML_NS, 'math');
        math.setAttribute('alttext', tex);
        if (/mode\s*=\s*display/.test(script.type)) math.setAttribute('display', 'block');
        const mtext = doc.createElementNS(MATHML_NS, 'mtext');
        mtext.textContent = tex;
        math.append(mtext);
        prev.replaceWith(math);
      }
      script.remove();
    }
    doc.querySelectorAll('.MathJax_Preview').forEach((n) => n.remove());
  }

  const PURIFY = {
    ADD_ATTR: ['alttext'],
    // TeX like `f:\mathbb{R}` looks like a URL scheme and would otherwise be stripped.
    ADD_URI_SAFE_ATTR: ['alttext'],
    FORBID_TAGS: ['style', 'link', 'meta', 'base', 'iframe', 'frame', 'frameset', 'object', 'embed', 'form',
      'input', 'button', 'select', 'option', 'textarea', 'fieldset', 'dialog', 'template', 'noscript',
      'video', 'audio', 'canvas', 'nav'],
    ADD_FORBID_CONTENTS: ['annotation', 'annotation-xml', 'nav', 'button', 'select', 'textarea'],
    FORBID_ATTR: ['style', 'class', 'bgcolor', 'color', 'background', 'face', 'align', 'valign', 'border',
      'cellpadding', 'cellspacing', 'autoplay', 'tabindex', 'contenteditable'],
    RETURN_DOM_FRAGMENT: true,
  };

  function fallbackContent(doc) {
    const pick = doc.querySelector('main, [role="main"], article') || doc.body;
    if (!pick) return '';
    const junk = 'script, style, noscript, template, nav, header, footer, aside, form, iframe, svg, '
      + '[role="navigation"], [role="banner"], [role="contentinfo"], [role="search"], [hidden], [aria-hidden="true"]';
    pick.querySelectorAll(junk).forEach((n) => n.remove());
    return pick.innerHTML;
  }

  function extract({ html, url, title }) {
    if (typeof Readability !== 'function' || typeof DOMPurify?.sanitize !== 'function') {
      throw new ReaderError('parse', 'Bundled Readability/DOMPurify failed to load.');
    }
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const baseHref = setBase(doc, url);
    prepareMath(doc);
    const backup = doc.cloneNode(true); // Readability mutates its input.

    let parsed = null;
    try {
      parsed = new Readability(doc).parse();
    } catch (err) {
      console.warn('[murmur] Readability failed', err);
    }

    let raw = parsed?.content;
    if (!parsed || countWords(parsed.textContent) < 25) {
      raw = fallbackContent(backup);
      parsed = null;
    }
    const frag = DOMPurify.sanitize(raw || '', PURIFY);
    if (!frag || countWords(frag.textContent) === 0) throw new ReaderError('parse');

    const host = safeHost(url);
    const meta = {
      url,
      title: (parsed?.title || title || backup.title || host || 'Untitled').trim(),
      byline: cleanByline(parsed?.byline),
      siteName: (parsed?.siteName || host || '').trim(),
      published: parsed?.publishedTime || '',
      lang: parsed?.lang || backup.documentElement.getAttribute('lang') || '',
      dir: parsed?.dir || backup.documentElement.getAttribute('dir') || '',
    };
    polish(frag, { pageUrl: url, baseHref, title: meta.title });
    return { meta, frag };
  }

  function safeHost(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
  }

  function cleanByline(byline) {
    const s = String(byline || '').replace(/\s+/g, ' ').trim().replace(/^by\s+/i, '');
    return s && s.length <= 140 ? s : '';
  }

  function stripHash(u) {
    return u.split('#')[0];
  }

  // Runs on sanitized nodes only, and only writes values we compute ourselves.
  function polish(frag, { pageUrl, baseHref, title }) {
    const base = baseHref || pageUrl;

    // Namespace source ids so they can't collide with the reader's own (#article, #title, …).
    const ids = new Set();
    for (const el of frag.querySelectorAll('[id]')) {
      el.id = `m-${el.id}`;
      ids.add(el.id);
    }
    for (const a of frag.querySelectorAll('a[name]:not([id])')) {
      a.id = `m-${a.getAttribute('name')}`;
      ids.add(a.id);
    }

    const here = new Set([stripHash(pageUrl), stripHash(base)]);
    for (const a of frag.querySelectorAll('a[href]')) {
      const href = absolutize(a.getAttribute('href'), base);
      const hashAt = href.indexOf('#');
      if (hashAt >= 0 && here.has(href.slice(0, hashAt))) {
        let id = href.slice(hashAt + 1);
        try { id = decodeURIComponent(id); } catch { /* keep raw */ }
        if (ids.has(`m-${id}`)) {
          a.setAttribute('href', `#m-${encodeURIComponent(id)}`);
          continue;
        }
      }
      if (!LINK_SCHEMES.test(href)) {
        a.removeAttribute('href');
        continue;
      }
      a.setAttribute('href', href);
      // setAttribute, not .target/.rel: SVG <a> exposes those as read-only.
      if (/^https?:/i.test(href)) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      }
    }

    for (const el of frag.querySelectorAll('img[src], source[src]')) {
      const src = absolutize(el.getAttribute('src'), base);
      if (isSafeImageUrl(src)) el.setAttribute('src', src);
      else el.removeAttribute('src');
    }
    for (const el of frag.querySelectorAll('img[srcset], source[srcset]')) {
      const srcset = absolutizeSrcset(el.getAttribute('srcset'), base);
      if (srcset) el.setAttribute('srcset', srcset);
      else el.removeAttribute('srcset');
    }
    // Lazy-load placeholders that never got a real URL.
    for (const img of frag.querySelectorAll('img:not([src]):not([srcset])')) if (!img.closest('picture')) img.remove();
    for (const img of frag.querySelectorAll('img')) {
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
    }

    // Inline SVG without a size renders at 300×150; size it from its viewBox or drop it.
    for (const svg of frag.querySelectorAll('svg')) {
      if (svg.parentElement?.closest('svg')) continue;
      const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
      if (!svg.getAttribute('width') && vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
        svg.setAttribute('width', String(vb[2]));
        svg.setAttribute('height', String(vb[3]));
      } else if (!svg.getAttribute('width') && !svg.getAttribute('height')) {
        svg.remove();
      }
    }

    for (const table of frag.querySelectorAll('table')) {
      if (table.parentElement?.closest('table')) continue;
      const wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      wrap.tabIndex = 0; // scrollable regions must be keyboard reachable
      table.replaceWith(wrap);
      wrap.append(table);
    }

    // Readability usually drops a heading that repeats the title, the fallback path doesn't.
    const firstHeading = frag.querySelector('h1, h2');
    if (firstHeading && normalizeText(firstHeading.textContent) === normalizeText(title)) firstHeading.remove();

    for (const p of frag.querySelectorAll('p')) {
      if (!p.textContent.trim() && !p.querySelector('img, picture, math, svg')) p.remove();
    }
  }

  function normalizeText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  // ---------- rendering ----------

  function showState(which) {
    $('state').hidden = which === 'doc';
    $('doc').hidden = which !== 'doc';
    $('state-loading').hidden = which !== 'loading';
    $('state-error').hidden = which !== 'error';
    $('state-paste').hidden = which !== 'paste';
  }

  function showError(err) {
    const kind = err instanceof ReaderError ? err.kind : 'parse';
    if (kind === 'no-tab') {
      showPaste(false);
      return;
    }
    const [title, body] = ERROR_COPY[kind] || ERROR_COPY.parse;
    $('error-title').textContent = title;
    $('error-body').textContent = body;
    $('error-detail').textContent = err instanceof ReaderError ? err.detail : String(err?.message || err || '');
    $('retry').hidden = kind === 'gone' || kind === 'restricted';
    document.title = 'Murmur Reader';
    showState('error');
  }

  function showPaste(focus = true) {
    showState('paste');
    if (focus) $('paste-text').focus();
  }

  function formatDate(value) {
    const d = new Date(value);
    if (!value || Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric' }).format(d);
  }

  function render({ meta, frag }) {
    setCurrentBlock(null);
    content.replaceChildren(frag);
    $('title').textContent = meta.title;
    document.title = meta.title;
    $('site-name').textContent = meta.siteName;
    $('site-name').hidden = !meta.siteName;

    const by = [meta.byline, formatDate(meta.published)].filter(Boolean).join(' · ');
    $('byline').textContent = by;
    $('byline').hidden = !by;

    const words = countWords(content.textContent);
    $('stats').textContent = `${words.toLocaleString()} words · ${listenMinutes(words)} min listen`;

    if (meta.lang) article.lang = meta.lang; else article.removeAttribute('lang');
    if (meta.dir === 'rtl' || meta.dir === 'ltr') article.dir = meta.dir; else article.removeAttribute('dir');

    const host = safeHost(meta.url);
    const source = $('source-link');
    const footer = $('footer-source');
    if (/^https?:/i.test(meta.url)) {
      source.href = meta.url;
      footer.href = meta.url;
      footer.hidden = false;
    } else {
      source.removeAttribute('href');
      footer.hidden = true;
    }
    $('source-host').textContent = host || 'Murmur Reader';

    showState('doc');
    $('listen').disabled = false;
    window.scrollTo(0, 0);
  }

  function renderPasted(text) {
    const paras = textToParagraphs(text);
    if (!paras.length) return;
    const frag = document.createDocumentFragment();
    for (const t of paras) {
      const p = document.createElement('p');
      p.textContent = t;
      frag.append(p);
    }
    render({ meta: { url: '', title: 'Pasted text', byline: '', siteName: '', published: '', lang: '', dir: '' }, frag });
  }

  async function load() {
    showState('loading');
    let page;
    try {
      page = await fetchSource();
    } catch (err) {
      showError(err);
      return;
    }
    try {
      render(extract(page));
    } catch (err) {
      console.error('[murmur] reader extraction failed', err);
      showError(err instanceof ReaderError ? err : new ReaderError('parse', err?.message));
    }
  }

  // ---------- listening ----------

  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, 3500);
  }

  function listen() {
    const reader = globalThis.Murmur?.reader;
    if (typeof reader?.start !== 'function') {
      toast('The read-aloud engine didn’t load. Try reloading this page.');
      return;
    }
    try {
      if (reader.isActive?.()) reader.toggle();
      else reader.start({ mode: 'page', root: document.querySelector('#article') });
    } catch (err) {
      console.error('[murmur] start failed', err);
      toast('Couldn’t start reading. Is the Murmur server running?');
    }
  }

  // ---------- focus mode ----------

  // The read-aloud engine dispatches `murmur:sentence` with {range}; null clears.
  const BLOCKS = 'p, li, blockquote, pre, figure, figcaption, h1, h2, h3, h4, h5, h6, dt, dd, td, th, caption';
  let currentBlock = null;
  let currentPath = [];
  let idleCheck = 0;

  function setCurrentBlock(block) {
    if (block === currentBlock) return;
    currentBlock?.classList.remove('is-current');
    for (const el of currentPath) el.classList.remove('is-current-path');
    currentBlock = block;
    currentPath = [];
    if (block) {
      block.classList.add('is-current');
      for (let el = block.parentElement; el && el !== article; el = el.parentElement) {
        el.classList.add('is-current-path');
        currentPath.push(el);
      }
    }
    article.classList.toggle('has-current', !!block);
    // The engine has no "ended" event; undim once it reports it is no longer active.
    clearInterval(idleCheck);
    if (block) {
      idleCheck = setInterval(() => {
        if (!globalThis.Murmur?.reader?.isActive?.()) setCurrentBlock(null);
      }, 1000);
    }
  }

  document.addEventListener('murmur:sentence', (e) => {
    const range = e.detail?.range;
    const node = range?.startContainer;
    const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    const block = el?.closest(BLOCKS);
    setCurrentBlock(block && article.contains(block) ? block : null);
  });

  // ---------- chrome ----------

  function wireToolbar() {
    const bar = $('toolbar');
    let lastY = window.scrollY;
    let ticking = false;
    window.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const y = window.scrollY;
        const settingsOpen = $('settings').matches(':popover-open');
        if (y > lastY + 6 && y > 120 && !settingsOpen) bar.classList.add('is-hidden');
        else if (y < lastY - 6 || y < 120) bar.classList.remove('is-hidden');
        bar.classList.toggle('is-scrolled', y > 8);
        lastY = y;
        ticking = false;
      });
    }, { passive: true });
    bar.addEventListener('focusin', () => bar.classList.remove('is-hidden'));

    // Mirror the big Listen button into the toolbar once it scrolls away.
    const mini = $('listen-mini');
    new IntersectionObserver(([entry]) => {
      mini.hidden = entry.isIntersecting || $('doc').hidden;
    }, { rootMargin: '-56px 0px 0px 0px' }).observe($('listen'));
  }

  function wireControls() {
    $('listen').addEventListener('click', listen);
    $('listen-mini').addEventListener('click', listen);
    $('focus-toggle').addEventListener('click', () => setPrefs({ focus: !prefs.focus }));
    $('settings').addEventListener('change', (e) => {
      const { name, value } = e.target;
      if (name === 'theme' || name === 'font' || name === 'width') setPrefs({ [name]: value });
    });
    for (const btn of document.querySelectorAll('[data-step]')) {
      btn.addEventListener('click', () => {
        const key = btn.dataset.step;
        setPrefs({ [key]: stepIn(key === 'size' ? SIZES : LEADINGS, prefs[key], +btn.dataset.dir) });
      });
    }
    $('retry').addEventListener('click', load);
    $('paste-open').addEventListener('click', () => showPaste());
    $('state-paste').addEventListener('submit', (e) => {
      e.preventDefault();
      renderPasted($('paste-text').value);
    });

    // Hide images that fail to load (hotlink protection, expired signed URLs) rather than showing broken icons.
    content.addEventListener('error', (e) => {
      if (e.target instanceof HTMLImageElement) {
        const fig = e.target.closest('figure');
        (fig && fig.querySelectorAll('img').length === 1 ? fig : e.target).hidden = true;
      }
    }, true);
  }

  async function init() {
    wireControls();
    wireToolbar();
    await loadPrefs();
    root.dataset.ready = '';
    await load();
  }

  init();
})();
