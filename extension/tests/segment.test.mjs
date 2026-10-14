import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

await import('../lib/segment.js');
const { splitSentences, _shouldMerge: shouldMerge } = globalThis.Murmur.segment;

const sentences = (text) => splitSentences(text).map(({ start, end }) => text.slice(start, end));

function assertWellFormed(text, spans) {
  let prevEnd = 0;
  for (const { start, end } of spans) {
    assert.ok(start < end, 'non-empty');
    assert.ok(start >= prevEnd, 'ordered, non-overlapping');
    assert.doesNotMatch(text[start], /\s/, 'no leading whitespace');
    assert.doesNotMatch(text[end - 1], /\s/, 'no trailing whitespace');
    prevEnd = end;
  }
  // Every non-space character of the input lands in exactly one span.
  const covered = spans.reduce((n, { start, end }) => n + text.slice(start, end).replace(/\s/g, '').length, 0);
  assert.equal(covered, text.replace(/\s/g, '').length);
}

test('plain sentences', () => {
  assert.deepEqual(sentences('One. Two! Three? Four.'), ['One.', 'Two!', 'Three?', 'Four.']);
});

test('empty and whitespace-only input', () => {
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences('   \n\n  \n '), []);
  assert.deepEqual(splitSentences(undefined), []);
});

test('academic abbreviations do not split', () => {
  const cases = [
    'Smith et al. found a large effect in 2019.',
    'Smith et al. Showed nothing new.',
    'As shown in Fig. 3, the curve flattens.',
    'Compare Figs. 3 and 4 for details.',
    'Dr. Smith and Mr. Jones met Prof. Lee at St. Mary’s.',
    'Mrs. Smith and Ms. Jones agreed with Martin Luther King Jr. on this.',
    'See p. 34 and pp. 40–45 of Vol. 2, Ch. 7, Sec. 4.2.',
    'Use Eq. 2 and Eqs. 5–6, cf. Ref. 9.',
    'Some fruits, e.g. apples, are sweet.',
    'Some fruits, e.g. Apples, are sweet.',
    'The core idea, i.e. Bayesian updating, is simple.',
    'It was approx. 30 km long.',
    'Cats vs. Dogs is an old debate.',
    'The U.S. Government responded quickly.',
    'J. R. R. Tolkien wrote The Hobbit.',
    'Item No. 5 is missing.',
    'Apples, pears, etc. are fruits.',
  ];
  for (const s of cases) assert.deepEqual(sentences(s), [s], s);
});

test('abbreviations inside a longer passage', () => {
  const text =
    'As shown by Smith et al. (2019), the effect in Fig. 3 is large. Dr. Smith agreed. ' +
    'See p. 34 for e.g. details, i.e. more. The U.S. government said so. J. R. R. Tolkien wrote it.';
  assert.deepEqual(sentences(text), [
    'As shown by Smith et al. (2019), the effect in Fig. 3 is large.',
    'Dr. Smith agreed.',
    'See p. 34 for e.g. details, i.e. more.',
    'The U.S. government said so.',
    'J. R. R. Tolkien wrote it.',
  ]);
});

test('real sentence ends still split', () => {
  assert.deepEqual(sentences('We listed apples, pears, etc. The next part is new.'), [
    'We listed apples, pears, etc.',
    'The next part is new.',
  ]);
  assert.deepEqual(sentences('The answer is no. We moved on.'), ['The answer is no.', 'We moved on.']);
  assert.deepEqual(sentences('It costs $5. That is cheap.'), ['It costs $5.', 'That is cheap.']);
});

