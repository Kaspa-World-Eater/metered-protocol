/**
 * SPEC.md §3.1a -- the buyer's record of which session identifiers it has already been offered.
 *
 * WHY THIS IS NOT A FIELD WIDTH. `sessionId` is provider-CHOSEN. Every threat its width appears
 * to address -- accidental collision, an outsider guessing or grinding one -- is a threat the
 * provider is not subject to, because it does not guess its own identifiers. It picks them, and
 * picking a previous one costs nothing.
 *
 * A reused `sessionId` makes the §3.4.1 preimage of two different sessions identical, so the
 * buyer's signature from the first is a valid signature for the second. That is threat X1 executed
 * by the one party no width defends against, and no on-chain rule can see it either: the covenant
 * is instantiated per session and cannot observe the other one. The buyer is the only party
 * positioned to catch it, and only by remembering.
 *
 * Synchronous by design, for the same reason SignerStore is (§4.2): an async check invites a
 * caller to forget the await, which silently turns a refusal into an acceptance.
 */

/** Durable storage for §3.1a. Keyed by provider: two providers may pick the same id honestly. */
export interface SessionHistory {
  seen(providerPubkey: string, sessionId: string): boolean;
  record(providerPubkey: string, sessionId: string): void;
}

/**
 * The default history: correct for the life of a process, and FORGETFUL ACROSS RESTART.
 *
 * SPEC.md §3.1a requires an implementation that keeps no history to say so, and this is that
 * disclosure: a buyer using this is protected against a provider reusing an identifier during one
 * run, and unprotected against one that waits for the buyer to restart. It is the default because
 * a default of "no check at all" would make the rule an intention rather than a mechanism; a buyer
 * that needs the real guarantee supplies a store that survives restart.
 */
export function memoryHistory(): SessionHistory {
  const byProvider = new Map<string, Set<string>>();
  return {
    seen: (providerPubkey, sessionId) => byProvider.get(providerPubkey)?.has(sessionId) ?? false,
    record: (providerPubkey, sessionId) => {
      const ids = byProvider.get(providerPubkey) ?? new Set<string>();
      ids.add(sessionId);
      byProvider.set(providerPubkey, ids);
    },
  };
}
