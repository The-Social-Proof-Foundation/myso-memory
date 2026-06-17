use std::sync::Arc;

use crate::social::{fetch_sub_agent_by_derived_address, SocialApiError};
use crate::types::AppState;

/// Poll indexed sub-agents and tombstone vectors when revoked/deactivated.
pub async fn run_lifecycle_sync(state: Arc<AppState>) {
    let rows = match state.db.list_cached_derived_agents().await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("lifecycle sync: failed to list cache: {}", e);
            return;
        }
    };

    for (derived, agent_id) in rows {
        match fetch_sub_agent_by_derived_address(
            &state.http_client,
            &state.config.social_server_url,
            &derived,
        )
        .await
        {
            Ok(agent) if agent.active && agent.revoked_at_ms.is_none() => continue,
            Ok(_) => {
                tracing::info!("lifecycle: tombstoning agent {}", agent_id);
                let _ = state.db.tombstone_agent(&agent_id).await;
                let _ = state.db.delete_cached_sub_agent_by_derived(&derived).await;
            }
            Err(SocialApiError::NotFound) => {
                tracing::info!("lifecycle: agent {} not in index, tombstoning", agent_id);
                let _ = state.db.tombstone_agent(&agent_id).await;
                let _ = state.db.delete_cached_sub_agent_by_derived(&derived).await;
            }
            Err(e) => {
                tracing::warn!("lifecycle: lookup failed for {}: {}", derived, e);
            }
        }
    }
}
