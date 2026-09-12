/**
 * The wire messages of SPEC.md §3, as types.
 *
 * These are the shapes the covenant measurement pinned. Nothing here should change without
 * changing §3, because `spec/vectors.ts` and `contracts/metered_session.tests.json` both encode
 * the same fields and the golden vector is compared byte for byte.
 */

/** SPEC.md §3.1. The provider's signed commitment, carried in the HTTP 402 response. */
export interface Offer {
  v: 1;
  scheme: 'metered';
  network: string;
  asset: 'KAS';
  sessionId: string;
  unit: string;
  meter: string;
  unitPriceSompi: number;
  babelUnits: number;
  maxBabels: number;
  toleranceAbs: number;
  checkpointEvery: number;
  responseWindowDaa: number;
  buyerPubkey: string;
  providerPubkey: string;
  partiesCommitment: string;
  /**
   * The kaspa-x402 escrow channel this session settles through, when it settles on that rail.
   *
   * `covenantId` is the channel's stable KIP-20 lineage; `vouchedSompi` is the lifetime ceiling
   * the buyer has already signed on it before this session, so each State's voucher is for
   * `vouchedSompi + cumulativeSompi`. Absent for a session that is not settling through a channel.
   * See docs/RAIL.md.
   */
  channel?: { covenantId: string; vouchedSompi: number };
  sig?: string;
}

/**
 * What a buyer tells a provider when it wants a session billed against a kaspa-x402 channel it has
 * already opened. Everything the provider needs to rebuild the escrow script and find the UTXO:
 * the parties are known, so this is the rest of the template plus where the money is.
 */
export interface ChannelProposal {
  covenantId: string;
  /** Absolute DAA score the escrow refunds after -- their `timeoutDaa`, verbatim. */
  timeoutDaa: number;
  /** The covenant's current settled total, which the script embeds. 0 for a fresh channel. */
  settledTotal: number;
  active: { txid: string; index: number; amount: number; scriptPublicKey: string };
}

/** SPEC.md §3.2. The buyer's authorisation for ONE chunk. Never for the session. */
export interface Reservation {
  v: 1;
  sessionId: string;
  seq: number;
  units: number;
  cumulativeUnits: number;
  cumulativeSompi: number;
  prevState: string | null;
  sig?: string;
}

/** SPEC.md §3.3. One per party per chunk boundary. */
export interface Measurement {
  v: 1;
  sessionId: string;
  seq: number;
  by: 'buyer' | 'provider';
  units: number;
  cumulativeUnits: number;
  contentDigest: string;
  measurementId: string;
  sig?: string;
}

/**
 * SPEC.md §3.4. The only object that can settle, and the only one whose signatures cover a byte
 * concatenation (§3.4.1) rather than canonical JSON.
 */
export interface State {
  v: 1;
  sessionId: string;
  seq: number;
  cumulativeUnits: number;
  cumulativeSompi: number;
  prevState: string | null;
  buyerSig?: string;
  providerSig?: string;
}

/** Why a session stopped. SPEC.md §5: "the only remedy for disagreement is to stop." */
export type HaltReason =
  | 'signature'
  | 'sequence'
  | 'content-digest'
  | 'tolerance-babel'
  | 'tolerance-cumulative'
  | 'bias';

export interface Halt {
  ok: false;
  reason: HaltReason;
  detail: string;
}

export interface Reconciled {
  ok: true;
  /** Rule 6: the LOWER of the two counts, which is what gets billed. */
  billedUnits: number;
  billedCumulativeUnits: number;
  /** SPEC.md §5.1: providerUnits − buyerUnits, the quantity the bias detector consumes. */
  residual: number;
}
