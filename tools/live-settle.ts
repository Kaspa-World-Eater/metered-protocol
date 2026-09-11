/**
 * `npm run live:settle` -- drive a real multi-chunk session on testnet-10, including a SUPERSEDE.
 *
 * The single settle that ran first proved the covenant accepts a doubly-signed State. It did not
 * prove the thing the two-phase design exists for: that a LATER State replaces a pending one and
 * a STALE one cannot. This runs all three steps against real consensus --
 *
 *   1. settle seq 0                 the first claim posts
 *   2. settle seq 0 again           refused; the guard is `seq > pendingSeq`, strictly
 *   3. settle seq 1                 supersedes, and the state advances again
 *   4. expire                       closes it, and the money SPLITS
 *
 * Step 2 is the one worth having. It is the stale-close threat -- "settle an old, lower-seq
 * State" -- and until now it had only ever been refused by a simulator.
 *
 * Step 4 is the other one worth having. Every earlier expire closed a session with NO claim
 * posted -- one output, nothing to divide. This one pays the provider exactly what it is owed and
 * refunds the rest, which is the only branch where getting an output value wrong costs somebody.
 *
 * The simulator is still the pre-flight for every spend EXPECTED to succeed, and it emits the
 * authoritative signature script. See tools/live-steps.ts for why the redeem script must be
 * appended to it by hand.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { publicKeyHex, signState, digestHex } from '../src/encoding.js';
import { loadSdk, loadAnchorKey } from './kaspa.js';
import { compileWithState, covenantAddress } from './covenant.js';
import { preflightSigscript, awaitUtxo, withState, buildExpire, awaitWindow, x, type Any } from './live-steps.js';
import { profileFromArgv, COVENANT_ID } from './covenant-profile.js';
import { bindContinuation, fundAsCovenant, covenantIdOf, assertInherited } from './covenant-binding.js';

// `npm run live:settle -- --profile ag` drives the ARGENT covenant instead.
const PROFILE = profileFromArgv();

const NETWORK = 'testnet-10' as const;
const FUND_SOMPI = 50_000_000n;
const FUND_FEE = 250_000n;
const SPEND_FEE = 360_000n; // measured: mass 3,429 -> 342,900 required
const SPEND_BUDGET = 21; // two checkMsgSig calls
const WINDOW = 2;
const CLOSE_FEE = 400_000n; // the covenant allowance in full; expire is the costliest path
const PRICE = 3630;
const CHUNK = 550;

const dir = mkdtempSync(join(tmpdir(), 'metered-settle-'));

interface Party {
  sk: string;
  pk: string;
}

interface Claim {
  seq: number;
  cumulativeUnits: number;
  cumulativeSompi: number;
  prevState: string | null;
}

/** Build one settle spend: pre-flight it, then hand back a signed transaction ready to submit. */
function buildSettle(
  sdk: Any,
  args: { parties: string; sessionId: string; buyer: Party; provider: Party },
  pending: { seq: number; sompi: number },
  claim: Claim,
  redeem: string,
  utxo: Any,
  outAddress: string,
  expectPass: boolean,
): Any {
  const state = {
    v: 1, sessionId: args.sessionId, seq: claim.seq,
    cumulativeUnits: claim.cumulativeUnits, cumulativeSompi: claim.cumulativeSompi,
    prevState: claim.prevState,
  };
  const ctor = [x(args.parties), x(args.sessionId), WINDOW, pending.seq, pending.sompi];
  const outValue = utxo.amount - SPEND_FEE;
  const sigscript = preflightSigscript({
    name: `live settle seq ${claim.seq}${expectPass ? '' : ' (stale)'}`,
    function: 'settle',
    constructor_args: ctor,
    args: [
      x(args.buyer.pk), x(args.provider.pk),
      x(signState(state, args.buyer.sk)), x(signState(state, args.provider.sk)),
      claim.seq, claim.cumulativeUnits, claim.cumulativeSompi, x(claim.prevState ?? '00'.repeat(32)),
    ],
    expect: expectPass ? 'pass' : 'fail',
    tx: {
      active_input_index: 0,
      inputs: [{ utxo_value: Number(utxo.amount), constructor_args: ctor, ...(PROFILE.binds ? { covenant_id: COVENANT_ID } : {}) }],
      outputs: [{
        value: Number(outValue), constructor_args: ctor,
        state: PROFILE.outState({
          parties: args.parties, sessionId: args.sessionId, window: WINDOW,
          seq: claim.seq, sompi: claim.cumulativeSompi,
        }),
        ...(PROFILE.binds ? { covenant_id: COVENANT_ID, authorizing_input: 0 } : {}),
      }],
    },
  }, dir, expectPass, PROFILE.contract);

  const tx = sdk.createTransaction([utxo], [{ address: outAddress, amount: outValue }], 0n, undefined, 0);
  tx.version = 1;
  tx.gas = 0n;
  tx.inputs[0].sigOpCount = 0;
  tx.inputs[0].computeBudget = SPEND_BUDGET;
  const push = new sdk.ScriptBuilder();
  push.addData(redeem);
  tx.inputs[0].signatureScript = sigscript + push.toString();
  const binding = bindContinuation(sdk, tx, utxo, PROFILE.binds);
  tx.finalize();
  return { tx, state, outValue, binding };
}

