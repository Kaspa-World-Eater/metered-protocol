import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { utf8, blake3Hex } from './encoding.js';
import { encodeWith, meterFor, resolveMeter, minimumTolerance, MeterUnavailable, available } from './meter.js';

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
  for (const c of vectors.cases) assert.equal(meter(utf8(c.text)), c.ids.length);
});

test('SPEC.md 6.3.3: the meter does NOT normalise -- whitespace is content', () => {
  const meter = meterFor('o200k_base');
  assert.notEqual(meter(utf8('a    b')), meter(utf8('a b')));
  assert.notEqual(meter(utf8(' a ')), meter(utf8('a')));
});

test('SPEC.md 3.1: an unobtainable meter is REFUSED, never silently substituted', () => {
  // The dangerous alternative is counting with some other tokeniser, which yields a number that
  // looks like a measurement and settles like one. There is deliberately no fallback.
  assert.throws(() => meterFor('cl100k_base'), MeterUnavailable);
  assert.throws(() => meterFor(''), MeterUnavailable);
  assert.throws(() => encodeWith('not-a-tokeniser', 'x'), MeterUnavailable);
});

test('the registry names what it can actually serve', () => {
  assert.deepEqual(available(), ['o200k_base', 'octets']);
  for (const name of available()) assert.equal(typeof meterFor(name)(utf8('hello')), 'number');
});

/* ------------------------------------------- net.bytes_delivered.v1, the second unit */

test('§6 octets counts UTF-8 bytes, which is what contentDigest already covers', () => {
  const octets = meterFor('octets');
  assert.equal(octets(utf8('hello')), 5);
  assert.equal(octets(utf8('café')), 5, 'one two-byte code point');
  assert.equal(octets(utf8('計量')), 6, 'CJK is three bytes each');
  assert.equal(octets(utf8('\u{1F512}')), 4, 'astral is four');
  assert.equal(octets(utf8('')), 0);
});

test('§6 THE EXACT METER: agreeing on the digest means agreeing on the count', () => {
  // The property that lets toleranceAbs be 0 for this unit. A tokeniser has no equivalent: two
  // implementations can agree on every byte and still differ by one token, because the boundaries
  // belong to the tokeniser rather than to the content.
  const octets = meterFor('octets');
  for (const text of ['', 'hello', 'café 計量 \u{1F512}', 'a'.repeat(5000)]) {
    assert.equal(octets(utf8(text)), utf8(text).length);
  }
});

test('§3.1 the tolerance FLOOR comes from the meter, not from the protocol', () => {
  assert.equal(minimumTolerance(resolveMeter('octets')), 0, 'exact: no honest divergence to absorb');
  assert.equal(minimumTolerance(resolveMeter('o200k_base')), 1, 'lossy: Study A measured one token');
});

test('§6 a meter measuring the WRONG unit is refused', () => {
  // The Offer carries both, and they have to agree. Counting tokens against a byte price is not a
  // rounding error, it is a different bill.
  assert.throws(() => resolveMeter('octets', 'llm.output_tokens.v1'), MeterUnavailable);
  assert.throws(() => resolveMeter('o200k_base', 'net.bytes_delivered.v1'), MeterUnavailable);
  assert.doesNotThrow(() => resolveMeter('octets', 'net.bytes_delivered.v1'));
});

test('§6 octets produces no token ids, and says so rather than guessing', () => {
  assert.throws(() => encodeWith('octets', 'hello'), MeterUnavailable);
});

test('§6 the exact meter measures BYTES, including bytes that are not text', () => {
  // The reason delivery is byte-typed at all. This is a PNG header followed by a NUL and a lone
  // 0xFF: not valid UTF-8, not expressible as a string, and exactly what a file-delivery provider
  // sells. Before the meter took bytes this content could not be metered, only described.
  const octets = meterFor('octets');
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
  assert.equal(octets(png), 10);

  // Round-tripping it through a string would have LOST bytes, which is the failure this prevents:
  // the invalid sequences become U+FFFD and the count comes back wrong.
  const throughText = utf8(new TextDecoder().decode(png));
  assert.notEqual(octets(throughText), 10, 'text is a lossy container for bytes');

  // The digest is over the same bytes the meter counted, which is what lets this unit run at a
  // tolerance of 0: agreeing on the digest IS agreeing on the count.
  assert.notEqual(blake3Hex(png), blake3Hex(png.slice(0, 9)), 'one byte fewer is a different digest');
});
