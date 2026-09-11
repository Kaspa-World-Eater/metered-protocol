/**
 * `npm run fee-check` -- does the covenant's compiled-in fee allowance hold on MAINNET?
 *
 * WHY THIS CANNOT WAIT UNTIL AFTER A DEPLOYMENT. `expire` reserves 400,000 sompi for the
 * transaction that closes a session, and that number is COMPILED INTO THE SCRIPT. If mainnet
 * prices the close above it, the covenant demands an output it cannot afford to pay for, no valid
 * close exists, and the balance is stranded -- with no way to patch the script that stranded it.
 * Finding E cost a live spend to learn the allowance was below the minimum; this asks the same
 * question of a different network, in advance.
 *
 * THE SDK'S FEE CALCULATOR IS NOT THE ORACLE HERE, and finding that out was the point of writing
 * this. `calculateTransactionFee` returns `undefined` above `maximumStandardTransactionMass`,
 * which is 100,000 on both networks -- and a two-output close of this covenant has a STORAGE mass
 * of 251,929, because KIP-9 prices an output by its reciprocal and a 4,000,000-sompi payout is
 * expensive by that measure. So the SDK refuses to price a transaction THIS PROJECT HAS REPEATEDLY
 * LANDED ON CHAIN: 100,000 is a standard-transaction policy, while the consensus limit KIP-9
 * enforces is 500,000, which tools/dust-map.ts models against a real rejection.
 *
 * So this reports three things separately rather than one number: what the two networks' rules
 * are, what the compute fee is where the SDK will price it, and where each shape sits against the
 * consensus storage limit. A single "fits" would have hidden all of it.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSdk, type Network } from './kaspa.js';
import { CLOSE_FEE_SOMPI } from '../src/reservation.js';
import { compileWithState } from './covenant.js';
import { buildExpire } from './live-steps.js';
import { publicKeyHex } from '../src/encoding.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const FUNDED = 50_000_000n;

/** The bytes an `expire` spend actually carries: arguments, dispatch tag, and the redeem script. */
const EXPIRE_SIGSCRIPT_BYTES = 660;
/**
 * Build the REAL close transaction, with the real redeem script and a real signature.
 *
 * An earlier version of this file modelled the transaction by hand and reported a mass of 251,929
 * with a fee of zero -- the fee was `undefined`, meaning the SDK could not price it, and a `?? 0n`
 * turned that into a pass. Measuring the real thing removes both the model and the excuse.
 */
const dir = mkdtempSync(join(tmpdir(), 'metered-fee-'));
const BUYER_SK = '11'.repeat(32);
const PROVIDER_SK = '22'.repeat(32);

function closeTx(sdk: Any, network: Network, outputs: bigint[]): Any {
  const networkId = new sdk.NetworkId(network);
  const buyer = new sdk.PrivateKey(BUYER_SK).toKeypair().toAddress(networkId).toString();
  const provider = new sdk.PrivateKey(PROVIDER_SK).toKeypair().toAddress(networkId).toString();
  const built = compileWithState(dir, {
    parties: 'cd'.repeat(32), sessionId: 'a1'.repeat(16), window: 2, seq: 3, sompi: 4_000_000,
  });
  const utxo = {
    address: buyer,
    outpoint: { transactionId: 'ab'.repeat(32), index: 0 },
    amount: FUNDED,
    scriptPublicKey: sdk.payToScriptHashScript(built.hex),
    blockDaaScore: 1n,
    isCoinbase: false,
  };
  const addrs = [provider, buyer];
  return buildExpire(
    sdk,
    {
      buyerPk: publicKeyHex(BUYER_SK), providerPk: publicKeyHex(PROVIDER_SK), signerSk: BUYER_SK,
      redeem: built.hex, tag: built.entries.expire?.dispatch_tag ?? '',
    },
    utxo,
    outputs.map((amount, i) => ({ address: addrs[i] ?? buyer, amount })),
    2,
  );
}

