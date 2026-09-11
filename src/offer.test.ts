import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicKeyHex, signEnvelope } from './encoding.js';
import { acceptOffer, OfferRejected } from './offer.js';
import { memoryHistory } from './history.js';
import type { Offer } from './types.js';

const BUYER_SK = '11'.repeat(32);
const PROVIDER_SK = '22'.repeat(32);
const SESSION = 'a1'.repeat(16);

const BASE: Offer = {
  v: 1, scheme: 'metered', network: 'kaspa:testnet-10', asset: 'KAS',
  sessionId: SESSION, unit: 'llm.output_tokens.v1', meter: 'o200k_base',
  unitPriceSompi: 3630, babelUnits: 550, maxBabels: 64,
  toleranceAbs: 1, checkpointEvery: 2, responseWindowDaa: 600,
  buyerPubkey: publicKeyHex(BUYER_SK), providerPubkey: publicKeyHex(PROVIDER_SK),
  partiesCommitment: 'ff'.repeat(32),
};

const offerWith = (over: Partial<Offer> = {}): Offer => signEnvelope({ ...BASE, ...over }, PROVIDER_SK) as Offer;
const OFFER = offerWith();

/* ------------------------------------------------------------------- §3.1, the Offer */

test('a well-formed signed Offer is accepted', () => {
  assert.equal(acceptOffer(OFFER).sessionId, SESSION);
});

test('§3.1: toleranceAbs of 0 is rejected -- it would halt honest sessions', () => {
  // Study A measured a one-token divergence between honest parties. Zero tolerance turns the
  // first unlucky chunk into a halt.
  assert.throws(() => acceptOffer(offerWith({ toleranceAbs: 0 })), OfferRejected);
});

test('§3.1: an absent tokenizer is rejected -- an unnamed tokeniser is not usable', () => {
  assert.throws(() => acceptOffer(offerWith({ meter: '' })), OfferRejected);
});

test('§3.1/§7.3: a responseWindowDaa outside 1..=2^32-1 is rejected', () => {
  assert.throws(() => acceptOffer(offerWith({ responseWindowDaa: 0 })), OfferRejected);
  assert.throws(() => acceptOffer(offerWith({ responseWindowDaa: 4294967296 })), OfferRejected);
});

test('an unsigned or wrongly-signed Offer is rejected', () => {
  assert.throws(() => acceptOffer({ ...BASE }), OfferRejected);
  assert.throws(() => acceptOffer(signEnvelope({ ...BASE }, BUYER_SK)), OfferRejected);
});

test('a tampered Offer is rejected -- the terms are what was signed', () => {
  assert.throws(() => acceptOffer({ ...OFFER, unitPriceSompi: 1 }), OfferRejected);
});

test('a wrong network is rejected when the buyer states one', () => {
  assert.throws(() => acceptOffer(OFFER, 'kaspa:mainnet'), OfferRejected);
  assert.doesNotThrow(() => acceptOffer(OFFER, 'kaspa:testnet-10'));
});

test('§3.1a: a REUSED sessionId is rejected, because the provider chooses it', () => {
  // The provider does not have to forge anything to replay a State across sessions: it reissues a
  // sessionId it used before, and the buyer's own earlier signature settles the new session. No
  // width of sessionId prevents that and no on-chain rule can see it -- the covenant is
  // instantiated per session. Only the buyer, remembering, can refuse.
  const history = memoryHistory();
  assert.doesNotThrow(() => acceptOffer(OFFER, undefined, history));
  assert.throws(() => acceptOffer(OFFER, undefined, history), OfferRejected);
});

test('§3.1a: a DIFFERENT sessionId from the same provider is still accepted', () => {
  // The novelty rule must not break the ordinary case, which is many sessions with one provider.
  const history = memoryHistory();
  acceptOffer(OFFER, undefined, history);
  assert.doesNotThrow(() => acceptOffer(offerWith({ sessionId: 'c3'.repeat(16) }), undefined, history));
});

test('§3.1a: history is per PROVIDER -- two providers may pick the same id honestly', () => {
  const history = memoryHistory();
  acceptOffer(OFFER, undefined, history);
  const other = signEnvelope({ ...BASE, providerPubkey: publicKeyHex(BUYER_SK) }, BUYER_SK) as Offer;
  assert.doesNotThrow(() => acceptOffer(other, undefined, history));
});

test('§3.1a: a REJECTED Offer does not burn its sessionId', () => {
  // The history is recorded last, after the signature check. Otherwise anyone who can hand the
  // buyer an unsigned Offer could poison it against identifiers the provider has not used yet.
  const history = memoryHistory();
  assert.throws(() => acceptOffer({ ...BASE }, undefined, history), OfferRejected);
  assert.doesNotThrow(() => acceptOffer(OFFER, undefined, history));
});

test('§3.1: a 32-byte sessionId is rejected -- the width is fixed, not a minimum', () => {
  assert.throws(() => acceptOffer(offerWith({ sessionId: 'a1'.repeat(32) })), OfferRejected);
});

/* ------------------------------- cross-network replay, and why it is NOT on-chain */

test('§3.1a ALSO stops CROSS-NETWORK replay: the same sessionId on another network is refused', () => {
  // The §3.4.1 preimage does not commit to a network, and the redeem script hashes the same on
  // every network -- so in principle a State signed for a testnet session could settle a mainnet
  // covenant with the same parties and sessionId. In practice it cannot, because the buyer FUNDS
  // the covenant and would have to accept that sessionId twice. §3.1a's history is keyed by
  // provider and id, deliberately NOT by network, so the second Offer is refused wherever it
  // claims to be.
  const history = memoryHistory();
  acceptOffer(offerWith({ network: 'kaspa:testnet-10' }), undefined, history);
  assert.throws(
    () => acceptOffer(offerWith({ network: 'kaspa:mainnet' }), undefined, history),
    OfferRejected,
  );
});

test('a DIFFERENT sessionId on another network is fine -- the rule is novelty, not isolation', () => {
  const history = memoryHistory();
  acceptOffer(offerWith({ network: 'kaspa:testnet-10' }), undefined, history);
  assert.doesNotThrow(() =>
    acceptOffer(offerWith({ network: 'kaspa:mainnet', sessionId: 'c3'.repeat(16) }), undefined, history));
});
