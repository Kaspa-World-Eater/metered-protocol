/**
 * `npm run conformance` -- generate the vectors a SECOND implementation must reproduce.
 *
 * THE SPECIFICATION'S CENTRAL CLAIM IS THAT TWO IMPLEMENTATIONS AGREE. That has been demonstrated
 * for the tokeniser, where the JavaScript encoder is pinned against Python `tiktoken` boundary for
 * boundary. It has never been demonstrated for the protocol, because there has only ever been one
 * implementation of it -- and a specification with one implementation is a description of that
 * implementation, however carefully it is written.
 *
 * So this emits the bytes. Every case names the section it comes from, states its input in a
 * language-neutral form, and gives the exact output an implementation must produce. An implementer
 * needs no TypeScript, no dependency on this repository, and no agreement with any of its choices
 * -- only the same answers.
 *
 * WHAT IS PINNED IS WHAT CANNOT BE NEGOTIATED LATER: canonical bytes, digests, the settlement
 * preimage, signature verification, reconciliation outcomes, and the close shape. Those are the
 * places where two honest implementations diverge silently and then cannot settle with each other.
 *
 * Signatures are pinned as VERIFICATION, never as production: BIP340 signing is randomised, so a
 * vector demanding particular signature bytes is a vector no correct implementation can pass.
 */
import { writeFileSync } from 'node:fs';
import {
  canonicalize, digestHex, blake3Hex, publicKeyHex, signEnvelope, signState,
  settlementPreimage, stateSigningPayload,
} from '../src/encoding.js';
import { reconcileBabel, toleranceBound } from '../src/reconcile.js';
import { requiredFunding, CLOSE_FEE_SOMPI, MIN_COVENANT_SOMPI } from '../src/reservation.js';
import { resolveMeter, minimumTolerance, meterFor } from '../src/meter.js';
import type { Measurement, Offer, State } from '../src/types.js';

const BUYER_SK = '11'.repeat(32);
const PROVIDER_SK = '22'.repeat(32);
const SESSION = 'a1'.repeat(16);

interface Case { name: string; given: unknown; expect: unknown }
interface Group { section: string; about: string; cases: Case[] }

const OFFER: Offer = signEnvelope({
  v: 1, scheme: 'metered', network: 'kaspa:testnet-10', asset: 'KAS',
  sessionId: SESSION, unit: 'llm.output_tokens.v1', meter: 'o200k_base',
  unitPriceSompi: 3630, babelUnits: 550, maxBabels: 64,
  toleranceAbs: 1, checkpointEvery: 2, responseWindowDaa: 600,
  buyerPubkey: publicKeyHex(BUYER_SK), providerPubkey: publicKeyHex(PROVIDER_SK),
  partiesCommitment: blake3Hex(`${publicKeyHex(BUYER_SK)}${publicKeyHex(PROVIDER_SK)}`),
}, PROVIDER_SK) as Offer;

/** Section 2. The bytes everything else is computed over: key order, escaping, no stray space. */
function encodingGroup(): Group {
  const shapes: [string, unknown][] = [
    ['nested objects sort by key at every level', { b: 1, a: { d: 4, c: 3 } }],
    ['arrays keep their order, unlike objects', { a: [3, 1, 2] }],
    ['non-ASCII is NOT escaped', { s: 'Cafe \u{1F512} 計量' }],
    ['a null is preserved where the spec names one', { prevState: null, seq: 0 }],
    ['negative and zero integers', { a: -1, b: 0, c: -9007199254740991 }],
    // THE ONE THAT ACTUALLY TESTS THE RULE. An earlier version of this vector used only BMP
    // characters, where code-point and code-unit order AGREE -- so it named the rule and tested
    // nothing, and a second implementation sorting by code point passed it. These two keys order
    // OPPOSITELY under the two rules: U+10000 encodes as the surrogate pair D800 DC00, and
    // D800 < FFFD, so it sorts FIRST by code unit and LAST by code point.
    ['UTF-16 code-unit order, where it DIFFERS from code-point order', { '�': 1, '\u{10000}': 2 }],
    ['BMP keys, where the two orders agree', { 'aＺ': 1, 'aａ': 2, az: 3 }],
  ];
  return {
    section: '2',
    about: 'Canonical JSON, and the digest taken over it. Sorted keys, no insignificant whitespace.',
    cases: shapes.map(([name, given]) => ({
      name,
      given,
      expect: { canonical: canonicalize(given), digest: digestHex(given) },
    })),
  };
}

