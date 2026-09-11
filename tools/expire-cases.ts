/**
 * The `expire` cases -- the payout path, and the one that carries every bug found in this covenant.
 *
 * Every case here needs a real transaction signature, so each is built twice: once with a
 * placeholder to learn the sighash, once with the signature over it. See tools/sighash.ts.
 */
import { sighashFor, signSighash } from './sighash.js';
import { BUYER_PK, BUYER_SK, PROVIDER_PK, PROVIDER_SK, STRANGER_SK, FUNDED, FEE, WINDOW, ctor, x, type Case } from './fixtures.js';

const PLACEHOLDER = x('44'.repeat(65));
const CLAIM = 4_000_000;

/** An expire spends the covenant and pays out. `sequence` is what satisfies the relative window. */
function expireTx(pendingSeq: number, pendingSompi: number, outputs: unknown[], sequence = WINDOW) {
  return {
    active_input_index: 0,
    inputs: [{ utxo_value: FUNDED, sequence, constructor_args: ctor(pendingSeq, pendingSompi) }],
    outputs,
  };
}

const toBuyer = (value: number) => ({ value, p2pk_pubkey: x(BUYER_PK) });
const toProvider = (value: number) => ({ value, p2pk_pubkey: x(PROVIDER_PK) });

/** Each case, with the key that must sign it. The signature is filled in afterwards. */
const PLAN: { case: Case; signer: string }[] = [
  {
    signer: BUYER_SK,
    case: {
      name: 'BUG 1, THE STUCK FUNDS: nobody ever settled, so the buyer takes everything back',
      function: 'expire',
      constructor_args: ctor(-1, 0),
      args: [x(BUYER_PK), x(PROVIDER_PK), PLACEHOLDER],
      expect: 'pass',
      tx: expireTx(-1, 0, [toBuyer(FUNDED - FEE)]),
    },
  },
  {
    signer: BUYER_SK,
    case: {
      name: 'BUG 1: with no claim, paying the provider instead of refunding the buyer is refused',
      function: 'expire',
      constructor_args: ctor(-1, 0),
      args: [x(BUYER_PK), x(PROVIDER_PK), PLACEHOLDER],
      expect: 'fail',
      tx: expireTx(-1, 0, [toProvider(FUNDED - FEE)]),
    },
  },
  {
    signer: PROVIDER_SK,
    case: {
      name: 'the normal payout: the provider takes the claim, the buyer takes the remainder',
      function: 'expire',
      constructor_args: ctor(3, CLAIM),
      args: [x(BUYER_PK), x(PROVIDER_PK), PLACEHOLDER],
      expect: 'pass',
      tx: expireTx(3, CLAIM, [toProvider(CLAIM), toBuyer(FUNDED - CLAIM - FEE)]),
    },
  },
  {
    signer: PROVIDER_SK,
    case: {
      name: 'BUG 2, THE BURNED REFUND: paying the buyer a token amount and burning the rest to fee is refused',
      function: 'expire',
      constructor_args: ctor(3, CLAIM),
      args: [x(BUYER_PK), x(PROVIDER_PK), PLACEHOLDER],
      expect: 'fail',
      tx: expireTx(3, CLAIM, [toProvider(CLAIM), toBuyer(1)]),
    },
  },
  {
    signer: PROVIDER_SK,
    case: {
      name: 'THE OVERCLAIM: paying the provider more than the pending claim is refused',
      function: 'expire',
      constructor_args: ctor(3, CLAIM),
      args: [x(BUYER_PK), x(PROVIDER_PK), PLACEHOLDER],
      expect: 'fail',
      tx: expireTx(3, CLAIM, [toProvider(CLAIM + 1_000_000), toBuyer(FUNDED - CLAIM - 1_000_000 - FEE)]),
    },
  },
  {
    signer: PROVIDER_SK,
    case: {
      name: 'THE WRONG DESTINATION: paying the claim to a stranger instead of the provider is refused',
      function: 'expire',
      constructor_args: ctor(3, CLAIM),
      args: [x(BUYER_PK), x(PROVIDER_PK), PLACEHOLDER],
      expect: 'fail',
      tx: expireTx(3, CLAIM, [{ value: CLAIM, p2pk_pubkey: x('cc'.repeat(32)) }, toBuyer(FUNDED - CLAIM - FEE)]),
    },
  },
  {
    signer: STRANGER_SK,
    case: {
      name: 'A STRANGER CANNOT CLOSE: expire signed by neither party is refused',
      function: 'expire',
      constructor_args: ctor(3, CLAIM),
      args: [x(BUYER_PK), x(PROVIDER_PK), PLACEHOLDER],
      expect: 'fail',
      tx: expireTx(3, CLAIM, [toProvider(CLAIM), toBuyer(FUNDED - CLAIM - FEE)]),
    },
  },
  {
    signer: BUYER_SK,
    case: {
      name: 'FINDING G: a claim too small to pay closes to the buyer instead of locking forever',
      function: 'expire',
      constructor_args: ctor(3, 100_000),
      args: [x(BUYER_PK), x(PROVIDER_PK), PLACEHOLDER],
      expect: 'pass',
      tx: expireTx(3, 100_000, [toBuyer(FUNDED - FEE)]),
    },
  },
  {
    signer: PROVIDER_SK,
    case: {
      name: 'FINDING G: a dust claim may NOT be paid to the provider -- it cannot be created',
      function: 'expire',
      constructor_args: ctor(3, 100_000),
      args: [x(BUYER_PK), x(PROVIDER_PK), PLACEHOLDER],
      expect: 'fail',
      tx: expireTx(3, 100_000, [toProvider(100_000), toBuyer(FUNDED - 100_000 - FEE)]),
    },
  },
  {
    signer: BUYER_SK,
    case: {
      // THE WINDOW THAT USED TO STRAND THE FUNDS. With the dust constant at 2,000,000 this claim
      // took the two-output branch, which demanded an output of exactly 2,100,000 -- and KIP-9
      // refuses to create one that small beside a large refund, so the session had NO legal close
      // at all. tools/dust-map.ts found the window; 2,600,000 folds it to the buyer instead.
      name: 'THE UNCLOSABLE WINDOW: a claim just above the old dust line folds, it does not strand',
      function: 'expire',
      constructor_args: ctor(3, 2_100_000),
      args: [x(BUYER_PK), x(PROVIDER_PK), PLACEHOLDER],
      expect: 'pass',
      tx: expireTx(3, 2_100_000, [toBuyer(FUNDED - FEE)]),
    },
  },
  {
    signer: PROVIDER_SK,
    case: {
      // The other half: it must NOT be payable to the provider, because it still cannot be
      // created. A fold that merely moved the problem would be no fix.
      name: 'THE UNCLOSABLE WINDOW: that same claim still may not be paid to the provider',
      function: 'expire',
      constructor_args: ctor(3, 2_100_000),
      args: [x(BUYER_PK), x(PROVIDER_PK), PLACEHOLDER],
      expect: 'fail',
      tx: expireTx(3, 2_100_000, [toProvider(2_100_000), toBuyer(FUNDED - 2_100_000 - FEE)]),
    },
  },
  {
    signer: PROVIDER_SK,
    case: {
      name: 'FINDING H: a one-output close that burns a payable refund to fee is refused',
      function: 'expire',
      constructor_args: ctor(3, CLAIM),
      args: [x(BUYER_PK), x(PROVIDER_PK), PLACEHOLDER],
      expect: 'fail',
      tx: expireTx(3, CLAIM, [toProvider(CLAIM)]),
    },
  },
  {
    signer: PROVIDER_SK,
    case: {
      name: 'a refund too small to pay folds into the provider, rather than locking the balance',
      function: 'expire',
      constructor_args: ctor(3, FUNDED - 1_000_000),
      args: [x(BUYER_PK), x(PROVIDER_PK), PLACEHOLDER],
      expect: 'pass',
      tx: expireTx(3, FUNDED - 1_000_000, [toProvider(FUNDED - 1_000_000)]),
    },
  },
  {
    signer: PROVIDER_SK,
    case: {
      name: 'FINDING J: two covenant inputs paying out once is refused -- input-group closure',
      function: 'expire',
      constructor_args: ctor(3, CLAIM),
      args: [x(BUYER_PK), x(PROVIDER_PK), PLACEHOLDER],
      expect: 'fail',
      tx: {
        active_input_index: 0,
        inputs: [
          { utxo_value: FUNDED, sequence: WINDOW, constructor_args: ctor(3, CLAIM) },
          { utxo_value: FUNDED, sequence: WINDOW, constructor_args: ctor(3, CLAIM) },
        ],
        outputs: [toProvider(CLAIM), toBuyer(FUNDED - CLAIM - FEE)],
      },
    },
  },
  {
    signer: BUYER_SK,
    case: {
      name: 'P10/THE EARLY CLOSE: expiring before the response window has passed is refused',
      function: 'expire',
      constructor_args: ctor(3, CLAIM),
      args: [x(BUYER_PK), x(PROVIDER_PK), PLACEHOLDER],
      expect: 'fail',
      tx: expireTx(3, CLAIM, [toProvider(CLAIM), toBuyer(FUNDED - CLAIM - FEE)], WINDOW - 1),
    },
  },
];

/** Ask the VM for each case's sighash, sign it, and return the cases with real signatures. */
export function buildExpireCases(contractPath: string): Case[] {
  return PLAN.map(({ case: testCase, signer }) => {
    const sighash = sighashFor(contractPath, testCase);
    const args = [...testCase.args];
    args[2] = x(signSighash(sighash, signer));
    return { ...testCase, args };
  });
}
