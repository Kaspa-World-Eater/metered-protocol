# Metered — a metered session scheme for x402

**Status:** Phase 0 draft. Normative. Nothing implemented.
**Version:** 0.1.0-draft.2 · 2026-09-09
**Scheme identifier:** `metered`

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as in RFC 2119.

---

## 0. Why this exists

x402 ships two schemes. `exact` transfers a fixed amount. `upto` authorises a maximum and charges
actual consumption. The `upto` specification states three non-goals:

- *"Multi-settlement / streaming"* — out of scope
- *"Recurring payments"* — out of scope
- *"Settling the same authorization multiple times (e.g. pay-per-chunk streaming)"* — not supported

and settlement is unilateral: the resource server reports consumption, the facilitator checks only
that it does not exceed the cap. There is no client verification and no dispute mechanism.

`metered` adds the two missing pieces: **babel reservation**, so a session can span many
settlements, and **two-sided measurement**, so the buyer's own count is part of what settles.

### 0.0 The babel

**A `babel` is one reserved slice of delivered work: `babelUnits` units of the Offer's `unit`.**
It is the quantum of this protocol. A Reservation authorises exactly one babel, a Measurement
reports one babel, and a State settles the running total of every babel agreed so far.

**The babel is the exposure bound.** It is the most either party can lose to the other turning
dishonest mid-session, it is fixed by the Offer before anything is spent, and every parameter in
this document is ultimately a statement about how small it can be made.

Named as the *bel* is -- a unit for a quantity that is otherwise awkward to measure -- and after
the tower, which is where two parties last stopped being able to agree on words.

### 0.1 What decided the parameters

Two studies ran before this document was written. They are in `../evidence/`, seeded and reproducible.

| Finding | Consequence |
|---|---|
| Per-babel token summation diverges by exactly 1 token in 0.08% of sessions (3 counter-examples in 3,634 adversarial trials) | `toleranceAbs` MUST be ≥ 1 **for a tokeniser** — §6 |
| Re-encoding an *interior* token slice diverges 7.6% of the time; babels tiling from zero drop that to 0.08% | Babels MUST tile from sequence position zero |
| Per-frame tokenisation is wrong by up to 21.5% (code) and 21.2% (CJK), systematically upward | Implementations MUST reassemble before tokenising |
| The same text under `o200k_base` vs `cl100k_base` differs by 40.9% on CJK | The Offer MUST name the meter; an unnamed meter is not usable |
| Checkpoint fee 0.002 KAS, latency p50 1,053 ms / p90 1,879 ms over 25 live anchors | Checkpoints MUST be non-blocking |

---

## 1. Roles and trust

| Party | Trusted for |
|---|---|
| Buyer | **Nothing.** Its measurement is a claim the provider need not believe. |
| Provider | **Nothing.** Same. |
| Kaspa consensus | Settlement and ordering. The only trust assumption. |
| Facilitator | **Nothing.** Optional convenience. Either party MUST be able to settle without one. |

There is no arbiter, oracle or reputation service. The only remedy for disagreement is to stop.

---

## 2. Canonical encoding

Every signed object is encoded identically by both parties or nothing works. A field-order
divergence between two encoders is silent, and produces signatures that verify for neither.

1. Objects are serialised as JSON with **keys sorted by UTF-16 code unit**, ascending — this is
   what RFC 8785 (JCS) mandates and what JavaScript's default `Array.prototype.sort` does.
   It is **not** the same as Unicode code-point order: they diverge above the BMP, where
   surrogate pairs (U+D800–DFFF) sort below U+E000–FFFF. `�` and `U+10000` order
   oppositely under the two rules. Field names in this version are ASCII, so nothing is
   affected today — but an implementer following the wrong rule would diverge silently the
   first time a key contained an astral character.
2. **No insignificant whitespace.** No spaces after `:` or `,`, no trailing newline.
3. Integers are JSON numbers and MUST be exactly representable — no value may exceed
   2^53−1. Sompi amounts and unit counts are integers. **Floats are forbidden. There are none in
   this protocol** — the last of them, `toleranceRel`, was removed in this version (§5 rule 4), so
   nothing settled here depends on binary floating point being reproduced identically by two
   implementations.
