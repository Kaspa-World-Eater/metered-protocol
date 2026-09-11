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
export { resolveMeter, meterFor, minimumTolerance, available, MeterUnavailable } from './meter.js';

/** Durability. A provider that holds money must not forget what it has signed (SPEC.md 4). */
export { fileStore, fileHistory, fileSessionStore } from './store.js';
export { memoryStore, type SignerStore } from './signer.js';
export { memoryHistory, type SessionHistory } from './history.js';

/** Accepting an Offer, and what a session costs to fund (SPEC.md 3.1, 7.4b). */
export { acceptOffer, OfferRejected } from './offer.js';
export { priceOf, requiredFunding, CLOSE_FEE_SOMPI, MIN_COVENANT_SOMPI } from './reservation.js';

/** Signing and digesting, for a caller that builds messages itself. */
export {
  publicKeyHex, signEnvelope, signState, verify, verifyState,
  canonicalize, digestHex, blake3Hex, utf8, settlementPreimage,
} from './encoding.js';

/** The messages themselves. */
export type { Offer, Reservation, Measurement, State, Halt } from './types.js';