// The merge rule must hold even if a different ICU build splits where Node's doesn't.
test('shouldMerge on synthetic segments', () => {
  const yes = [
    ['Smith et al. ', 'Showed it.'],
    ['See Fig. ', '3 for details.'],
    ['See Fig. ', 'S3 for details.'],
    ['Dr. ', 'Smith agreed.'],
    ['(see Fig. ', 'S2) shows it.'],
    ['Results e.g. ', 'Table 2.'],
    ['That is, i.e. ', 'Bayes.'],
    ['Read p. ', '34.'],
    ['Read pp. ', 'Ten to twelve.'],
    ['In the U.S. ', 'Government data.'],
    ['J. ', 'R. R. Tolkien.'],
    ['Prof. ', 'Lee.'],
    ['Cats vs. ', 'Dogs.'],
    ['This is approx. ', 'Ten.'],
    ['See also cf. ', 'Jones.'],
    ['Apples, etc. ', 'are fruits.'],
    ['Done. ', '2019 was a year.'],
    ['Done. ', ') trailing.'],
    ['Done. ', '] trailing.'],
    ['Done. ', '   '],
  ];
  const no = [
    ['It ended. ', 'Then it began.'],
    ['Apples, etc. ', 'The next part.'],
    ['The answer is no. ', 'We moved on.'],
    ['Is it? ', 'Yes.'],
    ['He left! ', 'Gone.'],
    ['See the figure. ', 'It shows.'],
    ['Done. ', '(Parenthetical sentence.)'],
  ];
  for (const [a, b] of yes) assert.equal(shouldMerge(a, b), true, `${a}|${b}`);
  for (const [a, b] of no) assert.equal(shouldMerge(a, b), false, `${a}|${b}`);
});

test('\\n\\n is a hard boundary, single \\n is a space', () => {
  const text = 'A Heading Without Period\n\nFirst line wraps\nonto the next line. Second sentence.\n\n\n  Last';
  assert.deepEqual(sentences(text), [
    'A Heading Without Period',
    'First line wraps\nonto the next line.',
    'Second sentence.',
    'Last',
  ]);
  assertWellFormed(text, splitSentences(text));
});

test('hard break wins over abbreviation and lowercase merges', () => {
  assert.deepEqual(sentences('See Fig.\n\n3 is next.'), ['See Fig.', '3 is next.']);
  assert.deepEqual(sentences('Intro by Dr.\n\nlowercase start.'), ['Intro by Dr.', 'lowercase start.']);
});

test('blank lines with spaces and CRLF', () => {
  const text = 'One here.\r\n \r\nTwo here\r\nstill two.';
  assert.deepEqual(sentences(text), ['One here.', 'Two here\r\nstill two.']);
});

test('offsets index into the original text', () => {
  const text = '  Leading space. Then Dr. Who arrived.  \n\n  Tail.  ';
  const spans = splitSentences(text);
  assertWellFormed(text, spans);
  assert.deepEqual(spans.map(({ start, end }) => text.slice(start, end)), [
    'Leading space.',
    'Then Dr. Who arrived.',
    'Tail.',
  ]);
});

test('long sentences split near the middle, preferring ; then , then space', () => {
  const half = 'the quick brown fox jumps over the lazy dog again and again while it rains outside today';
  const semi = `${half}, and more words follow here ${half}; ${half}, then still ${half}.`;
  assert.ok(semi.length > 300);
  const parts = sentences(semi);
  assert.equal(parts.length, 2);
  assert.ok(parts[0].endsWith(';'), parts[0]);
  assert.ok(parts.every((p) => p.length >= 40 && p.length <= 300));

  const commas = `${half}, ${half}, ${half}, ${half}.`;
  const cparts = sentences(commas);
  assert.ok(cparts.length >= 2);
  assert.ok(cparts.slice(0, -1).every((p) => p.endsWith(',')), cparts.join(' | '));
  assert.ok(cparts.every((p) => p.length >= 40 && p.length <= 300));

  const spaces = `${half} ${half} ${half} ${half}.`;
  const sparts = sentences(spaces);
  assert.ok(sparts.length >= 2);
  assert.ok(sparts.every((p) => p.length >= 40 && p.length <= 300));
  assertWellFormed(spaces, splitSentences(spaces));
});

test('very long sentence splits recursively into bounded pieces', () => {
  const clause = 'this clause has a fair number of ordinary words in it';
  const text = Array.from({ length: 30 }, () => clause).join(', ') + '.';
  assert.ok(text.length > 1500);
  const spans = splitSentences(text);
  assertWellFormed(text, spans);
  assert.ok(spans.length >= 5);
  for (const { start, end } of spans) {
    assert.ok(end - start <= 300, `piece of ${end - start}`);
    assert.ok(end - start >= 40, `piece of ${end - start}`);
  }
});