4. `null` is permitted only where this document names it (`prevState` at sequence 0).
5. Byte strings are **lower-case hexadecimal**, unprefixed, of the exact length stated.
6. **The signature is computed over the object with its own signature field absent**, not over a
   field set to null or empty. **BIP340 receives the canonical bytes themselves, NOT a digest of
   them.**

   That last sentence exists because its absence was a real gap, found by writing a second
   implementation. BIP340 accepts a message of any length, so signing `blake3(canonical)` is just
   as implementable as signing `canonical` and looks just as correct -- and §3.4.1 explicitly
   digests first for a State, which invites a reader to assume signing always digests first. It
   does not. **A State is the exception**, and it is the exception because a Kaspa script must
   reconstruct what it verifies and cannot build canonical JSON.
7. Digests are **BLAKE3-256**, 32 bytes, hex — **everywhere, without exception.** The message
   digest that chains States, the content digest, the session id, the parties commitment and
   the checkpoint digest all use the same function over the same canonical bytes.

   This is stated so emphatically because it was wrong. The borrowed encoder used BLAKE2b for
   message digests and BLAKE3 for content addressing, while this document called both blake3.
   An implementer following the sentence would have produced entirely different `prevState`
   values and a different checkpoint digest — total incompatibility, from one word. The
   encoder is now vendored in `src/encoding.ts` and uses BLAKE3 for all of it.
8. **Signature bytes are not canonical and MUST NOT be compared for equality.** BIP340 signs with
   random auxiliary data, so two correct signatures over the same message differ. A signature is
   *verified*, never diffed. Conformance vectors therefore pin the signing payload and its digest,
   and assert only that a signature verifies.

An implementation MUST reject an object whose re-encoding does not reproduce the bytes it verified.

**One object is signed over something other than its JSON form: the State.** Its two signatures
cover the fixed byte concatenation defined in §3.4.1, not its canonical JSON. This is not a
stylistic exception -- the covenant must reconstruct exactly what it verifies, and a Kaspa script
cannot build canonical JSON. Every rule above still governs how a State is *transmitted*; §3.4.1
governs what its signatures *cover*. An implementation that signs a State's JSON form produces a
signature the chain cannot check, and a session that cannot settle.

---

## 3. Messages

### 3.1 Offer

Sent by the provider inside the HTTP 402 response as an x402 `PaymentRequirements` with
`scheme: "metered"`. Signed by the provider. It is a commitment, not a suggestion.

| Field | Type | Rule |
|---|---|---|
| `v` | int | MUST be `1`. |
| `scheme` | string | MUST be `"metered"`. |
| `network` | string | CAIP-2-style, e.g. `"kaspa:testnet-10"`. |
| `asset` | string | `"KAS"` in this version. |
| `sessionId` | hex[16] | Provider-chosen, unique. Binds every later message. See §3.1a. |
| `unit` | string | Versioned unit identifier. §6 defines two. |
| `meter` | string | **MUST be present and resolvable, and MUST measure `unit`.** See §6. |
| `unitPriceSompi` | int | Price of one unit. MUST be ≥ 1. |
| `babelUnits` | int | Units per reservation. **This is the exposure bound.** MUST be ≥ 1. |
| `maxBabels` | int | Session ceiling. MUST be ≥ 1. |
| `toleranceAbs` | int | **MUST be ≥ the meter's floor** (§6): 0 for an exact meter, 1 otherwise. |
| `checkpointEvery` | int | Chunks between checkpoints. `0` disables checkpointing. |
| `responseWindowDaa` | int | **Relative** sequence delay. MUST be in `1..=4294967295`. See §7.3a. |
| `buyerPubkey` | hex[32] | BIP340 x-only. |
| `providerPubkey` | hex[32] | BIP340 x-only. |
| `partiesCommitment` | hex[32] | `blake3(buyerPubkey ‖ providerPubkey)`, over the 64 raw key bytes. |
| `channel` | object, optional | `{ covenantId: hex[32], vouchedSompi: int }`. The kaspa-x402 escrow channel this session settles through, and the lifetime ceiling the buyer has already vouched on it. Present iff the session settles on that rail (§3.5). `vouchedSompi` MUST be ≥ 0. |
| `sig` | hex[64] | Provider signature. |

A buyer MUST reject an Offer with a `toleranceAbs` below its meter's floor (§6), an absent or
unresolvable `meter`, a `meter` that does not measure the named `unit`, or a `responseWindowDaa`
outside the stated range.

### 3.1a `sessionId` novelty is the buyer's obligation

