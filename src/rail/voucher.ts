/**
 * Turning an agreed metered State into a kaspa-x402 escrow voucher.
 *
 * THIS IS THE WHOLE OF THE INTEGRATION, and the one place it could go wrong. See docs/RAIL.md.
 *
 * The kaspa-x402 `batch-settlement` binding settles through a KIP-20 escrow channel. The client
 * signs a VOUCHER -- `(covenantId, amount)` -- and `amount` is a lifetime cumulative CEILING the
 * server may claim up to. On chain, that ceiling is the only bound on a claim. Their server SDK
 * also checks a claim against "unsettled actual charges", but that check is the server's own
 * accounting, off chain; a server that bypasses its SDK can claim the full ceiling.
 *
 * So a voucher for the RESERVATION would let a seller claim the reservation after under-delivering,
 * which is precisely the outcome metered exists to prevent. The voucher is therefore signed AFTER
 * reconciliation, for exactly the `cumulativeSompi` both parties agreed. The State is why the
 * number is right; the voucher is what consensus honours. Both are kept.
 *
 * None of the digest construction is ours. `@kaspa-x402/core` builds the preimage --
 * `domainTag ‖ networkHash ‖ covenantId ‖ le64(amount)` -- and the digest, and this file signs
 * what it is handed. src/rail/voucher.test.ts proves the digest matches theirs byte for byte.
 */
import { schnorr } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { voucherDigest, voucherPreimageHex } from '@kaspa-x402/core';
import type { State } from '../types.js';

export class VoucherRefused extends Error {}

/** Their `Voucher`, as `@kaspa-x402/core` defines it. Amounts on their wire are decimal strings. */
export interface Voucher {
  covenantId: string;
  amount: string;
  signature: string;
}

export interface ChannelRef {
  /** `kaspa:testnet-10` etc. -- the same CAIP-2 form metered's Offer carries. */
  network: string;
  /** The stable KIP-20 lineage of the channel. Does not change when the UTXO rotates. */
  covenantId: string;
}

/**
 * Sign a voucher for an agreed State.
 *
 * `previouslyVouched` is the ceiling already signed on this channel. A voucher's amount is a
 * lifetime cumulative figure for the CHANNEL, and a channel outlives sessions -- so a new session
 * on an old channel starts its accounting where the last voucher left off, and a voucher may
 * never go DOWN. Both are checked here rather than trusted to the caller.
 */
export function voucherForState(
  state: State,
  channel: ChannelRef,
  buyerSk: string,
  previouslyVouched = 0,
): Voucher {
  if (!Number.isSafeInteger(state.cumulativeSompi) || state.cumulativeSompi <= 0) {
    throw new VoucherRefused(`a State owing ${state.cumulativeSompi} sompi has nothing to vouch`);
  }
  if (!Number.isSafeInteger(previouslyVouched) || previouslyVouched < 0) {
    throw new VoucherRefused('the previously vouched ceiling must be a whole, non-negative number');
  }

  // The channel's ceiling is what was already vouched on it plus this session's agreed total.
  // Never below the last voucher: their accounting treats a lower ceiling as an error, and a
  // buyer trying to vouch less than it already has is a buyer trying to take back money it
  // agreed to.
  const amount = previouslyVouched + state.cumulativeSompi;
  if (!Number.isSafeInteger(amount)) throw new VoucherRefused('the channel ceiling would overflow');

  const input = { network: channel.network, covenantId: channel.covenantId, amount: String(amount) };
  const digest = voucherDigest(input);
  return {
    covenantId: channel.covenantId,
    amount: input.amount,
    signature: bytesToHex(schnorr.sign(hexToBytes(digest), hexToBytes(buyerSk))),
  };
}

/** Does this voucher verify against this buyer, for this channel? What their covenant checks. */
export function verifyVoucher(voucher: Voucher, channel: ChannelRef, buyerPubkey: string): boolean {
  try {
    const digest = voucherDigest({ network: channel.network, covenantId: voucher.covenantId, amount: voucher.amount });
    return voucher.covenantId === channel.covenantId
      && schnorr.verify(hexToBytes(voucher.signature), hexToBytes(digest), hexToBytes(buyerPubkey));
  } catch {
    return false;
  }
}

/** The bytes their digest is taken over, for an implementer or a vector. */
export const voucherPreimage = (channel: ChannelRef, amount: string): string =>
  voucherPreimageHex({ network: channel.network, covenantId: channel.covenantId, amount });
