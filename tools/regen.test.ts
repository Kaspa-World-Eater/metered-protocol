/**
 * `npm run check` regenerates three signed fixture files, and BIP340 signing is randomised: every
 * run rewrote them with fresh signatures and nothing else, and the tree was dirty for ten days
 * (2026-09-12 to 09-22) with a diff that meant nothing. A gate that dirties its own tree teaches
 * you to ignore a dirty tree. These are the two rules that stop it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stable, restoreUnlessChanged } from './regen.js';

const SIG_A = 'a'.repeat(128);
const SIG_B = 'b'.repeat(128);
const keyed = (sig: string, amount = 5) => JSON.stringify({ amount, sig, nested: [{ signature: sig }] });
const bare = (sig: string, amount = 5) => JSON.stringify({ args: [String(amount), `0x${sig}`, 'c'.repeat(64)] });

test('two files that differ only in signatures are the same file, keyed or bare', () => {
  assert.equal(stable(keyed(SIG_A)), stable(keyed(SIG_B)));
  assert.equal(stable(bare(SIG_A)), stable(bare(SIG_B)));
});

test('a checkSig signature carries its sighash-type byte: 65 bytes is still a signature', () => {
  assert.equal(stable(bare(`${SIG_A}01`)), stable(bare(`${SIG_B}01`)));
});

test('a changed amount is a changed file; a 64-hex digest is not a signature', () => {
  assert.notEqual(stable(keyed(SIG_A, 5)), stable(keyed(SIG_A, 6)));
  assert.notEqual(stable(bare(SIG_A, 5)), stable(bare(SIG_A, 6)));
  assert.notEqual(stable(JSON.stringify({ d: 'c'.repeat(64) })), stable(JSON.stringify({ d: 'd'.repeat(64) })));
});

test('an equivalent regeneration puts the tracked bytes back and says so', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'metered-regen-')), 'v.json');
  writeFileSync(path, bare(SIG_B));
  assert.equal(restoreUnlessChanged(path, bare(SIG_A)), true);
  assert.equal(readFileSync(path, 'utf8'), bare(SIG_A));
});

test('a real change is left in place and reported', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'metered-regen-')), 'v.json');
  writeFileSync(path, bare(SIG_B, 6));
  assert.equal(restoreUnlessChanged(path, bare(SIG_A, 5)), false);
  assert.equal(readFileSync(path, 'utf8'), bare(SIG_B, 6));
});
