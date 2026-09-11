/**
 * SPEC.md §5.1.1 -- the bias detector, as a one-sided CUSUM.
 *
 * WHAT THIS REPLACED. §5.1 used to say a party MAY halt on "a persistent one-sided residual".
 * Persistent was never defined, so no two implementations could agree, and the rule decides when
 * to stop taking someone's money. Study C measured it instead: `evidence/results-c.txt`.
 *
 * WHY ONE-SIDED. The threat is directional -- a buyer under-reporting makes providerUnits −
 * buyerUnits POSITIVE -- and so is the only honest divergence ever observed (Study A's three
 * counter-examples all had the buyer counting fewer). Sign therefore carries no information at
 * all, and rate is the entire signal. That is what a CUSUM measures.
 *
 * WHAT IT CATCHES, measured rather than hoped:
 *
 *   a buyer shaving 1 token from every babel   caught, median 9 babels
 *   ... from half of all babels                caught, median 80 babels
 *   ... from a quarter                         1% of the time
 *   ... from a tenth                           never
 *
 * with ZERO false alarms in 800,000 honest babels. So the leak §5.1 promises to bound is bounded
 * at roughly 0.045% per babel -- not at zero. An implementation needing a tighter bound must
 * lower `toleranceAbs`; tuning K below 0.5 is not supported, because Study C bounds the honest
 * divergence rate at 0.075% rather than measuring it as exactly zero.
 */

/** Slack per babel. Above the honest drift (zero to measurement), below any real cheat. */
export const K = 0.5;

/** Alarm threshold. Chosen for zero false alarms across 400 sessions of 2,000 honest babels. */
export const H = 5;

/**
 * Running detector state. Deliberately a plain value rather than a class: SPEC.md §4 requires a
 * party to durably record what it has seen, and a value serialises without ceremony.
 */
export interface BiasState {
  /** The CUSUM statistic. Never negative -- that is what makes it one-sided. */
  sum: number;
  /** Babels observed. Reported with an alarm so the operator can see how fast it fired. */
  babels: number;
}

export const newBiasState = (): BiasState => ({ sum: 0, babels: 0 });

/**
 * Feed one babel's residual (providerUnits − buyerUnits) and return the updated state.
 *
 * Pure, so a caller can persist the result before acting on it, per §4's record-then-send rule.
 */
export function observeResidual(state: BiasState, residual: number): BiasState {
  return {
    sum: Math.max(0, state.sum + residual - K),
    babels: state.babels + 1,
  };
}

/** SPEC.md §5.1.1: the session halts when the statistic reaches the threshold. */
export const biasAlarm = (state: BiasState): boolean => state.sum >= H;
