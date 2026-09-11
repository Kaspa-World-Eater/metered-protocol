/**
 * The three chain operations a metered session needs, as functions rather than as a script.
 *
 * FUND, SETTLE, CLOSE. Until now this sequence existed only inside `tools/demo.ts`, wound through
 * its console output -- which meant that anything else wanting to settle a session had to copy it.
 * The second program to want that was the first real product built on this protocol, and copying
 * would have produced two versions of the one sequence that moves money.
 *
 * SPEC.md 7. `settle` posts a doubly-signed claim and pays no one; the response window then
 * restarts. `expire` pays out after the window: the claim to the provider, the remainder to the
 * buyer, everything to the buyer if no claim was ever posted. The two-phase shape is not an
 * implementation detail -- it is what makes the claim superseding a later one work as a guard
 * rather than as a branch.
 *
 * WHAT THIS STILL NEEDS: `silverc`, because the redeem script embeds the session's own identity as
 * constructor constants and so must be compiled per session. That is the official released
 * compiler and an ordinary dependency. It no longer needs the patched cli-debugger -- see
 * tools/sigscript.ts, which was the difference between one machine being able to settle and
 * anybody being able to.
 */
import { compileWithState, covenantAddress } from './covenant.js';
import { awaitUtxo, withState, buildExpire, awaitWindow, closeOutputs, x, type Any } from './live-steps.js';
import { signatureScript, settleArgs } from './sigscript.js';
import type { Network } from './kaspa.js';
import type { Offer, State } from '../src/types.js';

/** Fees are compiled into the covenant's allowance, so they are constants rather than estimates. */
export const SETTLE_FEE = 360_000n;
export const CLOSE_FEE = 400_000n;
export const FUND_FEE = 250_000n;

export interface Opened {
  hex: string;
  entries: Record<string, { dispatch_tag: string }>;
  address: string;
  window: number;
}

/**
 * Compile this session's covenant and derive the address that holds its funds.
 *
 * The constructor constants come from the Offer the provider actually issued, so the address is
 * derived from the agreement rather than the agreement being fitted to an address. A covenant
 * compiled for a different session has a different address and cannot be spent by this one.
 */
export async function openCovenant(
  dir: string, offer: Offer, window: number, network: Network,
): Promise<Opened> {
  const built = compileWithState(dir, {
    parties: offer.partiesCommitment, sessionId: offer.sessionId, window, seq: -1, sompi: 0,
  });
  const address = await covenantAddress(built.hex, network);
  return { ...built, address, window };
}

/** Pay into the covenant from an ordinary wallet, and wait for the UTXO to appear. */
export async function fundCovenant(
  rpc: Any, sdk: Any, opened: Opened, funderSk: string, amount: bigint, network: Network,
): Promise<Any> {
  const priv = new sdk.PrivateKey(funderSk);
  const from = priv.toKeypair().toAddress(new sdk.NetworkId(network)).toString();
  const { entries } = await rpc.getUtxosByAddresses([from]);
  if (entries.length === 0) throw new Error(`nothing to spend at ${from}`);
  const src = entries.reduce((a: Any, b: Any) => (b.amount > a.amount ? b : a));
  if (src.amount < amount + FUND_FEE) throw new Error(`largest UTXO at ${from} cannot cover ${amount}`);

  const fund = sdk.createTransaction(
    [src],
    [{ address: opened.address, amount }, { address: from, amount: src.amount - amount - FUND_FEE }],
    0n, undefined, 0,
  );
  fund.version = 1;
  fund.gas = 0n;
  for (const i of fund.inputs) { i.sigOpCount = 0; i.computeBudget = 10; }
  fund.finalize();
  await rpc.submitTransaction({ transaction: sdk.signTransaction(fund, [priv], true), allowOrphan: false });

  const utxo = await awaitUtxo(rpc, opened.address, amount);
  if (!utxo) throw new Error('the covenant UTXO never appeared');
  return utxo;
}

export interface Claim {
  txid: string;
  /** The continuation UTXO the claim now sits in. `close` spends this, not the funding UTXO. */
  posted: Any;
  redeem: string;
  address: string;
}

/**
 * Post the doubly-signed final State to the covenant.
 *
 * `settle` PAYS NO ONE. The single output hands the balance straight back to the same covenant,
 * now carrying `(seq, cumulativeSompi)` as its state, and the response window restarts. A later
 * State with a strictly higher seq supersedes this one by the same route.
 */
export async function settleClaim(
  rpc: Any, sdk: Any, opened: Opened, utxo: Any, state: State,
  parties: { buyerPubkey: string; providerPubkey: string; buyerSig: string; providerSig: string },
  network: Network,
): Promise<Claim> {
  const tag = opened.entries.settle?.dispatch_tag;
  if (!tag) throw new Error('the compiled covenant has no `settle` entry');

  const redeem = withState(opened.hex, state.seq, state.cumulativeSompi);
  const address = await covenantAddress(redeem, network);
  const amount = utxo.amount - SETTLE_FEE;

  const spend = sdk.createTransaction([utxo], [{ address, amount }], 0n, undefined, 0);
  spend.version = 1;
  spend.gas = 0n;
  spend.inputs[0].sigOpCount = 0;
  // Sized to the COSTLIEST entry, not this one: `expire` does two signature checks. Finding E.
  spend.inputs[0].computeBudget = 21;
  spend.inputs[0].signatureScript = signatureScript(
    sdk,
    settleArgs(state, parties.buyerPubkey, parties.providerPubkey, parties.buyerSig, parties.providerSig),
    tag,
    opened.hex,
  );
  spend.finalize();

  const txid = (await rpc.submitTransaction({ transaction: spend, allowOrphan: false })).transactionId as string;
  const posted = await awaitUtxo(rpc, address, amount);
  if (!posted) throw new Error('the claim never posted');
  return { txid, posted, redeem, address };
}

export interface Closed {
  txid: string;
  outputs: { address: string; amount: bigint }[];
}

/**
 * Wait out the response window and pay everyone.
 *
 * The output SHAPE is computed rather than assumed. The covenant accepts exactly three and refuses
 * everything else, and guessing gets "script ran, but verification failed" -- which says nothing
 * about which rule was broken. Below the KIP-9 floor a payout cannot be its own output at all, so
 * it folds into the other party's.
 */
export async function closeCovenant(
  rpc: Any, sdk: Any, opened: Opened, claim: Claim,
  who: { buyerPubkey: string; providerPubkey: string; signerSk: string; buyerAddress: string; providerAddress: string },
  owedSompi: number,
): Promise<Closed> {
  await awaitWindow(rpc, opened.window);
  const outputs = closeOutputs(
    claim.posted.amount, BigInt(owedSompi), CLOSE_FEE, who.buyerAddress, who.providerAddress,
  );
  const close = buildExpire(
    sdk,
    {
      buyerPk: who.buyerPubkey, providerPk: who.providerPubkey, signerSk: who.signerSk,
      redeem: claim.redeem, tag: opened.entries.expire?.dispatch_tag ?? '',
    },
    claim.posted, outputs, opened.window,
  );
  const txid = (await rpc.submitTransaction({ transaction: close, allowOrphan: false })).transactionId as string;
  return { txid, outputs };
}

export { x };
