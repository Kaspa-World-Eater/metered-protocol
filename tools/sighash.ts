/**
 * The signing harness for covenant entries that use `checkSig`.
 *
 * `checkMsgSig` verifies a signature over supplied data, so `settle` can be signed offline -- the
 * message is just the settlement digest. `checkSig` verifies a signature over the SPENDING
 * TRANSACTION, and the sighash depends on the whole transaction the simulator builds: outpoints,
 * amounts, script pubkeys, sequences, sigop counts. There is no way to compute it from outside
 * without reimplementing Kaspa's consensus hashing and matching the simulator byte for byte.
 *
 * So we ask it. `SILVERSCRIPT_PRINT_SIGHASH=1` makes the debugger print the sighash it computed,
 * we sign that, and write the signature back into the test case. Two passes, no reimplementation.
 *
 * WHY THIS IS NOT CIRCULAR. Kaspa's sighash covers the UTXO's script pubkey, not the spending
 * input's signature script -- the signature is not an input to the hash that the signature signs.
 * So a placeholder signature in pass one yields exactly the sighash that the real signature in
 * pass two must cover. If that ever stops being true, every expire test breaks loudly rather than
 * silently, because the VM verifies for real.
 *
 * THE DEBUGGER IS PATCHED LOCALLY to print it, in the v1.0.0 worktree under ~/.metered/. That
 * patch is four lines behind an environment variable and is NOT upstream; a fresh checkout will
 * not have it. `npm run contracts:gen` says so if the sighash never appears.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

/** Kaspa's SIG_HASH_ALL. A `sig` is 64 schnorr bytes plus this one type byte -- 65 in total. */
const SIG_HASH_ALL = 0x01;

export const DEBUGGER =
  process.env.SILVERSCRIPT_DEBUGGER ??
  join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.metered', 'silverscript-v1', 'target', 'release', 'cli-debugger.exe');

/**
 * Run one test case and return the sighash the VM computed for the active input. The case is
 * expected to FAIL at the signature check -- that is fine and expected, we only want the hash.
 */
export function sighashFor(contractPath: string, testCase: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'metered-sighash-'));
  const file = join(dir, 'one.tests.json');
  const name = (testCase as { name: string }).name;
  writeFileSync(file, JSON.stringify({ tests: [testCase] }));

  // `--run`, not `--run-all`: run-all re-spawns itself per case and swallows the child's stderr
  // when the case passes, which is exactly when we still need the hash.
  const run = spawnSync(DEBUGGER, [contractPath, '--run', '--test-file', file, '--test-name', name], {
    encoding: 'utf8',
    env: { ...process.env, SILVERSCRIPT_PRINT_SIGHASH: '1' },
  });
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const found = out.match(/SIGHASH ([0-9a-f]{64})/);
  if (!found) {
    throw new Error(
      'the debugger printed no sighash.\n\n' +
        `  tried: ${DEBUGGER}\n\n` +
        'That binary must be built from the v1.0.0 worktree WITH the local sighash patch\n' +
        '(four lines in debugger/cli/src/main.rs, behind SILVERSCRIPT_PRINT_SIGHASH).\n' +
        'A stock silverscript checkout will not print it. See tools/sighash.ts.\n\n' +
        `${out.split('\n').slice(-6).join('\n')}`,
    );
  }
  return found[1] as string;
}

/** BIP340 over the sighash, plus the type byte -- the 65 bytes a Kaspa `sig` parameter wants. */
export function signSighash(sighashHex: string, privateKeyHex: string): string {
  const raw = schnorr.sign(hexToBytes(sighashHex), hexToBytes(privateKeyHex));
  const withType = new Uint8Array(65);
  withType.set(raw, 0);
  withType[64] = SIG_HASH_ALL;
  return bytesToHex(withType);
}
