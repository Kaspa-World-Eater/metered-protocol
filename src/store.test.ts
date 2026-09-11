import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileStore, fileHistory } from './store.js';
import { signStateWithObligations, SignerObligationError, emptyRecord } from './signer.js';
import { acceptOffer, OfferRejected } from './offer.js';
import { publicKeyHex, signEnvelope } from './encoding.js';
import type { Offer, State } from './types.js';

const dir = mkdtempSync(join(tmpdir(), 'metered-store-'));
const fresh = (name: string) => join(dir, `${name}-${Math.random().toString(36).slice(2)}.jsonl`);

const SK = '11'.repeat(32);
const SESSION = 'a1'.repeat(16);
const stateAt = (seq: number, prevState: string | null): State =>
  ({ v: 1, sessionId: SESSION, seq, cumulativeUnits: 550 * (seq + 1), cumulativeSompi: 1000, prevState }) as State;

/* --------------------------------------------------------- §4.4, the restart rule */

test('§4.4 THE RESTART, FOR REAL: a new store on the same file refuses to re-sign', () => {
  // signer.test.ts already proves a fresh PROCESS behaves like a long-running one given a store
  // that remembers. This is the store that actually remembers, which is the half that was missing.
  const path = fresh('signer');
  signStateWithObligations(fileStore(path), stateAt(0, null), SK);

  const afterRestart = fileStore(path);
  assert.equal(afterRestart.load(SESSION)?.highestSeq, 0);
  assert.throws(() => signStateWithObligations(afterRestart, stateAt(0, null), SK), SignerObligationError);
});

test('the log replays in order, so the HIGHEST seq survives a restart', () => {
  const path = fresh('signer');
  const store = fileStore(path);
  let prev: string | null = null;
  for (const seq of [0, 1, 2]) {
    signStateWithObligations(store, stateAt(seq, prev), SK);
    prev = store.load(SESSION)?.lastStateDigest ?? null;
  }
  assert.equal(fileStore(path).load(SESSION)?.highestSeq, 2);
});

test('the record is on the DISK before the signature is returned -- §4.2, not just in a Map', () => {
  // The failure this rules out is a buffered write: sign, transmit, lose power, restart with no
  // record, and sign a DIFFERENT State at the same seq. Reading the file with a separate handle
  // is the closest an in-process test can get to another process looking.
  const path = fresh('signer');
  signStateWithObligations(fileStore(path), stateAt(0, null), SK);
  const onDisk = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { seq?: number; highestSeq: number });
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0]?.highestSeq, 0);
});

test('A TORN FINAL LINE IS DISCARDED, and the records before it survive', () => {
  // A half-written append means `save` never returned, so no signature was handed out and the
  // record describes something that never happened. Dropping it is correct, not lenient.
  const path = fresh('signer');
  const store = fileStore(path);
  signStateWithObligations(store, stateAt(0, null), SK);
  appendFileSync(path, '{"sessionId":"a1a1","highest');

  const recovered = fileStore(path);
  assert.equal(recovered.load(SESSION)?.highestSeq, 0, 'the whole record before the tear is kept');
});

test('an empty or absent file is a store with nothing in it, not a crash', () => {
  assert.equal(fileStore(fresh('missing')).load(SESSION), null);
  const empty = fresh('empty');
  writeFileSync(empty, '');
  assert.equal(fileStore(empty).load(SESSION), null);
  assert.equal(emptyRecord(SESSION).highestSeq, -1);
});

/* ------------------------------------------------------- §3.1a, sessionId novelty */

const BUYER_SK = '22'.repeat(32);
const PROVIDER_SK = '33'.repeat(32);
const BASE = {
  v: 1, scheme: 'metered', network: 'kaspa:testnet-10', asset: 'KAS',
  sessionId: SESSION, unit: 'llm.output_tokens.v1', tokenizer: 'o200k_base',
  unitPriceSompi: 3630, babelUnits: 550, maxBabels: 64,
  toleranceAbs: 1, checkpointEvery: 2, responseWindowDaa: 600,
  buyerPubkey: publicKeyHex(BUYER_SK), providerPubkey: publicKeyHex(PROVIDER_SK),
  partiesCommitment: 'ff'.repeat(32),
} as Offer;
const offerWith = (over: Partial<Offer> = {}): Offer => signEnvelope({ ...BASE, ...over }, PROVIDER_SK) as Offer;

test('§3.1a ACROSS A RESTART: a reused sessionId is still refused by a new process', () => {
  // src/history.ts documents that its in-memory default forgets, which leaves a buyer open to a
  // provider that simply waits for it to restart. This is the store that closes that.
  const path = fresh('history');
  acceptOffer(offerWith(), undefined, fileHistory(path));
  assert.throws(() => acceptOffer(offerWith(), undefined, fileHistory(path)), OfferRejected);
});

test('§3.1a: history survives a restart per PROVIDER, not globally', () => {
  const path = fresh('history');
  acceptOffer(offerWith(), undefined, fileHistory(path));
  const otherProvider = signEnvelope({ ...BASE, providerPubkey: publicKeyHex(BUYER_SK) }, BUYER_SK) as Offer;
  assert.doesNotThrow(() => acceptOffer(otherProvider, undefined, fileHistory(path)));
});

test('§3.1a: a new sessionId from the same provider still works after a restart', () => {
  const path = fresh('history');
  acceptOffer(offerWith(), undefined, fileHistory(path));
  assert.doesNotThrow(() => acceptOffer(offerWith({ sessionId: 'c3'.repeat(16) }), undefined, fileHistory(path)));
});
