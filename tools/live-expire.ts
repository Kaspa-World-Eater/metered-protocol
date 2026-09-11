/**
 * `npm run live:expire` -- open a real covenant on testnet-10 and close it with `expire`.
 *
 * WHY EXPIRE AND NOT SETTLE. `settle` hands the funds back to the SAME covenant with updated
 * state, and a continuation output must carry a KIP-20 CovenantBinding tying it to the authorizing
 * input. That plumbing now exists in tools/live-settle.ts. `expire` still needs none of it: it
 * pays plain P2PK addresses and continues nothing, and Argent lowers `emits {}` to
 * OpAuthOutputCount == 0, which an unbound payout already satisfies. That is what made it the
 * first covenant path to run on chain, and the first the ARGENT port ran too.
 *
 * WHAT IT PROVES. The whole covenant executes under real consensus: the parties commitment, the
 * relative timelock, the signature check, and the no-claim refund branch that step 3.4 added
 * after finding the funding UTXO would otherwise be unspendable forever.
 *
 * Everything happens in ONE run because the session keys live only in memory. Two earlier
 * attempts generated keys, funded a covenant and then exited on an unrelated error, stranding the
 * coins at an address whose keys no longer exist. Testnet, so it cost nothing but the lesson.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { publicKeyHex } from '../src/encoding.js';
import { loadSdk, loadAnchorKey } from './kaspa.js';
import { compileWithState, covenantAddress } from './covenant.js';
import { profileFromArgv } from './covenant-profile.js';

const NETWORK = 'testnet-10' as const;
const FUND_SOMPI = 50_000_000n;
const FUND_FEE = 250_000n;
// expire does TWO signature checks, so it needs compute budget 21, not 10 -- and mass rises with
// the budget, so the node demands ~313,800 for a one-output close. Measured by being refused.
const SPEND_FEE = 350_000n;
const EXPIRE_BUDGET = 21;
const WINDOW = 2;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/** kaspa-depin's lesson: createInputSignature returns a signature SCRIPT; strip the 0x41 push. */
const bareSig = (s: string) => (s.length === 132 && s.startsWith('41') ? s.slice(2) : s);

async function main(): Promise<void> {
  const funder = loadAnchorKey();
  if (!funder) throw new Error('no anchor key; run: npm run anchor -- address');

  const dir = mkdtempSync(join(tmpdir(), 'metered-expire-'));
  const buyerSk = bytesToHex(randomBytes(32));
  const providerSk = bytesToHex(randomBytes(32));
  const buyerPk = publicKeyHex(buyerSk);
  const providerPk = publicKeyHex(providerSk);
  const parties = bytesToHex(blake3(new Uint8Array([...hexToBytes(buyerPk), ...hexToBytes(providerPk)]), { dkLen: 32 }));
  const sessionId = bytesToHex(randomBytes(16));

  // `npm run live:expire -- --profile ag` closes with the ARGENT covenant instead. `expire` is
  // the entry that needs no KIP-20 plumbing: Argent lowers `emits {}` to OpAuthOutputCount == 0,
  // and an unbound P2PK payout already has zero authorised outputs.
  const profile = profileFromArgv();
  const compiled = compileWithState(dir, { parties, sessionId, window: WINDOW, seq: -1, sompi: 0 }, profile.contract);
  const address = await covenantAddress(compiled.hex, NETWORK);
  const tag = compiled.entries.expire?.dispatch_tag;
  if (!tag) throw new Error('the artifact has no expire entry');

  console.log(`\n  covenant  ${compiled.hex.length / 2} bytes  [${profile.key}] ${profile.contract}`);
  console.log(`  address   ${address}`);
  console.log(`  closing with EXPIRE, no claim posted -- the buyer takes it all back (SPEC 7.2)`);

  const sdk = await loadSdk();
  const networkId = new sdk.NetworkId(NETWORK);
  const priv = new sdk.PrivateKey(funder);
  const funderAddr = priv.toKeypair().toAddress(networkId).toString();
  const buyerAddr = new sdk.PrivateKey(buyerSk).toKeypair().toAddress(networkId).toString();
  const rpc = new sdk.RpcClient({ resolver: new sdk.Resolver(), encoding: sdk.Encoding.Borsh, networkId });
  await rpc.connect();
  try {
    const { entries } = await rpc.getUtxosByAddresses([funderAddr]);
    const utxo = entries.reduce((a: Any, b: Any) => (b.amount > a.amount ? b : a));
    const fundTx = sdk.createTransaction(
      [utxo],
      [{ address, amount: FUND_SOMPI }, { address: funderAddr, amount: utxo.amount - FUND_SOMPI - FUND_FEE }],
      0n, undefined, 0,
    );
    fundTx.version = 1;
    fundTx.gas = 0n;
    for (const i of fundTx.inputs) { i.sigOpCount = 0; i.computeBudget = 10; }
    fundTx.finalize();
    const fundId = (await rpc.submitTransaction({ transaction: sdk.signTransaction(fundTx, [priv], true), allowOrphan: false })).transactionId;
    console.log(`  funded    ${Number(FUND_SOMPI) / 1e8} TKAS   txid ${fundId}`);

    let cov: Any = null;
    for (let i = 0; i < 40 && !cov; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      const res = await rpc.getUtxosByAddresses([address]);
      cov = res.entries.find((e: Any) => e.amount === FUND_SOMPI) ?? null;
    }
    if (!cov) throw new Error('the covenant UTXO never appeared');

    // The window is RELATIVE (SPEC 7.3): ageDaa lowers to OpCheckSequenceVerify, which reads the
    // spending input's sequence. The UTXO must also actually BE that old, so wait for the DAA
    // score to advance past it.
    const startDaa = (await rpc.getBlockDagInfo()).virtualDaaScore;
    while ((await rpc.getBlockDagInfo()).virtualDaaScore < startDaa + BigInt(WINDOW) + 2n) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log(`  aged      past the ${WINDOW}-DAA response window`);

    const spend = sdk.createTransaction(
      [cov],
      [{ address: buyerAddr, amount: cov.amount - SPEND_FEE }],
      0n, undefined, 0,
    );
    spend.version = 1;
    spend.gas = 0n;
    spend.inputs[0].sigOpCount = 0;
    spend.inputs[0].computeBudget = EXPIRE_BUDGET;
    spend.inputs[0].sequence = BigInt(WINDOW);

    const sig = bareSig(sdk.createInputSignature(spend, 0, new sdk.PrivateKey(buyerSk)));
    const sb = new sdk.ScriptBuilder();
    sb.addData(buyerPk);
    sb.addData(providerPk);
    sb.addData(sig);
    sb.addData(tag);
    sb.addData(compiled.hex);
    spend.inputs[0].signatureScript = sb.toString();
    spend.finalize();

    const id = (await rpc.submitTransaction({ transaction: spend, allowOrphan: false })).transactionId;
    console.log(`\n  EXPIRED   the covenant ran under real consensus and paid out`);
    console.log(`  refund    ${Number(cov.amount - SPEND_FEE) / 1e8} TKAS -> ${buyerAddr}`);
    console.log(`  txid      ${id}`);
    console.log(`  explorer  https://explorer-tn10.kaspa.org/txs/${id}\n`);
  } finally {
    await rpc.disconnect().catch(() => undefined);
  }
}

main().catch((err: unknown) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
