/**
 * `npm run contracts` -- execute the covenant against its simulator suite.
 *
 * NOT part of `npm run check`, deliberately, and for two reasons rather than the usual one. It
 * needs the SilverScript debugger, a Rust binary from a separate checkout; and that binary must
 * carry the local sighash patch described in tools/sighash.ts, without which `expire` cannot be
 * executed at all. Wiring either requirement into the main gate would break `check` for anyone
 * who has not built them. It fails with instructions instead of a stack trace.
 *
 * REGENERATE AFTER EVERY CONTRACT EDIT. The expire signatures cover the spending transaction,
 * which commits to the covenant's own script -- so changing one line of the contract invalidates
 * every expire signature in the suite. A stale suite fails loudly rather than passing wrongly,
 * but it fails in a way that looks like a contract bug and is not. `npm run contracts` regenerates
 * first for exactly this reason.
 */
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { DEBUGGER } from './sighash.js';
import { profileFromArgv } from './covenant-profile.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** argentc, outside the repository like every other toolchain binary here. */
const ARGENTC = process.env.METERED_ARGENTC
  ?? join(homedir(), '.metered', 'argent', 'target', 'release', 'argentc.exe');

// `npm run contracts -- --profile ag` executes the Argent port instead. Both covenants run the
// SAME cases from the same generator: see tools/covenant-profile.ts for why that is not optional.
const PROFILE = profileFromArgv();

if (!existsSync(DEBUGGER)) {
  console.error(
    `SilverScript debugger not found at ${DEBUGGER}\n\n` +
      '  git clone https://github.com/kaspanet/silverscript && cd silverscript && git checkout v1.0.0\n' +
      '  cargo build --release -p cli-debugger\n\n' +
      'Then apply the sighash patch (see tools/sighash.ts) and set SILVERSCRIPT_DEBUGGER.',
  );
  process.exit(1);
}

// REBUILD FIRST WHEN THE CONTRACT IS GENERATED. Editing contracts/metered.ag without re-running
// argentc leaves this suite executing the PREVIOUS bytecode, which passes and proves nothing about
// the source anyone is reading. Caught exactly that way on 2026-09-10 while changing a constant.

/** argentc's output belongs beside the source it was built from, not beside the caller. */
const AG_BUILD_DIR = fileURLToPath(new URL('../build/ag', import.meta.url));

if (PROFILE.source) {
  const built = spawnSync(ARGENTC, ['build', PROFILE.source, '--out', AG_BUILD_DIR], { encoding: 'utf8' });
  if (built.status !== 0) {
    process.stderr.write(built.stderr ?? `argentc not found at ${ARGENTC}
`);
    process.exit(1);
  }
}

const gen = spawnSync('npx', ['tsx', 'tools/gen-contract-tests.ts', '--profile', PROFILE.key], { encoding: 'utf8', shell: true });
process.stdout.write(gen.stdout ?? '');
if (gen.status !== 0) {
  process.stderr.write(gen.stderr ?? '');
  process.exit(1);
}

if (!existsSync(PROFILE.contract)) {
  console.error(
    [
      `contract not found at ${PROFILE.contract}`,
      '',
      '  the Argent profile executes argentc OUTPUT, so build it first:',
      '  ~/.metered/argent/target/release/argentc build contracts/metered.ag --out build/ag',
    ].join('\n'),
  );
  process.exit(1);
}

const run = spawnSync(DEBUGGER, [PROFILE.contract, '--test-file', PROFILE.suite, '--run-all'], { encoding: 'utf8' });
process.stdout.write(run.stdout ?? '');
process.stderr.write(run.stderr ?? '');
process.exit(run.status ?? 1);
