# metered

**A payment protocol for work whose size is only known once it has been delivered.**

You cannot price a language model's answer before it writes one. Today that is settled by the
seller reporting what it used, against a cap the buyer set in advance — the buyer never verifies
anything, and for a fifth of a cent, disputing it is not worth anyone's time.

`metered` replaces the invoice with an agreement. The buyer authorises one slice at a time, both
sides count what was actually delivered, and a small program on Kaspa releases the money whether or
not either party cooperates at the end.

**The buyer counts the tokens it was given — not the ones it was told about.** Everything else here
is bookkeeping around that sentence.

- **[Read the explainer](docs/index.html)** — the idea, in plain terms, for people who are not
  going to read a specification.
- **[Read the specification](spec/SPEC.md)** — normative, and the thing to argue with.
- **[Implement it](spec/CONFORMANCE.md)** — inputs and exact outputs, in a form no implementation
  can pass by accident.

---

## The two ideas

**One babel at a time.** A *babel* is one reserved slice of delivered work. The buyer authorises a
babel, receives it, counts it, agrees it, and only then authorises the next. The babel is the
exposure bound: the most either side can lose if the other turns dishonest mid-session, fixed
before anything is spent.

**Both sides count.** After each babel the buyer measures it too, with the same tokeniser the
seller named up front. The seller's figure stops being an invoice and becomes a claim standing next
to the buyer's. If they agree within tolerance, the lower figure is billed. If they do not, the
session stops — there is no arbiter, because an arbiter would have to be trusted.

Neither party is trusted for anything. The arithmetic does not leave room.

## What is here

| | |
|---|---|
| `spec/SPEC.md` | the protocol, normatively |
| `spec/CONFORMANCE.md` | how to check an implementation, and the four traps that catch people |
| `spec/conformance-vectors.json` | 27 cases: canonical bytes, the settlement preimage, signatures, reconciliation, settlement |
| `spec/worked-example.txt` | a complete session, generated, with real signatures |
| `src/` | reference implementation, TypeScript |
| `impl-py/` | a second implementation, Python, written from the specification alone |
| `contracts/` | the covenant, twice: hand-written SilverScript and an Argent port |
| `evidence/` | the measurements behind every number in the specification |
| `tools/` | chain tooling — settle, close, anchor, and an end-to-end demo |

## Verifying it yourself

```bash
npm install
npm test                 # 176 tests
npm run conformance      # regenerate the vectors
npm run conformance:py   # the second implementation, against the same file
```

The second run is the one worth watching. `impl-py/` shares no code with `src/`, was written from
`spec/SPEC.md`, and implements BIP340 verification from the BIP rather than importing it. It agrees
on all 52 assertions.

The covenant suites need [SilverScript](https://github.com/kaspanet/silverscript) and a patched
debugger; the chain tooling additionally needs a rusty-kaspa WASM build (`METERED_KASPA_SDK`) and a
funded key. Neither is required to read the specification or run the conformance vectors.

## What has actually been demonstrated

Everything below ran, rather than being argued:

- **A real language model, metered end to end and settled on chain.** The model reported 10, 10, 10
  output tokens; the seller counted 10, 10, 10; the buyer independently counted 10, 10, 10.
- **Both covenants executed under real consensus** on testnet-10 — a claim posted, a stale claim
  refused by the network itself, a newer claim superseding it, the money split, and a full refund
  where no claim was ever made.
- **Two implementations agreeing** on every conformance vector.
- **A tokeniser pinned across languages**, token boundary by token boundary, against Python
  `tiktoken` on deliberately awful input: mixed scripts, emoji, combining marks, pathological
  whitespace.

Numbers worth knowing: the guarding program is **504 bytes** of a 520-byte limit; a receipt is
**72 bytes**; a timestamp record costs **0.002 KAS**; the dispute window is **600 blocks, about 60
seconds** at the ~10 blocks per second Kaspa produces. The same 600-block window would be over four
days at ten-minute block times, which is the whole reason this is built on a blockDAG.

## What has not

**It has not run on mainnet.** SilverScript is unaudited and Argent is pre-release, and this
covenant holds money. The language is the risk, not the protocol.

**Nobody outside this project has read the specification.** The second implementation is real
evidence — writing it surfaced two genuine gaps, now fixed — but it was written by the same author
from the same understanding, which is a weaker test than an independent one.

If you find a vector that is wrong, or a rule that cannot be implemented from what is written, that
is the most useful thing you can send. Both have happened already.

## Prior art

`metered` adds the two pieces [x402](https://github.com/coinbase/x402) names as out of scope:
reservation in chunks so a session can span many settlements, and two-sided measurement so the
buyer's own count is part of what settles. The chunked-quota idea is older still — telephone
networks standardised it in RFC 4006 for the same reason, that metering every unit is too expensive
and trusting the total is too risky. See [PRIOR-ART.md](PRIOR-ART.md).

## Licence

MIT. See [LICENSE](LICENSE).
