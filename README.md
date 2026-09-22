# metered

**A payment protocol for work whose size is only known once it has been delivered.**

You cannot price a language model's answer before it writes one. Today that is settled by the
seller reporting what it used, against a cap the buyer set in advance — the buyer never verifies
anything, and for a fifth of a cent, disputing it is not worth anyone's time.

`metered` replaces the invoice with an agreement. The buyer authorises one slice at a time, both
sides count what was actually delivered, and the agreed amount settles through the
[Kaspa x402](https://kaspa-x402.org) `batch-settlement` escrow — metered decides the number, that
rail moves the money. It adds no covenant of its own.

**The buyer counts what it was given — not what it was told about.** Everything else here is
bookkeeping around that sentence.

- **[Read the explainer](https://kaspahttp402.github.io/metered-protocol/)** — the idea, in plain
  terms, for people who are not going to read a specification.
- **[Read the specification](spec/SPEC.md)** — normative.
- **[Implement it](spec/CONFORMANCE.md)** — inputs and exact outputs, in a form no implementation
  can pass by accident.

---

## The two ideas

**One babel at a time.** A *babel* is one reserved slice of delivered work. The buyer authorises a
babel, receives it, counts it, agrees it, and only then authorises the next. The babel is the
exposure bound: the most either side can lose if the other turns dishonest mid-session, fixed
before anything is spent.

**Both sides count.** After each babel the buyer measures it too, with the same *meter* the seller
named up front. The seller's figure stops being an invoice and becomes a claim standing next
to the buyer's. If they agree within tolerance, the lower figure is billed. If they do not, the
session stops — there is no arbiter, because an arbiter would have to be trusted.

Neither party is trusted for anything. The arithmetic does not leave room.

## What is here

| | |
|---|---|
| `spec/SPEC.md` | the protocol, normatively |
| `spec/CONFORMANCE.md` | how to check an implementation, and the four traps that catch people |
| `spec/conformance-vectors.json` | 36 cases: canonical bytes, the settlement preimage, signatures, reconciliation, settlement, meters |
| `spec/worked-example.txt` | a complete session, generated, with real signatures |
| `src/` | reference implementation, TypeScript |
| `impl-py/` | a second implementation, Python, written from the specification alone |
| `src/rail/`, `tools/rail-*` | settlement on the Kaspa x402 escrow — the glue, not a covenant of our own |
| `contracts/` | a self-contained covenant from versions ≤ 1.x, kept for reference (see HANDOFF.md) — no longer the settlement path |
| `evidence/` | the measurements behind every number in the specification |
| `HANDOFF.md` | what this is, for the Kaspa x402 maintainers |

## Verifying it yourself

```bash
npm install
npm test                 # 212 tests
npm run conformance      # regenerate the vectors
npm run conformance:py   # the second implementation, against the same file
```

`impl-py/` shares no code with `src/`. It was written from `spec/SPEC.md` and implements BIP340
verification from the BIP rather than importing it, so the two agree on the specification rather
than on a shared library. All 69 assertions pass. It needs Python 3.10+ and the dependency pinned
in `impl-py/requirements.txt` (`pip install -r impl-py/requirements.txt`).

Settlement (`metered-protocol/rail`) needs a rusty-kaspa WASM build (`METERED_KASPA_SDK`) and a
funded key; it depends on `@kaspa-x402/core` and `@kaspa-x402/covenant` and reimplements neither.
Neither is required to read the specification or run the conformance vectors.

## Status

A metering session settles through the Kaspa x402 escrow on **testnet-10**, end to end. Not on
mainnet: that escrow is alpha and unaudited for mainnet funds.

What has been exercised end to end:

- A metering session settled through the `batch-settlement` escrow — channel opened, each babel
  vouchered with its countersignature, the seller claiming the agreed total, the buyer refunding
  the rest, and the node's transaction ids matching the reference artifacts' required ids.
- A seller that under-delivered proven unable to claim the reservation — refused by the builder,
  the lane accounting, and the escrow script.
- Two implementations agreeing on every conformance vector.
- The tokeniser pinned across languages, token boundary by token boundary, against Python
  `tiktoken` over mixed scripts, emoji, combining marks and pathological whitespace.
- Two different units settled through the same unchanged protocol — tokens and delivered bytes —
  which is what distinguishes a unit-agnostic design from one that merely uses abstract field names.

Figures: a State is **72 bytes** signed; a checkpoint costs **0.002 KAS**; the response window is
**600 blocks, about 60 seconds** at the
roughly 10 blocks per second Kaspa produces. The same 600-block window is over four days at
ten-minute block times, which is why the settlement layer is a blockDAG.

## Prior art

`metered` adds the two pieces [x402](https://github.com/coinbase/x402) names as out of scope:
reservation in chunks so a session can span many settlements, and two-sided measurement so the
buyer's own count is part of what settles. The chunked-quota idea is older still — telephone
networks standardised it in RFC 4006 for the same reason, that metering every unit is too expensive
and trusting the total is too risky. See [PRIOR-ART.md](PRIOR-ART.md).

## Licence

MIT. See [LICENSE](LICENSE).
