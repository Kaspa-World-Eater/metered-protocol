import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeWith, meterFor, TokenizerUnavailable, available } from './tokenizer.js';

interface Vectors {
  encoding: string;
  tiktokenVocab: number;
  cases: { name: string; text: string; ids: number[] }[];
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../evidence/tokenizer-vectors.json', import.meta.url)), 'utf8'),
) as Vectors;

/**
 * THE CONFORMANCE TEST, and the reason this file exists.
 *
 * Every tolerance in SPEC.md traces to Study A, which counted with PYTHON tiktoken. The protocol
 * counts with a JavaScript tokeniser. A one-token disagreement between them halts an honest
 * session -- exactly the failure SPEC.md 0.1 attributes to a zero tolerance, arriving through a
 * different door. So the two are pinned against each other rather than assumed to agree.
 *
 * IDS, NOT COUNTS. Two tokenisers can agree on a total by luck while disagreeing about where the
 * boundaries fall, and a boundary disagreement is what diverges on the NEXT input.
 */
for (const c of vectors.cases) {
  test(`o200k_base agrees with Python tiktoken, id for id: ${c.name}`, () => {
    assert.deepEqual(encodeWith('o200k_base', c.text), c.ids);
  });
}

test('the corpus is the adversarial one, not a happy path', () => {
  // If these cases ever vanish the test above still passes and proves much less. CJK, emoji and
  // zalgo are where Study A measured a 40.9% divergence between tokenisers.
  const names = vectors.cases.map((c) => c.name);
  for (const required of ['cjk', 'unicode_emoji', 'code', 'whitespace']) {
    assert.ok(names.includes(required), `the conformance corpus lost its ${required} case`);
  }
  assert.equal(vectors.encoding, 'o200k_base');
});

test('the meter counts what the encoder produces', () => {
  const meter = meterFor('o200k_base');
  for (const c of vectors.cases) assert.equal(meter(c.text), c.ids.length);
});

test('SPEC.md 6.3.3: the meter does NOT normalise -- whitespace is content', () => {
  const meter = meterFor('o200k_base');
  assert.notEqual(meter('a    b'), meter('a b'));
  assert.notEqual(meter(' a '), meter('a'));
});

test('SPEC.md 3.1: an unobtainable tokeniser is REFUSED, never silently substituted', () => {
  // The dangerous alternative is counting with some other tokeniser, which yields a number that
  // looks like a measurement and settles like one. There is deliberately no fallback.
  assert.throws(() => meterFor('cl100k_base'), TokenizerUnavailable);
  assert.throws(() => meterFor(''), TokenizerUnavailable);
  assert.throws(() => encodeWith('not-a-tokeniser', 'x'), TokenizerUnavailable);
});

test('the registry names what it can actually serve', () => {
  assert.deepEqual(available(), ['o200k_base']);
  for (const name of available()) assert.equal(typeof meterFor(name)('hello'), 'number');
});
