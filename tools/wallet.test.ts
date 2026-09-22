/**
 * The fee a spend pays is the node's own minimum, not a guess.
 *
 * Two guesses failed on 2026-09-22, each only at a size the previous run had not reached: a flat
 * 250,000 sompi was refused at 3 inputs (4,278 grams needs 427,800), and 200,000 per input was
 * refused at ONE input (2,038 grams needs 203,800 -- a one-input spend costs more than half a
 * three-input one, because most of the mass is the outputs). The SDK computes what the node will
 * demand; `feeFor` asks it, and only falls back to a formula when the binding is unavailable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feeFor, FEE_FLOOR_SOMPI } from './wallet.js';

const sdkReturning = (fee: bigint | undefined) => ({ calculateTransactionFee: () => fee });

test('a requirement above the floor is paid exactly: a big spend pays what it costs', () => {
  assert.equal(feeFor(sdkReturning(FEE_FLOOR_SOMPI + 1n), 'testnet-10', {}), FEE_FLOOR_SOMPI + 1n);
  assert.equal(feeFor(sdkReturning(3_000_000n), 'testnet-10', {}), 3_000_000n);
});

test('a requirement under the floor is raised to it -- which is where both failed guesses sat', () => {
  // 203,800 (1 input, 2,038 grams) and 427,800 (3 inputs, 4,278 grams) are the two amounts the
  // node actually demanded on 2026-09-22. Both are below the floor, so the floor covers them.
  for (const required of [1_000n, 203_800n, 427_800n]) {
    assert.equal(feeFor(sdkReturning(required), 'testnet-10', {}), FEE_FLOOR_SOMPI);
  }
  assert.ok(FEE_FLOOR_SOMPI > 427_800n, 'the floor must clear the largest requirement seen in practice');
});

test('an SDK that cannot answer -- undefined, missing, or throwing -- falls back, never to zero', () => {
  assert.equal(feeFor(sdkReturning(undefined), 'testnet-10', {}), FEE_FLOOR_SOMPI);
  assert.equal(feeFor({}, 'testnet-10', {}), FEE_FLOOR_SOMPI);
  assert.equal(feeFor({ calculateTransactionFee: () => { throw new Error('no'); } }, 'testnet-10', {}), FEE_FLOOR_SOMPI);
});
