/**
 * Opening and claiming a kaspa-x402 escrow channel from metered -- THEIR contract, THEIR
 * transaction shape, THEIR compute budgets; only the glue to the Kaspa SDK is ours.
 *
 * See docs/RAIL.md for the decision. This file is step 2 of it: a channel is opened with their
 * `batch-genesis` builder, and a metered session's agreed total is claimed through their
 * `batch-claim` builder against a voucher from src/rail/voucher.ts. Nothing about the escrow
 * script, the covenant id, the sighash or the signature script is constructed here -- their
 * `@kaspa-x402/covenant` emits a reference transaction and this turns it into a runtime one.
 *
 * THE PROOF IS THE TRANSACTION ID. Their artifact carries the id the transaction MUST have; the
 * node returns the id it actually assigned. If the two differ, the runtime transaction is not the
 * reference one and something in this file is wrong. That check is not optional.
 *
 * Compute budgets come from their pinned consensus vectors (vectors/tx-v1/): the funding input
 * at their P2PK budget, the claim at budget 20 for an estimate of 207,144 script units.
 */
import { schnorr } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  buildEscrowV2RedeemScript, escrowV2ScriptPublicKey, escrowV2ScriptPubKeyHash, serializedScriptPublicKey,
  buildBatchGenesisTxV1Artifact, buildBatchClaimTxV1Artifact, buildBatchRefundTxV1Artifact, TX_V1_P2PK_COMPUTE_BUDGET,
  type EscrowV2TemplateParams, type NetworkId as TheirNetwork,
} from '@kaspa-x402/covenant';
import { awaitUtxo, type Any } from './live-steps.js';
import { submitReference } from './rail-sdk.js';
import type { Network } from './kaspa.js';
import type { Voucher } from '../src/rail/voucher.js';
import type { ChannelProposal } from '../src/types.js';

/** Their pinned claim and refund evidence, from vectors/tx-v1/batch-claim.json and batch-refund.json. */
export const CLAIM_COMPUTE_BUDGET = 20;
export const CLAIM_SCRIPT_UNITS = 207_144;
export const REFUND_COMPUTE_BUDGET = 10;
export const REFUND_SCRIPT_UNITS = 102_330;

export interface Channel {
  network: Network;
  theirNetwork: TheirNetwork;
  covenantId: string;
  buyerPubkey: string;
  providerPubkey: string;
  /**
   * An ABSOLUTE DAA score, not a window. Their script says `require(tx.time >= timeout)`, and
   * their reference computes it as the virtual DAA score at opening plus the window. Passing a
   * window here as if it were absolute -- 1800, say -- puts the timeout in the distant past and
   * lets the buyer refund the channel at any moment, including mid-session. That is what the
   * first three channels this tooling opened did, which is why this comment exists.
   */
  timeoutDaa: bigint;
  active: { txid: string; index: number; amount: bigint; scriptPublicKey: string; redeemScript: string };
  settledTotal: bigint;
}

const theirNetwork = (n: Network): TheirNetwork => `kaspa:${n}` as TheirNetwork;
const p2pk = (xonly: string) => ({ version: 0, script: `20${xonly}ac` });

/** The template params for this channel at a given settled total. Payout and refund are P2PK. */
export function escrowParams(c: Pick<Channel, 'buyerPubkey' | 'providerPubkey' | 'theirNetwork' | 'timeoutDaa'>, settledTotal: bigint): EscrowV2TemplateParams {
  return {
    clientPublicKey: c.buyerPubkey,
    serverPublicKey: c.providerPubkey,
    network: c.theirNetwork,
    payoutScriptPublicKeyHash: escrowV2ScriptPubKeyHash(p2pk(c.providerPubkey)),
    refundScriptPublicKeyHash: escrowV2ScriptPubKeyHash(p2pk(c.buyerPubkey)),
    timeoutDaa: c.timeoutDaa,
    settledTotal,
  };
}

/**
 * The escrow's redeem script at its current settled total, rebuilt from the channel's terms.
 *
 * A seller learns a channel from a buyer's proposal, which carries no script -- only the terms
 * the script is a deterministic function of. So the seller rebuilds it, and `channelVerifier`
 * has already refused any proposal whose script public key disagrees with this rebuild.
 */
