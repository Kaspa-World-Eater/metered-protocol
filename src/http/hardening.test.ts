import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicKeyHex, signEnvelope, signState } from '../encoding.js';
import { BuyerSession } from './buyer.js';
import { requiredFunding } from '../reservation.js';
import { MAX_BODY_BYTES } from './serve.js';
import { type OfferTerms } from './service.js';
import { withMeteredServer, type Harness } from './harness.js';
import { readOffer, runBabel, openSession } from './client.js';
import { meterFor } from '../meter.js';
import type { Offer } from '../types.js';

/**
 * The audit of 2026-09-10, each finding pinned by the attack it allowed.
 *
 * Every test here failed before its fix. They are grouped in one file because they share a
 * property: none of them is about two parties disagreeing. They are about what happens when a
 * THIRD party, or a merely clumsy one, touches a session it has no right to move.
 */

const BUYER_SK = '11'.repeat(32);
const PROVIDER_SK = '22'.repeat(32);
const STRANGER_SK = '33'.repeat(32);

const meter = meterFor('o200k_base');
const deliver = (prompt: string, max: number) =>
  Array.from({ length: max }, (_, i) => `${prompt}${i}`).join(' ');

const TERMS: OfferTerms = {
  v: 1, scheme: 'metered', network: 'kaspa:testnet-10', asset: 'KAS',
  unit: 'llm.output_tokens.v1', meter: 'o200k_base',
  unitPriceSompi: 3630, babelUnits: 20, maxBabels: 8,
  toleranceAbs: 2, checkpointEvery: 0, responseWindowDaa: 600,
};

async function withServers(run: (h: Harness) => Promise<void>, maxSessions?: number): Promise<void> {
  return withMeteredServer({
    terms: TERMS, providerSk: PROVIDER_SK, providerPubkey: publicKeyHex(PROVIDER_SK),
    meter, deliver, maxSessions,
  }, run);
}

const post = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

/* ------------------------------------------------- F1: unbounded request body */

test('F1: a body larger than the cap is refused with 413, not accumulated', async () => {
  // Before the cap, `readJson` grew a Buffer for as long as a client cared to send. No session and
  // no signature required -- the cheapest denial of service there is.
  await withServers(async ({ base }) => {
    const huge = `{"buyerPubkey":"${'a'.repeat(MAX_BODY_BYTES + 1024)}"}`;
    const res = await post(base, '/metered/open', huge);
    assert.equal(res.status, 413);
  });
});

test('F1: a body just under the cap is still read normally', async () => {
  await withServers(async ({ base }) => {
    // Well-formed, merely padded: it must fail on its CONTENT, not on its size.
    const padded = JSON.stringify({ buyerPubkey: 'nonsense', pad: 'x'.repeat(1024) });
    const res = await post(base, '/metered/open', padded);
    assert.notEqual(res.status, 413);
  });
});

/* ------------------------- F2: a stranger must not be able to halt a session */

test('F2: a STRANGER who knows a sessionId cannot halt the session', async () => {
  // sessionId is not a secret -- it travels in clear in every message. Before the fix, any junk
  // sent to a known session halted it permanently, so anyone who could read one packet could
  // destroy the session. The buyer must still be able to continue afterwards.
  await withServers(async ({ base }) => {
    const { offer, session } = await openSession(base, BUYER_SK, meter, 'kaspa:testnet-10');

    const forged = signEnvelope({
      v: 1, sessionId: offer.sessionId, seq: 0, units: 5,
      cumulativeUnits: 5, cumulativeSompi: 5 * TERMS.unitPriceSompi, prevState: null,
    }, STRANGER_SK);
    const res = await post(base, '/metered/babel', { reservation: forged, prompt: 'x' });
    assert.equal(res.status, 403, 'the stranger is refused');

    const out = await runBabel(base, session, 'hello');
    assert.ok(out.billedUnits > 0, 'and the real buyer carries on unaffected');
  });
});

test('F2: an UNSIGNED reservation for a known session is refused without halting', async () => {
  await withServers(async ({ base }) => {
    const { offer, session } = await openSession(base, BUYER_SK, meter, 'kaspa:testnet-10');
    const unsigned = {
      v: 1, sessionId: offer.sessionId, seq: 0, units: 5,
      cumulativeUnits: 5, cumulativeSompi: 5 * TERMS.unitPriceSompi, prevState: null,
    };
    assert.equal((await post(base, '/metered/babel', { reservation: unsigned, prompt: 'x' })).status, 403);
    assert.ok((await runBabel(base, session, 'hello')).billedUnits > 0);
  });
});

