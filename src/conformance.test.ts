import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utf8 } from './encoding.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  canonicalize, digestHex, blake3Hex, settlementPreimage, stateSigningPayload, verify, verifyState,
} from './encoding.js';
import { reconcileBabel, toleranceBound } from './reconcile.js';
import { requiredFunding, CLOSE_FEE_SOMPI, MIN_COVENANT_SOMPI } from './reservation.js';
import { resolveMeter, minimumTolerance, meterFor } from './meter.js';
import type { Measurement, Offer, State } from './types.js';

/**
 * THE CONFORMANCE VECTORS, CHECKED AGAINST THE IMPLEMENTATION THAT EMITTED THEM.
 *
 * A vector file nobody runs is a file, not a guarantee: it drifts the first time the code changes
 * and nothing says so. This reads spec/conformance-vectors.json back and re-derives every answer,
 * so the vectors an implementer downloads are known to describe working behaviour rather than
 * remembered behaviour.
 *
 * A second implementation runs exactly these cases and compares exactly these fields. It needs no
 * TypeScript and no part of this repository -- see spec/CONFORMANCE.md.
 */
interface Vectors {
  version: number;
  offer: Offer;
  groups: { section: string; about: string; cases: { name: string; given: never; expect: never }[] }[];
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../spec/conformance-vectors.json', import.meta.url)), 'utf8'),
) as Vectors;

const group = (section: string) => {
  const found = vectors.groups.find((g) => g.section === section);
  assert.ok(found, `the vector file lost its section ${section}`);
  return found;
};

test('the vector file covers every section it claims to', () => {
  assert.equal(vectors.version, 1);
  for (const section of ['2', '3.4.1', '2.6 / 3.4', '5', '7.4a / 7.4b', '6']) assert.ok(group(section));
  const total = vectors.groups.reduce((n, g) => n + g.cases.length, 0);
  assert.ok(total >= 36, `only ${total} cases -- the suite has shrunk`);
});

for (const c of group('2').cases) {
  test(`§2 canonical JSON: ${c.name}`, () => {
    const expect = c.expect as unknown as { canonical: string; digest: string };
    assert.equal(canonicalize(c.given), expect.canonical);
    assert.equal(digestHex(c.given), expect.digest);
  });
}

for (const c of group('3.4.1').cases) {
  test(`§3.4.1 preimage: ${c.name}`, () => {
    const state = c.given as unknown as Record<string, unknown>;
    const expect = c.expect as unknown as { lengthBytes: number; preimageHex: string; digestHex: string };
    assert.equal(settlementPreimage(state).length, expect.lengthBytes);
    assert.equal(settlementPreimage(state).length, 72, 'the preimage is 72 bytes, always');
    assert.equal(stateSigningPayload(state), expect.preimageHex);
    assert.equal(blake3Hex(settlementPreimage(state)), expect.digestHex);
  });
}

for (const c of group('2.6 / 3.4').cases) {
  test(`signatures: ${c.name}`, () => {
    const given = c.given as unknown as {
      message?: object; state?: State; signature?: string; publicKey: string;
    };
    const expect = c.expect as unknown as { verifies: boolean };
    const got = given.state
      ? verifyState(given.state, given.signature ?? '', given.publicKey)
      : verify(given.message ?? {}, given.publicKey);
    assert.equal(got, expect.verifies);
  });
}

for (const c of group('5').cases) {
  test(`§5 reconciliation: ${c.name}`, () => {
    const given = c.given as unknown as { buyer: Measurement; provider: Measurement; seq: number };
    assert.deepEqual(reconcileBabel(vectors.offer, given.buyer, given.provider, given.seq), c.expect);
  });
}

test('§7.4b the funding floor reproduces', () => {
  const c = group('7.4a / 7.4b').cases.find((x) => x.name.includes('funding floor'));
  assert.ok(c);
  const expect = c.expect as unknown as { requiredFunding: number; closeFee: number; minCovenant: number };
  assert.equal(requiredFunding(vectors.offer), expect.requiredFunding);
  assert.equal(CLOSE_FEE_SOMPI, expect.closeFee);
  assert.equal(MIN_COVENANT_SOMPI, expect.minCovenant);
});

test('§5 rule 4: the tolerance bound reproduces, and still does not scale', () => {
  const c = group('7.4a / 7.4b').cases.find((x) => x.name.includes('tolerance bound'));
  assert.ok(c);
  const given = c.given as unknown as { providerUnits: number[] };
  const expect = c.expect as unknown as { bounds: number[] };
  assert.deepEqual(given.providerUnits.map((u) => toleranceBound(vectors.offer, u)), expect.bounds);
  assert.equal(new Set(expect.bounds).size, 1, 'every bound is the same number, at every size');
});

test('§7.4a the close shapes reproduce, including both sides of the dust line', () => {
  const shape = (pending: number, total: number): { outputs: number; to: string[] } => {
    if (pending < 2_600_000) return { outputs: 1, to: ['buyer'] };
    if (pending + 3_000_000 >= total) return { outputs: 1, to: ['provider'] };
    return { outputs: 2, to: ['provider', 'buyer'] };
  };
  const cases = group('7.4a / 7.4b').cases.filter((x) => x.name.startsWith('claim '));
  assert.ok(cases.length >= 6);
  for (const c of cases) {
    const given = c.given as unknown as { pendingSompi: number; covenantSompi: number };
    const expect = c.expect as unknown as { shape: { outputs: number; to: string[] } };
    assert.deepEqual(shape(given.pendingSompi, given.covenantSompi), expect.shape, c.name);
  }
});

/* ------------------------------------------------- §6, units and meters */

for (const c of group('6').cases.filter((x) => x.name.startsWith('octets of'))) {
  test(`§6 ${c.name}`, () => {
    const given = c.given as unknown as { meter: string; content: string };
    const expect = c.expect as unknown as { units: number; contentDigest: string };
    assert.equal(meterFor(given.meter)(utf8(given.content)), expect.units);
    assert.equal(blake3Hex(given.content), expect.contentDigest);
  });
}

test('§6 the tolerance floor and exactness reproduce', () => {
  const c = group('6').cases.find((x) => x.name.includes('tolerance floor'));
  assert.ok(c);
  const given = c.given as unknown as { meters: string[] };
  const expect = c.expect as unknown as { floors: number[]; exact: boolean[] };
  assert.deepEqual(given.meters.map((m) => minimumTolerance(resolveMeter(m))), expect.floors);
  assert.deepEqual(given.meters.map((m) => resolveMeter(m).exact), expect.exact);
  assert.equal(expect.floors[expect.exact.indexOf(true)], 0, 'an exact meter permits zero tolerance');
});

test('§6 each meter measures exactly one unit', () => {
  const c = group('6').cases.find((x) => x.name.includes('exactly one unit'));
  assert.ok(c);
  const given = c.given as unknown as { meters: string[] };
  const expect = c.expect as unknown as { units: string[] };
  assert.deepEqual(given.meters.map((m) => resolveMeter(m).unit), expect.units);
});
