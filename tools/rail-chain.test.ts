/**
 * Regression tests for `channelVerifier`, covering
 * https://github.com/Kaspa-World-Eater/metered-protocol/issues/1.
 *
 * `claimChannel` sets a channel's `active.amount` to the continuation UTXO's value (see its
 * `active:` assignment in rail-chain.ts) -- every prior claim's `claimSompi` is already out of it,
 * the same amount `settledTotal` has grown by. So `active.amount` IS `escrowSompi - settledTotal`
 * from genesis onward, and a check that subtracts `settledTotal` from it again understates the
 * channel's remaining balance by a second `settledTotal` and can refuse a continuation that is
 * genuinely funded. The first case below fails against that bug and passes against the fix.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { escrowV2ScriptPublicKey, serializedScriptPublicKey } from '@kaspa-x402/covenant';
import { channelVerifier, escrowParams } from './rail-chain.js';
import type { Any } from './live-steps.js';
import type { ChannelProposal } from '../src/types.js';

const BUYER_SK = '11'.repeat(32);
const SELLER_SK = '22'.repeat(32);
const buyerPubkey = bytesToHex(schnorr.getPublicKey(hexToBytes(BUYER_SK)));
const providerPubkey = bytesToHex(schnorr.getPublicKey(hexToBytes(SELLER_SK)));
const NETWORK = 'testnet-10' as const;
const TIMEOUT_DAA = 1_000_000n;

const ESCROW_SOMPI = 20_000_000n; // locked at genesis
const SETTLED_TOTAL = 15_000_000n; // claimed across prior babels
const REMAINING = ESCROW_SOMPI - SETTLED_TOTAL; // what active.amount actually holds now

function scriptPubKeyAt(settledTotal: bigint): string {
  const shape = { buyerPubkey, providerPubkey, theirNetwork: `kaspa:${NETWORK}` as const, timeoutDaa: TIMEOUT_DAA };
  return serializedScriptPublicKey(escrowV2ScriptPublicKey(escrowParams(shape, settledTotal)));
}

function proposal(overrides: Partial<ChannelProposal> = {}): ChannelProposal {
  return {
    covenantId: 'ab'.repeat(32),
    timeoutDaa: Number(TIMEOUT_DAA),
    settledTotal: Number(SETTLED_TOTAL),
    active: { txid: 'cd'.repeat(32), index: 0, amount: Number(REMAINING), scriptPublicKey: scriptPubKeyAt(SETTLED_TOTAL) },
    ...overrides,
  };
}

const fakeSdk = (): Any => ({
  ScriptPublicKey: class { constructor(public version: number, public script: string) {} },
  NetworkId: class { constructor(public id: string) {} },
  addressFromScriptPublicKey: () => ({ toString: () => 'kaspatest:fake' }),
});

function fakeRpc(opts: {
  virtualDaaScore?: bigint; liveAmount?: bigint; liveCovenantId?: string; noLiveUtxo?: boolean;
} = {}): Any {
  const p = proposal();
  return {
    getBlockDagInfo: async () => ({ virtualDaaScore: opts.virtualDaaScore ?? TIMEOUT_DAA - 1_000n }),
    getUtxosByAddresses: async () => ({
      entries: opts.noLiveUtxo ? [] : [{
        outpoint: { transactionId: p.active.txid, index: p.active.index },
        amount: opts.liveAmount ?? BigInt(p.active.amount),
        ...(opts.liveCovenantId === undefined ? {} : { covenantId: opts.liveCovenantId }),
      }],
    }),
  };
}

test('accepts a continuation whose remaining balance covers the requirement', async () => {
  const verify = channelVerifier(fakeRpc(), fakeSdk(), providerPubkey, NETWORK, Number(REMAINING));
  const result = await verify(buyerPubkey, proposal());
  assert.deepEqual(result, { covenantId: proposal().covenantId, vouchedSompi: Number(SETTLED_TOTAL) },
    'active.amount is already the remaining balance -- it must not be reduced by settledTotal a second time');
});

test('refuses a proposal whose remaining balance is genuinely short', async () => {
  const verify = channelVerifier(fakeRpc(), fakeSdk(), providerPubkey, NETWORK, Number(REMAINING) + 1);
  assert.equal(await verify(buyerPubkey, proposal()), null);
});

test('refuses a proposal that has already passed its refund timeout', async () => {
  const verify = channelVerifier(fakeRpc({ virtualDaaScore: TIMEOUT_DAA }), fakeSdk(), providerPubkey, NETWORK, Number(REMAINING));
  assert.equal(await verify(buyerPubkey, proposal()), null, 'the buyer can refund an expired channel at any moment');
});

test('refuses a live UTXO whose SDK-reported covenant id disagrees with the proposal', async () => {
  const verify = channelVerifier(fakeRpc({ liveCovenantId: 'ff'.repeat(32) }), fakeSdk(), providerPubkey, NETWORK, Number(REMAINING));
  assert.equal(await verify(buyerPubkey, proposal()), null);
});

test('does not require the covenant id binding when the SDK entry does not expose it', async () => {
  const verify = channelVerifier(fakeRpc(), fakeSdk(), providerPubkey, NETWORK, Number(REMAINING));
  const result = await verify(buyerPubkey, proposal());
  assert.notEqual(result, null, 'the field is best-effort, not a hard dependency');
});

test('refuses a proposal with no live UTXO at the claimed outpoint', async () => {
  const verify = channelVerifier(fakeRpc({ noLiveUtxo: true }), fakeSdk(), providerPubkey, NETWORK, Number(REMAINING));
  assert.equal(await verify(buyerPubkey, proposal()), null);
});
