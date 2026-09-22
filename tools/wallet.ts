/**
 * Spend the whole anchor wallet: every UTXO in, the requested outputs, one change output back.
 *
 * Both `tools/send.ts` and the rail's carve used to spend only the LARGEST UTXO. Two things go
 * wrong with that, and the 2026-09-22 rail re-run hit both in a row: the wallet held enough in
 * total but not in one piece, and once consolidated, the change from carving 20.5M out of 21M
 * was 250,000 sompi, whose KIP-9 storage mass (10^12 / amount) alone is eight times the 500,000
 * cap. Spending everything makes the change as large as the wallet allows, which is the cheapest
 * output there is.
 *
 * The fee is the node's standardness floor, 100 sompi per gram of compute mass, and each input
 * adds roughly 1,400 grams (3 inputs measured at 4,278): 200,000 per input clears it with room.
 */
import type { Any } from './live-steps.js';

export const FEE_PER_INPUT = 200_000n;

export interface Spend { readonly txid: string; readonly from: string; readonly fee: bigint }

/** Every UTXO of `sk` into `outputs` plus change, on `network`. Throws if the wallet cannot cover it. */
export async function spendWallet(
  rpc: Any, sdk: Any, sk: string, network: string, outputs: { address: string; amount: bigint }[],
): Promise<Spend> {
  const priv = new sdk.PrivateKey(sk);
  const from = priv.toKeypair().toAddress(new sdk.NetworkId(network)).toString();
  const { entries } = await rpc.getUtxosByAddresses([from]);
  const total = entries.reduce((sum: bigint, e: Any) => sum + BigInt(e.amount), 0n);
  const fee = FEE_PER_INPUT * BigInt(entries.length);
  const out = outputs.reduce((sum, o) => sum + o.amount, 0n);
  if (total < out + fee) throw new Error(`wallet holds ${total} across ${entries.length} UTXOs, need ${out + fee}`);
  const tx = sdk.createTransaction(entries, [...outputs, { address: from, amount: total - out - fee }], 0n, undefined, 0);
  tx.version = 1;
  tx.gas = 0n;
  for (const i of tx.inputs) { i.sigOpCount = 0; i.computeBudget = 10; }
  tx.finalize();
  const { transactionId } = await rpc.submitTransaction({ transaction: sdk.signTransaction(tx, [priv], true), allowOrphan: false });
  return { txid: String(transactionId), from, fee };
}
