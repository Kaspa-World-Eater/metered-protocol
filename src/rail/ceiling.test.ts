/**
 * Step 3 of docs/RAIL.md: a seller that under-delivered CANNOT claim the reservation.
 *
 * This is the property the whole integration turns on, and it holds at three layers of THEIR
 * code, two of which run here:
 *
 *   1. their transaction builder refuses to construct the claim
 *   2. their lane accounting refuses to admit it
 *   3. their escrow script refuses it under consensus:
 *
 *        require(checkMsgSig(clientVoucher, sha256(voucherMessage), client));
 *        int available = totalAuthorized - previous.settledTotal;
 *        require(claimAmount <= available);
 *
 *      (contracts/kaspa-x402-escrow-v2.sil, claim entry). The bytecode is pinned to a compiler
 *      commit and reproducibility-checked in their package; the vectors it runs against are
 *      validated by the full Rusty Kaspa transaction validator.
 *
 * The first two are asserted below. The third is quoted rather than executed, because executing
 * it means their simulator and their fixtures, and the point of being on their rail is that those
 * are theirs to keep true. A seller bypassing layers 1 and 2 is stopped by layer 3.
 *
 * The numbers are the live session's: 4 babels reserved at 65,536 bytes (5,242,880 sompi), each
 * delivered short at 57,344 bytes (4,587,520 sompi agreed). Testnet-10, claim 1f00e92a…
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBatchClaimAccounting, voucherDigest } from '@kaspa-x402/core';
import {
  buildEscrowV2RedeemScript, escrowV2ScriptPublicKey, serializedScriptPublicKey,
  buildBatchClaimTxV1Artifact, escrowV2ScriptPubKeyHash,
} from '@kaspa-x402/covenant';
import { publicKeyHex } from '../encoding.js';
import { voucherForState } from './voucher.js';
import type { State } from '../types.js';

const BUYER_SK = '11'.repeat(32);
const SELLER_SK = '22'.repeat(32);
const RESERVED = 5_242_880n;
const AGREED = 4_587_520n;
const CHANNEL = { network: 'kaspa:testnet-10' as const, covenantId: 'cd'.repeat(32) };

const p2pk = (k: string) => ({ version: 0, script: `20${k}ac` });
const params = (settledTotal: bigint) => ({
  clientPublicKey: publicKeyHex(BUYER_SK), serverPublicKey: publicKeyHex(SELLER_SK), network: CHANNEL.network,
  payoutScriptPublicKeyHash: escrowV2ScriptPubKeyHash(p2pk(publicKeyHex(SELLER_SK))),
  refundScriptPublicKeyHash: escrowV2ScriptPubKeyHash(p2pk(publicKeyHex(BUYER_SK))),
  timeoutDaa: 1800n, settledTotal,
});

/** The claim a seller would try to build, for a given amount against a given voucher ceiling. */
function claimAttempt(claimAmount: bigint, totalAuthorized: bigint, voucherSignature: string) {
  return buildBatchClaimTxV1Artifact({
    network: CHANNEL.network, activeOutpoint: { txid: 'ab'.repeat(32), index: 0 }, activeAmount: 20_000_000n,
    activeScriptPublicKey: serializedScriptPublicKey(escrowV2ScriptPublicKey(params(0n))),
    activeRedeemScript: buildEscrowV2RedeemScript(params(0n)),
    covenantId: CHANNEL.covenantId, settledTotal: 0n, totalAuthorized, claimAmount,
    successorScriptPublicKey: serializedScriptPublicKey(escrowV2ScriptPublicKey(params(claimAmount))),
    successorRedeemScript: buildEscrowV2RedeemScript(params(claimAmount)),
    serverOutputScriptPublicKey: serializedScriptPublicKey(p2pk(publicKeyHex(SELLER_SK))),
    expectedPayoutScriptPublicKeyHash: params(0n).payoutScriptPublicKeyHash,
    fee: 500_000n, serverSignature: '00'.repeat(65), voucherSignature,
    computeBudget: 20, scriptUnitsEstimate: 207_144,
  });
}

const agreedState: State = {
  v: 1, sessionId: 'a1'.repeat(16), seq: 3, cumulativeUnits: 229_376, cumulativeSompi: Number(AGREED), prevState: 'b2'.repeat(32),
};

test('the buyer vouches the AGREED total, and the seller can claim exactly that', () => {
  const voucher = voucherForState(agreedState, CHANNEL, BUYER_SK);
  assert.equal(voucher.amount, String(AGREED));
  const artifact = claimAttempt(AGREED, BigInt(voucher.amount), voucher.signature);
  assert.equal(artifact.fee.claimAmount, String(AGREED));
  assert.equal(artifact.continuation.settledTotal, String(AGREED));
});

test('LAYER 1: their builder refuses a claim for the RESERVATION against a voucher for the agreed', () => {
  const voucher = voucherForState(agreedState, CHANNEL, BUYER_SK);
  assert.throws(
    () => claimAttempt(RESERVED, BigInt(voucher.amount), voucher.signature),
    /exceeds the remaining signed cumulative ceiling/,
  );
});

test('LAYER 2: their lane accounting refuses the same claim', () => {
  const lane = {
    fundingAmount: '20000000', chargedCumulativeAmount: String(AGREED),
    claimedCumulativeAmount: '0', signedMaxClaimable: String(AGREED),
  };
  assert.throws(() => applyBatchClaimAccounting(lane, String(RESERVED)), /cannot exceed/);
  // And the agreed amount goes through, advancing exactly what was claimed.
  const after = applyBatchClaimAccounting(lane, String(AGREED));
  assert.equal(after.claimedCumulativeAmount, String(AGREED));
});

test('a seller cannot substitute a bigger ceiling: the voucher signature binds the amount', () => {
  // Forging a voucher for the reservation is the only other way in, and it needs the buyer's key.
  const real = voucherForState(agreedState, CHANNEL, BUYER_SK);
  const forged = { ...real, amount: String(RESERVED) };
  // Their builder will construct it -- it cannot verify a signature without the key -- but the
  // script's checkMsgSig over (domain || network || covenantId || le64(amount)) will not. The
  // digest below is what the script recomputes, and the real signature is over a different one.
  const artifact = claimAttempt(RESERVED, BigInt(forged.amount), forged.signature);
  assert.notEqual(
    voucherDigest({ network: CHANNEL.network, covenantId: CHANNEL.covenantId, amount: real.amount }),
    artifact.voucherDigest,
    'the forged claim commits to a digest the buyer never signed',
  );
});
