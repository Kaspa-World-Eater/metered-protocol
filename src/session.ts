/**
 * The session driver -- the pieces of SPEC.md §§3-8, in the order a real chunk goes through them.
 *
 * Nothing new is decided here. Every rule lives in its own module and this composes them, which is
 * deliberate: the rules are testable without a session, and the ORDER is testable without
 * re-testing the rules.
 *
 * THE ONE THING WORTH READING TWICE. A Reservation's `cumulativeSompi` and a State's are different
 * numbers and must not be conflated. The Reservation authorises `units × unitPriceSompi` -- what
 * the buyer is willing to be exposed to for this chunk. The State settles `min(buyer, provider) ×
 * unitPriceSompi` -- what was actually delivered, per §5 rule 6. Authorised is a ceiling, billed
 * is a fact, and billing the authorised figure would quietly discard rule 6 and with it the
 * entire reason the counts are two-sided.
 */
import { digestHex } from './encoding.js';
import { acceptReservation, priceOf, type BabelCursor } from './reservation.js';
import { reconcileBabel } from './reconcile.js';
import { newBiasState, observeResidual, biasAlarm, type BiasState } from './bias.js';
import { signStateWithObligations, type SignerStore } from './signer.js';
import { Checkpointer } from './checkpoint.js';
import type { Halt, Measurement, Offer, Reservation, State } from './types.js';

export interface ChunkResult {
  state: State;
  buyerSig: string;
  providerSig: string;
  billedUnits: number;
  checkpointed: boolean;
}

export class SessionHalted extends Error {
  constructor(readonly halt: Halt) {
    super(`${halt.reason}: ${halt.detail}`);
  }
}

/**
 * Drives one session for BOTH parties, which is what a test needs and what a real deployment
 * splits in half. Keeping them together here is the only way to assert that the two halves agree.
 */
export class Session {
  private cursor: BabelCursor | null = null;
  private bias: BiasState = newBiasState();

  constructor(
    private readonly offer: Offer,
    private readonly buyerStore: SignerStore,
    private readonly providerStore: SignerStore,
    private readonly checkpointer: Checkpointer,
  ) {}

  get residualState(): BiasState {
    return this.bias;
  }

  get cumulativeSompi(): number {
    return this.cursor?.cumulativeSompi ?? 0;
  }

  /**
   * Run one chunk end to end: reserve, reconcile, bill, doubly sign, checkpoint.
   *
   * Throws SessionHalted on any rule failure. §1: "The only remedy for disagreement is to stop."
   */
  chunk(
    reservation: Reservation,
    buyerMeasurement: Measurement,
    providerMeasurement: Measurement,
    keys: { buyerSk: string; providerSk: string },
  ): ChunkResult {
    acceptReservation(this.offer, reservation, this.cursor);

    const outcome = reconcileBabel(this.offer, buyerMeasurement, providerMeasurement, reservation.seq);
    if (!outcome.ok) throw new SessionHalted(outcome);

    // §5.1.1. The residual is observed BEFORE the State is signed, so an alarming chunk is never
    // settled -- halting after signing would leave a signed State the counterparty could close on.
    this.bias = observeResidual(this.bias, outcome.residual);
    if (biasAlarm(this.bias)) {
      throw new SessionHalted({
        ok: false,
        reason: 'bias',
        detail: `CUSUM reached ${this.bias.sum} after ${this.bias.babels} chunks`,
      });
    }

    const state: State = {
      v: 1,
      sessionId: this.offer.sessionId,
      seq: reservation.seq,
      cumulativeUnits: outcome.billedCumulativeUnits,
      cumulativeSompi: priceOf(this.offer, outcome.billedCumulativeUnits),
      prevState: this.cursor?.stateDigest ?? null,
    };

    // Both parties sign the same bytes, each under its own obligations (§4). Neither signature
    // depends on the other existing, so the order here carries no meaning.
    const buyerSig = signStateWithObligations(this.buyerStore, state, keys.buyerSk);
    const providerSig = signStateWithObligations(this.providerStore, state, keys.providerSk);

    const checkpoint = this.checkpointer.record(this.offer, state);

    this.cursor = {
      seq: state.seq,
      cumulativeUnits: state.cumulativeUnits,
      cumulativeSompi: state.cumulativeSompi,
      stateDigest: digestHex(state),
    };

    return { state, buyerSig, providerSig, billedUnits: outcome.billedUnits, checkpointed: checkpoint !== null };
  }
}
