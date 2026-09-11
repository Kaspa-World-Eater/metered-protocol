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
| `responseWindowDaa` | int | **Relative** sequence delay. MUST be in `1..=4294967295`. See §7.3. |
| `buyerPubkey` | hex[32] | BIP340 x-only. |
| `providerPubkey` | hex[32] | BIP340 x-only. |
| `partiesCommitment` | hex[32] | `blake3(buyerPubkey ‖ providerPubkey)`. |
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

## 7. Settlement

### 7.1 Cooperative close — NOT AVAILABLE in this version

~~Both parties sign an **ordinary spend** paying `cumulativeSompi` to the provider and the
remainder to the buyer. **The covenant is not executed.** This is what happens almost every time,
and keeping it off the covenant path removes nearly all the script-size pressure from the common
case.~~

**That is not implementable, and the reason is structural rather than a bug.** The session's funds
sit at a covenant P2SH address. A P2SH output cannot be spent without supplying its redeem script
and satisfying it, so **every** close executes the covenant. There is no "ordinary spend" available
to a UTXO locked by a script, and the sentence about removing script-size pressure has it exactly
backwards: a cooperative close must be a THIRD ENTRY POINT, and entry points are what script size
is made of.

**Measured, 2026-09-10.** A minimal cooperative entry -- bind the parties, check two signatures,
constrain no outputs because two consenting parties have already agreed the split -- takes the
contract from 516 bytes to **619**, against a limit of 520. It costs **103 bytes** and there are
**4** spare.

**Two custody models, and this version picked one.**

| | Funds live at | Cooperative close | Unilateral close |
|---|---|---|---|
| **Covenant** (this version) | a covenant P2SH | a third entry, +103 bytes | `settle` then `expire`, consensus-enforced |
| **Channel** (Lightning-shaped) | a plain 2-of-2 | an ordinary spend, free | pre-signed asymmetric commitments plus revocation |

They are alternatives, not complements: one UTXO cannot be both a bare 2-of-2 and a covenant. The
covenant model was chosen because consensus enforces the sequence ordering directly, which removes
revocation secrets and the entire class of bugs that comes with them. The price is that the common
case pays for a script, and §7.1 was written as though it did not.

**What a close costs today, plainly:** two transactions -- `settle`, then `expire` after
`responseWindowDaa` -- rather than one. A cooperative path would save one transaction fee and the
window. Whether a cooperative close is worth the 103 bytes it measures at is an open decision
rather than an oversight, and it is recorded here so a later version can take it up deliberately.

### 7.2 Unilateral close

Used when a counterparty is unresponsive or a party refuses to co-sign. Three paths:

**Two entry points, not three.** Phase 1's script budget found that three paths plus a
continuation state does not plausibly fit in 520 bytes, and that `supersede` need not be its own
entry — it is a guard on `settle`.

| Path | Who | What consensus enforces |
|---|---|---|
| `settle` | Either party with a doubly-signed State | Both signatures verify against `partiesCommitment` over the §3.4.1 preimage. **If a State is already pending, this one MUST carry a strictly higher `seq`** — this is supersede, as a guard rather than a branch. **`settle` pays no one.** It posts the claim: the single output returns the funds to this same covenant carrying `(seq, cumulativeSompi)` as state, and the response window restarts. |
| `expire` | Either party after the response window | Pays out the pending claim — `cumulativeSompi` to the provider, the remainder to the buyer. **If no claim was ever posted, refunds the buyer entirely.** |

**Settlement is two-phase, and it has to be.** An earlier draft of this table said `settle` "pays
exactly `cumulativeSompi` and the remainder" *and* that a later `settle` supersedes it. Those
cannot both hold: once the money is paid the covenant is spent and there is nothing left to
supersede. §7.5's "a stale close that has already been **accepted**" was always describing a
posted claim, not a completed payout. Found by writing
the covenant.

### 7.2a One covenant per transaction

**A closing transaction MUST spend exactly one covenant input.** `expire` enforces
`tx.inputs.length == 1`.

The reason is that `expire` pays to `P2PK(buyer)` and `P2PK(provider)`, and those scripts are not
session-specific. Two sessions between the same two parties therefore produce **identical output
scripts**, so one pair of outputs can satisfy both inputs' checks at once -- each input reads its
own `total` and each is separately satisfied, while only one payout exists.

