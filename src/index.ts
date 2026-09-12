/**
 * What a program using this protocol is allowed to reach for.
 *
 * THIS FILE EXISTS BECAUSE SOMETHING TRIED TO USE THE PROTOCOL. Until then every import in the
 * repository was relative and internal, so the question "what is the public surface?" had never
 * been asked, and the honest answer was "all of it" -- which means any rearrangement inside `src/`
 * is a breaking change for somebody.
 *
 * So this is the whole of what is promised. Anything not re-exported here is internal and may move
 * without warning. Deliberately absent: the reconciliation internals, the bias detector, and the
 * canonical encoder's private helpers.
 *
 * SETTLEMENT IS NOT ABSENT, IT IS ELSEWHERE -- `metered/chain`. An earlier version of this comment
 * called the chain tooling "a demonstration of the covenant rather than part of the protocol a
 * caller links against", and the first product built on this protocol falsified that within the
 * day: the covenant is what makes the signed numbers enforceable, so of course a caller needs it.
 * The split is about COST, not importance. Everything in this file is plain TypeScript over the
 * messages; everything behind `metered/chain` needs a WASM SDK and a contract compiler, and a
 * buyer that only speaks the protocol should not pay for those to do it.
 *
 * The list is short on purpose. A surface is a promise, and every name added here is one more
 * thing that cannot be changed later without telling someone.
 */

/** Building and running a provider. */
export { MeteredService, type OfferTerms, type ServiceOptions } from './http/service.js';
export { serveMetered, meteredHandler, BodyTooLarge } from './http/serve.js';
export { ProviderSession, SessionRejected, type Deliver, type Meter } from './http/provider.js';

/** Being a buyer. */
export { BuyerSession, BuyerRefused } from './http/buyer.js';
export { openSession, runBabel, readOffer, ProtocolError, type ChunkOutcome } from './http/client.js';

/** The wire, for anything speaking it directly rather than through the client. */
export {
  toBase64, fromBase64, toPaymentRequired, X402_VERSION,
  type BabelResponse, type ChunkRequest, type StateRequest, type PaymentRequiredBody,
} from './http/protocol.js';

/** Units and meters (SPEC.md 6). */
export { resolveMeter, meterFor, minimumTolerance, available, encodeWith, MeterUnavailable } from './meter.js';

/** Durability. A provider that holds money must not forget what it has signed (SPEC.md 4). */
export { fileStore, fileHistory, fileSessionStore, type SessionStore } from './store.js';
export { memoryStore, SignerObligationError, type SignerStore, type SignerRecord } from './signer.js';
export { memoryHistory, type SessionHistory } from './history.js';

/**
 * The types an implementable interface is made of.
 *
 * These are here because leaving them out made the surface LOOK complete and be unusable:
 * `ServiceOptions` accepts an `anchor` and a `sessions` store, and neither the `Anchor` interface
 * nor `SessionStore`'s snapshot type could be reached, so a caller could see where its own
 * implementation was meant to go and had no way to write one. A type named in an exported
 * signature is part of the surface whether or not anybody remembered to say so.
 */
export { Checkpointer, isCheckpointBabel, type Anchor, type CheckpointRecord } from './checkpoint.js';
export type { SessionSnapshot } from './http/provider.js';
export type { BabelCursor } from './reservation.js';
export type { BiasState } from './bias.js';
export { ReservationRejected, ReservationUnauthenticated, acceptReservation } from './reservation.js';
export { MAX_BODY_BYTES, type ServeOptions } from './http/serve.js';
export type { StateResponse, ErrorBody } from './http/protocol.js';

/**
 * SPEC.md 7.3a. The response window is the PROVIDER'S DEADLINE: once the covenant ages past it
 * with no claim pending, the buyer can take back everything, including work already delivered.
 * A provider that never asks itself when to settle will eventually deliver for free.
 */
export {
  shouldSettle, acceptPolicy, worstCaseExposure, PolicyRejected, CONFIRM_MARGIN_DAA,
  type ExposurePolicy, type Exposure,
} from './deadline.js';

/** Accepting an Offer, and what a session costs to fund (SPEC.md 3.1, 7.4b). */
export { acceptOffer, OfferRejected } from './offer.js';
export { priceOf, requiredFunding, CLOSE_FEE_SOMPI, MIN_COVENANT_SOMPI } from './reservation.js';

/** Signing and digesting, for a caller that builds messages itself. */
export {
  publicKeyHex, signEnvelope, signState, verify, verifyState,
  canonicalize, digestHex, blake3Hex, utf8, settlementPreimage,
  partiesCommitment, stateSigningPayload, settlementDigest,
} from './encoding.js';

/**
 * Settling through the kaspa-x402 escrow channel (SPEC.md 3.5, docs/RAIL.md). The voucher is
 * theirs; this turns an agreed State into one and checks one.
 */
export { voucherForState, verifyVoucher, voucherPreimage, VoucherRefused, type Voucher, type ChannelRef } from './rail/voucher.js';
export { VoucherRequired } from './http/provider.js';
export { ChannelRefused } from './http/service.js';

/** The messages themselves. */
export type { Offer, Reservation, Measurement, State, Halt, HaltReason, Reconciled, ChannelProposal } from './types.js';
