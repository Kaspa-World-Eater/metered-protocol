/**
 * No document in this repo may cite a transaction by a truncated id. Copied from quorum after the
 * kaspanet/kccs#29 review; here it bit on docs/RAIL.md, HANDOFF.md and the phase notes (31 hits
 * on 2026-09-22, all from runs the public index no longer served) and passes on the current tree.
 * The same test runs in the published package, which ships fewer documents: it scans what is there.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { truncatedIds } from './pinned.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const under = (dir: string) => (existsSync(join(root, dir)) ? readdirSync(join(root, dir)).filter((f) => f.endsWith('.md')).map((f) => join(dir, f)) : []);
const docs = ['README.md', 'HANDOFF.md', 'PRIOR-ART.md', 'publish/README.md', ...under('docs'), ...under('spec')]
  .filter((d) => existsSync(join(root, d)));

test('a prefix plus an ellipsis is caught; a whole id and ordinary prose are not', () => {
  const full = 'a'.repeat(64);
  assert.deepEqual(truncatedIds('tx `81c3008f1fe5d79508105ada...` landed'), [{ line: 1, text: '81c3008f1fe5d79508105ada...' }]);
  assert.deepEqual(truncatedIds(`tx ${full} landed`), []);
  assert.deepEqual(truncatedIds('and so on... the deed 0xdeadbeef and 12345678 cost'), []);
  assert.equal(truncatedIds('one\ntwo deadbeefcafe…\nthree')[0]?.line, 2);
});

test('no document cites a transaction by a truncated id', () => {
  const found = docs.flatMap((d) => truncatedIds(readFileSync(join(root, d), 'utf8')).map((t) => `${d}:${t.line} ${t.text}`));
  assert.deepEqual(found, [], `truncated ids in docs:\n  ${found.join('\n  ')}`);
});
