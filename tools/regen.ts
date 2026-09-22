/**
 * Regenerated fixtures that moved only in their signatures go back to the tracked bytes.
 *
 * BIP340 signing is randomised, and the conformance vectors and both covenant suites are signed
 * with the protocol's own signers. So every `npm run check` rewrote all three with fresh
 * signatures and nothing else, and the tree sat dirty from 2026-09-12 to 09-22 with a diff that
 * said nothing. A gate that dirties its own tree teaches you to ignore a dirty tree.
 *
 * Signatures appear two ways: under a `sig`/`signature` key (the vectors) and as bare 0x-prefixed
 * hex strings in argument arrays (the covenant suites): 64 bytes for a `checkDataSig` signature,
 * 65 for a `checkSig` one that carries its sighash-type byte. A 32-byte digest or key is 64 hex
 * and is NOT blanked: a changed digest is a changed file.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SIGNATURE = /^(?:0x)?[0-9a-f]{128}(?:[0-9a-f]{2})?$/;
const isSignature = (key: string, value: unknown): boolean =>
  key === 'sig' || key === 'signature' || (typeof value === 'string' && SIGNATURE.test(value));

/** Everything a generated JSON file determines, with the randomised signatures blanked out. */
export function stable(json: string): string {
  return JSON.stringify(JSON.parse(json, (key, value: unknown) => (isSignature(key, value) ? '<randomised>' : value)));
}

/**
 * After a generator has rewritten `path`: if it is `before` up to signatures, write `before`
 * back and return true. A real change stays on disk, and returns false.
 */
export function restoreUnlessChanged(path: string, before: string): boolean {
  const same = stable(before) === stable(readFileSync(path, 'utf8'));
  if (same) writeFileSync(path, before);
  return same;
}
