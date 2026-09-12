/**
 * `npx tsx tools/rail-live.ts` -- a metered session settled through the kaspa-x402 escrow, live.
 *
 * Step 2 of docs/RAIL.md, and the thing that decides whether the plan is real:
 *
 *   carve   -> one P2PK UTXO of exactly escrow + fee, because their genesis admits no change
 *   genesis -> THEIR batch-genesis, THEIR covenant id, verified by the node returning that id
 *   session -> an ordinary metered session over HTTP: reserve, deliver, both count, both sign
 *   voucher -> the buyer signs THEIR voucher for exactly the agreed cumulativeSompi
 *   claim   -> THEIR batch-claim, bounded by that voucher, paying the seller and continuing the escrow
 *
 * What it proves: the number metered agreed is the number their contract paid. What it does NOT
 * yet prove: that a seller who under-delivered cannot claim the reservation -- that is step 3, and
 * it needs a negative case this file deliberately does not contain.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { bytesToHex } from '@noble/hashes/utils';
import { meterFor } from '../src/meter.js';
import { publicKeyHex, utf8 } from '../src/encoding.js';
import { fileStore } from '../src/store.js';
import { serveMetered } from '../src/http/serve.js';
import { MeteredService, type OfferTerms } from '../src/http/service.js';
import { openSession, runBabel } from '../src/http/client.js';
import type { Voucher } from '../src/rail/voucher.js';
import { loadSdk, loadAnchorKey } from './kaspa.js';
import { awaitUtxo, type Any } from './live-steps.js';
import { openChannel, claimChannel, refundChannel, type Channel } from './rail-chain.js';
import type { State } from '../src/types.js';

const NETWORK = 'testnet-10' as const;
const ESCROW = 20_000_000n;
const GENESIS_FEE = 500_000n;
const CLAIM_FEE = 500_000n;
const CARVE_FEE = 250_000n;
// The channel's refund window, in DAA blocks past opening -- about six seconds at ten blocks a
// second, short enough that the refund can be proven in the same run. The protocol's own
// responseWindowDaa is a separate number and stays at 600.
const WINDOW_DAA = 60n;
const RESPONSE_WINDOW = 600;
const RAIL_DIR = join(homedir(), '.metered', 'rail');
// 4 babels of 65,536 bytes at 20 sompi each = 5,242,880 sompi, comfortably above KIP-9's floor
// once the claim fee comes out of the seller's output.
const PRICE = 20;
const BABEL = 65_536;
const BABELS = 4;

const dir = mkdtempSync(join(tmpdir(), 'metered-rail-'));
const meter = meterFor('octets');
const deliver = (prompt: string, max: number): Uint8Array => utf8(`${prompt}:`.repeat(Math.ceil(max / 8)).slice(0, max));

/**
 * Write the channel down, with the seller's key beside it.
 *
 * The first three channels this tooling opened are unrecoverable: their seller keys were random
 * and never saved, the escrow script embeds the seller's public key, and a P2SH cannot be spent
 * without reproducing its script. Their client SDK has a whole `ChannelStore` contract for exactly
 * this reason. This is the smallest honest version of it.
 */
function remember(channel: Channel, providerSk: string): void {
  mkdirSync(RAIL_DIR, { recursive: true });
  const file = join(RAIL_DIR, `${channel.covenantId}.json`);
  writeFileSync(file, JSON.stringify({ ...channel, providerSk }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2), { mode: 0o600 });
}

/** Their genesis wants one input of exactly escrow + fee. Ordinary wallets do not hold that, so make it. */
async function carve(rpc: Any, sdk: Any, sk: string, amount: bigint): Promise<{ txid: string; index: number; amount: bigint }> {
  const networkId = new sdk.NetworkId(NETWORK);
  const priv = new sdk.PrivateKey(sk);
  const from = priv.toKeypair().toAddress(networkId).toString();
  const { entries } = await rpc.getUtxosByAddresses([from]);
  const src = entries.reduce((a: Any, b: Any) => (b.amount > a.amount ? b : a));
  if (src.amount < amount + CARVE_FEE) throw new Error(`largest UTXO ${src.amount} cannot carve ${amount}`);
  const tx = sdk.createTransaction([src], [{ address: from, amount }, { address: from, amount: src.amount - amount - CARVE_FEE }], 0n, undefined, 0);
  tx.version = 1;
  tx.gas = 0n;
  for (const i of tx.inputs) { i.sigOpCount = 0; i.computeBudget = 10; }
  tx.finalize();
  const { transactionId } = await rpc.submitTransaction({ transaction: sdk.signTransaction(tx, [priv], true), allowOrphan: false });
  const landed = await awaitUtxo(rpc, from, amount);
  if (!landed) throw new Error('the carved UTXO never appeared');
  return { txid: String(transactionId), index: Number(landed.outpoint.index), amount };
}

