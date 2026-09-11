import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicKeyHex, signEnvelope, blake3Hex } from './encoding.js';
import { reconcileBabel, toleranceBound } from './reconcile.js';
import { newBiasState, observeResidual, biasAlarm, K, H } from './bias.js';
import type { Measurement, Offer } from './types.js';

const BUYER_SK = '11'.repeat(32);
const PROVIDER_SK = '22'.repeat(32);
const STRANGER_SK = '33'.repeat(32);

const OFFER: Offer = {
  v: 1, scheme: 'metered', network: 'kaspa:testnet-10', asset: 'KAS',
  sessionId: 'a1'.repeat(16), unit: 'llm.output_tokens.v1', meter: 'o200k_base',
  unitPriceSompi: 3630, babelUnits: 550, maxBabels: 64,
  toleranceAbs: 1, checkpointEvery: 2, responseWindowDaa: 600,
  buyerPubkey: publicKeyHex(BUYER_SK), providerPubkey: publicKeyHex(PROVIDER_SK),
  partiesCommitment: 'ff'.repeat(32),
};

const DIGEST = blake3Hex('chunk bytes');

function measure(
  by: 'buyer' | 'provider',
  units: number,
  cumulative: number,
  sk: string,
  over: Partial<Measurement> = {},
): Measurement {
  const m: Measurement = {
    v: 1, sessionId: OFFER.sessionId, seq: 0, by, units,
    cumulativeUnits: cumulative, contentDigest: DIGEST,
    measurementId: blake3Hex(`${by}/${units}`).slice(0, 32),
    ...over,
  };
  return signEnvelope(m, sk);
}

/* ------------------------------------------------------------------ the six rules */

test('agreeing measurements reconcile, and bill the count both parties reached', () => {
  const r = reconcileBabel(OFFER, measure('buyer', 550, 550, BUYER_SK), measure('provider', 550, 550, PROVIDER_SK), 0);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.billedUnits, 550);
  assert.equal(r.residual, 0);
});

test('RULE 6: a one-token disagreement inside tolerance bills the LOWER count', () => {
  // Exactly the divergence Study A measured, with the buyer counting fewer.
  const r = reconcileBabel(OFFER, measure('buyer', 549, 549, BUYER_SK), measure('provider', 550, 550, PROVIDER_SK), 0);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.billedUnits, 549, 'the provider does not get paid for the token it alone counted');
  assert.equal(r.residual, 1);
});

test('RULE 1, P2/THE FORGERY: a measurement signed by a stranger does not reconcile', () => {
  const r = reconcileBabel(OFFER, measure('buyer', 550, 550, STRANGER_SK), measure('provider', 550, 550, PROVIDER_SK), 0);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'signature');
});

test('RULE 1: the provider cannot supply BOTH halves by stamping one "buyer"', () => {
  // `by` is checked against the key that actually signed, not merely read.
  const forged = measure('buyer', 550, 550, PROVIDER_SK);
  const r = reconcileBabel(OFFER, forged, measure('provider', 550, 550, PROVIDER_SK), 0);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'signature');
});

test('RULE 1: a tampered measurement does not verify', () => {
  const m = { ...measure('buyer', 550, 550, BUYER_SK), units: 400 };
  const r = reconcileBabel(OFFER, m, measure('provider', 550, 550, PROVIDER_SK), 0);
  assert.equal(r.ok, false);
});

test('RULE 2, X2: a measurement from another chunk cannot be spliced in', () => {
  const r = reconcileBabel(OFFER, measure('buyer', 550, 550, BUYER_SK, { seq: 3 }), measure('provider', 550, 550, PROVIDER_SK), 0);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'sequence');
});

test('RULE 2, X1: a measurement from another session cannot be spliced in', () => {
  const other = measure('buyer', 550, 550, BUYER_SK, { sessionId: 'c3'.repeat(16) });
  const r = reconcileBabel(OFFER, other, measure('provider', 550, 550, PROVIDER_SK), 0);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'sequence');
});

