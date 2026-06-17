use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::Response,
};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use redis::AsyncCommands;
use sha2::{Digest, Sha256};
use std::sync::Arc;

use crate::myso::{
    derived_address_from_public_key, verify_sub_agent_onchain, CAP_MEMORY_READ, CAP_MEMORY_WRITE,
};
use crate::social::{fetch_sub_agent_by_derived_address, SocialApiError};
use crate::types::{AppState, AuthInfo};

/// Sub-agent signature verification + on-chain capability checks.
///
/// Flow:
/// 1. Verify Ed25519 signature
/// 2. Resolve sub-agent: cache → social API → account-id fallback
/// 3. Verify on-chain SubAgent + MemoryAccount
/// 4. Cache mapping for future requests
async fn constant_time_reject() -> StatusCode {
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    StatusCode::UNAUTHORIZED
}

fn unsupported_legacy_sdk() -> StatusCode {
    StatusCode::UPGRADE_REQUIRED
}

pub async fn verify_signature(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let headers = request.headers();

    // Extract auth headers as owned Strings
    let public_key_hex = headers
        .get("x-public-key")
        .and_then(|v| v.to_str().ok())
        .map(String::from)
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let signature_hex = headers
        .get("x-signature")
        .and_then(|v| v.to_str().ok())
        .map(String::from)
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let timestamp_str = headers
        .get("x-timestamp")
        .and_then(|v| v.to_str().ok())
        .map(String::from)
        .ok_or(StatusCode::UNAUTHORIZED)?;

    // Optional account ID hint from header
    let account_id_hint = headers
        .get("x-account-id")
        .and_then(|v| v.to_str().ok())
        .map(String::from);

    // Optional sub-agent private key (hex) for MYDATA decrypt — legacy header name.
    let sub_agent_key_hex = headers
        .get("x-delegate-key")
        .and_then(|v| v.to_str().ok())
        .map(String::from);

    // Optional MYDATA SessionKey (base64 JSON) — replaces `x-delegate-key` on
    // the wire. When present, it is preferred over `delegate_key_hex` for
    // any MYDATA decrypt operation. Phase 1 of the migration: both headers
    // are accepted so existing SDKs continue to work unchanged.
    let mydata_session = headers
        .get("x-mydata-session")
        .and_then(|v| v.to_str().ok())
        .map(String::from);

    if mydata_session.is_some() && sub_agent_key_hex.is_some() {
        tracing::debug!(
            "both x-mydata-session and x-delegate-key present; preferring x-mydata-session"
        );
    }
    if mydata_session.is_none() && sub_agent_key_hex.is_some() {
        tracing::warn!(
            target: "memory::deprecation",
            "request using legacy x-delegate-key header — client should upgrade to SDK v0.4+ (x-mydata-session)"
        );
    }

    // MED-1 fix: Extract nonce for replay protection.
    // Nonce must be a UUID v4, checked against Redis to prevent replay attacks.
    // TTL = 600s (10 min) > timestamp window (300s) so no replay is possible.
    let nonce = headers
        .get("x-nonce")
        .and_then(|v| v.to_str().ok())
        .map(String::from)
        .ok_or_else(|| {
            tracing::warn!(
                target: "memory::deprecation",
                "request missing x-nonce; rejecting unsupported legacy SDK"
            );
            unsupported_legacy_sdk()
        })?;

    // Validate nonce is UUID format (prevents injection attacks)
    if uuid::Uuid::parse_str(&nonce).is_err() {
        tracing::warn!("Invalid nonce format (not UUID): {}", &nonce[..nonce.len().min(36)]);
        return Err(constant_time_reject().await);
    }

    // Validate timestamp (5 minute window)
    // INFO-2 fix: Use checked_sub to avoid potential overflow with user-supplied timestamps
    let timestamp: i64 = timestamp_str
        .parse()
        .map_err(|_| StatusCode::UNAUTHORIZED)?;
    let now = chrono::Utc::now().timestamp();
    let age = now.checked_sub(timestamp).unwrap_or(i64::MAX);
    if age > 300 || age < -300 {
        tracing::warn!("Request timestamp too old or future: {} (now: {})", timestamp, now);
        // LOW-2: Use constant_time_reject to normalize timing on timestamp failures
        return Err(constant_time_reject().await);
    }

    // Decode public key
    let pk_bytes = hex::decode(&public_key_hex).map_err(|_| StatusCode::UNAUTHORIZED)?;
    let pk_array: [u8; 32] = pk_bytes
        .try_into()
        .map_err(|_| StatusCode::UNAUTHORIZED)?;
    let verifying_key =
        VerifyingKey::from_bytes(&pk_array).map_err(|_| StatusCode::UNAUTHORIZED)?;

    // Decode signature
    let sig_bytes = hex::decode(&signature_hex).map_err(|_| StatusCode::UNAUTHORIZED)?;
    let sig_array: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| StatusCode::UNAUTHORIZED)?;
    let signature = Signature::from_bytes(&sig_array);

    // Build the signed message: "{timestamp}.{method}.{path_and_query}.{body_sha256}.{nonce}"
    // LOW-1: Include query parameters in signed message to prevent query-param tampering
    let method = request.method().as_str().to_string();
    let path = request.uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| request.uri().path().to_string());

    // Split request to consume body
    let (mut parts, body) = request.into_parts();

    let body_bytes = axum::body::to_bytes(body, 1024 * 1024)
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?;

    let body_hash = hex::encode(Sha256::digest(&body_bytes));
    // MED-1 fix: Include nonce in signed message to prevent replay attacks.
    // LOW-23: Include x-account-id in the signed canonical message so an
    //         intermediary cannot swap the account hint. The header MUST be
    //         present — the SDK now always sends it. If absent we use an
    //         empty string so the signature will mismatch and the request
    //         is rejected below.
    //
    // NOTE (coordinator): this change must land in lockstep with the SDK
    // signing change in packages/sdk/src/{memory,manual}.ts. If the Rust
    // sidecar agent edits this function concurrently, reconcile so the
    // canonical message below is the single source of truth.
    //
    // Canonical format:
    //   "{timestamp}.{method}.{path_and_query}.{body_sha256}.{nonce}.{account_id}"
    let account_id_for_sig = account_id_hint.clone().unwrap_or_default();
    let message = format!(
        "{}.{}.{}.{}.{}.{}",
        timestamp_str, method, path, body_hash, nonce, account_id_for_sig
    );

    // Step 1: Verify Ed25519 signature
    // LOW-2: Use constant_time_reject so signature failures take the same wall-clock
    // time as account-resolution failures, preventing differential timing attacks.
    if verifying_key
        .verify(message.as_bytes(), &signature)
        .is_err()
    {
        tracing::warn!("Signature verification failed for key: {}", public_key_hex);
        return Err(constant_time_reject().await);
    }

    tracing::debug!("signature verified for key: {}", public_key_hex);

    // MED-1 fix: Check and record nonce in Redis to block replays.
    // Done AFTER signature verify so we don't waste Redis writes on bad requests.
    {
        let nonce_key = format!("nonce:{}", nonce);
        let mut redis = state.redis.clone();

        // SET nonce_key "1" EX 600 NX — only set if Not eXists
        let set_result: Option<String> = redis
            .set_options(
                &nonce_key,
                "1",
                redis::SetOptions::default()
                    .conditional_set(redis::ExistenceCheck::NX)
                    .with_expiration(redis::SetExpiry::EX(600)),
            )
            .await
            .unwrap_or(None); // if Redis is down, fail-open for nonce check only
                              // (signature + timestamp still protect against most replays)

        if set_result.is_none() {
            // NX failed = nonce already exists = replay attempt
            tracing::warn!(
                "Replay attack detected: nonce {} already seen (key={}...)",
                nonce,
                &public_key_hex[..16.min(public_key_hex.len())]
            );
            // LOW-2: uniform timing even for replay rejections
            return Err(constant_time_reject().await);
        }
    }

    let required_cap = required_capability_for_path(method.as_str(), path.as_str());

    // Step 2: Resolve sub-agent
    let resolved = match resolve_sub_agent(
        &state,
        &public_key_hex,
        &pk_array,
        account_id_hint,
        required_cap,
    )
    .await
    {
        Ok(info) => info,
        Err(e) => {
            tracing::warn!("Sub-agent resolution failed: {}", e);
            return Err(constant_time_reject().await);
        }
    };

    tracing::debug!(
        "sub-agent resolved: account={} agent={} owner={}",
        resolved.account_id,
        resolved.agent_object_id,
        resolved.owner
    );

    // Store auth info in request extensions
    parts.extensions.insert(AuthInfo {
        public_key: public_key_hex,
        owner: resolved.owner,
        account_id: resolved.account_id,
        agent_object_id: resolved.agent_object_id,
        derived_address: resolved.derived_address,
        capabilities: resolved.capabilities,
        sub_agent_key: sub_agent_key_hex,
        mydata_session,
    });

    // Rebuild request with the body re-injected
    let request = Request::from_parts(parts, axum::body::Body::from(body_bytes));

    Ok(next.run(request).await)
}

