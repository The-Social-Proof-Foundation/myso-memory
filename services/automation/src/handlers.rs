//! HTTP handlers: job CRUD, event ingestion (ingestion interface, not the bus itself).

use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::clients::{AuditClient, OracleClient, WorkflowClient};
use crate::executor::RunContext;
use crate::memory_bridge::MemoryBridgeClient;
use crate::store::{AutomationStore, JobFilter, RunSummary};
use crate::{
    AutomationJob, EventBus, EventTrigger, JobAction, MatchMode, PlatformEvent,
    RetryPolicy, TriggerKind, TriggerSet,
};

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<dyn AutomationStore>,
    pub bus: EventBus,
    pub run_ctx: Arc<RunContext>,
    pub internal_sync_secret: String,
}

#[derive(serde::Deserialize)]
pub struct CreateJobRequest {
    pub organization_id: String,
    pub account_id: String,
    /// Owner wallet address; see [`AutomationJob::owner_address`].
    pub owner_address: String,
    pub name: String,
    pub trigger_set: TriggerSet,
    pub target_agent_object_id: String,
    pub target_agent_key_ref: String,
    pub action: JobAction,
    #[serde(default = "default_memory_scope")]
    pub memory_scope: String,
    #[serde(default)]
    pub max_mist_per_run: u64,
    #[serde(default)]
    pub retry_policy: RetryPolicy,
}

fn default_memory_scope() -> String {
    "private".into()
}

#[derive(serde::Serialize)]
pub struct JobResponse {
    pub id: Uuid,
    pub name: String,
    pub enabled: bool,
}

pub async fn health() -> impl IntoResponse {
    Json(serde_json::json!({ "status": "ok", "service": "myso-automation" }))
}

pub async fn create_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreateJobRequest>,
) -> Result<Json<JobResponse>, AppError> {
    // Job creation is a trusted-service operation: a job row names an
    // organization, an account, and an agent key ref. The browser never calls
    // this directly — it goes through the memory relayer, which enforces owner
    // auth and then presents the shared secret on the caller's behalf.
    verify_internal_secret(&headers, &state.internal_sync_secret)?;

    let job = AutomationJob {
        id: Uuid::new_v4(),
        organization_id: req.organization_id,
        account_id: req.account_id,
        owner_address: req.owner_address,
        name: req.name,
        enabled: true,
        trigger_set: req.trigger_set,
        target_agent_object_id: req.target_agent_object_id,
        target_agent_key_ref: req.target_agent_key_ref,
        action: req.action,
        memory_scope: req.memory_scope,
        max_mist_per_run: req.max_mist_per_run,
        retry_policy: req.retry_policy,
    };
    let saved = state.store.create_job(job).await.map_err(AppError::store)?;
    Ok(Json(JobResponse {
        id: saved.id,
        name: saved.name,
        enabled: saved.enabled,
    }))
}

pub async fn get_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<AutomationJob>, AppError> {
    verify_internal_secret(&headers, &state.internal_sync_secret)?;
    state
        .store
        .get_job(id)
        .await
        .map_err(AppError::store)?
        .ok_or(AppError::NotFound)
        .map(Json)
}

#[derive(serde::Deserialize)]
pub struct ListJobsQuery {
    pub organization_id: Option<String>,
    pub account_id: Option<String>,
    pub limit: Option<i64>,
}

/// List jobs, scoped to an organization or account.
///
/// A scope is mandatory: without one this would return every tenant's jobs, so
/// an unscoped request is a 400 rather than a full inventory dump.
pub async fn list_jobs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListJobsQuery>,
) -> Result<Json<Vec<AutomationJob>>, AppError> {
    verify_internal_secret(&headers, &state.internal_sync_secret)?;
    let filter = JobFilter::new(query.organization_id, query.account_id, query.limit);
    // An unscoped listing is a caller mistake, not a server fault.
    filter
        .validate()
        .map_err(|e| AppError::BadRequest(e.to_string()))?;
    let jobs = state.store.list_jobs(filter).await.map_err(AppError::store)?;
    Ok(Json(jobs))
}

#[derive(serde::Deserialize)]
pub struct ListRunsQuery {
    pub limit: Option<i64>,
}

/// Recent runs for one job, newest first.
pub async fn list_runs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Query(query): Query<ListRunsQuery>,
) -> Result<Json<Vec<RunSummary>>, AppError> {
    verify_internal_secret(&headers, &state.internal_sync_secret)?;
    // 404 rather than an empty list when the job does not exist, so a typo in a
    // job id is distinguishable from a job that never ran.
    if state.store.get_job(id).await.map_err(AppError::store)?.is_none() {
        return Err(AppError::NotFound);
    }
    let runs = state
        .store
        .list_runs(id, query.limit.unwrap_or(crate::store::DEFAULT_LIST_LIMIT))
        .await
        .map_err(AppError::store)?;
    Ok(Json(runs))
}

