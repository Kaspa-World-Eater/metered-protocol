/**
 * What the demo SAYS about what happened, kept apart from what it does.
 *
 * `demo.ts` drives a real session: HTTP, a covenant, transactions, coins. Nothing here moves money
 * or signs anything -- these functions only read back what landed and describe it. Keeping the two
 * apart means a change to the wording can never be a change to the path that spends.
 */
import { awaitUtxo, type Any } from './live-steps.js';
import type { ModelSource } from './model.js';

/** Read the close back off the chain and say which of the three shapes it took. */
export async function reportClose(
  rpc: Any, outs: { address: string; amount: bigint }[], providerAddr: string, owed: number, units: number,
): Promise<void> {
  const first = outs[0];
  if (!first) throw new Error('no close outputs');
  if (!(await awaitUtxo(rpc, first.address, first.amount))) throw new Error('the close did not land');
  if (outs.length === 1) {
    const to = first.address === providerAddr ? 'provider' : 'buyer';
    console.log(`\n     ${owed} sompi earned is BELOW the KIP-9 floor, so it cannot be paid as`);
    console.log(`     its own output. It folded into the ${to}'s ${Number(first.amount) / 1e8} TKAS.`);
    console.log('     Before Finding G was fixed, a session this small locked the balance forever.\n');
    return;
  }
  console.log(`\n     provider earned ${Number(first.amount) / 1e8} TKAS for ${units} units`);
  console.log(`     buyer refunded  ${Number(outs[1]!.amount) / 1e8} TKAS\n`);
}

/** Checkpoint records, with the txid that makes one usable as evidence. */
export function reportCheckpoints(records: { seq: number; status: string; txid?: string; error?: string }[]): void {
  for (const c of records) {
    const where = c.txid ? `   ${c.txid}` : c.error ? `   ${c.error}` : '';
    console.log(`     seq ${c.seq}       ${c.status}${where}`);
  }
}

/** Say what is behind the meter, so a reader never has to guess whether it was real. */
export function announceModel(source: ModelSource | null): void {
  if (!source) return;
  console.log(`\n  0. MODEL      ${source.model}, ${source.reportedTokens.length} completions`);
  console.log(`                the model reports ${source.reportedTokens.join(', ')} output tokens`);
}
