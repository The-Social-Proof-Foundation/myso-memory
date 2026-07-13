//! Fire-and-forget audit pushes to the social-server unified audit log
//! (`POST /internal/audit/logs`). Administrative and org-scoped actions only —
//! private recall is data-plane and not audited.

use std::sync::Arc;

use serde::Serialize;

use crate::types::AppState;

#[derive(Debug, Clone, Serialize)]
pub struct AuditEntry {
    pub source: String,
    pub actor_address: String,
    pub actor_type: String,
    pub action: String,
    pub target_type: String,
    pub target_id: String,
    pub organization_id: Option<String>,
    pub account_id: Option<String>,
    pub prev_state: Option<serde_json::Value>,
    pub new_state: Option<serde_json::Value>,
    pub tx_digest: Option<String>,
    pub idempotency_key: Option<String>,
    pub metadata: Option<serde_json::Value>,
}

impl AuditEntry {
    pub fn relayer_agent_action(
        action: &str,
        actor_address: &str,
        target_type: &str,
        target_id: &str,
        organization_id: Option<String>,
        account_id: Option<String>,
        metadata: serde_json::Value,
    ) -> Self {
        Self {
            source: "memory_relayer".to_string(),
            actor_address: actor_address.to_string(),
            actor_type: "agent".to_string(),
            action: action.to_string(),
            target_type: target_type.to_string(),
            target_id: target_id.to_string(),
            organization_id,
            account_id,
            prev_state: None,
            new_state: None,
            tx_digest: None,
            idempotency_key: None,
            metadata: Some(metadata),
        }
    }
}

/// Push audit entries without blocking or failing the caller.
pub fn spawn_audit_push(state: &Arc<AppState>, entries: Vec<AuditEntry>) {
    if entries.is_empty() {
        return;
    }
    let client = state.http_client.clone();
    let base_url = state
        .config
        .social_server_url
        .trim_end_matches('/')
        .to_string();
    let secret = state.config.audit_sync_secret.clone();
    tokio::spawn(async move {
        let url = format!("{}/internal/audit/logs", base_url);
        let mut builder = client
            .post(&url)
            .json(&serde_json::json!({ "entries": entries }));
        if let Some(secret) = secret {
            builder = builder.header("x-audit-sync-secret", secret);
        }
        match builder.send().await {
            Ok(resp) if !resp.status().is_success() => {
                tracing::warn!(status = %resp.status(), "audit push rejected");
            }
            Err(err) => {
                tracing::warn!(error = %err, "audit push failed");
            }
            _ => {}
        }
    });
}