/// Ingestion interface — deduplicates, then publishes to the in-process event bus (v1).
///
/// Returns 202 once the event is queued; job execution happens on the consumer.
pub async fn ingest_event(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(event): Json<PlatformEvent>,
) -> Result<StatusCode, AppError> {
    verify_internal_secret(&headers, &state.internal_sync_secret)?;
    if event.event_version == 0 {
        return Err(AppError::BadRequest("event_version required".into()));
    }
    let fresh = state
        .store
        .ingest_event_dedup(&event)
        .await
        .map_err(AppError::store)?;
    if !fresh {
        return Ok(StatusCode::OK);
    }
    // Publish only. The event consumer spawned in `main` evaluates it. This used
    // to also evaluate inline, so with the engine enabled every ingested event
    // ran each matching job twice, and with it disabled (`AUTOMATION_ENABLED=
    // false`, "serve the API but run nothing") jobs still ran.
    state.bus.publish(event);
    Ok(StatusCode::ACCEPTED)
}

// ---------------------------------------------------------------------------
// Sealed delegate keys
// ---------------------------------------------------------------------------
//
// These routes move opaque ciphertext. The engine cannot open a sealed key (it
// has no seal private key), never logs one, and never returns one except to the
// bridge-facing `/sealed` route.

const MAX_SEALED_BYTES: usize = 4096;
const MAX_ID_BYTES: usize = 200;

/// `[A-Za-z0-9._-]{1,64}`: a name, not free text, so it is safe in a URL and a log.
pub fn valid_delegate_ref(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn bounded_nonblank(value: &str, field: &str) -> Result<(), AppError> {
    if value.trim().is_empty() || value.len() > MAX_ID_BYTES {
        return Err(AppError::BadRequest(format!("{field} is required")));
    }
    Ok(())
}

#[derive(serde::Deserialize)]
pub struct PutDelegateRequest {
    pub account_id: String,
    pub delegate_ref: String,
    pub agent_object_id: String,
    pub seal_key_id: String,
    pub sealed: String,
}

pub async fn put_delegate(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<PutDelegateRequest>,
) -> Result<StatusCode, AppError> {
    verify_internal_secret(&headers, &state.internal_sync_secret)?;
    bounded_nonblank(&req.account_id, "account_id")?;
    bounded_nonblank(&req.agent_object_id, "agent_object_id")?;
    bounded_nonblank(&req.seal_key_id, "seal_key_id")?;
    if !valid_delegate_ref(&req.delegate_ref) {
        return Err(AppError::BadRequest(
            "delegate_ref must be 1-64 characters of letters, digits, '.', '_' or '-'".into(),
        ));
    }
    if req.sealed.trim().is_empty() || req.sealed.len() > MAX_SEALED_BYTES {
        return Err(AppError::BadRequest("sealed is required and must be small".into()));
    }
    state
        .store
        .put_delegate(crate::store::DelegateRecord {
            account_id: req.account_id,
            delegate_ref: req.delegate_ref,
            agent_object_id: req.agent_object_id,
            seal_key_id: req.seal_key_id,
            sealed: req.sealed,
            created_at: chrono::Utc::now(),
        })
        .await
        .map_err(AppError::store)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(serde::Deserialize)]
pub struct DelegateScopeQuery {
    pub account_id: Option<String>,
    pub delegate_ref: Option<String>,
}

fn require_account(query: &DelegateScopeQuery) -> Result<&str, AppError> {
    match query.account_id.as_deref().map(str::trim) {
        Some(a) if !a.is_empty() => Ok(a),
        _ => Err(AppError::BadRequest("account_id is required".into())),
    }
}

fn require_ref(query: &DelegateScopeQuery) -> Result<&str, AppError> {
    match query.delegate_ref.as_deref() {
        Some(r) if valid_delegate_ref(r) => Ok(r),
        _ => Err(AppError::BadRequest("a valid delegate_ref is required".into())),
    }
}

/// Metadata only. The sealed key is never part of this response.
pub async fn list_delegates(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<DelegateScopeQuery>,
) -> Result<Json<Vec<crate::store::DelegateSummary>>, AppError> {
    verify_internal_secret(&headers, &state.internal_sync_secret)?;
    let account = require_account(&query)?;
    Ok(Json(
        state.store.list_delegates(account).await.map_err(AppError::store)?,
    ))
}

#[derive(serde::Serialize)]
pub struct SealedDelegateResponse {
    pub agent_object_id: String,
    pub seal_key_id: String,
    pub sealed: String,
}

/// The sealed envelope, for the bridge to open. Still ciphertext on the wire.
pub async fn get_sealed_delegate(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<DelegateScopeQuery>,
) -> Result<Json<SealedDelegateResponse>, AppError> {
    verify_internal_secret(&headers, &state.internal_sync_secret)?;
    let account = require_account(&query)?;
    let delegate_ref = require_ref(&query)?;
    let record = state
        .store
        .get_delegate(account, delegate_ref)
        .await
        .map_err(AppError::store)?
        .ok_or(AppError::NotFound)?;
    Ok(Json(SealedDelegateResponse {
        agent_object_id: record.agent_object_id,
        seal_key_id: record.seal_key_id,
        sealed: record.sealed,
    }))
}

pub async fn delete_delegate(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<DelegateScopeQuery>,
) -> Result<StatusCode, AppError> {
    verify_internal_secret(&headers, &state.internal_sync_secret)?;
    let account = require_account(&query)?;
    let delegate_ref = require_ref(&query)?;
    if state
        .store
        .delete_delegate(account, delegate_ref)
        .await
        .map_err(AppError::store)?
    {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::NotFound)
    }
}