**A buyer MUST reject an Offer carrying a `sessionId` it has already been offered by the same
provider, and MUST retain enough history to do so for as long as it will accept Offers from that
provider.**

`sessionId` is **provider-chosen**, and every threat that its width appears to address is one the
provider is not subject to. Sixteen bytes give 128 bits against accidental collision and against a
third party trying to guess or grind one -- both real, both handled. Neither is the interesting
case. A provider does not guess its own identifiers: it picks them, and picking a previous one
costs nothing.

The consequence is that the settlement preimage of §3.4.1 is no longer unique to a session. Two
sessions sharing a `sessionId` and a `(seq, cumulativeUnits, cumulativeSompi, prevState)` produce
the *same 72 bytes*, so the buyer's signature from the first session is a valid signature for the
second. That is exactly threat X1, cross-session replay, executed by the one party for
whom no choice of width is a defence.

No larger `sessionId` fixes this, and no on-chain rule can: the covenant is instantiated per
session and cannot see the other one. **The only party positioned to catch a reused `sessionId` is
the buyer, and only by remembering.** Hence the rule above, and hence the width was reduced to 16
bytes with nothing lost -- the bytes were never doing this job.

An implementation that keeps no such history MUST document that it does not, because a buyer
without it is unprotected against a provider that reuses identifiers deliberately.

**THIS RULE IS ALSO WHAT SEPARATES THE NETWORKS.** The §3.4.1 preimage does not commit to a
network, and a redeem script hashes to the same value on every one of them -- so a State signed
for a testnet session would, in principle, settle a mainnet covenant carrying the same parties and
`sessionId`. It cannot in practice, and the reason is that the history above is keyed by provider
and identifier, **deliberately not by network**: the second Offer is refused wherever it claims to
be. The buyer also funds the covenant, so the collision cannot be created without its help.

**Binding the network into the preimage instead was measured and rejected.** It costs 4 bytes in
the hand-written covenant, which has 16 spare, and **28 bytes in the Argent port, which has none**
-- the tag becomes state, and a continuation must re-emit it. Spending the only implementation
that a compiler checks, to duplicate a guarantee §3.1a already gives, is a bad trade. An
implementation that drops the novelty rule loses network separation along with everything else,
which is the other reason it is a MUST.

### 3.2 Reservation

Signed by the buyer. Authorises **one babel**, never the session.

**A provider MUST verify that signature against the Offer's `buyerPubkey` before doing anything
else with the Reservation, and MUST refuse it otherwise.** An unverified Reservation authorises
nothing: it is not evidence the buyer asked for the work, so a provider acting on one is
delivering for free to whoever sent it, and holds no record of an authorisation to bill against.
Because `sessionId` travels in clear, "whoever sent it" includes anyone who has seen one message.

| Field | Type | Rule |
|---|---|---|
| `v` | int | MUST be `1`. |
| `sessionId` | hex[16] | MUST equal the Offer's. |
| `seq` | int | Chunk index from 0, strictly incrementing by exactly 1. |
| `units` | int | Units authorised. MUST be ≤ `babelUnits`. |
| `cumulativeUnits` | int | Running total including this babel. See below. |
| `cumulativeSompi` | int | Running amount. Recomputed and compared, never trusted. |
| `prevState` | hex[32] or null | Digest of the previous **doubly-signed** State. `null` at `seq` 0. |
| `sig` | hex[64] | Buyer signature. |

**Running from what.** Both running totals build on the previous **State**'s figures -- what was
actually settled -- plus this babel's *authorised* amount:

    cumulativeUnits  = prevState.cumulativeUnits  + units
    cumulativeSompi  = prevState.cumulativeSompi  + units x unitPriceSompi

This needs saying because §5 rule 6 bills the **lower** of the two counts, so the authorised and
settled figures diverge the first time the parties disagree by a token, and they never re-converge.
An implementation that instead accumulated its own authorised totals would drift a little further
from the settled chain on every divergent babel, and the two parties would disagree about
`cumulativeSompi` while both followed this document.

So: **a Reservation is a ceiling measured from the last settled point, and a State is a fact.** The
Reservation says *at most this much will be owed after this babel*; the State says what is owed.
`cumulativeSompi` in a Reservation is therefore an upper bound on the State that follows it, and
equal to it only when the two counts agreed exactly.

### 3.3 Measurement

Both parties emit one per babel boundary. Signed by its author.

