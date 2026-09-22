/**
 * A claim of "proven live" is only a pin if a reader can fetch the transaction. A txid shortened
 * to a prefix and "..." is the author's word, not a pin (caught in kaspanet/kccs#29 review, when
 * the only record of the live slash was 24 hex chars). This finds every such id in prose.
 */

/** A run of 8..63 hex chars followed by an ellipsis: an id that was cut before it was whole. */
const TRUNCATED_ID = /\b[0-9a-f]{8,63}(?:\.\.\.|…)/g;

export interface TruncatedId {
  readonly line: number;
  readonly text: string;
}

/** Every truncated id in `text`, with its 1-based line, in order. */
export function truncatedIds(text: string): TruncatedId[] {
  const out: TruncatedId[] = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(TRUNCATED_ID)) out.push({ line: i + 1, text: m[0] });
  });
  return out;
}
