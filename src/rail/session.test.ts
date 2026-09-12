/**
 * A metered session on the kaspa-x402 rail, over HTTP: the voucher travels with the
 * countersignature, and nothing is delivered against an unvouched State.
 *
 * docs/RAIL.md, "the voucher travels with the countersignature". The property under test is the
 * one the rail introduced: on it, agreeing the number and authorising the money are two
 * signatures, and only the second moves funds. A buyer that signs the State and withholds the
 * voucher must be refused the next babel, or the seller carries an unbounded debt it cannot claim.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { publicKeyHex, signEnvelope, utf8 } from '../encoding.js';
import { MeteredService, type OfferTerms, type ServiceOptions } from '../http/service.js';
import { serveMetered } from '../http/serve.js';
import { openSession, runBabel, readOffer } from '../http/client.js';
import { BuyerSession } from '../http/buyer.js';
import { meterFor } from '../meter.js';
import { verifyVoucher } from './voucher.js';
import type { ChannelProposal, Offer } from '../types.js';

const PROVIDER_SK = 'a7'.repeat(32);
const BUYER_SK = 'b8'.repeat(32);
const COVENANT = 'c9'.repeat(32);
const VOUCHED_BEFORE = 1_000_000;
const PRICE = 10;
const meter = meterFor('octets');

const TERMS: OfferTerms = {
  v: 1, scheme: 'metered', network: 'kaspa:testnet-10', asset: 'KAS',
  unit: 'net.bytes_delivered.v1', meter: 'octets',
  unitPriceSompi: PRICE, babelUnits: 100, maxBabels: 8,
  toleranceAbs: 0, checkpointEvery: 0, responseWindowDaa: 600,
  channel: { covenantId: COVENANT, vouchedSompi: VOUCHED_BEFORE },
};

async function onRail(terms: OfferTerms = TERMS, channelFor?: ServiceOptions['channelFor']) {
  const service = new MeteredService({
    terms, providerSk: PROVIDER_SK, providerPubkey: publicKeyHex(PROVIDER_SK),
    meter, deliver: (_p, max) => utf8('x'.repeat(Math.min(max, 60))),
    ...(channelFor ? { channelFor } : {}),
  });
  const server = serveMetered({ service });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    service,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const post = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('ON THE RAIL: each countersign carries a voucher for the channel ceiling, and the provider holds it', async () => {
  const s = await onRail();
  try {
    const { offer, session } = await openSession(s.base, BUYER_SK, meter, 'kaspa:testnet-10');
    assert.deepEqual(offer.channel, { covenantId: COVENANT, vouchedSompi: VOUCHED_BEFORE });

    const a = await runBabel(s.base, session, 'a');
    const b = await runBabel(s.base, session, 'b');
    assert.equal(b.state.cumulativeSompi, 2 * 60 * PRICE);

    // The provider's copy is the buyer's, for this channel, for the ceiling the session brings it to.
    const held = s.service.get(offer.sessionId)?.voucher();
    assert.ok(held);
    assert.equal(held.amount, String(VOUCHED_BEFORE + b.state.cumulativeSompi), 'ceiling = vouched before + agreed now');
    assert.equal(held.covenantId, COVENANT);
    assert.equal(verifyVoucher(held, { network: offer.network, covenantId: COVENANT }, publicKeyHex(BUYER_SK)), true);
    void a;
  } finally {
    await s.stop();
  }
});

test('A BUYER THAT AGREES AND DOES NOT PAY GETS NOTHING MORE: no voucher, no next babel', async () => {
  const s = await onRail();
  try {
    const offer = await readOffer(s.base, publicKeyHex(BUYER_SK));
    const buyer = new BuyerSession(offer, BUYER_SK, meter, 'kaspa:testnet-10');

    // Babel 0 by hand, so the countersign can be sent WITHOUT its voucher.
    const r0 = buyer.reserve();
    const d0 = await (await post(s.base, '/metered/babel', { reservation: r0, prompt: 'a' })).json() as { contentB64: string; measurement: never };
    const m0 = buyer.measure(Buffer.from(d0.contentB64, 'base64'), d0.measurement, 0);
    const st0 = await (await post(s.base, '/metered/state', { measurement: m0 })).json() as { state: never; providerSig: string };
    const sig0 = buyer.countersign(st0.state, st0.providerSig, m0.units);

    const withheld = await post(s.base, '/metered/countersign', { state: st0.state, buyerSig: sig0 });
    assert.equal(withheld.status, 400, 'agreed, not paid: refused with a reason, not halted');
    assert.match(JSON.stringify(await withheld.json()), /voucher required/);

    // And the next babel is refused until the voucher arrives -- the provider will not extend
    // credit past the one babel it has already delivered.
    const r1 = buyer.reserve();
    const starved = await post(s.base, '/metered/babel', { reservation: r1, prompt: 'b' });
    assert.equal(starved.status, 400);
    assert.match(JSON.stringify(await starved.json()), /never vouched/);

    // Sending the voucher repairs it: the countersign is accepted and babel 1 is served.
    const repaired = await post(s.base, '/metered/countersign', { state: st0.state, buyerSig: sig0, voucher: buyer.vouch() });
    assert.equal(repaired.status, 200);
    const served = await post(s.base, '/metered/babel', { reservation: buyer.reserve(), prompt: 'b' });
    assert.equal(served.status, 200);
  } finally {
    await s.stop();
  }
});

test('a voucher for the wrong amount, or from the wrong key, is refused', async () => {
  const s = await onRail();
  try {
    const offer = await readOffer(s.base, publicKeyHex(BUYER_SK));
    const buyer = new BuyerSession(offer, BUYER_SK, meter, 'kaspa:testnet-10');
    const r0 = buyer.reserve();
    const d0 = await (await post(s.base, '/metered/babel', { reservation: r0, prompt: 'a' })).json() as { contentB64: string; measurement: never };
    const m0 = buyer.measure(Buffer.from(d0.contentB64, 'base64'), d0.measurement, 0);
    const st0 = await (await post(s.base, '/metered/state', { measurement: m0 })).json() as { state: never; providerSig: string };
    const sig0 = buyer.countersign(st0.state, st0.providerSig, m0.units);
    const good = buyer.vouch();
    assert.ok(good);

    const short = await post(s.base, '/metered/countersign', { state: st0.state, buyerSig: sig0, voucher: { ...good, amount: String(Number(good.amount) - 1) } });
    assert.equal(short.status, 400, 'one sompi under the agreed ceiling');

    const other = new BuyerSession(offer, 'd1'.repeat(32), meter, 'kaspa:testnet-10');
    void other;
    const forged = await post(s.base, '/metered/countersign', { state: st0.state, buyerSig: sig0, voucher: { ...good, signature: 'ab'.repeat(64) } });
    assert.equal(forged.status, 400, 'not the buyer\'s signature');
  } finally {
    await s.stop();
  }
});

test('OFF THE RAIL nothing changes: no channel, no voucher, no gate', async () => {
  const { channel, ...plain } = TERMS;
  void channel;
  const s = await onRail(plain);
  try {
    const { offer, session } = await openSession(s.base, BUYER_SK, meter, 'kaspa:testnet-10');
    assert.equal(offer.channel, undefined);
    await runBabel(s.base, session, 'a');
    await runBabel(s.base, session, 'b');
    assert.equal(session.vouch(), null);
    assert.equal(s.service.get(offer.sessionId)?.voucher(), null);
  } finally {
    await s.stop();
  }
});

test('the buyer refuses an Offer whose channel ceiling contradicts its own record', () => {
  const offer = signEnvelope({
    ...TERMS, sessionId: 'a1'.repeat(16), buyerPubkey: publicKeyHex(BUYER_SK),
    providerPubkey: publicKeyHex(PROVIDER_SK), partiesCommitment: 'ff'.repeat(32),
  } as Offer, PROVIDER_SK) as Offer;
  const buyer = new BuyerSession(offer, BUYER_SK, meter);
  // Nothing agreed yet, so even with a matching record there is nothing to vouch...
  assert.throws(() => buyer.vouch(VOUCHED_BEFORE), /nothing has been countersigned/);
  // ...and a provider claiming a higher prior ceiling than the buyer ever signed is refused first.
  assert.throws(() => buyer.vouch(VOUCHED_BEFORE - 1), /this buyer's record says/);
});

/* ----------------------------------------------- the buyer proposes, the seller decides */

