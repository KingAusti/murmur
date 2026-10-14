// Map the TTS server's timed tokens onto normalized words (and so onto source offsets).
// Classic script: attaches to globalThis.Murmur. Contract: docs/ARCHITECTURE.md → Murmur.align.align.
(function () {
  'use strict';
  const M = (globalThis.Murmur = globalThis.Murmur || {});
  if (M.align) return;

  const ALNUM = /[\p{L}\p{N}]/u;
  const LOOKAHEAD = 24; // max chars skipped on either side when resyncing after a mismatch
  const ANCHOR = 4; // chars that must agree for a resync point to count
  const MIN_COVERAGE = 0.6;

  const at = (tw, f) => Math.round((tw.s + (tw.e - tw.s) * f) * 1000) / 1000; // ms, like the server

  function alnumChars(s) {
    const out = [];
    for (const c of String(s).toLowerCase().normalize('NFKD')) if (ALNUM.test(c)) out.push(c);
    return out;
  }

  // serverWords: [{t, s, e}]  normWords: [{text, srcStart, srcEnd}]
  // → [{s, e, srcStart, srcEnd}] for each normWord that got timing, in order;
  //   [] for empty normWords; null when under 60% of words could be timed.
  function align(serverWords, normWords) {
    if (!Array.isArray(normWords) || !normWords.length) return [];
    if (!Array.isArray(serverWords)) return null;

    // Both sides flattened to alnum char streams, each char tagged with the word/token it came from.
    const a = [], aWord = [];
    normWords.forEach((w, k) => {
      for (const c of alnumChars(w.text)) a.push(c), aWord.push(k);
    });
    const toks = serverWords.filter((tw) => tw && Number.isFinite(tw.s) && Number.isFinite(tw.e));
    const b = [], bTok = [];
    toks.forEach((tw, k) => {
      for (const c of alnumChars(tw.t ?? '')) b.push(c), bTok.push(k); // punctuation tokens add no chars
    });

    const agree = (p, q, len = ANCHOR) => {
      const n = Math.min(len, a.length - p, b.length - q);
      if (n <= 0) return false;
      for (let x = 0; x < n; x++) if (a[p + x] !== b[q + x]) return false;
      return true;
    };

    // Smallest total skip [dp, dq] (each <= max) after which `len` chars agree, or null.
    const resync = (p, q, max, len) => {
      const maxP = Math.min(max, a.length - p - 1), maxQ = Math.min(max, b.length - q - 1);
      for (let d = 1; d <= maxP + maxQ; d++) {
        for (let j = Math.max(0, d - maxP); j <= Math.min(d, maxQ); j++) {
          if (agree(p + d - j, q + j, len)) return [d - j, j];
        }
      }
      return null;
    };

    // Greedy walk; on mismatch, resync within LOOKAHEAD, then (a long dropped or inserted run)
    // anywhere ahead with a stricter anchor, and only then treat the char as a substitution.
    const owners = toks.map(() => []);
    let p = 0, q = 0, wide = true;
    while (p < a.length && q < b.length) {
      if (a[p] === b[q]) {
        owners[bTok[q++]].push(aWord[p++]);
        continue;
      }
      let skip = resync(p, q, LOOKAHEAD, ANCHOR);
      // A failed wide search covers every later (p, q) too, so it never needs to run again.
      if (!skip && wide) (skip = resync(p, q, Infinity, 2 * ANCHOR)), (wide = !!skip);
      skip = skip || [1, 1];
      p += skip[0], q += skip[1];
    }

    const ws = new Array(normWords.length).fill(Infinity);
    const we = new Array(normWords.length).fill(-Infinity);
    toks.forEach((tw, k) => {
      const own = owners[k], n = own.length;
      // Usually one owner. If a token straddles words, split its time by character share.
      for (let i = 0; i < n; ) {
        let j = i;
        while (j < n && own[j] === own[i]) j++;
        const s = i === 0 ? tw.s : at(tw, i / n);
        const e = j === n ? tw.e : at(tw, j / n);
        const w = own[i];
        if (s < ws[w]) ws[w] = s;
        if (e > we[w]) we[w] = e;
        i = j;
      }
    });

    const out = [];
    let timed = 0, lastS = -Infinity;
    normWords.forEach((w, k) => {
      if (ws[k] === Infinity) return;
      timed++;
      const s = Math.max(ws[k], lastS);
      lastS = s;
      out.push({ s, e: Math.max(we[k], s), srcStart: w.srcStart, srcEnd: w.srcEnd });
    });
    return timed < MIN_COVERAGE * normWords.length ? null : out;
  }

  M.align = { align };
})();
