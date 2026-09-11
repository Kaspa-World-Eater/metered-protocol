/**
 * Map every legal close, and find the claims that have none.
 *
 * SPEC.md 7.4a names three close shapes and gates them on the constant 2,000,000. That constant is
 * the ASYMPTOTIC KIP-9 floor -- the value an output approaches when everything else in the
 * transaction is large. The real floor is not a constant: storage mass prices an output by its
 * reciprocal and subtracts the input's, so what is payable depends on the other output and on how
 * much the covenant holds.
 *
 * So this does not argue about it. For a covenant balance it walks every pendingSompi and asks the
 * node's own formula which of the three shapes, if any, consensus would accept. A claim with no
 * accepted shape is a session whose funds cannot move.
 *
 *     mass = 10^12/out_1 + 10^12/out_2 - 10^12/in   and a transaction is refused above 500,000
 */
const LIMIT = 500_000;
const RECIP = 1_000_000_000_000;
const FEE = 400_000;
const DUST = Number(process.env.METERED_DUST ?? 2_000_000);
const FOLD = DUST + FEE;

const massOf = (outs: number[], input: number): number =>
  outs.reduce((m, o) => m + Math.floor(RECIP / o), 0) - Math.floor(RECIP / input);

/** What the covenant would DEMAND for this claim, following contracts/metered_session.sil. */
function demandedShape(pending: number, total: number): { outs: number[]; name: string } {
  if (pending < DUST) return { outs: [total - FEE], name: 'fold-to-buyer' };
  if (pending + FOLD >= total) return { outs: [pending], name: 'fold-to-provider' };
  return { outs: [pending, total - pending - FEE], name: 'two-output' };
}

function scan(total: number): { gaps: [number, number][]; checked: number } {
  const gaps: [number, number][] = [];
  let open: number | null = null;
  let checked = 0;
  // Step finely near the dust boundary, coarsely elsewhere: that is where the edges live.
  for (let pending = 0; pending <= total; pending += pending > 1_900_000 && pending < 3_000_000 ? 1 : 1_009) {
    checked += 1;
    const { outs } = demandedShape(pending, total);
    const legal = outs.every((o) => o > 0) && massOf(outs, total) <= LIMIT;
    if (!legal && open === null) open = pending;
    if (legal && open !== null) {
      gaps.push([open, pending - 1]);
      open = null;
    }
  }
  if (open !== null) gaps.push([open, total]);
  return { gaps, checked };
}

const balances = (process.env.METERED_BALANCES ?? '50000000,20000000,10000000,5000000,100000000')
  .split(',').map(Number);
console.log('\n  KIP-9 CLOSE FEASIBILITY -- claims with no legal close shape\n');
console.log(`  ${'covenant'.padStart(12)}  ${'checked'.padStart(9)}  unclosable range of pendingSompi`);
for (const total of balances) {
  const { gaps, checked } = scan(total);
  const shown = gaps.length === 0
    ? 'none'
    : gaps.map(([a, b]) => `${a.toLocaleString()}..${b.toLocaleString()}`).join(', ');
  console.log(`  ${total.toLocaleString().padStart(12)}  ${String(checked).padStart(9)}  ${shown}`);
}
console.log('');
