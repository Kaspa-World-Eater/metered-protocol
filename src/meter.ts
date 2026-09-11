/**
 * SPEC.md §6 -- the meters, and resolving the one an Offer names.
 *
 * A METER TURNS DELIVERED CONTENT INTO A NUMBER BOTH SIDES CAN REACH INDEPENDENTLY. That is the
 * whole of what the protocol needs from a unit: everything else -- the offer, the reservation, the
 * reconciliation, the covenant -- works on integers and does not care what was counted.
 *
 * This file used to be `tokenizer.ts`, and the rename is a finding rather than tidying. Writing a
 * second unit showed that `tokenizer` was a unit-SPECIFIC field sitting in a unit-AGNOSTIC message:
 * it made sense for tokens and meant nothing for bytes. A protocol that claims its unit is
 * pluggable should not name one unit's machinery in every Offer.
 *
 * EXACT AND INEXACT METERS ARE DIFFERENT ANIMALS, and the difference decides the tolerance.
 *
 *   A tokeniser is a LOSSY map from bytes to a count. Two correct implementations can agree on
 *   every byte and still disagree by one token, because the boundaries are a property of the
 *   tokeniser rather than of the content. Study A measured exactly that: three counter-examples
 *   in 3,634 adversarial trials, each one token.
 *
 *   Counting octets is a DIRECT function of the bytes. Two parties who agree on `contentDigest`
 *   cannot disagree on the length -- the digest already proves the bytes are identical. A
 *   tolerance would not absorb honest divergence, because there is none; it would only widen the
 *   room a counterparty can shave in.
 *
 * So `exact` is not a performance note. It is what makes `toleranceAbs` of 0 correct for one unit
 * and wrong for another, and §3.1's floor comes from the meter rather than from the protocol.
 */
import { encode as encodeO200k } from 'gpt-tokenizer/encoding/o200k_base';

export class MeterUnavailable extends Error {}

export interface Meter {
  /** The name an Offer carries. */
  name: string;
  /** The unit this meter measures. An Offer naming a different unit is refused. */
  unit: string;
  /** Content in, units out. */
  count(content: string): number;
  /**
   * Whether two correct implementations ALWAYS reach the same number for the same bytes.
   * `true` permits `toleranceAbs` of 0; `false` requires at least 1.
   */
  exact: boolean;
}

/**
 * `o200k_base` is GPT-4o's tokeniser, and the one every measured number in SPEC.md was taken with:
 * Study A's symmetry results, Study C's residual baseline, and the provider agreement study.
 */
const o200k: Meter = {
  name: 'o200k_base',
  unit: 'llm.output_tokens.v1',
  count: (content) => encodeO200k(content).length,
  exact: false,
};

/**
 * Octets of the delivered content, UTF-8, exactly as `contentDigest` covers them.
 *
 * The strongest meter in the protocol, and the simplest: the parties already agree on the bytes by
 * the time counting matters, because §5 rule 3 halts on a digest mismatch before any tolerance is
 * consulted. Once the digests match, the lengths are the same number or one side is broken.
 */
const octets: Meter = {
  name: 'octets',
  unit: 'net.bytes_delivered.v1',
  count: (content) => new TextEncoder().encode(content).length,
  exact: true,
};

const REGISTRY: Record<string, Meter> = { o200k_base: o200k, octets };

/**
 * The meter an Offer names, or throw.
 *
 * NO FALLBACK, DELIBERATELY. Counting with a meter other than the one agreed produces a number
 * that looks like a measurement, settles like one, and is not one. §3.1 requires an Offer whose
 * meter cannot be obtained to be refused, and this is where that refusal happens.
 */
export function resolveMeter(name: string, unit?: string): Meter {
  const meter = REGISTRY[name];
  if (!meter) {
    throw new MeterUnavailable(
      `cannot obtain meter "${name}" -- SPEC.md 3.1 requires refusing an Offer whose meter is ` +
        `unresolvable, rather than counting with a different one. available: ${Object.keys(REGISTRY).join(', ')}`,
    );
  }
  if (unit !== undefined && meter.unit !== unit) {
    throw new MeterUnavailable(
      `meter "${name}" measures ${meter.unit}, but the Offer asks for ${unit}`,
    );
  }
  return meter;
}

/**
 * The smallest tolerance an Offer may carry for this meter.
 *
 * SPEC.md §3.1. An exact meter permits 0, and should use it: honest divergence is impossible, so
 * any tolerance is pure shaving room. An inexact meter requires at least 1, because Study A
 * measured a one-token disagreement between honest parties and a zero tolerance would halt them.
 */
export const minimumTolerance = (meter: Meter): number => (meter.exact ? 0 : 1);

/** A counting function for the named meter, for callers that want only the number. */
export function meterFor(name: string, unit?: string): (content: string) => number {
  const meter = resolveMeter(name, unit);
  return (content: string) => meter.count(content);
}

/** Token ids, for the conformance comparison that pins boundaries rather than totals. */
export function encodeWith(name: string, text: string): number[] {
  if (name !== 'o200k_base') throw new MeterUnavailable(`${name} does not produce token ids`);
  return encodeO200k(text);
}

/** Every meter this implementation can serve, for a provider building an Offer. */
export const available = (): string[] => Object.keys(REGISTRY);
