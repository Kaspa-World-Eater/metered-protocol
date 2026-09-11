import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalize, digestHex, blake3Hex, publicKeyHex,
  sign, verify, signEnvelope, signState, verifyState, stateSigningPayload, settlementPreimage,
} from './encoding.js';

const SK = '11'.repeat(32);
const PK = publicKeyHex(SK);
const OTHER_SK = '22'.repeat(32);
const OTHER_PK = publicKeyHex(OTHER_SK);

/* ------------------------------------------------------- canonical encoding */

test('keys sort, and the output has no whitespace', () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalize({ z: [1, 2], a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"z":[1,2]}');
});

test('THE RULE THAT WAS WRONG IN THE SPEC: sorting is UTF-16, not code point', () => {
  // U+FFFD is one UTF-16 unit (0xFFFD); U+10000 is a surrogate pair starting 0xD800. UTF-16 order
  // puts the astral character FIRST; code-point order puts it second. The spec said code point
  // until a check caught it, and an implementer following that would diverge silently.
  const out = canonicalize({ '�': 1, '\u{10000}': 2 });
  assert.ok(out.indexOf('\u{10000}') < out.indexOf('�'), 'astral key must sort first under UTF-16');
});

test('undefined-valued keys are dropped, null is kept', () => {
  assert.equal(canonicalize({ a: undefined, b: null, c: 1 }), '{"b":null,"c":1}');
});

test('a non-finite number is refused rather than encoded', () => {
  assert.throws(() => canonicalize({ n: Infinity }), /non-finite/);
  assert.throws(() => canonicalize({ n: NaN }), /non-finite/);
});

test('an unsupported type is refused rather than coerced', () => {
  assert.throws(() => canonicalize({ f: () => 1 } as unknown), /unsupported/);
  assert.throws(() => canonicalize(BigInt(1) as unknown), /unsupported/);
});

test('encoding is stable across key insertion order', () => {
  assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }));
});

/* -------------------------------------------------------------- one digest */

test('ONE HASH EVERYWHERE: digestHex is blake3 of the canonical form', () => {
  // The borrowed code used BLAKE2b here and BLAKE3 for content addressing, while the spec called
  // both blake3. That single sentence would have produced incompatible prevState chains.
  const v = { b: 1, a: 'x' };
  assert.equal(digestHex(v), blake3Hex(canonicalize(v)));
  assert.equal(digestHex(v).length, 64);
});

test('the digest changes if any field changes', () => {
  assert.notEqual(digestHex({ a: 1 }), digestHex({ a: 2 }));
  assert.notEqual(digestHex({ a: 1 }), digestHex({ a: '1' }));
});

/* -------------------------------------------------------------- signatures */

test('sign and verify round-trip', () => {
  const m = signEnvelope({ hello: 'world', n: 3 }, SK);
  assert.equal(verify(m, PK), true);
});

test('the signature covers the payload WITHOUT its own field', () => {
  // present-and-empty is a different byte string from absent, and getting this wrong is a classic
  // interop failure that only shows up between two independent implementations
  const m = signEnvelope({ a: 1 }, SK);
  const withEmpty = { ...m, sig: '' };
  assert.equal(canonicalize(withoutSig(m)), canonicalize({ a: 1 }));
  assert.notEqual(canonicalize(withEmpty), canonicalize({ a: 1 }));
});

const withoutSig = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'sig'));

test('a tampered message fails verification', () => {
  const m = signEnvelope({ a: 1 }, SK) as Record<string, unknown>;
  m.a = 2;
  assert.equal(verify(m as object, PK), false);
});

test('the wrong key fails verification', () => {
  assert.equal(verify(signEnvelope({ a: 1 }, SK), OTHER_PK), false);
});

test('a missing or malformed signature is false, never a throw', () => {
  assert.equal(verify({ a: 1 }, PK), false);
  assert.equal(verify({ a: 1, sig: 'not-hex' }, PK), false);
  assert.equal(verify({ a: 1, sig: 42 } as unknown as object, PK), false);
});

