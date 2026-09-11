/**
 * `npx tsx tools/sigscript-check.ts` -- prove the signature script can be built without the simulator.
 *
 * tools/sigscript.ts claims it knows how a SilverScript signature script is laid out. This is
 * where that claim is tested rather than believed: every case below is built BOTH ways -- once by
 * the patched cli-debugger that every live spend has used until now, and once in TypeScript from
 * nothing but the compiled artifact -- and the two byte strings must be identical.
 *
 * If they are, settlement stops requiring a patched debugger and starts requiring only the Kaspa
 * SDK, which is the difference between a protocol one machine can settle and a protocol anyone
 * can. If they are not, the description in sigscript.ts is wrong and belongs nowhere near money.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { partiesCommitment, publicKeyHex, signState } from '../src/encoding.js';
import { compileWithState } from './covenant.js';
import { preflightSigscript, withState, x, type Any } from './live-steps.js';
import { signatureScript, actionScript, encodeNumber, settleArgs, type Arg } from './sigscript.js';
import { loadSdk } from './kaspa.js';

const dir = mkdtempSync(join(tmpdir(), 'metered-sigscript-'));
const BUYER_SK = '11'.repeat(32);
const PROVIDER_SK = '22'.repeat(32);
const SESSION = 'a1'.repeat(16);
const PARTIES = partiesCommitment(publicKeyHex(BUYER_SK), publicKeyHex(PROVIDER_SK));
const WINDOW = 2;

interface Case {
  name: string;
  seq: number;
  units: number;
  sompi: number;
  prevState: string | null;
}

/** Deliberately spread across the number encoding's awkward places, not three happy cases. */
const CASES: Case[] = [
  { name: 'seq 0, the first claim', seq: 0, units: 550, sompi: 1996500, prevState: null },
  { name: 'a mid-session claim', seq: 3, units: 2199, sompi: 7982370, prevState: 'b2'.repeat(32) },
  { name: 'values that fill the sign bit', seq: 1, units: 128, sompi: 32768, prevState: 'cd'.repeat(32) },
  { name: 'a large sompi total', seq: 7, units: 1000000, sompi: 47600000, prevState: 'ef'.repeat(32) },
];

function argsFor(c: Case): Arg[] {
  const state = {
    v: 1, sessionId: SESSION, seq: c.seq, cumulativeUnits: c.units,
    cumulativeSompi: c.sompi, prevState: c.prevState,
  };
  return settleArgs(
    state, publicKeyHex(BUYER_SK), publicKeyHex(PROVIDER_SK),
    signState(state, BUYER_SK), signState(state, PROVIDER_SK),
  );
}

function numberVectors(): void {
  // The encoding these scripts hang on, checked against Kaspa script's own rules before anything
  // larger is compared. Zero is the empty push; 0x80 needs a byte added so the sign bit is free.
  const vectors: [number, string][] = [
    [0, ''], [1, '01'], [127, '7f'], [128, '8000'], [255, 'ff00'], [256, '0001'],
    [-1, '81'], [-127, 'ff'], [-128, '8080'], [32768, '008000'], [1996500, 'd4761e'],
  ];
  for (const [n, want] of vectors) {
    const got = Buffer.from(encodeNumber(n)).toString('hex');
    if (got !== want) throw new Error(`encodeNumber(${n}) = ${got}, expected ${want}`);
  }
  console.log(`  number encoding    ${vectors.length} vectors agree`);
}

async function main(): Promise<void> {
  numberVectors();
  const sdk = await loadSdk();

  let checked = 0;
  for (const c of CASES) {
    const ctor: Arg[] = [x(PARTIES), x(SESSION), WINDOW, -1, 0];
    const built = compileWithState(dir, {
      parties: PARTIES, sessionId: SESSION, window: WINDOW, seq: -1, sompi: 0,
    });
    const tag = built.entries.settle?.dispatch_tag;
    if (!tag) throw new Error('the compiled covenant has no `settle` entry');

    const args = argsFor(c);
    const outRedeem = withState(built.hex, c.seq, c.sompi);

    // THE REFERENCE: the patched debugger, which is what every live spend has used.
    const fromDebugger = preflightSigscript({
      name: `sigscript ${c.name}`,
      function: 'settle',
      constructor_args: ctor,
      args,
      expect: 'pass',
      tx: {
        active_input_index: 0,
        inputs: [{ utxo_value: 50_000_000, constructor_args: ctor }],
        outputs: [{
          value: 49_640_000, constructor_args: ctor,
          state: { pendingSeq: c.seq, pendingSompi: c.sompi },
        }],
      },
    } as unknown, dir);

    // THE CANDIDATE: built here, from the compiled artifact and nothing else. Compared as the
    // WHOLE script -- action half plus redeem -- because that is what gets broadcast; comparing
    // only the half this file constructs would leave the join untested.
    const redeem = new (sdk as Any).ScriptBuilder();
    redeem.addData(built.hex);
    const reference = fromDebugger + redeem.toString();
    const mine = signatureScript(sdk as Any, args, tag, built.hex);

    if (actionScript(sdk as Any, args, tag) !== fromDebugger) {
      console.log(`
  ACTION HALF MISMATCH on "${c.name}"`);
      process.exit(1);
    }
    if (mine !== reference) {
      console.log(`\n  MISMATCH on "${c.name}"`);
      console.log(`    debugger  ${reference.slice(0, 120)}...  (${reference.length / 2} bytes)`);
      console.log(`    built     ${mine.slice(0, 120)}...  (${mine.length / 2} bytes)`);
      process.exit(1);
    }
    console.log(`  ${c.name.padEnd(30)} ${mine.length / 2} bytes, identical`);
    checked += 1;
    void outRedeem;
  }

  console.log(`\n  ${checked} signature scripts built without the simulator, byte for byte.\n`);
}

main().catch((err: unknown) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