test('RULE 3, P2: matching counts over DIFFERENT bytes still halts', () => {
  // The rule that cannot be replaced by counting: identical numbers, different content.
  const other = measure('buyer', 550, 550, BUYER_SK, { contentDigest: blake3Hex('different bytes') });
  const r = reconcileBabel(OFFER, other, measure('provider', 550, 550, PROVIDER_SK), 0);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'content-digest');
});

test('RULE 3 is checked BEFORE the counts, so mismatched bytes never pass on close numbers', () => {
  const other = measure('buyer', 549, 549, BUYER_SK, { contentDigest: blake3Hex('different bytes') });
  const r = reconcileBabel(OFFER, other, measure('provider', 550, 550, PROVIDER_SK), 0);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'content-digest', 'not tolerance -- the bytes differ, so counting is moot');
});

test('RULE 4: a disagreement past tolerance halts', () => {
  const r = reconcileBabel(OFFER, measure('buyer', 500, 500, BUYER_SK), measure('provider', 550, 550, PROVIDER_SK), 0);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'tolerance-babel');
});

test('RULE 5: per-chunk agreement cannot hide accumulated drift', () => {
  // This chunk agrees exactly; the running totals do not. Rule 4 passes, rule 5 catches it.
  const r = reconcileBabel(OFFER, measure('buyer', 550, 2000, BUYER_SK), measure('provider', 550, 2200, PROVIDER_SK), 0);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'tolerance-cumulative');
});

test('§5 rule 4: the tolerance is ABSOLUTE and does not grow with the babel', () => {
  // The removal of `toleranceRel`, pinned. Honest divergence is a boundary effect of magnitude
  // one token -- Study C found none at all at seven sizes from 3 to 550 units -- so a bound that
  // scales with the babel only widens the room a counterparty can shave in. At 0.2% of a
  // 5,000-unit babel that would have been ten free tokens per babel, justified by nothing.
  assert.equal(toleranceBound(OFFER, 10), OFFER.toleranceAbs);
  assert.equal(toleranceBound(OFFER, 5_000), OFFER.toleranceAbs);
  assert.equal(toleranceBound(OFFER, 1_000_000), OFFER.toleranceAbs, 'no size buys extra room');
});

/* ------------------------------------------------- §5.1.1, the bias detector */

test('an honest session never alarms -- the residual is zero to measurement (Study C)', () => {
  let state = newBiasState();
  for (let i = 0; i < 5000; i += 1) state = observeResidual(state, 0);
  assert.equal(biasAlarm(state), false);
  assert.equal(state.sum, 0);
});

test('B1: a buyer shaving one token from EVERY chunk is caught, and quickly', () => {
  let state = newBiasState();
  let chunks = 0;
  while (!biasAlarm(state) && chunks < 100) {
    state = observeResidual(state, 1);
    chunks += 1;
  }
  assert.equal(biasAlarm(state), true);
  assert.equal(chunks, Math.ceil(H / (1 - K)), 'the alarm arrives in 10 chunks, matching Study C');
});

test('the detector is BLIND to a patient buyer, and the spec says so rather than implying zero', () => {
  // Study C: at one chunk in ten the alarm never fires. This is the measured limit of the
  // mechanism, asserted here so nobody later assumes the bound is zero.
  let state = newBiasState();
  for (let i = 0; i < 20000; i += 1) state = observeResidual(state, i % 10 === 0 ? 1 : 0);
  assert.equal(biasAlarm(state), false);
});

test('the statistic never goes negative, which is what makes it one-sided', () => {
  // A provider under-counting cannot bank credit against a later buyer-side cheat.
  let state = newBiasState();
  for (let i = 0; i < 50; i += 1) state = observeResidual(state, -5);
  assert.equal(state.sum, 0);
  for (let i = 0; i < 10; i += 1) state = observeResidual(state, 1);
  assert.equal(biasAlarm(state), true, 'the earlier credit does not delay the alarm');
});

test('bias state is a plain value, so it can be persisted before it is acted on (§4)', () => {
  const state = observeResidual(newBiasState(), 1);
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
});
