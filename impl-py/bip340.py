"""
BIP340 Schnorr verification, implemented from the BIP.

Imported from nowhere on purpose. A second implementation that borrowed its signature checking
from the first would be testing one library twice, and signature verification is exactly where a
protocol quietly accepts things it should refuse.

Verification only: this file never signs. BIP340 signing is randomised, so the conformance vectors
pin verification and never demand particular signature bytes.
"""

from __future__ import annotations

import hashlib

P = 2**256 - 2**32 - 977
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (
    0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
    0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8,
)
Point = tuple[int, int] | None


def _add(a: Point, b: Point) -> Point:
    if a is None:
        return b
    if b is None:
        return a
    if a[0] == b[0] and a[1] != b[1]:
        return None
    lam = (
        (3 * a[0] * a[0] * pow(2 * a[1], P - 2, P)) % P
        if a == b
        else ((b[1] - a[1]) * pow(b[0] - a[0], P - 2, P)) % P
    )
    x = (lam * lam - a[0] - b[0]) % P
    return (x, (lam * (a[0] - x) - a[1]) % P)


def _mul(point: Point, scalar: int) -> Point:
    result: Point = None
    while scalar:
        if scalar & 1:
            result = _add(result, point)
        point = _add(point, point)
        scalar >>= 1
    return result


def _lift_x(x: int) -> Point:
    """BIP340: the x-only public key is the point with EVEN y."""
    if x >= P:
        return None
    y_sq = (pow(x, 3, P) + 7) % P
    y = pow(y_sq, (P + 1) // 4, P)
    if pow(y, 2, P) != y_sq:
        return None
    return (x, y if y % 2 == 0 else P - y)


def _tagged(tag: str, data: bytes) -> bytes:
    tag_hash = hashlib.sha256(tag.encode()).digest()
    return hashlib.sha256(tag_hash + tag_hash + data).digest()


def schnorr_verify(message: bytes, pubkey_hex: str, sig_hex: str) -> bool:
    """BIP340 verification. Implemented from the BIP rather than imported, to stay independent."""
    try:
        sig = bytes.fromhex(sig_hex)
        pubkey = int(pubkey_hex, 16)
    except ValueError:
        return False
    if len(sig) != 64:
        return False

    point = _lift_x(pubkey)
    if point is None:
        return False
    r = int.from_bytes(sig[:32], "big")
    s = int.from_bytes(sig[32:], "big")
    if r >= P or s >= N:
        return False

    e = int.from_bytes(_tagged("BIP0340/challenge", sig[:32] + pubkey.to_bytes(32, "big") + message), "big") % N
    candidate = _add(_mul(G, s), _mul(point, N - e))
    return candidate is not None and candidate[1] % 2 == 0 and candidate[0] == r


