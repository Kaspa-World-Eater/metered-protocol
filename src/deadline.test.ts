import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldSettle, acceptPolicy, worstCaseExposure, PolicyRejected,
  CONFIRM_MARGIN_DAA, type ExposurePolicy,
} from './deadline.js';

/**
 * SPEC.md §7.3a. The window is the provider's DEADLINE, and these pin what that means.
 *
 * The failure being prevented is specific and total: the covenant UTXO ages past the window with
 * no claim pending, and the buyer closes with `expire`, taking back everything -- including
 * payment for work already delivered and already agreed in signed States.
 */
const POLICY: ExposurePolicy = { settleByAgeDaa: 300, settleAtUnsettledSompi: 5_000_000 };
const WINDOW = 600;

test('§7.3a: at the age deadline the provider must post, even for a small claim', () => {
  assert.equal(shouldSettle(POLICY, { ageDaa: 300, unsettledSompi: 1 }).settle, true);
  assert.equal(shouldSettle(POLICY, { ageDaa: 299, unsettledSompi: 1 }).settle, false);
});

test('§7.3a: at the exposure limit the provider must post, however young the UTXO', () => {
  assert.equal(shouldSettle(POLICY, { ageDaa: 0, unsettledSompi: 5_000_000 }).settle, true);
  assert.equal(shouldSettle(POLICY, { ageDaa: 0, unsettledSompi: 4_999_999 }).settle, false);
});

test('nothing unsettled means nothing to defend -- a settle would pay a fee for no reason', () => {
  assert.equal(shouldSettle(POLICY, { ageDaa: 10_000, unsettledSompi: 0 }).settle, false);
});

test('the reason is reported, because an operator has to be able to act on it', () => {
  assert.match(shouldSettle(POLICY, { ageDaa: 400, unsettledSompi: 1 }).why ?? '', /deadline/);
  assert.match(shouldSettle(POLICY, { ageDaa: 1, unsettledSompi: 9_000_000 }).why ?? '', /exposure/);
});

/* --------------------------------------- the policy must FIT INSIDE the window */

test('a deadline that leaves no room for the settle to confirm is REFUSED', () => {
  // The trap this closes: a settle broadcast before the deadline but confirmed after it has
  // defended nothing. Study B measured p90 confirmation at 1,879 ms, and 60 DAA is about six
  // seconds at this network's block rate -- three times that.
  assert.throws(() => acceptPolicy({ ...POLICY, settleByAgeDaa: WINDOW }, WINDOW), PolicyRejected);
  assert.throws(
    () => acceptPolicy({ ...POLICY, settleByAgeDaa: WINDOW - CONFIRM_MARGIN_DAA + 1 }, WINDOW),
    PolicyRejected,
  );
  assert.doesNotThrow(() => acceptPolicy({ ...POLICY, settleByAgeDaa: WINDOW - CONFIRM_MARGIN_DAA }, WINDOW));
});

test('a policy with no deadline at all is refused', () => {
  assert.throws(() => acceptPolicy({ ...POLICY, settleByAgeDaa: 0 }, WINDOW), PolicyRejected);
});

/* ----------------------------------------------- what the provider actually risks */

test('the worst case is a NUMBER the provider chooses, not a hope', () => {
  // The provider's counterpart to the babel. With an exposure limit, the most that can be lost to
  // a buyer that waits out the window is that limit.
  assert.equal(worstCaseExposure(POLICY, 50_000_000), 5_000_000);
  // ... and without one it is the whole session, which is why leaving it at 0 is a decision.
  assert.equal(worstCaseExposure({ ...POLICY, settleAtUnsettledSompi: 0 }, 50_000_000), 50_000_000);
});

test('the worst case never exceeds what the session can bill', () => {
  assert.equal(worstCaseExposure(POLICY, 1_000_000), 1_000_000);
});
