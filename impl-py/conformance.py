"""
Run spec/conformance-vectors.json against the Python implementation.

    python impl-py/conformance.py

This is what a second implementation is FOR. It shares no code with the TypeScript, was written
from the specification, and either produces the same bytes or it does not.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import metered

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VECTORS = os.path.join(ROOT, "spec", "conformance-vectors.json")


class Results:
    def __init__(self) -> None:
        self.passed = 0
        self.failed: list[str] = []

    def expect(self, name: str, got: object, want: object) -> None:
        if got == want:
            self.passed += 1
            return
        self.failed.append(f"{name}\n      expected {want!r}\n      got      {got!r}")


def group(doc: dict, section: str) -> dict:
    for g in doc["groups"]:
        if g["section"] == section:
            return g
    raise SystemExit(f"the vector file has no section {section}")


def run_encoding(doc: dict, r: Results) -> None:
    for case in group(doc, "2")["cases"]:
        r.expect(f"§2 {case['name']} (canonical)", metered.canonicalize(case["given"]), case["expect"]["canonical"])
        r.expect(f"§2 {case['name']} (digest)", metered.digest_hex(case["given"]), case["expect"]["digest"])


def run_preimage(doc: dict, r: Results) -> None:
    for case in group(doc, "3.4.1")["cases"]:
        pre = metered.settlement_preimage(case["given"])
        r.expect(f"§3.4.1 {case['name']} (length)", len(pre), case["expect"]["lengthBytes"])
        r.expect(f"§3.4.1 {case['name']} (bytes)", pre.hex(), case["expect"]["preimageHex"])
        r.expect(f"§3.4.1 {case['name']} (digest)", metered.blake3_hex(pre), case["expect"]["digestHex"])


def run_signatures(doc: dict, r: Results) -> None:
    for case in group(doc, "2.6 / 3.4")["cases"]:
        given = case["given"]
        if "state" in given:
            got = metered.verify_state(given["state"], given["signature"], given["publicKey"])
        else:
            got = metered.verify_envelope(given["message"], given["publicKey"])
        r.expect(f"sig {case['name']}", got, case["expect"]["verifies"])


def run_reconcile(doc: dict, offer: dict, r: Results) -> None:
    for case in group(doc, "5")["cases"]:
        given = case["given"]
        got = metered.reconcile(offer, given["buyer"], given["provider"], given["seq"])
        want = case["expect"]
        r.expect(f"§5 {case['name']} (ok)", got.ok, want["ok"])
        if want["ok"]:
            r.expect(f"§5 {case['name']} (billed)", got.billed_units, want["billedUnits"])
            r.expect(f"§5 {case['name']} (cumulative)", got.billed_cumulative_units, want["billedCumulativeUnits"])
            r.expect(f"§5 {case['name']} (residual)", got.residual, want["residual"])
        else:
            r.expect(f"§5 {case['name']} (reason)", got.reason, want["reason"])


def run_settlement(doc: dict, offer: dict, r: Results) -> None:
    for case in group(doc, "7.4a / 7.4b")["cases"]:
        given, want = case["given"], case["expect"]
        if "pendingSompi" in given:
            got = metered.close_shape(given["pendingSompi"], given["covenantSompi"])
            r.expect(f"§7.4a {case['name']}", got, want["shape"])
        elif "requiredFunding" in want:
            r.expect("§7.4b required funding", metered.required_funding(offer), want["requiredFunding"])
            r.expect("§7.4b close fee", metered.CLOSE_FEE_SOMPI, want["closeFee"])
            r.expect("§7.4b minimum covenant", metered.MIN_COVENANT_SOMPI, want["minCovenant"])
        else:
            bounds = [metered.tolerance_bound(offer, u) for u in given["providerUnits"]]
            r.expect("§5 rule 4 tolerance does not scale", bounds, want["bounds"])


def run_meters(doc: dict, r: Results) -> None:
    for case in group(doc, "6")["cases"]:
        given, want = case["given"], case["expect"]
        if "content" in given:
            r.expect(f"§6 {case['name']} (units)", metered.octets(given["content"]), want["units"])
            r.expect(f"§6 {case['name']} (digest)", metered.blake3_hex(given["content"]), want["contentDigest"])
        elif "floors" in want:
            floors = [metered.minimum_tolerance(m) for m in given["meters"]]
            exact = [metered.METERS[m][1] for m in given["meters"]]
            r.expect("§6 tolerance floors", floors, want["floors"])
            r.expect("§6 meter exactness", exact, want["exact"])
        else:
            units = [metered.METERS[m][0] for m in given["meters"]]
            r.expect("§6 meter units", units, want["units"])


def main() -> int:
    with open(VECTORS, encoding="utf-8") as fh:
        doc = json.load(fh)
    offer = doc["offer"]
    r = Results()

    run_encoding(doc, r)
    run_preimage(doc, r)
    run_signatures(doc, r)
    run_reconcile(doc, offer, r)
    run_settlement(doc, offer, r)
    run_meters(doc, r)

    print(f"\n  metered, second implementation (Python) against spec/conformance-vectors.json\n")
    for failure in r.failed:
        print(f"  FAIL  {failure}")
    print(f"\n  {r.passed} passed, {len(r.failed)} failed\n")
    return 1 if r.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
