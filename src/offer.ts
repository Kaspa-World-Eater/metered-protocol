/**
 * SPEC.md §3.1 -- what a buyer MUST reject before spending anything.
 *
 * The Offer is the provider's signed commitment and every later message is bound to it, so this
 * is the only moment a buyer can decline cheaply. After it accepts, the exposure bound, the
 * tolerance and the response window are all fixed by terms it agreed to.
 *
 * Three of these rejections are named in §3.1 and the rest come from field constraints in the same
 * table. They are enforced together because a buyer that checks some of them is not safer in any
 * useful sense -- an Offer with `babelUnits` of zero is as unusable as one with no tokeniser.
 */
import { verify } from './encoding.js';
import type { SessionHistory } from './history.js';
import type { Offer } from './types.js';

/** §7.3: the window lowers to OpCheckSequenceVerify, whose low 32 bits carry the delay. */
const MAX_RESPONSE_WINDOW = 4294967295;

/** SPEC.md 3.1: 16 bytes. 128 bits of nonce -- see 3.1a for why more would not help. */
const SESSION_ID = /^[0-9a-f]{32}$/;

export class OfferRejected extends Error {}

const reject = (why: string): never => {
  throw new OfferRejected(why);
};

/** The numeric floors from the §3.1 table, each of which makes the Offer unusable if breached. */
function checkBounds(offer: Offer): void {
  if (offer.unitPriceSompi < 1) reject('unitPriceSompi must be >= 1');
  if (offer.babelUnits < 1) reject('babelUnits must be >= 1');
  if (offer.maxBabels < 1) reject('maxBabels must be >= 1');
  // Named explicitly in §3.1, and load-bearing: Study A measured a one-token divergence between
  // honest parties, so a zero tolerance halts honest sessions on the first unlucky babel.
  if (offer.toleranceAbs < 1) reject('toleranceAbs must be >= 1 -- see SPEC.md 0.1');
  if (offer.checkpointEvery < 0) reject('checkpointEvery must be >= 0');
}

/**
 * Accept an Offer, or throw. Returns the Offer so a caller can use it in an expression.
 *
 * `tokenizer` is checked for presence only. §6.3.4 requires it to name "a specific, publicly
 * obtainable tokeniser and version", and whether a given name resolves is a property of the
 * buyer's environment rather than of the message -- a buyer that cannot obtain it MUST refuse,
 * but that refusal belongs where the tokeniser is loaded, not here.
 */
/** The fields that must simply be what §3.1 says, before any of them are worth interpreting. */
function checkShape(offer: Offer, expectedNetwork?: string): void {
  if (offer.v !== 1) reject(`unsupported version ${offer.v}`);
  if (offer.scheme !== 'metered') reject(`scheme is ${offer.scheme}, not metered`);
  if (expectedNetwork && offer.network !== expectedNetwork) {
    reject(`network is ${offer.network}, expected ${expectedNetwork}`);
  }
  if (!SESSION_ID.test(offer.sessionId)) reject('sessionId must be 16 hex bytes');
  if (!offer.tokenizer) reject('tokenizer is absent -- an unnamed tokeniser is not usable');
  if (offer.responseWindowDaa < 1 || offer.responseWindowDaa > MAX_RESPONSE_WINDOW) {
    reject(`responseWindowDaa ${offer.responseWindowDaa} outside 1..=${MAX_RESPONSE_WINDOW}`);
  }
}

/**
 * SPEC.md §3.1a. `history.ts` says why the width of `sessionId` is not what does this job.
 *
 * Called LAST, after the signature has verified, so a malformed or unsigned Offer cannot burn an
 * identifier the provider might go on to use honestly: an attacker who can hand the buyer junk
 * must not be able to poison its history against the real provider.
 */
function checkNovelty(offer: Offer, history?: SessionHistory): void {
  if (!history) return;
  if (history.seen(offer.providerPubkey, offer.sessionId)) {
    reject(`sessionId ${offer.sessionId} has been offered by this provider before -- see SPEC.md 3.1a`);
  }
  history.record(offer.providerPubkey, offer.sessionId);
}

export function acceptOffer(offer: Offer, expectedNetwork?: string, history?: SessionHistory): Offer {
  checkShape(offer, expectedNetwork);
  checkBounds(offer);

  // Before novelty and after everything cheap: it is the most expensive check, and it is what
  // makes `providerPubkey` mean anything, which the novelty history is keyed by.
  if (!verify(offer, offer.providerPubkey)) reject('Offer signature does not verify');

  checkNovelty(offer, history);
  return offer;
}