Measured before the rule was added: two covenant inputs of 10,000,000 sompi each, closed with
outputs totalling 9,600,000, was **accepted**. 10,400,000 sompi -- more than half the money --
went to fee. Either party can sign such a transaction, so it is a griefing attack against whoever
has more at stake.

`settle` is not exposed the same way, because its single output is the continuation P2SH and that
script embeds the `sessionId`; two sessions cannot share one. The rule is nonetheless stated for
the whole scheme rather than for one entry, because the property being relied on is that **a
covenant accounts for every input carrying it**, and a future entry that pays to a
non-session-specific script would reintroduce this without warning.

Found by reading Argent's leader/delegate input-group invariants, whose Rule 3 requires exactly
this accounting.

### 7.3 The response window is relative, not absolute

`this.age` in SilverScript lowers to `OpCheckSequenceVerify`, which reads the spending input's
`sequence` field — **not** a current-DAA context. Therefore:

- `responseWindowDaa` is a **relative** delay, satisfied by setting the spending input's `sequence`.
- It MUST fit the low-32-bit encoding: `1..=4294967295`.
- The disabled bit (`1 << 63`) MUST be unset. Mask `0x00000000ffffffff`.

### 7.3a The window is the provider's DEADLINE

Because the delay is relative to the **covenant UTXO being spent**, the clock starts when the
covenant is funded and every `settle` restarts it by creating a fresh output. That has a
consequence §7.3's mechanics do not state, and it is the sharpest rule in this document:

**Once the covenant UTXO is older than `responseWindowDaa` and no claim is pending, the buyer can
`expire` and take back everything — including payment for work already delivered and already
agreed in doubly-signed States.**

**A provider MUST therefore post a claim before that deadline, and MUST choose
`responseWindowDaa` long enough to do so.** A provider that delivers for longer than the window
without settling is not protected by holding signed States; it is holding evidence of a debt the
chain will shortly release.

The provider is not otherwise exposed. It holds a doubly-signed State it can post at any moment,
and `seq > pendingSeq` is strict, so a stale claim can never overwrite a fresher one — the buyer's
only move is to get there **first**, and only while nothing is pending. The requirement is a
deadline, not a vigil.

**This is not the problem a Lightning watchtower solves, and MUST NOT be answered the same way.**
There, punishment is retrospective: an old state must be detected and answered with a justice
transaction, using per-update revocation secrets, by a wallet that is offline by nature — hence
delegation to a third party who must be trusted, can be bribed, and has to be paid. None of that
shape appears here. The party at risk is a server, online because serving is its business; it
needs only the latest State, which it already holds; there is no secret to store, no third party,
and nothing to delegate. **An implementation MUST NOT introduce one.**

Two settings bound the loss, and both are the provider's to choose:

| Setting | Bounds |
|---|---|
| post before the UTXO reaches a chosen age | how long an unposted claim may sit |
| post once unsettled value reaches a chosen amount | how much may accrue unposted |

The second is the provider's counterpart to the babel: with it, the worst a buyer can take by
waiting out the window is that amount. Without it, the bound is whatever the session can bill in
the time allowed, which is a choice too — just an implicit one.

**Each settle costs a transaction**, so a short window is safer and dearer. That trade is the
provider's, and it should be made with the numbers rather than by default.

### 7.4 Mutable covenant state is integers only

There is a NUM2BIN size cap on `byte[32]` state writes in the current compiler. Mutable covenant
state is therefore restricted to `seq` and `cumulativeSompi`, both integers. `partiesCommitment` is
a **constructor constant**, which is a different mechanism and is unaffected. `prevState` lives in
the off-chain message and is never written on-chain.

### 7.4a Dust, and the three shapes a close may take

Kaspa's KIP-9 prices an output by its reciprocal, and a transaction is refused when

    10^12 / out_1  +  10^12 / out_2  -  10^12 / in   >  500,000

The formula is the node's own, confirmed to within one sompi against a real rejection.

**THE FLOOR IS NOT A CONSTANT, and treating it as one strands funds.** An output is priced by its
reciprocal and the input's is subtracted, so what is payable depends on the OTHER output and on
how much the covenant holds. 2,000,000 is only the limit a very large transaction approaches.
`tools/dust-map.ts` walks every possible claim against the formula above and reports which of the
three shapes below, if any, consensus would accept. Against a threshold of 2,000,000 there is an
**unclosable window at every balance** -- claims for which the covenant demands an output the
network will not create, and the whole balance is stranded:

