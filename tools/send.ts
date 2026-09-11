/**
 * `npx tsx tools/send.ts <address> <sompi>` -- move testnet coins out of the anchor wallet.
 *
 * A plain transfer, kept here because funding anything else from this wallet by hand means
 * rebuilding the same transaction each time and getting the fee wrong once.
 */
import { loadSdk, loadAnchorKey, type Any } from './chain.js';

const [, , to, amountArg] = process.argv;
if (!to || !amountArg) throw new Error('usage: tsx tools/send.ts <address> <sompi>');
const amount = BigInt(amountArg);
const FEE = 250_000n;

const key = loadAnchorKey();
if (!key) throw new Error('no anchor key; run: npm run anchor -- address');

const sdk = await loadSdk() as Any;
const networkId = new sdk.NetworkId('testnet-10');
const priv = new sdk.PrivateKey(key);
const from = priv.toKeypair().toAddress(networkId).toString();
const rpc = new sdk.RpcClient({ resolver: new sdk.Resolver(), encoding: sdk.Encoding.Borsh, networkId });
await rpc.connect();
try {
  const { entries } = await rpc.getUtxosByAddresses([from]);
  const src = entries.reduce((a: Any, b: Any) => (b.amount > a.amount ? b : a));
  if (src.amount < amount + FEE) throw new Error(`largest UTXO is ${src.amount}, need ${amount + FEE}`);
  const tx = sdk.createTransaction(
    [src], [{ address: to, amount }, { address: from, amount: src.amount - amount - FEE }], 0n, undefined, 0,
  );
  tx.version = 1;
  tx.gas = 0n;
  for (const i of tx.inputs) { i.sigOpCount = 0; i.computeBudget = 10; }
  tx.finalize();
  const id = await rpc.submitTransaction({ transaction: sdk.signTransaction(tx, [priv], true), allowOrphan: false });
  console.log(`  sent ${amount} sompi to ${to}\n  ${id.transactionId}`);
} finally {
  await rpc.disconnect().catch(() => undefined);
}
