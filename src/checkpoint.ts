/**
 * SPEC.md §8 -- checkpoints, which MUST be non-blocking.
 *
 * WHY THE RULE EXISTS, in one measurement. Study B anchored 25 checkpoints on testnet-10 and found
 * p50 1,053 ms and p90 1,879 ms. A session that awaited each anchor would stall for roughly two
 * seconds every `checkpointEvery` babels, which for a streamed response is the difference between
 * a working product and an unusable one. So the session continues while the anchor confirms, and
 * this module never returns a promise the caller is tempted to await.
 *
 * WHAT A CHECKPOINT IS FOR, and what it is NOT. §8: "Checkpoints are evidence, not safety." They
 * prove a State existed before a given block, which makes a stale close provable and attributable
 * after the fact. They cannot PREVENT one -- the covenant cannot recover a State from a digest, so
 * it cannot enforce a minimum seq. Prevention is §7.2's response window. A failed anchor therefore
 * costs evidence, never funds, which is exactly why failing one is allowed not to stop anything.
 */
import { digestHex } from './encoding.js';
import type { Offer, State } from './types.js';

/**
 * Anchors a 32-byte digest on-chain and returns the transaction that carries it.
 *
 * IT RETURNS THE TXID BECAUSE A CHECKPOINT NOBODY CAN FIND IS NOT EVIDENCE. SPEC.md 8's whole
 * claim is that a checkpoint proves a State existed before a given block; proving it means
 * fetching that transaction and reading the payload back. A record that says only "confirmed"
 * asks a future reader to take this process's word for it, which is the opposite of the point.
 *
 * Still fire-and-forget: the session never waits on the promise.
 */
export type Anchor = (digest: string) => Promise<string>;

export interface CheckpointRecord {
  seq: number;
  digest: string;
  status: 'pending' | 'confirmed' | 'failed';
  /** The transaction carrying the digest. Absent until the anchor resolves; this is the evidence. */
  txid?: string;
  error?: string;
}

/** §8: every `checkpointEvery` babels. `0` disables checkpointing entirely. */
export function isCheckpointBabel(offer: Offer, seq: number): boolean {
  if (offer.checkpointEvery <= 0) return false;
  return (seq + 1) % offer.checkpointEvery === 0;
}

/**
 * The checkpointer. Deliberately NOT async: `record` returns as soon as the anchor is dispatched,
 * so there is no promise for a caller to await and no way for a slow chain to become a slow
 * session. The only way to observe an anchor is to ask afterwards.
 */
export class Checkpointer {
  private readonly records = new Map<number, CheckpointRecord>();

  /**
   * In-flight anchors, held ONLY so a reporter can wait for them after a session is over.
   * Nothing in a session ever reads this: the moment it does, a slow chain becomes a slow session,
   * which is the exact failure 8 exists to prevent.
   */
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(private readonly anchor: Anchor) {}

  /**
   * Anchor this State's digest if its babel calls for one. Returns the record immediately, always
   * `pending`, because the point is that nothing waits.
   */
  record(offer: Offer, state: State): CheckpointRecord | null {
    if (!isCheckpointBabel(offer, state.seq)) return null;

    const entry: CheckpointRecord = { seq: state.seq, digest: digestHex(state), status: 'pending' };
    this.records.set(state.seq, entry);

    // A rejected anchor marks the record and stops there. It MUST NOT propagate: an unhandled
    // rejection here would take down a session over lost evidence, and evidence is not safety.
    const flight = this.anchor(entry.digest).then(
      (txid) => {
        entry.status = 'confirmed';
        entry.txid = txid;
      },
      (err: unknown) => {
        entry.status = 'failed';
        entry.error = err instanceof Error ? err.message : String(err);
      },
    );
    this.inFlight.add(flight);
    void flight.finally(() => this.inFlight.delete(flight));

    return entry;
  }

  get(seq: number): CheckpointRecord | undefined {
    return this.records.get(seq);
  }

  all(): CheckpointRecord[] {
    return [...this.records.values()].sort((a, b) => a.seq - b.seq);
  }

  /** Checkpoints still in flight. A session MAY close with these outstanding; §8 allows it. */
  pending(): CheckpointRecord[] {
    return this.all().filter((r) => r.status === 'pending');
  }

  /**
   * Wait for every dispatched anchor to finish, for REPORTING ONLY.
   *
   * A session must never call this. It exists because a reporter that prints `pending` and stops
   * has proved nothing -- it has printed the state a record is BORN in, which every record shows
   * whether the anchor works or not. Waiting once, after the session has already closed, is what
   * makes the difference between confirmed and failed visible.
   */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }
}
