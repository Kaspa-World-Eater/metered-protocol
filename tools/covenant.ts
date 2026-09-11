/**
 * Compiling the covenant with real constructor arguments, and deriving its address.
 *
 * kaspa-depin compiles once with placeholders and swaps hex at runtime, because its SDK consumers
 * must not need a Rust toolchain. This project already requires `silverc` for `npm run contracts`,
 * so it compiles with the real values instead -- no placeholder table to keep in step with the
 * contract, and no chance of a swap count silently going stale when a constant gains a use site.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadSdk, type Network } from './kaspa.js';
import { HAND_WRITTEN } from './covenant-profile.js';

export const SILVERC = process.env.METERED_SILVERC ?? join(homedir(), '.metered', 'bin', 'silverc.exe');

export interface CovenantState {
  parties: string;
  sessionId: string;
  window: number;
  seq: number;
  sompi: number;
}

export interface Compiled {
  hex: string;
  span: { offset: number; len: number };
  entries: Record<string, { dispatch_tag: string }>;
}

/**
 * Compile with the given constructor arguments and return the redeem script.
 *
 * `contract` selects which covenant: the hand-written SilverScript, or argentc's generated
 * output. Both take the SAME five constructor arguments in the same order, which is why one
 * function serves both -- see tools/covenant-profile.ts.
 */
export function compileWithState(dir: string, state: CovenantState, contractPath = HAND_WRITTEN.contract): Compiled {
  if (!existsSync(SILVERC)) {
    throw new Error(`silverc not found at ${SILVERC}; set METERED_SILVERC`);
  }
  const bytes = (hex: string) => ({ kind: 'bytes', value: Array.from(Buffer.from(hex, 'hex')) });
  const ctorPath = join(dir, `ctor-${state.seq}-${state.sompi}.json`);
  const outPath = join(dir, `art-${state.seq}-${state.sompi}.json`);
  writeFileSync(
    ctorPath,
    JSON.stringify([
      bytes(state.parties),
      bytes(state.sessionId),
      { kind: 'int', value: state.window },
      { kind: 'int', value: state.seq },
      { kind: 'int', value: state.sompi },
    ]),
  );
  execFileSync(SILVERC, [contractPath, '--constructor-args', ctorPath, '-o', outPath], { stdio: 'pipe' });

  const artifact = JSON.parse(readFileSync(outPath, 'utf8')) as {
    contracts: Record<string, { compiled: { bytecode: number[]; state_span: { offset: number; len: number } }; entries: Record<string, { dispatch_tag: string }> }>;
  };
  const contract = artifact.contracts.MeteredSession;
  if (!contract) throw new Error('artifact has no MeteredSession contract');
  return {
    hex: Buffer.from(contract.compiled.bytecode).toString('hex'),
    span: contract.compiled.state_span,
    entries: contract.entries,
  };
}

/** The P2SH address a redeem script locks to -- where the session's funds actually sit. */
export async function covenantAddress(redeemHex: string, network: Network): Promise<string> {
  const sdk = await loadSdk();
  const spk = sdk.payToScriptHashScript(redeemHex);
  return sdk.addressFromScriptPublicKey(spk, new sdk.NetworkId(network)).toString();
}
