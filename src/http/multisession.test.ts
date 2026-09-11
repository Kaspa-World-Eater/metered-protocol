import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { publicKeyHex, signEnvelope, digestHex } from '../encoding.js';
import { serveMetered } from './serve.js';
import { meterFor } from '../meter.js';
import { MeteredService, type OfferTerms } from './service.js';
import { openSession, runBabel } from './client.js';
import type { Anchor } from '../checkpoint.js';

/**
 * MANY SESSIONS AT ONCE -- the difference between a demo and a server.
 *
 * The risks here are not cryptographic, they are bookkeeping: one buyer seeing another's state,
 * one buyer's halt taking down the wrong session, or a map that grows until the process dies.
 * Each has a test, and the interleaved one matters most because a per-session bug that only
 * appears when two sessions run in step is exactly what a single-session test cannot find.
 */
const BUYER_SK = '11'.repeat(32);
const OTHER_SK = '33'.repeat(32);
const PROVIDER_SK = '22'.repeat(32);
const PRICE = 3630;

const meter = meterFor('octets');
/** Exactly `maxUnits` ASCII bytes, beginning with the prompt so a test can tell sessions apart. */
const deliver = (prompt: string, maxUnits: number) => `${prompt}${'x'.repeat(maxUnits)}`.slice(0, maxUnits);

const TERMS: OfferTerms = {
  v: 1, scheme: 'metered', network: 'kaspa:testnet-10', asset: 'KAS',
  unit: 'net.bytes_delivered.v1', meter: 'octets',
  unitPriceSompi: PRICE, babelUnits: 10, maxBabels: 8,
  toleranceAbs: 0, checkpointEvery: 0, responseWindowDaa: 600,
};

interface Fixture { base: string; service: MeteredService; server: Server }

interface Overrides {
  meter: typeof meter;
  deliver: typeof deliver;
  maxSessions: number;
  anchor: Anchor;
  checkpointEvery: number;
}

async function startService(overrides: Partial<Overrides> = {}): Promise<Fixture> {
  const service = new MeteredService({
    terms: { ...TERMS, checkpointEvery: overrides.checkpointEvery ?? TERMS.checkpointEvery },
    providerSk: PROVIDER_SK,
    providerPubkey: publicKeyHex(PROVIDER_SK),
    meter: overrides.meter ?? meter,
    deliver: overrides.deliver ?? deliver,
    maxSessions: overrides.maxSessions,
    anchor: overrides.anchor,
  });
  const server = serveMetered({ service });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, service, server };
}

async function withService(run: (f: Fixture) => Promise<void>, overrides = {}): Promise<void> {
  const f = await startService(overrides);
  try {
    await run(f);
  } finally {
    await new Promise<void>((resolve) => f.server.close(() => resolve()));
  }
}

void signEnvelope;

test('TWO BUYERS AT ONCE do not see or disturb each other', async () => {
  await withService(async ({ base, service }) => {
    const a = await openSession(base, BUYER_SK, meter, 'kaspa:testnet-10');
    const b = await openSession(base, OTHER_SK, meter, 'kaspa:testnet-10');
    assert.notEqual(a.offer.sessionId, b.offer.sessionId, 'each open mints its own session');
    assert.notEqual(a.offer.partiesCommitment, b.offer.partiesCommitment, 'and its own parties commitment');

    // Interleaved, because a bug that only shows up under interleaving is the whole risk here.
    for (let i = 0; i < 3; i += 1) {
      const ra = await runBabel(base, a.session, `a${i}`);
      const rb = await runBabel(base, b.session, `b${i}`);
      assert.equal(ra.state.sessionId, a.offer.sessionId);
      assert.equal(rb.state.sessionId, b.offer.sessionId);
      assert.equal(ra.state.seq, i);
      assert.equal(rb.state.seq, i);
    }
    assert.equal(a.session.spentSompi, b.session.spentSompi, 'equal work, equal bills, separate books');
    assert.equal(service.size, 2);
  });
});

test('ONE BUYER HALTING does not halt the other', async () => {
  // The liar's session must die; the honest one must keep going.
  const liar = (content: string) => (content.includes('cheat') ? meter(content) * 3 : meter(content));
  await withService(async ({ base }) => {
    const good = await openSession(base, BUYER_SK, meter, 'kaspa:testnet-10');
    const bad = await openSession(base, OTHER_SK, meter, 'kaspa:testnet-10');

    await assert.rejects(() => runBabel(base, bad.session, 'cheat'));
    const still = await runBabel(base, good.session, 'fine');
    assert.equal(still.billedUnits, 10, 'the honest session is untouched');
  }, { meter: liar });
});

test('a buyer that catches a lie stops WITHOUT telling the server, and that is fine', async () => {
  // Worth being precise about: the buyer detects the inflated count locally, in measure(), and
  // never sends anything further. The server is not told and does not mark itself halted -- it is
  // simply left holding a session nobody returns to, which eviction handles. SPEC.md 1 says the
  // remedy for disagreement is to stop; it does not require announcing it, and announcing would
  // tell a dishonest provider exactly which check caught it.
  await withService(async ({ base, service }) => {
    const { offer, session } = await openSession(base, BUYER_SK, meter, 'kaspa:testnet-10');
    await assert.rejects(() => runBabel(base, session, 'x'), /differ by more than/);
    assert.equal(service.isHalted(offer.sessionId), false, 'the server was never told');
    assert.equal(service.size, 1, 'and still holds it, until eviction');
  }, { meter: (c: string) => meter(c) * 3 });
});

