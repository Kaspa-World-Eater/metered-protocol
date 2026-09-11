/**
 * SPEC.md §6 -- resolving the tokeniser an Offer names, and refusing one it does not.
 *
 * §3.1 says a buyer MUST reject an Offer whose `tokenizer` is "absent or unresolvable", and
 * §6.3.4 says the field MUST identify "a specific, publicly obtainable tokeniser and version".
 * `src/offer.ts` checks only presence, and says why: whether a name RESOLVES is a property of the
 * environment rather than of the message, so the refusal belongs where the tokeniser is loaded.
 * This is that place, and this is that refusal.
 *
 * WHY A REGISTRY RATHER THAN A LOOKUP. An unknown name must fail loudly and immediately. The
 * dangerous alternative is a fallback -- counting with *some* tokeniser when the named one is
 * unavailable -- which produces a number that looks like a measurement, settles like one, and is
 * not one. There is no default here for that reason.
 *
 * COUNTING IS NOT THE SAME AS ENCODING. A meter returns a count, but the conformance vectors pin
 * the IDS, because two tokenisers can agree on a total by luck while disagreeing about where the
 * boundaries fall -- and a boundary disagreement is what diverges on the next input rather than
 * this one. See evidence/tokenizer_vectors.py.
 */
import { encode as encodeO200k } from 'gpt-tokenizer/encoding/o200k_base';

export class TokenizerUnavailable extends Error {}

/**
 * The tokenisers this implementation can actually obtain, by the name an Offer would use.
 *
 * `o200k_base` is GPT-4o's, and the one every number in SPEC.md was measured with: Study A's
 * symmetry results, Study C's residual baseline, and the provider agreement study all used it.
 */
const REGISTRY: Record<string, (text: string) => number[]> = {
  o200k_base: encodeO200k,
};

/** Token ids for `text`. Exported so the conformance test can compare boundaries, not just totals. */
export function encodeWith(tokenizer: string, text: string): number[] {
  const encoder = REGISTRY[tokenizer];
  if (!encoder) {
    throw new TokenizerUnavailable(
      `cannot obtain tokeniser "${tokenizer}" -- SPEC.md 3.1 requires refusing an Offer whose ` +
        `tokeniser is unresolvable, rather than counting with a different one. ` +
        `available: ${Object.keys(REGISTRY).join(', ')}`,
    );
  }
  return encoder(text);
}

/**
 * A meter for the named tokeniser, or throw.
 *
 * SPEC.md §6.1 counts the assistant content ACTUALLY DELIVERED, and §6.3.3 forbids normalising it
 * -- so the text is tokenised exactly as received, with no trimming and no whitespace collapsing.
 * §6.3.1's reassembly rule is the caller's: a meter is handed a whole chunk, never a stream frame.
 */
export function meterFor(tokenizer: string): (content: string) => number {
  const encoder = REGISTRY[tokenizer];
  if (!encoder) encodeWith(tokenizer, ''); // throws with the full explanation above
  return (content: string) => encodeWith(tokenizer, content).length;
}

/** The tokeniser names this implementation can serve, for a provider building an Offer. */
export const available = (): string[] => Object.keys(REGISTRY);