/**
 * Fund the covenant from the anchor key and wait for its UTXO.
 *
 * AN ARGENT SESSION MUST BE FUNDED AS A COVENANT, not merely paid into, and this cost a rejected
 * transaction to learn. `OpAuthOutputCount(activeInput)` asks how many outputs are authorised by
 * the input being spent -- and an input that belongs to NO covenant authorises nothing, whatever
 * its outputs claim. So the identity has to exist before the first settle, which means the
 * FUNDING transaction is the genesis.
 *
 * The simulator passed the same spend because its test case declares `covenant_id` on the input
 * directly; on chain there was nothing to declare it. That disagreement between simulator and
 * consensus is the finding, and it is why the pre-flight is a floor rather than a proof.
 *
 * The hand-written covenant needs none of this: it constrains `outputs[0]` by convention and
 * never asks who authorised it.
 */
async function payInto(sdk: Any, rpc: Any, priv: Any, from: string, address: string): Promise<Any> {
  const { entries } = await rpc.getUtxosByAddresses([from]);
  const source = entries.reduce((a: Any, b: Any) => (b.amount > a.amount ? b : a));
  const tx = sdk.createTransaction(
    [source],
    [{ address, amount: FUND_SOMPI }, { address: from, amount: source.amount - FUND_SOMPI - FUND_FEE }],
    0n, undefined, 0,
  );
  tx.version = 1;
  tx.gas = 0n;
  for (const i of tx.inputs) { i.sigOpCount = 0; i.computeBudget = 10; }
  fundAsCovenant(tx, PROFILE.binds);
  tx.finalize();
  await rpc.submitTransaction({ transaction: sdk.signTransaction(tx, [priv], true), allowOrphan: false });
  return awaitUtxo(rpc, address, FUND_SOMPI);
}

/**
 * Submit a spend that MUST be rejected, and return why. A silent success here would mean the
 * supersede guard does not hold on chain, which is the one outcome that must never pass quietly.
 */
async function expectRefusal(rpc: Any, tx: Any): Promise<string> {
  try {
    await rpc.submitTransaction({ transaction: tx, allowOrphan: false });
  } catch (err) {
    return (err instanceof Error ? err.message : String(err)).split(':').pop()?.trim() ?? 'refused';
  }
  throw new Error('CONSENSUS ACCEPTED A STALE STATE -- the supersede guard does not hold on chain');
}