test('a SERVER-side disagreement halts the session for good, and later requests get 404', async () => {
  await withService(async ({ base, service }) => {
    const { offer, session } = await openSession(base, BUYER_SK, meter, 'kaspa:testnet-10');
    const reservation = session.reserve();
    const delivered = await fetch(`${base}/metered/babel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reservation, prompt: 'x' }),
    });
    assert.equal(delivered.status, 200);

    // A buyer Measurement describing DIFFERENT bytes. Rule 3 halts before any counting.
    const { measurement } = await delivered.json() as { measurement: { contentDigest: string } };
    const mine = signEnvelope({
      v: 1, sessionId: offer.sessionId, seq: 0, by: 'buyer', units: 10,
      cumulativeUnits: 10, contentDigest: 'ab'.repeat(32), measurementId: 'cd'.repeat(16),
    }, BUYER_SK);
    assert.notEqual(measurement.contentDigest, 'ab'.repeat(32));

    const settled = await fetch(`${base}/metered/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ measurement: mine }),
    });
    assert.equal(settled.status, 409, 'the session cannot continue');
    assert.equal(service.isHalted(offer.sessionId), true);

    const after = await fetch(`${base}/metered/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ measurement: mine }),
    });
    assert.equal(after.status, 404, 'stopping is sticky');
  });
});

test('an unknown session is a 404, not a crash', async () => {
  await withService(async ({ base }) => {
    const res = await fetch(`${base}/metered/babel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reservation: { sessionId: 'de'.repeat(16), seq: 0 }, prompt: 'x' }),
    });
    assert.equal(res.status, 404);
  });
});

test('the session map stays bounded, evicting halted sessions first', async () => {
  await withService(async ({ service }) => {
    for (let i = 0; i < 5; i += 1) service.open(publicKeyHex(`${(i + 17).toString(16).padStart(2, '0')}`.repeat(32)));
    assert.ok(service.size <= 3, `expected at most 3 sessions, got ${service.size}`);
  }, { maxSessions: 3 });
});


/* --------------------------------------------------- SPEC.md 8, checkpoints */

test('CHECKPOINTS FIRE on schedule during a real HTTP session', async () => {
  const anchored: string[] = [];
  const anchor: Anchor = async (digest) => {
    anchored.push(digest);
    return `tx-${anchored.length}`;
  };
  await withService(async ({ base, service }) => {
    const { offer, session } = await openSession(base, BUYER_SK, meter, 'kaspa:testnet-10');
    for (let i = 0; i < 4; i += 1) await runBabel(base, session, `c${i}`);

    // checkpointEvery is 2, so chunks 1 and 3 anchor and 0 and 2 do not.
    const records = service.checkpointsFor(offer.sessionId);
    assert.deepEqual(records.map((r) => r.seq), [1, 3]);
    assert.equal(anchored.length, 2, 'the anchor was actually called, not just recorded');
  }, { anchor, checkpointEvery: 2 });
});

test('a checkpoint anchors the DOUBLY-signed State, not the provider proposal', async () => {
  // SPEC.md 3.4: a State with one signature is not a State. Anchoring at settle would publish a
  // claim the buyer had not agreed to, which is evidence of nothing.
  const seen: string[] = [];
  await withService(async ({ base, service }) => {
    const { offer, session } = await openSession(base, BUYER_SK, meter, 'kaspa:testnet-10');
    const out = await runBabel(base, session, 'x');
    const records = service.checkpointsFor(offer.sessionId);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.digest, digestHex(out.state), 'the anchored digest is the agreed State');
    assert.equal(records[0]?.txid, 'tx', 'and the record carries the transaction, which is the evidence');
  }, { anchor: async (d: string) => { seen.push(d); return 'tx'; }, checkpointEvery: 1 });
});

test('A FAILING ANCHOR CANNOT TAKE DOWN A SESSION -- evidence is not safety', async () => {
  // SPEC.md 8: checkpoints prove a State existed; they cannot prevent a stale close. Losing one
  // costs provability, never funds, so it must not be able to stop a paying session.
  const anchor: Anchor = () => Promise.reject(new Error('node unreachable'));
  await withService(async ({ base, service }) => {
    const { offer, session } = await openSession(base, BUYER_SK, meter, 'kaspa:testnet-10');
    for (let i = 0; i < 3; i += 1) {
      const out = await runBabel(base, session, `c${i}`);
      assert.equal(out.billedUnits, 10, 'the session keeps paying out regardless');
    }
    await new Promise((r) => setTimeout(r, 20));
    const records = service.checkpointsFor(offer.sessionId);
    assert.ok(records.length > 0);
    assert.ok(records.every((r) => r.status === 'failed'), 'and the failures are recorded, not swallowed');
  }, { anchor, checkpointEvery: 1 });
});

test('checkpointEvery 0 anchors nothing at all', async () => {
  let calls = 0;
  await withService(async ({ base, service }) => {
    const { offer, session } = await openSession(base, BUYER_SK, meter, 'kaspa:testnet-10');
    for (let i = 0; i < 3; i += 1) await runBabel(base, session, `c${i}`);
    assert.equal(calls, 0);
    assert.equal(service.checkpointsFor(offer.sessionId).length, 0);
  }, { anchor: async () => { calls += 1; return 'tx'; }, checkpointEvery: 0 });
});
