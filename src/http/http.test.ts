import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { publicKeyHex, signEnvelope } from '../encoding.js';
import { serveMetered } from './serve.js';
import { type OfferTerms } from './service.js';
import { withMeteredServer, type Harness } from './harness.js';
import { openSession, readOffer, runBabel } from './client.js';
import { BuyerSession } from './buyer.js';
import type { Offer } from '../types.js';

const BUYER_SK = '11'.repeat(32);
const OTHER_SK = '33'.repeat(32);
const PROVIDER_SK = '22'.repeat(32);
const PRICE = 3630;

/** A deterministic meter: one unit per word. Real sessions name a tokeniser (SPEC.md 6). */
const meter = (content: string) => content.trim().split(/\s+/).filter(Boolean).length;
const deliver = (prompt: string, maxUnits: number) =>
  Array.from({ length: maxUnits }, (_, i) => `${prompt}-${i}`).join(' ');

const TERMS: OfferTerms = {
  v: 1, scheme: 'metered', network: 'kaspa:testnet-10', asset: 'KAS',
  unit: 'words.v1', tokenizer: 'whitespace',
  unitPriceSompi: PRICE, babelUnits: 10, maxBabels: 8,
  toleranceAbs: 1, checkpointEvery: 0, responseWindowDaa: 600,
};

async function withServer(
  run: (h: Harness) => Promise<void>,
  overrides: Partial<{ meter: typeof meter; deliver: typeof deliver; maxSessions: number }> = {},
): Promise<void> {
  return withMeteredServer({
    terms: TERMS,
    providerSk: PROVIDER_SK,
    providerPubkey: publicKeyHex(PROVIDER_SK),
    meter: overrides.meter ?? meter,
    deliver: overrides.deliver ?? deliver,
    maxSessions: overrides.maxSessions,
  }, run);
}

test('an unpaid request gets x402 402 with an Offer minted for the asking buyer', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/metered/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ buyerPubkey: publicKeyHex(BUYER_SK) }),
    });
    assert.equal(res.status, 402);
    const body = await res.json() as { x402Version: number; accepts: Offer[] };
    assert.equal(body.x402Version, 2, 'the v2 envelope, so an x402 client can read it');
    assert.equal(body.accepts[0]?.scheme, 'metered');
    assert.equal(body.accepts[0]?.buyerPubkey, publicKeyHex(BUYER_SK), 'the Offer names the buyer that asked');
  });
});

test('open requires a buyer key -- terms cannot be signed for nobody', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/metered/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 400);
  });
});

test('A FULL SESSION over HTTP: four chunks, each reserved, counted twice and countersigned', async () => {
  await withServer(async ({ base }) => {
    const { session } = await openSession(base, BUYER_SK, meter, 'kaspa:testnet-10');
    let last = null;
    for (let i = 0; i < 4; i += 1) {
      const out = await runBabel(base, session, `chunk${i}`);
      assert.equal(out.billedUnits, 10);
      assert.equal(out.state.seq, i);
      assert.equal(out.state.cumulativeSompi, 10 * (i + 1) * PRICE);
      last = out.state;
    }
    assert.equal(session.spentSompi, 40 * PRICE);
    assert.equal(last?.prevState !== null, true, 'the session is a hash chain after seq 0');
  });
});

test('the buyer refuses an Offer whose tolerance would halt an honest session', () => {
  const bad = signEnvelope({
    ...TERMS, sessionId: 'a1'.repeat(16), buyerPubkey: publicKeyHex(BUYER_SK),
    providerPubkey: publicKeyHex(PROVIDER_SK), partiesCommitment: 'ff'.repeat(32), toleranceAbs: 0,
  } as Offer, PROVIDER_SK) as Offer;
  assert.throws(() => new BuyerSession(bad, BUYER_SK, meter), /toleranceAbs/);
});

test('the buyer refuses a wrong network before spending anything', async () => {
  await withServer(async ({ base }) => {
    await assert.rejects(() => openSession(base, BUYER_SK, meter, 'kaspa:mainnet'), /network/);
  });
});

test('UNDER-DELIVERY IS NOT FRAUD: the buyer is billed for what arrived, not what it reserved', async () => {
  // Aborting mid-babel costs the PROVIDER revenue, not the buyer money. A
  // one-sided scheme cannot offer this, because there the seller's number is the only number.
  await withServer(async ({ base }) => {
    const { session } = await openSession(base, BUYER_SK, meter);
    const out = await runBabel(base, session, 'x');
    assert.equal(out.billedUnits, 3, 'billed for three delivered units, not ten reserved');
    assert.equal(session.spentSompi, 3 * PRICE);
  }, { deliver: () => 'only three words' });
});

test('P1 THE INFLATED COUNT: a provider that overstates what it sent is refused', async () => {
  await withServer(async ({ base }) => {
    const { session } = await openSession(base, BUYER_SK, meter);
    await assert.rejects(() => runBabel(base, session, 'x'), /differ by more than/);
  }, { meter: (c: string) => meter(c) * 3 });
});

test('THE EXPOSURE BOUND is enforced server-side, not by the buyer being polite', async () => {
  await withServer(async ({ base }) => {
    const offer = await readOffer(base, publicKeyHex(BUYER_SK));
    // Built by hand: a rogue buyer would not run its own checks, so the test must not either.
    const reservation = signEnvelope({
      v: 1, sessionId: offer.sessionId, seq: 0, units: 1000,
      cumulativeUnits: 1000, cumulativeSompi: 1000 * PRICE, prevState: null,
    }, BUYER_SK);
    const res = await fetch(`${base}/metered/babel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reservation, prompt: 'x' }),
    });
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(await res.json()), /babelUnits/);
  });
});
