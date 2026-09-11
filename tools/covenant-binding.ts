/**
 * KIP-20 covenant bindings: what Argent's `settle` requires and the hand-written covenant does not.
 *
 * Argent lowers `emits next` to `OpAuthOutputCount(activeInput) == 1`, so a continuation output
 * must be BOUND to the covenant and to the input that created it. `emits {}` lowers to a count of
 * zero, which an unbound P2PK payout already satisfies -- so `expire` needs none of this.
 *
 * THE THING THAT COST A REJECTED TRANSACTION. `OpAuthOutputCount` asks how many outputs are
 * authorised by the input being spent, and an input belonging to NO covenant authorises nothing,
 * whatever its outputs claim. So an Argent session must be FUNDED AS A COVENANT rather than merely
 * paid into: the funding transaction is the genesis, and every settle inherits from it.
 *
 * The simulator passed the same spend, because a test case declares `covenant_id` on the input
 * directly and on chain there was nothing to declare it. That disagreement between simulator and
 * consensus is the finding, and it is why a pre-flight is a floor rather than a proof.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/** Which branch a binding took. `genesis` on a continuation would be a quietly reset session. */
export type BindingKind = 'none' | 'genesis' | 'inherited';

/** Bind output 0 to this session's covenant, establishing one only if the input has none. */
export function bindContinuation(sdk: Any, tx: Any, utxo: Any, binds: boolean): BindingKind {
  if (!binds) return 'none';
  const inherited = utxo.covenantId ?? utxo.entry?.covenantId ?? utxo.utxoEntry?.covenantId;
  if (inherited) {
    tx.outputs[0].covenant = new sdk.CovenantBinding(0, inherited);
    return 'inherited';
  }
  tx.populateGenesisCovenants([{ authorizingInput: 0, outputs: [0] }]);
  return 'genesis';
}

/** Establish a covenant on output 0 of a funding transaction. See the header: this is the genesis. */
export function fundAsCovenant(tx: Any, binds: boolean): void {
  // Output 0 is the covenant; output 1 is the funder's change and must NOT join it.
  if (binds) tx.populateGenesisCovenants([{ authorizingInput: 0, outputs: [0] }]);
}

/**
 * The covenant id a finalized transaction actually carries, read off its serialized form.
 *
 * NOT off `tx.outputs[0].covenant`: that getter hands ownership of a WASM object to JavaScript,
 * and reading it twice fails with "null pointer passed to rust".
 */
export function covenantIdOf(tx: Any): string {
  const json = JSON.parse(tx.serializeToSafeJSON()) as { outputs: { covenant?: { covenantId?: string } }[] };
  return json.outputs[0]?.covenant?.covenantId ?? '(none)';
}

/**
 * PRINTING "inherited" IS INTENTION; THIS IS THE MECHANISM.
 *
 * A supersede that fell to the genesis branch would start a SECOND covenant, still satisfy
 * `OpAuthOutputCount == 1`, and settle happily -- passing for the wrong reason, with the session's
 * identity quietly reset. So the branch and the id are both asserted, not merely reported.
 */
export function assertInherited(kind: BindingKind, continuation: Any, first: Any): void {
  if (kind !== 'inherited') {
    throw new Error('the supersede started a NEW covenant instead of inheriting the session identity');
  }
  if (covenantIdOf(continuation) !== covenantIdOf(first)) {
    throw new Error('the covenant identity changed between settles -- these are two sessions, not one');
  }
}