async function main(): Promise<void> {
  const funder = loadAnchorKey();
  if (!funder) throw new Error('no anchor key; run: npm run anchor -- address');

  const buyer: Party = { sk: bytesToHex(randomBytes(32)), pk: '' };
  const provider: Party = { sk: bytesToHex(randomBytes(32)), pk: '' };
  buyer.pk = publicKeyHex(buyer.sk);
  provider.pk = publicKeyHex(provider.sk);
  const parties = bytesToHex(blake3(new Uint8Array([...hexToBytes(buyer.pk), ...hexToBytes(provider.pk)]), { dkLen: 32 }));
  const sessionId = bytesToHex(randomBytes(16));
  const ids = { parties, sessionId, buyer, provider };

  const opened = compileWithState(dir, { parties, sessionId, window: WINDOW, seq: -1, sompi: 0 }, PROFILE.contract);
  const spanEnd = opened.span.offset + opened.span.len;
  const address = await covenantAddress(opened.hex, NETWORK);
  console.log(`\n  covenant  ${opened.hex.length / 2} bytes  [${PROFILE.key}]  state span ${opened.span.len}`);
  console.log(`  address   ${address}`);

  const sdk = await loadSdk();
  const networkId = new sdk.NetworkId(NETWORK);
  const priv = new sdk.PrivateKey(funder);
  const funderAddr = priv.toKeypair().toAddress(networkId).toString();
  const rpc = new sdk.RpcClient({ resolver: new sdk.Resolver(), encoding: sdk.Encoding.Borsh, networkId });
  await rpc.connect();
  try {
    const utxo0 = await payInto(sdk, rpc, priv, funderAddr, address);
    if (!utxo0) throw new Error('the covenant UTXO never appeared');
    console.log(`  funded    ${Number(FUND_SOMPI) / 1e8} TKAS`);

    // ---- 1. the first claim
    const claim0: Claim = { seq: 0, cumulativeUnits: CHUNK, cumulativeSompi: CHUNK * PRICE, prevState: null };
    const redeem1 = withState(opened.hex, claim0.seq, claim0.cumulativeSompi, spanEnd);
    const addr1 = await covenantAddress(redeem1, NETWORK);
    const first = buildSettle(sdk, ids, { seq: -1, sompi: 0 }, claim0, opened.hex, utxo0, addr1, true);
    const id0 = (await rpc.submitTransaction({ transaction: first.tx, allowOrphan: false })).transactionId;
    const utxo1 = await awaitUtxo(rpc, addr1, first.outValue);
    if (!utxo1) throw new Error('the seq-0 continuation never appeared');
    console.log(`\n  1. SETTLED seq 0   ${id0}`);
    if (PROFILE.binds) console.log(`     covenant  ${first.binding}  ${covenantIdOf(first.tx)}`);

    // ---- 2. THE STALE CLOSE. Consensus must refuse this: seq 0 is not > pendingSeq 0.
    const stale = buildSettle(sdk, ids, { seq: 0, sompi: claim0.cumulativeSompi }, claim0, redeem1, utxo1, addr1, false);
    console.log(`  2. REFUSED seq 0 again -- ${await expectRefusal(rpc, stale.tx)}`);

    // ---- 3. supersede with a strictly higher seq
    const claim1: Claim = {
      seq: 1, cumulativeUnits: CHUNK * 2, cumulativeSompi: CHUNK * 2 * PRICE,
      prevState: digestHex(first.state),
    };
    const redeem2 = withState(opened.hex, claim1.seq, claim1.cumulativeSompi, spanEnd);
    const addr2 = await covenantAddress(redeem2, NETWORK);
    const second = buildSettle(sdk, ids, { seq: 0, sompi: claim0.cumulativeSompi }, claim1, redeem1, utxo1, addr2, true);
    const id1 = (await rpc.submitTransaction({ transaction: second.tx, allowOrphan: false })).transactionId;
    const utxo2 = await awaitUtxo(rpc, addr2, second.outValue);
    if (!utxo2) throw new Error('the seq-1 continuation never appeared');
    console.log(`  3. SETTLED seq 1   ${id1}`);
    if (PROFILE.binds) {
      console.log(`     covenant  ${second.binding}  ${covenantIdOf(second.tx)}`);
      assertInherited(second.binding, second.tx, first.tx);
    }
    console.log(`     ${Number(second.outValue) / 1e8} TKAS at the seq-1 covenant, state advanced twice`);

    // ---- 4. CLOSE IT. The branch where the money actually SPLITS: the provider takes the pending
    // claim, the buyer takes the remainder. Until now expire had only ever closed a session with
    // NO claim posted, which is the easy half -- one output, nothing to divide.
    const buyerAddr = new sdk.PrivateKey(buyer.sk).toKeypair().toAddress(networkId).toString();
    const providerAddr = new sdk.PrivateKey(provider.sk).toKeypair().toAddress(networkId).toString();
    const owed = BigInt(claim1.cumulativeSompi);
    const refund = utxo2.amount - owed - CLOSE_FEE;

    // SPEC 7.3: the window is RELATIVE, so the UTXO must actually be that old before ageDaa passes.
    await awaitWindow(rpc, WINDOW);

    const closeTx = buildExpire(
      sdk,
      {
        buyerPk: buyer.pk, providerPk: provider.pk, signerSk: provider.sk,
        redeem: redeem2, tag: opened.entries.expire?.dispatch_tag ?? '',
      },
      utxo2,
      [{ address: providerAddr, amount: owed }, { address: buyerAddr, amount: refund }],
      WINDOW,
    );
    const id2 = (await rpc.submitTransaction({ transaction: closeTx, allowOrphan: false })).transactionId;
    const paid = await awaitUtxo(rpc, providerAddr, owed);
    const refunded = await awaitUtxo(rpc, buyerAddr, refund);
    if (!paid || !refunded) throw new Error('the split did not land -- one side was not paid');
    console.log(`  4. CLOSED  seq 1   ${id2}`);
    console.log(`\n  VERIFIED  provider ${Number(owed) / 1e8} TKAS, buyer ${Number(refund) / 1e8} TKAS`);
    console.log(`            full lifecycle on chain: settle, refuse a stale one, supersede, split\n`);
  } finally {
    await rpc.disconnect().catch(() => undefined);
  }
}

main().catch((err: unknown) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
