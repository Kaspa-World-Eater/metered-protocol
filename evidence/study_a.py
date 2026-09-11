"""
Study A -- is the metering unit symmetrically observable?

Gate 2 of the build plan. The protocol assumes a buyer and a provider can independently count the
same delivered text and agree. That assumption has never been tested, and everything downstream
rests on it, so it is tested before anything is built.

Five experiments, in order of how badly a failure would hurt:

  E1  Determinism            same bytes, same tokeniser, twice. The floor.
  E2  Stream reassembly      SSE frames can split a multi-byte character. Does reassembly recover?
  E3  Per-frame counting     the mistake the design forbids. Quantify what it costs.
  E4  Per-chunk summation    THE CRITICAL ONE. The protocol counts per chunk and sums. Tokenisation
                             is not compositional, so this may simply not hold.
  E5  Cross-tokeniser        how far apart are two tokenisers on the same text? Decides whether the
                             Offer naming a tokeniser is a nicety or load-bearing.

Run: python study_a.py
"""
import io
import json
import random
import sys

import tiktoken

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ENC = tiktoken.get_encoding("o200k_base")
random.seed(20260904)


# ----------------------------------------------------------------- test corpus
def corpus():
    """Conditions the build document says Study A must cover."""
    return {
        "prose": (
            "The provider delivers service and counts consumption against that quota. When the "
            "quota nears exhaustion or a timer expires, the network reports usage and requests "
            "more. This is the mechanism telecoms standardised in RFC 4006, and it is the reason "
            "metering is affordable at all: the authoritative system is consulted once per chunk "
            "rather than once per byte. Everything downstream is a decision about chunk size."
        ),
        "unicode_emoji": (
            "Settlement 🔒 confirmed — 0.002 KAS ⚡ anchored in block 4506c0. Café naïve résumé "
            "façade. 🇯🇵🇰🇷🇺🇸 flags are surrogate pairs. Family: 👨‍👩‍👧‍👦 is one grapheme, several "
            "code points. Math: ∑ᵢ₌₁ⁿ xᵢ → ∞ ≠ ∅. Zalgo: T̸̢̛h̷̡e̴ ̶m̵e̷t̶e̸r̴."
        ),
        "cjk": (
            "計量プロトコルは、両者が独立して同じ単位を測定できる場合にのみ機能します。"
            "측정이 일치하지 않으면 즉시 중단합니다。"
            "如果两方的测量结果不一致，就立即停止付款和服务。这是整个协议的核心。"
        ),
        "code": (
            "function reconcile(buyer, provider, tol) {\n"
            "  if (buyer.digest !== provider.digest) return { halt: true, why: 'content' };\n"
            "  const d = Math.abs(buyer.units - provider.units);\n"
            "  const allow = Math.max(tol.abs, tol.rel * provider.units);\n"
            "  return d <= allow ? { units: Math.min(buyer.units, provider.units) }\n"
            "                    : { halt: true, why: 'count' };\n"
            "}\n"
        ),
        "tool_call": json.dumps(
            {
                "name": "anchor_digest",
                "arguments": {
                    "network": "kaspa:testnet-10",
                    "digest": "08b6c521fe6bcd469119d66f5bb2d54bd17998d1088b7d3bd497c931343ec1cf",
                    "fee_sompi": 200000,
                    "note": "checkpoint at seq 40 — non-blocking",
                },
            },
            ensure_ascii=False,
        ),
        "whitespace": "a\n\n\n   b\t\t c   \n\r\n d" + " " * 40 + "e\n" * 12,
        "repetitive": "the the the " * 60,
        "long_mixed": None,  # built below
    }


def build_long_mixed(c):
    parts = [c["prose"], c["code"], c["unicode_emoji"], c["cjk"], c["tool_call"], c["prose"]]
    return "\n\n".join(parts * 4)


# --------------------------------------------------------------- stream models
def sse_frames(text, lo=1, hi=40):
    """
    Split into byte-sized frames the way a streaming API actually does -- on bytes, not characters,
    so a frame can end mid-character. This is what makes reassembly non-trivial.
    """
    raw = text.encode("utf-8")
    frames, i = [], 0
    while i < len(raw):
        n = random.randint(lo, hi)
        frames.append(raw[i:i + n])
        i += n
    return frames


def reassemble(frames):
    return b"".join(frames).decode("utf-8")


def decode_incrementally(frames):
    """A buyer decoding as frames arrive, holding back incomplete characters. The correct way."""
    dec = io.TextIOWrapper(io.BytesIO(), encoding="utf-8")  # placeholder, replaced below
    import codecs
    d = codecs.getincrementaldecoder("utf-8")()
    return "".join(d.decode(f) for f in frames) + d.decode(b"", True)


# ------------------------------------------------------------------ experiments
def e1_determinism(texts):
    bad = 0
    for name, t in texts.items():
        if ENC.encode(t) != ENC.encode(t):
            print(f"    FAIL {name}")
            bad += 1
    return bad


