use axum::{
    extract::{Request, State},
    http::{StatusCode,HeaderValue,header::CACHE_CONTROL},
    middleware::Next,
    response::Response,
};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use redis::AsyncCommands;
use sha2::{Digest, Sha256};
use std::sync::Arc;

use crate::memory_contract::{
    self, capability_label, check_direct_execution_allowed, CAP_AI_SPEND,
    CAP_COMMENT, CAP_MEMORY_READ, CAP_MEMORY_WRITE, CAP_MESSAGE_READ, CAP_MYDATA_READ,
    CAP_POST_PUBLISH, CAP_REACT, CAP_TASK_TRADE, E_SUB_AGENT_APPROVAL_REQUIRED,
};
use crate::myso::{
    canonical_agent_by_object_id, derived_address_from_public_key, verify_sub_agent_onchain,
};
use crate::policy::{validate_agent_policy, PolicyError, RequestPolicyInput};
use crate::social::{fetch_sub_agent_by_derived_address, SocialApiError, SocialSubAgent};
use crate::types::{AppState, AuthInfo};

async fn constant_time_reject() -> StatusCode {
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    StatusCode::UNAUTHORIZED
}

fn policy_reject(err: PolicyError) -> StatusCode {
    tracing::warn!("policy rejected: {} (code={})", err, err.error_code());
    StatusCode::FORBIDDEN
}

fn unsupported_legacy_sdk() -> StatusCode {
    StatusCode::UPGRADE_REQUIRED
}

fn verify_owner_co_signature(
    owner_pk_hex: &str,
    owner_sig_hex: &str,
    message: &str,
    expected_owner: &str,
) -> bool {
    let Ok(pk_bytes) = hex::decode(owner_pk_hex) else {
        return false;
    };
    let Ok(pk_array): Result<[u8; 32], _> = pk_bytes.try_into() else {
        return false;
    };
    let Ok(verifying_key) = VerifyingKey::from_bytes(&pk_array) else {
        return false;
    };
    let derived = derived_address_from_public_key(&pk_array);
    if !memory_contract::addresses_equal(&derived, expected_owner) {
        return false;
    }
    let Ok(sig_bytes) = hex::decode(owner_sig_hex) else {
        return false;
    };
    let Ok(sig_array): Result<[u8; 64], _> = sig_bytes.try_into() else {
        return false;
    };
    let signature = Signature::from_bytes(&sig_array);
    verifying_key.verify(message.as_bytes(), &signature).is_ok()
}

