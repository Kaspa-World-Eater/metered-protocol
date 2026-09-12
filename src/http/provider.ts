/**
 * The provider's half of a metered session, as a transport-agnostic state machine.
 *
 * No HTTP in here on purpose. The rules are the interesting part and they are testable without a
 * socket; `serve.ts` is the thin layer that maps them onto requests. That split is the same one
 * the rest of this project uses -- the part with rules is tested against fixtures, the part with
 * I/O is proven live.
 *
 * WHAT THE PROVIDER IS TRUSTED FOR: nothing (SPEC.md 1). It counts its own delivery and says so,
 * and the buyer's count is an equal input to what settles. This class never sees the buyer's key
 * and cannot produce a State on its own.
 */
import { blake3Hex, signEnvelope } from '../encoding.js';
import { signStateWithObligations, memoryStore, type SignerStore } from '../signer.js';
import type { Checkpointer } from '../checkpoint.js';
import { acceptReservation, type BabelCursor } from '../reservation.js';
import { reconcileBabel } from '../reconcile.js';
import { newBiasState, observeResidual, biasAlarm, type BiasState } from '../bias.js';
import type { Halt, Measurement, Offer, Reservation, State } from '../types.js';
import { verifyVoucher, type Voucher } from '../rail/voucher.js';

/** Counts the units in delivered content. Injected, because SPEC.md 6 makes it the Offer's choice. */
export type Meter = (content: Uint8Array) => number;

/**
 * Produces the content for a chunk. This is the thing actually being sold.
 *
 * BYTES, NOT TEXT. Everything the protocol does to delivered content -- digest it, count it,
 * agree on it -- is defined over bytes, and this signature used to say `string`, which quietly
 * restricted the whole scheme to things expressible as text. A file is not, so a unit called
 * `net.bytes_delivered.v1` could be declared and never actually served.
 */
export type Deliver = (prompt: string, maxUnits: number) => Uint8Array;

/** The stand-in for content a restored session deliberately no longer holds. */
const EMPTY = new Uint8Array(0);

export class SessionRejected extends Error {
  constructor(readonly halt?: Halt) {
    super(halt ? `${halt.reason}: ${halt.detail}` : 'session rejected');
  }
}

/**
 * A countersignature arrived without the voucher that has to travel with it (docs/RAIL.md).
 *
 * Neither a halt nor an authentication failure: the buyer has agreed the number and not yet
 * authorised the money, and the remedy is for it to send the voucher, not for the session to
 * stop. Until it does, no further babel is delivered.
 */
export class VoucherRequired extends Error {}

interface Pending {
  seq: number;
  content: Uint8Array;
  units: number;
  contentDigest: string;
}

/**
 * Everything a session needs to be rebuilt after a restart.
 *
 * NOTE WHAT IS ABSENT: the delivered CONTENT. `settle` works from the babel's digest, its unit
 * count and its seq, and never reads the text again -- so a provider that persists sessions is
 * not thereby keeping a copy of everything it has ever said to anyone. That is a property of the
 * protocol rather than a precaution taken here: the digest is what the parties agreed about.
 */
export interface SessionSnapshot {
  offer: Offer;
  cursor: BabelCursor | null;
  pending: Omit<Pending, 'content'> | null;
  lastStateDigest: string | null;
  bias: BiasState;
  settled: [string, { state: State; providerSig: string; billedUnits: number }][];
  /** The rail's state, if the session is on it: how far it is vouched, and the voucher to claim with. */
  vouchedThroughSeq?: number;
  lastVoucher?: Voucher | null;
}

export class ProviderSession {
  private cursor: BabelCursor | null = null;
  private bias: BiasState = newBiasState();
  private pending: Pending | null = null;
  private lastStateDigest: string | null = null;

  private lastState: State | null = null;
  /** The seq of the last State whose voucher this session holds. -1 before any. */
  private vouchedThroughSeq = -1;
  private lastVoucher: Voucher | null = null;

  /**
   * Settled results by the buyer's `measurementId`, so SPEC.md 3.3's idempotency rule holds.
   * Bounded by `maxBabels`, which the Offer fixes, so it cannot grow without limit.
   */
  private readonly settled = new Map<string, { state: State; providerSig: string; billedUnits: number }>();

