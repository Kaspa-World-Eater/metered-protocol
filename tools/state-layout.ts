/**
 * Where does contract state actually live in the bytecode?
 *
 * `settle` hands the funds back to the SAME covenant with `(pendingSeq, pendingSompi)` updated,
 * so a real spend has to derive the OUTPUT address -- which means knowing exactly which bytes
 * change and how they are encoded. The artifact reports a `state_span`, but a span is a claim.
 * This compiles the contract twice with different state and diffs the result, which is the same
 * measure-do-not-reason discipline every parameter in SPEC.md 0.1 came from.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SILVERC, compileWithState } from './covenant.js';
import { profileFromArgv } from './covenant-profile.js';
import { withState } from './live-steps.js';

// `npm run state-layout -- --profile ag` measures the Argent port instead. Its span is larger
// because Argent has no per-instance immutable parameter: parties, session_id and window are
// state there, so a continuation re-emits all five fields rather than two.
const PROFILE = profileFromArgv();

const dir = mkdtempSync(join(tmpdir(), 'metered-layout-'));

function bytecodeFor(seq: number, sompi: number): { hex: string; span: { offset: number; len: number } } {
  const out = compileWithState(dir, { parties: '11'.repeat(32), sessionId: '22'.repeat(16), window: 10, seq, sompi }, PROFILE.contract);
  return out;
}

const a = bytecodeFor(-1, 0);
const b = bytecodeFor(7, 123456);

console.log(`profile      ${PROFILE.key}  ${PROFILE.contract}`);
console.log(`silverc      ${SILVERC}`);
console.log(`length       ${a.hex.length / 2} vs ${b.hex.length / 2} bytes`);
console.log(`state_span   offset ${a.span.offset}, len ${a.span.len}`);
console.log('\ndiffering bytes:');
for (let i = 0; i < Math.min(a.hex.length, b.hex.length); i += 2) {
  const x = a.hex.slice(i, i + 2);
  const y = b.hex.slice(i, i + 2);
  if (x !== y) console.log(`  byte ${String(i / 2).padStart(4)}   ${x} -> ${y}`);
}
console.log(`\nspan bytes A  ${a.hex.slice(a.span.offset * 2, (a.span.offset + a.span.len) * 2)}`);
console.log(`span bytes B  ${b.hex.slice(b.span.offset * 2, (b.span.offset + b.span.len) * 2)}`);
console.log(`\nhead A        ${a.hex.slice(0, 48)}`);
console.log(`head B        ${b.hex.slice(0, 48)}`);

// THE SPAN IS A CLAIM THE COMPILER MAKES. This is the check that it is true: splice B's state
// into A by hand and demand the result equal a real compile of B, byte for byte. If the layout
// were anything but "the mutable pair sits at the END of the span", it fails here rather than on
// chain, where the symptom is a session nobody can spend.
const spliced = withState(a.hex, 7, 123456, a.span.offset + a.span.len);
console.log(`\nsplice check  ${spliced === b.hex ? 'IDENTICAL to a real compile' : 'DIFFERS from a real compile'}`);
if (spliced !== b.hex) {
  console.log(`  spliced     ${spliced}`);
  console.log(`  compiled    ${b.hex}`);
  process.exit(1);
}

void execFileSync;
void writeFileSync;
void readFileSync;
