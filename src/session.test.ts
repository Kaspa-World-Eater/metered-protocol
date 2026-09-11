import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicKeyHex, signEnvelope, blake3Hex, digestHex, verifyState } from './encoding.js';
import { Session, SessionHalted } from './session.js';
import { memoryStore } from './signer.js';
import { Checkpointer, type Anchor } from './checkpoint.js';
import type { Measurement, Offer, Reservation, State } from './types.js';

const BUYER_SK = '11'.repeat(32);
const PROVIDER_SK = '22'.repeat(32);
const SESSION = 'a1'.repeat(16);
const PRICE = 3630;
const CHUNK = 550;

const OFFER: Offer = signEnvelope({
  v: 1, scheme: 'metered', network: 'kaspa:testnet-10', asset: 'KAS',
  sessionId: SESSION, unit: 'llm.output_tokens.v1', meter: 'o200k_base',
  unitPriceSompi: PRICE, babelUnits: CHUNK, maxBabels: 64,
  toleranceAbs: 1, checkpointEvery: 2, responseWindowDaa: 600,
  buyerPubkey: publicKeyHex(BUYER_SK), providerPubkey: publicKeyHex(PROVIDER_SK),
  partiesCommitment: 'ff'.repeat(32),
}, PROVIDER_SK) as Offer;

const KEYS = { buyerSk: BUYER_SK, providerSk: PROVIDER_SK };

function newSession(anchor: Anchor = () => Promise.resolve('txid')) {
  return new Session(OFFER, memoryStore(), memoryStore(), new Checkpointer(anchor));
}

/** A chunk's three messages. `settled` is what previous chunks actually billed. */
function chunkMessages(seq: number, settledUnits: number, prevDigest: string | null, buyerUnits: number, providerUnits = CHUNK) {
  const reservation = signEnvelope({
    v: 1, sessionId: SESSION, seq, units: CHUNK,
    cumulativeUnits: settledUnits + CHUNK,
    cumulativeSompi: (settledUnits + CHUNK) * PRICE,
    prevState: prevDigest,
  }, BUYER_SK) as Reservation;
  const digest = blake3Hex(`chunk-${seq}`);
  const measure = (by: 'buyer' | 'provider', units: number, sk: string): Measurement =>
    signEnvelope({
      v: 1, sessionId: SESSION, seq, by, units,
      cumulativeUnits: settledUnits + units, contentDigest: digest,
      measurementId: blake3Hex(`${by}-${seq}`).slice(0, 32),
    } as Measurement, sk) as Measurement;
  return {
    reservation,
    buyer: measure('buyer', buyerUnits, BUYER_SK),
    provider: measure('provider', providerUnits, PROVIDER_SK),
  };
}

test('a clean multi-chunk session settles, chains, and checkpoints on schedule', () => {
  const session = newSession();
  let settled = 0;
  let prev: string | null = null;
  const states: State[] = [];

  for (let seq = 0; seq < 4; seq += 1) {
    const m = chunkMessages(seq, settled, prev, CHUNK);
    const result = session.chunk(m.reservation, m.buyer, m.provider, KEYS);

    assert.equal(result.billedUnits, CHUNK);
    assert.equal(result.state.prevState, prev, 'each State chains to the last');
    assert.equal(verifyState(result.state, result.buyerSig, OFFER.buyerPubkey), true);
    assert.equal(verifyState(result.state, result.providerSig, OFFER.providerPubkey), true);
    // checkpointEvery is 2, so chunks 1 and 3 anchor and 0 and 2 do not.
    assert.equal(result.checkpointed, seq % 2 === 1, `chunk ${seq} checkpoint`);

    settled = result.state.cumulativeUnits;
    prev = digestHex(result.state);
    states.push(result.state);
  }

  assert.equal(settled, 4 * CHUNK);
  assert.equal(session.cumulativeSompi, 4 * CHUNK * PRICE);
  assert.equal(new Set(states.map((s) => s.seq)).size, 4, 'no seq is reused');
});

