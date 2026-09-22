/**
 * A live proof must outlive the explorer that indexed it.
 *
 * On 2026-09-22 every id from the 2026-09-11/12 rail runs returned 404 from api-tn10.kaspa.org:
 * the index had moved on, and a full 64-hex id that nobody can fetch is no more a pin than a
 * truncated one (kaspanet/kccs#29 review). The record written here is what a third party needs
 * WITHOUT an index: the reference transaction whose hash IS the id, and where and when it went.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proofFor, writeProof, explorerUrl } from './proof.js';

const TXID = '81c3008f1fe5d79508105ada9b0760f4de52651de8b38a5039f549aeffaf172d';
const TX = { version: 0, inputs: [{ previousOutpoint: { txid: 'aa'.repeat(32), index: 0 }, amount: '100000000' }], outputs: [], mass: '2000' };
const SUBMIT = { txid: TXID, network: 'testnet-10' as const, kind: 'batch-claim', transaction: TX, submittedAt: '2026-09-22T12:00:00.000Z', virtualDaaScore: 568_219_725n };

test('a proof carries the whole reference transaction, its id, and where it went', () => {
  const p = proofFor(SUBMIT);
  assert.equal(p.txid, TXID);
  assert.equal(p.network, 'testnet-10');
  assert.equal(p.kind, 'batch-claim');
  assert.deepEqual(p.transaction, TX);
  assert.equal(p.submittedAt, '2026-09-22T12:00:00.000Z');
  assert.equal(p.virtualDaaScore, '568219725');
  assert.equal(p.explorer, `https://explorer-tn10.kaspa.org/txs/${TXID}`);
});

test('the explorer link follows the network', () => {
  assert.equal(explorerUrl('testnet-10', TXID), `https://explorer-tn10.kaspa.org/txs/${TXID}`);
  assert.equal(explorerUrl('testnet-11', TXID), `https://explorer-tn11.kaspa.org/txs/${TXID}`);
  assert.equal(explorerUrl('mainnet', TXID), `https://explorer.kaspa.org/txs/${TXID}`);
});

test('a proof refuses an id that is not 64 lowercase hex: the truncated-id class dies at the source', () => {
  assert.throws(() => proofFor({ ...SUBMIT, txid: TXID.slice(0, 24) }), /64 hex/);
  assert.throws(() => proofFor({ ...SUBMIT, txid: TXID.toUpperCase() }), /64 hex/);
});

test('writeProof lands <dir>/<txid>.json, and it reads back as the proof', () => {
  const dir = mkdtempSync(join(tmpdir(), 'metered-proof-'));
  const p = proofFor(SUBMIT);
  const path = writeProof(dir, p);
  assert.equal(path, join(dir, `${TXID}.json`));
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), p);
});

test('writeProof creates the directory when it is missing', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'metered-proof-')), 'docs', 'proofs');
  const path = writeProof(dir, proofFor(SUBMIT));
  assert.ok(readFileSync(path, 'utf8').includes(TXID));
});
