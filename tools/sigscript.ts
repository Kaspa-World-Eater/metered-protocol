/**
 * Build a covenant signature script WITHOUT the simulator.
 *
 * THIS FILE EXISTS BECAUSE SETTLEMENT WAS UNDEPLOYABLE. Every live spend this project has ever
 * made obtained its signature script by running the SilverScript cli-debugger and reading the
 * bytes it printed -- behind an environment variable added by a LOCAL, un-upstreamed patch. That
 * worked, and it meant a metered session could be settled on exactly one machine in the world.
 * A protocol whose enforcement half needs a patched debugger is not adoptable, however carefully
 * the rest of it is specified.
 *
 * A SilverScript signature script is not mysterious, which is what makes this fixable. It is:
 *
 *     <arg_0> <arg_1> ... <arg_n> <dispatch_tag> <redeem_script>
 *
 * -- the entry's arguments pushed in DECLARATION order, then the tag that selects the entry, then
 * the redeem script itself. The debugger's `combine_action_and_redeem` does the same thing; it was
 * simply the only thing doing it.
 *
 * The order was established by comparison, not by reading: the first attempt pushed the arguments
 * reversed, on the reasoning that the first one should end up on top of the stack. It produced a
 * script of exactly the right length and entirely the wrong bytes, which is a good argument for
 * checking against the reference rather than against one's own reasoning.
 *
 * Nothing here is trusted on the strength of that description. tools/sigscript-check.ts builds
 * every case both ways and compares the bytes, and the two must agree exactly.
 */
import type { Any } from './live-steps.js';

/** A covenant argument: a hex blob (`0x...`) or a whole number. */
export type Arg = string | number;

export class UnencodableArg extends Error {}

/**
 * SilverScript numbers are minimally-encoded, little-endian, sign-and-magnitude -- Kaspa script's
 * own number encoding, not two's complement. Zero is the EMPTY push, which is why it cannot be
 * written as a single 0x00 byte.
 */
export function encodeNumber(n: number): Uint8Array {
  if (!Number.isSafeInteger(n)) throw new UnencodableArg(`${n} is not a whole number`);
  if (n === 0) return new Uint8Array(0);

  const negative = n < 0;
  let value = Math.abs(n);
  const out: number[] = [];
  while (value > 0) {
    out.push(value & 0xff);
    value = Math.floor(value / 256);
  }
  // The top bit doubles as the sign, so a value that already fills it needs one more byte to
  // carry the sign without changing the magnitude.
  const top = out[out.length - 1] as number;
  if (top & 0x80) out.push(negative ? 0x80 : 0x00);
  else if (negative) out[out.length - 1] = top | 0x80;
  return Uint8Array.from(out);
}

const hexToBytes = (hex: string): Uint8Array => {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new UnencodableArg(`not hex: ${hex}`);
  return Uint8Array.from(clean.match(/../g)?.map((b) => parseInt(b, 16)) ?? []);
};

const asBytes = (arg: Arg): Uint8Array =>
  (typeof arg === 'number' ? encodeNumber(arg) : hexToBytes(arg));

/**
 * The ACTION half: arguments then dispatch tag, with no redeem script appended.
 *
 * Kept separate from the redeem half because the caller appends that itself -- the redeem bytes
 * must physically be present in the input's own signature script, since `validateOutputState`
 * rebuilds the continuation out of them.
 */
export function actionScript(sdk: Any, args: Arg[], dispatchTag: string): string {
  const builder = new sdk.ScriptBuilder();
  for (const arg of args) builder.addData(asBytes(arg));
  builder.addData(hexToBytes(dispatchTag));
  return builder.toString();
}

/**
 * The arguments the covenant's `settle` entry takes, in the order it declares them.
 *
 * ONE DEFINITION, because the order is load-bearing and there were three copies of it -- the test
 * generator, the demo and the cross-check each built this list by hand. Three lists that must
 * agree and are maintained separately are three chances to find out on chain.
 */
export function settleArgs(
  state: { seq: number; cumulativeUnits: number; cumulativeSompi: number; prevState: string | null },
  buyerPubkey: string, providerPubkey: string, buyerSig: string, providerSig: string,
): Arg[] {
  return [
    `0x${buyerPubkey}`, `0x${providerPubkey}`, `0x${buyerSig}`, `0x${providerSig}`,
    state.seq, state.cumulativeUnits, state.cumulativeSompi,
    `0x${state.prevState ?? '00'.repeat(32)}`,
  ];
}

/** The whole signature script: the action half, then the redeem script it runs against. */
export function signatureScript(sdk: Any, args: Arg[], dispatchTag: string, redeemHex: string): string {
  const redeem = new sdk.ScriptBuilder();
  redeem.addData(hexToBytes(redeemHex));
  return actionScript(sdk, args, dispatchTag) + redeem.toString();
}