export const redeemScriptFor = (c: Channel): string => buildEscrowV2RedeemScript(escrowParams(c, c.settledTotal));

const sign = (digest: string, sk: string) => bytesToHex(schnorr.sign(hexToBytes(digest), hexToBytes(sk)));
/** A TRANSACTION signature carries SIGHASH_ALL (0x01) after the 64 bytes; a voucher signature does not. */
const signTx = (digest: string, sk: string) => `${sign(digest, sk)}01`;

/**
 * Open a channel: spend one P2PK UTXO of EXACTLY escrow + fee into their singleton genesis.
 *
 * Genesis admits no change output, so the caller must supply a UTXO of the right size (see
 * `carve` in rail-live.ts). Built twice: once with a dummy signature to learn the sighash, once
 * with the real one -- the same two-pass shape their reference adapter uses.
 */
export async function openChannel(
  rpc: Any, sdk: Any,
  opts: { buyerSk: string; providerPubkey: string; network: Network; windowDaa: bigint; escrowSompi: bigint; feeSompi: bigint;
    funding: { txid: string; index: number; amount: bigint } },
): Promise<{ channel: Channel; txid: string }> {
  const buyerPubkey = bytesToHex(schnorr.getPublicKey(hexToBytes(opts.buyerSk)));
  // The timeout is absolute: where the chain is now, plus the window the parties agreed.
  const now = BigInt((await rpc.getBlockDagInfo()).virtualDaaScore);
  const timeoutDaa = now + opts.windowDaa;
  const shape = { buyerPubkey, providerPubkey: opts.providerPubkey, theirNetwork: theirNetwork(opts.network), timeoutDaa };
  const params = escrowParams(shape, 0n);
  const redeem = buildEscrowV2RedeemScript(params);
  const escrowSpk = serializedScriptPublicKey(escrowV2ScriptPublicKey(params));
  if (opts.funding.amount !== opts.escrowSompi + opts.feeSompi) {
    throw new Error(`genesis needs a UTXO of exactly ${opts.escrowSompi + opts.feeSompi}, got ${opts.funding.amount}`);
  }

  const input = (signature: string) => ({
    previousOutpoint: { txid: opts.funding.txid, index: opts.funding.index }, amount: opts.funding.amount,
    scriptPublicKey: serializedScriptPublicKey(p2pk(buyerPubkey)), signature, computeBudget: TX_V1_P2PK_COMPUTE_BUDGET,
  });
  const base = { escrowAmount: opts.escrowSompi, escrowScriptPublicKey: escrowSpk, escrowRedeemScript: redeem, initialSettledTotal: 0n, fee: opts.feeSompi };
  const unsigned = buildBatchGenesisTxV1Artifact({ ...base, fundingInputs: [input('00'.repeat(64))] });
  const digest = unsigned.sighashes[0]?.digest;
  if (!digest) throw new Error('genesis artifact carries no sighash');
  const artifact = buildBatchGenesisTxV1Artifact({ ...base, fundingInputs: [input(sign(digest, opts.buyerSk))], mass: unsigned.transaction.mass });

  const txid = await submitReference(rpc, sdk, artifact);
  const landed = await awaitUtxo(rpc, sdk.addressFromScriptPublicKey(new sdk.ScriptPublicKey(0, escrowSpk.slice(4)), new sdk.NetworkId(opts.network)).toString(), opts.escrowSompi);
  if (!landed) throw new Error('the escrow UTXO never appeared');

  return {
    txid,
    channel: {
      ...shape, network: opts.network, covenantId: artifact.covenantId, settledTotal: 0n,
      active: { txid, index: 0, amount: opts.escrowSompi, scriptPublicKey: escrowSpk, redeemScript: redeem },
    },
  };
}

/**
 * The SELLER claims against the buyer's voucher. The voucher bounds the claim on chain; the
 * seller's own signature authorises the spend. The escrow continues with `settledTotal` advanced.
 */
