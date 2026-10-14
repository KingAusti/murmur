import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

await import('../lib/segment.js');
await import('../lib/normalize.js');
await import('../lib/align.js');
const { align } = globalThis.Murmur.align;
const { normalize } = globalThis.Murmur.normalize;
const { splitSentences } = globalThis.Murmur.segment;

const ALNUM = /[\p{L}\p{N}]/u;

// normWords straight from a raw string, using the contract's token rule (no substitutions).
function rawWords(text) {
  const out = [];
  for (const m of text.matchAll(/\S+/g)) {
    const lead = m[0].match(/^[^\p{L}\p{N}$€£¥#]*/u)[0].length;
    const trail = m[0].slice(lead).match(/[^\p{L}\p{N}\p{M}%°]*$/u)[0].length;
    const srcStart = m.index + lead, srcEnd = m.index + m[0].length - trail;
    if (srcEnd > srcStart && ALNUM.test(text.slice(srcStart, srcEnd))) out.push({ text: text.slice(srcStart, srcEnd), srcStart, srcEnd });
  }
  return out;
}

// Server tokens with evenly spaced timings: token i spans [i*0.2, i*0.2 + 0.15].
const timed = (tokens) => tokens.map((t, i) => ({ t, s: +(i * 0.2).toFixed(3), e: +(i * 0.2 + 0.15).toFixed(3) }));
const S = (i) => +(i * 0.2).toFixed(3);
const E = (i) => +(i * 0.2 + 0.15).toFixed(3);

function assertMonotonic(res) {
  for (let i = 0; i < res.length; i++) {
    assert.ok(res[i].e >= res[i].s, `e >= s at ${i}`);
    if (i) assert.ok(res[i].s >= res[i - 1].s, `monotonic s at ${i}`);
  }
}

// Real misaki token shapes observed from the server.
const FIX1 = 'A well-known result (see Fig. 3) costs $20.50, i.e., 3.5% of 1,250 units.';
const FIX1_TOKENS = ['A', 'well-known', 'result', '(', 'see', 'Fig', '.', '3', ')', 'costs', '$', '20.50', ',', 'i.e.', ',', '3.5%', 'of', '1,250', 'units', '.'];
const FIX2 = "Dr. Smith's 2nd study—published in 1998—used CO2 & H2O at 25°C…";
const FIX2_TOKENS = ['Dr.', "Smith's", '2nd', 'study', '—', 'published', 'in', '1998', '—', 'used', 'CO2', '&', 'H', '2', 'O', 'at', '25°C', '…'];

test('real tokens: punctuation, "$" split, "i.e." kept whole', () => {
  const words = rawWords(FIX1);
  const res = align(timed(FIX1_TOKENS), words);
  assert.ok(res);
  assert.equal(res.length, words.length);
  // word → [first token index, last token index]
  const expect = {
    A: [0, 0], 'well-known': [1, 1], result: [2, 2], see: [4, 4], Fig: [5, 5], 3: [7, 7], costs: [9, 9],
    '$20.50': [11, 11], 'i.e': [13, 13], '3.5%': [15, 15], of: [16, 16], '1,250': [17, 17], units: [18, 18],
  };
  res.forEach((r, i) => {
    const src = FIX1.slice(r.srcStart, r.srcEnd);
    assert.equal(src, words[i].text);
    const [a, b] = expect[src];
    assert.deepEqual([r.s, r.e], [S(a), E(b)], src);
  });
});

test('real tokens: em-dash joined words and split chemical formula', () => {
  const words = rawWords(FIX2);
  const res = align(timed(FIX2_TOKENS), words);
  assert.ok(res);
  assert.equal(res.length, words.length);
  const expect = {
    Dr: [0, 0], "Smith's": [1, 1], '2nd': [2, 2], 'study—published': [3, 5], in: [6, 6], '1998—used': [7, 9],
    CO2: [10, 10], H2O: [12, 14], at: [15, 15], '25°C': [16, 16],
  };
  res.forEach((r) => {
    const src = FIX2.slice(r.srcStart, r.srcEnd);
    assert.ok(expect[src], `unexpected word ${src}`);
    assert.deepEqual([r.s, r.e], [S(expect[src][0]), E(expect[src][1])], src);
  });
});

test('timed punctuation never stretches a word', () => {
  const words = rawWords('See Fig. 3.');
  const res = align([
    { t: 'See', s: 0, e: 0.2 }, { t: 'Fig', s: 0.2, e: 0.5 }, { t: '.', s: 0.5, e: 0.9 },
    { t: '3', s: 0.9, e: 1.1 }, { t: '.', s: 1.1, e: 1.6 },
  ], words);
  assert.deepEqual(res.map((r) => [r.s, r.e]), [[0, 0.2], [0.2, 0.5], [0.9, 1.1]]);
});

test('normalize → server tokens of the spoken string → source spans', () => {
  const { spoken, words } = normalize(FIX1);
  assert.equal(spoken, 'A well-known result (see Figure 3) costs $20.50, that is, 3.5% of 1,250 units.');
  const tokens = ['A', 'well-known', 'result', '(', 'see', 'Figure', '3', ')', 'costs', '$', '20.50', ',', 'that', 'is', ',', '3.5%', 'of', '1,250', 'units', '.'];
  const res = align(timed(tokens), words);
  assert.ok(res);
  assert.equal(res.length, words.length, 'one entry per normWord');
  const srcs = res.map((r) => FIX1.slice(r.srcStart, r.srcEnd));
  assert.deepEqual(srcs, ['A', 'well-known', 'result', 'see', 'Fig.', '3', 'costs', '$20.50', 'i.e.', 'i.e.', '3.5%', 'of', '1,250', 'units']);
  // "that" and "is" both highlight "i.e." for their own time slices.
  assert.deepEqual([res[8].s, res[8].e, res[9].s, res[9].e], [S(12), E(12), S(13), E(13)]);
});

test('server drops a word: the rest still align', () => {
  const words = rawWords('This is a very big deal for us.');
  const res = align(timed(['This', 'is', 'a', 'big', 'deal', 'for', 'us', '.']), words);
  assert.ok(res);
  const got = Object.fromEntries(res.map((r) => [words.find((w) => w.srcStart === r.srcStart).text, r.s]));
  assert.equal(got.very, undefined);
  assert.equal(got.big, S(3));
  assert.equal(got.us, S(6));
});

test('server adds a token: it does not steal timing', () => {
  const words = rawWords('The big deal is here now.');
  const res = align(timed(['The', 'um', 'big', 'deal', 'is', 'here', 'now', '.']), words);
  assert.ok(res);
  assert.equal(res.length, words.length);
  assert.deepEqual(res.map((r) => r.s), [0, 2, 3, 4, 5, 6].map(S));
});

test('small spelling mismatch resyncs', () => {
  const words = rawWords('The colour of the sky is blue today.');
  const res = align(timed(['The', 'color', 'of', 'the', 'sky', 'is', 'blue', 'today', '.']), words);
  assert.ok(res);
  assert.equal(res.length, words.length);
  assert.deepEqual(res.map((r) => r.s), [0, 1, 2, 3, 4, 5, 6, 7].map(S));
});

test('a token spanning two words splits its time by characters', () => {
  const words = rawWords('New York');
  const res = align([{ t: 'NewYork', s: 0, e: 0.7 }], words);
  assert.deepEqual(res.map((r) => [r.s, r.e]), [[0, 0.3], [0.3, 0.7]]);
});

test('tokens without timings are ignored', () => {
  const words = rawWords('One two three.');
  const res = align([{ t: 'One', s: 0, e: 0.2 }, { t: 'two', s: null, e: null }, { t: 'two', s: 0.3, e: 0.5 }, { t: 'three' , s: 0.6, e: 0.9 }], words);
  assert.deepEqual(res.map((r) => [r.s, r.e]), [[0, 0.2], [0.3, 0.5], [0.6, 0.9]]);
});

test('start times are clamped to never decrease', () => {
  const words = rawWords('alpha beta');
  const res = align([{ t: 'alpha', s: 1, e: 1.2 }, { t: 'beta', s: 0.5, e: 0.7 }], words);
  assert.deepEqual(res.map((r) => [r.s, r.e]), [[1, 1.2], [1, 1]]);
});

test('below 60% coverage returns null; edge inputs', () => {
  const words = rawWords('Completely different sentence about cats.');
  assert.equal(align(timed(['Nothing', 'in', 'common', 'here', '.']), words), null);
  assert.equal(align([], words), null);
  assert.equal(align(undefined, words), null);
  assert.deepEqual(align(timed(['hello']), []), []);
  // 3 of 5 words timed = 60% → still accepted.
  const five = rawWords('one two three four five');
  assert.equal(align(timed(['one', 'two', 'three']), five).length, 3);
  assert.equal(align(timed(['one', 'two']), five), null);
});

// ── Property-style: normalize → fake misaki tokens of `spoken` → align ────

const SAMPLES = [
  'As shown by Smith et al. (2019), the effect in Fig. 3 is large (Smith & Lee, 2020; Wu, 2021).',
  'Dr. Smith agreed with the findings [3–5, 8] but questioned the method.',
  'See p. 34 for e.g. details, i.e. more on the topic.',
  'The U.S. government said so (Smith et al., 2019, p. 34).',
  'J. R. R. Tolkien wrote The Hobbit, The Lord of the Rings, etc.',
  'Visit https://example.com/path?q=1 or email help@uni.edu for help.',
  'A well-known result (see Fig. 3) costs $20.50, i.e., 3.5% of 1,250 units.',
  "Dr. Smith's 2nd study—published in 1998—used CO2 & H2O at 25°C…",
  'Mitochondria, approx. 0.5–10 μm in length, produce ATP via oxidative phosphorylation.',
  'Compare Eqs. 4–6 with Sec. 2.1 and Ch. IV of Vol. 3, cf. Ref. 12.',
  '“Is it true?” she asked—and nobody answered.',
  'The p-value was < 0.05; thus, H₀ was rejected (n = 1,024).',
  'In 1776, the Declaration of Independence was signed in Philadelphia, Pennsylvania.',
  'Item No. 5 costs €12 and weighs 3 kg vs. item No. 6 at 4 kg.',
  'The café’s naïve coöperation surprised everyone at the São Paulo conference.',
  'Photosynthesis converts light energy into chemical energy stored in glucose (C6H12O6).',
  'Students should read Chapter 3 before Monday\'s lecture; quizzes start Week 2.',
  'Newton’s second law, F = ma, relates force, mass, and acceleration [1].',
  'Built ca. 1500 by monks, the abbey (see Fig. S2) still stands today.',
  'O’Brien and McDonald (2018) disagreed with van der Berg (2015) about the data.',
  'He scored 98% on the exam—an all-time high—and earned an A+.',
  'Use the formula x² + y² = r² for circles centered at the origin.',
];

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Roughly how misaki splits: punctuation peeled off both ends, dashes inside words split out.
function fakeTokens(spoken) {
  const out = [];
  for (const chunk of spoken.split(' ')) {
    const lead = chunk.match(/^[^\p{L}\p{N}]*/u)[0];
    const trail = chunk.slice(lead.length).match(/[^\p{L}\p{N}%°]*$/u)[0];
    const core = chunk.slice(lead.length, chunk.length - trail.length);
    for (const c of lead) out.push(c);
    if (core) for (const part of core.split(/([—–])/)) if (part) out.push(part);
    for (const c of trail) out.push(c);
  }
  return out;
}

const PERTURB = {
  splitMixed: (toks) => toks.flatMap((t) => (/\p{L}/u.test(t) && /\p{N}/u.test(t) ? t.match(/\p{L}+|\p{N}+|[^\p{L}\p{N}]+/gu) : [t])),
  dropOne: (toks, rnd) => {
    const idx = toks.map((t, i) => (ALNUM.test(t) ? i : -1)).filter((i) => i >= 0);
    const k = idx[Math.floor(rnd() * idx.length)];
    return toks.filter((_, i) => i !== k);
  },
  insertOne: (toks, rnd) => {
    const k = Math.floor(rnd() * (toks.length + 1));
    return [...toks.slice(0, k), 'um', ...toks.slice(k)];
  },
  typo: (toks, rnd) => {
    const idx = toks.map((t, i) => (/\p{L}{4,}/u.test(t) ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) return toks;
    const k = idx[Math.floor(rnd() * idx.length)];
    return toks.map((t, i) => (i === k ? t.replace(/\p{L}(?=\p{L}*$)/u, 'q') : t));
  },
};

test('property: every sample aligns 1:1 with ideal tokens', () => {
  for (const text of SAMPLES) {
    for (const { start, end } of splitSentences(text)) {
      const sentence = text.slice(start, end);
      const { spoken, words } = normalize(sentence);
      const tokens = fakeTokens(spoken);
      const res = align(timed(tokens), words);
      assert.ok(res, `null for: ${spoken}`);
      assert.equal(res.length, words.length, spoken);
      res.forEach((r, i) => {
        assert.equal(r.srcStart, words[i].srcStart);
        assert.equal(r.srcEnd, words[i].srcEnd);
      });
      assertMonotonic(res);
    }
  }
});

test('property: perturbed tokens still align with monotonic timing', () => {
  const rnd = mulberry32(42);
  for (const text of SAMPLES) {
    const { spoken, words } = normalize(text);
    for (const [name, fn] of Object.entries(PERTURB)) {
      for (let rep = 0; rep < 5; rep++) {
        const tokens = fn(fakeTokens(spoken), rnd);
        const res = align(timed(tokens), words);
        assert.ok(res, `${name}: null for ${spoken} / ${tokens.join('|')}`);
        assertMonotonic(res);
        // Entries keep word order and map to real words.
        let w = 0;
        for (const r of res) {
          while (w < words.length && words[w].srcStart !== r.srcStart) w++;
          assert.ok(w < words.length, `${name}: entry out of order`);
          w++;
        }
        const minimum = name === 'splitMixed' ? words.length : words.length - 2;
        assert.ok(res.length >= minimum, `${name}: only ${res.length}/${words.length} for ${spoken} / ${tokens.join('|')}`);
      }
    }
  }
});

test('classic-script semantics: safe to run twice in one context', () => {
  const ctx = vm.createContext({});
  for (const f of ['segment', 'normalize', 'align', 'segment', 'normalize', 'align']) {
    vm.runInContext(readFileSync(new URL(`../lib/${f}.js`, import.meta.url), 'utf8'), ctx);
  }
  assert.equal(vm.runInContext('Murmur.align.align([{t:"hi",s:0,e:1}],[{text:"hi",srcStart:0,srcEnd:2}]).length', ctx), 1);
});

// ── Adversarial (review) ──────────────────────────────────────────────────

test('server drops a long run (> lookahead): later words still align', () => {
  const text = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau';
  const words = rawWords(text);
  const kept = words.filter((_, i) => i < 3 || i > 8).map((w) => w.text);
  const res = align(timed(kept), words);
  assert.ok(res, 'not null');
  assert.deepEqual(res.map((r) => text.slice(r.srcStart, r.srcEnd)), kept);
  assertMonotonic(res);
});

test('tokens with a missing t are ignored, not read as "undefined"', () => {
  const words = rawWords('undefined hello');
  const res = align([{ s: 0, e: 0.1 }, { t: 'undefined', s: 0.2, e: 0.3 }, { t: 'hello', s: 0.4, e: 0.5 }], words);
  assert.deepEqual(res.map((r) => r.s), [0.2, 0.4]);
});

test('accented words align whether composed or decomposed on either side', () => {
  const words = rawWords('cafe\u0301 au lait');
  const res = align(timed(['café', 'au', 'lait']), words);
  assert.deepEqual(res.map((r) => r.s), [S(0), S(1), S(2)]);
});

test('totally unrelated tokens: null, and fast', () => {
  const words = rawWords('the quick brown fox jumps over the lazy dog '.repeat(30));
  const t0 = performance.now();
  assert.equal(align(timed('lorem ipsum dolor sit amet consectetur '.repeat(40).trim().split(' ')), words), null);
  assert.ok(performance.now() - t0 < 200);
});
