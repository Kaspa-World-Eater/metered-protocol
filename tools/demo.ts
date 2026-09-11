/**
 * `npm run demo` -- the whole thing, end to end, on testnet-10.
 *
 * A buyer discovers terms over HTTP, runs a metered session against a real server, and then
 * settles the result on Kaspa. Every piece this project has built, in one command:
 *
 *   402 handshake -> the provider states its terms and signs them
 *   covenant       -> compiled with those exact terms, funded on chain
 *   chunks         -> delivered over HTTP, counted by BOTH sides, doubly signed
 *   settle         -> the final State posted to the covenant under real consensus
 *   expire         -> the money splits: provider paid what it earned, buyer refunded
 *
 * WHAT IS REAL AND WHAT IS NOT, stated plainly. The transport, the signatures, the covenant, the
 * transactions and the coins are all real, and so is the COUNTING: both sides run the real
 * `o200k_base` tokeniser over SPEC.md 6's real unit, `llm.output_tokens.v1`, and src/tokenizer.ts
 * is pinned id-for-id against the Python tiktoken every number in SPEC.md was measured with.
 *
 * What is still not real is the CONTENT: generated text rather than model output, because
 * metering something is the claim being demonstrated and wiring a model in would add an API key
 * and prove nothing further. Earlier this demo also counted words under a `words.v1` unit of its
 * own invention, which meant the one thing it existed to show was the one thing it faked.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { meterFor } from '../src/tokenizer.js';
import { demoModel, type ModelSource } from './model.js';
import { fileStore } from '../src/store.js';
import { publicKeyHex, signEnvelope, signState } from '../src/encoding.js';
import { serveMetered } from '../src/http/serve.js';
import { MeteredService, type OfferTerms } from '../src/http/service.js';
import { kaspaAnchor } from './anchor.js';
import { openSession, runBabel } from '../src/http/client.js';
import { loadSdk, loadAnchorKey } from './kaspa.js';
import { compileWithState, covenantAddress } from './covenant.js';
import { preflightSigscript, awaitUtxo, withState, buildExpire, awaitWindow, closeOutputs, x, type Any } from './live-steps.js';
import type { Offer, State } from '../src/types.js';

const NETWORK = 'testnet-10' as const;
const FUND = 50_000_000n;
const FUND_FEE = 250_000n;
const SETTLE_FEE = 360_000n;
const CLOSE_FEE = 400_000n;
const WINDOW = 2;
// DELIBERATELY BELOW THE KIP-9 FLOOR. Thirty words at 3,630 sompi earns 108,900 -- about
// eighteen times too small to be paid out as its own output. That is the exact session that
// LOCKED THE FUNDS and produced Finding G, and it is kept here on purpose: the covenant now
// folds a dust payout into the buyer's refund rather than demanding an output the chain cannot
// create, so this run closes. A demo priced safely above the floor would never touch that path.
const PRICE = 3630;
const CHUNK = 10;
const CHUNKS = 3;

const TOKENIZER = 'o200k_base';
const dir = mkdtempSync(join(tmpdir(), 'metered-demo-'));
const meter = meterFor(TOKENIZER);
const generated = (prompt: string, max: number) =>
  Array.from({ length: max }, (_, i) => `${prompt}${i}`).join(' ');

/**
 * `npm run demo -- --model` meters a REAL language model instead of generated text.
 *
 * Everything else is identical, which is the point: the protocol never knew what it was metering.
 * Without the flag, or without a key, the demo runs on generated text and says so.
 */
const USE_MODEL = process.argv.includes('--model');

/**
 * Open a session, let the caller fund its covenant, THEN run the chunks.
 *
 * The order matters for a reason worth writing down: a checkpoint anchor SPENDS a UTXO, and in
 * this demo the anchoring wallet and the funding wallet are the same one. Running chunks first
 * meant the anchor consumed the UTXO the funding transaction was about to use, and the covenant
 * was never funded. In a real deployment the provider anchors from its own wallet and the buyer
 * funds the covenant from another, so they never contend -- the demo has to be explicit about an
 * order that reality gets for free.
 */