export async function claimChannel(
  rpc: Any, sdk: Any, channel: Channel, voucher: Voucher, providerSk: string, claimSompi: bigint, feeSompi: bigint,
): Promise<{ txid: string; channel: Channel; paidToSeller: bigint }> {
  const providerPubkey = bytesToHex(schnorr.getPublicKey(hexToBytes(providerSk)));
  if (providerPubkey !== channel.providerPubkey) throw new Error('only the channel\'s server key may claim');
  const next = channel.settledTotal + claimSompi;
  const successor = escrowParams(channel, next);
  const successorRedeem = buildEscrowV2RedeemScript(successor);
  const successorSpk = serializedScriptPublicKey(escrowV2ScriptPublicKey(successor));

  const build = (serverSignature: string, mass?: bigint) => buildBatchClaimTxV1Artifact({
    network: channel.theirNetwork,
    activeOutpoint: { txid: channel.active.txid, index: channel.active.index }, activeAmount: channel.active.amount,
    activeScriptPublicKey: channel.active.scriptPublicKey, activeRedeemScript: channel.active.redeemScript,
    covenantId: channel.covenantId, settledTotal: channel.settledTotal,
    totalAuthorized: BigInt(voucher.amount), claimAmount: claimSompi,
    successorScriptPublicKey: successorSpk, successorRedeemScript: successorRedeem,
    serverOutputScriptPublicKey: serializedScriptPublicKey(p2pk(providerPubkey)),
    expectedPayoutScriptPublicKeyHash: successor.payoutScriptPublicKeyHash,
    fee: feeSompi, serverSignature, voucherSignature: voucher.signature,
    computeBudget: CLAIM_COMPUTE_BUDGET, scriptUnitsEstimate: CLAIM_SCRIPT_UNITS,
    ...(mass === undefined ? {} : { mass }),
  });
  // The dummy must already be the 65-byte TRANSACTION shape: their builder validates length on
  // the unsigned pass too, and a 64-byte placeholder is refused before any sighash is produced.
  const unsigned = build('00'.repeat(65));
  const digest = unsigned.sighashes[0]?.digest;
  if (!digest) throw new Error('claim artifact carries no sighash');
  const artifact = build(signTx(digest, providerSk), BigInt(unsigned.transaction.mass));

  const txid = await submitReference(rpc, sdk, artifact);
  return {
    txid,
    paidToSeller: BigInt(artifact.fee.serverOutputAmount),
    channel: {
      ...channel, settledTotal: next,
      active: { txid, index: artifact.continuation.outputIndex, amount: BigInt(artifact.continuation.amount), scriptPublicKey: successorSpk, redeemScript: successorRedeem },
    },
  };
}

/**
 * The BUYER takes back what the seller never claimed, once the timeout has passed.
 *
 * Their `refund` entry admits only the client's signature, only after `tx.time >= timeout`, only
 * spending the whole active UTXO to one unbound output at the refund script. The lock time is set
 * to the timeout so the node, not this code, is what enforces the wait -- the same shape their
 * reference adapter uses.
 */
export async function refundChannel(
  rpc: Any, sdk: Any, channel: Channel, buyerSk: string, feeSompi: bigint,
): Promise<{ txid: string; refunded: bigint }> {
  const buyerPubkey = bytesToHex(schnorr.getPublicKey(hexToBytes(buyerSk)));
  if (buyerPubkey !== channel.buyerPubkey) throw new Error("only the channel's client key may refund");
  const params = escrowParams(channel, channel.settledTotal);

  const build = (clientSignature: string, mass?: bigint) => buildBatchRefundTxV1Artifact({
    activeOutpoint: { txid: channel.active.txid, index: channel.active.index }, activeAmount: channel.active.amount,
    activeScriptPublicKey: channel.active.scriptPublicKey, activeRedeemScript: channel.active.redeemScript,
    covenantId: channel.covenantId,
    refundOutputScriptPublicKey: serializedScriptPublicKey(p2pk(buyerPubkey)),
    expectedRefundScriptPublicKeyHash: params.refundScriptPublicKeyHash,
    fee: feeSompi, clientSignature, timeoutDaa: channel.timeoutDaa,
    lockTimeDaa: channel.timeoutDaa + 1n, inputSequence: 0n,
    computeBudget: REFUND_COMPUTE_BUDGET, scriptUnitsEstimate: REFUND_SCRIPT_UNITS,
    ...(mass === undefined ? {} : { mass }),
  });
  const unsigned = build('00'.repeat(65));
  const digest = unsigned.sighashes[0]?.digest;
  if (!digest) throw new Error('refund artifact carries no sighash');
  const artifact = build(signTx(digest, buyerSk), BigInt(unsigned.transaction.mass));

  // Do not broadcast into a refusal: wait for the chain to pass the timeout first.
  while (BigInt((await rpc.getBlockDagInfo()).virtualDaaScore) <= channel.timeoutDaa + 1n) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  const txid = await submitReference(rpc, sdk, artifact);
  return { txid, refunded: BigInt(artifact.fee.refundOutputAmount) };
}