pub async fn verify_signature(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let headers = request.headers();

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

    let account_id_hint = headers
        .get("x-account-id")
        .and_then(|v| v.to_str().ok())
        .map(String::from);

    if headers.contains_key("x-delegate-key") && !state.config.allow_legacy_delegate_key_forwarding
    {
        tracing::warn!(
            target: "memory::security",
            "rejected legacy x-delegate-key transport"
        );
        return Err(StatusCode::BAD_REQUEST);
    }
    let sub_agent_key_hex = state
        .config
        .allow_legacy_delegate_key_forwarding
        .then(|| {
            headers
                .get("x-delegate-key")
                .and_then(|v| v.to_str().ok())
                .map(String::from)
        })
        .flatten();

    let signed_platform = headers.get("x-platform-id").and_then(|v|v.to_str().ok()).map(String::from);
    let platform_signature = headers.get("x-platform-signature").and_then(|v|v.to_str().ok()).map(String::from);

    let mydata_session = headers
        .get("x-mydata-session")
        .and_then(|v| v.to_str().ok())
        .map(String::from);

    let nonce = headers
        .get("x-nonce")
        .and_then(|v| v.to_str().ok())
        .map(String::from)
        .ok_or_else(|| {
            tracing::warn!(target: "memory::deprecation", "request missing x-nonce");
            unsupported_legacy_sdk()
        })?;

    if uuid::Uuid::parse_str(&nonce).is_err() {
        return Err(constant_time_reject().await);
    }

    let sdk_compat = headers
        .get("x-sdk-compatibility")
        .and_then(|v| v.to_str().ok());
    if let Err(status) = crate::jobs::check_sdk_compatibility_header(sdk_compat) {
        return Err(status);
    }

    let timestamp: i64 = timestamp_str
        .parse()
        .map_err(|_| StatusCode::UNAUTHORIZED)?;
    let now = chrono::Utc::now().timestamp();
    let age = now.checked_sub(timestamp).unwrap_or(i64::MAX);
    if age > 300 || age < -300 {
        return Err(constant_time_reject().await);
    }

    let pk_bytes = hex::decode(&public_key_hex).map_err(|_| StatusCode::UNAUTHORIZED)?;
    let pk_array: [u8; 32] = pk_bytes.try_into().map_err(|_| StatusCode::UNAUTHORIZED)?;
    let verifying_key =
        VerifyingKey::from_bytes(&pk_array).map_err(|_| StatusCode::UNAUTHORIZED)?;

    let sig_bytes = hex::decode(&signature_hex).map_err(|_| StatusCode::UNAUTHORIZED)?;
    let sig_array: [u8; 64] = sig_bytes.try_into().map_err(|_| StatusCode::UNAUTHORIZED)?;
    let signature = Signature::from_bytes(&sig_array);

    let method = request.method().as_str().to_string();
    let path_only = request.uri().path().to_string();
    let path = request
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| path_only.clone());

    let owner_pk_header = headers
        .get("x-owner-public-key")
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let owner_sig_header = headers
        .get("x-owner-signature")
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    if headers.contains_key("x-owner-delegate-key")
        && !state.config.allow_legacy_social_key_forwarding
    {
        tracing::warn!(
            target: "memory::security",
            "rejected legacy x-owner-delegate-key transport"
        );
        return Err(StatusCode::BAD_REQUEST);
    }
    let owner_delegate_key = state
        .config
        .allow_legacy_social_key_forwarding
        .then(|| {
            headers
                .get("x-owner-delegate-key")
                .and_then(|v| v.to_str().ok())
                .map(String::from)
        })
        .flatten();

    let (mut parts, body) = request.into_parts();

    let body_bytes = axum::body::to_bytes(body, 1024 * 1024)
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?;

    let body_hash = hex::encode(Sha256::digest(&body_bytes));
    let account_id_for_sig = account_id_hint.clone().unwrap_or_default();
    let message = format!(
        "{}.{}.{}.{}.{}.{}",
        timestamp_str, method, path, body_hash, nonce, account_id_for_sig
    );

    if verifying_key
        .verify(message.as_bytes(), &signature)
        .is_err()
    {
        return Err(constant_time_reject().await);
    }

    if let Some(platform) = signed_platform.as_deref() {
        crate::owner_auth::address(platform).map_err(|_|StatusCode::BAD_REQUEST)?;
        let encoded = platform_signature.as_deref().ok_or_else(unsupported_legacy_sdk)?;
        let bytes: [u8;64] = hex::decode(encoded).map_err(|_|StatusCode::UNAUTHORIZED)?.try_into().map_err(|_|StatusCode::UNAUTHORIZED)?;
        let bound = format!("mysocial-request-platform-v1|{}|{}",platform,message);
        if verifying_key.verify(bound.as_bytes(),&Signature::from_bytes(&bytes)).is_err() {return Err(constant_time_reject().await);}
    } else if platform_signature.is_some() {return Err(StatusCode::BAD_REQUEST);}

    {
        let nonce_key = format!("nonce:{}", nonce);
        let mut redis = state.redis.clone();
        let set_result: Option<String> = redis
            .set_options(
                &nonce_key,
                "1",
                redis::SetOptions::default()
                    .conditional_set(redis::ExistenceCheck::NX)
                    .with_expiration(redis::SetExpiry::EX(600)),
            )
            .await
            .unwrap_or(None);

        if set_result.is_none() {
            return Err(constant_time_reject().await);
        }
    }

    let required_cap = required_capability_for_path(method.as_str(), &path_only);
    let is_write = is_write_route(method.as_str(), &path_only);

    let policy_input = RequestPolicyInput::from_headers(&parts.headers);

    let resolved = match resolve_sub_agent(
        &state,
        &public_key_hex,
        &pk_array,
        account_id_hint,
        required_cap,
        &policy_input,
        is_write,
        &message,
        owner_pk_header.as_deref(),
        owner_sig_header.as_deref(),
    )
    .await
    {
        Ok(info) => info,
        Err(ResolveError::Policy(e)) => return Err(policy_reject(e)),
        Err(ResolveError::Other(msg)) => {
            tracing::debug!("auth resolve failed: {msg}");
            return Err(constant_time_reject().await);
        }
    };

    if is_write && required_cap != 0 {
        if let Err(code) = check_direct_execution_allowed(
            resolved.agent.approval_required_caps as u64,
            required_cap,
            resolved.owner_co_signed,
        ) {
            if code == E_SUB_AGENT_APPROVAL_REQUIRED {
                return Err(policy_reject(PolicyError::ApprovalRequired {
                    required: required_cap,
                }));
            }
        }
    }

    if requires_mydata_access(&path_only)
        && !memory_contract::has_cap(resolved.agent.capabilities as u64, CAP_MYDATA_READ)
    {
        tracing::warn!(
            "agent {} missing {}",
            resolved.agent.agent_object_id,
            capability_label(CAP_MYDATA_READ)
        );
        return Err(policy_reject(PolicyError::MissingCapability {
            required: CAP_MYDATA_READ,
        }));
    }

    parts.extensions.insert(AuthInfo {
        public_key: public_key_hex,
        owner: resolved.owner,
        account_id: resolved.agent.account_id.clone(),
        agent_object_id: resolved.agent.agent_object_id.clone(),
        derived_address: resolved.agent.derived_address.clone(),
        capabilities: resolved.agent.capabilities as u64,
        approval_required_caps: resolved.agent.approval_required_caps as u64,
        max_action_spend: resolved.agent.max_action_spend.map(|v| v as u64),
        expires_at_ms: resolved.agent.expires_at_ms,
        platform_scope: resolved.agent.platform_scope.clone(),
        organization_id: resolved.agent.organization_id.clone(),
        platform_id: policy_input.platform_id.clone(),
        label: resolved.agent.label.clone(),
        sub_agent_key: sub_agent_key_hex,
        mydata_session,
        owner_co_signed: resolved.owner_co_signed,
        owner_delegate_key,
    });

    let request = Request::from_parts(parts, axum::body::Body::from(body_bytes));
    Ok(private_response(next.run(request).await))
}

