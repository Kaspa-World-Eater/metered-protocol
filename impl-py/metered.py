"""
A SECOND IMPLEMENTATION of the metered protocol, in Python.

WHY IT EXISTS. SPEC.md's central claim is that two independent implementations can measure the
same delivered work and agree. Until this file there was one implementation, and a specification
with one implementation is a description of that implementation.

HOW IT WAS WRITTEN, because that is the part that matters: from spec/SPEC.md and
spec/CONFORMANCE.md, not from src/. Every place the specification turned out to be insufficient to
write this file is recorded in impl-py/FINDINGS.md rather than resolved by reading the TypeScript.
Those are the real output of this exercise. The code passing is the easy half.

It implements the part a conformance suite can check -- encoding, digests, the settlement
preimage, signature verification, reconciliation and the settlement arithmetic. It is not a
working client: there is no transport here, no covenant, and no key management.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from blake3 import blake3

# --------------------------------------------------------------------------- SPEC.md section 2


def canonicalize(value: Any) -> str:
    """
    Canonical JSON, per section 2: keys sorted by UTF-16 CODE UNIT, no insignificant whitespace.

    Sorting on the UTF-16 big-endian encoding gives code-unit order directly. Python's own
    ``sorted`` on ``str`` gives CODE POINT order, which section 2 warns is a different rule --
    they diverge above the BMP, where surrogates sort below U+E000..FFFF. No field name in this
    version is affected, and following the wrong rule would still be a latent divergence.
    """
    return json.dumps(
        _sorted(value),
        ensure_ascii=False,      # section 2: non-ASCII is not escaped
        separators=(",", ":"),   # section 2 rule 2: no insignificant whitespace
        allow_nan=False,         # section 2 rule 3: no floats, and certainly no NaN
    )


def _sorted(value: Any) -> Any:
    if isinstance(value, dict):
        items = sorted(value.items(), key=lambda kv: kv[0].encode("utf-16-be"))
        return {k: _sorted(v) for k, v in items}
    if isinstance(value, list):
        return [_sorted(v) for v in value]     # section 2: arrays keep their order
    return value


def blake3_hex(data: bytes | str) -> str:
    """Section 2 rule 7: BLAKE3-256, 32 bytes, lower-case hex. Everywhere, without exception."""
    raw = data.encode("utf-8") if isinstance(data, str) else data
    return blake3(raw).hexdigest()


def digest_hex(value: Any) -> str:
    """The digest of an object is BLAKE3 over its canonical bytes."""
    return blake3_hex(canonicalize(value))


# --------------------------------------------------------------------------- section 3.4.1

PREIMAGE_LEN = 72
ZERO32 = bytes(32)


def num2bin8(value: int) -> bytes:
    """
    Eight-byte SIGNED-MAGNITUDE, little-endian: the sign is the top bit of the LAST byte.

    Not two's complement. CONFORMANCE.md calls this out and gives a ``seq: -1`` vector because it
    is exactly where the two encodings differ.
    """
    if abs(value) > 2**53 - 1:
        raise ValueError(f"{value} exceeds the 2^53-1 cap of section 2 rule 3")
    out = bytearray(abs(value).to_bytes(8, "little"))
    if value < 0:
        out[7] |= 0x80
    return bytes(out)


def settlement_preimage(state: dict[str, Any]) -> bytes:
    """
    Section 3.4.1. The only bytes a State's signatures cover:

        sessionId(16) || seq(8) || cumulativeUnits(8) || cumulativeSompi(8) || prevState(32)

    ``prevState`` is null in the JSON at seq 0 and 32 ZERO bytes here, because a null has no byte
    form. This is the one message in the protocol NOT signed over canonical JSON.
    """
    prev = state.get("prevState")
    out = (
        bytes.fromhex(state["sessionId"])
        + num2bin8(state["seq"])
        + num2bin8(state["cumulativeUnits"])
        + num2bin8(state["cumulativeSompi"])
        + (bytes.fromhex(prev) if prev else ZERO32)
    )
    if len(out) != PREIMAGE_LEN:
        raise ValueError(f"preimage is {len(out)} bytes, not {PREIMAGE_LEN}")
    return out


def settlement_digest(state: dict[str, Any]) -> bytes:
    """What both parties actually sign, and what the covenant recomputes."""
    return blake3(settlement_preimage(state)).digest()


from bip340 import schnorr_verify


def verify_envelope(message: dict[str, Any], pubkey_hex: str, field: str = "sig") -> bool:
    """Section 2 rule 6: the signature covers the object with its OWN signature field ABSENT."""
    sig = message.get(field)
    if not isinstance(sig, str):
        return False
    payload = {k: v for k, v in message.items() if k != field}
    return schnorr_verify(canonicalize(payload).encode("utf-8"), pubkey_hex, sig)


def verify_state(state: dict[str, Any], sig_hex: str, pubkey_hex: str) -> bool:
    """A State signature covers the section 3.4.1 preimage digest, NOT canonical JSON."""
    try:
        return schnorr_verify(settlement_digest(state), pubkey_hex, sig_hex)
    except (ValueError, KeyError):
        return False


# --------------------------------------------------------------------------- section 5

@dataclass(frozen=True)
class Outcome:
    ok: bool
    billed_units: int | None = None
    billed_cumulative_units: int | None = None
    residual: int | None = None
    reason: str | None = None


def tolerance_bound(offer: dict[str, Any], provider_units: int) -> int:
    """Section 5 rule 4: ABSOLUTE. It does not scale with the babel."""
    del provider_units
    return offer["toleranceAbs"]


def reconcile(offer: dict[str, Any], buyer: dict[str, Any], provider: dict[str, Any], seq: int) -> Outcome:
    """Section 5, in order. Any failure halts the session."""
    if buyer.get("by") != "buyer" or provider.get("by") != "provider":
        return Outcome(ok=False, reason="signature")
    if not verify_envelope(buyer, offer["buyerPubkey"]):
        return Outcome(ok=False, reason="signature")
    if not verify_envelope(provider, offer["providerPubkey"]):
        return Outcome(ok=False, reason="signature")

    if offer["sessionId"] not in (buyer.get("sessionId"), provider.get("sessionId")):
        return Outcome(ok=False, reason="sequence")
    if buyer.get("seq") != seq or provider.get("seq") != seq:
        return Outcome(ok=False, reason="sequence")

    if buyer["contentDigest"] != provider["contentDigest"]:
        return Outcome(ok=False, reason="content-digest")

    if abs(buyer["units"] - provider["units"]) > tolerance_bound(offer, provider["units"]):
        return Outcome(ok=False, reason="tolerance-babel")
    if abs(buyer["cumulativeUnits"] - provider["cumulativeUnits"]) > tolerance_bound(
        offer, provider["cumulativeUnits"]
    ):
        return Outcome(ok=False, reason="tolerance-cumulative")

    return Outcome(
        ok=True,
        billed_units=min(buyer["units"], provider["units"]),
        billed_cumulative_units=min(buyer["cumulativeUnits"], provider["cumulativeUnits"]),
        residual=provider["units"] - buyer["units"],
    )


# --------------------------------------------------------------------------- section 7.4

CLOSE_FEE_SOMPI = 400_000
MIN_COVENANT_SOMPI = 10_000_000
DUST_SOMPI = 2_600_000
FOLD_SOMPI = 3_000_000


def close_shape(pending_sompi: int, covenant_sompi: int) -> dict[str, Any]:
    """Section 7.4a: exactly three legal shapes, and which one depends on the claim."""
    if pending_sompi < DUST_SOMPI:
        return {"outputs": 1, "to": ["buyer"]}
    if pending_sompi + FOLD_SOMPI >= covenant_sompi:
        return {"outputs": 1, "to": ["provider"]}
    return {"outputs": 2, "to": ["provider", "buyer"]}


def required_funding(offer: dict[str, Any]) -> int:
    """Section 7.4b: the largest bill the Offer permits, its close fee, and the shape floor."""
    max_bill = offer["maxBabels"] * offer["babelUnits"] * offer["unitPriceSompi"]
    return max(max_bill + CLOSE_FEE_SOMPI, MIN_COVENANT_SOMPI)