| Field | Type | Rule |
|---|---|---|
| `v` | int | MUST be `1`. |
| `sessionId` | hex[16] | |
| `seq` | int | The babel being reported. |
| `by` | string | `"buyer"` or `"provider"`. MUST match the signing key. |
| `units` | int | Units this party counted **for this babel alone**. |
| `cumulativeUnits` | int | This party's running total. Catches drift a per-babel check misses. |
| `contentDigest` | hex[32] | blake3 over the exact bytes of this babel. See §6.3. |
| `measurementId` | hex[16] | Idempotency key. A retransmission MUST be a no-op -- see below. |
| `sig` | hex[64] | |

### 3.3a A retransmission is a no-op, not a disagreement

A Measurement carries `measurementId` so the same message can arrive twice without being counted
twice. **A party receiving a `measurementId` it has already settled MUST return the result it
returned the first time, unchanged.** It MUST NOT halt, and MUST NOT settle it again.

This is not a nicety. Retransmission is ordinary behaviour for anything carried over a network: a
client whose request times out will resend it. An implementation that treats the second copy as a
protocol violation converts a lost response -- nobody's fault, nobody's disagreement -- into a
permanently halted session, and does so most often to the honest party with the worst connection.

### 3.4 State

The only object that can settle. Carries **two** signatures.

| Field | Type | Rule |
|---|---|---|
| `v` | int | MUST be `1`. |
| `sessionId` | hex[16] | |
| `seq` | int | |
| `cumulativeUnits` | int | Agreed total. |
| `cumulativeSompi` | int | Agreed amount owed the provider. |
| `prevState` | hex[32] or null | Digest of the previous State. The session is a hash chain. |
| `buyerSig` | hex[64] | Both REQUIRED. |
| `providerSig` | hex[64] | A State with one signature is not a State. |

Both signatures are computed over the **settlement preimage** of §3.4.1 -- **not** over the
State's canonical JSON with its signature fields absent, which is how every other signed object in
this document works. See §2.

### 3.5 The voucher, when the session settles through a kaspa-x402 channel

A State is what the parties agreed. On the kaspa-x402 `batch-settlement` rail, what moves money is
a **voucher**: `{ covenantId, amount, signature }`, signed by the buyer alone, where `amount` is a
lifetime cumulative ceiling the seller may claim up to and the chain enforces only that ceiling.
Its construction -- preimage, digest, signature -- is the rail's and is not restated here; see
docs/RAIL.md and `@kaspa-x402/core`.

Two rules make the State and the voucher one act of agreement rather than two:

1. **The buyer MUST send the voucher for State `n` in the same message as its countersignature of
   State `n`**, and that voucher's `amount` MUST equal `channel.vouchedSompi + cumulativeSompi`
   of that State. A voucher for less is a buyer paying less than it agreed; for more, a buyer
   overpaying, and the provider MUST refuse either.
2. **The provider MUST NOT deliver babel `n+1` until it holds a valid voucher for State `n`.**
   Without this, a buyer could sign every State and pay for none, and the provider would hold an
   agreed debt the chain will not honour. With it, the provider's exposure is exactly one babel --
   what it always was.

A missing or wrong voucher is neither an authentication failure (§5.2) nor a disagreement (§5): the
number is agreed and the money is not yet authorised. The provider refuses the countersignature
and any further babel, states why, and the session resumes when the voucher arrives.

**How a session comes to be on a channel.** The buyer opens the channel -- it is the buyer's
money -- and then proposes it when opening the session: `POST /metered/open` MAY carry `channel:
{ covenantId, timeoutDaa, settledTotal, active: { txid, index, amount, scriptPublicKey } }`, which is
enough for the provider to rebuild the escrow script and find the UTXO. The provider MUST verify
the proposal against the chain before naming the channel in its Offer, and MUST refuse it if it
cannot verify. Only what the provider itself confirmed goes into `channel`; the buyer MUST refuse
an Offer that names a channel other than the one it proposed.

The voucher's `amount` is a property of the **channel**, not the session: a channel outlives
sessions, and each session's vouchers continue the ceiling from where the last left off. That is
what `channel.vouchedSompi` carries, and a buyer keeping its own record of it MUST refuse an Offer
whose value differs from that record.

### 3.4.1 The settlement preimage

The only bytes a State's signatures ever cover. Fixed width, fixed order, no delimiters, no
length prefixes -- the covenant reconstructs this exact layout from values it already holds, so
anything variable-length would be unreconstructable.