/// Signed responses carry account/agent context and must not enter shared caches.
fn private_response(mut response:Response)->Response{
    response.headers_mut().insert(CACHE_CONTROL,HeaderValue::from_static("private, no-store"));
    response
}

struct ResolvedSubAgent {
    agent: SocialSubAgent,
    owner: String,
    owner_co_signed: bool,
}

enum ResolveError {
    Policy(PolicyError),
    Other(String),
}

fn is_write_route(method: &str, path: &str) -> bool {
    if path.starts_with("/api/social/") {
        return true;
    }
    method == "POST"
        && (path.starts_with("/api/remember")
            || path == "/api/chain/actions/prepare"
            || path == "/api/chain/actions/submit"
            || path == "/api/chain/approvals/request"
            || path == "/api/analyze"
            || path == "/api/ask"
            || path == "/api/ai-credit/chat"
            || path == "/api/ai-credit/inference"
            || path == "/api/ai-credit/record-inference"
            || path == "/api/restore"
            || path == "/api/task/deliverable/upload"
            || path == "/api/messaging/attachments/upload"
            || path.starts_with("/api/work/"))
}

fn requires_mydata_access(path: &str) -> bool {
    path == "/api/mydata/read-content"
        || path == "/api/mydata/check-current-access"
        || path.starts_with("/api/work/")
        || path.starts_with("/api/remember")
        || path.starts_with("/api/recall")
        || path == "/api/restore"
        || path == "/api/analyze"
        || path == "/api/ask"
}

pub(crate) fn require_path_capability(auth: &AuthInfo, method: &str, path: &str) -> Result<(), crate::types::AppError> {
    let required = required_capability_for_path(method, path);
    if auth.capabilities & required == required {
        Ok(())
    } else {
        Err(crate::types::AppError::Forbidden("The active sub-agent lacks the required capability".into()))
    }
}