test('F2: a bogus countersignature is refused without halting', async () => {
  await withServers(async ({ base }) => {
    const { offer, session } = await openSession(base, BUYER_SK, meter, 'kaspa:testnet-10');
    await runBabel(base, session, 'first');

    const res = await post(base, '/metered/countersign', {
      state: { v: 1, sessionId: offer.sessionId, seq: 0, cumulativeUnits: 1, cumulativeSompi: 1, prevState: null },
      buyerSig: 'ab'.repeat(32),
    });
    assert.equal(res.status, 403);
    assert.ok((await runBabel(base, session, 'second')).billedUnits > 0, 'the session survives');
  });
});

/* ------------------------------------------- F4: an open-flood must not evict */

test('F4: flooding /open does not evict a session that is mid-flight', async () => {
  // Opening is free and unauthenticated. Evicting by age alone let an attacker's fresh sessions
  // survive while real buyers -- older by definition -- were dropped part-way through.
  await withServers(async ({ base }) => {
    const { session } = await openSession(base, BUYER_SK, meter, 'kaspa:testnet-10');
    await runBabel(base, session, 'started');

    for (let i = 0; i < 12; i += 1) await readOffer(base, publicKeyHex(STRANGER_SK));

    const out = await runBabel(base, session, 'still here');
    assert.ok(out.billedUnits > 0, 'the in-progress session outlived the flood');
  }, 4);
});

/* ---------------------------- F5: a retransmission must be a no-op, not a halt */

test('F5: sending the SAME measurement twice returns the same State, and does not halt', async () => {
  // SPEC.md 3.3 calls `measurementId` an idempotency key and says a retransmission MUST be a
  // no-op. It was not: `pending` had already been consumed, so the retry raised SessionRejected
  // and the session died -- meaning an ordinary HTTP timeout-and-retry killed the buyer's own
  // session. Nothing malicious required.
  await withServers(async ({ base }) => {
    const { offer, session } = await openSession(base, BUYER_SK, meter, 'kaspa:testnet-10');
    const reservation = session.reserve();
    const delivered = await (await post(base, '/metered/babel', { reservation, prompt: 'hi' })).json() as
      { content: string; measurement: unknown };
    const mine = session.measure(delivered.content, delivered.measurement as never, reservation.seq);

    const first = await post(base, '/metered/state', { measurement: mine });
    const second = await post(base, '/metered/state', { measurement: mine });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200, 'the retry is accepted');
    assert.deepEqual(await second.json(), await first.json(), 'and returns the identical State');
    assert.ok(offer.sessionId);
  });
});

/* ---------------------- F6: never agree a total the covenant cannot pay out */

test('F6: the buyer REFUSES a State billing more than the covenant can pay', async () => {
  // The stranded-funds case. `expire` demands an output of exactly pendingSompi, so once the
  // parties have signed a total above what the covenant holds (less the close fee), no valid
  // close transaction exists and the whole balance is locked -- the same family as Finding G,
  // reached by agreement rather than by dust.
  const offer = signEnvelope({
    ...TERMS, sessionId: 'a1'.repeat(16), buyerPubkey: publicKeyHex(BUYER_SK),
    providerPubkey: publicKeyHex(PROVIDER_SK), partiesCommitment: 'ff'.repeat(32),
  }, PROVIDER_SK) as Offer;

  // Funded far too thinly for the bill about to be agreed: 420,000 less the 400,000 close fee
  // leaves 20,000 payable, against a 72,600 bill.
  const funded = 420_000;
  const session = new BuyerSession(offer, BUYER_SK, meter, undefined, undefined, undefined, funded);

  const state = {
    v: 1, sessionId: offer.sessionId, seq: 0,
    cumulativeUnits: 20, cumulativeSompi: 20 * TERMS.unitPriceSompi, prevState: null,
  };
  assert.throws(
    () => session.countersign(state as never, signState(state, PROVIDER_SK), 20),
    /7\.4b|can pay out/,
  );
});

test('F6: the same State is accepted once the covenant is funded properly', () => {
  const offer = signEnvelope({
    ...TERMS, sessionId: 'b2'.repeat(16), buyerPubkey: publicKeyHex(BUYER_SK),
    providerPubkey: publicKeyHex(PROVIDER_SK), partiesCommitment: 'ff'.repeat(32),
  }, PROVIDER_SK) as Offer;

  const session = new BuyerSession(offer, BUYER_SK, meter, undefined, undefined, undefined, requiredFunding(offer));
  const state = {
    v: 1, sessionId: offer.sessionId, seq: 0,
    cumulativeUnits: 20, cumulativeSompi: 20 * TERMS.unitPriceSompi, prevState: null,
  };
  assert.doesNotThrow(() => session.countersign(state as never, signState(state, PROVIDER_SK), 20));
});
