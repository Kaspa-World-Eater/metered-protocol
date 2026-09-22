/**
 * `npx tsx tools/send.ts <address> <sompi>` -- move testnet coins out of the anchor wallet.
 *
 * A plain transfer, kept here because funding anything else from this wallet by hand means
 * rebuilding the same transaction each time and getting the fee wrong once. It spends the whole
 * wallet (tools/wallet.ts), so sending to the wallet's own address consolidates it.
 */
import { loadSdk, loadAnchorKey, type Any } from './chain.js';
import { spendWallet } from './wallet.js';

const [, , to, amountArg] = process.argv;
if (!to || !amountArg) throw new Error('usage: tsx tools/send.ts <address> <sompi>');
const amount = BigInt(amountArg);

const key = loadAnchorKey();
if (!key) throw new Error('no anchor key; run: npm run anchor -- address');

const sdk = await loadSdk() as Any;
const rpc = new sdk.RpcClient({ resolver: new sdk.Resolver(), encoding: sdk.Encoding.Borsh, networkId: new sdk.NetworkId('testnet-10') });
await rpc.connect();
try {
  const { txid } = await spendWallet(rpc, sdk, key, 'testnet-10', [{ address: to, amount }]);
  console.log(`  sent ${amount} sompi to ${to}
  ${txid}`);
} finally {
  await rpc.disconnect().catch(() => undefined);
}
