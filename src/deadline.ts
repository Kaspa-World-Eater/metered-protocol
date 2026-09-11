/**
 * SPEC.md §7.3a -- the response window is the PROVIDER'S DEADLINE, not merely a dispute window.
 *
 * `expire` lowers to `OpCheckSequenceVerify`, which measures the age of the covenant UTXO being
 * spent. So the clock runs from the moment the covenant is funded, and each `settle` resets it by
 * creating a fresh UTXO. That has a consequence §7.3 never stated:
 *
 *   ONCE THE COVENANT UTXO IS OLDER THAN THE WINDOW AND NO CLAIM IS PENDING, THE BUYER CAN CLOSE
 *   AND TAKE BACK EVERYTHING -- INCLUDING PAYMENT FOR WORK ALREADY DELIVERED.
 *
 * The provider is not defenceless: it holds a doubly-signed State and can post it at any time, and
 * a stale claim can never overwrite a fresher one (`seq > pendingSeq` is strict). But it must post
 * BEFORE the deadline, not merely notice afterwards.
 *
 * WHY THIS IS NOT A WATCHTOWER PROBLEM. Lightning needs one because punishment is retrospective:
 * you must detect an old state and answer it with a justice transaction, holding per-update
 * revocation secrets, while being a wallet that is offline by nature -- so you delegate to a third
 * party who must be trusted, can be bribed, and has to be paid. None of that shape is here. The
 * party at risk is a SERVER, online by definition because serving is its job; it needs only the
 * latest State, which it already holds; there is no secret, no third party, and nothing to
 * delegate. What it needs is not vigilance but a DEADLINE it keeps, which is a policy it can
 * evaluate locally from numbers it already has.
 */

export interface ExposurePolicy {
  /**
   * Post a claim once the covenant UTXO reaches this age, in DAA. MUST be below the Offer's
   * `responseWindowDaa` by enough margin for the settle to confirm.
   */
  settleByAgeDaa: number;
  /** Post a claim once this much has accrued unsettled, whatever the age. 0 disables. */
  settleAtUnsettledSompi: number;
}

export class PolicyRejected extends Error {}

/**
 * The margin between the policy's deadline and the window itself, in DAA.
 *
 * A settle that is BROADCAST before the deadline but confirms after it has not defended anything,
 * so the policy must fire early enough to land. Study B measured checkpoint confirmation at 1,879
 * ms for the 90th percentile; at the ~10 blocks per second this network produces, 60 DAA is about
 * six seconds, which is three times that.
 */
export const CONFIRM_MARGIN_DAA = 60;

/** Check a policy against the window it has to fit inside. Throws rather than quietly clamping. */
export function acceptPolicy(policy: ExposurePolicy, responseWindowDaa: number): ExposurePolicy {
  if (policy.settleByAgeDaa < 1) throw new PolicyRejected('settleByAgeDaa must be >= 1');
  if (policy.settleAtUnsettledSompi < 0) throw new PolicyRejected('settleAtUnsettledSompi must be >= 0');
  if (policy.settleByAgeDaa + CONFIRM_MARGIN_DAA > responseWindowDaa) {
    throw new PolicyRejected(
      `settleByAgeDaa ${policy.settleByAgeDaa} leaves less than ${CONFIRM_MARGIN_DAA} DAA of the ` +
        `${responseWindowDaa}-DAA window for the settle to confirm`,
    );
  }
  return policy;
}

export interface Exposure {
  /** Age of the covenant UTXO the next close would spend, in DAA. */
  ageDaa: number;
  /** Value agreed but not yet posted on chain. */
  unsettledSompi: number;
}

/**
 * Whether the provider should post its claim now, and why.
 *
 * Deliberately a pure function of two numbers. It does not poll, hold a socket, or know what a
 * chain is -- the caller has those, and a decision that can be computed is easier to test, to
 * reason about, and to disagree with than one buried in a daemon.
 */
export function shouldSettle(policy: ExposurePolicy, now: Exposure): { settle: boolean; why: string | null } {
  if (now.unsettledSompi <= 0) return { settle: false, why: null };
  if (now.ageDaa >= policy.settleByAgeDaa) {
    return { settle: true, why: `the covenant UTXO is ${now.ageDaa} DAA old, at or past the deadline` };
  }
  if (policy.settleAtUnsettledSompi > 0 && now.unsettledSompi >= policy.settleAtUnsettledSompi) {
    return { settle: true, why: `${now.unsettledSompi} sompi unsettled, at or past the exposure limit` };
  }
  return { settle: false, why: null };
}

/**
 * The most a provider can lose under a policy: everything that can accrue before it must post.
 *
 * This is the provider's counterpart to the babel, and it is the number to choose deliberately.
 * `settleAtUnsettledSompi` caps it directly; without one it is bounded only by how much a session
 * can bill in `settleByAgeDaa`, which is why leaving it at 0 is a decision rather than a default.
 */
export function worstCaseExposure(policy: ExposurePolicy, maxBillSompi: number): number {
  if (policy.settleAtUnsettledSompi <= 0) return maxBillSompi;
  return Math.min(policy.settleAtUnsettledSompi, maxBillSompi);
}
