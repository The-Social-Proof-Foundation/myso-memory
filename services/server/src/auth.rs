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

use crate::memory_contract::{self, CAP_MEMORY_READ, CAP_MEMORY_WRITE};
use crate::myso::{derived_address_from_public_key, verify_sub_agent_onchain};
use crate::policy::{PolicyError, RequestPolicyInput, validate_agent_policy};
use crate::social::{
    fetch_ancestor_chain, fetch_sub_agent_by_derived_address, SocialApiError, SocialSubAgent,
};
use crate::types::{AppState, AuthInfo};

/// Estimated gas for a sponsored File Storage upload (MIST). Conservative ceiling for max_action_spend checks.
const ESTIMATED_UPLOAD_SPEND_MIST: u64 = 50_000_000;

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
    verifying_key
        .verify(message.as_bytes(), &signature)
        .is_ok()
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

    let sub_agent_key_hex = headers
        .get("x-delegate-key")
        .and_then(|v| v.to_str().ok())
        .map(String::from);

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
    let pk_array: [u8; 32] = pk_bytes
        .try_into()
        .map_err(|_| StatusCode::UNAUTHORIZED)?;
    let verifying_key =
        VerifyingKey::from_bytes(&pk_array).map_err(|_| StatusCode::UNAUTHORIZED)?;

    let sig_bytes = hex::decode(&signature_hex).map_err(|_| StatusCode::UNAUTHORIZED)?;
    let sig_array: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| StatusCode::UNAUTHORIZED)?;
    let signature = Signature::from_bytes(&sig_array);

    let method = request.method().as_str().to_string();
    let path = request
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| request.uri().path().to_string());

    let owner_pk_header = headers
        .get("x-owner-public-key")
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let owner_sig_header = headers
        .get("x-owner-signature")
        .and_then(|v| v.to_str().ok())
        .map(String::from);

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

    let required_cap = required_capability_for_path(method.as_str(), path.as_str());
    let is_write = required_cap == CAP_MEMORY_WRITE;

    let policy_input = RequestPolicyInput::from_headers(
        &parts.headers,
        false,
        if is_write {
            ESTIMATED_UPLOAD_SPEND_MIST
        } else {
            0
        },
    );

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
        Err(ResolveError::Other(_)) => return Err(constant_time_reject().await),
    };

    parts.extensions.insert(AuthInfo {
        public_key: public_key_hex,
        owner: resolved.owner,
        account_id: resolved.agent.account_id.clone(),
        agent_object_id: resolved.agent.agent_object_id.clone(),
        derived_address: resolved.agent.derived_address.clone(),
        capabilities: resolved.agent.capabilities as u64,
        approval_required_caps: resolved.agent.approval_required_caps as u64,
        max_action_spend: resolved.agent.max_action_spend.map(|v| v as u64),
        platform_scope: resolved.agent.platform_scope.clone(),
        platform_id: policy_input.platform_id.clone(),
        label: resolved.agent.label.clone(),
        sub_agent_key: sub_agent_key_hex,
        mydata_session,
        owner_co_signed: resolved.owner_co_signed,
    });

    let request = Request::from_parts(parts, axum::body::Body::from(body_bytes));
    Ok(next.run(request).await)
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

    let mut agent: Option<SocialSubAgent> = None;
    let mut owner = String::new();

    if let Ok(Some(_cached)) = state.db.get_cached_sub_agent(public_key_hex).await {
        if let Ok(indexed) = fetch_sub_agent_by_derived_address(
            &state.http_client,
            &state.config.social_server_url,
            &derived_address,
        )
        .await
        {
            match verify_sub_agent_onchain(
                &state.http_client,
                &state.config.myso_rpc_url,
                &indexed.account_id,
                &indexed.agent_object_id,
                pk_bytes,
                required_cap,
            )
            .await
            {
                Ok(verified) => {
                    owner = verified.owner;
                    agent = Some(indexed);
                }
                Err(e) => {
                    let _ = state.db.delete_cached_sub_agent(public_key_hex).await;
                    return Err(ResolveError::Other(e.to_string()));
                }
            }
        }
    }

    if agent.is_none() {
        match fetch_sub_agent_by_derived_address(
            &state.http_client,
            &state.config.social_server_url,
            &derived_address,
        )
        .await
        {
            Ok(indexed) => {
                if let Some(ref hint) = account_id_hint {
                    if hint != &indexed.account_id {
                        return Err(ResolveError::Other(
                            "x-account-id does not match indexed sub-agent account".into(),
                        ));
                    }
                }
                let verified = verify_sub_agent_onchain(
                    &state.http_client,
                    &state.config.myso_rpc_url,
                    &indexed.account_id,
                    &indexed.agent_object_id,
                    pk_bytes,
                    required_cap,
                )
                .await
                .map_err(|e| ResolveError::Other(e.to_string()))?;
                owner = verified.owner;
                agent = Some(indexed);
            }
            Err(SocialApiError::NotFound) => {
                return Err(ResolveError::Other(format!(
                    "sub-agent not found for derived address {}",
                    derived_address
                )));
            }
            Err(e) => return Err(ResolveError::Other(e.to_string())),
        }
    }

    let agent = agent.expect("agent resolved");
    let ancestors = fetch_ancestor_chain(
        &state.http_client,
        &state.config.social_server_url,
        &agent,
    )
    .await
    .map_err(|e| ResolveError::Other(e.to_string()))?;

    let owner_co_signed = match (owner_pk, owner_sig) {
        (Some(pk), Some(sig)) if is_write => {
            verify_owner_co_signature(pk, sig, message, &owner)
        }
        _ => false,
    };

    let input = RequestPolicyInput {
        platform_id: policy_input.platform_id.clone(),
        owner_co_signed,
        estimated_spend_mist: policy_input.estimated_spend_mist,
    };

    validate_agent_policy(&agent, &ancestors, required_cap, &input, is_write)
        .map_err(ResolveError::Policy)?;

    let _ = state.db.cache_sub_agent(public_key_hex, &agent, &owner).await;

    Ok(ResolvedSubAgent {
        agent,
        owner,
        owner_co_signed: input.owner_co_signed,
    })
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
            platform_scope: None,
            platform_id: None,
            label: "test".into(),
            sub_agent_key: None,
            mydata_session: None,
            owner_co_signed: false,
        };
        assert_eq!(auth.agent_object_id, "0xagent");
    }
}