/** Section 3.4.1. Fixed width, fixed order, no delimiters -- and the traps inside it. */
function preimageGroup(): Group {
  const states: [string, Record<string, unknown>][] = [
    ['a mid-session State', { v: 1, sessionId: SESSION, seq: 3, cumulativeUnits: 2199, cumulativeSompi: 7982370, prevState: 'b2'.repeat(32) }],
    ['seq 0, where prevState is null and becomes 32 ZERO bytes', { v: 1, sessionId: SESSION, seq: 0, cumulativeUnits: 550, cumulativeSompi: 1996500, prevState: null }],
    ['a NEGATIVE integer is signed-magnitude, not two-complement', { v: 1, sessionId: SESSION, seq: -1, cumulativeUnits: 0, cumulativeSompi: 0, prevState: null }],
    ['the largest integer the protocol admits', { v: 1, sessionId: SESSION, seq: 1, cumulativeUnits: 9007199254740991, cumulativeSompi: 9007199254740991, prevState: 'cd'.repeat(32) }],
  ];
  return {
    section: '3.4.1',
    about: 'The 72-byte settlement preimage: sessionId(16) seq(8) units(8) sompi(8) prevState(32).',
    cases: states.map(([name, given]) => ({
      name,
      given,
      expect: {
        lengthBytes: settlementPreimage(given).length,
        preimageHex: stateSigningPayload(given),
        digestHex: blake3Hex(settlementPreimage(given)),
      },
    })),
  };
}

/** Signatures, pinned as verification because signing is randomised. */
function signatureGroup(): Group {
  const state = { v: 1, sessionId: SESSION, seq: 0, cumulativeUnits: 550, cumulativeSompi: 1996500, prevState: null } as unknown as State;
  const buyerSig = signState(state, BUYER_SK);
  return {
    section: '2.6 / 3.4',
    about: 'Verification vectors. A correct implementation MUST agree on true and on false alike.',
    cases: [
      {
        name: 'the Offer verifies against the provider key that signed it',
        given: { message: OFFER, publicKey: OFFER.providerPubkey, field: 'sig' },
        expect: { verifies: true },
      },
      {
        name: 'the Offer does NOT verify against the buyer key',
        given: { message: OFFER, publicKey: OFFER.buyerPubkey, field: 'sig' },
        expect: { verifies: false },
      },
      {
        name: 'a State signature verifies over the 72-byte preimage, not over JSON',
        given: { state, signature: buyerSig, publicKey: publicKeyHex(BUYER_SK) },
        expect: { verifies: true },
      },
      {
        name: 'the same signature fails once an amount changes',
        given: { state: { ...state, cumulativeSompi: 1996501 }, signature: buyerSig, publicKey: publicKeyHex(BUYER_SK) },
        expect: { verifies: false },
      },
    ],
  };
}

const measure = (by: 'buyer' | 'provider', units: number, cumulative: number, digest: string): Measurement =>
  signEnvelope({
    v: 1, sessionId: SESSION, seq: 0, by, units, cumulativeUnits: cumulative,
    contentDigest: digest, measurementId: blake3Hex(`${SESSION}/0/${by}`).slice(0, 32),
  }, by === 'buyer' ? BUYER_SK : PROVIDER_SK) as unknown as Measurement;

/** Section 5. What gets billed, or why the session stops. */
function reconcileGroup(): Group {
  const d = blake3Hex('the delivered bytes');
  const other = blake3Hex('different bytes');
  const rows: [string, Measurement, Measurement][] = [
    ['identical counts bill that count', measure('buyer', 550, 550, d), measure('provider', 550, 550, d)],
    ['a one-token disagreement inside tolerance bills the LOWER', measure('buyer', 549, 549, d), measure('provider', 550, 550, d)],
    ['beyond tolerance the session halts', measure('buyer', 500, 500, d), measure('provider', 550, 550, d)],
    ['a different contentDigest halts, whatever the counts', measure('buyer', 550, 550, other), measure('provider', 550, 550, d)],
  ];
  return {
    section: '5',
    about: 'Reconciliation. Rule 6 bills the lower count; a digest mismatch is unresolvable.',
    cases: rows.map(([name, buyer, provider]) => ({
      name,
      given: { buyer, provider, seq: 0, toleranceAbs: OFFER.toleranceAbs },
      expect: reconcileBabel(OFFER, buyer, provider, 0),
    })),
  };
}