test('long split never lands inside a citation or right after an abbreviation', async () => {
  await import('../lib/normalize.js');
  const { normalize } = globalThis.Murmur.normalize;
  const words = 'the measured response of the system grew steadily across every condition we tested';
  const text =
    `${words} and ${words} as earlier work suggested ` +
    '(Smith & Lee, 2020; Wu, 2021; Garcia et al., 2018, p. 12; Okafor, 2017; Brown, 2016) [3–5, 8, 11, 14] ' +
    `while ${words} and ${words} once more.`;
  assert.ok(text.length > 300);
  const parts = sentences(text);
  assert.ok(parts.length >= 2);
  for (const p of parts) {
    assert.equal(p.split('(').length, p.split(')').length, `unbalanced (): ${p}`);
    assert.equal(p.split('[').length, p.split(']').length, `unbalanced []: ${p}`);
    assert.doesNotMatch(normalize(p).spoken, /Smith|Garcia|2019|2021|\[/, p);
  }

  const fig = `${words} ${words} as shown in Fig. 3 and ${words} ${words}.`;
  assert.ok(fig.length > 300);
  for (const p of sentences(fig)) assert.doesNotMatch(p, /Fig\.$/, p);
});

test('unsplittable long spans come back whole', () => {
  const url = 'https://example.com/' + 'a'.repeat(400);
  assert.deepEqual(sentences(url), [url]);
  // Only whitespace near the edges: splitting would leave a piece under 40 chars.
  const lopsided = 'Hi ' + 'x'.repeat(380) + ' ok.';
  assert.deepEqual(sentences(lopsided), [lopsided]);
});

test('URLs and decimals do not split', () => {
  assert.deepEqual(sentences('Visit https://example.com/a.b.c?x=1. Then read 3.14 pages.'), [
    'Visit https://example.com/a.b.c?x=1.',
    'Then read 3.14 pages.',
  ]);
});

test('classic-script semantics: safe to run twice in one context', () => {
  const src = readFileSync(new URL('../lib/segment.js', import.meta.url), 'utf8');
  const ctx = vm.createContext({});
  vm.runInContext(src, ctx);
  vm.runInContext(src, ctx);
  assert.equal(typeof vm.runInContext('Murmur.segment.splitSentences', ctx), 'function');
  assert.equal(vm.runInContext('Murmur.segment.splitSentences("A b. C d.").length', ctx), 2);
});

// ── Adversarial (review) ──────────────────────────────────────────────────

test('an unclosed bracket does not block long splits', () => {
  const text = 'Look (at this ' + 'word word word word word word, '.repeat(200);
  const spans = splitSentences(text);
  assertWellFormed(text, spans);
  for (const { start, end } of spans) assert.ok(end - start <= 300, `piece of ${end - start}`);
});

test('long merge chains stay linear (reference lists full of initials)', () => {
  const refs = 'Smith, J. A., Lee, K. B., Wu, C. D. '.repeat(3000);
  const t0 = performance.now();
  const spans = splitSentences(refs);
  assert.ok(performance.now() - t0 < 1000, `${performance.now() - t0}ms`);
  assertWellFormed(refs, spans);
});

test('unicode, scripts without spaces and odd whitespace', () => {
  const text = 'これは日本語です。次の文です。 Then English.\u00a0\u00a0И русский текст. Ещё. Hello 👋🏽 world.';
  const spans = splitSentences(text);
  assertWellFormed(text, spans);
  assert.deepEqual(spans.map(({ start, end }) => text.slice(start, end)), [
    'これは日本語です。', '次の文です。', 'Then English.', 'И русский текст.', 'Ещё.', 'Hello 👋🏽 world.',
  ]);
  assert.deepEqual(sentences('\t \u00a0'), []);
  assert.deepEqual(sentences('\n\nA.\n \t\nB.\n\n'), ['A.', 'B.']);
});

test('a balanced citation group longer than the limit is never cut', async () => {
  await import('../lib/normalize.js');
  const { normalize } = globalThis.Murmur.normalize;
  const group = Array.from({ length: 14 }, (_, i) => `Author${String.fromCharCode(97 + i)} & Coauthor, ${2000 + i}`).join('; ');
  const text = `See (${group}) now.`;
  assert.ok(group.length > 300);
  for (const p of sentences(text)) {
    assert.equal(p.split('(').length, p.split(')').length, `unbalanced (): ${p}`);
    assert.doesNotMatch(normalize(p).spoken, /Author|Coauthor/, p);
  }
});
