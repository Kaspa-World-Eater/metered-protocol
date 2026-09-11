/**
 * A buyer that drives a metered session over HTTP, start to finish.
 *
 * This is the reference client: read the 402, decide whether the terms are acceptable, then run
 * chunks until the work is done or something disagrees. It is short because every decision it
 * makes lives in buyer.ts, which is where the rules are.
 */
import { digestHex, publicKeyHex } from '../encoding.js';
import { BuyerSession } from './buyer.js';
import type { SessionHistory } from '../history.js';
import { fromBase64, type BabelResponse, type PaymentRequiredBody, type StateResponse } from './protocol.js';
import type { Meter } from './provider.js';
import type { Offer, State } from '../types.js';

export class ProtocolError extends Error {}

async function post<T>(base: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new ProtocolError(`${path} -> ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

/**
 * Fetch the 402 and take the Offer out of it. The 402 is the answer, not a failure.
 *
 * The buyer's key goes UP with the request because the Offer commits to
 * blake3(buyer || provider); a provider cannot sign terms for a buyer it has not been told about.
 */
export async function readOffer(base: string, buyerPubkey: string): Promise<Offer> {
  const res = await fetch(`${base}/metered/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ buyerPubkey }),
  });
  if (res.status !== 402) throw new ProtocolError(`expected 402, got ${res.status}`);
  const body = (await res.json()) as PaymentRequiredBody;
  const offer = body.accepts.find((a) => a.scheme === 'metered');
  if (!offer) throw new ProtocolError('no metered offer in accepts');
  return offer;
}

export interface ChunkOutcome {
  content: Uint8Array;
  state: State;
  billedUnits: number;
  /**
   * The two signatures over this State's 72-byte preimage.
   *
   * Returned because SETTLEMENT NEEDS THEM and nothing else could reach them. The covenant's
   * `settle` entry takes both, and a caller holding only the State holds a number it cannot
   * enforce -- which was true of every caller of this function until a product tried to settle.
   */
  providerSig: string;
  buyerSig: string;
}

/**
 * Run one chunk: reserve, receive, count, reconcile, countersign.
 *
 * Two round trips, because the buyer cannot honestly sign a count for content it has not seen.
 */
export async function runBabel(
  base: string,
  session: BuyerSession,
  prompt: string,
  units?: number,
): Promise<ChunkOutcome> {
  const reservation = session.reserve(units);
  const delivered = await post<BabelResponse>(base, '/metered/babel', { reservation, prompt });

  // Decoded before anything is measured, so every number below is taken over the bytes the buyer
  // actually keeps -- not over the transit encoding they arrived in.
  const content = fromBase64(delivered.contentB64);
  const mine = session.measure(content, delivered.measurement, reservation.seq);
  const settled = await post<StateResponse>(base, '/metered/state', { measurement: mine });

  const buyerSig = session.countersign(settled.state, settled.providerSig, mine.units);
  await post(base, '/metered/countersign', { state: settled.state, buyerSig });

  return {
    content,
    state: settled.state,
    billedUnits: settled.billedUnits,
    providerSig: settled.providerSig,
    buyerSig,
  };
}

/**
 * Open a session against a server and hand back the buyer half, ready to run chunks.
 *
 * `history` is SPEC.md 3.1a's obligation and belongs to the CALLER, because it has to outlive any
 * one session to mean anything: a buyer opening many sessions against one provider creates the
 * history once and passes it to every call. Omitting it leaves that buyer unprotected against a
 * provider that reuses a session identifier deliberately.
 */
export async function openSession(
  base: string,
  buyerSk: string,
  meter: Meter,
  expectedNetwork?: string,
  history?: SessionHistory,
): Promise<{ offer: Offer; session: BuyerSession }> {
  const offer = await readOffer(base, publicKeyHex(buyerSk));
  if (offer.buyerPubkey !== publicKeyHex(buyerSk)) {
    throw new ProtocolError('the Offer names a different buyer than the one that asked');
  }
  return { offer, session: new BuyerSession(offer, buyerSk, meter, expectedNetwork, history) };
}

export { digestHex };
