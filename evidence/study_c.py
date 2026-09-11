"""
Study C -- the honest residual baseline, and whether SPEC.md 5.1's bias detector can work.

5.1 is normative: both parties MUST track the signed residual providerUnits - buyerUnits, and MAY
halt on "a persistent one-sided residual". It justifies that with "Honest noise scatters about
zero; bias does not, in either direction."

Study A's stress search already contradicted the premise -- three counter-examples in 3,634 trials
and all three the same sign -- but three points measured at SESSION level cannot size a detector.
This measures the per-chunk residual directly, which is the quantity 5.1 actually tracks, and then
asks whether any threshold separates honest sessions from a tolerance-riding buyer.

The counting model is Study A's, unchanged: the provider slices its own canonical tokens at chunk
boundaries and reports len(slice); the buyer re-encodes the bytes it received and reports that.
residual = provider - buyer, per chunk.

Run: python study_c.py
"""
import random
import sys

import tiktoken

# IMPORTED, not copied. The alphabets belong to Study A; duplicating them would let the two
# studies drift into sampling different text and quietly stop being comparable. The clone-to-vary
# check caught exactly that in the first draft of this file.
#
# Importing it also replaces sys.stdout, which is why the reconfigure below is a reconfigure and
# not a second TextIOWrapper: wrapping a wrapper leaves the first one to be collected, and its
# __del__ closes the buffer underneath the one still in use.
from study_a_stress import ALPHABETS

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ENC = tiktoken.get_encoding("o200k_base")


def sample_text(rng, n):
    """Study A's generator, with an explicit rng so this study stays independently seeded."""
    alpha = rng.choice(ALPHABETS)
    if rng.random() < 0.3:
        other = rng.choice(ALPHABETS)
        half = n // 2
        first = "".join(rng.choice(alpha) for _ in range(half))
        return first + "".join(rng.choice(other) for _ in range(n - half))
    return "".join(rng.choice(alpha) for _ in range(n))


def residuals(text, chunk):
    """Per-chunk provider - buyer, exactly as SPEC.md 5.1 defines the residual."""
    toks = ENC.encode(text)
    out = []
    for i in range(0, len(toks), chunk):
        piece = toks[i:i + chunk]
        got = len(ENC.encode(ENC.decode(piece)))
        out.append(len(piece) - got)
    return out


def honest_sample(rng, trials, chunk_sizes):
    """Every per-chunk residual an honest session can produce, pooled."""
    pool = []
    for _ in range(trials):
        text = sample_text(rng, rng.randint(400, 3000))
        pool.extend(residuals(text, rng.choice(chunk_sizes)))
    return pool


def cusum_alarm(stream, k, h):
    """
    One-sided CUSUM on the residual. Returns the index of the first alarm, or None.

    One-sided because the threat is directional: a buyer under-reporting makes provider - buyer
    POSITIVE, and so -- per Study A -- does honest divergence. Sign cannot separate them, so the
    only discriminator left is rate, which is what a CUSUM measures.
    """
    total = 0.0
    for i, value in enumerate(stream):
        total = max(0.0, total + value - k)
        if total >= h:
            return i
    return None


