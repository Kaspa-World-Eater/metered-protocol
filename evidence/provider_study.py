"""
Study A, second half -- do providers agree with their OWN tokeniser?

This is the last real risk to the unit, and the only part of Gate 2 that needs money.

Study A proved that two parties running the same tokeniser over the same bytes agree. It did NOT
prove that a provider's reported `completion_tokens` matches what that provider's own published
tokeniser says about the text it actually sent. If those disagree, the buyer cannot independently
derive the bill, and `llm.output_tokens.v1` does not work.

KEYS ARE NEVER READ BY ANYTHING BUT THIS SCRIPT, AND NEVER STORED IN THE REPO.
Same discipline as the Kaspa anchor key: they live outside the project, in

    ~/.metered/providers.env

which this reads and never prints. Nothing here logs a key, and no failure message contains one.

    python provider_study.py            # run every provider that has a key
    python provider_study.py --dry-run  # show what it would do, spend nothing
"""
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ENV_PATH = Path.home() / ".metered" / "providers.env"
DRY = "--dry-run" in sys.argv
N_PER_PROVIDER = 12


# ------------------------------------------------------------------ key loading
def load_keys() -> dict:
    """Read keys from outside the repo. Never logs a value."""
    if not ENV_PATH.exists():
        return {}
    keys = {}
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip().strip('"').strip("'")
        if v:
            keys[k.strip()] = v
    return keys


# --------------------------------------------------------------------- prompts
# Deliberately spans the conditions Study A found divergence in: prose, code, CJK, emoji.
PROMPTS = [
    "Explain in two short paragraphs why chunked quota reservation bounds trust.",
    "Write a small JavaScript function that clamps a number between two bounds. Code only.",
    "日本語で、計量プロトコルの利点を三文で説明してください。",
    "List five emoji and describe each in one short sentence.",
    "Write one paragraph about tokenisation, then the same paragraph in Korean.",
    "Count from one to forty in words, comma separated.",
]

PROVIDERS = {
    "OPENAI_API_KEY": {
        "label": "openai",
        "url": "https://api.openai.com/v1/chat/completions",
        "model": "gpt-4o-mini",
        "tokenizer": "o200k_base",
        "auth": lambda k: {"Authorization": f"Bearer {k}"},
    },
    "GROQ_API_KEY": {
        "label": "groq",
        "url": "https://api.groq.com/openai/v1/chat/completions",
        "model": "llama-3.1-8b-instant",
        "tokenizer": None,  # not a tiktoken vocabulary -- see the note in the summary
        "auth": lambda k: {"Authorization": f"Bearer {k}"},
    },
    "TOGETHER_API_KEY": {
        "label": "together",
        "url": "https://api.together.xyz/v1/chat/completions",
        "model": "meta-llama/Llama-3.2-3B-Instruct-Turbo",
        "tokenizer": None,
        "auth": lambda k: {"Authorization": f"Bearer {k}"},
    },
}


def call(cfg: dict, key: str, prompt: str) -> dict:
    body = json.dumps({
        "model": cfg["model"],
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 400,
        "temperature": 0,
    }).encode()
    req = urllib.request.Request(cfg["url"], data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    for h, v in cfg["auth"](key).items():
        req.add_header(h, v)
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read())


def summarise(label: str, rows: list) -> None:
    if not rows:
        print(f"    {label}: no successful calls")
        return
    errs = [r["rel"] for r in rows]
    exact = sum(1 for r in rows if r["reported"] == r["counted"])
    print(f"    reported vs independently counted, {len(rows)} completions")
    print(f"      exact matches   {exact}/{len(rows)}")
    print(f"      max abs error   {max(abs(r['reported'] - r['counted']) for r in rows)} tokens")
    print(f"      max rel error   {max(abs(e) for e in errs) * 100:.2f}%")
    print(f"      mean rel error  {sum(errs) / len(errs) * 100:+.2f}%")
    worst = max(rows, key=lambda r: abs(r["reported"] - r["counted"]))
    print(f"      worst case      reported {worst['reported']}, counted {worst['counted']}"
          f"  ({worst['prompt'][:38]}...)")


def main() -> None:
    print("STUDY A, SECOND HALF -- do providers agree with their own tokeniser?")
    print("=" * 78)
    print(f"reading keys from {ENV_PATH}  (never printed, never committed)\n")

    keys = load_keys()
    if not keys:
        print("  No keys found. Create the file with one line per provider:\n")
        for k in PROVIDERS:
            print(f"      {k}=...")
        print(f"\n  at {ENV_PATH}")
        print("  Then run this again. Only providers with a key are tried.")
        return

    try:
        import tiktoken
    except ImportError:
        print("  pip install tiktoken")
        return

    have = [k for k in PROVIDERS if k in keys]
    print(f"  keys present for: {', '.join(PROVIDERS[k]['label'] for k in have) or 'none'}")
    print(f"  {N_PER_PROVIDER} completions each, max 400 tokens, temperature 0")
    print(f"  estimated cost: well under $1 total\n")

    if DRY:
        print("  --dry-run: stopping before any request is made. Nothing spent.")
        return

    findings = {}
    for env_key in have:
        cfg = PROVIDERS[env_key]
        label = cfg["label"]
        print(f"  {label} ({cfg['model']})")

        if not cfg["tokenizer"]:
            print("    SKIPPED -- no published tiktoken-compatible tokeniser.")
            print("    This is itself a result: a provider whose tokeniser we cannot obtain")
            print("    cannot use llm.output_tokens.v1 at all. Recorded as disqualified.")
            findings[label] = {"disqualified": True, "reason": "no published tokeniser"}
            print()
            continue

        enc = tiktoken.get_encoding(cfg["tokenizer"])
        rows = []
        for i in range(N_PER_PROVIDER):
            prompt = PROMPTS[i % len(PROMPTS)]
            try:
                res = call(cfg, keys[env_key], prompt)
            except urllib.error.HTTPError as e:
                print(f"    call {i + 1}: HTTP {e.code} -- skipped")   # no key in the message
                continue
            except Exception as e:
                print(f"    call {i + 1}: {type(e).__name__} -- skipped")
                continue

            text = res["choices"][0]["message"]["content"] or ""
            reported = res.get("usage", {}).get("completion_tokens")
            if reported is None:
                print(f"    call {i + 1}: provider reported no completion_tokens -- skipped")
                continue
            counted = len(enc.encode(text))
            rows.append({
                "prompt": prompt, "reported": reported, "counted": counted,
                "rel": (reported - counted) / reported if reported else 0.0,
            })
            time.sleep(0.3)

        summarise(label, rows)
        findings[label] = {"rows": rows}
        print()

    out = Path(__file__).with_name("results-provider.json")
    out.write_text(json.dumps(findings, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"  written to {out.name}")
    print()
    print("  GATE: the unit survives if reported and counted agree closely enough that an honest")
    print("  session does not halt. The tolerance floor from the first half of Study A is 1 token.")
    print("  A provider whose own reported count is systematically off by more than a token or two")
    print("  cannot be metered with llm.output_tokens.v1 as specified.")


if __name__ == "__main__":
    main()
