// Speech normalization with a source map back to the original text.
// Classic script: attaches to globalThis.Murmur. Contract: docs/ARCHITECTURE.md → Murmur.normalize.normalize.
(function () {
  'use strict';
  const M = (globalThis.Murmur = globalThis.Murmur || {});
  if (M.normalize) return;

  // ── Citations ────────────────────────────────────────────────────────────
  // Leading \s* is part of the match so "result [12]." becomes "result.". The (?<!\s) keeps long
  // whitespace runs from making every pattern quadratic.
  const NUM_CITE = /(?<!\s)\s*\[\s*\d+[a-z]?(?:\s*[-–—,]\s*\d+[a-z]?)*\s*\]/gu;

  const NAME = String.raw`(?:(?:van|von|de|der|den|du|da|di|la|le)\s+)*\p{Lu}[\p{L}'’\-]+`;
  const AUTHORS = String.raw`${NAME}(?:\s+et\s+al\.?|(?:\s*,\s*${NAME})*,?\s+(?:and|&)\s+${NAME})?`;
  const YEAR = String.raw`(?:(?:1[5-9]|20)\d{2}[a-z]?|n\.d\.|in\s+press)`;
  const LOCATOR = String.raw`,\s*(?:pp?|chap|ch|sec)\.\s*\d+(?:\s*[-–]\s*\d+)?`;
  const ONE_CITE = String.raw`(?:(?:see\s+also|see|e\.g\.,?|cf\.)\s+)?${AUTHORS}(?:,|(?<=\bal\.?))\s*${YEAR}(?:\s*,\s*${YEAR})*(?:${LOCATOR})?`;
  // A comma (or "et al.") before the year is required, so "(March 2020)" or "(In 2019)" survive.
  const PAREN_CITE = new RegExp(String.raw`(?<!\s)\s*\(${ONE_CITE}(?:\s*;\s*${ONE_CITE})*\)`, 'gu');

  // ── URLs and emails ──────────────────────────────────────────────────────
  const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+|(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu;
  // Sentence punctuation glued to the end of a URL isn't part of it; keep ")" only if it closes one the URL opened.
  function trimUrl(s) {
    let open = s.split('(').length - 1, close = s.split(')').length - 1;
    let end = s.length;
    while (end > 0) {
      const c = s[end - 1];
      if (/[.,;:!?'"\]}>]/.test(c)) end--;
      else if (c === ')' && close > open) end--, close--;
      else break;
    }
    return end;
  }

  // ── Substitutions ────────────────────────────────────────────────────────
  // Labels only expand when a reference follows: "Fig. 3", "Ch. IV", "Fig. S2", "Eq. (4)".
  const REF = String.raw`(?=\s*\(?(?:\d|[IVXLC]+\b|[ivx]+\b|\p{Lu}\d))`;
  const DIGIT = String.raw`(?=\s*\d)`;
  const rx = (src, flags = '') => new RegExp(src, 'gu' + flags);

  const SUBS = [
    [rx(String.raw`\be\.g\.(?!\w)`, 'i'), 'for example'],
    [rx(String.raw`\bi\.e\.(?!\w)`, 'i'), 'that is'],
    [rx(String.raw`\bet\s+al(?:\.|\b)`), 'and colleagues'],
    [rx(String.raw`\bcf\.(?!\w)`, 'i'), 'compare'],
    [rx(String.raw`\betc\.(?!\w)`, 'i'), 'et cetera'],
    [rx(String.raw`\b[Vv]s\.(?!\w)`), 'versus'],
    [rx(String.raw`\bvs(?=\s)`), 'versus'], // dotless only in lowercase: "VS Code" stays
    [rx(String.raw`\bapprox\.(?!\w)`, 'i'), 'approximately'],
    [rx(String.raw`\bca\.${DIGIT}`), 'about'],
    [rx(String.raw`\bFigs\.${REF}`, 'i'), 'Figures'],
    [rx(String.raw`\bFig\.${REF}`, 'i'), 'Figure'],
    [rx(String.raw`\bEqs\.${REF}`, 'i'), 'Equations'],
    [rx(String.raw`\bEq\.${REF}`, 'i'), 'Equation'],
    [rx(String.raw`\bSec\.${REF}`, 'i'), 'Section'],
    [rx(String.raw`\bCh\.${REF}`, 'i'), 'Chapter'],
    [rx(String.raw`\bVol\.${REF}`, 'i'), 'Volume'],
    [rx(String.raw`\bNo\.${DIGIT}`, 'i'), 'Number'],
    [rx(String.raw`\bpp\.${DIGIT}`), 'pages'],
    [rx(String.raw`\bp\.${DIGIT}`), 'page'],
  ];

  const INVISIBLE = /[­​-‍⁠﻿]/;
  const ALNUM = /[\p{L}\p{N}]/u;
  const LEAD_JUNK = /^[^\p{L}\p{N}$€£¥#]+/u;
  const TRAIL_JUNK = /[^\p{L}\p{N}\p{M}%°]+$/u; // \p{M}: keep a decomposed accent (e + U+0301)

  // All rule matches, earliest first; on equal start, the earlier rule wins. Overlaps are dropped.
  function findEdits(text, skipCitations) {
    const rules = [];
    if (skipCitations) rules.push([NUM_CITE, ''], [PAREN_CITE, '']);
    rules.push([URL_RE, 'link', trimUrl], ...SUBS);

    const found = [];
    rules.forEach(([re, rep, fix], prio) => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const len = fix ? fix(m[0]) : m[0].length;
        if (len > 0) found.push({ start: m.index, end: m.index + len, rep, prio });
        if (!m[0].length) re.lastIndex++;
      }
    });
    found.sort((a, b) => a.start - b.start || a.prio - b.prio);

    const edits = [];
    let pos = 0;
    for (const f of found) if (f.start >= pos) edits.push(f), (pos = f.end);
    return edits;
  }

  function normalize(text, opts) {
    const skipCitations = !opts || opts.skipCitations !== false;
    text = String(text || '');

    // Spoken string as parallel per-char arrays so every output char keeps its source span.
    const ch = [], ss = [], se = [];
    const push = (c, s, e) => {
      if (/\s/.test(c)) {
        if (!ch.length || ch[ch.length - 1] === ' ') return; // collapse + left-trim
        c = ' ';
      }
      ch.push(c), ss.push(s), se.push(e);
    };

    let i = 0;
    for (const ed of findEdits(text, skipCitations)) {
      for (; i < ed.start; i++) if (!INVISIBLE.test(text[i])) push(text[i], i, i + 1);
      let rep = ed.rep;
      if (!rep) {
        // A deletion must not fuse the neighbouring words together.
        const prev = ch[ch.length - 1];
        if (prev && ALNUM.test(prev) && ALNUM.test(text[ed.end] || '')) push(' ', ed.start, ed.end);
      } else if (text[ed.end - 1] === '.' && !text.slice(ed.end).trim()) {
        rep += '.'; // "…, etc." at the very end keeps its full stop
      }
      for (const c of rep) push(c, ed.start, ed.end);
      i = ed.end;
    }
    for (; i < text.length; i++) if (!INVISIBLE.test(text[i])) push(text[i], i, i + 1);
    while (ch.length && ch[ch.length - 1] === ' ') ch.pop(), ss.pop(), se.pop();

    const spoken = ch.join('');
    const words = [];
    const run = /\S+/g;
    let m;
    while ((m = run.exec(spoken))) {
      const tok = m[0];
      const lead = (LEAD_JUNK.exec(tok) || [''])[0].length;
      const core = tok.slice(lead);
      const trail = (TRAIL_JUNK.exec(core) || [''])[0].length;
      const a = m.index + lead;
      const b = m.index + tok.length - trail;
      if (b <= a || !ALNUM.test(spoken.slice(a, b))) continue;
      let srcStart = Infinity, srcEnd = -Infinity;
      for (let k = a; k < b; k++) {
        if (ss[k] < srcStart) srcStart = ss[k];
        if (se[k] > srcEnd) srcEnd = se[k];
      }
      words.push({ text: spoken.slice(a, b), srcStart, srcEnd });
    }

    return words.length ? { spoken, words } : { spoken: '', words: [] };
  }

  M.normalize = { normalize };
})();