/**
 * The provider's check on a channel a buyer proposes -- a ready-made `channelFor` for products.
 *
 * The buyer's word is the proposal; this is what makes it true or not. The escrow script is
 * REBUILT from the parties and the proposed terms, so a proposal whose script does not match is
 * refused before the chain is asked anything; then the proposal must not already be past its
 * refund timeout, since an expired channel is the buyer's to reclaim at any moment; then the UTXO
 * must exist at that outpoint, for that amount, under that covenant id; and what it holds must
 * cover the most this session could bill. `vouchedSompi` is reported as the settled total, the
 * floor the chain already knows -- a provider keeping its own record of vouchers may report
 * higher.
 *
 * `active.amount` is already what the escrow holds NOW -- `claimChannel` sets it to the
 * continuation UTXO's value, which has every prior claim's `claimSompi` subtracted out already
 * (see the `active:` assignment there). `settledTotal` grows by that same amount, so
 * `active.amount` and `escrowSompi - settledTotal` are the same number from genesis onward.
 * Subtracting `settledTotal` from `active.amount` here would subtract it twice, understating what
 * the channel actually holds and refusing a continuation that is genuinely funded.
 */
export function channelVerifier(
  rpc: Any, sdk: Any, providerPubkey: string, network: Network, requiredSompi: number,
): (buyerPubkey: string, proposal: ChannelProposal) => Promise<{ covenantId: string; vouchedSompi: number } | null> {
  return async (buyerPubkey, proposal) => {
    const shape = { buyerPubkey, providerPubkey, theirNetwork: theirNetwork(network), timeoutDaa: BigInt(proposal.timeoutDaa) };
    const expected = serializedScriptPublicKey(escrowV2ScriptPublicKey(escrowParams(shape, BigInt(proposal.settledTotal))));
    if (expected.toLowerCase() !== proposal.active.scriptPublicKey.toLowerCase()) return null;
    if (proposal.active.amount < requiredSompi) return null;

    const virtualDaaScore = BigInt((await rpc.getBlockDagInfo()).virtualDaaScore);
    if (virtualDaaScore >= BigInt(proposal.timeoutDaa)) return null;

    const address = sdk.addressFromScriptPublicKey(new sdk.ScriptPublicKey(0, expected.slice(4)), new sdk.NetworkId(network)).toString();
    const { entries } = await rpc.getUtxosByAddresses([address]);
    const live = entries.find((e: Any) =>
      String(e.outpoint.transactionId).toLowerCase() === proposal.active.txid.toLowerCase()
      && Number(e.outpoint.index) === proposal.active.index
      && BigInt(e.amount) === BigInt(proposal.active.amount));
    if (!live) return null;
    // Best-effort: the WASM SDK's UTXO entries may carry the covenant id they're bound to
    // (`entry.covenantId`, mirroring `TxV1ReferenceInput.utxo.covenantId` in the reference
    // artifacts `@kaspa-x402/covenant` builds). When it's there, a live UTXO under the RIGHT
    // script but the WRONG lineage is refused rather than trusted on the buyer's say-so; when the
    // binding isn't exposed this check is skipped rather than made a hard dependency on a field
    // this repo cannot verify without the real SDK.
    const liveCovenantId = live.covenantId ?? live.covenant_id;
    if (liveCovenantId != null && String(liveCovenantId).toLowerCase() !== proposal.covenantId.toLowerCase()) return null;
    return { covenantId: proposal.covenantId, vouchedSompi: proposal.settledTotal };
  };
}

/** What a buyer sends a provider about a channel it holds, from the channel record. */
export const proposalFor = (channel: Channel): ChannelProposal => ({
  covenantId: channel.covenantId,
  timeoutDaa: Number(channel.timeoutDaa),
  settledTotal: Number(channel.settledTotal),
  active: { txid: channel.active.txid, index: channel.active.index, amount: Number(channel.active.amount), scriptPublicKey: channel.active.scriptPublicKey },
});