const SHAPES: { name: string; outputs: bigint[] }[] = [
  { name: 'two outputs (provider + buyer)', outputs: [4_000_000n, FUNDED - 4_000_000n - BigInt(CLOSE_FEE_SOMPI)] },
  { name: 'one output, folded', outputs: [FUNDED - BigInt(CLOSE_FEE_SOMPI)] },
];

/** KIP-9's consensus limit on storage mass, validated against a real rejection in dust-map.ts. */
const STORAGE_LIMIT = 500_000n;

/** Price every close shape on every network, and return the fees the SDK is willing to quote. */
function reportShapes(sdk: Any, networks: Network[]): bigint[] {
  console.log('\n  2. WHAT EACH CLOSE SHAPE COSTS');
  console.log(`     ${'shape'.padEnd(32)}${'network'.padEnd(13)}${'mass'.padStart(9)}${'fee'.padStart(11)}`);
  const fees: bigint[] = [];
  for (const shape of SHAPES) {
    for (const network of networks) {
      const tx = closeTx(sdk, network, shape.outputs);
      const mass = sdk.calculateTransactionMass(network, tx) as bigint;
      const priced = sdk.calculateTransactionFee(network, tx) as bigint | undefined;
      if (priced !== undefined) fees.push(priced);
      const shown = priced === undefined ? 'unpriced' : String(priced);
      console.log(`     ${shape.name.padEnd(32)}${network.padEnd(13)}${String(mass).padStart(9)}${shown.padStart(11)}`);
    }
  }
  console.log('     "unpriced" = above the 100,000 STANDARD-transaction policy, not above consensus.');
  return fees;
}

async function main(): Promise<void> {
  const sdk = await loadSdk();
  const networks: Network[] = ['mainnet', 'testnet-10'];

  console.log(`
  COVENANT FEE ALLOWANCE: ${CLOSE_FEE_SOMPI.toLocaleString()} sompi, compiled into the script
`);

  console.log('  1. DO THE TWO NETWORKS PRICE ALIKE?');
  const limits = networks.map((n) => String(sdk.maximumStandardTransactionMass(n)));
  for (const [i, n] of networks.entries()) {
    console.log(`     ${n.padEnd(12)} maximumStandardTransactionMass ${limits[i]}`);
  }
  const alike = new Set(limits).size === 1;
  console.log(`     ${alike ? 'IDENTICAL' : 'THEY DIFFER -- do not assume testnet measurements carry over'}`);

  const fees = reportShapes(sdk, networks);

  console.log('\n  3. WHERE EACH SHAPE SITS AGAINST THE KIP-9 CONSENSUS LIMIT');
  for (const shape of SHAPES) {
    // Numbers, not bigints: the signature says Array<number>, and bigints panic inside the WASM.
    const storage = sdk.calculateStorageMass(
      'mainnet', [Number(FUNDED)], shape.outputs.map(Number),
    ) as bigint | undefined;
    const ok = storage !== undefined && storage <= STORAGE_LIMIT;
    console.log(`     ${shape.name.padEnd(32)}storage mass ${String(storage).padStart(7)} / ${STORAGE_LIMIT}   ${ok ? 'legal' : 'REFUSED'}`);
  }

  const worst = fees.reduce((a, b) => (b > a ? b : a), 0n);
  const headroom = BigInt(CLOSE_FEE_SOMPI) - worst;
  console.log(`
  WORST PRICED FEE ${worst.toLocaleString()} sompi, allowance ${CLOSE_FEE_SOMPI.toLocaleString()}, headroom ${headroom.toLocaleString()}`);
  if (headroom < 0n) {
    console.log('\n  THE ALLOWANCE IS TOO SMALL. Do not deploy: closes would be unaffordable.\n');
    process.exit(1);
  }
  if (!alike) process.exit(1);
  console.log('  Both networks price identically, and the allowance covers the worst of them.\n');
}

main().catch((err: unknown) => {
  console.error(`
  ${err instanceof Error ? err.message : String(err)}
`);
  process.exit(1);
});
