//! Canonical org metadata client (Wave 0 architectural rule).
//!
//! social-server owns the authoritative view of `{ principal_owner, account_id,
//! org_memory_group_id }`. This module fetches that summary and caches it in
//! memory for the process lifetime — org owner + memory group id are effectively
//! immutable (owner transfers are rare; group id never changes), so an aggressive
//! cache is safe. Cache misses hit `GET /internal/organizations/:id/summary`
//! behind the shared `INTERNAL_SYNC_SECRET`.
//!
//! Callers must never re-derive `org_memory_group_id` locally — the sidecar
//! contract depends on the same value social-server has indexed.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Deserialize;
use tokio::sync::Mutex;

use crate::types::AppError;

/// Maximum entries in the in-process cache before oldest is evicted.
const CACHE_CAPACITY: usize = 10_000;

#[derive(Debug, Clone, Deserialize)]
pub struct OrgSummary {
    pub organization_id: String,
    pub principal_owner: String,
    pub account_id: String,
    pub org_memory_group_id: Option<String>,
}

#[derive(Debug, Default)]
struct CacheState {
    entries: HashMap<String, OrgSummary>,
    /// Insertion order for FIFO eviction when we hit the capacity cap.
    order: Vec<String>,
}

/// Process-lifetime cache for org summaries; safe to `.clone()` cheaply.
#[derive(Clone)]
pub struct OrgSummaryCache {
    inner: Arc<Mutex<CacheState>>,
}

impl OrgSummaryCache {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(CacheState::default())),
        }
    }

    pub async fn get_cached(&self, organization_id: &str) -> Option<OrgSummary> {
        let guard = self.inner.lock().await;
        guard.entries.get(organization_id).cloned()
    }

    async fn insert(&self, summary: OrgSummary) {
        let mut guard = self.inner.lock().await;
        if guard.entries.contains_key(&summary.organization_id) {
            guard
                .entries
                .insert(summary.organization_id.clone(), summary);
            return;
        }
        while guard.order.len() >= CACHE_CAPACITY {
            if let Some(oldest) = guard.order.first().cloned() {
                guard.order.remove(0);
                guard.entries.remove(&oldest);
            } else {
                break;
            }
        }
        guard
            .order
            .push(summary.organization_id.clone());
        guard
            .entries
            .insert(summary.organization_id.clone(), summary);
    }
}

impl Default for OrgSummaryCache {
    fn default() -> Self {
        Self::new()
    }
}

/// Fetch an org summary, caching the response for the process lifetime.
///
/// Returns `None` on 404 (org unknown to social-server) so recall paths can
/// degrade rather than fail outright; other transport errors surface as
/// `AppError::Internal`.
pub async fn fetch_org_summary(
    client: &reqwest::Client,
    cache: &OrgSummaryCache,
    social_server_url: &str,
    internal_sync_secret: Option<&str>,
    organization_id: &str,
) -> Result<Option<OrgSummary>, AppError> {
    if let Some(hit) = cache.get_cached(organization_id).await {
        return Ok(Some(hit));
    }

    let url = format!(
        "{}/internal/organizations/{}/summary",
        social_server_url.trim_end_matches('/'),
        organization_id
    );
    let mut req = client.get(&url);
    if let Some(secret) = internal_sync_secret {
        req = req.header("x-internal-sync-secret", secret);
    }
    let resp = req.send().await.map_err(|e| {
        AppError::Internal(format!("org summary fetch failed: {e}"))
    })?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(AppError::Internal(format!(
            "org summary fetch status {}",
            resp.status()
        )));
    }

    let summary: OrgSummary = resp.json().await.map_err(|e| {
        AppError::Internal(format!("org summary decode failed: {e}"))
    })?;
    cache.insert(summary.clone()).await;
    Ok(Some(summary))
}