def e2_reassembly(texts):
    rows = []
    for name, t in texts.items():
        frames = sse_frames(t)
        whole = len(ENC.encode(t))
        naive = len(ENC.encode(reassemble(frames)))
        incr = len(ENC.encode(decode_incrementally(frames)))
        rows.append((name, whole, naive, incr, naive == whole and incr == whole))
    return rows


def e3_per_frame(texts):
    """Tokenise each frame separately and sum -- the mistake. How wrong is it?"""
    rows = []
    for name, t in texts.items():
        frames = sse_frames(t)
        whole = len(ENC.encode(t))
        # a frame may not be valid utf-8 on its own; a naive implementation decodes with replacement
        per_frame = sum(len(ENC.encode(f.decode("utf-8", errors="replace"))) for f in frames)
        err = (per_frame - whole) / whole * 100 if whole else 0
        rows.append((name, whole, per_frame, err))
    return rows


def e4_chunk_summation(texts, chunk_tokens):
    """
    THE CRITICAL EXPERIMENT.

    The protocol counts per chunk and accumulates. The provider stops at exactly N tokens, sends
    those bytes, and the buyer re-tokenises what it received. Because tokenisation is not
    compositional -- a merge can span a boundary -- the buyer's per-chunk sum may not equal the
    provider's total. If it does not, the design in section 07 is wrong.
    """
    rows = []
    for name, t in texts.items():
        toks = ENC.encode(t)
        whole = len(toks)
        if whole < chunk_tokens * 2:
            continue
        # provider slices at exact token boundaries and sends the bytes for each slice
        buyer_sum = 0
        worst = 0
        for i in range(0, whole, chunk_tokens):
            piece_tokens = toks[i:i + chunk_tokens]
            piece_bytes = ENC.decode(piece_tokens)          # what actually goes on the wire
            buyer_count = len(ENC.encode(piece_bytes))       # what the buyer independently counts
            buyer_sum += buyer_count
            worst = max(worst, abs(buyer_count - len(piece_tokens)))
        err = (buyer_sum - whole) / whole * 100
        rows.append((name, whole, buyer_sum, err, worst, whole // chunk_tokens + 1))
    return rows


def e5_cross_tokeniser(texts):
    a, b = tiktoken.get_encoding("o200k_base"), tiktoken.get_encoding("cl100k_base")
    rows = []
    for name, t in texts.items():
        na, nb = len(a.encode(t)), len(b.encode(t))
        rows.append((name, na, nb, (nb - na) / na * 100 if na else 0))
    return rows


# ------------------------------------------------------------------------ main
def main():
    c = corpus()
    c["long_mixed"] = build_long_mixed(c)
    texts = {k: v for k, v in c.items() if v}

    print("STUDY A -- is the metering unit symmetrically observable?")
    print("tokeniser: o200k_base   corpus:", len(texts), "conditions")
    print("=" * 78)

    print("\nE1  DETERMINISM -- same bytes twice")
    print("   ", "PASS" if e1_determinism(texts) == 0 else "FAIL")

    print("\nE2  STREAM REASSEMBLY -- frames split mid-character")
    print(f"    {'condition':<16}{'whole':>8}{'joined':>8}{'incremental':>13}   verdict")
    for name, whole, naive, incr, ok in e2_reassembly(texts):
        print(f"    {name:<16}{whole:>8}{naive:>8}{incr:>13}   {'ok' if ok else 'MISMATCH'}")

    print("\nE3  PER-FRAME COUNTING -- the mistake the design forbids")
    print(f"    {'condition':<16}{'correct':>9}{'per-frame':>11}{'error':>10}")
    for name, whole, pf, err in e3_per_frame(texts):
        print(f"    {name:<16}{whole:>9}{pf:>11}{err:>9.1f}%")

    for chunk in (50, 200, 550):
        print(f"\nE4  PER-CHUNK SUMMATION at {chunk} tokens/chunk  <-- decides the design")
        print(f"    {'condition':<16}{'provider':>9}{'buyer sum':>11}{'error':>9}{'worst':>7}{'chunks':>8}")
        for name, whole, bsum, err, worst, n in e4_chunk_summation(texts, chunk):
            flag = "" if abs(err) < 0.0001 else "   <-- DIVERGES"
            print(f"    {name:<16}{whole:>9}{bsum:>11}{err:>8.3f}%{worst:>7}{n:>8}{flag}")

    print("\nE5  CROSS-TOKENISER -- o200k vs cl100k on identical text")
    print(f"    {'condition':<16}{'o200k':>8}{'cl100k':>9}{'difference':>12}")
    for name, na, nb, d in e5_cross_tokeniser(texts):
        print(f"    {name:<16}{na:>8}{nb:>9}{d:>11.1f}%")


if __name__ == "__main__":
    main()
