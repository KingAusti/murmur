import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

await import('../lib/normalize.js');
const { normalize } = globalThis.Murmur.normalize;

// Each word as [spokenText, exact source slice].
const pairs = (text, opts) => normalize(text, opts).words.map((w) => [w.text, text.slice(w.srcStart, w.srcEnd)]);

function assertInvariants(text, { spoken, words }) {
  assert.equal(spoken, spoken.trim());
  assert.doesNotMatch(spoken, /\s{2}|[\t\n\r ]/);
  const tokens = spoken.split(' ').map((t) => t.replace(/^[^\p{L}\p{N}$€£¥#]+|[^\p{L}\p{N}\p{M}%°]+$/gu, ''));
  assert.deepEqual(words.map((w) => w.text), tokens.filter((t) => /[\p{L}\p{N}]/u.test(t)));
  let prev = -1;
  for (const w of words) {
    assert.ok(w.srcStart >= 0 && w.srcStart < w.srcEnd && w.srcEnd <= text.length, JSON.stringify(w));
    assert.ok(w.srcStart >= prev, 'source order follows spoken order');
    prev = w.srcStart;
  }
}

test('plain text passes through with identity mapping', () => {
  const text = 'The cat sat on the mat.';
  const out = normalize(text);
  assert.equal(out.spoken, text);
  assert.deepEqual(pairs(text), ['The', 'cat', 'sat', 'on', 'the', 'mat'].map((w) => [w, w]));
  assertInvariants(text, out);
});

test('numeric bracket citations are removed', () => {
  assert.equal(normalize('A known result [12].').spoken, 'A known result.');
  assert.equal(normalize('Shown before [3–5, 8] and later [1,2].').spoken, 'Shown before and later.');
  assert.equal(normalize('Shown before [3-5] here.').spoken, 'Shown before here.');
  assert.equal(normalize('Joined word[12]next here.').spoken, 'Joined word next here.');
  // Non-numeric brackets are content.
  assert.equal(normalize('The set [a, b] is closed.').spoken, 'The set [a, b] is closed.');
});

test('author-year citations are removed', () => {
  const cases = [
    ['This holds (Smith, 2019).', 'This holds.'],
    ['This holds (Smith et al., 2019, p. 34) in general.', 'This holds in general.'],
    ['This holds (Smith & Lee, 2020; Wu, 2021).', 'This holds.'],
    ['This holds (Smith and Lee, 2020).', 'This holds.'],
    ['This holds (Smith, Jones, & Lee, 2020a).', 'This holds.'],
    ['This holds (see Smith, 2019, pp. 3–5).', 'This holds.'],
    ['This holds (e.g., Smith, 2019; O’Brien, 2018).', 'This holds.'],
    ['This holds (van der Berg, 2015).', 'This holds.'],
    ['This holds (Smith et al. 2019).', 'This holds.'],
  ];
  for (const [input, spoken] of cases) assert.equal(normalize(input).spoken, spoken, input);
});

test('parentheticals that are not citations survive', () => {
  for (const s of ['It rained (March 2020) a lot.', 'It rained (in 2019) a lot.', 'Use the (Smith) method.', 'Read (Fig. 3) now.']) {
    assert.match(normalize(s).spoken, /\(/, s);
  }
});

test('skipCitations: false keeps citations (but still expands inside them)', () => {
  const text = 'This holds (Smith et al., 2019) [12].';
  assert.equal(normalize(text, { skipCitations: false }).spoken, 'This holds (Smith and colleagues, 2019) [12].');
  assert.equal(normalize(text, {}).spoken, 'This holds.');
});

test('citation wins over substitutions inside it', () => {
  const text = 'As argued (Smith et al., 2019, p. 34), it works.';
  const out = normalize(text);
  assert.equal(out.spoken, 'As argued, it works.');
  assert.ok(!out.words.some((w) => /colleagues|page/.test(w.text)));
  assertInvariants(text, out);
});

test('citation removal keeps later offsets exact', () => {
  const text = 'Early work [4] and (Smith & Lee, 2020; Wu, 2021) later work matters.';
  const out = normalize(text);
  assert.equal(out.spoken, 'Early work and later work matters.');
  assert.deepEqual(pairs(text), [
    ['Early', 'Early'], ['work', 'work'], ['and', 'and'], ['later', 'later'], ['work', 'work'], ['matters', 'matters'],
  ]);
  assertInvariants(text, out);
});

test('Latin abbreviations', () => {
  const cases = [
    ['Fruits, e.g., apples.', 'Fruits, for example, apples.'],
    ['The prior, i.e., the belief.', 'The prior, that is, the belief.'],
    ['Smith et al. showed it.', 'Smith and colleagues showed it.'],
    ['See the proof, cf. the lemma.', 'See the proof, compare the lemma.'],
    ['Apples, pears, etc. are fruits.', 'Apples, pears, et cetera are fruits.'],
    ['Apples, pears, etc.', 'Apples, pears, et cetera.'],
    ['Nature vs. nurture.', 'Nature versus nurture.'],
    ['Nature vs nurture.', 'Nature versus nurture.'],
    ['Open it in VS Code.', 'Open it in VS Code.'],
    ['It is approx. 30 km.', 'It is approximately 30 km.'],
    ['Built ca. 1500 by monks.', 'Built about 1500 by monks.'],
    ['E.g. this one.', 'for example this one.'],
  ];
  for (const [input, spoken] of cases) assert.equal(normalize(input).spoken, spoken, input);
});

test('label abbreviations', () => {
  const cases = [
    ['See Fig. 3 now.', 'See Figure 3 now.'],
    ['See Figs. 3 and 4.', 'See Figures 3 and 4.'],
    ['See fig. 2b.', 'See Figure 2b.'],
    ['See Fig. S2.', 'See Figure S2.'],
    ['Solve Eq. (4) first.', 'Solve Equation (4) first.'],
    ['Solve Eqs. 4–6 first.', 'Solve Equations 4–6 first.'],
    ['Read Sec. 2.1 and Ch. IV of Vol. 3.', 'Read Section 2.1 and Chapter IV of Volume 3.'],
    ['Item No. 5 is gone.', 'Item Number 5 is gone.'],
    ['Turn to p. 34 and pp. 40–45.', 'Turn to page 34 and pages 40–45.'],
  ];
  for (const [input, spoken] of cases) assert.equal(normalize(input).spoken, spoken, input);
});

test('labels are left alone without a following reference', () => {
  assert.equal(normalize('The answer is No. Really.').spoken, 'The answer is No. Really.');
  assert.equal(normalize('Mr. P. Jones arrived.').spoken, 'Mr. P. Jones arrived.');
  assert.equal(normalize('It took 5 sec. to load.').spoken, 'It took 5 sec. to load.');
});

test('substituted words share the source span of the abbreviation', () => {
  const text = '(see e.g., X)';
  assert.deepEqual(pairs(text), [['see', 'see'], ['for', 'e.g.'], ['example', 'e.g.'], ['X', 'X']]);

  const t2 = 'Smith et al., in Fig. 3 on p. 34, i.e. here.';
  assert.deepEqual(pairs(t2), [
    ['Smith', 'Smith'], ['and', 'et al.'], ['colleagues', 'et al.'], ['in', 'in'], ['Figure', 'Fig.'], ['3', '3'],
    ['on', 'on'], ['page', 'p.'], ['34', '34'], ['that', 'i.e.'], ['is', 'i.e.'], ['here', 'here'],
  ]);
  assertInvariants(t2, normalize(t2));
});

test('URLs and emails become "link"', () => {
  const text = 'Visit https://example.com/a?b=1&c=2. Or www.test.org/x, or mail jo.doe+x@uni.edu now.';
  const out = normalize(text);
  assert.equal(out.spoken, 'Visit link. Or link, or mail link now.');
  assert.deepEqual(pairs(text), [
    ['Visit', 'Visit'], ['link', 'https://example.com/a?b=1&c=2'], ['Or', 'Or'], ['link', 'www.test.org/x'],
    ['or', 'or'], ['mail', 'mail'], ['link', 'jo.doe+x@uni.edu'], ['now', 'now'],
  ]);
  assert.equal(normalize('(see https://en.wikipedia.org/wiki/Foo_(bar)).').spoken, '(see link).');
  assert.equal(normalize('(see https://example.com/x).').spoken, '(see link).');
});

test('whitespace collapses without breaking offsets', () => {
  const text = '  Line one\n  wraps\there and\r\n\r\nthere.   ';
  const out = normalize(text);
  assert.equal(out.spoken, 'Line one wraps here and there.');
  assert.deepEqual(pairs(text).map(([a, b]) => a === b), Array(6).fill(true));
  assertInvariants(text, out);
});

test('invisible characters are dropped', () => {
  const text = 'hy­phen​ated word';
  assert.equal(normalize(text).spoken, 'hyphenated word');
  assert.deepEqual(pairs(text), [['hyphenated', 'hy­phen​ated'], ['word', 'word']]);
});

test('numbers, units and symbols are left for the TTS engine', () => {
  const text = 'A well-known result costs $20.50, i.e., 3.5% of 1,250 units at 25°C…';
  const out = normalize(text);
  assert.equal(out.spoken, 'A well-known result costs $20.50, that is, 3.5% of 1,250 units at 25°C…');
  assert.deepEqual(out.words.map((w) => w.text), [
    'A', 'well-known', 'result', 'costs', '$20.50', 'that', 'is', '3.5%', 'of', '1,250', 'units', 'at', '25°C',
  ]);
  assertInvariants(text, out);
});

test('surrounding punctuation is stripped from words and their spans', () => {
  const text = '“Quoted,” (paren) [bracket] —dash— end.';
  assert.deepEqual(pairs(text), [
    ['Quoted', 'Quoted'], ['paren', 'paren'], ['bracket', 'bracket'], ['dash', 'dash'], ['end', 'end'],
  ]);
});

test('words follow the spec token definition (one per non-space run)', () => {
  const text = "Dr. Smith's 2nd study—published in 1998—used CO2 & H2O.";
  assert.deepEqual(normalize(text).words.map((w) => w.text), [
    'Dr', "Smith's", '2nd', 'study—published', 'in', '1998—used', 'CO2', 'H2O',
  ]);
});

test('nothing speakable', () => {
  for (const s of ['', '   ', '[12]', ' (Smith, 2019). ', '— … —', '\n\n']) {
    assert.deepEqual(normalize(s), { spoken: '', words: [] }, JSON.stringify(s));
  }
  assert.deepEqual(normalize(undefined), { spoken: '', words: [] });
});

test('every word maps back to the right source slice on a dense paragraph', () => {
  const text =
    'In Fig. 3 (Smith et al., 2019, p. 34) we see, e.g., a drop [3–5, 8]; cf. Eq. 2 and pp. 10–12 ' +
    'of Vol. 2 at https://doi.org/10.1000/xyz. Contact a@b.co, etc.';
  const out = normalize(text);
  assert.equal(
    out.spoken,
    'In Figure 3 we see, for example, a drop; compare Equation 2 and pages 10–12 of Volume 2 at link. Contact link, et cetera.',
  );
  const expected = {
    In: 'In', Figure: 'Fig.', 3: '3', we: 'we', see: 'see', for: 'e.g.', example: 'e.g.', a: 'a', drop: 'drop',
    compare: 'cf.', Equation: 'Eq.', 2: '2', and: 'and', pages: 'pp.', '10–12': '10–12', of: 'of', Volume: 'Vol.',
    at: 'at', link: null, Contact: 'Contact', et: 'etc.', cetera: 'etc.',
  };
  for (const w of out.words) {
    const src = text.slice(w.srcStart, w.srcEnd);
    if (w.text === 'link') assert.match(src, /^(https:\/\/doi\.org\/10\.1000\/xyz|a@b\.co)$/);
    else assert.equal(src, expected[w.text], w.text);
  }
  assertInvariants(text, out);
});

test('classic-script semantics: safe to run twice in one context', () => {
  const src = readFileSync(new URL('../lib/normalize.js', import.meta.url), 'utf8');
  const ctx = vm.createContext({});
  vm.runInContext(src, ctx);
  vm.runInContext(src, ctx);
  assert.equal(vm.runInContext('Murmur.normalize.normalize("e.g. x").spoken', ctx), 'for example x');
});

// ── Adversarial (review) ──────────────────────────────────────────────────

test('decomposed accents stay inside the word and its span', () => {
  const text = 'He said "cafe\u0301." and nai\u0308ve';
  assert.deepEqual(pairs(text), [['He', 'He'], ['said', 'said'], ['cafe\u0301', 'cafe\u0301'], ['and', 'and'], ['nai\u0308ve', 'nai\u0308ve']]);
  assertInvariants(text, normalize(text));
});

test('astral letters, CJK and emoji keep exact spans', () => {
  for (const text of ['𝑥 equals 𝑦 here 👋🏽.', 'これは日本語です。', 'Мы видим (Иванов, 2019) это.']) {
    const r = normalize(text);
    assertInvariants(text, r);
    for (const w of r.words) assert.equal(text.slice(w.srcStart, w.srcEnd), w.text);
  }
  assert.equal(normalize('Мы видим (Иванов, 2019) это.').spoken, 'Мы видим это.');
});

test('pathological inputs stay linear', () => {
  const cases = [
    'a' + ' '.repeat(20000) + 'b', // whitespace run before a would-be citation
    'a.'.repeat(10000), // dotted run before a would-be email
    'a-'.repeat(10000),
    'http://a' + ')'.repeat(20000), // URL trimming
    '(' + 'Aa, '.repeat(4000), // unclosed author list
  ];
  for (const text of cases) {
    const t0 = performance.now();
    normalize(text);
    assert.ok(performance.now() - t0 < 150, `${text.slice(0, 12)}… took ${performance.now() - t0}ms`);
  }
  assert.equal(normalize('a' + ' '.repeat(5000) + '[3] b').spoken, 'a b');
});
