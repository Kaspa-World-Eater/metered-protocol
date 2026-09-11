import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicKeyHex, signEnvelope, blake3Hex } from './encoding.js';
import { acceptOffer, OfferRejected } from './offer.js';
import { memoryHistory } from './history.js';
import { acceptReservation, ReservationRejected, priceOf, requiredFunding, CLOSE_FEE_SOMPI } from './reservation.js';
import { Checkpointer, isCheckpointBabel } from './checkpoint.js';
import type { BabelCursor } from './reservation.js';
import type { Offer, Reservation, State } from './types.js';

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

const offerWith = (over: Partial<Offer> = {}): Offer => signEnvelope({ ...BASE, ...over }, PROVIDER_SK);
const OFFER = offerWith();

/** SIGNED, because 3.2 says a Reservation is the buyer's signed authorisation. */
const reserve = (over: Partial<Reservation> = {}): Reservation =>
  signEnvelope({
    v: 1, sessionId: SESSION, seq: 0, units: 550,
    cumulativeUnits: 550, cumulativeSompi: 550 * 3630, prevState: null, ...over,
  }, BUYER_SK) as Reservation;

/** The same Reservation with no signature at all, for the refusal below. */
const unsigned = (over: Partial<Reservation> = {}): Reservation => ({
  v: 1, sessionId: SESSION, seq: 0, units: 550,
  cumulativeUnits: 550, cumulativeSompi: 550 * 3630, prevState: null, ...over,
});

/* ------------------------------------------------- §3.2, the Reservation */

test('§3.2 AUTH: an UNSIGNED Reservation is refused -- it authorises nothing', () => {
  // Found 2026-09-10 by audit. Nothing verified this, so a provider would deliver work to anyone
  // who knew a sessionId and held no evidence the buyer had authorised the babel it billed for.
  // Twelve existing tests were passing unsigned Reservations, which is how it stayed invisible.
  assert.throws(() => acceptReservation(OFFER, unsigned(), null), ReservationRejected);
});

test('§3.2 AUTH: a Reservation signed by the WRONG key is refused', () => {
  const notTheBuyer = signEnvelope({ ...unsigned() }, PROVIDER_SK) as Reservation;
  assert.throws(() => acceptReservation(OFFER, notTheBuyer, null), ReservationRejected);
});

test('§3.2 AUTH: a TAMPERED Reservation is refused -- the units are what was signed', () => {
  // The attack the signature actually stops: take a real signed Reservation for one babel and
  // raise `units` before handing it on.
  const tampered = { ...reserve(), units: 5_000_000 } as Reservation;
  assert.throws(() => acceptReservation(OFFER, tampered, null), ReservationRejected);
});


test('the first reservation starts at seq 0 and chains to null', () => {
  const cursor = acceptReservation(OFFER, reserve(), null);
  assert.equal(cursor.seq, 0);
  assert.equal(cursor.cumulativeSompi, priceOf(OFFER, 550));
});

test('THE EXPOSURE BOUND: units above babelUnits is refused', () => {
  // babelUnits is the entire trust model -- a buyer is never exposed to more than one chunk.
  assert.throws(() => acceptReservation(OFFER, reserve({ units: 551 }), null), ReservationRejected);
});

test('B4 THE REPLAY: seq must advance by exactly one, so an old reservation cannot be reused', () => {
  const first = acceptReservation(OFFER, reserve(), null);
  const cursor: BabelCursor = { ...first, stateDigest: blake3Hex('state-0') };
  assert.throws(() => acceptReservation(OFFER, reserve({ seq: 0 }), cursor), ReservationRejected);
});

test('a skipped chunk is refused -- no chunk slips past unbilled', () => {
  const first = acceptReservation(OFFER, reserve(), null);
  const cursor: BabelCursor = { ...first, stateDigest: blake3Hex('state-0') };
  const skipped = reserve({ seq: 2, cumulativeUnits: 1100, cumulativeSompi: 1100 * 3630, prevState: cursor.stateDigest });
  assert.throws(() => acceptReservation(OFFER, skipped, cursor), ReservationRejected);
});

test('§3.2 RECOMPUTED, NEVER TRUSTED: an inflated cumulativeSompi is refused', () => {
  // The sentence that stops a buyer handing the provider a free variable, or the reverse.
  assert.throws(
    () => acceptReservation(OFFER, reserve({ cumulativeSompi: 1 }), null),
    ReservationRejected,
  );
});

test('a cumulativeUnits that does not match the running total is refused', () => {
  assert.throws(() => acceptReservation(OFFER, reserve({ cumulativeUnits: 5000 }), null), ReservationRejected);
});

test('a reservation must chain to the previous DOUBLY-SIGNED State', () => {
  const first = acceptReservation(OFFER, reserve(), null);
  const cursor: BabelCursor = { ...first, stateDigest: blake3Hex('state-0') };
  const forked = reserve({ seq: 1, cumulativeUnits: 1100, cumulativeSompi: 1100 * 3630, prevState: blake3Hex('elsewhere') });
  assert.throws(() => acceptReservation(OFFER, forked, cursor), ReservationRejected);
});

