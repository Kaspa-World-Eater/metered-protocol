import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestHex, publicKeyHex, verifyState } from './encoding.js';
import { signStateWithObligations, SignerObligationError, memoryStore, emptyRecord } from './signer.js';
import type { SignerStore } from './signer.js';
import type { State } from './types.js';

const SK = '11'.repeat(32);
const PK = publicKeyHex(SK);
const SESSION = 'a1'.repeat(16);

const stateAt = (seq: number, prevState: string | null, sompi = 1000 * (seq + 1)): State =>
  ({ v: 1, sessionId: SESSION, seq, cumulativeUnits: 550 * (seq + 1), cumulativeSompi: sompi, prevState });

test('a normal run signs an unbroken chain', () => {
  const store = memoryStore();
  const first = stateAt(0, null);
  const sig = signStateWithObligations(store, first, SK);
  assert.equal(verifyState(first, sig, PK), true);

  const second = stateAt(1, digestHex(first));
  assert.equal(verifyState(second, signStateWithObligations(store, second, SK), PK), true);
});

test('§4.1: signing a SECOND State at the same seq is refused', () => {
  // The violation that lets a counterparty hold two signed States at one seq and pick the better.
  const store = memoryStore();
  const first = stateAt(0, null);
  signStateWithObligations(store, first, SK);
  assert.throws(
    () => signStateWithObligations(store, { ...first, cumulativeSompi: 999999 }, SK),
    SignerObligationError,
  );
});

test('§4.4: signing BELOW the highest already signed is refused', () => {
  const store = memoryStore();
  const first = stateAt(0, null);
  signStateWithObligations(store, first, SK);
  signStateWithObligations(store, stateAt(1, digestHex(first)), SK);
  assert.throws(() => signStateWithObligations(store, stateAt(0, null), SK), SignerObligationError);
});

test('§4.3: a State that does not chain to the last one agreed is refused', () => {
  const store = memoryStore();
  const first = stateAt(0, null);
  signStateWithObligations(store, first, SK);
  const forked = stateAt(1, 'de'.repeat(32));
  assert.throws(() => signStateWithObligations(store, forked, SK), SignerObligationError);
});

test('§4.3: the FIRST State must chain to null, not to anything else', () => {
  assert.throws(
    () => signStateWithObligations(memoryStore(), stateAt(0, 'de'.repeat(32)), SK),
    SignerObligationError,
  );
});

test('§4.4 THE RESTART: a fresh process reads the store and refuses to re-sign', () => {
  // No separate restart path exists, deliberately -- the record is loaded on every call, so a new
  // process behaves identically to a long-running one.
  const rows = new Map<string, ReturnType<typeof emptyRecord>>();
  const persistent = (): SignerStore => ({
    load: (id) => rows.get(id) ?? null,
    save: (record) => {
      rows.set(record.sessionId, { ...record });
    },
  });

  const before = persistent();
  const first = stateAt(0, null);
  signStateWithObligations(before, first, SK);

  const afterCrash = persistent(); // same storage, new "process"
  assert.throws(() => signStateWithObligations(afterCrash, stateAt(0, null), SK), SignerObligationError);
  const next = stateAt(1, digestHex(first));
  assert.equal(verifyState(next, signStateWithObligations(afterCrash, next, SK), PK), true);
});

test('§4.2 RECORD-THEN-SEND: a store that cannot write yields NO signature', () => {
  // The interleaving this rule exists to stop: sign, transmit, crash, restart, sign a different
  // State at the same seq. If the write fails the caller must get nothing to transmit.
  const failing: SignerStore = {
    load: () => null,
    save: () => {
      throw new Error('disk full');
    },
  };
  assert.throws(() => signStateWithObligations(failing, stateAt(0, null), SK), /disk full/);
});

test('§4.2: the record is written BEFORE the signature exists, not after', () => {
  // Ordering is the whole rule, so it is asserted directly rather than inferred.
  const order: string[] = [];
  const spy: SignerStore = {
    load: () => null,
    save: () => {
      order.push('saved');
    },
  };
  signStateWithObligations(spy, stateAt(0, null), SK);
  order.push('returned');
  assert.deepEqual(order, ['saved', 'returned']);
});

test('sessions are independent -- one does not gate the other', () => {
  const store = memoryStore();
  signStateWithObligations(store, stateAt(0, null), SK);
  const other: State = { ...stateAt(0, null), sessionId: 'c3'.repeat(16) };
  assert.doesNotThrow(() => signStateWithObligations(store, other, SK));
});