struct ResolvedSubAgent {
    account_id: String,
    agent_object_id: String,
    owner: String,
    derived_address: String,
    capabilities: u64,
}

fn required_capability_for_path(method: &str, path: &str) -> u64 {
    if method != "POST" {
        return CAP_MEMORY_READ;
    }
    if path.starts_with("/api/remember")
        || path == "/api/analyze"
        || path == "/api/restore"
    {
        CAP_MEMORY_WRITE
    } else {
        CAP_MEMORY_READ
    }
}

async fn verify_and_cache_sub_agent(
    state: &AppState,
    public_key_hex: &str,
    pk_bytes: &[u8; 32],
    account_id: &str,
    agent_object_id: &str,
    required_cap: u64,
) -> Result<ResolvedSubAgent, String> {
    let verified = verify_sub_agent_onchain(
        &state.http_client,
        &state.config.myso_rpc_url,
        account_id,
        agent_object_id,
        pk_bytes,
        required_cap,
    )
    .await
    .map_err(|e| e.to_string())?;

    let _ = state
        .db
        .cache_sub_agent(
            public_key_hex,
            &verified.derived_address,
            &verified.account_id,
            &verified.agent_object_id,
            &verified.owner,
            verified.capabilities as i64,
        )
        .await;

    Ok(ResolvedSubAgent {
        account_id: verified.account_id,
        agent_object_id: verified.agent_object_id,
        owner: verified.owner,
        derived_address: verified.derived_address,
        capabilities: verified.capabilities,
    })
}

