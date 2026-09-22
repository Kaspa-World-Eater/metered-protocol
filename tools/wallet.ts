/**
 * Spend the whole anchor wallet: every UTXO in, the requested outputs, one change output back.
 *
 * Both `tools/send.ts` and the rail's carve used to spend only the LARGEST UTXO. Two things go
 * wrong with that, and the 2026-09-22 rail re-run hit both in a row: the wallet held enough in
 * total but not in one piece, and once consolidated, the change from carving 20.5M out of 21M
 * was 250,000 sompi, whose KIP-9 storage mass (10^12 / amount) alone is eight times the 500,000
 * cap. Spending everything makes the change as large as the wallet allows, which is the cheapest
 * output there is.
 */
import type { Any } from './live-steps.js';

/**
 * A floor, not the fee. The node's minimum is 100 sompi per gram of compute mass and the SDK
 * computes it exactly (`feeFor`); this only catches the case where it cannot answer, and keeps a
 * spend from paying a trivial fee because a binding was missing.
 */
export const FEE_FLOOR_SOMPI = 500_000n;

/**
 * What the node will demand for this transaction, from the SDK that knows.
 *
 * GUESSING THIS IS A TRAP, twice proven: a flat 250,000 was refused at 3 inputs (4,278 grams), and
 * 200,000-per-input was refused at ONE (2,038 grams) -- a one-input spend is more than half the
 * mass of a three-input one, because most of the mass is not the inputs. Each guess held until a
 * run reached a size the last one had not.
 */
export function feeFor(sdk: Any, network: string, tx: Any): bigint {
  try {
    const required = sdk.calculateTransactionFee?.(network, tx) as bigint | undefined;
    if (required != null && required > FEE_FLOOR_SOMPI) return required;
  } catch {
    // An SDK build without the binding, or a transaction it will not measure: fall through.
  }
  return FEE_FLOOR_SOMPI;
}

export interface Spend { readonly txid: string; readonly from: string; readonly fee: bigint }

/**
 * Every UTXO of `sk` into `outputs` plus change, on `network`. Throws if the wallet cannot cover
 * it. Built twice: once to measure, once to pay what the measurement asks.
 */
export async function spendWallet(
  rpc: Any, sdk: Any, sk: string, network: string, outputs: { address: string; amount: bigint }[],
): Promise<Spend> {
  const priv = new sdk.PrivateKey(sk);
  const from = priv.toKeypair().toAddress(new sdk.NetworkId(network)).toString();
  const { entries } = await rpc.getUtxosByAddresses([from]);
  const total = entries.reduce((sum: bigint, e: Any) => sum + BigInt(e.amount), 0n);
  const out = outputs.reduce((sum, o) => sum + o.amount, 0n);

  const build = (fee: bigint): Any => {
    if (total < out + fee) throw new Error(`wallet holds ${total} across ${entries.length} UTXOs, need ${out + fee}`);
    const tx = sdk.createTransaction(entries, [...outputs, { address: from, amount: total - out - fee }], 0n, undefined, 0);
    tx.version = 1;
    tx.gas = 0n;
    for (const i of tx.inputs) { i.sigOpCount = 0; i.computeBudget = 10; }
    tx.finalize();
    return tx;
  };

  const fee = feeFor(sdk, network, build(FEE_FLOOR_SOMPI));
  const signed = sdk.signTransaction(build(fee), [priv], true);
  const { transactionId } = await rpc.submitTransaction({ transaction: signed, allowOrphan: false });
  return { txid: String(transactionId), from, fee };
}