/** A real metered session over HTTP, returning the final agreed State and the provider's signature. */
async function agreeOverHttp(providerSk: string, buyerSk: string, covenantId: string): Promise<{ state: State; voucher: Voucher }> {
  const terms: OfferTerms = {
    v: 1, scheme: 'metered', network: 'kaspa:testnet-10', asset: 'KAS',
    unit: 'net.bytes_delivered.v1', meter: 'octets',
    unitPriceSompi: PRICE, babelUnits: BABEL, maxBabels: BABELS + 1,
    toleranceAbs: 0, checkpointEvery: 0, responseWindowDaa: RESPONSE_WINDOW,
    // SPEC.md 3.5: the Offer names the channel, so every countersign carries a voucher and the
    // provider refuses the next babel without one. A fresh channel has vouched nothing yet.
    channel: { covenantId, vouchedSompi: 0 },
  };
  const service = new MeteredService({
    terms, providerSk, providerPubkey: publicKeyHex(providerSk), meter, deliver, store: fileStore(join(dir, 'signer.jsonl')),
  });
  const server = serveMetered({ service });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const { offer, session } = await openSession(base, buyerSk, meter, 'kaspa:testnet-10');
    let last: State | null = null;
    for (let i = 0; i < BABELS; i += 1) {
      const out = await runBabel(base, session, `babel${i}`);
      console.log(`     babel ${i}   ${out.billedUnits} bytes, ${out.state.cumulativeSompi} sompi agreed, vouched with the countersign`);
      last = out.state;
    }
    if (!last) throw new Error('no babels ran');
    // THE PROVIDER'S COPY. It arrived with the countersignature and was verified before the next
    // babel was served; this is what the seller claims with. Nothing is re-derived from the buyer.
    const voucher = service.get(offer.sessionId)?.voucher();
    if (!voucher) throw new Error('the provider holds no voucher, so it has nothing to claim with');
    return { state: last, voucher };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

async function main(): Promise<void> {
  const buyerSk = loadAnchorKey();
  if (!buyerSk) throw new Error('no anchor key; run: npm run anchor -- address');
  const providerSk = bytesToHex(randomBytes(32));
  const providerPubkey = publicKeyHex(providerSk);

  const sdk = await loadSdk();
  const networkId = new sdk.NetworkId(NETWORK);
  const rpc = new sdk.RpcClient({ resolver: new sdk.Resolver(), encoding: sdk.Encoding.Borsh, networkId });
  await rpc.connect();
  try {
    console.log(`\n  1. CARVE      a UTXO of exactly ${ESCROW + GENESIS_FEE} sompi for their singleton genesis`);
    const funding = await carve(rpc, sdk, buyerSk, ESCROW + GENESIS_FEE);
    console.log(`     ${funding.txid}`);

    console.log(`\n  2. GENESIS    THEIR batch-genesis: ${Number(ESCROW) / 1e8} KAS into kaspa-x402-escrow-v2`);
    const { channel, txid: genesisId } = await openChannel(rpc, sdk, {
      buyerSk, providerPubkey, network: NETWORK, windowDaa: WINDOW_DAA, escrowSompi: ESCROW, feeSompi: GENESIS_FEE, funding,
    });
    console.log(`     ${genesisId}\n     covenantId ${channel.covenantId}\n     node id == artifact id: yes (submitReference refuses otherwise)`);
    console.log(`     timeout at DAA ${channel.timeoutDaa} (absolute; now + ${WINDOW_DAA})`);
    remember(channel, providerSk);

    console.log(`\n  3. SESSION    an ordinary metered session, ${BABELS} babels of ${BABEL} bytes at ${PRICE} sompi`);
    const { state, voucher } = await agreeOverHttp(providerSk, buyerSk, channel.covenantId);

    console.log(`\n  4. VOUCHER    held by the PROVIDER, delivered with the last countersign: ${voucher.amount} for ${state.cumulativeSompi} agreed`);
    console.log(`     amount ${voucher.amount}   covenantId ${voucher.covenantId.slice(0, 16)}…`);

    console.log(`\n  5. CLAIM      the seller claims ${state.cumulativeSompi} through THEIR batch-claim`);
    const claimed = await claimChannel(rpc, sdk, channel, voucher, providerSk, BigInt(state.cumulativeSompi), CLAIM_FEE);
    console.log(`     ${claimed.txid}`);

    const sellerAddr = new sdk.PrivateKey(providerSk).toKeypair().toAddress(networkId).toString();
    const paid = await awaitUtxo(rpc, sellerAddr, claimed.paidToSeller);
    if (!paid) throw new Error('the seller was never paid');
    console.log(`\n  RESULT        seller holds ${claimed.paidToSeller} sompi (${state.cumulativeSompi} agreed − ${CLAIM_FEE} fee)`);
    console.log(`                escrow continues with ${claimed.channel.active.amount} sompi, settledTotal ${claimed.channel.settledTotal}`);
    console.log(`                the number metered agreed is the number their contract paid.`);
    remember(claimed.channel, providerSk);

    console.log(`\n  6. REFUND     the buyer takes back the ${claimed.channel.active.amount} the seller never claimed, once DAA passes ${channel.timeoutDaa}`);
    const refund = await refundChannel(rpc, sdk, claimed.channel, buyerSk, CLAIM_FEE);
    const buyerAddr = new sdk.PrivateKey(buyerSk).toKeypair().toAddress(networkId).toString();
    const back = await awaitUtxo(rpc, buyerAddr, refund.refunded);
    if (!back) throw new Error('the refund never landed');
    console.log(`     ${refund.txid}\n     ${refund.refunded} sompi back to the buyer. Genesis, claim, refund: the whole lifecycle, on their contract.\n`);
  } finally {
    await rpc.disconnect().catch(() => undefined);
  }
}

main().catch((err: unknown) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