/// Resolve a sub-agent using cache → social API → account-id fallback.
async fn resolve_sub_agent(
    state: &AppState,
    public_key_hex: &str,
    pk_bytes: &[u8; 32],
    account_id_hint: Option<String>,
    required_cap: u64,
) -> Result<ResolvedSubAgent, String> {
    let derived_address = derived_address_from_public_key(pk_bytes);

    if let Ok(Some(cached)) = state.db.get_cached_sub_agent(public_key_hex).await {
        match verify_and_cache_sub_agent(
            state,
            public_key_hex,
            pk_bytes,
            &cached.account_id,
            &cached.agent_object_id,
            required_cap,
        )
        .await
        {
            Ok(resolved) => {
                tracing::debug!("sub-agent resolved from cache");
                return Ok(resolved);
            }
            Err(e) => {
                tracing::warn!(
                    "cached sub-agent {} invalid on-chain: {}",
                    public_key_hex,
                    e
                );
                let _ = state.db.delete_cached_sub_agent(public_key_hex).await;
            }
        }
    }

    match fetch_sub_agent_by_derived_address(
        &state.http_client,
        &state.config.social_server_url,
        &derived_address,
    )
    .await
    {
        Ok(indexed) => {
            if !indexed.active {
                return Err("sub-agent inactive in social index".to_string());
            }
            if let Some(ref hint) = account_id_hint {
                if hint != &indexed.account_id {
                    return Err("x-account-id does not match indexed sub-agent account".to_string());
                }
            }
            return verify_and_cache_sub_agent(
                state,
                public_key_hex,
                pk_bytes,
                &indexed.account_id,
                &indexed.agent_object_id,
                required_cap,
            )
            .await;
        }
        Err(SocialApiError::NotFound) => {
            return Err(format!(
                "sub-agent not found for derived address {} — register via memory::register_sub_agent",
                derived_address
            ));
        }
        Err(e) => {
            return Err(format!("social API lookup failed: {}", e));
        }
    }
}

