use std::sync::Arc;

use crate::types::{AppError, AppState, AuthInfo};

/// Ensure on-chain AgentMemoryVault exists before first write for this agent.
pub async fn ensure_agent_vault(
    state: &Arc<AppState>,
    auth: &AuthInfo,
) -> Result<(), AppError> {
    if state
        .db
        .get_vault_for_agent(&auth.agent_object_id)
        .await?
        .is_some()
    {
        return Ok(());
    }

    let url = format!("{}/memory/ensure-vault", state.config.sidecar_url);
    let mut req = state
        .http_client
        .post(&url)
        .json(&serde_json::json!({
            "accountId": auth.account_id,
            "agentObjectId": auth.agent_object_id,
            "packageId": state.config.package_id,
            "keyIndex": 0,
        }));
    if let Some(secret) = state.config.sidecar_secret.as_deref() {
        req = req.header("authorization", format!("Bearer {}", secret));
    }

    let resp = req.send().await.map_err(|e| {
        AppError::Internal(format!("ensure-vault sidecar request failed: {}", e))
    })?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        tracing::warn!(
            "ensure-vault failed for agent {}: {}",
            auth.agent_object_id,
            body
        );
        // Non-fatal: vault creation can be retried; memories still work off-chain.
        state
            .db
            .record_agent_vault(&auth.agent_object_id, &auth.account_id, None)
            .await?;
        return Ok(());
    }

    #[derive(serde::Deserialize)]
    struct VaultResponse {
        #[serde(rename = "vaultId")]
        vault_id: Option<String>,
    }

    let result: VaultResponse = resp.json().await.map_err(|e| {
        AppError::Internal(format!("Failed to parse ensure-vault response: {}", e))
    })?;

    state
        .db
        .record_agent_vault(
            &auth.agent_object_id,
            &auth.account_id,
            result.vault_id.as_deref(),
        )
        .await?;

    tracing::info!(
        "agent vault ensured: agent={} vault={:?}",
        auth.agent_object_id,
        result.vault_id
    );
    Ok(())
}