| Offset | Width | Field |
|---|---|---|
| 0 | 16 | `sessionId` |
| 16 | 8 | `seq` |
| 24 | 8 | `cumulativeUnits` |
| 32 | 8 | `cumulativeSompi` |
| 40 | 32 | `prevState` |
| | **72** | total |

1. Integers are **8-byte signed-magnitude**, the encoding `OpNum2Bin(x, 8)` produces. §2.3 already
   caps every integer in this protocol at 2^53−1, which is comfortably inside 8 signed-magnitude
   bytes, so the conversion is always defined. An implementation MUST still range-check before
   converting: SilverScript's undefined behaviour is **fail-open**, and an out-of-range
   `OpNum2Bin` is undefined, not a rejection.
2. `prevState` is 32 bytes always. At `seq` 0, where the JSON carries `null`, the preimage carries
   **32 zero bytes**. A `null` has no byte form and the covenant cannot branch on one cheaply.
3. The signed digest is `blake3(preimage)`, 32 bytes, per §2.7. Both parties sign **that digest**
   with BIP340. On-chain it is verified with `checkMsgSig`, which checks a signature over supplied
   data rather than over the spending transaction.
4. **`v` is deliberately absent.** A version field would cost 8 more bytes against a 520-byte
   script limit, and it is not load-bearing here: a future version changes the covenant's
   bytecode, which changes its P2SH address, which means the funds a v1 signature could be
   replayed against do not exist at a v2 address. The contract's own bytecode is the version tag.
   This is a deliberate omission with an argument, not an oversight.

---

## 4. Signer obligations

Adapted from Kurrent's stated signer policy. These are obligations on implementations, not on the
wire format, and violating them loses money without any message being malformed.

1. A party MUST sign **at most one** State for a given `(sessionId, seq)`.
2. A party MUST **durably record** the highest State it has signed **before transmitting it**.
   Record-then-send. Never send-then-record.
3. A party MUST NOT sign a State whose `prevState` does not match the digest of the State it last
   agreed to.
4. On restart, a party MUST load its highest recorded State before participating further, and MUST
   refuse to sign at a `seq` at or below it.

---

## 5. The reconciliation rule

At each babel boundary, in order. Any failure halts the session.

1. Both Measurement signatures verify, and each `by` matches the key that signed it.
2. Both `seq` equal the babel being reconciled.
3. **`contentDigest` values are equal.** If counts match but digests differ, the parties are
   describing different bytes and counting cannot resolve it.
4. `|buyerUnits − providerUnits| ≤ toleranceAbs`. **The bound is absolute and does not scale with
   the babel.** An earlier draft added a relative term. It was removed because the evidence never
   supported it: honest divergence is a boundary effect, Study A saw it three times in 3,634
   adversarial trials and every occurrence was exactly one token, and Study C found none at all at
   seven babel sizes from 3 to 550 units with 4,000 boundaries each. The magnitude does not grow
   with the babel, so a bound that grows with the babel widens the room a counterparty can shave
   in — §5.1's leak — in exchange for nothing measured.
5. The same bound holds for `cumulativeUnits`.
6. **The billed amount uses the lower of the two counts.**

### 5.0 What reconciliation produces

The rules above say what must hold. This says what comes out, because a second implementation
cannot guess it and two implementations that disagree about the OUTPUT disagree about the bill.

On success:

| Field | Value |
|---|---|
| `billedUnits` | `min(buyerUnits, providerUnits)` — rule 6 |
| `billedCumulativeUnits` | `min(buyerCumulativeUnits, providerCumulativeUnits)` |
| `residual` | `providerUnits - buyerUnits`, **signed, in that order** |

`billedCumulativeUnits` is stated because rule 6 only names the per-babel amount. An implementation
that carries the provider's cumulative figure forward instead agrees about every babel and disagrees
about the session.

The **sign** of `residual` is stated because §5.1.1 feeds it to a one-sided CUSUM. Reversing it does
not produce a detector that fires late; it produces one that ignores a counterparty shaving and
alarms on an honest one.

On failure the outcome carries a `reason`, which is one of:

`signature`, `sequence`, `content-digest`, `tolerance-babel`, `tolerance-cumulative`, `bias`.

Rule 6 removes the incentive to sit at the top of the tolerance band. It also absorbs the one-token
divergence measured in Study A, since every counter-example found had the buyer counting fewer.
That second property was luck, and is recorded as luck.