fn required_capability_for_path(method: &str, path: &str) -> u64 {
    // The owner-agent module enforces its documented any-of management capability guard.
    if path.starts_with("/api/agent/read/agent_admin_") {return 0;}
    if path == "/api/agent/read/mydata_agent_funding_coins" { return CAP_MYDATA_READ; }
    if path == "/api/agent/read/task_agent_funding_coins" { return CAP_TASK_TRADE; }
    if path.starts_with("/api/agent/read/payments_") {return crate::memory_contract::CAP_TRADE_EXECUTE;}
    if path == "/api/agent/read/dex_receipt" {return crate::memory_contract::CAP_TRADE_EXECUTE;}
    if path.starts_with("/api/agent/read/poc_") {return crate::memory_contract::CAP_TRADE_EXECUTE;}
    if path.starts_with("/api/agent/read/subscription_") {return crate::memory_contract::CAP_TRADE_EXECUTE;}
    if matches!(path, "/api/mydata/read-content" | "/api/mydata/check-current-access" | "/api/mydata/graph/verify-seller") { return CAP_MYDATA_READ; }
    if path == "/api/task/deliverable/upload" { return crate::memory_contract::CAP_TASK_TRADE; }
    if matches!(path, "/api/agent/read/mydata_listings" | "/api/agent/read/mydata_graph_offers" | "/api/agent/read/mydata_owned_listings" | "/api/agent/read/mydata_quote" | "/api/agent/read/mydata_receipt" | "/api/agent/read/mydata_owner_receipt" | "/api/agent/read/mydata_owner_access_history") { return CAP_MYDATA_READ; }
    if path == "/api/messaging/attachments/upload" {
        return crate::memory_contract::CAP_MESSAGE_SEND;
    }
    if path.starts_with("/api/messaging/") {
        return CAP_MESSAGE_READ;
    }
    if matches!(path, "/api/agent/read/rooms" | "/api/agent/read/organization_rooms") {
        return CAP_MESSAGE_READ;
    }
    if matches!(path, "/api/agent/read/social_messaging_group_digests" | "/api/agent/read/social_messaging_group_members" | "/api/agent/read/social_messaging_message_receipt") { return CAP_MESSAGE_READ; }
    if path == "/api/agent/read/social_mydata_buyer_purchases" { return CAP_MYDATA_READ; }
    if path == "/api/agent/context" || path.starts_with("/api/agent/read/") || path.starts_with("/api/chain/actions/") {
        return 0;
    }
    if path == "/api/ai-credit/chat" || path == "/api/ai-credit/inference" || path == "/api/ai-credit/record-inference" {
        return CAP_AI_SPEND;
    }
    if path.starts_with("/api/social/") {
        if method == "DELETE" {
            if path.starts_with("/api/social/post/") {
                return CAP_POST_PUBLISH;
            }
            if path.starts_with("/api/social/comment/") {
                return CAP_COMMENT;
            }
        }
        if method == "POST" {
            if path == "/api/social/post" || path == "/api/social/repost" {
                return CAP_POST_PUBLISH;
            }
            if path == "/api/social/comment" {
                return CAP_COMMENT;
            }
            if path.starts_with("/api/social/react/") {
                return CAP_REACT;
            }
        }
        return CAP_MEMORY_READ;
    }

    if method != "POST" {
        return CAP_MEMORY_READ;
    }
    if path.starts_with("/api/work/")
        || path.starts_with("/api/remember")
        || path == "/api/analyze"
        || path == "/api/ask"
        || path == "/api/restore"
    {
        CAP_MEMORY_WRITE
    } else {
        CAP_MEMORY_READ
    }
}