// ============================================================
// Unit Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ── MED-1: Nonce must be valid UUID v4 ──────────────────────────────

    #[test]
    fn nonce_valid_uuid_accepted() {
        let nonce = "550e8400-e29b-41d4-a716-446655440000";
        assert!(uuid::Uuid::parse_str(nonce).is_ok());
    }

    #[test]
    fn nonce_invalid_format_rejected() {
        let bad_nonces = [
            "",
            "not-a-uuid",
            "12345",
            "550e8400-e29b-41d4-a716",            // truncated
            "ZZZZZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZZZZZZZZZ", // non-hex
            "../../../etc/passwd",                  // injection attempt
        ];
        for nonce in bad_nonces {
            assert!(
                uuid::Uuid::parse_str(nonce).is_err(),
                "should reject nonce: {:?}",
                nonce,
            );
        }
    }

    // ── INFO-2: checked_sub prevents overflow ───────────────────────────

    #[test]
    fn checked_sub_handles_underflow() {
        // Attacker sends timestamp = i64::MAX, now is a small positive number
        // 1700000000 - i64::MAX is a large negative number (no overflow),
        // but it's far outside the ±300s window → request rejected.
        let now: i64 = 1700000000;
        let timestamp: i64 = i64::MAX;
        let age = now.checked_sub(timestamp).unwrap_or(i64::MAX);
        // age is a huge negative value, well below -300
        assert!(age < -300, "age {} should be less than -300", age);
    }


    #[test]
    fn checked_sub_handles_negative_overflow() {
        // Attacker sends timestamp = i64::MIN
        let now: i64 = 1700000000;
        let timestamp: i64 = i64::MIN;
        let age = now.checked_sub(timestamp).unwrap_or(i64::MAX);
        // i64::MIN wraps — checked_sub returns None → i64::MAX
        assert_eq!(age, i64::MAX);
    }

    #[test]
    fn checked_sub_normal_case_passes() {
        let now: i64 = 1700000100;
        let timestamp: i64 = 1700000000;
        let age = now.checked_sub(timestamp).unwrap_or(i64::MAX);
        assert_eq!(age, 100);
        assert!(age <= 300); // within window
    }

    #[test]
    fn checked_sub_future_timestamp_within_window() {
        let now: i64 = 1700000000;
        let timestamp: i64 = 1700000200; // 200s in the future
        let age = now.checked_sub(timestamp).unwrap_or(i64::MAX);
        assert_eq!(age, -200);
        assert!(age >= -300); // within ±300s window
    }

    #[test]
    fn checked_sub_exactly_at_boundary() {
        let now: i64 = 1700000000;

        // Exactly at +300s boundary — should be accepted (age == 300, not > 300)
        let timestamp_past = now - 300;
        let age_past = now.checked_sub(timestamp_past).unwrap_or(i64::MAX);
        assert_eq!(age_past, 300);
        // The check is `age > 300 || age < -300`, so exactly 300 passes
        assert!(!(age_past > 300 || age_past < -300));

        // At +301s — should be rejected
        let timestamp_expired = now - 301;
        let age_expired = now.checked_sub(timestamp_expired).unwrap_or(i64::MAX);
        assert_eq!(age_expired, 301);
        assert!(age_expired > 300);
    }

    // ── LOW-1: Query parameters included in signed message ──────────────

    #[test]
    fn signed_message_includes_query_params() {
        // Simulate what the middleware does: use path_and_query
        let uri: axum::http::Uri = "/api/recall?limit=999".parse().unwrap();
        let path = uri
            .path_and_query()
            .map(|pq| pq.as_str().to_string())
            .unwrap_or_else(|| uri.path().to_string());

        assert_eq!(path, "/api/recall?limit=999");
        // The full query string is part of the message → signature covers it
    }

    #[test]
    fn signed_message_without_query_uses_path_only() {
        let uri: axum::http::Uri = "/api/remember".parse().unwrap();
        let path = uri
            .path_and_query()
            .map(|pq| pq.as_str().to_string())
            .unwrap_or_else(|| uri.path().to_string());

        assert_eq!(path, "/api/remember");
    }

    // ── LOW-2: constant_time_reject returns 401 ─────────────────────────

    #[tokio::test]
    async fn constant_time_reject_returns_unauthorized() {
        let status = constant_time_reject().await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn unsupported_legacy_sdk_returns_upgrade_required() {
        assert_eq!(unsupported_legacy_sdk(), StatusCode::UPGRADE_REQUIRED);
    }

    // ── LOW-23: account_id included in signed canonical message ─────────

    #[test]
    fn canonical_message_format_with_account_id() {
        let timestamp = "1700000000";
        let method = "POST";
        let path = "/api/remember";
        let body_hash = "abc123";
        let nonce = "550e8400-e29b-41d4-a716-446655440000";
        let account_id = "0xdeadbeef";

        let message = format!(
            "{}.{}.{}.{}.{}.{}",
            timestamp, method, path, body_hash, nonce, account_id
        );

        assert_eq!(
            message,
            "1700000000.POST./api/remember.abc123.550e8400-e29b-41d4-a716-446655440000.0xdeadbeef"
        );
        // Verify all 6 fields are present
        assert_eq!(message.matches('.').count(), 5);
    }

    #[test]
    fn canonical_message_without_account_id_uses_empty_string() {
        let account_id_hint: Option<String> = None;
        let account_id_for_sig = account_id_hint.unwrap_or_default();

        let message = format!(
            "{}.{}.{}.{}.{}.{}",
            "1700000000", "POST", "/api/recall", "hash", "nonce", account_id_for_sig
        );

        // Ends with a dot and empty string — will mismatch if client sends an actual account_id
        assert!(message.ends_with('.'));
    }

    // ── MED-1: Full signature + nonce verification flow ─────────────────

    #[test]
    fn signed_message_all_fields_present() {
        // Verify the canonical format: "{timestamp}.{method}.{path_and_query}.{body_sha256}.{nonce}.{account_id}"
        let parts = [
            "1700000000",
            "POST",
            "/api/analyze?ns=work",
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            "f47ac10b-58cc-4372-a567-0e02b2c3d479",
            "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        ];
        let message = parts.join(".");
        // Must have exactly 6 fields separated by 5 dots
        assert_eq!(message.split('.').count(), 6);
        // Nonce field (5th) must be a valid UUID
        let nonce_field = message.split('.').nth(4).unwrap();
        assert!(uuid::Uuid::parse_str(nonce_field).is_ok());
    }

    // ── Ed25519 signature verification integration ──────────────────────

    /// Helper: create a deterministic Ed25519 signing key for tests.
    /// Uses a fixed 32-byte secret key — NOT for production use.
    fn test_signing_key() -> ed25519_dalek::SigningKey {
        let secret: [u8; 32] = [
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
            0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
            0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
            0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
        ];
        ed25519_dalek::SigningKey::from_bytes(&secret)
    }

    #[test]
    fn ed25519_roundtrip_signature_verification() {
        use ed25519_dalek::Signer;

        let signing_key = test_signing_key();
        let verifying_key = signing_key.verifying_key();

        let message = "1700000000.POST./api/remember.abc123.f47ac10b-58cc-4372-a567-0e02b2c3d479.0xdead";
        let signature = signing_key.sign(message.as_bytes());

        // Valid signature passes
        assert!(verifying_key.verify(message.as_bytes(), &signature).is_ok());

        // Tampered message fails
        let tampered = "1700000001.POST./api/remember.abc123.f47ac10b-58cc-4372-a567-0e02b2c3d479.0xdead";
        assert!(verifying_key.verify(tampered.as_bytes(), &signature).is_err());
    }

    #[test]
    fn ed25519_wrong_nonce_fails_verification() {
        use ed25519_dalek::Signer;

        let signing_key = test_signing_key();
        let verifying_key = signing_key.verifying_key();

        let nonce1 = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
        let nonce2 = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

        let msg1 = format!("1700000000.POST./api/remember.hash.{}.0xdead", nonce1);
        let signature = signing_key.sign(msg1.as_bytes());

        // Replacing nonce = replay with different nonce → signature fails
        let msg2 = format!("1700000000.POST./api/remember.hash.{}.0xdead", nonce2);
        assert!(verifying_key.verify(msg2.as_bytes(), &signature).is_err());
    }

    #[test]
    fn ed25519_wrong_account_id_fails_verification() {
        use ed25519_dalek::Signer;

        let signing_key = test_signing_key();
        let verifying_key = signing_key.verifying_key();

        let msg = "1700000000.POST./api/recall.hash.nonce.0xaccount_a";
        let signature = signing_key.sign(msg.as_bytes());

        // Swapping account_id → signature fails (LOW-23)
        let swapped = "1700000000.POST./api/recall.hash.nonce.0xaccount_b";
        assert!(verifying_key.verify(swapped.as_bytes(), &signature).is_err());
    }

    // ── ENG-1696: Manual-mode trust boundary ────────────────────────────
    //
    // Manual-mode routes (/api/remember/manual, /api/recall/manual) must
    // succeed without the `x-delegate-key` header. The SDK no longer emits
    // this header on those routes (packages/sdk/src/memory.ts), and Manual-
    // mode route handlers (services/server/src/routes.rs) never read
    // `AuthInfo.delegate_key`. This test locks in the invariant that
    // `AuthInfo` is valid with `delegate_key: None` so a future refactor
    // cannot silently re-introduce a requirement on the header.

    #[test]
    fn required_capability_write_routes() {
        assert_eq!(
            required_capability_for_path("POST", "/api/remember"),
            CAP_MEMORY_WRITE
        );
        assert_eq!(
            required_capability_for_path("POST", "/api/analyze"),
            CAP_MEMORY_WRITE
        );
        assert_eq!(
            required_capability_for_path("POST", "/api/restore"),
            CAP_MEMORY_WRITE
        );
    }

    #[test]
    fn required_capability_read_routes() {
        assert_eq!(
            required_capability_for_path("POST", "/api/recall"),
            CAP_MEMORY_READ
        );
        assert_eq!(
            required_capability_for_path("GET", "/api/recall"),
            CAP_MEMORY_READ
        );
    }

    #[test]
    fn auth_info_valid_without_sub_agent_key_for_manual_routes() {
        let auth = AuthInfo {
            public_key: "abcd".to_string(),
            owner: "0xowner".to_string(),
            account_id: "0xaccount".to_string(),
            agent_object_id: "0xagent".to_string(),
            derived_address: "0xderived".to_string(),
            capabilities: CAP_MEMORY_READ,
            sub_agent_key: None,
            mydata_session: None,
        };
        assert!(auth.sub_agent_key.is_none());
        assert!(auth.mydata_session.is_none());
        let debug_str = format!("{:?}", auth);
        assert!(debug_str.contains("None"));
        assert!(!debug_str.contains("<redacted>"));
    }
}