/// Length-safe constant-time secret comparison.
///
/// Hashing both sides first means the comparison time does not depend on the
/// secret's length, which an early `len()` check would leak. A blank configured
/// secret never matches anything, so an empty env var cannot disable auth.
fn secrets_match(provided: &str, expected: &str) -> bool {
    if expected.is_empty() {
        return false;
    }
    let a = Sha256::digest(provided.as_bytes());
    let b = Sha256::digest(expected.as_bytes());
    a == b
}

fn verify_internal_secret(headers: &HeaderMap, secret: &str) -> Result<(), AppError> {
    let provided = headers
        .get("x-internal-sync-secret")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !secrets_match(provided, secret) {
        return Err(AppError::Unauthorized);
    }
    Ok(())
}

/// Reject an unauthenticated request before any body is parsed.
///
/// Without this, axum's `Json` extractor runs first and a request with no
/// credentials and a malformed body gets a 422 describing the body's shape
/// instead of a 401 — the auth check only ran once the handler was reached,
/// which is strictly after extraction. Handlers still verify the secret
/// themselves, so mounting one without this middleware fails closed.
pub async fn require_internal_secret(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<Response, AppError> {
    verify_internal_secret(&headers, &state.internal_sync_secret)?;
    Ok(next.run(request).await)
}

pub fn sample_event_trigger() -> EventTrigger {
    EventTrigger {
        kind: TriggerKind::Event,
        cron_expr: None,
        interval_ms: None,
        condition: None,
        event_family: "workflow".into(),
        event_type: "item.created".into(),
        organization_id: None,
        account_id: None,
        agent_object_id: None,
        payload_filter: None,
        debounce_window_ms: 0,
        cooldown_ms: 0,
        max_executions_per_window: None,
        deduplication_key: None,
        replay_behavior: crate::ReplayBehavior::Skip,
    }
}

pub fn sample_trigger_set() -> TriggerSet {
    TriggerSet {
        match_mode: MatchMode::Any,
        evaluation_window_ms: 0,
        triggers: vec![sample_event_trigger()],
    }
}

#[derive(Debug)]
pub enum AppError {
    NotFound,
    Unauthorized,
    BadRequest(String),
    Store(String),
}

impl AppError {
    fn store(e: crate::store::StoreError) -> Self {
        Self::Store(e.to_string())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        match self {
            Self::NotFound => (StatusCode::NOT_FOUND, "not found").into_response(),
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized").into_response(),
            Self::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg).into_response(),
            Self::Store(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg).into_response(),
        }
    }
}

pub fn build_run_context(
    store: Arc<dyn AutomationStore>,
    config: &crate::Config,
) -> RunContext {
    RunContext {
        store,
        oracle: OracleClient::new(config),
        memory: MemoryBridgeClient::new(config),
        workflow: WorkflowClient::new(config),
        audit: AuditClient::new(config),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_trigger_set_is_valid_json() {
        let set = sample_trigger_set();
        let v = serde_json::to_value(&set).unwrap();
        assert_eq!(v["match_mode"], "any");
    }

    #[test]
    fn delegate_refs_are_plain_names() {
        assert!(valid_delegate_ref("nightly-digest.v2_a"));
        assert!(!valid_delegate_ref(""));
        assert!(!valid_delegate_ref(&"a".repeat(65)));
        assert!(!valid_delegate_ref("has space"));
        assert!(!valid_delegate_ref("a/b"));
        assert!(!valid_delegate_ref("a&b=c"));
        assert!(!valid_delegate_ref("../x"));
    }

    #[test]
    fn secret_comparison_accepts_only_the_exact_value() {
        assert!(secrets_match("s3cret", "s3cret"));
        assert!(!secrets_match("s3cret", "s3cre7"));
        assert!(!secrets_match("", "s3cret"));
        assert!(!secrets_match("longer-than-expected", "s3cret"));
    }

    #[test]
    fn an_empty_configured_secret_never_matches() {
        // Guards against a blank env var silently disabling auth: every caller
        // must be rejected, including one presenting a blank header.
        assert!(!secrets_match("", ""));
        assert!(!secrets_match("anything", ""));
    }
}
