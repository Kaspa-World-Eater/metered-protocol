# Conformance

**If you are implementing `metered`, this is the file that tells you whether you have.**

`conformance-vectors.json` contains inputs and the exact outputs a correct implementation must
produce. It is generated from a working implementation and checked back against it on every commit,
so it describes behaviour that runs rather than behaviour that was remembered.

You need no TypeScript, no dependency on this repository, and no agreement with any of its internal
choices. You need the same answers.

## Why this file exists

The central claim of `SPEC.md` is that **two independent implementations can measure the same
delivered work and agree**. Everything else rests on it: if two parties cannot arrive at the same
number, there is nothing to settle and the protocol is decoration.

That claim has been demonstrated once, for the tokeniser — the JavaScript encoder is pinned against
Python `tiktoken` token for token over an adversarial corpus. It has **not** been demonstrated for
the protocol, because so far there has only been one implementation of it. A specification with one
implementation is a description of that implementation, however carefully it is written.

These vectors are the invitation to fix that.

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
and change on a different schedule. The unit is only meaningful if you reproduce those too:
`llm.output_tokens.v1` counts delivered assistant content under the tokeniser the Offer names.

The covenant has its own suites — `contracts/metered_session.tests.json` and
`contracts/metered_ag.tests.json` — which execute against a SilverScript simulator rather than
against a protocol implementation.

## If you disagree with a vector

Say so. A vector that is wrong is worth more to this project than one that is right, and the
implementation that produced them has been wrong before — eight times in one audit, each recorded in
the commit history rather than tidied away. Bring the case that fails and the reasoning.

Regenerate with `npm run conformance`; verify with `npm test`.