async fn resolve_sub_agent(
    state: &AppState,
    public_key_hex: &str,
    pk_bytes: &[u8; 32],
    account_id_hint: Option<String>,
    required_cap: u64,
    policy_input: &RequestPolicyInput,
    is_write: bool,
    message: &str,
    owner_pk: Option<&str>,
    owner_sig: Option<&str>,
) -> Result<ResolvedSubAgent, ResolveError> {
    let derived_address = derived_address_from_public_key(pk_bytes);

    let account_id_hint = account_id_hint.map(|a| crate::memory_contract::normalize_object_id(&a));

    // Discovery only: whichever source names the agent, chain state below is authoritative.
    let (account_id, agent_object_id) = match state.db.get_cached_sub_agent(public_key_hex).await {
        Ok(Some(cached)) => (cached.account_id, cached.agent_object_id),
        _ => discover_agent(state, &derived_address, account_id_hint.as_deref()).await?,
    };

    let owner = match verify_sub_agent_onchain(
        &state.http_client,
        &state.config.myso_rpc_url,
        &account_id,
        &agent_object_id,
        pk_bytes,
        required_cap,
    )
    .await
    {
        Ok(verified) => verified.owner,
        Err(e) => {
            let _ = state.db.delete_cached_sub_agent(public_key_hex).await;
            return Err(ResolveError::Other(e.to_string()));
        }
    };

    let agent = canonical_agent_by_object_id(
        &state.http_client,
        &state.config.myso_rpc_url,
        &state.config.package_id,
        &agent_object_id,
    )
    .await
    .map_err(|e| ResolveError::Other(e.to_string()))?;
    if !memory_contract::addresses_equal(&agent.account_id, &account_id)
        || !memory_contract::addresses_equal(&agent.derived_address, &derived_address)
    {
        let _ = state.db.delete_cached_sub_agent(public_key_hex).await;
        return Err(ResolveError::Other(
            "on-chain sub-agent is not bound to the signing key".into(),
        ));
    }
    if account_id_hint.as_deref().is_some_and(|hint| !memory_contract::addresses_equal(hint, &agent.account_id)) {
        return Err(ResolveError::Other("x-account-id mismatch".into()));
    }
    let mut ancestors = Vec::new();
    let mut parent = agent.parent_object_id.clone();
    let mut seen = std::collections::HashSet::new();
    while let Some(id) = parent {
        if !seen.insert(id.clone()) || ancestors.len() >= memory_contract::MAX_AGENT_DEPTH as usize {
            return Err(ResolveError::Other("invalid ancestor chain".into()));
        }
        let canonical = canonical_agent_by_object_id(&state.http_client, &state.config.myso_rpc_url, &state.config.package_id, &id).await.map_err(|e|ResolveError::Other(e.to_string()))?;
        if !memory_contract::addresses_equal(&canonical.account_id,&agent.account_id) || canonical.organization_id != agent.organization_id {
            return Err(ResolveError::Other("ancestor identity mismatch".into()));
        }
        parent=canonical.parent_object_id.clone();ancestors.push(canonical);
    }

    let owner_co_signed = match (owner_pk, owner_sig) {
        (Some(pk), Some(sig)) if is_write => verify_owner_co_signature(pk, sig, message, &owner),
        _ => false,
    };

    validate_agent_policy(&agent, &ancestors, required_cap, &policy_input)
        .map_err(ResolveError::Policy)?;

    let _ = state
        .db
        .cache_sub_agent(public_key_hex, &agent, &owner)
        .await;

    Ok(ResolvedSubAgent {
        agent,
        owner,
        owner_co_signed,
    })
}

