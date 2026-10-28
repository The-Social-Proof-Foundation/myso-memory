//! Bind a verified wallet session to the owner's single root agent.
//! Indexer rows are candidates only; the configured fullnode decides parentage.
use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::Arc;

use crate::types::{AppError, AppState};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletRootRequest {
    wallet_address: String,
    #[serde(default)]
    agent_object_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletRootResponse {
    account_id: String,
    agent_object_id: String,
    root_agent_object_id: String,
    signer_session_id: String,
}

pub async fn internal_mcp_wallet_root(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<WalletRootRequest>,
) -> Result<Json<WalletRootResponse>, AppError> {
    let Some(secret) = state.config.internal_sync_secret.as_deref() else {
        return Err(AppError::Internal("internal sync secret is not configured".into()));
    };
    let provided = headers.get("x-internal-sync-secret").and_then(|value| value.to_str().ok()).unwrap_or("");
    if secret.is_empty() || !crate::routes::internal_secret_matches(provided, secret) {
        return Err(AppError::Unauthorized("unauthorized".into()));
    }
    let wallet = crate::chain_reads::id(body.wallet_address.trim())?;
    let account_id = memory_account_for_owner(&state, &wallet).await?;
    let root = single_root_agent(&state, &wallet, &account_id).await?;
    let selected = match body.agent_object_id.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        Some(requested) => child_under_root(&state, &account_id, &root, requested).await?,
        None => root.clone(),
    };
    let exp = chrono::Utc::now().timestamp() + 30 * 60;
    let signer_session_id = signer_session(secret, &wallet, &account_id, exp);
    Ok(Json(WalletRootResponse {
        account_id,
        agent_object_id: selected,
        root_agent_object_id: root,
        signer_session_id,
    }))
}

async fn memory_account_for_owner(state: &AppState, wallet: &str) -> Result<String, AppError> {
    let value = social_get(state, &format!("/profiles/{wallet}/memory-account")).await?;
    let account_id = value.get("account_id").and_then(Value::as_str).ok_or_else(|| AppError::Forbidden("No memory account is registered for this wallet".into()))?;
    let owner = value.get("principal_owner").and_then(Value::as_str).unwrap_or("");
    if !crate::memory_contract::addresses_equal(owner, wallet) || !value.get("active").and_then(Value::as_bool).unwrap_or(false) {
        return Err(AppError::Forbidden("The indexed memory account does not belong to this active wallet".into()));
    }
    let chain_owner = crate::myso::fetch_memory_account_owner(&state.http_client, &state.config.myso_rpc_url, account_id).await.map_err(|error| AppError::Internal(error.to_string()))?;
    if !crate::memory_contract::addresses_equal(&chain_owner, wallet) {
        return Err(AppError::Forbidden("The fullnode memory account owner does not match this wallet".into()));
    }
    Ok(crate::chain_reads::id(account_id)?)
}

async fn single_root_agent(state: &AppState, wallet: &str, account_id: &str) -> Result<String, AppError> {
    let mut roots = Vec::new();
    let mut offset = 0i64;
    for _ in 0..4 {
        let page = social_get(state, &format!("/profiles/{wallet}/sub-agents?active_only=true&limit=50&offset={offset}")).await?;
        let rows = page.get("sub_agents").and_then(Value::as_array).ok_or_else(|| AppError::Internal("sub-agent inventory is invalid".into()))?;
        if rows.is_empty() { break; }
        for row in rows {
            let Some(agent_id) = row.get("agent_object_id").and_then(Value::as_str) else { continue };
            let parent = row.get("parent_object_id").and_then(Value::as_str).unwrap_or("");
            if !parent.is_empty() { continue; }
            if confirm_root(state, account_id, agent_id).await? { roots.push(crate::chain_reads::id(agent_id)?); }
        }
        if rows.len() < 50 { break; }
        offset += 50;
    }
    match roots.len() {
        1 => Ok(roots.remove(0)),
        0 => Err(AppError::Forbidden("This wallet has no active root agent".into())),
        _ => Err(AppError::Conflict("This wallet has more than one root agent".into())),
    }
}

async fn confirm_root(state: &AppState, account_id: &str, agent_id: &str) -> Result<bool, AppError> {
    let agent = crate::myso::canonical_agent_by_object_id(&state.http_client, &state.config.myso_rpc_url, &state.config.package_id, agent_id).await.map_err(|error| AppError::BadRequest(error.to_string()))?;
    Ok(agent.active
        && agent.parent_object_id.as_deref().unwrap_or("").is_empty()
        && crate::memory_contract::addresses_equal(&agent.account_id, account_id)
        && agent.expires_at_ms.is_none_or(|expires| chrono::Utc::now().timestamp_millis() <= expires))
}

async fn child_under_root(state: &AppState, account_id: &str, root: &str, requested: &str) -> Result<String, AppError> {
    let mut current = crate::chain_reads::id(requested)?;
    let mut seen = std::collections::HashSet::new();
    for _ in 0..8 {
        if !seen.insert(current.clone()) { return Err(AppError::Forbidden("The selected agent ancestry is invalid".into())); }
        let agent = crate::myso::canonical_agent_by_object_id(&state.http_client, &state.config.myso_rpc_url, &state.config.package_id, &current).await.map_err(|error| AppError::BadRequest(error.to_string()))?;
        if !agent.active || !crate::memory_contract::addresses_equal(&agent.account_id, account_id) || agent.expires_at_ms.is_some_and(|expires| chrono::Utc::now().timestamp_millis() > expires) {
            return Err(AppError::Forbidden("The selected agent is not an active member of this account".into()));
        }
        match agent.parent_object_id.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
            None => {
                if crate::memory_contract::addresses_equal(&current, root) { return Ok(crate::chain_reads::id(requested)?); }
                return Err(AppError::Forbidden("The selected agent does not descend from this wallet's root agent".into()));
            }
            Some(parent) => current = crate::chain_reads::id(parent)?,
        }
    }
    Err(AppError::Forbidden("The selected agent ancestry is too deep".into()))
}

async fn social_get(state: &AppState, path: &str) -> Result<Value, AppError> {
    let url = format!("{}{}", state.config.social_server_url.trim_end_matches('/'), path);
    let response = state.http_client.get(url).timeout(std::time::Duration::from_secs(20)).send().await.map_err(|_| AppError::Internal("social read service unavailable".into()))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND { return Err(AppError::Forbidden("No memory account is registered for this wallet".into())); }
    if !response.status().is_success() { return Err(AppError::Internal("social read service rejected the wallet lookup".into())); }
    response.json().await.map_err(|_| AppError::Internal("social read service returned invalid JSON".into()))
}

fn signer_session(secret: &str, wallet: &str, account_id: &str, exp: i64) -> String {
    let payload = format!("{wallet}|{account_id}|{exp}");
    let mut key = [0u8; 64];
    let secret_bytes = secret.as_bytes();
    let hashed;
    let key_bytes: &[u8] = if secret_bytes.len() > 64 {
        hashed = Sha256::digest(secret_bytes);
        &hashed
    } else { secret_bytes };
    key[..key_bytes.len()].copy_from_slice(key_bytes);
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for (index, byte) in key.iter().enumerate() { ipad[index] ^= byte; opad[index] ^= byte; }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(payload.as_bytes());
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner.finalize());
    format!("{exp}.{}", hex::encode(outer.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signer_session_is_bound_to_expiry() {
        let first = signer_session("secret", "0x1", "0x2", 10);
        let second = signer_session("secret", "0x1", "0x2", 11);
        assert_ne!(first, second);
        assert!(first.starts_with("10."));
    }
}
