/**
 * `metered` as an x402 scheme over HTTP.
 *
 * x402 ships `exact` and `upto`, and the `upto` specification lists multi-settlement, streaming
 * and pay-per-chunk as out of scope. This is the transport for the scheme that fills that gap, so
 * it deliberately follows x402's v2 envelope rather than inventing one: an unpaid request gets a
 * 402 whose body carries `x402Version`, a `resource` block and an `accepts` array. A client that
 * already speaks x402 can read the shape even if it does not know this scheme, and will see
 * `scheme: "metered"` and decline rather than misread it.
 *
 * A CHUNK IS TWO ROUND TRIPS, and that is not an accident of design. The buyer cannot measure
 * content it has not received, so it cannot sign a Measurement in the same request that asks for
 * the chunk. Collapsing them would mean the buyer signing a count it took on trust, which is
 * exactly the one-sidedness SPEC.md 0 exists to remove.
 *
 *   POST /metered/open    -> 402 + Offer, or 200 once the covenant is funded
 *   POST /metered/babel   -> content + the PROVIDER's Measurement
 *   POST /metered/state   -> reconciles both Measurements, returns the State + provider signature
 */
import type { Measurement, Offer, Reservation, State } from '../types.js';

export const X402_VERSION = 2;

/** The x402 v2 body an unpaid request gets back. */
export interface PaymentRequiredBody {
  x402Version: number;
  error: string;
  resource: { url: string; description?: string; mimeType?: string };
  accepts: Offer[];
}

export function toPaymentRequired(offer: Offer, resource: string, error: string): PaymentRequiredBody {
  return {
    x402Version: X402_VERSION,
    error,
    resource: { url: resource, description: `metered session, ${offer.babelUnits} ${offer.unit} per chunk` },
    accepts: [offer],
  };
}

/** `POST /metered/babel` -- the buyer authorises exactly one chunk and asks for it. */
export interface ChunkRequest {
  reservation: Reservation;
  prompt: string;
}

/**
 * What comes back. `contentB64` is the delivered bytes; `measurement` is the PROVIDER's count of
 * them. The buyer counts the same bytes itself and does not have to believe this.
 *
 * BASE64 IS TRANSIT ONLY, and the field is named so that nothing can forget it. JSON has no way
 * to carry arbitrary bytes, so they are encoded to cross the wire and decoded on arrival -- but
 * the digest and the unit count are taken over the DECODED bytes at both ends. Metering the
 * encoded form would bill the buyer for roughly a third more than it asked for, and would agree
 * a digest over the encoding rather than over the content.
 */
export interface BabelResponse {
  contentB64: string;
  measurement: Measurement;
}

/** Bytes -> the wire. */
export const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/**
 * The wire -> bytes.
 *
 * Node's base64 decoder is LENIENT: it discards anything outside the alphabet rather than
 * refusing, so a corrupted field decodes to plausible-looking bytes instead of an error. That is
 * survivable here only because it cannot be silent -- different bytes produce a different digest,
 * and SPEC.md 5 rule 3 halts the session on a digest mismatch before any count is consulted.
 */
export const fromBase64 = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, 'base64'));

/** `POST /metered/state` -- the buyer's count, after it has seen the content. */
export interface StateRequest {
  measurement: Measurement;
}

/**
 * The reconciled State and the provider's signature over it. The buyer verifies and countersigns;
 * a State with one signature is not a State (SPEC.md 3.4).
 */
export interface StateResponse {
  state: State;
  providerSig: string;
  billedUnits: number;
}

/** Every failure this transport can report, as an x402-shaped error body. */
export interface ErrorBody {
  x402Version: number;
  error: string;
  reason?: string | undefined;
}

export const errorBody = (error: string, reason?: string): ErrorBody =>
  ({ x402Version: X402_VERSION, error, reason });
