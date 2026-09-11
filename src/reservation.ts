/**
 * SPEC.md §3.2 -- the Reservation. One babel, never the session.
 *
 * This is where the exposure bound is actually enforced. The buyer signs an authorisation for a
 * single chunk, and the provider's matching exposure -- "take a chunk, never sign its State" -- is the
 * provider's matching exposure. Both are one chunk, deliberately and symmetrically: `babelUnits`
 * is the whole trust model, which is why the checks here are not conveniences.
 *
 * "Recomputed and compared, never trusted" (§3.2) is the load-bearing sentence. A provider that
 * reads `cumulativeSompi` off the wire and bills it has handed the buyer a free variable.
 */
import { verify } from './encoding.js';
import type { Offer, Reservation } from './types.js';

export class ReservationRejected extends Error {}

/**
 * The Reservation did not come from the buyer named in the Offer -- unsigned, wrongly signed, or
 * altered after signing.
 *
 * A SUBTYPE, because the difference matters to the caller and to nobody else. Every other
 * ReservationRejected means an AUTHENTICATED buyer asked for something it had agreed not to ask
 * for, which is a disagreement and stops the session. This one means the sender is not the buyer
 * at all, so it is evidence about the sender and none about the session -- and since `sessionId`
 * travels in clear, treating it as a disagreement would let any observer kill any session.
 */
export class ReservationUnauthenticated extends ReservationRejected {}

const refuse = (why: string): never => {
  throw new ReservationRejected(why);
};

/** What the previous chunk left behind. `null` means nothing has been reserved yet. */
export interface BabelCursor {
  seq: number;
  cumulativeUnits: number;
  cumulativeSompi: number;
  stateDigest: string | null;
}

/** The amount a chunk costs, recomputed from the Offer's price rather than read off the wire. */
export const priceOf = (offer: Offer, units: number): number => units * offer.unitPriceSompi;

/**
 * Check a Reservation against the Offer and the session so far. Throws, or returns the cursor the
 * next chunk must build on.
 */
/**
 * §3.2: "from 0, strictly incrementing by exactly 1". Exactly one, so B4 -- replaying an old
 * Reservation -- cannot advance the session, and no chunk can be skipped past unbilled.
 */
function checkSequencing(offer: Offer, reservation: Reservation, previous: BabelCursor | null): void {
  if (reservation.v !== 1) refuse(`unsupported version ${reservation.v}`);
  if (reservation.sessionId !== offer.sessionId) refuse('sessionId does not match the Offer');

  const expectedSeq = previous === null ? 0 : previous.seq + 1;
  if (reservation.seq !== expectedSeq) refuse(`seq must be exactly ${expectedSeq}, got ${reservation.seq}`);
  if (reservation.seq >= offer.maxBabels) {
    refuse(`seq ${reservation.seq} reaches the session ceiling of ${offer.maxBabels} chunks`);
  }
}

/** THE EXPOSURE BOUND. Everything else in this protocol is bookkeeping around these two lines. */
function checkExposure(offer: Offer, reservation: Reservation): void {
  if (reservation.units < 1) refuse('units must be >= 1');
  if (reservation.units > offer.babelUnits) {
    refuse(`units ${reservation.units} exceeds babelUnits ${offer.babelUnits}`);
  }
}

/** §3.2: recomputed and compared, never trusted. Returns the totals the caller should keep. */
function recomputeTotals(
  offer: Offer,
  reservation: Reservation,
  previous: BabelCursor | null,
): { units: number; sompi: number } {
  const units = (previous?.cumulativeUnits ?? 0) + reservation.units;
  const sompi = (previous?.cumulativeSompi ?? 0) + priceOf(offer, reservation.units);
  if (reservation.cumulativeUnits !== units) {
    refuse(`cumulativeUnits is ${reservation.cumulativeUnits}, recomputed ${units}`);
  }
  if (reservation.cumulativeSompi !== sompi) {
    refuse(`cumulativeSompi is ${reservation.cumulativeSompi}, recomputed ${sompi}`);
  }
  return { units, sompi };
}

/**
 * The funding floor: the most a session can ever bill, plus the fee its close will cost.
 *
 * SPEC.md 7.4b. `expire` pays the provider EXACTLY `pendingSompi`, so if the parties agree a total
 * the covenant cannot pay -- including the network fee for the transaction that pays it -- then no
 * valid close transaction exists and the whole balance is stranded. The covenant cannot catch this
 * itself: it would have to know the fee a future transaction will cost, which is not available to
 * a script. The buyer can, because the buyer chooses the funding amount, and it can do so before
 * spending anything.
 */
export function requiredFunding(offer: Offer, closeFeeSompi = CLOSE_FEE_SOMPI): number {
  const maxBill = offer.maxBabels * offer.babelUnits * offer.unitPriceSompi;
  return Math.max(maxBill + closeFeeSompi, MIN_COVENANT_SOMPI);
}

/**
 * The smallest balance a covenant may hold, and it is not a dust rule -- it is a SHAPE rule.
 *
 * A two-output close needs both halves to clear KIP-9 together, and below roughly 0.068 KAS they
 * cannot: tools/dust-map.ts finds claims with no legal close at all for balances between
 * 5,700,000 and 6,800,000 sompi, whatever the dust constant is set to. Above 6,850,000 the
 * problem disappears. 10,000,000 is the round number above that with margin.
 */
export const MIN_COVENANT_SOMPI = 10_000_000;

/**
 * The covenant's fee allowance, measured: `expire` performs two signature checks
 * and is the costliest entry, needing ~313,800 -- 400,000 is what the contract reserves.
 */
export const CLOSE_FEE_SOMPI = 400_000;

export function acceptReservation(
  offer: Offer,
  reservation: Reservation,
  previous: BabelCursor | null,
): BabelCursor {
  // SPEC.md 3.2: "Signed by the buyer." Until 2026-09-10 nothing checked that, so the provider
  // would deliver work to anyone who knew a sessionId, and held no evidence the buyer had ever
  // authorised the babel it was about to bill for. FIRST, because every check below it is
  // interpreting a document whose author is otherwise unknown.
  if (!verify(reservation, offer.buyerPubkey)) {
    throw new ReservationUnauthenticated(
      'Reservation signature does not verify against the buyer named in the Offer',
    );
  }

  checkSequencing(offer, reservation, previous);
  checkExposure(offer, reservation);
  const totals = recomputeTotals(offer, reservation, previous);

  // §3.2: the digest of the previous DOUBLY-SIGNED State, null at seq 0. This is what stops a
  // Reservation being lifted out of one history and dropped into another.
  const expectedPrev = previous?.stateDigest ?? null;
  if (reservation.prevState !== expectedPrev) {
    refuse(`prevState ${reservation.prevState ?? 'null'} does not chain to ${expectedPrev ?? 'null'}`);
  }

  return {
    seq: reservation.seq,
    cumulativeUnits: totals.units,
    cumulativeSompi: totals.sompi,
    stateDigest: null, // filled in once the State for this chunk is doubly signed
  };
}
