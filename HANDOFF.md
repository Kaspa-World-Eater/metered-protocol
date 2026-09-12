# metered → kaspa-x402: a handoff

This document is for the kaspa-x402.org maintainers. It says what metered is, what part of it is
meant for you, what to ignore, and where the evidence is.

## The one-sentence version

**metered is a two-sided *metering* scheme that settles on your `batch-settlement` escrow.** The
buyer measures what it received, both sides sign the agreed amount, and only then does the buyer
sign a voucher for it. It is the case x402 names as out of scope — work whose price is known only
after delivery — expressed as a scheme inside the x402 v2 envelope, paying through your rail
unchanged.

It does **not** add a covenant, an escrow, a facilitator, or a wire format that competes with
yours. Where our work overlapped yours, we removed ours.

## What is the contribution (this is what to look at)

| Where | What |
|---|---|
| `spec/SPEC.md §0–§6` | the metering protocol: messages, canonical encoding, the reconciliation rule, units and meters, signer obligations, the 72-byte State preimage |
| `spec/SPEC.md §3.5` | how a session settles on your channel: the Offer names `channel: { covenantId, vouchedSompi }`; the buyer's voucher travels with its countersignature; the seller refuses the next babel without it |
| `docs/RAIL.md` | every fact we verified in your code, with file and line, and the design that follows |
| `src/` | reference implementation (TypeScript) |
| `impl-py/` | a second implementation, written from the spec alone, sharing no code — the two agree on the specification, not a library |
| `spec/CONFORMANCE.md`, `spec/conformance-vectors.json` | 36 vectors an implementation must reproduce |
| `src/rail/`, `tools/rail-chain.ts`, `tools/rail-sdk.ts`, `tools/rail.ts` | the glue between a metered State and your voucher, and between your artifacts and a node — this uses `@kaspa-x402/core` and `@kaspa-x402/covenant`, and reimplements none of them |

The npm package is `metered-protocol`. `import 'metered-protocol'` is the protocol; `metered-protocol/rail` is settlement through your escrow.

## What to ignore (legacy, not the contribution)

Versions ≤ 1.x carried a self-contained SilverScript/Argent covenant with its own `settle`/`expire`
entries. It was chain-proven, but it duplicated what your `kaspa-x402-escrow-v2` already does, so it
is no longer the settlement path. It survives in git history and under `contracts/` and the
`tools/covenant*`, `tools/chain.ts`, `tools/sigscript*` files for reference only. `metered-protocol/chain`
is that legacy path; `metered-protocol/rail` supersedes it. Nothing a new implementer needs is in there.

## The property that matters, and why it needs the second count

Your voucher is a lifetime cumulative ceiling, and on chain that ceiling is the only bound on a
claim. So the voucher **must** be signed after reconciliation, for exactly the agreed amount — never
for the reservation. If it were signed for the reservation, a seller could under-deliver and claim
the whole thing, which is the outcome metering exists to prevent. `voucherForState()` takes a
signed State and cannot be handed a reservation, because a reservation is a different type.

One rule falls out of putting a metering session on a voucher rail: agreeing the number and
authorising the money are two signatures, and only the second moves funds. So the voucher travels
in the same message as the countersignature, and the seller delivers nothing further until it holds
the voucher for the last State. The seller's exposure stays at exactly one babel.

## Evidence (testnet-10)

A metering session settled through your escrow, end to end, with the node's transaction ids
matching your artifacts' required ids at every step:

| Step | Transaction |
|---|---|
| channel genesis (`batch-genesis`) | `21203038…` covenantId, `21b0f971…` an earlier run |
| 4 babels, both sides counting | 4,587,520 sompi agreed of 5,242,880 reserved |
| claim (`batch-claim`) | `338ff973…` / `da68ff07…` — seller paid the agreed total less fee |
| refund (`batch-refund`) | `8db4d3c8…` — remainder to the buyer after the timeout |
| a claim for the *reservation* | refused by your builder, your lane accounting, and the escrow script |

A working product runs on it: **spigot** ([github.com/kaspahttp402/spigot](https://github.com/kaspahttp402/spigot))
sells files by the byte over one of your channels — open once, buy many, refund the rest, the
seller paid only for the bytes that arrived.

## Two things we found in your code while integrating

Offered in the spirit of the handoff, not as criticism:

1. **`timeoutDaa` is an absolute DAA score** (`require(tx.time >= timeout)`), computed as
   virtual-DAA-at-opening plus the window. It is easy to mistake for a relative window, and doing so
   puts the timeout in the past and removes the seller's protection entirely. Our tooling made
   exactly that mistake before we read the contract. It may be worth a sentence in the covenant
   README next to `refundTimeoutDaa`.
2. **A claim's on-chain bound is the voucher ceiling alone.** Your server SDK also checks a claim
   against "unsettled actual charges", but a server bypassing the SDK is bounded only by the signed
   ceiling. That is correct and sufficient — it is just worth stating plainly for implementers who
   settle without your server package, as we do.

## Status, plainly

- Two-sided metering, specified, implemented twice, 36 conformance vectors, 212 tests.
- Settles on your `batch-settlement` escrow; proven on testnet-10; the covenant is yours, unmodified.
- Not on mainnet — your escrow is alpha and unaudited for mainnet funds, which is the right gate.
- No competing escrow, facilitator, or wire format remains.

If any of this is useful to fold into kaspa-x402, it is offered for that. The metering is the part
worth taking; the rail underneath it is already yours.
