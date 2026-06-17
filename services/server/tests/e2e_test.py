#!/usr/bin/env python3
"""
E2E test for memory Server — Ed25519 sub-agent auth + current API contract.

What this covers:
  1. GET /health is reachable without auth
  2. Unsigned requests to protected routes are rejected (401)
  3. Valid-format but wrong-key signatures are rejected (401)
  4. Expired timestamps are rejected (401)
  5. Opt-in: signed /api/remember + /api/recall happy path with a
     pre-registered sub-agent key (requires TEST_SUB_AGENT_KEY + real backend)

The happy-path flow needs a sub-agent registered on-chain, social server
indexing that agent, File Storage, MYDATA key servers, MySo RPC, and a
funded server wallet.

Env vars:
  TEST_BASE_URL           default "http://localhost:8000"
  TEST_SUB_AGENT_KEY      hex-encoded Ed25519 secret (32 bytes → 64 hex chars)
  TEST_DELEGATE_KEY       deprecated alias for TEST_SUB_AGENT_KEY
  TEST_ACCOUNT_ID         MemoryAccount object ID (optional x-account-id hint)
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

from nacl.encoding import RawEncoder
from nacl.signing import SigningKey

BASE_URL = os.environ.get("TEST_BASE_URL", "http://localhost:8000").rstrip("/")


def _sign(
    signing_key: SigningKey,
    method: str,
    path: str,
    body_bytes: bytes,
    timestamp: str,
    nonce: str,
    account_id: str,
) -> str:
    """Return the hex-encoded Ed25519 signature over the canonical message.

    Server-side payload format (services/server/src/auth.rs):
        "{timestamp}.{method}.{path}.{body_hash}.{nonce}.{account_id}"

    Empty account_id is signed as the empty string when no x-account-id is sent.
    """
    body_hash = hashlib.sha256(body_bytes).hexdigest()
    message = f"{timestamp}.{method}.{path}.{body_hash}.{nonce}.{account_id}".encode()
    signed = signing_key.sign(message, encoder=RawEncoder)
    return signed.signature.hex()


def make_signed_request(
    method: str,
    path: str,
    body: dict,
    signing_key: SigningKey,
    account_id: str | None = None,
) -> dict:
    """Send a signed JSON request and return the decoded JSON response."""
    body_bytes = json.dumps(body).encode()
    timestamp = str(int(time.time()))
    nonce = str(uuid.uuid4())
    signature_hex = _sign(
        signing_key, method, path, body_bytes, timestamp, nonce, account_id or ""
    )
    public_key_hex = signing_key.verify_key.encode().hex()

    headers = {
        "Content-Type": "application/json",
        "x-public-key": public_key_hex,
        "x-signature": signature_hex,
        "x-timestamp": timestamp,
        "x-nonce": nonce,
    }
    if account_id:
        headers["x-account-id"] = account_id

    req = urllib.request.Request(f"{BASE_URL}{path}", data=body_bytes, headers=headers, method=method)
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def _load_sub_agent_key() -> SigningKey | None:
    """Load TEST_SUB_AGENT_KEY (or legacy TEST_DELEGATE_KEY) as a SigningKey."""
    hex_key = (
        os.environ.get("TEST_SUB_AGENT_KEY", "").strip()
        or os.environ.get("TEST_DELEGATE_KEY", "").strip()
    )
    if not hex_key:
        return None
    try:
        raw = bytes.fromhex(hex_key)
    except ValueError:
        print("[warn] TEST_SUB_AGENT_KEY is not valid hex; skipping happy-path checks")
        return None
    if len(raw) != 32:
        print(f"[warn] TEST_SUB_AGENT_KEY must be 32 bytes (got {len(raw)}); skipping happy-path checks")
        return None
    return SigningKey(raw, encoder=RawEncoder)


def test_health() -> None:
    req = urllib.request.Request(f"{BASE_URL}/health")
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())
        assert data["status"] == "ok", f"Expected status=ok, got {data}"
        print(f"[pass] GET /health → {data}")


def test_unsigned_rejected() -> None:
    body = json.dumps({"text": "hello", "namespace": "default"}).encode()
    req = urllib.request.Request(
        f"{BASE_URL}/api/remember",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req)
    except urllib.error.HTTPError as e:
        assert e.code == 401, f"Expected 401, got {e.code}"
        print(f"[pass] unsigned POST /api/remember → {e.code}")
        return
    raise AssertionError("Expected 401, request succeeded")


def test_wrong_signature_rejected() -> None:
    key_a = SigningKey.generate()
    key_b = SigningKey.generate()

    body = {"text": "evil", "namespace": "default"}
    body_bytes = json.dumps(body).encode()
    timestamp = str(int(time.time()))
    nonce = str(uuid.uuid4())
    signature_hex = _sign(
        key_a, "POST", "/api/remember", body_bytes, timestamp, nonce, ""
    )

    req = urllib.request.Request(
        f"{BASE_URL}/api/remember",
        data=body_bytes,
        headers={
            "Content-Type": "application/json",
            "x-public-key": key_b.verify_key.encode().hex(),  # mismatched key
            "x-signature": signature_hex,
            "x-timestamp": timestamp,
            "x-nonce": nonce,
        },
        method="POST",
    )
    try:
        urllib.request.urlopen(req)
    except urllib.error.HTTPError as e:
        assert e.code == 401, f"Expected 401, got {e.code}"
        print(f"[pass] mismatched public-key POST /api/remember → {e.code}")
        return
    raise AssertionError("Expected 401, request succeeded")


def test_expired_timestamp_rejected() -> None:
    # Use a fresh random key — the request is expected to die at the
    # timestamp check, which runs BEFORE sub-agent resolution.
    signing_key = SigningKey.generate()
    body = {"text": "old", "namespace": "default"}
    body_bytes = json.dumps(body).encode()
    timestamp = str(int(time.time()) - 600)  # 10 min past
    nonce = str(uuid.uuid4())
    signature_hex = _sign(
        signing_key, "POST", "/api/remember", body_bytes, timestamp, nonce, ""
    )

    req = urllib.request.Request(
        f"{BASE_URL}/api/remember",
        data=body_bytes,
        headers={
            "Content-Type": "application/json",
            "x-public-key": signing_key.verify_key.encode().hex(),
            "x-signature": signature_hex,
            "x-timestamp": timestamp,
            "x-nonce": nonce,
        },
        method="POST",
    )
    try:
        urllib.request.urlopen(req)
    except urllib.error.HTTPError as e:
        assert e.code == 401, f"Expected 401, got {e.code}"
        print(f"[pass] expired-timestamp POST /api/remember → {e.code}")
        return
    raise AssertionError("Expected 401, request succeeded")


def test_remember_recall_happy_path(signing_key: SigningKey, account_id: str | None) -> None:
    """Signed /api/remember → /api/recall with a pre-registered sub-agent key."""
    remember_body = {
        "text": "The capital of France is Paris.",
        "namespace": "e2e-test",
    }
    result = make_signed_request(
        "POST", "/api/remember", remember_body, signing_key, account_id=account_id
    )
    assert "id" in result, f"Expected 'id' in remember response, got {result}"
    assert result["namespace"] == "e2e-test", f"Unexpected namespace: {result}"
    print(f"[pass] POST /api/remember → id={result['id']}, blob_id={result['blob_id']}")

    recall_body = {
        "query": "What is the capital of France?",
        "limit": 5,
        "namespace": "e2e-test",
    }
    recall_result = make_signed_request(
        "POST", "/api/recall", recall_body, signing_key, account_id=account_id
    )
    assert "results" in recall_result, f"Expected 'results' in recall response, got {recall_result}"
    assert recall_result["total"] >= 1, f"Expected ≥1 result, got {recall_result['total']}"
    top = recall_result["results"][0]
    for k in ("text", "blob_id", "distance"):
        assert k in top, f"Missing '{k}' in recall result: {top}"
    print(f"[pass] POST /api/recall → {recall_result['total']} hits, top distance={top['distance']:.4f}")


def main() -> int:
    print("=" * 60)
    print(f"  memory Server E2E — target {BASE_URL}")
    sub_agent_key = _load_sub_agent_key()
    account_id = os.environ.get("TEST_ACCOUNT_ID") or None
    if sub_agent_key:
        print("  happy-path: enabled (TEST_SUB_AGENT_KEY provided)")
    else:
        print("  happy-path: skipped (set TEST_SUB_AGENT_KEY to enable)")
    print("=" * 60)

    failures: list[str] = []

    contract_checks = (
        ("health", test_health),
        ("unsigned_rejected", test_unsigned_rejected),
        ("wrong_signature_rejected", test_wrong_signature_rejected),
        ("expired_timestamp_rejected", test_expired_timestamp_rejected),
    )
    for name, fn in contract_checks:
        try:
            fn()
        except (AssertionError, urllib.error.URLError, urllib.error.HTTPError) as e:
            failures.append(f"{name}: {e}")
            print(f"[FAIL] {name}: {e}")

    if sub_agent_key:
        try:
            test_remember_recall_happy_path(sub_agent_key, account_id)
        except (AssertionError, urllib.error.URLError, urllib.error.HTTPError) as e:
            failures.append(f"remember_recall_happy_path: {e}")
            print(f"[FAIL] remember_recall_happy_path: {e}")
    else:
        print("[skip] remember_recall_happy_path (no TEST_SUB_AGENT_KEY)")

    print()
    print("=" * 60)
    if failures:
        print(f"  {len(failures)} failure(s):")
        for f in failures:
            print(f"    - {f}")
        print("=" * 60)
        return 1
    print("  all checks passed")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
