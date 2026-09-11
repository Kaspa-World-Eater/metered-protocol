/**
 * The pieces every live covenant run needs, in one place so the scripts cannot drift apart.
 *
 * THE SIMULATOR IS THE PRE-FLIGHT. A spend expected to succeed is run through cli-debugger against
 * the exact constructor arguments, state and transaction shape it will use on chain, and is only
 * broadcast if that passes. The debugger also emits the authoritative signature script, so nothing
 * here reimplements SilverScript's argument encoding and then hopes it matches.
 *
 * A spend expected to FAIL is pre-flighted too, with expect: 'fail' -- so the simulator confirms
 * the contract refuses it before consensus is asked to. If the two ever disagree, that is the
 * finding, and it is worth the extra call to notice.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEBUGGER } from './sighash.js';
import { HAND_WRITTEN } from './covenant-profile.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Any = any;

export const x = (hex: string) => `0x${hex}`;

/**
 * Splice new state into a compiled redeem script.
 *
 * MEASURED, NOT ASSUMED, and measured again for the Argent port. `tools/state-layout.ts` compiles
 * each covenant twice with different state and diffs the bytes:
 *
 *   hand-written  span [1, 19)   `08 <seq LE8> 08 <sompi LE8>`
 *   Argent        span [1, 78)   `20 <parties 32> 10 <session_id 16> 08 <window> 08 <seq> 08 <sompi>`
 *
 * The claim these share is not the offset -- it is that **the mutable pair sits at the END of the
 * state span in both**, because both declare `pendingSeq`/`pendingSompi` last. So the splice is
 * anchored to the span's end rather than its start, and one function serves both covenants
 * instead of a second one drifting alongside it.
 *
 * `spanEnd` is `span.offset + span.len` from the artifact, which is a claim the compiler makes;
 * `verifySplice` below checks it against a real compile rather than trusting it.
 */
const SEQ_AND_SOMPI = 18;

export function withState(redeemHex: string, seq: number, sompi: number, spanEnd = 19): string {
  const num = (v: number) => {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt(Math.abs(v)));
    if (v < 0) b[7] = (b[7] as number) | 0x80;
    return b.toString('hex');
  };
  const cut = (spanEnd - SEQ_AND_SOMPI) * 2;
  return `${redeemHex.slice(0, cut)}08${num(seq)}08${num(sompi)}${redeemHex.slice(spanEnd * 2)}`;
}

/**
 * Run one scenario through the simulator and return the signature script it built.
 *
 * The returned script is the ACTION half only -- arguments and dispatch tag, 242 bytes for
 * `settle`. The 513-byte redeem script is appended separately by the caller, mirroring the
 * debugger's own `combine_action_and_redeem`.
 *
 * That detail is not cosmetic and cost a live transaction to learn. `validateOutputState`
 * reconstructs the continuation script out of the INPUT'S OWN signature script
 * (`OpTxInputScriptSigSubstr`, offset by `this.bytecodeSize`), so the redeem bytes must
 * physically be in there. Broadcasting the action alone gives it nothing to rebuild from, and the
 * node reports only "false stack entry at end of script execution".
 */
export function preflightSigscript(testCase: unknown, dir: string, expectPass = true, contract = HAND_WRITTEN.contract): string {
  const file = join(dir, 'preflight.tests.json');
  writeFileSync(file, JSON.stringify({ tests: [testCase] }));
  const name = (testCase as { name: string }).name;
  // spawnSync, not execFileSync: the dump goes to STDERR, and execFileSync returns only stdout.
  const run = spawnSync(DEBUGGER, [contract, '--run', '--test-file', file, '--test-name', name], {
    encoding: 'utf8',
    env: { ...process.env, SILVERSCRIPT_PRINT_SIGSCRIPT: '1' },
  });
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if (run.status !== 0) {
    console.log(out.split('\n').slice(-20).join('\n'));
    throw new Error(
      expectPass
        ? 'PRE-FLIGHT FAILED -- refusing to broadcast a spend the simulator rejects'
        : 'PRE-FLIGHT of the negative case did not behave as expected',
    );
  }
  const sigscript = out.match(/SIGSCRIPT ([0-9a-f]+)/);
  if (!sigscript) throw new Error('the debugger printed no signature script (is the local patch built?)');
  return sigscript[1] as string;
}

