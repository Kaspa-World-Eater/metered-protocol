/**
 * `npm run live:deadline` -- prove SPEC.md 7.3a on chain: what a provider loses by not posting.
 *
 * A real session runs over HTTP. Both parties count, both sign, and the provider ends up holding
 * doubly-signed States for work it genuinely delivered. Then it does the one thing 7.3a forbids:
 * nothing. The covenant UTXO ages past the response window with no claim pending, the buyer calls
 * `expire`, and consensus hands the entire balance back to the buyer.
 *
 * THE POINT IS THAT NOTHING HERE IS AN ATTACK. The buyer does not forge, race, or exploit; it
 * waits and then follows the rules. The provider is not cheated -- it holds perfectly good
 * evidence of a debt, and the chain releases the money anyway, because a signed State that was
 * never posted is a claim nobody made.
 *
 * This runs on testnet-10 and costs test coins. It is the demonstration behind the rule.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { bytesToHex } from '@noble/hashes/utils';
import { publicKeyHex } from '../src/encoding.js';
import { serveMetered } from '../src/http/serve.js';
import { MeteredService, type OfferTerms } from '../src/http/service.js';
import { openSession, runBabel } from '../src/http/client.js';
import { meterFor } from '../src/meter.js';
import { shouldSettle, type ExposurePolicy } from '../src/deadline.js';
import { loadSdk, loadAnchorKey } from './kaspa.js';
import { compileWithState, covenantAddress } from './covenant.js';
import { awaitUtxo, buildExpire, awaitWindow, type Any } from './live-steps.js';

const NETWORK = 'testnet-10' as const;
const FUND = 50_000_000n;
const FUND_FEE = 250_000n;
const CLOSE_FEE = 400_000n;
const WINDOW = 2;
const PRICE = 3630;
const BABEL = 10;

const dir = mkdtempSync(join(tmpdir(), 'metered-deadline-'));
const meter = meterFor('o200k_base');
const deliver = (prompt: string, max: number) =>
  Array.from({ length: max }, (_, i) => `${prompt}${i}`).join(' ');

/** What the provider's policy WOULD have told it, had it been asked. */
const POLICY: ExposurePolicy = { settleByAgeDaa: 1, settleAtUnsettledSompi: 50_000 };

async function main(): Promise<void> {
  const funder = loadAnchorKey();
  if (!funder) throw new Error('no anchor key; run: npm run anchor -- address');

  const buyerSk = bytesToHex(randomBytes(32));
  const providerSk = bytesToHex(randomBytes(32));
  const terms: OfferTerms = {
    v: 1, scheme: 'metered', network: 'kaspa:testnet-10', asset: 'KAS',
    unit: 'llm.output_tokens.v1', meter: 'o200k_base',
    unitPriceSompi: PRICE, babelUnits: BABEL, maxBabels: 16,
    toleranceAbs: 1, checkpointEvery: 0, responseWindowDaa: WINDOW,
  };

  const service = new MeteredService({
    terms, providerSk, providerPubkey: publicKeyHex(providerSk), meter, deliver,
  });
  const server = serveMetered({ service });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const sdk = await loadSdk();
  const networkId = new sdk.NetworkId(NETWORK);
  const priv = new sdk.PrivateKey(funder);
  const from = priv.toKeypair().toAddress(networkId).toString();
  const buyerAddr = new sdk.PrivateKey(buyerSk).toKeypair().toAddress(networkId).toString();
  const rpc = new sdk.RpcClient({ resolver: new sdk.Resolver(), encoding: sdk.Encoding.Borsh, networkId });
  await rpc.connect();

  try {
    const { offer, session } = await openSession(base, buyerSk, meter, 'kaspa:testnet-10');
    const built = compileWithState(dir, {
      parties: offer.partiesCommitment, sessionId: offer.sessionId, window: WINDOW, seq: -1, sompi: 0,
    });
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
    if (!utxo) throw new Error('the covenant UTXO never appeared');
    console.log(`\n  1. FUNDED     ${Number(FUND) / 1e8} TKAS at ${address.slice(0, 30)}...`);

    // ---- real work, really agreed.
    let owed = 0;
    for (let i = 0; i < 2; i += 1) {
      const out = await runBabel(base, session, `question-${i}-`);
      owed = out.state.cumulativeSompi;
      console.log(`     babel ${i}: ${out.billedUnits} units, ${owed} sompi owed and DOUBLY SIGNED`);
    }

    const verdict = shouldSettle(POLICY, { ageDaa: WINDOW, unsettledSompi: owed });
    console.log(`\n  2. POLICY     says settle: ${verdict.settle} -- ${verdict.why ?? 'nothing owed'}`);
    console.log('     the provider ignores it and posts nothing. That is the whole experiment.');

    await awaitWindow(rpc, WINDOW);
    console.log(`\n  3. AGED       past the ${WINDOW}-DAA window with NO claim pending`);

    const close = buildExpire(
      sdk,
      { buyerPk: offer.buyerPubkey, providerPk: offer.providerPubkey, signerSk: buyerSk,
        redeem: built.hex, tag: built.entries.expire?.dispatch_tag ?? '' },
      utxo,
      [{ address: buyerAddr, amount: utxo.amount - CLOSE_FEE }],
      WINDOW,
    );
    const id = (await rpc.submitTransaction({ transaction: close, allowOrphan: false })).transactionId;
    const got = await awaitUtxo(rpc, buyerAddr, utxo.amount - CLOSE_FEE);
    if (!got) throw new Error('the close did not land');

    console.log(`\n  4. CLOSED     the buyer took everything back   ${id}`);
    console.log(`\n  PROVIDER OWED     ${owed} sompi, doubly signed, for work actually delivered`);
    console.log(`  PROVIDER RECEIVED 0`);
    console.log(`  BUYER RECEIVED    ${Number(utxo.amount - CLOSE_FEE) / 1e8} TKAS -- the entire balance`);
    console.log('\n  Nothing here was an attack. The buyer waited, then followed the rules.');
    console.log('  SPEC.md 7.3a is the rule that makes this the provider\'s own fault.\n');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await rpc.disconnect().catch(() => undefined);
  }
}

main().catch((err: unknown) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