test('the session ceiling is enforced -- maxBabels is a real limit', () => {
  const small = offerWith({ maxBabels: 1 });
  const first = acceptReservation(small, reserve(), null);
  const cursor: BabelCursor = { ...first, stateDigest: blake3Hex('state-0') };
  const second = reserve({ seq: 1, cumulativeUnits: 1100, cumulativeSompi: 1100 * 3630, prevState: cursor.stateDigest });
  assert.throws(() => acceptReservation(small, second, cursor), ReservationRejected);
});

test('a reservation from another session is refused', () => {
  assert.throws(() => acceptReservation(OFFER, reserve({ sessionId: 'c3'.repeat(16) }), null), ReservationRejected);
});

/* ----------------------------------------------------- §8, checkpoints */

const stateAt = (seq: number): State =>
  ({ v: 1, sessionId: SESSION, seq, cumulativeUnits: 550, cumulativeSompi: 1000, prevState: null });

test('§8: checkpoints fire every checkpointEvery chunks, and 0 disables them', () => {
  assert.equal(isCheckpointBabel(OFFER, 0), false);
  assert.equal(isCheckpointBabel(OFFER, 1), true); // checkpointEvery = 2
  assert.equal(isCheckpointBabel(offerWith({ checkpointEvery: 0 }), 99), false);
});

test('§8 NON-BLOCKING: recording returns before the anchor resolves', async () => {
  // The rule exists because Study B measured p90 at 1,879 ms. This asserts the shape that makes
  // stalling impossible: `record` is not async, so there is no promise to await.
  let release: (() => void) | undefined;
  const slow = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cp = new Checkpointer(() => slow.then(() => 'txid-1'));

  const entry = cp.record(OFFER, stateAt(1));
  assert.equal(entry?.status, 'pending', 'the session continues while the anchor confirms');

  release?.();
  await slow;
  await Promise.resolve();
  assert.equal(cp.get(1)?.status, 'confirmed');
  assert.equal(cp.get(1)?.txid, 'txid-1', 'a checkpoint nobody can locate is not evidence');
});

test('§8: settled() waits for dispatched anchors, so a REPORT can say what became of them', async () => {
  // `pending` is the state every record is born in, so a reporter that prints it and stops has
  // shown nothing -- it reads the same whether the anchor works or not. The demo printed exactly
  // that until this existed. Waiting is safe ONLY after a session is over, which is why the wait
  // lives here and not on any path a session takes.
  let release: (() => void) | undefined;
  const slow = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cp = new Checkpointer(() => slow.then(() => 'txid-late'));

  assert.equal(cp.record(OFFER, stateAt(1))?.status, 'pending');
  release?.();
  await cp.settled();
  assert.equal(cp.get(1)?.status, 'confirmed');
  assert.equal(cp.get(1)?.txid, 'txid-late');
});

test('§8: settled() returns even when every anchor FAILED, and still does not throw', async () => {
  const cp = new Checkpointer(() => Promise.reject(new Error('node unreachable')));
  cp.record(OFFER, stateAt(1));
  await cp.settled();
  assert.equal(cp.get(1)?.status, 'failed');
});

test('§8: settled() on a checkpointer that anchored nothing resolves immediately', async () => {
  const cp = new Checkpointer(() => Promise.resolve('unused'));
  await cp.settled();
  assert.equal(cp.all().length, 0);
});

test('§8: a FAILED anchor marks the record and never throws -- evidence is not safety', async () => {
  // A checkpoint proves a State existed; it cannot prevent a stale close. Losing one costs
  // evidence, never funds, so it must not be able to take down a session.
  const cp = new Checkpointer(() => Promise.reject(new Error('node unreachable')));
  const entry = cp.record(OFFER, stateAt(1));
  assert.equal(entry?.status, 'pending');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(cp.get(1)?.status, 'failed');
  assert.match(cp.get(1)?.error ?? '', /node unreachable/);
});

test('§8: a chunk that is not a checkpoint anchors nothing', () => {
  let calls = 0;
  const cp = new Checkpointer(() => {
    calls += 1;
    return Promise.resolve('txid');
  });
  assert.equal(cp.record(OFFER, stateAt(0)), null);
  assert.equal(calls, 0);
});

/* ------------------------------------- §7.4b, the funding floor (audit F6) */

test('§7.4b: requiredFunding covers the largest bill the Offer permits, plus the close fee', () => {
  // The covenant pays the provider EXACTLY pendingSompi. A total it cannot cover -- including the
  // fee for the transaction that pays it -- has no valid close at all, and the whole balance is
  // stranded. The covenant cannot check this: it would need the fee of a transaction that does
  // not exist yet. The buyer can, because the buyer chooses the funding amount.
  const maxBill = OFFER.maxBabels * OFFER.babelUnits * OFFER.unitPriceSompi;
  assert.equal(requiredFunding(OFFER), maxBill + CLOSE_FEE_SOMPI);
  assert.ok(requiredFunding(OFFER) > maxBill, 'the fee is not optional');
});

test('§7.4b: a session funded to requiredFunding can always pay its largest possible bill', () => {
  const funded = requiredFunding(OFFER);
  const maxBill = OFFER.maxBabels * OFFER.babelUnits * OFFER.unitPriceSompi;
  assert.ok(funded - CLOSE_FEE_SOMPI >= maxBill, 'the worst case still leaves the fee behind');
});