  constructor(
    readonly offer: Offer,
    private readonly providerSk: string,
    private readonly meter: Meter,
    private readonly deliver: Deliver,
    /** SPEC.md 8. Optional: a session with `checkpointEvery: 0` anchors nothing. */
    private readonly checkpointer?: Checkpointer,
    /**
     * SPEC.md 4. Defaults to a store that forgets on restart, which is fine for a test and is
     * NOT fine for a provider holding money: 4.4's restart rule is only as good as the store.
     * src/store.ts has one that survives a power cut.
     */
    private readonly store: SignerStore = memoryStore(),
  ) {}

  /** State that must outlive the process. See SessionSnapshot. */
  snapshot(): SessionSnapshot {
    const { content, ...pending } = this.pending ?? { content: EMPTY, seq: -1, units: 0, contentDigest: '' };
    void content;
    return {
      offer: this.offer,
      cursor: this.cursor,
      pending: this.pending ? pending : null,
      lastStateDigest: this.lastStateDigest,
      bias: this.bias,
      settled: [...this.settled.entries()],
      vouchedThroughSeq: this.vouchedThroughSeq,
      lastVoucher: this.lastVoucher,
    };
  }

  /** Rebuild a session from a snapshot. The counterparty cannot tell this from a long-lived one. */
  static restore(
    snap: SessionSnapshot,
    providerSk: string,
    meter: Meter,
    deliver: Deliver,
    checkpointer?: Checkpointer,
    store?: SignerStore,
  ): ProviderSession {
    const session = new ProviderSession(snap.offer, providerSk, meter, deliver, checkpointer, store);
    session.cursor = snap.cursor;
    session.lastStateDigest = snap.lastStateDigest;
    session.bias = snap.bias;
    session.pending = snap.pending ? { ...snap.pending, content: EMPTY } : null;
    for (const [id, result] of snap.settled) session.settled.set(id, result);
    session.vouchedThroughSeq = snap.vouchedThroughSeq ?? -1;
    session.lastVoucher = snap.lastVoucher ?? null;
    return session;
  }

  get pendingSeq(): number {
    return this.cursor?.seq ?? -1;
  }

  /**
   * Accept a Reservation and deliver one chunk, with the provider's own count of it.
   *
   * The Reservation is checked BEFORE anything is delivered -- units above `babelUnits`, a seq
   * that does not advance by exactly one, or totals that do not recompute all mean the buyer has
   * not authorised what it is asking for, and delivering first would be giving work away.
   */
  chunk(reservation: Reservation, prompt: string): { content: Uint8Array; measurement: Measurement } {
    acceptReservation(this.offer, reservation, this.cursor);
    // ON THE RAIL, NOTHING IS DELIVERED AGAINST AN UNVOUCHED STATE. The State and the voucher are
    // two signatures and only the voucher moves money; a buyer that signed the last State and
    // withheld its voucher holds a debt this provider cannot claim. So the previous babel must be
    // vouched before this one is served, which keeps the provider's exposure at exactly one babel.
    if (this.offer.channel && this.cursor && this.vouchedThroughSeq < this.cursor.seq) {
      throw new VoucherRequired(`babel ${this.cursor.seq} was countersigned but never vouched; send its voucher before asking for ${reservation.seq}`);
    }

    const content = this.deliver(prompt, reservation.units);
    const units = this.meter(content);
    const contentDigest = blake3Hex(content);
    this.pending = { seq: reservation.seq, content, units, contentDigest };

    const measurement: Measurement = {
      v: 1,
      sessionId: this.offer.sessionId,
      seq: reservation.seq,
      by: 'provider',
      units,
      cumulativeUnits: (this.cursor?.cumulativeUnits ?? 0) + units,
      contentDigest,
      measurementId: blake3Hex(`${this.offer.sessionId}/${reservation.seq}/provider`).slice(0, 32),
    };
    return { content, measurement: signEnvelope(measurement, this.providerSk) };
  }

