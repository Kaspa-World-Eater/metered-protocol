# Prior art read before writing any SilverScript

The build plan says to read `trillskillz/OpenSilver` and `a19q3/Kurrent` before designing the
settlement covenant. This is what came out of that, and it changes the specification in five
places. Every item here is a thing we would otherwise have discovered by compiling, or worse, by
losing money.

---

## 1. `this.age` is relative sequence, not absolute DAA

From OpenSilver's STATUS.md, established by reading the compiler:

> `this.age` lowers to `OpCheckSequenceVerify` (Kaspa's CSV), which reads `input.sequence`
> directly — not a current-DAA context. So we satisfy `this.age >= timeout_age` by setting the
> spending input's `sequence` to the desired relative-time value. Mask is
> `SEQUENCE_LOCK_TIME_MASK = 0x00000000ffffffff`; values must keep the disabled-bit (`1 << 63`)
> unset.

Kurrent states the same constraint from the other side:

> the response window must fit the Toccata low-32-bit relative-sequence encoding
> (`1..=u32::MAX` DAA score units)

**Change to the spec.** The Offer's `deadlineDaa` is wrong as written. It is not an absolute DAA
score at which a party may close — it is a **relative** delay encoded in the spending input's
sequence field, bounded to `1..=u32::MAX`. Rename to `responseWindowDaa`, document it as relative,
and state the encoding rules including the disabled-bit.

---

## 2. There is a NUM2BIN size cap on `byte[32]` state writes

OpenSilver hit this and had to refactor two patterns around it:

> Refactored Ownable and SocialRecovery from `byte[32] owner` (blake2b hash) to
> `pubkey owner + bool has_pending_owner` gating. ... Upstream compiler patch to use OP_PUSHDATA
> for `byte[32]` state writes would unblock a future hash-keyed variant.

**Change to the spec.** Our `State` carries `prevState`, a 32-byte digest. That field cannot live
in *mutable covenant state*.

It does not need to. The signatures are over a State the spender supplies in the witness; the
covenant only needs enough on-chain to adjudicate a supersede. So:

- **Mutable covenant state: integers only** — `seq` and `cumulativeSompi`.
- `partiesCommitment` stays a constructor constant, which is a different thing and is fine.
- `prevState` stays in the off-chain message, where it chains the session and is never written
  on-chain.

---

## 3. The one-state-per-seq rule, which our spec was missing entirely

Kurrent's security assumptions:

> Signer policy assumes participants sign at most one state root for a given
> `(scope_id, state_number)` pair and durably record the highest signed state.

**Change to the spec.** This is a normative obligation on implementations and it was absent from
our design. A party that signs two different States at the same `seq` has handed the counterparty
a choice of which to settle, and will lose. Both halves matter:

- MUST sign at most one State per `(sessionId, seq)`.
- MUST durably record the highest signed State *before* transmitting it, not after.

The second half is the one that gets implemented wrong. Record-then-send, never send-then-record.

---

## 4. Independent confirmation that checkpoints are evidence, not safety

Kurrent, on the same question:

> Monitoring evidence may use KIP-21 lane proofs as an observability substrate, but KIP-21 is not
> itself the bilateral fund-safety primitive.

That is section 09 of our build document, arrived at independently. Good — but note what follows
from it, which our document stated less sharply than Kurrent does:

> This repository does not claim ... that a higher state can reverse a stale settlement after that
> stale settlement has already been accepted.

**Once a stale close is accepted, it is final.** The challenge window is the entire protection,
and a party offline for its duration loses. Our watchtower non-goal is correct and is the honest
state of the art, not a shortcut we are taking.

---

## 5. The happy path should not touch the covenant at all

Not stated in either repo — this follows from the size problem, and from how Lightning is built.

Our covenant needs three paths, two signature checks, output-amount enforcement, and a
continuation state for supersede. `job_escrow_v2.sil` needed six measured reduction passes to reach
**514 bytes** with three paths and a simpler job, so a metering covenant with continuation state is
genuinely at risk of not fitting.

**Change to the design.** Split the two cases:

- **Cooperative close (the normal path).** Both parties sign an ordinary spend paying the final
  split. No covenant logic executes. Small, cheap, and it is what happens almost every time.
- **Unilateral close (the exception).** The covenant path, with the response window and supersede.

This is standard channel practice and it moves nearly all the byte pressure off the common case.
The covenant still has to fit, but it only has to handle the argument.

---

## Useful things also worth knowing

**`#[covenant.singleton(mode = transition, termination = allowed)]`** is the supported shape for a
state transition with an optional continuation output — `next_states` comes in from the caller and
the policy pins every field with `require(...)`. OpenSilver's `streaming-payment.sil` is a worked
example. Note that it is *on-chain* streaming, a transaction per claim, so it is the wrong shape
for metering — but the transition machinery is exactly what supersede needs.

**`return` must be last**, and there is a fixture-backed lowering for the singleton sugar.

**Kurrent requires specific rusty-kaspa commits** for the lane-proof RPC (`2787953e`) and a
covenant-output RPC conversion fix (`9fdbaf1b`). Anything we build against lane proofs needs
`origin/master` or a descendant preserving those.

**`reorg_tolerance_daa` belongs in the channel policy hash** — the finality policy is part of what
the parties agree to, not an implementation detail.

**OpenSilver's `escrow-bilateral.sil` uses `byte[34]` for a P2PK scriptPubKey**; our covenant code
uses 36 bytes including a two-byte version prefix. One of us is wrong about the encoding and it is
worth resolving before either is trusted.
