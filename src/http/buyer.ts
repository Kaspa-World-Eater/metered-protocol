/**
 * The buyer's half of a metered session.
 *
 * WHAT THE BUYER IS TRUSTED FOR: nothing either (SPEC.md 1). It counts what it actually received
 * and signs that. If its count and the provider's disagree past tolerance the session stops --
 * there is no arbiter, and "the only remedy for disagreement is to stop."
 *
 * THE BUYER COUNTS THE BYTES IT WAS GIVEN, not the ones it was told about. That sentence is the
 * whole product. Everything else here is bookkeeping around it.
 */
import { blake3Hex, digestHex, signEnvelope, verify, verifyState } from '../encoding.js';
import { signStateWithObligations, memoryStore, type SignerStore } from '../signer.js';
import { acceptOffer } from '../offer.js';
import { memoryHistory, type SessionHistory } from '../history.js';
import { priceOf, requiredFunding, CLOSE_FEE_SOMPI } from '../reservation.js';
import { newBiasState, observeResidual, biasAlarm, type BiasState } from '../bias.js';
import { toleranceBound } from '../reconcile.js';
import type { Measurement, Offer, Reservation, State } from '../types.js';
import type { Meter } from './provider.js';

export class BuyerRefused extends Error {}

export class BuyerSession {
  private seq = -1;
  private cumulativeUnits = 0;
  private cumulativeSompi = 0;
  private lastStateDigest: string | null = null;
  private bias: BiasState = newBiasState();

  constructor(
    readonly offer: Offer,
    private readonly buyerSk: string,
    private readonly meter: Meter,
    expectedNetwork?: string,
    /**
     * SPEC.md 3.1a. Defaults to a history that remembers nothing before this session, which
     * catches nothing -- a single session cannot repeat an identifier. A buyer that runs more
     * than one session against a provider MUST pass a history that outlives them all.
     */
    history: SessionHistory = memoryHistory(),
    /** SPEC.md 4, and the same warning as the provider's: the default forgets on restart. */
    private readonly store: SignerStore = memoryStore(),
    /**
     * SPEC.md 7.4b. What the covenant actually holds, if this buyer funded one. Supplying it lets
     * the buyer refuse to agree a total the covenant could never pay out -- see `countersign`.
     */
    private readonly fundedSompi?: number,
  ) {
    acceptOffer(offer, expectedNetwork, history);
  }

  get spentSompi(): number {
    return this.cumulativeSompi;
  }

  /** Authorise exactly one chunk. Never the session (SPEC.md 3.2). */
  reserve(units = this.offer.babelUnits): Reservation {
    if (units > this.offer.babelUnits) throw new BuyerRefused('refusing to reserve more than one chunk');
    const next = this.seq + 1;
    const reservation: Reservation = {
      v: 1,
      sessionId: this.offer.sessionId,
      seq: next,
      units,
      cumulativeUnits: this.cumulativeUnits + units,
      cumulativeSompi: this.cumulativeSompi + priceOf(this.offer, units),
      prevState: this.lastStateDigest,
    };
    return signEnvelope(reservation, this.buyerSk);
  }

  /**
   * Count the delivered content and produce the buyer's Measurement.
   *
   * The provider's Measurement is checked here for signature and content digest, but its COUNT is
   * not adopted -- that is the point. A mismatched digest means the two sides are describing
   * different bytes, and no amount of counting can reconcile that (SPEC.md 5 rule 3).
   */
  measure(content: string, providerMeasurement: Measurement, seq: number): Measurement {
    if (!verify(providerMeasurement, this.offer.providerPubkey)) {
      throw new BuyerRefused('the provider Measurement does not verify');
    }
    const contentDigest = blake3Hex(content);
    if (providerMeasurement.contentDigest !== contentDigest) {
      throw new BuyerRefused('the provider is describing different bytes than it delivered');
    }
    const units = this.meter(content);
    const bound = toleranceBound(this.offer, providerMeasurement.units);
    if (Math.abs(units - providerMeasurement.units) > bound) {
      throw new BuyerRefused(`counts differ by more than ${bound}: ${units} vs ${providerMeasurement.units}`);
    }
    const measurement: Measurement = {
      v: 1,
      sessionId: this.offer.sessionId,
      seq,
      by: 'buyer',
      units,
      cumulativeUnits: this.cumulativeUnits + units,
      contentDigest,
      measurementId: blake3Hex(`${this.offer.sessionId}/${seq}/buyer`).slice(0, 32),
    };
    return signEnvelope(measurement, this.buyerSk);
  }

  /**
   * Check the State the provider proposes, and countersign it if it is right.
   *
   * RECOMPUTED, NEVER TRUSTED. The amount is derived from the Offer's price and the agreed units,
   * not read off the wire -- a buyer that signs whatever `cumulativeSompi` arrives has handed the
   * provider a blank cheque with a signature already on it.
   */
  countersign(state: State, providerSig: string, myUnits: number): string {
    if (state.sessionId !== this.offer.sessionId) throw new BuyerRefused('State is for another session');
    if (state.seq !== this.seq + 1) throw new BuyerRefused(`State seq ${state.seq} does not follow ${this.seq}`);
    if (state.prevState !== this.lastStateDigest) throw new BuyerRefused('State does not chain to the last one');

    const expected = state.cumulativeUnits * this.offer.unitPriceSompi;
    if (state.cumulativeSompi !== expected) {
      throw new BuyerRefused(`State bills ${state.cumulativeSompi}, recomputed ${expected}`);
    }
    if (state.cumulativeUnits > this.cumulativeUnits + myUnits) {
      throw new BuyerRefused('State bills more units than the buyer counted');
    }

    // SPEC.md 7.4b. `expire` pays the provider EXACTLY `pendingSompi`, so a total the covenant
    // cannot cover -- including the fee for the transaction that pays it -- has NO valid close,
    // and the entire balance is stranded. The covenant cannot check this itself: it would need to
    // know the fee of a transaction that does not exist yet. The buyer can, and must.
    if (this.fundedSompi !== undefined) {
      const payable = this.fundedSompi - CLOSE_FEE_SOMPI;
      if (state.cumulativeSompi > payable) {
        throw new BuyerRefused(
          `State bills ${state.cumulativeSompi}, above the ${payable} this covenant can pay out ` +
            `(funded ${this.fundedSompi} less the ${CLOSE_FEE_SOMPI} close fee) -- SPEC.md 7.4b`,
        );
      }
    }
    if (!verifyState(state, providerSig, this.offer.providerPubkey)) {
      throw new BuyerRefused('the provider signature over the State does not verify');
    }

    // SPEC.md 5.1.1, buyer side. The provider can ride the tolerance too.
    this.bias = observeResidual(this.bias, state.cumulativeUnits - (this.cumulativeUnits + myUnits));
    if (biasAlarm(this.bias)) throw new BuyerRefused('bias detector tripped -- halting the session');

    this.seq = state.seq;
    this.cumulativeUnits = state.cumulativeUnits;
    this.cumulativeSompi = state.cumulativeSompi;
    this.lastStateDigest = digestHex(state);
    // SPEC.md 4, buyer side. The obligations are symmetric: a buyer that signs two States at one
    // seq has handed the provider a choice of which to settle, and it will not choose the cheaper.
    return signStateWithObligations(this.store, state, this.buyerSk);
  }
}
