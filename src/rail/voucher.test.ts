/**
 * The voucher, checked against THEIR code rather than against this file's idea of it.
 *
 * Every digest below is recomputed with `@kaspa-x402/core` and `@kaspa-x402/covenant` and must
 * match what `voucherForState` signed. If the two packages ever disagree with each other, or this
 * file drifts from them, the money stops moving and the error consensus reports says nothing
 * about which of the three was wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voucherDigest } from '@kaspa-x402/core';
import { voucherV2Digest } from '@kaspa-x402/covenant';
import { schnorr } from '@noble/curves/secp256k1';
import { hexToBytes } from '@noble/hashes/utils';
import { publicKeyHex } from '../encoding.js';
import { voucherForState, verifyVoucher, voucherPreimage, VoucherRefused } from './voucher.js';
import type { State } from '../types.js';

const BUYER_SK = '11'.repeat(32);
const OTHER_SK = '33'.repeat(32);
const CHANNEL = { network: 'kaspa:testnet-10', covenantId: 'c0'.repeat(32) };

const agreed = (cumulativeSompi: number, seq = 3): State => ({
  v: 1, sessionId: 'a1'.repeat(16), seq, cumulativeUnits: 2199, cumulativeSompi, prevState: 'b2'.repeat(32),
});

test('the voucher digest is THEIRS, byte for byte, from both of their packages', () => {
  const v = voucherForState(agreed(4_000_160), CHANNEL, BUYER_SK);
  const theirsCore = voucherDigest({ network: CHANNEL.network, covenantId: CHANNEL.covenantId, amount: '4000160' });
  const theirsCovenant = voucherV2Digest({ network: CHANNEL.network as 'kaspa:testnet-10', covenantId: CHANNEL.covenantId, totalAuthorized: 4_000_160n });
  assert.equal(theirsCore, theirsCovenant, 'their two packages agree with each other');
  // The signature is over exactly that digest and nothing else.
  assert.equal(schnorr.verify(hexToBytes(v.signature), hexToBytes(theirsCore), hexToBytes(publicKeyHex(BUYER_SK))), true);
  assert.equal(v.amount, '4000160', 'decimal string, as their wire carries it');
  assert.equal(v.covenantId, CHANNEL.covenantId);
  assert.equal(voucherPreimage(CHANNEL, '4000160').length / 2, 104, 'domainTag(32) network(32) covenantId(32) le64(8)');
});

test('THE VOUCHER IS FOR THE AGREED STATE, and a reservation is not a State', () => {
  // The thing the whole integration turns on. A State exists only after both sides counted and
  // signed, so a voucher built from one carries the agreed figure by construction -- there is no
  // way to hand this function the reservation, because the reservation is a different type.
  const v = voucherForState(agreed(860_310), CHANNEL, BUYER_SK);
  assert.equal(v.amount, '860310', 'what arrived, not what was reserved');
  assert.equal(verifyVoucher(v, CHANNEL, publicKeyHex(BUYER_SK)), true);
});

test('a channel outlives sessions: the ceiling accumulates and never goes down', () => {
  // First session on the channel vouched 4,000,160. A second session agreeing 860,310 must vouch
  // the SUM: a voucher is a lifetime cumulative ceiling for the lineage, not a per-session figure.
  const second = voucherForState(agreed(860_310), CHANNEL, BUYER_SK, 4_000_160);
  assert.equal(second.amount, '4860470');
  assert.equal(verifyVoucher(second, CHANNEL, publicKeyHex(BUYER_SK)), true);
});

test('a voucher verifies only for its buyer, its channel and its exact amount', () => {
  const v = voucherForState(agreed(4_000_160), CHANNEL, BUYER_SK);
  assert.equal(verifyVoucher(v, CHANNEL, publicKeyHex(OTHER_SK)), false, 'wrong buyer');
  assert.equal(verifyVoucher(v, { ...CHANNEL, covenantId: 'd1'.repeat(32) }, publicKeyHex(BUYER_SK)), false, 'wrong lineage');
  assert.equal(verifyVoucher({ ...v, amount: '4000161' }, CHANNEL, publicKeyHex(BUYER_SK)), false, 'one sompi more');
  assert.equal(verifyVoucher({ ...v, amount: '4000159' }, CHANNEL, publicKeyHex(BUYER_SK)), false, 'one sompi less');
});

test('nothing owed is nothing to vouch, and a ceiling cannot be negative', () => {
  assert.throws(() => voucherForState(agreed(0), CHANNEL, BUYER_SK), VoucherRefused);
  assert.throws(() => voucherForState(agreed(-5), CHANNEL, BUYER_SK), VoucherRefused);
  assert.throws(() => voucherForState(agreed(100), CHANNEL, BUYER_SK, -1), VoucherRefused);
});

test('a zero covenant id is refused by THEIR code, and that refusal reaches the caller', () => {
  // Their preimage builder rejects an all-zero lineage. This is not re-checked here; it is
  // deliberately allowed to surface from their package, so the two cannot drift apart.
  assert.throws(() => voucherForState(agreed(100), { ...CHANNEL, covenantId: '00'.repeat(32) }, BUYER_SK));
});
