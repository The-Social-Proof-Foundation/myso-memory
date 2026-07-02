//! Best-effort producer for `memory_access_request` workflow items.
//!
//! When an authenticated agent asks for org-scoped write/read but lacks the
//! required `OrgMemoryReader` / `OrgMemoryWriter` grant, the memory relayer
//! notifies social-server so the org admin sees an inbox item. From there the
//! admin uses the SDK helper (`grantOrgMemoryPermissionFromWorkflowItem`) to
//! grant permission on-chain; the messaging relayer's chain sync closes the
//! item.
//!
//! Failures are logged and swallowed — the caller's original permission-denied
//! response is what matters.

use std::sync::Arc;

use serde::Serialize;

use crate::types::{AppError, AppState, AuthInfo};

#[derive(Debug, Serialize)]
struct MemoryAccessRequestBody {
    recipient_address: String,
    organization_id: String,
    account_id: String,
    org_memory_group_id: String,
    member_address: String,
    permissions_mask: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_object_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<String>,
}

/// Fire a memory access request to social-server. Returns `Ok(true)` when the
/// producer actually posted an item, `Ok(false)` when it degraded (missing
/// config, unknown org, etc.).
pub async fn spawn_memory_access_request(
    state: &Arc<AppState>,
    auth: &AuthInfo,
    requested_mask: i64,
) -> Result<bool, AppError> {
    if !state.config.memory_access_sync_enabled {
        return Ok(false);
    }
    let Some(secret) = state.config.memory_access_sync_secret.clone() else {
        tracing::debug!("memory access request skipped: MEMORY_ACCESS_SYNC_SECRET unset");
        return Ok(false);
    };
    let Some(org_id) = auth.organization_id.clone() else {
        return Ok(false);
    };

    // Look up the org owner + memory group id via the canonical social-server
    // endpoint (Wave 0 rule: never re-derive locally).
    let summary = match crate::org_summary::fetch_org_summary(
        &state.http_client,
        &state.org_summaries,
        &state.config.social_server_url,
        state.config.internal_sync_secret.as_deref(),
        &org_id,
    )
    .await?
    {
        Some(s) => s,
        None => {
            tracing::warn!(org = %org_id, "memory access request skipped: org summary not found");
            return Ok(false);
        }
    };
    let Some(group_id) = summary.org_memory_group_id else {
        tracing::warn!(
            org = %org_id,
            "memory access request skipped: org_memory_group_id not indexed yet"
        );
        return Ok(false);
    };

    let body = MemoryAccessRequestBody {
        recipient_address: summary.principal_owner,
        organization_id: summary.organization_id,
        account_id: summary.account_id,
        org_memory_group_id: group_id,
        member_address: auth.derived_address.clone(),
        permissions_mask: requested_mask,
        agent_object_id: Some(auth.agent_object_id.clone()),
        title: Some("Memory access requested".to_string()),
        body: Some(format!(
            "Agent {} requested org memory access (mask={requested_mask})",
            auth.derived_address
        )),
    };

    let url = format!(
        "{}/internal/memory/access-requests",
        state.config.social_server_url.trim_end_matches('/')
    );
    let resp = state
        .http_client
        .post(&url)
        .header("x-memory-access-sync-secret", secret)
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("access request post failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        tracing::warn!(status = %status, body = %body, "access request post rejected");
        return Ok(false);
    }
    Ok(true)
}