test('signatures are not deterministic, which is why a vector never pins them', () => {
  // BIP340 signs with random auxiliary data. Two correct signatures over one message differ, and a
  // golden vector that compared signature bytes would fail on every second run -- as ours did.
  const a = sign({ a: 1 }, SK);
  const b = sign({ a: 1 }, SK);
  assert.notEqual(a, b);
  assert.equal(verify({ a: 1, sig: a }, PK), true);
  assert.equal(verify({ a: 1, sig: b }, PK), true);
});

/* ------------------------------------------------------------- State, doubly signed */

// SPEC.md 3.4.1: a State's signatures cover a 72-byte preimage, NOT canonical JSON, because the
// covenant must rebuild what it verifies and a Kaspa script cannot build JSON. Every fixture below
// is therefore a COMPLETE State -- a partial one has no preimage at all.
const SESSION = 'a1'.repeat(16);
const PREV = 'b2'.repeat(32);
const STATE = { v: 1, sessionId: SESSION, seq: 3, cumulativeUnits: 2199, cumulativeSompi: 7982370, prevState: PREV };

test('both State signatures cover the same bytes, and neither field is in the preimage', () => {
  const buyerSig = signState(STATE, SK);
  const providerSig = signState(STATE, OTHER_SK);
  const full = { ...STATE, buyerSig, providerSig };

  // neither signature depends on the other having been made first
  assert.equal(stateSigningPayload(full), stateSigningPayload(STATE));
  assert.equal(verifyState(full, buyerSig, PK), true);
  assert.equal(verifyState(full, providerSig, OTHER_PK), true);
});

test('the settlement preimage is exactly 72 bytes, in the order SPEC.md 3.4.1 fixes', () => {
  assert.equal(settlementPreimage(STATE).length, 72);
  const hex = stateSigningPayload(STATE);
  assert.equal(hex.slice(0, 32), SESSION); // sessionId, offset 0
  assert.equal(hex.slice(32, 48), '0300000000000000'); // seq 3, little-endian, offset 16
  assert.equal(hex.slice(80, 144), PREV); // prevState, offset 40
});

test('prevState null becomes 32 ZERO bytes, because a null has no byte form', () => {
  const genesis = { ...STATE, seq: 0, prevState: null };
  assert.equal(stateSigningPayload(genesis).slice(80, 144), '00'.repeat(32));
  assert.equal(verifyState(genesis, signState(genesis, SK), PK), true);
});

test('a State signature does not verify against a changed amount', () => {
  const sig = signState(STATE, SK);
  assert.equal(verifyState({ ...STATE, cumulativeSompi: 7982371 }, sig, PK), false);
});

test('a State signature cannot be lifted onto a different sequence number', () => {
  const sig = signState(STATE, SK);
  assert.equal(verifyState({ ...STATE, seq: 4 }, sig, PK), false);
});

test('a State signature cannot be lifted into another session -- threat X1, cross-session replay', () => {
  // This is why sessionId stays in the preimage. one fallback considered during design would drop it to
  // save its width; this test is the defence that would cost, and the covenant fits without it.
  const sig = signState(STATE, SK);
  assert.equal(verifyState({ ...STATE, sessionId: 'c3'.repeat(16) }, sig, PK), false);
});

test('X1 FROM THE INSIDE: a REUSED sessionId makes the same signature valid twice', () => {
  // The test above covers a DIFFERENT sessionId, which is the outsider's version of X1. This is
  // the provider's version, and it is why SPEC.md 3.1a exists: sessionId is provider-CHOSEN, so
  // the provider need not forge anything -- it reissues an identifier it used before, and the
  // buyer's own signature from the earlier session settles the later one unaltered.
  //
  // This assertion is deliberately POSITIVE. The preimage cannot tell the two sessions apart at
  // any width, so no property of encoding.ts is being claimed here; what is being pinned is that
  // the defence has to live somewhere else. src/offer.test.ts holds the other half.
  const sig = signState(STATE, SK);
  const otherSession = { ...STATE }; // same id, same seq, same amounts: a different session
  assert.equal(verifyState(otherSession, sig, PK), true);
});