### 5.1 Bias detection — symmetric and normative

Rule 6 bills the lower count, which removes the provider's incentive to sit at the top of the
tolerance band. Phase 1 found it hands the identical trick to the **buyer**: under-reporting by
exactly `toleranceAbs` every babel pays less, systematically, and no single babel breaches
anything. At 1 token on a 550-token babel that is 0.18% — small, but a leak with no mechanism
against it.

Therefore **both parties MUST** track the signed residual `providerUnits − buyerUnits` across the
session. **The honest residual is zero to measurement** (Study C: 0 non-zero residuals in 10,013
honest babels at 50/200/550 units; 95% upper bound 0.075% at every babel size tested), so any
sustained positive drift is signal rather than noise. A party MUST halt when the test below fires.

This converts tolerance-riding from an unbounded slow leak into a bounded one: an adversary must
stay inside the tolerance *and* keep the residual centred, which means giving back what it takes.

#### 5.1.1 The test, measured rather than chosen

"A persistent one-sided residual" was normative and undefined -- no threshold, no window, no
statistic, so two implementers could not produce the same behaviour. Study C
(`evidence/results-c.txt`) measured what honest sessions actually do and sized a test against it.

**Both parties MUST run a one-sided CUSUM over the per-babel residual `providerUnits - buyerUnits`:**

    S[0] = 0
    S[i] = max(0, S[i-1] + residual[i] - k)      with k = 0.5
    halt when S[i] >= h                          with h = 5

One-sided, because the threat is directional and so is the only honest divergence ever observed:
both make the residual **positive**. Sign therefore carries no information and rate is the whole
signal -- which is what a CUSUM measures and what "persistent" was groping for.

| Buyer under-reports 1 token on | Detected | Median babels to alarm |
|---|---|---|
| every babel (the 0.18% leak §5.1 names) | 100% | 9 |
| 50% of babels | 100% | 80 |
| 25% of babels | 1% | — |
| 10% of babels | never | — |

False alarms: **zero in 800,000 honest babels** (400 sessions of 2,000).

**What this does and does not bound, stated because a reader will otherwise infer zero.** The test
catches the threat §5.1 was written for, quickly. It does **not** catch a patient buyer: below
about a quarter of babels the leak is invisible to it. So §5.1's promise of converting an
unbounded slow leak into a bounded one holds, and **the bound is roughly 0.045% per babel** -- an
order of magnitude under the named threat, and not zero. An implementation that needs a tighter
bound must reduce `toleranceAbs`, not tune `k` and `h`; below `k = 0.5` the honest rate is no
longer known to be small enough, because Study C bounds it at 0.075% rather than measuring it as
exactly zero.

---

### 5.2 Only an authenticated counterparty may halt a session

§1 says "the only remedy for disagreement is to stop". That applies to two parties who have
**authenticated themselves** and cannot agree on a measurement. It does not apply to a message
from an unknown sender.

**An implementation MUST NOT halt a session because a message failed to authenticate.** It MUST
refuse the message and leave the session untouched. Halting is reserved for failures that only an
authenticated counterparty can reach.

The distinction is load-bearing because `sessionId` is not a secret -- it is carried in clear in
every message, and it must be, since it is what binds them together (§3.1a). An implementation
that halts on any malformed input therefore lets anyone who has observed a single message destroy
the session permanently, at no cost and with no key. That is a denial of service wearing this
specification as its authorisation.

Concretely: a bad signature, an unparseable body and an oversized body are refusals. A measurement
outside tolerance, a broken State chain and a tripped bias detector are halts.

---

## 6. Units and meters

The protocol counts integers and does not know what they represent. A **unit** names what is being
sold; a **meter** names the procedure that turns delivered content into a number. The Offer carries
both, and a meter that does not measure the named unit MUST be refused -- counting tokens against a
byte price is not a rounding error, it is a different bill.

| Unit | Meter | Exact |
|---|---|---|
| `llm.output_tokens.v1` | `o200k_base` | no |
| `net.bytes_delivered.v1` | `octets` | yes |

### 6.0 Exact and inexact meters, and where the tolerance comes from

**A meter is EXACT when two correct implementations always reach the same number for the same
bytes.** That property decides `toleranceAbs`, and it belongs to the meter rather than to the
protocol:

| | Minimum `toleranceAbs` | Because |
|---|---|---|
| exact | **0**, and it SHOULD be 0 | §5 rule 3 has already agreed `contentDigest`, so the bytes are identical and the counts cannot differ. A tolerance would absorb no honest divergence and would be pure room to shave in. |
| inexact | **1** | Tokenisation is a lossy map from bytes to a count. Two implementations can agree on every byte and still differ by one token, because the boundaries belong to the tokeniser. §0.1 measured it. |

An earlier version of this document required `toleranceAbs ≥ 1` of every Offer. That rule was
derived from tokenisation and stated as though it were a property of the protocol; adding a second
unit is what made the difference visible.

### 6.1 `llm.output_tokens.v1`

Tokens in the assistant content **actually delivered to the buyer**, tokenised with the meter named
in the Offer.

**Not counted:** input tokens, system prompt, and anything the buyer does not receive.

#### Hidden reasoning tokens are out of scope

A model billing for internal reasoning the buyer never sees cannot be metered two-sided -- the
buyer cannot count what it was not given. Providers billing for hidden reasoning MUST either price
it into the delivered-token rate or use `exact` for that portion. This is a limitation of the
approach, not an omission, and it is the boundary of two-sided measurement rather than a gap in
this specification: no protocol can make a buyer able to count data it never receives.

#### Counting rules for `llm.output_tokens.v1`

1. Implementations MUST **reassemble the full babel** before tokenising. Tokenising stream frames
   separately is wrong by up to 21.5% (§0.1) and MUST NOT be done.
2. Chunks MUST **tile from sequence position zero**. Cutting a session into interior slices
   diverges 7.6% of the time; tiling from zero drops it to 0.08%. A future change to how babels are
   cut would silently reintroduce this, which is why it is normative rather than advisory.
3. `contentDigest` is blake3 over the **raw delivered bytes**, with **no normalisation** — no
   whitespace collapsing, no unicode normalisation, no trimming.
4. The `tokenizer` field MUST identify a specific, publicly obtainable tokeniser and version.
5. An implementation that cannot obtain the named tokeniser MUST **refuse the Offer**. It MUST NOT
   count with a different one. A substituted tokeniser produces a number that looks like a
   measurement and settles like one; §0.1 measured 40.9% divergence on CJK between two real
   tokenisers, so the substitute is not an approximation of the agreed unit but a different unit
   wearing its name.
6. Implementations of this specification in different languages MUST agree **token for token**,
   not merely on totals. Two tokenisers can produce the same count for one input and disagree
   about where the boundaries fall, which diverges on the next input rather than this one. This
   reference implementation pins its JavaScript tokeniser against Python `tiktoken` over §0.1's
   adversarial corpus -- CJK, emoji, combining marks, surrogate pairs, pathological whitespace --
   and compares the token IDs.

---


### 6.2 `net.bytes_delivered.v1`

**Octets of the content actually delivered to the buyer, exactly as `contentDigest` covers them.**
The meter is `octets`, and it is exact.

1. Count the bytes as delivered. **No re-encoding, no normalisation, no decompression.** If a
   transport compressed the body, the unit is the bytes the buyer received and digested, not the
   bytes before or after any transform the transport applied. `contentDigest` is computed over the
   same bytes, which is what makes the two sides agree by construction.
2. The rules of §6.1's counting section that concern *what* is counted apply unchanged:
   reassemble the whole babel before counting, and tile babels from sequence position zero.
3. `toleranceAbs` SHOULD be 0. A non-zero tolerance is permitted and is a decision to accept
   shaving, since there is no honest divergence for it to absorb.

This unit is why the protocol names a meter rather than a tokeniser. Anything a buyer physically
receives and can count -- bytes, frames, records -- fits the same machinery, and only §6 changes.

**What does NOT fit:** a resource the buyer never receives. Storage at rest has nothing delivered
to count and needs proof of continued possession, which is a different mechanism with different
assumptions. **This protocol meters delivery, not possession.**

### 6.4 Delivered content is bytes, and a transport encoding is not the content

Everything this protocol does to delivered content -- digest it under §6.3, count it under §6.1 or
§6.2, agree on it under §5 -- is defined over **bytes**. An implementation MUST NOT restrict
delivery to content expressible as text.

This is stated because it is easy to violate without noticing, and the reference implementation did
for as long as it had only ever sold tokens: every signature on its delivery path took a string, so
`net.bytes_delivered.v1` could be declared in an Offer and could not actually be served. The
specification was not wrong; the implementation was narrower than the specification, which is the
harder failure to see.

