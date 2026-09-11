"""
Generate the tokeniser conformance vectors: `evidence/tokenizer-vectors.json`.

WHY THIS FILE EXISTS. Every tolerance in SPEC.md traces to Study A, and Study A counted with
PYTHON tiktoken. The protocol implementation counts with a JavaScript tokeniser. If those two
disagree by even one token on one input, a buyer and a provider running different implementations
halt an honest session -- which is precisely the failure SPEC.md 0.1 says a zero tolerance causes.

So the agreement is not assumed, it is pinned. This writes the exact token ID sequences Python
produces over Study A's own corpus -- the adversarial one, with CJK, emoji, zalgo, surrogate
pairs and pathological whitespace -- and src/tokenizer.test.ts demands the JavaScript tokeniser
reproduce them exactly. IDS, not counts: two tokenisers can agree on a count by luck and disagree
on where the boundaries fall, and a boundary disagreement is what diverges on the NEXT input.

Regenerate with:  python evidence/tokenizer_vectors.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tiktoken
from study_a import corpus, build_long_mixed

ENCODING = "o200k_base"


def main():
    enc = tiktoken.get_encoding(ENCODING)
    texts = dict(corpus())
    texts["long_mixed"] = build_long_mixed(texts)

    vectors = {
        "encoding": ENCODING,
        "tiktokenVocab": enc.n_vocab,
        "cases": [
            {"name": name, "text": text, "ids": enc.encode(text)}
            for name, text in sorted(texts.items())
        ],
    }
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tokenizer-vectors.json")
    with open(out, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(vectors, fh, ensure_ascii=False, indent=1, sort_keys=True)
        fh.write("\n")
    total = sum(len(c["ids"]) for c in vectors["cases"])
    print(f"wrote {out}")
    print(f"  {ENCODING}, vocab {enc.n_vocab}: {len(vectors['cases'])} cases, {total} tokens")


if __name__ == "__main__":
    main()
