/**
 * `npm run anchor -- <command>` -- set up and exercise the checkpoint anchor on testnet.
 *
 *   address   generate the anchor key if there is none, and show where to fund it
 *   balance   what the anchor key can currently pay for
 *   test      anchor one digest for real, then read it back off the chain and verify it
 *
 * TESTNET ONLY, and the network is not a flag by accident. Nothing in this project has any
 * business writing to mainnet, and a default that could be overridden by a typo is the kind of
 * thing that only has to be wrong once.
 */
import { randomBytes } from 'node:crypto';
import { blake3Hex } from '../src/encoding.js';
import { loadAnchorKey, saveAnchorKey, anchorAddress, KEY_FILE, loadSdk } from './kaspa.js';
import { submitAnchor, ANCHOR_FEE_SOMPI, currentTip, readAnchoredPayload } from './anchor.js';

const NETWORK = 'testnet-10' as const;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/** Existing key, or a fresh one. Generating is safe: an unfunded key holds nothing to lose. */
function keyOrCreate(): { key: string; created: boolean } {
  const existing = loadAnchorKey();
  if (existing) return { key: existing, created: false };
  const key = randomBytes(32).toString('hex');
  saveAnchorKey(key);
  return { key, created: true };
}

async function utxoTotal(address: string): Promise<bigint> {
  const sdk = await loadSdk();
  const rpc = new sdk.RpcClient({
    resolver: new sdk.Resolver(),
    encoding: sdk.Encoding.Borsh,
    networkId: new sdk.NetworkId(NETWORK),
  });
  await rpc.connect();
  try {
    const { entries } = await rpc.getUtxosByAddresses([address]);
    return entries.reduce((sum: bigint, e: Any) => sum + e.amount, 0n);
  } finally {
    await rpc.disconnect().catch(() => undefined);
  }
}

async function showAddress(): Promise<void> {
  const { key, created } = keyOrCreate();
  const address = await anchorAddress(key, NETWORK);
  console.log(`\n  ${created ? 'Generated a new anchor key' : 'Using the existing anchor key'}`);
  console.log(`  stored at ${KEY_FILE} (outside the repository, never printed)\n`);
  console.log(`  network  ${NETWORK}`);
  console.log(`  address  ${address}\n`);
  console.log('  Fund it from a testnet-10 faucet. One anchor costs 200,000 sompi (0.002 KAS),');
  console.log('  so even a small faucet drip covers hundreds of checkpoints.\n');
}

async function showBalance(): Promise<void> {
  const key = loadAnchorKey();
  if (!key) return void console.log('\n  No anchor key yet. Run: npm run anchor -- address\n');
  const address = await anchorAddress(key, NETWORK);
  const total = await utxoTotal(address);
  const anchors = total / ANCHOR_FEE_SOMPI;
  console.log(`\n  address  ${address}`);
  console.log(`  balance  ${total} sompi  (${Number(total) / 1e8} KAS)`);
  console.log(`  buys     ${anchors} anchor${anchors === 1n ? '' : 's'}\n`);
  if (total === 0n) console.log('  Unfunded. Send testnet-10 coins to the address above.\n');
}

async function testAnchor(): Promise<void> {
  const key = loadAnchorKey();
  if (!key) return void console.log('\n  No anchor key yet. Run: npm run anchor -- address\n');
  const cfg = { network: NETWORK, privateKeyHex: key };
  const digest = blake3Hex(`metered/anchor-test/${Date.now()}`);

  // Captured BEFORE submitting, or the forward walk could start past our own block.
  const from = await currentTip(cfg);
  console.log(`\n  anchoring ${digest}`);
  const txid = await submitAnchor(cfg, digest);
  console.log(`  accepted  ${txid}`);
  console.log('  reading it back off the chain -- acceptance is not proof...');

  const payload = await readAnchoredPayload(cfg, txid, from);
  const stored = payload.toLowerCase();
  console.log(`  payload   ${stored || '(EMPTY)'}`);
  if (stored !== digest) {
    throw new Error(`the chain stored ${stored || 'nothing'}, not the digest -- the anchor is worthless`);
  }
  console.log('  VERIFIED  the chain stored exactly the digest that was anchored');
  console.log(`  explorer  https://explorer-tn10.kaspa.org/txs/${txid}\n`);
}

const COMMANDS: Record<string, () => Promise<void>> = {
  address: showAddress,
  balance: showBalance,
  test: testAnchor,
};

const command = process.argv[2] ?? 'address';
const run = COMMANDS[command];
if (!run) {
  console.error(`unknown command '${command}'. Try: ${Object.keys(COMMANDS).join(', ')}`);
  process.exit(1);
}
run().catch((err: unknown) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
