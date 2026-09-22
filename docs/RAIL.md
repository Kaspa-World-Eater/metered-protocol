# metered on the kaspa-x402 rail

**Decision (2026-09-12):** metered keeps its reconciliation and gives up its covenant. Settlement
moves onto the `batch-settlement` binding of the Kaspa x402 reference implementation
([kaspa-x402.org](https://kaspa-x402.org), `@kaspa-x402/*` on npm). This document records what was
verified in their code before that was decided, and the resulting design.

## Why

Two projects had built the same thing. Theirs is on the standards track, has transaction vectors
pinned against full-consensus validation, durable-store contracts and restart recovery, and is the
implementation that will be audited first. Ours was chain-proven and ours alone. A second escrow
covenant for Kaspa helps nobody.

What they do not have — and what x402 declares out of scope — is the one thing metered is:
**the amount is derived from a quantity both parties measured independently.** In their model the
client signs a voucher for whatever the server says a request cost. In metered, both count, the
lower figure is billed, disagreement halts, and an exact meter runs at zero tolerance. That layer
is not redundant with anything, and it does not care which covenant holds the money.

So: **metered decides the number; their rail pays it.**

## What was verified, with where

All from `@kaspa-x402/core@0.1.0-alpha.10`, `client`, `covenant`, read on 2026-09-12.

| Fact | Where |
|---|---|
| A voucher is `{ covenantId, amount, signature }`, and `amount` is a **"lifetime cumulative settlement ceiling for the covenant lineage"** | `core/dist/index.d.ts` `interface Voucher` |
| A claim carries its own `claimAmount`, separate from the voucher | `core` `interface ClaimPayload` |
| A claim must satisfy `claim <= remaining voucher authorization` AND `claim <= unsettled actual charges` | `core` `applyBatchClaimAccounting` |
| The second of those is the server SDK's own accounting, not the covenant's. **On chain, only the voucher ceiling binds the claim** | `covenant` `buildClaimV2Args`: pushes `voucherSignature(64)`, `totalAuthorized`, `claimAmount` |
| The voucher preimage is `domainTag ‖ networkHash ‖ covenantId ‖ le64(amount)`; the signature is 64 bytes, BIP340 schnorr over `voucherDigest` | `core` `voucherPreimage`, `voucherDigest`; `client` `#signVoucher`; `covenant` `buildClaimV2Args` |
| The client's signer is an **injected adapter**: `signer.signVoucher({ digest, preimage, channel, amount })` | `client/dist/index.js` line ~1785 |
| A channel binds `clientPublicKey`, `serverPublicKey`, `payTo`, `refundAddress`, `refundTimeoutDaa`, `salt`; `covenantId` is the stable KIP-20 lineage and does not change on rotation | `core` `interface ChannelConfig`, `ChannelState` |
| Genesis, top-up, claim and refund are prepare-then-broadcast transitions with durable attempt records; mainnet fails closed unless `allowMainnet: true` | `client/README.md`, `server/README.md` |

## The design

### The voucher is signed after reconciliation, never before

This is the whole of the integration and the one place it could go wrong.

Because the chain enforces only the voucher ceiling, a voucher for the *reservation* would let a
seller claim the full reservation after under-delivering — precisely the outcome metered exists to
prevent. So the sequence per babel is:

1. Buyer signs a metered **Reservation** for up to `babelUnits` — off-rail, as today. This is the
   seller's authority to deliver, not a payment.
2. Seller delivers; both count; both sign the metered **State** with the agreed `cumulativeSompi`.
3. Buyer signs a kaspa-x402 **voucher** for exactly `state.cumulativeSompi`.

The voucher is what consensus honours. The State is why that number is right: the doubly-signed
record of units and digest that justifies it. Both are kept. Neither replaces the other.

**Exposure is unchanged.** Under metered's own covenant, a seller holding a Reservation but no State
could not settle it either — the covenant paid States. One babel of delivered-but-not-yet-agreed
work was always the seller's exposure, and it still is. The buyer's exposure stays zero beyond what
it has agreed.

### The voucher travels with the countersignature, and the seller waits for it

Found while proving step 2. Under metered's own covenant, a doubly-signed State was itself
settleable: the seller holding one could post it. On their rail the State and the voucher are two
signatures, and only the voucher moves money. So a buyer could sign the State — agreeing the number,
keeping the session alive — and withhold the voucher, and the seller would hold an agreed debt it
cannot claim.

Two rules close that, and both are the integration's, not theirs:

1. **The buyer sends the voucher in the same request as its State countersignature.** They are one
   act of agreement, and splitting them across round trips is what creates the gap.
2. **The seller MUST NOT deliver babel N+1 until it holds a valid voucher covering State N.** With
   that, the seller's exposure is exactly one babel — the same as it always was.

Implemented as SPEC §3.5: the Offer carries `channel: { covenantId, vouchedSompi }`; the countersign
carries the voucher; the provider verifies it on arrival, holds it, and refuses the next babel
without it. A missing or wrong voucher is a 400 with the reason, not a halt -- the session resumes
when the voucher arrives. Proven live on testnet-10 (2026-09-22: genesis [`266fe312667f3ab682146f7da339b3e8398c2ee8fc85b8ff6c9a0d2096aded03`](https://explorer-tn10.kaspa.org/txs/266fe312667f3ab682146f7da339b3e8398c2ee8fc85b8ff6c9a0d2096aded03),
claim [`d9f499a373603b4c7eb3c9717cb8602156d8e1ada57e707381488f8162e13aca`](https://explorer-tn10.kaspa.org/txs/d9f499a373603b4c7eb3c9717cb8602156d8e1ada57e707381488f8162e13aca)) with the provider claiming the voucher it received on the wire, not one derived
out of band.

### One channel per buyer–seller pair, many sessions

Their channel is between two keys and is meant to be reused. metered's session is between the same
two keys and is deliberately short. So the channel outlives sessions: a buyer opens a channel with
a seller once (genesis), runs any number of metered sessions against it, and vouchers advance the
channel's lifetime cumulative ceiling across all of them. The metered `sessionId` remains what it
is — a replay boundary for States — and the Offer additionally carries the `covenantId` the
vouchers bind to.

### What metered keeps, drops and gains

| | |
|---|---|
| **Keeps** | SPEC §2–§6 entire: canonical encoding, the messages, signer obligations, reconciliation, units and meters, the 72-byte preimage, both implementations, the conformance suite. `spigot` unchanged in concept. |
| **Drops** | SPEC §7's own covenant — `contracts/metered_session.sil`, `contracts/metered.ag`, and the chain tooling that funds, settles and closes it. Kept in history; no longer the path. |
| **Gains** | A dependency on `@kaspa-x402/core` (pinned), a `voucherForState()` that turns an agreed State into their voucher, and settlement through their channel primitives. |

### Where metered appears in their 402

metered stays a scheme of its own — `scheme: "metered"` inside the x402 v2 envelope, with its own
two-round-trip babel flow — and uses their **escrow channel** for money. It does not become a
variant of `batch-settlement`, because their per-request flow is pay-then-serve and metered's is
reserve-deliver-count-agree; folding one into the other would lose the second count. A standard
x402 client declining `scheme: "metered"` is correct behaviour for a scheme it does not know.

## Order of work

1. ✅ `voucherForState()` — their digest, byte for byte, from both their packages. `src/rail/voucher.ts`.
2. ✅ **Live on testnet-10** (first 2026-09-12; re-run 2026-09-22, the run every id below is from):
   carve [`61fa0169ee0634d5a5b63af4b1400a20de62c1873b06287108bb47abff7074cb`](https://explorer-tn10.kaspa.org/txs/61fa0169ee0634d5a5b63af4b1400a20de62c1873b06287108bb47abff7074cb),
   their genesis [`266fe312667f3ab682146f7da339b3e8398c2ee8fc85b8ff6c9a0d2096aded03`](https://explorer-tn10.kaspa.org/txs/266fe312667f3ab682146f7da339b3e8398c2ee8fc85b8ff6c9a0d2096aded03)
   (covenantId `088058206a60dfed2290b46a718f78425b3bd8916c546ec8da65055088fb0ef4`), a 4-babel session agreeing 4,587,520 sompi,
   their claim [`d9f499a373603b4c7eb3c9717cb8602156d8e1ada57e707381488f8162e13aca`](https://explorer-tn10.kaspa.org/txs/d9f499a373603b4c7eb3c9717cb8602156d8e1ada57e707381488f8162e13aca)
   paying the seller 4,087,520 and continuing the escrow at settledTotal 4,587,520. The node's
   transaction ids matched their artifacts' exactly. `tools/rail-chain.ts`, `tools/rail-live.ts`.
3. ✅ A seller cannot claim the reservation: refused by their builder, by their accounting, and by
   the script (`claimAmount <= totalAuthorized - settledTotal` under a voucher signature the buyer
   never gave). `src/rail/ceiling.test.ts`.
4. ✅ The voucher travels with the countersignature; the seller waits for it. SPEC §3.5. Live: the
   genesis → claim above.
5. Retire §7 and its tooling from the reference implementation; update SPEC and the public tree;
   publish 2.0.0, since a section leaves.
6. ✅ Refund, and the full lifecycle live: genesis (covenantId `088058206a60dfed2290b46a718f78425b3bd8916c546ec8da65055088fb0ef4`) → four vouched babels →
   claim → refund [`33ed179a05cdeb71e73e8790459c2f67b277a103f509f06a0e6213f6c56ccc48`](https://explorer-tn10.kaspa.org/txs/33ed179a05cdeb71e73e8790459c2f67b277a103f509f06a0e6213f6c56ccc48),
   14,912,480 sompi back to the buyer after the timeout.
   **Found on the way: their `timeoutDaa` is an ABSOLUTE DAA score** (`require(tx.time >= timeout)`),
   computed as virtual-DAA-at-opening plus the window. The first three channels passed a window as
   if it were absolute, putting the timeout in the past and leaving the buyer free to refund
   mid-session. Those three, and their seller keys, are gone: the escrow script embeds the seller
   key and was never saved. Channel state is now written to `~/.metered/rail/<covenantId>.json` the
   moment a channel exists -- the smallest honest version of their `ChannelStore` contract.
7. Talk to kaspa-x402.org. They found this project first; the conversation is "our scheme runs on
   your escrow, here is the evidence" — with three transaction ids attached.

### Proofs

Every transaction id in this document is 64 hex characters with an explorer link. The three that
go through their builders -- genesis, claim, refund -- also have a matching `docs/proofs/<txid>.json`:
the reference transaction itself (its hash IS the id, recomputable with `@kaspa-x402/covenant`),
the network, which builder made it, the node's virtual DAA score at submission, and the time.
`tools/rail-sdk.ts` writes it the moment the node confirms the id, before anything else happens.
The carve is an ordinary P2PK spend from the buyer's wallet and is linked, not archived.

That file exists because the first run's ids did not survive. The 2026-09-12 lifecycle was real,
but by 2026-09-22 every one of its ids returned 404 from `api-tn10.kaspa.org` — the public index
does not reach back that far — and an id nobody can fetch is the author's word, not a pin
(kaspanet/kccs#29 review). So the lifecycle was re-run on 2026-09-22 with the archive in place,
and those are the ids cited here. `src/proof.ts` refuses to write anything but a whole id.

## Caveats, stated once

Their packages are `0.1.0-alpha.10` and say so: testnet-oriented, not audited for mainnet funds.
Being theirs does not reach mainnet sooner. It puts metered on the track that will.