| Covenant holds | Claims with no legal close |
|---|---|
| 1 KAS | 2,000,000 .. 2,000,980 |
| 0.5 KAS | 2,000,000 .. 2,004,044 |
| 0.2 KAS | 2,000,000 .. 2,028,014 |
| 0.1 KAS | 2,000,000 .. 2,146,692 |
| 0.05 KAS | 2,000,000 .. 2,599,999 |

**So the threshold is 2,600,000, and the fold threshold 3,000,000** -- measured as the smallest
values that close the window at every balance §7.4b admits.

That is not a pricing inconvenience; it decides whether a session can be closed. A close
therefore has **exactly three legal shapes**, and an implementation MUST choose between them
rather than always emitting two outputs:

| Condition | Shape |
|---|---|
| `cumulativeSompi` < 2,600,000 | ONE output, everything to the **buyer**. Includes the no-claim case. |
| refund < 2,600,000 | ONE output, everything to the **provider**. Requires `cumulativeSompi + 3,000,000 >= total`. |
| both payable | TWO outputs: `cumulativeSompi` to the provider, the remainder to the buyer. |

**Whichever side's share is dust, the other side takes the lot.** Dust cannot be paid to anyone,
so folding it costs that party at most 0.02 KAS, and the alternative is locking the entire
balance. A provider SHOULD still price a session so the ordinary two-output close is reachable,
and MAY close cooperatively (§7.1) at any size, where an ordinary spend can pay whatever both
parties agree.

**The fold threshold is 2,400,000 rather than 2,000,000, and the difference is the fee.** The
refund is `total - cumulativeSompi - fee`, so a bound of 2,000,000 would admit refunds only up to
1,600,000 and leave everything between there and the dust floor with no legal shape at all --
another way to lock the balance. Adding the fee allowance closes that gap exactly.

This section is what a real session taught: three babels of ten words at 3,630 sompi earned
108,900, the State settled on chain, and the close was then impossible. The same session now
closes.

### 7.5 What settlement does not promise

A stale close that has already been **accepted** cannot be reversed by a later State. The response
window is the entire protection. A party offline for its duration loses. This is the honest state
of the art and matches Kurrent's stated non-claims; see §9.

---

### 7.4b The funding floor

**A buyer MUST fund the covenant with at least**

    max( maxBabels x babelUnits x unitPriceSompi + closeFee , 10,000,000 sompi )

**The second term is a SHAPE rule, not a dust rule.** A two-output close needs both halves to
clear KIP-9 *together*, and for balances from 5,700,000 to 6,800,000 sompi they cannot -- at any
split, and whatever the dust threshold is set to. `tools/dust-map.ts` walks balances in
100,000-sompi steps and finds claims with no legal close at every balance in that band, and none
at 6,850,000 or above. 10,000,000 is the next round number, and is what this rule requires.

**and MUST NOT countersign a State whose `cumulativeSompi` exceeds what the covenant holds less
that fee.**

§7.2's `expire` pays the provider an output of **exactly** `pendingSompi`. If the parties have
signed a total the covenant cannot cover -- including the fee for the very transaction that pays
it -- then no valid close transaction exists, and the entire balance is stranded. It is Finding G
again, reached by agreement rather than by dust.

**The covenant cannot enforce this and no covenant could.** It would have to know the fee of a
transaction that has not been built yet, which is not available to a script at validation time.
The buyer can, because the buyer chooses the funding amount, and it can do so before spending
anything at all. This is why the rule is normative on the buyer rather than a line of script.

---

## 8. Checkpoints

Every `checkpointEvery` babels, `digest(State)` is anchored in a Kaspa lane at a measured cost of
0.002 KAS. Checkpointing MUST be **non-blocking** — the session continues while it confirms,
because measured p90 latency is 1,879 ms.

**Checkpoints are evidence, not safety.** They prove a State existed before a given block, which
makes a stale close provable and attributable. They cannot prevent one: the covenant cannot recover
a State from a digest, so it cannot enforce a minimum `seq`. Prevention is §7.2's job.

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
