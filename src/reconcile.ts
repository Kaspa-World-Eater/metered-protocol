/**
 * SPEC.md §5 -- the reconciliation rule, in order, halting on the first failure.
 *
 * The order is normative and it is not arbitrary. Signatures come first because an unsigned
 * Measurement is not evidence of anything; the content digest comes before the counts because if
 * the two parties are describing different bytes then no amount of counting can reconcile them,
 * and a tolerance comparison on mismatched content would silently succeed whenever the numbers
 * happened to land close together.
 *
 * Rule 6 bills the LOWER count. That removes the provider's incentive to sit at the top of the
 * tolerance band -- and hands the identical trick to the buyer, which is why §5.1's bias detector
 * is normative and symmetric. See bias.ts.
 */
import { verify } from './encoding.js';
import type { Halt, Measurement, Offer, Reconciled } from './types.js';

const halt = (reason: Halt['reason'], detail: string): Halt => ({ ok: false, reason, detail });

/**
 * SPEC.md §5 rule 4. The bound is ABSOLUTE, and does not scale with the size of the babel.
 *
 * `toleranceRel` was removed in this version because the evidence never supported it. Honest
 * divergence between two correct implementations is a BOUNDARY effect: Study A found it three
 * times in 3,634 adversarial trials, and every occurrence was exactly one token. Study C looked
 * for it at seven babel sizes from 3 to 550 units, 4,000 boundaries each, and found none at any
 * size -- so the magnitude does not grow with the babel, and a bound that grows with the babel is
 * answering a problem nobody has measured.
 *
 * What such a bound WOULD do is widen the room a counterparty can shave in, which is the exact
 * leak §5.1 exists to bound: at 0.2% of a 5,000-unit babel it is ten free tokens per babel,
 * justified by nothing.
 */
export function toleranceBound(offer: Offer, providerUnits: number): number {
  void providerUnits;
  return offer.toleranceAbs;
}

/**
 * Rule 1. Each Measurement must verify against the key for the party it claims to be from.
 *
 * `by` is checked against the key that actually signed, not merely read -- otherwise a provider
 * could sign a Measurement stamped `by: "buyer"` and supply both halves of the reconciliation.
 */
function signedByClaimedParty(m: Measurement, offer: Offer): boolean {
  const key = m.by === 'buyer' ? offer.buyerPubkey : offer.providerPubkey;
  return verify(m, key);
}

/**
 * Reconcile one babel boundary. Returns what to bill, or the reason to stop.
 *
 * Idempotency (§3.3, `measurementId`) is the caller's job: a retransmitted Measurement MUST be a
 * no-op, and that belongs to whatever holds session state, not to a pure rule.
 */
/** Rule 1. Both signatures verify, and each `by` matches the key that actually signed. */
function checkAuthorship(offer: Offer, buyer: Measurement, provider: Measurement): Halt | null {
  if (buyer.by !== 'buyer' || provider.by !== 'provider') {
    return halt('signature', `measurements are ${buyer.by}/${provider.by}, expected buyer/provider`);
  }
  if (!signedByClaimedParty(buyer, offer)) return halt('signature', 'buyer measurement does not verify');
  if (!signedByClaimedParty(provider, offer)) return halt('signature', 'provider measurement does not verify');
  return null;
}

/** Rule 2, plus X1: this session, this babel, both sides. */
function checkPlacement(offer: Offer, buyer: Measurement, provider: Measurement, seq: number): Halt | null {
  if (buyer.sessionId !== offer.sessionId || provider.sessionId !== offer.sessionId) {
    return halt('sequence', 'measurement sessionId does not match the Offer');
  }
  if (buyer.seq !== seq || provider.seq !== seq) {
    return halt('sequence', `expected seq ${seq}, got buyer ${buyer.seq} / provider ${provider.seq}`);
  }
  return null;
}

/** Rules 4 and 5. Reached only once the parties are known to be describing the same bytes. */
function checkTolerances(offer: Offer, buyer: Measurement, provider: Measurement): Halt | null {
  const bound = toleranceBound(offer, provider.units);
  if (Math.abs(buyer.units - provider.units) > bound) {
    return halt('tolerance-babel', `|${buyer.units} − ${provider.units}| exceeds ${bound}`);
  }
  const cumulativeBound = toleranceBound(offer, provider.cumulativeUnits);
  if (Math.abs(buyer.cumulativeUnits - provider.cumulativeUnits) > cumulativeBound) {
    return halt(
      'tolerance-cumulative',
      `|${buyer.cumulativeUnits} − ${provider.cumulativeUnits}| exceeds ${cumulativeBound}`,
    );
  }
  return null;
}

export function reconcileBabel(
  offer: Offer,
  buyer: Measurement,
  provider: Measurement,
  seq: number,
): Reconciled | Halt {
  // Rule 3 sits between the groups rather than inside one, because its ORDER is the point: it runs
  // before any counting, so mismatched bytes can never pass on numbers that happen to land close.
  const failure =
    checkAuthorship(offer, buyer, provider) ??
    checkPlacement(offer, buyer, provider, seq) ??
    (buyer.contentDigest !== provider.contentDigest
      ? halt('content-digest', 'the parties are describing different bytes')
      : null) ??
    checkTolerances(offer, buyer, provider);
  if (failure) return failure;

  return {
    ok: true,
    billedUnits: Math.min(buyer.units, provider.units),
    billedCumulativeUnits: Math.min(buyer.cumulativeUnits, provider.cumulativeUnits),
    residual: provider.units - buyer.units,
  };
}