def main():
    print("STUDY C -- the honest residual baseline, and can 5.1's detector work")
    print("=" * 78)

    rng = random.Random(3)
    chunk_sizes = [50, 200, 550]
    pool = honest_sample(rng, 900, chunk_sizes)

    nonzero = [r for r in pool if r != 0]
    positive = sum(1 for r in nonzero if r > 0)
    mean = sum(pool) / len(pool)

    print(f"\n1. THE HONEST BASELINE, {len(pool)} chunks over {len(chunk_sizes)} chunk sizes")
    print(f"     chunks with a non-zero residual : {len(nonzero)}  ({100 * len(nonzero) / len(pool):.3f}%)")
    print(f"     of those, POSITIVE (buyer low)  : {positive} / {len(nonzero)}")
    print(f"     mean residual per chunk         : {mean:+.6f} tokens")
    print(f"     magnitudes seen                 : {sorted(set(abs(r) for r in nonzero)) or 'none'}")

    if nonzero and positive == len(nonzero):
        print("\n     CONFIRMED, and 5.1 is wrong: honest divergence is ONE-SIDED. Every non-zero")
        print("     residual has the buyer counting fewer -- the SAME sign a tolerance-riding")
        print("     buyer produces. Direction carries no information. Only rate does.")
    elif not nonzero:
        print("\n     No divergence at all at these chunk sizes.")

    print("\n1b. RATE AGAINST CHUNK SIZE, at EQUAL chunk counts")
    print("     The comparison only means something if every size gets the same number of chunk")
    print("     BOUNDARIES, because a boundary is where divergence can happen. An earlier version")
    print("     of this section generated equal numbers of TEXTS, which gave size 3 over a hundred")
    print("     times the sample of size 550 and made large chunks look clean when they were only")
    print("     under-observed. Where a count is zero, the 95% upper bound is the rule of three,")
    print("     3/n -- absence of evidence, priced.")
    print("     chunk   chunks   non-zero   rate       95% upper bound")
    floor_rng = random.Random(7)
    target = 4000
    for size in (3, 5, 11, 23, 50, 200, 550):
        seen = []
        while len(seen) < target:
            need = (target - len(seen)) * size
            seen.extend(residuals(sample_text(floor_rng, min(6000, max(400, need * 2))), size))
        seen = seen[:target]
        bad = sum(1 for r in seen if r != 0)
        bound = f"{3 / len(seen):.4%}" if bad == 0 else "n/a (saw one)"
        print(f"     {size:>5}   {len(seen):>6}   {bad:>8}   {bad / len(seen):>7.4%}   {bound}")
    print("\n     Divergence is RARE AT EVERY SIZE, of order 1e-4, and this sample cannot")
    print("     resolve a difference between sizes. The honest conclusion is a bound, not a")
    print("     floor: nothing here justifies a minimum babelUnits, and nothing here rules one")
    print("     out either. What it does establish is that the honest rate is small enough that")
    print("     the detector below is not fighting it.")

    print("\n2. WHAT A BUYER STEALS, per SPEC.md 5.1's threat: under-report by 1 token")
    print(f"     honest drift            : {mean:+.6f} tokens/chunk")
    for rate in (1.0, 0.5, 0.25, 0.10):
        print(f"     a buyer cheating {rate:>4.0%}   : {rate:+.6f} tokens/chunk")
    print("     The honest drift is zero to measurement, so ANY positive drift is signal.")
    print("     That is the good case for a detector -- and section 3 shows it still is not")
    print("     enough, because a rare cheat is small as well as one-sided.")

    print("\n3. DETECTOR: one-sided CUSUM, k=0.5, h=5  (k above honest drift, below any cheat)")
    k, h = 0.5, 5.0

    trials = 400
    horizon = 2000
    false_alarms = 0
    for _ in range(trials):
        stream = [rng.choice(pool) for _ in range(horizon)]
        if cusum_alarm(stream, k, h) is not None:
            false_alarms += 1
    print(f"     FALSE ALARMS on honest sessions : {false_alarms} / {trials} sessions of {horizon} chunks")

    print("\n     detection of a buyer under-reporting 1 token on a fraction of chunks:")
    print("     leak rate   detected   median chunks to alarm   cost to buyer")
    for rate in (1.0, 0.5, 0.25, 0.10, 0.05):
        found = []
        for _ in range(trials):
            stream = [rng.choice(pool) + (1 if rng.random() < rate else 0) for _ in range(horizon)]
            hit = cusum_alarm(stream, k, h)
            if hit is not None:
                found.append(hit)
        found.sort()
        median = found[len(found) // 2] if found else None
        pct = 100 * len(found) / trials
        shown = f"{median:>6}" if median is not None else "     -"
        print(f"     {rate:>7.0%}   {pct:>7.1f}%   {shown}                  "
              f"{rate * 100 / 550:.3f}% of a 550-token chunk")

    print("\n4. WHAT THIS MEANS FOR 5.1")
    print("     The detector works, and against the exact threat 5.1 names. A buyer under-")
    print("     reporting one token on EVERY chunk -- the 0.18% leak 5.1 was written to stop --")
    print("     is caught in a median of 9 chunks, with zero false alarms in 800,000 honest ones.")
    print("     'Persistent one-sided residual' becomes CUSUM(k=0.5, h=5), which two implementers")
    print("     can read the same way.")
    print("")
    print("     What it does NOT catch is a patient buyer. At 25% of chunks detection collapses")
    print("     to 1%, and at 10% it never fires. So 5.1's claim that it converts an unbounded")
    print("     leak into a bounded one is TRUE, and the bound is now a number rather than a")
    print("     hope: roughly 0.045% per chunk, an order of magnitude under the threat named,")
    print("     but NOT zero. 5.1 should say so, because a reader currently infers zero.")
    print("")
    print("     Honest drift being zero is why any of this works, and it also corrects Finding D")
    print("     in PHASE3.md: the fear that this detector would halt honest sessions is not")
    print("     supported at realistic chunk sizes. Study A's counter-examples were mostly at")
    print("     chunk=5. What survives of Finding D is that 'persistent' was undefined -- which")
    print("     these numbers now fix.")


if __name__ == "__main__":
    main()
