/**
 * Can somebody actually BUILD something using only the public surface?
 *
 * Not "does index.ts export enough names" -- that question is answerable by looking, and looking
 * is what missed it. `ServiceOptions` accepts an `anchor` and a `sessions` store, and for a while
 * neither the `Anchor` interface nor the snapshot type behind `SessionStore` was exported. The
 * surface looked complete: a caller could see exactly where its own implementation was meant to
 * go, and had no way to write one.
 *
 * So this file imports ONLY from the package entry point, the way a stranger would, and
 * implements every interface the protocol asks a caller to supply. Nothing here asserts much at
 * runtime. The test is that it COMPILES -- a type that is named in an exported signature and not
 * exported itself makes this file fail to build, and typecheck is in the gate.
 *
 * The rule it enforces: a type reachable from the public API is part of the public API, whether or
 * not anybody remembered to say so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MeteredService, serveMetered, meterFor, utf8, publicKeyHex, partiesCommitment,
  memoryStore, memoryHistory, shouldSettle, isCheckpointBabel, minimumTolerance, resolveMeter,
  type Anchor, type CheckpointRecord, type SessionStore, type SessionSnapshot,
  type SignerStore, type SignerRecord, type SessionHistory, type ServeOptions,
  type ExposurePolicy, type OfferTerms, type Deliver, type Meter, type State, type Offer,
} from './index.js';

const PROVIDER_SK = 'cd'.repeat(32);

/**
 * SPEC.md 8. A checkpoint anchor is the caller's to provide: it puts a digest on chain and returns
 * the transaction carrying it, because a checkpoint nobody can locate is not evidence.
 */
const anchor: Anchor = async (digest: string): Promise<string> => `tx-for-${digest.slice(0, 8)}`;

/** SPEC.md 4. A signer store is where the obligations live; a caller may keep them anywhere. */
function storeInMemory(): SignerStore {
  const rows = new Map<string, SignerRecord>();
  return {
    load: (sessionId: string) => rows.get(sessionId) ?? null,
    save: (record: SignerRecord) => { rows.set(record.sessionId, record); },
  };
}

/** Sessions that survive a restart -- also the caller's, and also an interface it must implement. */
function sessionsInMemory(): SessionStore {
  const rows = new Map<string, SessionSnapshot>();
  return {
    load: (sessionId: string) => rows.get(sessionId) ?? null,
    save: (snapshot: SessionSnapshot) => { rows.set(snapshot.offer.sessionId, snapshot); },
    drop: (sessionId: string) => { rows.delete(sessionId); },
  };
}

const history: SessionHistory = memoryHistory();

const TERMS: OfferTerms = {
  v: 1, scheme: 'metered', network: 'kaspa:testnet-10', asset: 'KAS',
  unit: 'net.bytes_delivered.v1', meter: 'octets',
  unitPriceSompi: 20, babelUnits: 4096, maxBabels: 8,
  toleranceAbs: 0, checkpointEvery: 0, responseWindowDaa: 600,
};

test('a provider can be assembled from the package entry point alone', () => {
  const meter: Meter = meterFor(TERMS.meter, TERMS.unit);
  const deliver: Deliver = (_prompt, maxUnits) => utf8('x'.repeat(maxUnits));

  const service = new MeteredService({
    terms: TERMS,
    providerSk: PROVIDER_SK,
    providerPubkey: publicKeyHex(PROVIDER_SK),
    meter,
    deliver,
    anchor,
    store: storeInMemory(),
    sessions: sessionsInMemory(),
    maxSessions: 4,
  });

  const opts: ServeOptions = { service };
  const server = serveMetered(opts);
  assert.equal(typeof server.listen, 'function');
  server.close();
});

test('the pieces a buyer needs are all reachable from the entry point', () => {
  const buyerPk = publicKeyHex('ab'.repeat(32));
  const providerPk = publicKeyHex(PROVIDER_SK);

  // The commitment binding the two parties, which consensus recomputes in script.
  assert.match(partiesCommitment(buyerPk, providerPk), /^[0-9a-f]{64}$/);

  // The tolerance floor belongs to the meter, and both are reachable.
  assert.equal(minimumTolerance(resolveMeter('octets')), 0);

  // SPEC.md 7.3a -- deciding when to settle is the provider's obligation, not a helper's. It
  // answers with a reason as well as a verdict, because "settle now" that cannot say why is not
  // something an operator can argue with.
  const policy: ExposurePolicy = { settleByAgeDaa: 400, settleAtUnsettledSompi: 5_000_000 };
  assert.equal(shouldSettle(policy, { ageDaa: 401, unsettledSompi: 1_000 }).settle, true, 'past the deadline');
  assert.equal(shouldSettle(policy, { ageDaa: 1, unsettledSompi: 5_000_000 }).settle, true, 'at the exposure limit');
  assert.equal(shouldSettle(policy, { ageDaa: 1, unsettledSompi: 1_000 }).settle, false);
  // Nothing owed is nothing to post, however old the covenant gets.
  assert.equal(shouldSettle(policy, { ageDaa: 9_999, unsettledSompi: 0 }).settle, false);
  assert.match(shouldSettle(policy, { ageDaa: 401, unsettledSompi: 1_000 }).why ?? '', /deadline/);

  // SPEC.md 8 -- which babels carry a checkpoint, decided from the Offer's own terms.
  const offer = { ...TERMS, checkpointEvery: 2 } as unknown as Offer;
  assert.equal(isCheckpointBabel(offer, 1), true, 'every second babel');
  assert.equal(isCheckpointBabel(offer, 0), false);

  // A record the anchor produced, typed by the package rather than by this file.
  const checkpoint: CheckpointRecord = { seq: 0, digest: 'ab'.repeat(32), status: 'pending' };
  assert.equal(checkpoint.status, 'pending');

  // A store implemented above satisfies the same interface the package ships.
  const mine = storeInMemory();
  const theirs = memoryStore();
  const record: SignerRecord = { sessionId: 'ab'.repeat(8), highestSeq: -1, lastStateDigest: null };
  mine.save(record);
  theirs.save(record);
  assert.equal(mine.load(record.sessionId)?.sessionId, theirs.load(record.sessionId)?.sessionId);

  void history;
  void (null as unknown as State);
});