const PROPOSAL: ChannelProposal = {
  covenantId: COVENANT, timeoutDaa: 568_000_000, settledTotal: 250_000,
  active: { txid: 'e1'.repeat(32), index: 0, amount: 20_000_000, scriptPublicKey: '0000aa' },
};
const { channel: _unused, ...OFF_RAIL } = TERMS;
void _unused;

test('THE BUYER PROPOSES ITS CHANNEL; only what the SELLER confirms goes into the Offer', async () => {
  // The seller's check is injected: it looks at the chain, this package does not. Here it accepts
  // the lineage but reports its OWN ceiling, and that -- not the buyer's number -- is what the
  // Offer carries and every voucher is measured against.
  const seen: ChannelProposal[] = [];
  const s = await onRail(OFF_RAIL, async (buyer, proposal) => {
    seen.push(proposal);
    return buyer === publicKeyHex(BUYER_SK) ? { covenantId: proposal.covenantId, vouchedSompi: 999_999 } : null;
  });
  try {
    const { offer, session } = await openSession(s.base, BUYER_SK, meter, 'kaspa:testnet-10', undefined, PROPOSAL);
    assert.deepEqual(seen, [PROPOSAL], 'the seller saw exactly what the buyer proposed');
    assert.deepEqual(offer.channel, { covenantId: COVENANT, vouchedSompi: 999_999 }, "the seller's figure, not the proposal's");
    const out = await runBabel(s.base, session, 'a');
    assert.equal(s.service.get(offer.sessionId)?.voucher()?.amount, String(999_999 + out.state.cumulativeSompi));
  } finally {
    await s.stop();
  }
});

test('a proposal the seller does not confirm is refused, with a reason and no session', async () => {
  const s = await onRail(OFF_RAIL, async () => null);
  try {
    await assert.rejects(() => openSession(s.base, BUYER_SK, meter, 'kaspa:testnet-10', undefined, PROPOSAL), /expected 402, got 400/);
  } finally {
    await s.stop();
  }
});

test('a seller with no way to verify channels refuses every proposal -- it must not bill blind', async () => {
  const s = await onRail(OFF_RAIL);
  try {
    await assert.rejects(() => openSession(s.base, BUYER_SK, meter, 'kaspa:testnet-10', undefined, PROPOSAL), /expected 402, got 400/);
    // ...and still serves a session off the rail to the same buyer.
    const { offer } = await openSession(s.base, BUYER_SK, meter, 'kaspa:testnet-10');
    assert.equal(offer.channel, undefined);
  } finally {
    await s.stop();
  }
});

test('the buyer refuses an Offer that names a different channel than it proposed', async () => {
  const s = await onRail(OFF_RAIL, async () => ({ covenantId: 'd2'.repeat(32), vouchedSompi: 0 }));
  try {
    await assert.rejects(() => openSession(s.base, BUYER_SK, meter, 'kaspa:testnet-10', undefined, PROPOSAL), /does not bill against the channel/);
  } finally {
    await s.stop();
  }
});
