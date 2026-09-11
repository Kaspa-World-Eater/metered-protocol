import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicKeyHex, signEnvelope, blake3Hex } from '../encoding.js';
import { ProviderSession } from './provider.js';
import { fileStore } from '../store.js';
import { memoryStore, SignerObligationError } from '../signer.js';
import { meterFor } from '../tokenizer.js';
import type { Measurement, Offer, Reservation } from '../types.js';

/**
 * SPEC.md §4 ON THE PATH THAT ACTUALLY RUNS.
 *
 * src/signer.ts implemented all four signer obligations and src/session.ts used them. Until
 * 2026-09-10 nothing else did: this HTTP server -- the one every demo and every live settlement
 * goes through -- called `signState` directly, so §4.1, §4.2 and §4.4 were enforced only inside
 * another module's own test. The rules were present and unreachable.
 *
 * These exist so that cannot quietly become true again.
 */
const PROVIDER_SK = '22'.repeat(32);
const BUYER_SK = '11'.repeat(32);
const dir = mkdtempSync(join(tmpdir(), 'metered-oblig-'));
const path = () => join(dir, `s-${Math.random().toString(36).slice(2)}.jsonl`);

const meter = meterFor('o200k_base');
const deliver = (prompt: string, maxUnits: number) =>
  Array.from({ length: maxUnits }, (_, i) => `${prompt}${i}`).join(' ');

const SESSION = 'a1'.repeat(16);
const OFFER = signEnvelope(
  {
    v: 1, scheme: 'metered', network: 'kaspa:testnet-10', asset: 'KAS',
    sessionId: SESSION, unit: 'llm.output_tokens.v1', tokenizer: 'o200k_base',
    unitPriceSompi: 3630, babelUnits: 40, maxBabels: 8,
    toleranceAbs: 2, checkpointEvery: 0, responseWindowDaa: 600,
    buyerPubkey: publicKeyHex(BUYER_SK), providerPubkey: publicKeyHex(PROVIDER_SK),
    partiesCommitment: 'ff'.repeat(32),
  },
  PROVIDER_SK,
) as Offer;

const reserve = (seq: number): Reservation =>
  signEnvelope(
    {
      v: 1, sessionId: SESSION, seq, units: OFFER.babelUnits,
      cumulativeUnits: OFFER.babelUnits * (seq + 1),
      cumulativeSompi: OFFER.babelUnits * (seq + 1) * OFFER.unitPriceSompi,
      prevState: null,
    },
    BUYER_SK,
  ) as Reservation;

/** Run one chunk and hand back the buyer's Measurement, which is what `settle` consumes. */
function buyerMeasurement(content: string, seq: number, units: number, cumulative: number): Measurement {
  return signEnvelope(
    {
      v: 1, sessionId: SESSION, seq, by: 'buyer', units, cumulativeUnits: cumulative,
      contentDigest: blake3Hex(content),
      measurementId: blake3Hex(`${SESSION}/${seq}/buyer`).slice(0, 32),
    },
    BUYER_SK,
  ) as Measurement;
}

const sessionWith = (store: ReturnType<typeof memoryStore>) =>
  new ProviderSession(OFFER, PROVIDER_SK, meter, deliver, undefined, store);

/** Drive seq 0 to a signed State. Returns the store it signed through. */
function settleSeqZero(store: ReturnType<typeof memoryStore>) {
  const session = sessionWith(store);
  const { content } = session.chunk(reserve(0), 'x');
  const units = meter(content);
  return { session, out: session.settle(buyerMeasurement(content, 0, units, units)) };
}

test('§4.2 THE LIVE PATH RECORDS: a settle over HTTP writes to the store before signing', () => {
  const store = memoryStore();
  const { out } = settleSeqZero(store);
  assert.ok(out.providerSig, 'a signature came back');
  assert.equal(store.load(SESSION)?.highestSeq, 0, 'and the store knows about it');
});

test('§4.1/§4.4 ON THE LIVE PATH: a second State at the same seq is REFUSED, not signed', () => {
  // Before the store was threaded through, this produced a second valid signature at seq 0 --
  // handing the counterparty a choice of which State to settle, and it will not choose the
  // cheaper one. The refusal is the whole point of SPEC.md 4.
  const store = memoryStore();
  settleSeqZero(store);

  const second = sessionWith(store); // same store: same party, same session
  const { content } = second.chunk(reserve(0), 'y');
  const units = meter(content);
  assert.throws(
    () => second.settle(buyerMeasurement(content, 0, units, units)),
    SignerObligationError,
  );
});

test('§4.4 THE RESTART, END TO END: a fresh session on a FILE store still refuses seq 0', () => {
  // The durable half. A provider that restarts and forgets is the same as one that never
  // recorded -- src/store.ts is what makes 4.4 true rather than merely available.
  const file = path();
  settleSeqZero(fileStore(file) as ReturnType<typeof memoryStore>);

  const afterRestart = sessionWith(fileStore(file) as ReturnType<typeof memoryStore>);
  const { content } = afterRestart.chunk(reserve(0), 'z');
  const units = meter(content);
  assert.throws(
    () => afterRestart.settle(buyerMeasurement(content, 0, units, units)),
    SignerObligationError,
  );
});

test('a memory store does NOT survive the restart -- the difference is real, not decorative', () => {
  // The contrast that makes the test above mean something. Same sequence, forgetful store, and
  // the second signature is handed out.
  settleSeqZero(memoryStore());
  const { out } = settleSeqZero(memoryStore());
  assert.ok(out.providerSig, 'a forgetful provider signs seq 0 twice across a restart');
});
