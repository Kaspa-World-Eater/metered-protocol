# Conformance

**If you are implementing `metered`, this is the file that tells you whether you have.**

`conformance-vectors.json` contains inputs and the exact outputs a correct implementation must
produce. It is generated from a working implementation and checked back against it on every commit,
so it describes behaviour that runs rather than behaviour that was remembered.

You need no TypeScript, no dependency on this repository, and no agreement with any of its internal
choices. You need the same answers.

## Why this file exists

A protocol whose central claim is that **two independent implementations can measure the same
delivered work and agree** is only as good as that agreement. Prose cannot establish it; identical
bytes can.

These vectors are generated from a working implementation and checked back against it, and a second
implementation written from the specification alone reproduces all of them.

## Running them

Each group names the section of `SPEC.md` it comes from. Every case has `given` and `expect`.
Compare the fields in `expect` exactly — byte for byte where they are hex, value for value
otherwise.

| Group | Section | What diverges if you get it wrong |
|---|---|---|
| canonical JSON | §2 | every digest and every signature, silently |
| settlement preimage | §3.4.1 | signatures two peers accept and the chain rejects |
| signature verification | §2.6, §3.4 | you accept forgeries, or reject honest peers |
| reconciliation | §5 | you bill a different amount than your counterparty |
| close shape and funding | §7.4a, §7.4b | funds that cannot be paid out at all |

## The four that catch people

1. **Canonical JSON sorts by UTF-16 code unit, not by code point or locale.** The vectors include a
   case where those orders differ. A sort that looks right in your language may not be.

2. **A State's signature does NOT cover its JSON.** It covers the 72-byte preimage of §3.4.1 —
   `sessionId(16) ‖ seq(8) ‖ cumulativeUnits(8) ‖ cumulativeSompi(8) ‖ prevState(32)`. Signing the
   JSON instead produces a signature your counterparty accepts and the covenant cannot check, which
   is a session that can never settle. Every other message *is* signed over canonical JSON. This one
   is the exception, and it is the exception because a Kaspa script cannot build JSON.

3. **Integers in the preimage are 8-byte signed-magnitude, little-endian** — the sign lives in the
   top bit of the last byte, not in a two's-complement representation. There is a vector with
   `seq: -1` precisely because that is where the two encodings differ.

4. **`prevState` is `null` in JSON and 32 ZERO bytes in the preimage.** A null has no byte form, so
   it is given one. Omitting those 32 bytes shortens the preimage and changes every digest after it.

## Signatures are pinned as verification, not as production

BIP340 signing is randomised: two correct implementations signing the same message produce different
bytes, and both are valid. So no vector asks you to produce a particular signature. The vectors give
you signatures and ask whether you agree they verify — including the cases where the answer is
**false**, which is the half that matters.

## What is not here

The tokeniser vectors live separately, in `../evidence/tokenizer-vectors.json`, because they are large
and change on a different schedule. `llm.output_tokens.v1` is only meaningful if you reproduce those
too: it counts delivered assistant content under the meter the Offer names, and a meter that draws
its boundaries elsewhere produces a different number for the same bytes.

`net.bytes_delivered.v1` needs no separate file. It is counted here, in §6, because an exact meter
has nothing to pin beyond the arithmetic — which is also why it is the unit that permits a
`toleranceAbs` of 0.

The covenant has its own suites — `contracts/metered_session.tests.json` and
`contracts/metered_ag.tests.json` — which execute against a SilverScript simulator rather than
against a protocol implementation.

## Reporting a disagreement

A vector that is wrong is a defect in this repository, not in the implementation that fails it.
Open an issue with the case, the value produced, and the section of `SPEC.md` relied on.

Regenerate with `npm run conformance`; verify with `npm test`.
