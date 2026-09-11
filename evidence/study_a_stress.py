"""
Study A, adversarial follow-up.

E4 returned exactly zero divergence across every condition and chunk size, which is the answer the
design wanted and therefore the answer to distrust. Tokenisation is not compositional in general --
encode(decode(tokens)) is not guaranteed to reproduce tokens -- so a clean result on eight
hand-written strings is weak evidence.

This searches for a counter-example the way an adversary would: many texts, many boundaries,
material chosen to stress byte-pair merges across a cut.

Run: python study_a_stress.py
"""
import io
import random
import sys

import tiktoken

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
ENC = tiktoken.get_encoding("o200k_base")
random.seed(1)

ALPHABETS = [
    "abcdefghijklmnopqrstuvwxyz ",
    "abc ",                                    # short alphabet -> long merges
    "  \t\n",                                  # whitespace runs merge aggressively
    "0123456789",
    "()[]{}<>.,;:!?-_=+*/\\'\"`~@#$%^&|",
    "日本語のテキストです",
    "аб вг де ёж зи",                          # cyrillic
    "🔒⚡🎯👨‍👩‍👧‍👦🇯🇵é̂ñ",                          # multi-code-point graphemes
    "aaaaaaaaaabbbbbbbbbb",                    # pathological repetition
]


def random_text(n):
    alpha = random.choice(ALPHABETS)
    if random.random() < 0.3:                  # sometimes mix two alphabets mid-string
        other = random.choice(ALPHABETS)
        half = n // 2
        return "".join(random.choice(alpha) for _ in range(half)) + \
               "".join(random.choice(other) for _ in range(n - half))
    return "".join(random.choice(alpha) for _ in range(n))


def check(text, chunk):
    """
    Simulate the protocol exactly: provider slices its own canonical tokens at chunk boundaries,
    sends the bytes for each slice, buyer re-encodes what it received.

    Returns (provider_total, buyer_total, worst_single_chunk_delta).
    """
    toks = ENC.encode(text)
    if len(toks) < chunk * 2:
        return None
    buyer, worst = 0, 0
    for i in range(0, len(toks), chunk):
        piece = toks[i:i + chunk]
        wire = ENC.decode(piece)
        got = len(ENC.encode(wire))
        buyer += got
        worst = max(worst, abs(got - len(piece)))
    return len(toks), buyer, worst


def main():
    print("STUDY A -- adversarial search for per-chunk divergence")
    print("=" * 78)

    trials = 0
    diverged = []
    worst_seen = 0

    for _ in range(4000):
        text = random_text(random.randint(200, 3000))
        chunk = random.choice([3, 5, 7, 11, 17, 23, 50, 97, 200, 550])
        r = check(text, chunk)
        if r is None:
            continue
        trials += 1
        prov, buyer, worst = r
        worst_seen = max(worst_seen, worst)
        if prov != buyer:
            diverged.append((text[:60], chunk, prov, buyer, worst))

    print(f"\n  trials with >=2 chunks : {trials}")
    print(f"  totals that diverged   : {len(diverged)}")
    print(f"  worst single-chunk delta: {worst_seen} token(s)")

    if diverged:
        print("\n  COUNTER-EXAMPLES FOUND -- the design assumption is wrong:")
        for t, c, p, b, w in diverged[:8]:
            print(f"    chunk={c:<4} provider={p:<6} buyer={b:<6} delta={b - p:+d}  text={t!r}")
    else:
        print("\n  No counter-example found. Per-chunk summation was exact in every trial.")

    # A second, harder probe: cut at a boundary chosen to sit inside a long merge run.
    print("\n  targeted probe -- boundaries inside long repetition runs")
    bad = 0
    for word in ["a" * 200, "the " * 200, " " * 300, "0" * 200, "日" * 200]:
        toks = ENC.encode(word)
        for chunk in range(1, min(12, max(2, len(toks) // 2))):
            r = check(word, chunk)
            if r and r[0] != r[1]:
                bad += 1
                print(f"    DIVERGES chunk={chunk} {r[0]} vs {r[1]} on {word[:14]!r}...")
    print(f"    {'no divergence' if bad == 0 else str(bad) + ' divergences'}")

    # And the round-trip property on its own, which is what the above depends on.
    print("\n  round-trip property: encode(decode(slice)) == slice")
    rt_bad = 0
    for _ in range(3000):
        text = random_text(random.randint(50, 800))
        toks = ENC.encode(text)
        if len(toks) < 4:
            continue
        i = random.randrange(0, len(toks) - 2)
        j = random.randrange(i + 1, len(toks))
        piece = toks[i:j]
        if ENC.encode(ENC.decode(piece)) != piece:
            rt_bad += 1
    print(f"    arbitrary interior slices re-encoding differently: {rt_bad} / 3000")
    if rt_bad:
        print("    ^ note: interior slices are NOT how the protocol cuts. Chunks always start at 0.")


if __name__ == "__main__":
    main()