test('RULE 6 END TO END: a one-token divergence bills the lower count, and the session continues', () => {
  // The exact divergence Study A measured. It must not halt anything -- toleranceAbs is 1
  // precisely so an honest session survives it.
  const session = newSession();
  const m = chunkMessages(0, 0, null, CHUNK - 1);
  const result = session.chunk(m.reservation, m.buyer, m.provider, KEYS);

  assert.equal(result.billedUnits, CHUNK - 1, 'billed the lower of the two counts');
  assert.equal(result.state.cumulativeSompi, (CHUNK - 1) * PRICE);
  assert.equal(session.residualState.sum, 0.5, 'the residual is fed to the detector, not ignored');
});

test('the billed amount, not the AUTHORISED amount, is what the State settles', () => {
  // The Reservation authorises 550 units; the parties agree only 549 were delivered. Settling the
  // authorised figure would silently discard rule 6 and the whole point of two-sided counting.
  const session = newSession();
  const m = chunkMessages(0, 0, null, CHUNK - 1);
  assert.equal(m.reservation.cumulativeSompi, CHUNK * PRICE, 'authorised');
  const result = session.chunk(m.reservation, m.buyer, m.provider, KEYS);
  assert.notEqual(result.state.cumulativeSompi, m.reservation.cumulativeSompi);
  assert.equal(result.state.cumulativeSompi, (CHUNK - 1) * PRICE, 'settled');
});

test('a divergence past tolerance halts the session', () => {
  const session = newSession();
  const m = chunkMessages(0, 0, null, 400);
  assert.throws(() => session.chunk(m.reservation, m.buyer, m.provider, KEYS), SessionHalted);
});

test('B1 SUSTAINED SHAVING: the bias detector halts a buyer riding the tolerance', () => {
  // Every chunk is individually legal -- one token, inside toleranceAbs. Only the RATE gives it
  // away, which is what §5.1.1 exists to measure.
  const session = newSession();
  let settled = 0;
  let prev: string | null = null;
  let halted = 0;

  for (let seq = 0; seq < 40; seq += 1) {
    const m = chunkMessages(seq, settled, prev, CHUNK - 1);
    try {
      const result = session.chunk(m.reservation, m.buyer, m.provider, KEYS);
      settled = result.state.cumulativeUnits;
      prev = digestHex(result.state);
    } catch (err) {
      assert.ok(err instanceof SessionHalted);
      assert.equal(err.halt.reason, 'bias');
      halted = seq;
      break;
    }
  }
  // Ten observations are needed (10 x (1 - 0.5) = 5 = H), and they are seqs 0..9, so the alarm
  // lands ON seq 9. Study C reports the same event as "median 10 chunks"; both are the same fact
  // counted from different ends, which is exactly the sort of off-by-one worth pinning in a test.
  assert.equal(halted, 9, 'the 10th observation trips it, which is seq 9');
});

test('a halted chunk leaves NO signed State behind', () => {
  // The residual is observed before signing, so an alarming chunk is never settled. Signing first
  // would hand the counterparty a State it could close on after the halt.
  const session = newSession();
  let settled = 0;
  let prev: string | null = null;
  let lastGood: State | null = null;

  for (let seq = 0; seq < 40; seq += 1) {
    const m = chunkMessages(seq, settled, prev, CHUNK - 1);
    try {
      const result = session.chunk(m.reservation, m.buyer, m.provider, KEYS);
      settled = result.state.cumulativeUnits;
      prev = digestHex(result.state);
      lastGood = result.state;
    } catch {
      break;
    }
  }
  assert.equal(lastGood?.seq, 8, 'seq 9 alarmed, so seq 8 is the last State ever signed');
});

test('a replayed reservation cannot re-run a chunk that already settled', () => {
  const session = newSession();
  const first = chunkMessages(0, 0, null, CHUNK);
  session.chunk(first.reservation, first.buyer, first.provider, KEYS);
  assert.throws(() => session.chunk(first.reservation, first.buyer, first.provider, KEYS));
});
