//! Background push of per-agent memory usage aggregates to the social-server
//! (`POST /internal/memory/usage-stats`) — feeds the org dashboard columns
//! (`memory_entries`, `memory_bytes`, `org_shared_memory_entries`).

use std::sync::Arc;

use serde::Serialize;

use crate::types::AppState;

#[derive(Debug, Serialize)]
struct MemoryUsageStatEntry {
    agent_object_id: String,
    organization_id: Option<String>,
    account_id: Option<String>,
    entries: i64,
    bytes: i64,
    org_shared_entries: i64,
}

pub fn spawn_usage_stats_sync(state: Arc<AppState>) {
    if !state.config.memory_usage_sync_enabled {
        tracing::info!("memory usage-stats sync disabled (MEMORY_USAGE_SYNC_ENABLED)");
        return;
    }
    let interval_secs = state.config.memory_usage_sync_interval_secs.max(30);
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(interval_secs));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            if let Err(err) = push_usage_stats(&state).await {
                tracing::warn!(error = %err, "memory usage-stats push failed");
            }
        }
    });
}

async fn push_usage_stats(state: &Arc<AppState>) -> Result<(), crate::types::AppError> {
    let rows = state.db.memory_usage_summary().await?;
    if rows.is_empty() {
        return Ok(());
    }
    let stats: Vec<MemoryUsageStatEntry> = rows
        .into_iter()
        .map(
            |(agent_object_id, organization_id, entries, bytes, org_shared_entries)| {
                MemoryUsageStatEntry {
                    agent_object_id,
                    organization_id,
                    account_id: None,
                    entries,
                    bytes,
                    org_shared_entries,
                }
            },
        )
        .collect();
    let count = stats.len();

    let url = format!(
        "{}/internal/memory/usage-stats",
        state.config.social_server_url.trim_end_matches('/')
    );
    let mut builder = state
        .http_client
        .post(&url)
        .json(&serde_json::json!({ "stats": stats }));
    if let Some(secret) = &state.config.memory_usage_sync_secret {
        builder = builder.header("x-memory-usage-sync-secret", secret);
    }
    let resp = builder
        .send()
        .await
        .map_err(|e| crate::types::AppError::Internal(format!("usage-stats push failed: {}", e)))?;
    if !resp.status().is_success() {
        return Err(crate::types::AppError::Internal(format!(
            "usage-stats push status {}",
            resp.status()
        )));
    }
    tracing::debug!(agents = count, "memory usage-stats pushed");
    Ok(())
}