1. A transport that cannot carry arbitrary bytes MAY encode them -- JSON bodies, for instance,
   require it. This reference transport base64-encodes the babel body and names the field
   `contentB64` so that the encoding is visible at every use.
2. **The encoding is never what is metered or digested.** Both parties MUST decode before counting
   and before computing `contentDigest`. Metering the encoded form bills the buyer for roughly a
   third more than it received, and digesting it commits the parties to the encoding rather than to
   the content.
3. A lenient decoder is acceptable but MUST NOT be relied upon. Base64 decoders commonly discard
   characters outside the alphabet rather than refusing, so a corrupted field decodes to different
   bytes instead of raising. That cannot pass silently here: different bytes produce a different
   digest, and §5 rule 3 halts the session on a digest mismatch before any count is consulted.

## 7. Settlement

**Settlement is on the kaspa-x402 rail.** A metered session determines *how much is owed* by
two-sided measurement (§5) and records it in a doubly-signed State (§3.4). What moves the money is
the `batch-settlement` escrow of the Kaspa x402 reference implementation
([kaspa-x402.org](https://kaspa-x402.org)): the buyer opens a channel, signs a voucher for the
agreed cumulative total after each babel (§3.5), and the seller claims up to that ceiling. metered
does not define its own on-chain settlement, deliberately -- a second escrow covenant for Kaspa
would duplicate work already on the standards track, and the metering is the part that is new.

The full mechanics -- the voucher preimage, the channel lifecycle, the proof that a seller cannot
claim past what the buyer vouched -- are in **§3.5** and **docs/RAIL.md**, verified end to end on
testnet-10.

**Historical note.** Versions ≤ 1.x carried a self-contained SilverScript/Argent covenant with its
own `settle`/`expire` entries, chain-proven on testnet, and this section specified it. That covenant
is retained in git history and in `contracts/` for reference, but it is no longer the settlement
path and is not part of the protocol a new implementation must reproduce. The one piece of it worth
keeping in mind is §7.3a's finding, which the rail inherits:

### 7.3a The response window is the provider's DEADLINE

The window after which a channel can be refunded is the provider's deadline to claim, not merely
the buyer's protection. Once a channel ages past its timeout with value vouched-but-unclaimed, the
buyer may refund the whole balance -- including work already delivered and agreed. A provider that
never claims eventually delivers for free. The kaspa-x402 escrow enforces this with an absolute
timeout DAA score; a provider MUST claim before it, and MUST NOT delegate that obligation to a
third party.

## 8. Checkpoints

Every `checkpointEvery` babels, `digest(State)` is anchored in a Kaspa lane at a measured cost of
0.002 KAS. Checkpointing MUST be **non-blocking** — the session continues while it confirms,
because measured p90 latency is 1,879 ms.

**Checkpoints are evidence, not safety.** They prove a State existed before a given block, which
makes a stale close provable and attributable. They cannot prevent one: the covenant cannot recover
a State from a digest, so it cannot enforce a minimum `seq`. Prevention is §3.1a (novelty) and the rail's per-seq voucher.

---

## 9. Non-goals

- **Hidden reasoning tokens.** Not two-sided measurable. Permanent.
- **Watchtowers.** A party offline for the response window can be closed against unfairly.
- **Quality.** The meter counts units delivered. Whether they were any good is verification.
- **Routing or multi-hop.** Bilateral only.
- **Discovery, reputation, marketplaces.**
- **Fiat, stablecoins, cross-chain.** Native KAS in this version.
- **Privacy.** Checkpoints are public; session size and cadence leak.

---

## 10. Worked example

`worked-example.txt` is generated by `vectors.ts` using the reference encoder
(`src/encoding.ts`), with real BLAKE3 digests and real BIP340 signatures. It is a **golden vector**: an implementation that produces different bytes for the same
inputs is wrong.

It runs a six-babel session in which babel 2 exhibits the one-token divergence Study A measured
(absorbed by `toleranceAbs`, billed at 549), a checkpoint fires after babel 2, and babel 4 diverges
by 48 units and halts. Settlement is at State 3: **2,199 units, 7,982,370 sompi, 3,996,630 sompi
refunded.**

Regenerate with `npm run vectors`. CI regenerates it on every push and requires a
byte-for-byte match.

---