  /**
   * Reconcile the buyer's count against the provider's and produce the State to be countersigned.
   *
   * The residual is fed to the bias detector BEFORE the State is signed, so a chunk that trips the
   * alarm is never settled -- signing first and halting after would hand the buyer a State it
   * could close on (SPEC.md 5.1.1).
   */
  settle(buyerMeasurement: Measurement): { state: State; providerSig: string; billedUnits: number } {
    // SPEC.md 3.3: `measurementId` is an idempotency key, and "a retransmission MUST be a no-op".
    // Without this a client that times out and retries -- which is ordinary HTTP behaviour, not
    // an attack -- finds `pending` already consumed, gets a SessionRejected, and kills its own
    // session. The settled result is returned again instead, unchanged.
    const replay = this.settled.get(buyerMeasurement.measurementId);
    if (replay) return replay;

    const pending = this.pending;
    if (!pending) throw new SessionRejected();

    const providerMeasurement: Measurement = {
      v: 1,
      sessionId: this.offer.sessionId,
      seq: pending.seq,
      by: 'provider',
      units: pending.units,
      cumulativeUnits: (this.cursor?.cumulativeUnits ?? 0) + pending.units,
      contentDigest: pending.contentDigest,
      measurementId: blake3Hex(`${this.offer.sessionId}/${pending.seq}/provider`).slice(0, 32),
    };
    const signedProvider = signEnvelope(providerMeasurement, this.providerSk);

    const outcome = reconcileBabel(this.offer, buyerMeasurement, signedProvider, pending.seq);
    if (!outcome.ok) throw new SessionRejected(outcome);

    this.bias = observeResidual(this.bias, outcome.residual);
    if (biasAlarm(this.bias)) {
      throw new SessionRejected({
        ok: false,
        reason: 'bias',
        detail: `CUSUM reached ${this.bias.sum} after ${this.bias.babels} chunks`,
      });
    }

    const state: State = {
      v: 1,
      sessionId: this.offer.sessionId,
      seq: pending.seq,
      cumulativeUnits: outcome.billedCumulativeUnits,
      cumulativeSompi: outcome.billedCumulativeUnits * this.offer.unitPriceSompi,
      prevState: this.lastStateDigest,
    };

    this.cursor = {
      seq: state.seq,
      cumulativeUnits: state.cumulativeUnits,
      cumulativeSompi: state.cumulativeSompi,
      stateDigest: null,
    };
    this.pending = null;
    this.lastState = state;
    // SPEC.md 4, THROUGH THE STORE. Never `signState` directly: 4.1 (one State per seq), 4.3 (the
    // chain is unbroken) and 4.2 (record BEFORE the signature escapes) are the rules that lose
    // money without any message being malformed, and none of them is checkable by a counterparty.
    const providerSig = signStateWithObligations(this.store, state, this.providerSk);
    const result = { state, providerSig, billedUnits: outcome.billedUnits };
    this.settled.set(buyerMeasurement.measurementId, result);
    return result;
  }

  /**
   * Record the digest of a State once both parties have signed it, so the chain can continue --
   * and checkpoint it if this chunk calls for one.
   *
   * THE CHECKPOINT HAPPENS HERE, not in `settle`, and the difference is the whole point of a
   * checkpoint. SPEC.md 8 anchors `digest(State)` as EVIDENCE that a State existed before a given
   * block. A State with one signature is not a State (SPEC.md 3.4), so anchoring at `settle` would
   * be publishing a claim the buyer had not yet agreed to -- evidence of nothing.
   *
   * It does not await. SPEC.md 8 requires checkpointing to be NON-BLOCKING because Study B
   * measured p90 confirmation at 1,879 ms, and a session that stalled two seconds every few chunks
   * would be unusable for a streamed response.
   */
  chainTo(digest: string, voucher?: Voucher): void {
    this.lastStateDigest = digest;
    if (this.cursor) this.cursor = { ...this.cursor, stateDigest: digest };
    if (this.checkpointer && this.lastState) this.checkpointer.record(this.offer, this.lastState);
    if (this.offer.channel) this.acceptVoucher(voucher);
  }

  /** The voucher covering the latest agreed State -- what the provider claims with. */
  voucher(): Voucher | null {
    return this.lastVoucher;
  }

  /**
   * The voucher must be the buyer's, for this channel, for exactly the ceiling this State brings
   * the channel to. A voucher for less is a buyer paying less than it agreed; for more, a buyer
   * overpaying, which the provider must not accept either -- it would be claiming money the State
   * does not justify.
   */
  private acceptVoucher(voucher: Voucher | undefined): void {
    const channel = this.offer.channel;
    const state = this.lastState;
    if (!channel || !state) return;
    if (!voucher) throw new VoucherRequired(`State ${state.seq} needs a voucher for ${channel.vouchedSompi + state.cumulativeSompi}`);
    const expected = String(channel.vouchedSompi + state.cumulativeSompi);
    if (voucher.amount !== expected) throw new VoucherRequired(`voucher is for ${voucher.amount}; State ${state.seq} calls for ${expected}`);
    if (!verifyVoucher(voucher, { network: this.offer.network, covenantId: channel.covenantId }, this.offer.buyerPubkey)) {
      throw new VoucherRequired('the voucher does not verify against the buyer for this channel');
    }
    this.vouchedThroughSeq = state.seq;
    this.lastVoucher = voucher;
  }
}
