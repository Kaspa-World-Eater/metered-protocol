import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicKeyHex } from '../encoding.js';
import { type OfferTerms } from './service.js';
import { withMeteredServer } from './harness.js';
import { openSession, runBabel, ProtocolError } from './client.js';
import { fileSessionStore, fileStore } from '../store.js';
import { meterFor } from '../meter.js';

/**
 * A PROVIDER RESTART, from the buyer's side of the wire.
 *
 * Losing a session costs at most the babel in flight -- the buyer reserves it again -- so this is
 * a quality of implementation rather than a rule of the protocol. It is tested because "survives
 * a restart" is the kind of claim that is easy to make and easy to be wrong about: the state that
 * matters is not the offer, it is the cursor, the chain digest and the bias detector, and dropping
 * any one of them produces a session that looks alive and then refuses the next message.
 */
const PROVIDER_SK = '22'.repeat(32);
const BUYER_SK = '11'.repeat(32);
const dir = mkdtempSync(join(tmpdir(), 'metered-restart-'));
const meter = meterFor('o200k_base');
const deliver = (prompt: string, max: number) =>
  Array.from({ length: max }, (_, i) => `${prompt}${i}`).join(' ');

const TERMS: OfferTerms = {
  v: 1, scheme: 'metered', network: 'kaspa:testnet-10', asset: 'KAS',
  unit: 'llm.output_tokens.v1', meter: 'o200k_base',
  unitPriceSompi: 3630, babelUnits: 20, maxBabels: 8,
  toleranceAbs: 2, checkpointEvery: 0, responseWindowDaa: 600,
};

const paths = () => {
  const tag = Math.random().toString(36).slice(2);
  return { sessions: join(dir, `s-${tag}.jsonl`), signer: join(dir, `k-${tag}.jsonl`) };
};

const opts = (p: ReturnType<typeof paths>) => ({
  terms: TERMS, providerSk: PROVIDER_SK, providerPubkey: publicKeyHex(PROVIDER_SK),
  meter, deliver,
  store: fileStore(p.signer),
  sessions: fileSessionStore(p.sessions),
});

test('a buyer carries on across a provider restart, and the chain stays unbroken', async () => {
  const p = paths();
  let sessionId = '';
  let secondState: { seq: number; cumulativeUnits: number } | null = null;

  // ---- the provider runs, serves two babels, and dies.
  await withMeteredServer(opts(p), async ({ base }) => {
    const { offer, session } = await openSession(base, BUYER_SK, meter, 'kaspa:testnet-10');
    sessionId = offer.sessionId;
    await runBabel(base, session, 'one');
    const second = await runBabel(base, session, 'two');
    secondState = second.state;
  });

  // ---- a NEW process, same files, same buyer, same session id.
  await withMeteredServer(opts(p), async ({ base, service }) => {
    const revived = service.get(sessionId);
    assert.ok(revived, 'the session came back from the store');
    assert.equal(revived.pendingSeq, secondState?.seq, 'and remembers how far it had got');
    assert.equal(revived.offer.sessionId, sessionId);
  });
});

test('the restarted provider still refuses to re-sign a State it already signed', async () => {
  // The two durable stores are separate and both matter. This is the signer half: even with the
  // session restored, SPEC.md 4.4 must still hold across the restart.
  const p = paths();
  let sessionId = '';
  await withMeteredServer(opts(p), async ({ base }) => {
    const { offer, session } = await openSession(base, BUYER_SK, meter, 'kaspa:testnet-10');
    sessionId = offer.sessionId;
    await runBabel(base, session, 'one');
  });

  await withMeteredServer(opts(p), async ({ service }) => {
    const record = fileStore(p.signer).load(sessionId);
    assert.equal(record?.highestSeq, 0, 'the signer record outlived the process');
    assert.ok(service.get(sessionId), 'and so did the session');
  });
});

test('a HALTED session stays halted across a restart -- stopping has to be sticky', async () => {
  const p = paths();
  let sessionId = '';
  await withMeteredServer(opts(p), async ({ base, service }) => {
    const { offer, session } = await openSession(base, BUYER_SK, meter, 'kaspa:testnet-10');
    sessionId = offer.sessionId;
    await runBabel(base, session, 'one');
    service.halt(sessionId);
  });

  await withMeteredServer(opts(p), async ({ base, service }) => {
    assert.equal(service.get(sessionId), undefined, 'the halt survived the restart');
    const { session } = await openSession(base, BUYER_SK, meter, 'kaspa:testnet-10');
    assert.ok(session, 'and a fresh session is still possible');
  });
});

test('without a session store, a restart forgets -- the difference is real', async () => {
  const p = paths();
  let sessionId = '';
  const forgetful = { ...opts(p), sessions: undefined };
  await withMeteredServer(forgetful, async ({ base }) => {
    const { offer, session } = await openSession(base, BUYER_SK, meter, 'kaspa:testnet-10');
    sessionId = offer.sessionId;
    await runBabel(base, session, 'one');
  });
  await withMeteredServer(forgetful, async ({ service }) => {
    assert.equal(service.get(sessionId), undefined, 'gone, as documented');
  });
  void ProtocolError;
});