/** Poll until a UTXO of exactly this value appears at an address, or give up. */
export async function awaitUtxo(rpc: Any, address: string, amount: bigint): Promise<Any> {
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    const res = await rpc.getUtxosByAddresses([address]);
    const hit = res.entries.find((e: Any) => e.amount === amount);
    if (hit) return hit;
  }
  return null;
}

/**
 * Build an `expire` spend. This is the path where the money actually SPLITS -- the provider takes
 * the pending claim and the buyer takes the remainder -- so it is the one branch where getting an
 * output value wrong costs somebody real funds.
 *
 * The fee is the covenant's full allowance. `expire` evaluates checkSig(buyer) || checkSig(provider)
 * -- two signature checks, so compute budget 21 -- and a two-output close carries a ~650-byte
 * signature script on top of that. The contract requires
 * `outputs[1].value + pendingSompi + 400000 >= total`, so paying exactly 400,000 satisfies it at
 * equality and leaves the node the most fee this covenant can legally offer.
 */
export function buildExpire(
  sdk: Any,
  parts: { buyerPk: string; providerPk: string; signerSk: string; redeem: string; tag: string },
  utxo: Any,
  outputs: { address: string; amount: bigint }[],
  window: number,
): Any {
  const tx = sdk.createTransaction([utxo], outputs, 0n, undefined, 0);
  tx.version = 1;
  tx.gas = 0n;
  tx.inputs[0].sigOpCount = 0;
  tx.inputs[0].computeBudget = 21;
  tx.inputs[0].sequence = BigInt(window);

  // createInputSignature returns a signature SCRIPT; strip the 0x41 push to get the bare 65 bytes.
  const raw = sdk.createInputSignature(tx, 0, new sdk.PrivateKey(parts.signerSk));
  const sig = raw.length === 132 && raw.startsWith('41') ? raw.slice(2) : raw;

  const sb = new sdk.ScriptBuilder();
  sb.addData(parts.buyerPk);
  sb.addData(parts.providerPk);
  sb.addData(sig);
  sb.addData(parts.tag);
  sb.addData(parts.redeem);
  tx.inputs[0].signatureScript = sb.toString();
  tx.finalize();
  return tx;
}

/** Wait for the DAG to advance past a relative window, so `this.ageDaa` can be satisfied. */
export async function awaitWindow(rpc: Any, window: number): Promise<void> {
  const start = (await rpc.getBlockDagInfo()).virtualDaaScore;
  while ((await rpc.getBlockDagInfo()).virtualDaaScore < start + BigInt(window) + 2n) {
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * The KIP-9 dust floor, and the fee allowance that must be added to it when folding.
 *
 * An output below ~2,000,835 sompi cannot be created at all (SPEC.md 7.4a), so a close has three
 * legal shapes rather than one, and picking the wrong one is refused by the covenant.
 */
export const DUST = 2_000_000n;

/**
 * Choose the outputs a close must have. This is protocol knowledge, not a convenience: the
 * covenant accepts exactly these shapes and nothing else, so a caller that guesses gets
 * "script ran, but verification failed" and learns nothing about why.
 *
 *   provider's share is dust  -> one output, everything to the BUYER
 *   buyer's refund is dust    -> one output, everything to the PROVIDER
 *   both are payable          -> two outputs, the ordinary close
 */
export function closeOutputs(
  total: bigint, owed: bigint, fee: bigint, buyer: string, provider: string,
): { address: string; amount: bigint }[] {
  if (owed < DUST) return [{ address: buyer, amount: total - fee }];
  const refund = total - owed - fee;
  if (refund < DUST) return [{ address: provider, amount: owed }];
  return [{ address: provider, amount: owed }, { address: buyer, amount: refund }];
}