/** Section 7.4a and 7.4b. Which close shape is legal, and what a session must be funded with. */
function settlementGroup(): Group {
  // STRUCTURED, never prose. An earlier version compared English -- "one output, all to the
  // buyer" -- so a correct implementation with different wording failed. A conformance suite that
  // tests its own phrasing is testing the wrong thing.
  const shape = (pending: number, total: number): { outputs: number; to: string[] } => {
    if (pending < 2_600_000) return { outputs: 1, to: ['buyer'] };
    if (pending + 3_000_000 >= total) return { outputs: 1, to: ['provider'] };
    return { outputs: 2, to: ['provider', 'buyer'] };
  };
  const rows: [number, number][] = [
    [0, 50_000_000], [100_000, 50_000_000], [2_599_999, 50_000_000],
    [2_600_000, 50_000_000], [4_000_000, 50_000_000], [47_600_000, 50_000_000],
  ];
  const units = [10, 550, 5000, 1000000];
  return {
    section: '7.4a / 7.4b',
    about: 'Close shape by claim, the funding floor, and a tolerance that does not scale.',
    cases: [
      ...rows.map(([pending, total]) => ({
        name: `claim ${pending} of ${total}`,
        given: { pendingSompi: pending, covenantSompi: total },
        expect: { shape: shape(pending, total) },
      })),
      {
        name: 'the funding floor for this Offer',
        given: { babelUnits: OFFER.babelUnits, maxBabels: OFFER.maxBabels, unitPriceSompi: OFFER.unitPriceSompi },
        expect: { requiredFunding: requiredFunding(OFFER), closeFee: CLOSE_FEE_SOMPI, minCovenant: MIN_COVENANT_SOMPI },
      },
      {
        name: 'the tolerance bound does not grow with the babel',
        given: { toleranceAbs: OFFER.toleranceAbs, providerUnits: units },
        expect: { bounds: units.map((u) => toleranceBound(OFFER, u)) },
      },
    ],
  };
}

/** Section 6. The meters, and the property that decides each one's tolerance floor. */
function meterGroup(): Group {
  const texts = ['', 'hello', 'café', '計量', '\u{1F512}', 'a\nb\tc  d', 'x'.repeat(1000)];
  const octets = meterFor('octets');
  const names = ['octets', 'o200k_base'];
  return {
    section: '6',
    about: 'Units and meters. An exact meter permits a tolerance of 0; a lossy one requires 1.',
    cases: [
      ...texts.map((text) => ({
        name: `octets of ${JSON.stringify(text).slice(0, 28)}`,
        given: { meter: 'octets', content: text },
        expect: { units: octets(text), contentDigest: blake3Hex(text) },
      })),
      {
        name: 'the tolerance floor belongs to the meter, not the protocol',
        given: { meters: names },
        expect: {
          floors: names.map((m) => minimumTolerance(resolveMeter(m))),
          exact: names.map((m) => resolveMeter(m).exact),
        },
      },
      {
        name: 'each meter measures exactly one unit',
        given: { meters: names },
        expect: { units: names.map((m) => resolveMeter(m).unit) },
      },
    ],
  };
}

const doc = {
  version: 1,
  about: 'Conformance vectors for the metered protocol. See spec/CONFORMANCE.md.',
  offer: OFFER,
  groups: [encodingGroup(), preimageGroup(), signatureGroup(), reconcileGroup(), settlementGroup(), meterGroup()],
};

writeFileSync('spec/conformance-vectors.json', `${JSON.stringify(doc, null, 1)}\n`);
const total = doc.groups.reduce((n, g) => n + g.cases.length, 0);
console.log(`wrote spec/conformance-vectors.json -- ${doc.groups.length} groups, ${total} cases`);
