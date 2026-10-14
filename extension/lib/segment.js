// Sentence splitting for read-aloud. Classic script: attaches to globalThis.Murmur.
// Contract: docs/ARCHITECTURE.md → Murmur.segment.splitSentences.
(function () {
  'use strict';
  const M = (globalThis.Murmur = globalThis.Murmur || {});
  if (M.segment) return;

  const MAX_LEN = 300;
  const MIN_PIECE = 40;
  const TAIL = 64; // chars of the previous segment that shouldMerge looks at
  const HARD_BREAK = /\n[^\S\n]*\n\s*/g; // blank line (optionally with trailing spaces) = paragraph boundary

  // Lowercased, without trailing dot. Matched against the last word of a segment.
  // "No." is left out on purpose ("the answer is no."); "No. 5" is caught by the digit rule.
  const ABBREV = new Set([
    'dr', 'mr', 'mrs', 'ms', 'prof', 'st', 'jr', 'sr',
    'fig', 'figs', 'eq', 'eqs', 'sec', 'ch', 'vol', 'p', 'pp', 'ref', 'refs',
    'vs', 'e.g', 'i.e', 'cf', 'approx', 'ca',
  ]);

  let segmenter = null;
  function getSegmenter() {
    return (segmenter = segmenter || new Intl.Segmenter('en', { granularity: 'sentence' }));
  }

  // Should `next` be glued onto `prev`? Both are raw segment strings (may carry whitespace).
  function shouldMerge(prev, next) {
    const n = next.trimStart();
    if (!n) return true;
    if (/^[\p{Ll}\p{N})\]]/u.test(n)) return true;

    const p = prev.trimEnd();
    if (!p.endsWith('.')) return false;
    const words = p.split(/\s+/);
    const last = words[words.length - 1].replace(/^[(\[{"'“‘]+/, '');
    const bare = last.slice(0, -1);
    if (ABBREV.has(bare.toLowerCase())) return true;
    if (bare.toLowerCase() === 'al' && (words[words.length - 2] || '').toLowerCase() === 'et') return true;
    // Initials and dotted acronyms: "J.", "R.", "U.S.", "U.S.A."
    if (/^(?:\p{Lu}\.)*\p{Lu}$/u.test(bare)) return true;
    return false;
  }

  function trimSpan(text, start, end) {
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    return start < end ? { start, end } : null;
  }

  // Best break offset inside [start, end): prefer "; " / ": " near the middle, then ", ", then any space.
  // Never breaks inside (...) or [...] (a citation cut in half would no longer be recognised and skipped)
  // or right after a "." (inside a sentence that is an abbreviation like "Fig." whose number follows).
  function findBreak(text, start, end, nested = true) {
    const len = end - start;
    const mid = start + len / 2;
    const margin = Math.max(MIN_PIECE, Math.floor(len * 0.25));
    const best = [-1, -1, -1]; // per tier
    let depth = 0;
    for (let i = start; i < end - 1; i++) {
      const c = text[i];
      if (nested && (c === '(' || c === '[')) depth++;
      else if (nested && (c === ')' || c === ']') && depth > 0) depth--;
      if (depth || !/\s/.test(text[i + 1]) || i + 1 < start + MIN_PIECE || i + 1 > end - MIN_PIECE) continue;
      let tier, at;
      if (c === ';' || c === ':') (tier = 0), (at = i + 1);
      else if (c === ',') (tier = 1), (at = i + 1);
      else if (!/[\s.]/.test(c)) (tier = 2), (at = i + 1);
      else continue;
      if (tier < 2 && (at < start + margin || at > end - margin)) continue; // punctuation must be near the middle
      if (best[tier] < 0 || Math.abs(at - mid) < Math.abs(best[tier] - mid)) best[tier] = at;
    }
    const at = best.find((x) => x >= 0) ?? -1;
    // Nothing outside brackets because one never closes: ignore nesting rather than read 1000+ chars at once.
    // A balanced long citation still comes back whole, so normalize can drop it in one piece.
    return at < 0 && depth > 0 ? findBreak(text, start, end, false) : at;
  }

  function splitLong(text, span, out) {
    if (span.end - span.start <= MAX_LEN) return void out.push(span);
    const at = findBreak(text, span.start, span.end);
    const a = at < 0 ? null : trimSpan(text, span.start, at);
    const b = at < 0 ? null : trimSpan(text, at, span.end);
    if (!a || !b || a.end - a.start < MIN_PIECE || b.end - b.start < MIN_PIECE) return void out.push(span);
    splitLong(text, a, out);
    splitLong(text, b, out);
  }

  function splitBlock(text, blockStart, blockEnd, out) {
    // Single newlines are soft wraps: mask them so ICU doesn't break there. Same length → same offsets.
    const block = text.slice(blockStart, blockEnd).replace(/[\r\n]/g, ' ');
    const merged = [];
    for (const { segment, index } of getSegmenter().segment(block)) {
      const prev = merged[merged.length - 1];
      // Only the tail of prev matters; passing all of it is quadratic over long merge chains (reference lists).
      if (prev && shouldMerge(block.slice(Math.max(prev.start, prev.end - TAIL), prev.end), segment)) {
        prev.end = index + segment.length;
      } else {
        merged.push({ start: index, end: index + segment.length });
      }
    }
    for (const seg of merged) {
      const span = trimSpan(text, blockStart + seg.start, blockStart + seg.end);
      if (span) splitLong(text, span, out);
    }
  }

  function splitSentences(text) {
    const out = [];
    if (!text) return out;
    let pos = 0;
    HARD_BREAK.lastIndex = 0;
    let m;
    while ((m = HARD_BREAK.exec(text))) {
      splitBlock(text, pos, m.index, out);
      pos = m.index + m[0].length;
    }
    splitBlock(text, pos, text.length, out);
    return out;
  }

  M.segment = { splitSentences, _shouldMerge: shouldMerge };
})();