async function runSession(
  terms: OfferTerms, providerSk: string, buyerSk: string, funder: string,
  afterOpen: (offer: Offer) => Promise<void>,
  deliver: (prompt: string, max: number) => string = generated,
): Promise<{ offer: Offer; state: State; sigs: [string, string]; service: MeteredService }> {
  // A REAL anchor. SPEC.md 8's checkpoints go to testnet-10 while the session is still running,
  // which is the point of them being non-blocking: the chunks below do not wait for a block.
  const service = new MeteredService({
    terms, providerSk, providerPubkey: publicKeyHex(providerSk), meter, deliver,
    // SPEC.md 4, durably. A provider holding money must not forget what it has signed, and the
    // default store forgets on restart -- so the demo uses the real one, in its temp directory.
    store: fileStore(join(dir, 'signer.jsonl')),
    anchor: kaspaAnchor({ network: NETWORK, privateKeyHex: funder }),
  });
  const server = serveMetered({ service });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const { offer, session } = await openSession(base, buyerSk, meter, 'kaspa:testnet-10');
    await afterOpen(offer);
    let last: State | null = null;
    for (let i = 0; i < CHUNKS; i += 1) {
      const out = await runBabel(base, session, `word${i}-`);
      console.log(`     chunk ${i}: ${out.billedUnits} units, ${out.state.cumulativeSompi} sompi owed`);
      last = out.state;
    }
    if (!last) throw new Error('no chunks ran');
    return { offer, state: last, sigs: [signState(last, buyerSk), signState(last, providerSk)], service };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** Read the close back off the chain and say which of the three shapes it took. */
async function reportClose(
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
  console.log(`\n     provider earned ${Number(first.amount) / 1e8} TKAS for ${units} tokens`);
  console.log(`     buyer refunded  ${Number(outs[1]!.amount) / 1e8} TKAS\n`);
}

/** Checkpoint records, with the txid that makes one usable as evidence. */
function reportCheckpoints(records: { seq: number; status: string; txid?: string; error?: string }[]): void {
  for (const c of records) {
    const where = c.txid ? `   ${c.txid}` : c.error ? `   ${c.error}` : '';
    console.log(`     seq ${c.seq}       ${c.status}${where}`);
  }
}

/** Say what is behind the meter, so a reader never has to guess whether it was real. */
function announceModel(source: ModelSource | null): void {
  if (!source) return;
  console.log(`
  0. MODEL      ${source.model}, ${source.reportedTokens.length} completions`);
  console.log(`                the model reports ${source.reportedTokens.join(', ')} output tokens`);
}

async function main(): Promise<void> {
  const funder = loadAnchorKey();
  if (!funder) throw new Error('no anchor key; run: npm run anchor -- address');

  const buyerSk = bytesToHex(randomBytes(32));
  const providerSk = bytesToHex(randomBytes(32));
  const buyerPk = publicKeyHex(buyerSk);
  const providerPk = publicKeyHex(providerSk);

  // A REAL MODEL, if asked for. Replies are fetched up front because `Deliver` is synchronous --
  // reconciliation is -- and capped at CHUNK output tokens each, so the babel is enforced by the
  // model itself rather than trusted.
  const source = await demoModel(USE_MODEL, CHUNK);
  announceModel(source);

  // TERMS ONLY -- no sessionId, no buyer, no parties commitment. The server mints those when a
  // buyer asks, because an Offer commits to blake3(buyer || provider) and cannot be signed for
  // someone who has not turned up yet. That is also what lets one server hold many sessions.
  const terms: OfferTerms = {
    v: 1, scheme: 'metered', network: 'kaspa:testnet-10', asset: 'KAS',
    unit: 'llm.output_tokens.v1', tokenizer: TOKENIZER,
    unitPriceSompi: PRICE, babelUnits: CHUNK, maxBabels: 16,
    toleranceAbs: 1, checkpointEvery: 2, responseWindowDaa: WINDOW,
  };
  console.log(`\n  1. TERMS      ${CHUNK} ${TOKENIZER} tokens per chunk at ${PRICE} sompi each`);

  const sdk = await loadSdk();
  const networkId = new sdk.NetworkId(NETWORK);
  const priv = new sdk.PrivateKey(funder);
  const from = priv.toKeypair().toAddress(networkId).toString();
  const rpc = new sdk.RpcClient({ resolver: new sdk.Resolver(), encoding: sdk.Encoding.Borsh, networkId });
  await rpc.connect();
  try {
    let covenant: { hex: string; entries: Record<string, { dispatch_tag: string }>; address: string; utxo: Any } | null = null;

    console.log(`\n  2. SESSION    opening, funding, then running ${CHUNKS} chunks over HTTP`);
    const { offer, state, sigs, service } = await runSession(terms, providerSk, buyerSk, funder, async (o) => {
      // THE COVENANT IS BUILT FROM THE OFFER THE SERVER ACTUALLY ISSUED, so its constructor
      // constants are that session's parties commitment and id. The address is derived from the
      // agreement rather than the agreement being fitted to an address.
      const built = compileWithState(dir, { parties: o.partiesCommitment, sessionId: o.sessionId, window: WINDOW, seq: -1, sompi: 0 });
      const address = await covenantAddress(built.hex, NETWORK);
      const { entries } = await rpc.getUtxosByAddresses([from]);
      const src = entries.reduce((a: Any, b: Any) => (b.amount > a.amount ? b : a));
      const fund = sdk.createTransaction(
        [src], [{ address, amount: FUND }, { address: from, amount: src.amount - FUND - FUND_FEE }], 0n, undefined, 0,
      );
      fund.version = 1;
      fund.gas = 0n;
      for (const i of fund.inputs) { i.sigOpCount = 0; i.computeBudget = 10; }
      fund.finalize();
      await rpc.submitTransaction({ transaction: sdk.signTransaction(fund, [priv], true), allowOrphan: false });
      const utxo = await awaitUtxo(rpc, address, FUND);
      if (!utxo) throw new Error('covenant UTXO never appeared');
      covenant = { ...built, address, utxo };
      console.log(`     funded     ${Number(FUND) / 1e8} TKAS -> ${address.slice(0, 28)}...`);
    }, source?.deliver ?? generated);
    if (!covenant) throw new Error('the covenant was never funded');
    const opened = covenant as { hex: string; entries: Record<string, { dispatch_tag: string }>; address: string; utxo: Any };
    const utxo = opened.utxo;
    const parties = offer.partiesCommitment;
    const sessionId = offer.sessionId;

    console.log(`     final      seq ${state.seq}, ${state.cumulativeUnits} units, ${state.cumulativeSompi} sompi`);

    // SPEC.md 8 checkpoints were dispatched DURING the session, without it waiting for a block.
    const checkpoints = service.checkpointsFor(sessionId);
    console.log(`\n  3. ANCHORED   ${checkpoints.length} checkpoint(s), dispatched mid-session without it waiting`);
    reportCheckpoints(checkpoints);
    void blake3; void hexToBytes; void signEnvelope;

    const ctor = [x(parties), x(sessionId), WINDOW, -1, 0];
    const outRedeem = withState(opened.hex, state.seq, state.cumulativeSompi);
    const outAddr = await covenantAddress(outRedeem, NETWORK);
    const outValue = utxo.amount - SETTLE_FEE;
    const sigscript = preflightSigscript({
      name: 'demo settle',
      function: 'settle',
      constructor_args: ctor,
      args: [x(buyerPk), x(providerPk), x(sigs[0]), x(sigs[1]), state.seq, state.cumulativeUnits, state.cumulativeSompi, x(state.prevState ?? '00'.repeat(32))],
      expect: 'pass',
      tx: {
        active_input_index: 0,
        inputs: [{ utxo_value: Number(utxo.amount), constructor_args: ctor }],
        outputs: [{ value: Number(outValue), constructor_args: ctor, state: { pendingSeq: state.seq, pendingSompi: state.cumulativeSompi } }],
      },
    }, dir);
    const spend = sdk.createTransaction([utxo], [{ address: outAddr, amount: outValue }], 0n, undefined, 0);
    spend.version = 1;
    spend.gas = 0n;
    spend.inputs[0].sigOpCount = 0;
    spend.inputs[0].computeBudget = 21;
    const push = new sdk.ScriptBuilder();
    push.addData(opened.hex);
    spend.inputs[0].signatureScript = sigscript + push.toString();
    spend.finalize();
    const settleId = (await rpc.submitTransaction({ transaction: spend, allowOrphan: false })).transactionId;
    const posted = await awaitUtxo(rpc, outAddr, outValue);
    if (!posted) throw new Error('the claim never posted');
    console.log(`\n  4. SETTLED    the HTTP session's State, on chain   ${settleId}`);

    await awaitWindow(rpc, WINDOW);
    const buyerAddr = new sdk.PrivateKey(buyerSk).toKeypair().toAddress(networkId).toString();
    const providerAddr = new sdk.PrivateKey(providerSk).toKeypair().toAddress(networkId).toString();
    const owed = BigInt(state.cumulativeSompi);
    // The covenant accepts exactly three close shapes and refuses everything else, so the shape
    // is computed rather than assumed. Guessing gets "script ran, but verification failed", which
    // says nothing about which rule was broken.
    const outs = closeOutputs(posted.amount, owed, CLOSE_FEE, buyerAddr, providerAddr);
    const close = buildExpire(
      sdk,
      { buyerPk, providerPk, signerSk: providerSk, redeem: outRedeem, tag: opened.entries.expire?.dispatch_tag ?? '' },
      posted, outs, WINDOW,
    );
    const closeId = (await rpc.submitTransaction({ transaction: close, allowOrphan: false })).transactionId;
    console.log(`  5. CLOSED     ${closeId}`);
    await reportClose(rpc, outs, providerAddr, state.cumulativeSompi, state.cumulativeUnits);

    // The same checkpoints, read again now the session is over. They said "pending" above because
    // the session did not wait for them, which is SPEC.md 8's rule; they have since resolved on
    // their own. A checkpoint carries its txid so a future reader can fetch the block and check
    // the payload rather than taking this process's word for it.
    // The session never waited for these (SPEC.md 8). This report does, ONCE, now that the
    // session is over -- otherwise every line below reads `pending`, which is the state a record
    // is born in and says nothing about whether the anchor worked.
    await service.checkpointsSettled(sessionId);
    console.log('  6. CHECKPOINTS, re-read now the session is done:');
    for (const c of service.checkpointsFor(sessionId)) {
      console.log(`     seq ${c.seq}       ${c.status}${c.txid ? `   ${c.txid}` : ''}${c.error ? `   ${c.error}` : ''}`);
    }
    console.log('');
  } finally {
    await rpc.disconnect().catch(() => undefined);
  }
}

main().catch((err: unknown) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
