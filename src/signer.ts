/**
 * SPEC.md §4 -- the signer obligations.
 *
 * These are the rules that lose money without any message being malformed. Nothing here is
 * checkable by a counterparty and nothing here appears on the wire; a party that ignores them
 * produces perfectly valid States and then gets closed against on a stale one.
 *
 * RECORD-THEN-SEND, never send-then-record. §4.2 is the whole reason this module holds a store
 * rather than a variable. The dangerous interleaving is: sign, transmit, crash, restart, and sign
 * a DIFFERENT State at the same seq because the first was never written down. The counterparty
 * now holds two signed States at one seq and picks whichever pays it more, which is §4.1's
 * violation arriving through the back door. So the write happens before the signature is returned
 * to the caller, and a store that throws means no signature was ever handed out.
 */
import { digestHex, signState } from './encoding.js';
import type { State } from './types.js';

/** What a party must durably hold. Small on purpose: this gets written on every chunk. */
export interface SignerRecord {
  sessionId: string;
  /** Highest seq this party has signed. -1 before anything is signed. */
  highestSeq: number;
  /** Digest of the State at `highestSeq`, which the next State's `prevState` must match. */
  lastStateDigest: string | null;
}

/**
 * Durable storage. Synchronous by design -- an async save invites a caller to forget the await,
 * which turns record-then-send back into send-then-record silently.
 */
export interface SignerStore {
  load(sessionId: string): SignerRecord | null;
  save(record: SignerRecord): void;
}

export class SignerObligationError extends Error {}

export const emptyRecord = (sessionId: string): SignerRecord =>
  ({ sessionId, highestSeq: -1, lastStateDigest: null });

/**
 * Sign a State, or refuse. The refusals ARE the feature.
 *
 * §4.4's restart rule needs no separate code path: the record is loaded from the store on every
 * call, so a fresh process behaves exactly like a long-running one. A restart that forgets is a
 * store that lost data, not a signer that skipped a step.
 */
export function signStateWithObligations(
  store: SignerStore,
  state: State,
  privateKeyHex: string,
): string {
  const record = store.load(state.sessionId) ?? emptyRecord(state.sessionId);

  // §4.1 and §4.4: at most one State per seq, and never at or below the highest already signed.
  if (state.seq <= record.highestSeq) {
    throw new SignerObligationError(
      `refusing to sign seq ${state.seq}: already signed ${record.highestSeq} for this session`,
    );
  }

  // §4.3: the chain must be unbroken. A State whose prevState does not match what this party last
  // agreed to is either a fork or a splice, and signing it endorses a history it never saw.
  if (state.prevState !== record.lastStateDigest) {
    throw new SignerObligationError(
      `refusing to sign seq ${state.seq}: prevState ${state.prevState ?? 'null'} does not chain to ` +
        `${record.lastStateDigest ?? 'null'}`,
    );
  }

  // §4.2: RECORD, then sign, then return. The signature does not escape this function until the
  // store has accepted the write -- so a throw here means nothing was ever transmitted.
  store.save({
    sessionId: state.sessionId,
    highestSeq: state.seq,
    lastStateDigest: digestHex(state),
  });

  return signState(state, privateKeyHex);
}

/** An in-memory store. Fine for tests; a real party needs something that survives a crash. */
export function memoryStore(): SignerStore {
  const rows = new Map<string, SignerRecord>();
  return {
    load: (sessionId) => rows.get(sessionId) ?? null,
    save: (record) => {
      rows.set(record.sessionId, { ...record });
    },
  };
}