/// Map a signing key's derived address to `(account_id, agent_object_id)`. The signed
/// `x-account-id` is resolved through the on-chain `MemoryAccount.agents` registry; the
/// social indexer is only a fallback for clients that omit it.
async fn discover_agent(
    state: &AppState,
    derived_address: &str,
    account_id_hint: Option<&str>,
) -> Result<(String, String), ResolveError> {
    if let Some(account_id) = account_id_hint {
        return match crate::org_chain::agent_object_id_in_account(
            &state.http_client,
            &state.config.myso_rpc_url,
            &state.config.package_id,
            account_id,
            derived_address,
        )
        .await
        {
            Ok(Some(agent_object_id)) => Ok((account_id.to_string(), agent_object_id)),
            Ok(None) => Err(ResolveError::Other(format!(
                "sub-agent {derived_address} is not registered in account {account_id}"
            ))),
            Err(e) => Err(ResolveError::Other(e.to_string())),
        };
    }
    match fetch_sub_agent_by_derived_address(
        &state.http_client,
        &state.config.social_server_url,
        derived_address,
    )
    .await
    {
        Ok(indexed) => Ok((indexed.account_id, indexed.agent_object_id)),
        Err(SocialApiError::NotFound) => Err(ResolveError::Other(format!(
            "sub-agent not found for derived address {derived_address}"
        ))),
        Err(e) => Err(ResolveError::Other(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn required_capability_write_routes() {
        assert_eq!(
            required_capability_for_path("POST", "/api/remember"),
            CAP_MEMORY_WRITE
        );
    }

    #[test]
    fn authenticated_responses_disable_caching_without_replacing_cors_vary(){
        let mut response=Response::new(axum::body::Body::empty());
        response.headers_mut().insert(axum::http::header::VARY,HeaderValue::from_static("Origin"));
        let response=private_response(response);
        assert_eq!(response.headers()[CACHE_CONTROL],"private, no-store");
        assert_eq!(response.headers()[axum::http::header::VARY],"Origin");
    }
    #[test]
    fn coin_reads_require_the_trade_capability(){
        for resource in ["payments_quote","payments_coins","payments_balance","payments_receipt"]{
            assert_eq!(required_capability_for_path("GET",&format!("/api/agent/read/{resource}")),crate::memory_contract::CAP_TRADE_EXECUTE);
        }
    }
    #[test]
    fn subscription_reads_require_the_trade_capability(){
        for resource in ["subscription_quote","subscription_renewal_quote","subscription_get","subscription_list","subscription_plans","subscription_receipt"]{
            assert_eq!(required_capability_for_path("GET",&format!("/api/agent/read/{resource}")),crate::memory_contract::CAP_TRADE_EXECUTE);
        }
    }
    #[test]
    fn direct_content_disclosure_requires_mydata_capability_without_a_spend_route() {
        assert_eq!(required_capability_for_path("POST", "/api/mydata/read-content"), CAP_MYDATA_READ);
        assert_eq!(required_capability_for_path("POST", "/api/mydata/graph/verify-seller"), CAP_MYDATA_READ);
        assert!(requires_mydata_access("/api/mydata/read-content"));
        assert!(!is_write_route("POST", "/api/mydata/read-content"));
    }
    #[test]
    fn messaging_inbox_requires_message_read() {
        assert_eq!(
            required_capability_for_path("GET", "/api/messaging/inbox"),
            CAP_MESSAGE_READ,
        );
        assert_eq!(
            required_capability_for_path("GET", "/api/messaging/wait"),
            CAP_MESSAGE_READ,
        );
    }

    #[test]
    fn required_capability_social_post() {
        assert_eq!(
            required_capability_for_path("POST", "/api/social/post"),
            CAP_POST_PUBLISH
        );
    }

    #[test]
    fn required_capability_social_delete_post() {
        assert_eq!(
            required_capability_for_path("DELETE", "/api/social/post/0xabc"),
            CAP_POST_PUBLISH
        );
    }

    #[test]
    fn is_write_route_social() {
        assert!(is_write_route("POST", "/api/social/post"));
        assert!(is_write_route("DELETE", "/api/social/post/0xabc"));
    }

    #[test]
    fn context_is_available_to_any_authenticated_agent() {
        assert_eq!(required_capability_for_path("GET", "/api/agent/context"), 0);
        assert!(!requires_mydata_access("/api/agent/context"));
    }

    #[test]
    fn registry_gateway_defers_action_capability_to_validated_body() {
        assert_eq!(
            required_capability_for_path("POST", "/api/chain/actions/prepare"),
            0
        );
        assert!(is_write_route("POST", "/api/chain/actions/prepare"));
    }

    #[test]
    fn analyze_and_ask_require_memory_write_and_mydata() {
        assert_eq!(
            required_capability_for_path("POST", "/api/analyze"),
            CAP_MEMORY_WRITE
        );
        assert_eq!(
            required_capability_for_path("POST", "/api/ask"),
            CAP_MEMORY_WRITE
        );
        assert!(requires_mydata_access("/api/analyze"));
        assert!(requires_mydata_access("/api/ask"));
        assert!(is_write_route("POST", "/api/analyze"));
        assert!(is_write_route("POST", "/api/ask"));
    }

    #[test]
    fn inference_requires_ai_spend_capability() {
        assert_eq!(
            required_capability_for_path("POST", "/api/ai-credit/inference"),
            CAP_AI_SPEND
        );
        assert!(is_write_route("POST", "/api/ai-credit/inference"));
    }

    #[test]
    fn auth_info_includes_policy_fields() {
        let auth = AuthInfo {
            public_key: "abcd".into(),
            owner: "0xowner".into(),
            account_id: "0xaccount".into(),
            agent_object_id: "0xagent".into(),
            derived_address: "0xderived".into(),
            capabilities: CAP_MEMORY_READ,
            approval_required_caps: 0,
            max_action_spend: None,
            expires_at_ms: None,
            platform_scope: None,
            organization_id: None,
            platform_id: None,
            label: "test".into(),
            sub_agent_key: None,
            mydata_session: None,
            owner_co_signed: false,
            owner_delegate_key: None,
        };
        assert_eq!(auth.agent_object_id, "0xagent");
        assert_eq!(auth.label, "test");
        assert_eq!(auth.approval_required_caps, 0);
        assert!(auth.max_action_spend.is_none());
        assert!(auth.organization_id.is_none());
    }
}
