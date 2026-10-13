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
use crate::webhook::WebhookClient;
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

/// Liveness, plus the event bus's counters. `lagged` above zero means events were dropped after the
/// engine had acknowledged them: the outbox will not resend those, so it is the number to alert on.
pub async fn health(State(state): State<AppState>) -> impl IntoResponse {
    let bus = state.bus.stats();
    Json(serde_json::json!({
        "status": if bus.lagged == 0 { "ok" } else { "degraded" },
        "service": "myso-automation",
        "event_bus": bus,
    }))
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
    validate_job_action(&req.action, state.run_ctx.webhook.allow_private())
        .map_err(AppError::BadRequest)?;

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

/// Structural checks for the chain-action kinds, so a malformed config is a 400 at creation rather
/// than a failed run later. `memory_relayer_call` is validated when it runs, as before.
pub fn validate_job_action(action: &JobAction, webhook_allow_private: bool) -> Result<(), String> {
    match action.kind {
        crate::JobActionKind::MemoryRelayerCall => Ok(()),
        crate::JobActionKind::RegisteredAction => {
            let config = crate::registered_action::parse_config(&action.config)?;
            crate::registered_action::validate_config(&config)
        }
        crate::JobActionKind::Webhook => {
            let config = crate::webhook::parse_config(&action.config)?;
            crate::webhook::validate_config(&config, webhook_allow_private)
        }
    }
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
// Encrypted delegate keys
// ---------------------------------------------------------------------------
//
// These routes move opaque ciphertext. The engine cannot open a encrypted key (it
// has no MyData private key), never logs one, and never returns one except to the
// bridge-facing `/encrypted` route.

const MAX_ENCRYPTED_KEY_BYTES: usize = 4096;
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
    pub mydata_key_id: String,
    pub encrypted_key: String,
    /// `memory` (default), `task_worker`, `juror` or `jury_keeper`.
    #[serde(default = "default_delegate_class")]
    pub delegate_class: String,
    /// Required for every class but `memory`, which must leave it empty.
    #[serde(default)]
    pub allowed_action_ids: Vec<String>,
}

fn default_delegate_class() -> String {
    DELEGATE_CLASS_MEMORY.into()
}

pub const DELEGATE_CLASS_MEMORY: &str = "memory";
pub const DELEGATE_CLASS_TASK_WORKER: &str = "task_worker";
pub const DELEGATE_CLASS_JUROR: &str = "juror";
pub const DELEGATE_CLASS_JURY_KEEPER: &str = "jury_keeper";
const MAX_DELEGATE_ACTIONS: usize = 16;

/// A juror's own steps. Must match `JUROR_ACTION_IDS` in the bridge and the relayer's policy.
pub const JUROR_ACTION_IDS: &[&str] = &[
    "jury.accept.v1",
    "jury.commit_vote.v1",
    "jury.reveal_vote.v1",
    "jury.claim_fee.v1",
];

/// The permissionless jury cranks. Must match `KEEPER_ACTION_IDS` in the bridge.
pub const KEEPER_ACTION_IDS: &[&str] = &[
    "jury.select_jury.v1",
    "jury.replace_no_shows.v1",
    "jury.finalize_round.v1",
    "jury.finalize_case.v1",
    "jury.execute_task_verdict.v1",
    "jury.start_neutral_resolution.v1",
    "jury.execute_neutral_resolution.v1",
    "jury.settle_dispute_fees.v1",
    "jury.escalate_proposal.v1",
    "jury.finalize_proposal.v1",
    "jury.apply_proposal_decision.v1",
    "jury.sweep_case.v1",
    "jury.refresh_roster_entry.v1",
    "jury.evict_ineligible.v1",
];

/// The event family a class's jobs may subscribe to.
pub fn delegate_event_family(class: &str) -> Option<&'static str> {
    match class {
        DELEGATE_CLASS_TASK_WORKER => Some("task"),
        DELEGATE_CLASS_JUROR | DELEGATE_CLASS_JURY_KEEPER => Some("jury"),
        _ => None,
    }
}

/// Whether a delegate of `class` may be allowed to run `id`: a task worker any task market action, a
/// juror only its own four steps, a keeper only the cranks.
pub fn class_may_run(class: &str, id: &str) -> bool {
    if !crate::registered_action::valid_action_id(id) {
        return false;
    }
    match class {
        DELEGATE_CLASS_TASK_WORKER => id.starts_with("task."),
        DELEGATE_CLASS_JUROR => JUROR_ACTION_IDS.contains(&id),
        DELEGATE_CLASS_JURY_KEEPER => KEEPER_ACTION_IDS.contains(&id),
        _ => false,
    }
}

/// A memory delegate runs no chain actions at all; every other class runs only its own. Checked
/// here and again by the bridge, so neither can be bypassed alone.
pub fn validate_delegate_class(class: &str, allowed_action_ids: &[String]) -> Result<(), String> {
    match class {
        DELEGATE_CLASS_MEMORY => {
            if allowed_action_ids.is_empty() {
                Ok(())
            } else {
                Err("a memory delegate cannot run chain actions; use the task_worker, juror or jury_keeper class".into())
            }
        }
        DELEGATE_CLASS_TASK_WORKER | DELEGATE_CLASS_JUROR | DELEGATE_CLASS_JURY_KEEPER => {
            if allowed_action_ids.is_empty() || allowed_action_ids.len() > MAX_DELEGATE_ACTIONS {
                return Err(format!(
                    "a {class} delegate needs 1 to {MAX_DELEGATE_ACTIONS} allowed_action_ids"
                ));
            }
            match allowed_action_ids.iter().find(|id| !class_may_run(class, id)) {
                Some(bad) => Err(format!("`{bad}` is not an action a {class} delegate may run")),
                None => Ok(()),
            }
        }
        other => Err(format!("unknown delegate_class `{other}`")),
    }
}

pub async fn put_delegate(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<PutDelegateRequest>,
) -> Result<StatusCode, AppError> {
    verify_internal_secret(&headers, &state.internal_sync_secret)?;
    bounded_nonblank(&req.account_id, "account_id")?;
    bounded_nonblank(&req.agent_object_id, "agent_object_id")?;
    bounded_nonblank(&req.mydata_key_id, "mydata_key_id")?;
    if !valid_delegate_ref(&req.delegate_ref) {
        return Err(AppError::BadRequest(
            "delegate_ref must be 1-64 characters of letters, digits, '.', '_' or '-'".into(),
        ));
    }
    if req.encrypted_key.trim().is_empty() || req.encrypted_key.len() > MAX_ENCRYPTED_KEY_BYTES {
        return Err(AppError::BadRequest("encrypted is required and must be small".into()));
    }
    validate_delegate_class(&req.delegate_class, &req.allowed_action_ids)
        .map_err(AppError::BadRequest)?;
    state
        .store
        .put_delegate(crate::store::DelegateRecord {
            account_id: req.account_id,
            delegate_ref: req.delegate_ref,
            agent_object_id: req.agent_object_id,
            mydata_key_id: req.mydata_key_id,
            encrypted_key: req.encrypted_key,
            delegate_class: req.delegate_class,
            allowed_action_ids: req.allowed_action_ids,
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

/// Metadata only. The encrypted key is never part of this response.
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
pub struct EncryptedDelegateResponse {
    pub agent_object_id: String,
    pub mydata_key_id: String,
    pub encrypted_key: String,
    pub delegate_class: String,
    pub allowed_action_ids: Vec<String>,
}

/// The encrypted envelope, for the bridge to open. Still ciphertext on the wire.
pub async fn get_delegate_key(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<DelegateScopeQuery>,
) -> Result<Json<EncryptedDelegateResponse>, AppError> {
    verify_internal_secret(&headers, &state.internal_sync_secret)?;
    let account = require_account(&query)?;
    let delegate_ref = require_ref(&query)?;
    let record = state
        .store
        .get_delegate(account, delegate_ref)
        .await
        .map_err(AppError::store)?
        .ok_or(AppError::NotFound)?;
    Ok(Json(EncryptedDelegateResponse {
        agent_object_id: record.agent_object_id,
        mydata_key_id: record.mydata_key_id,
        encrypted_key: record.encrypted_key,
        delegate_class: record.delegate_class,
        allowed_action_ids: record.allowed_action_ids,
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
        webhook: WebhookClient::new(config),
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
    fn chain_action_configs_are_validated_when_a_job_is_created() {
        let registered = |config: serde_json::Value| JobAction {
            kind: crate::JobActionKind::RegisteredAction,
            config,
        };
        assert!(validate_job_action(
            &registered(serde_json::json!({ "action_id": "task.accept.v1", "params": {} })),
            false
        )
        .is_ok());
        assert!(validate_job_action(&registered(serde_json::json!({ "action_id": "nope" })), false).is_err());
        assert!(validate_job_action(&registered(serde_json::json!({})), false).is_err());

        let webhook = |config: serde_json::Value| JobAction {
            kind: crate::JobActionKind::Webhook,
            config,
        };
        let good = serde_json::json!({
            "url": "https://worker.example.com/hook",
            "secret": "0123456789abcdef",
            "allowed_hosts": ["worker.example.com"],
            "allowed_action_ids": ["task.deliver.v1"],
        });
        assert!(validate_job_action(&webhook(good.clone()), false).is_ok());
        let mut http = good;
        http["url"] = "http://worker.example.com/hook".into();
        assert!(validate_job_action(&webhook(http.clone()), false).is_err());
        assert!(validate_job_action(&webhook(http), true).is_ok());

        let memory = JobAction {
            kind: crate::JobActionKind::MemoryRelayerCall,
            config: serde_json::json!({}),
        };
        assert!(validate_job_action(&memory, false).is_ok());
    }

    #[test]
    fn delegate_classes_constrain_which_actions_may_be_allowlisted() {
        let ids = |list: &[&str]| list.iter().map(|s| (*s).to_string()).collect::<Vec<_>>();
        assert!(validate_delegate_class("memory", &[]).is_ok());
        assert!(validate_delegate_class("memory", &ids(&["task.accept.v1"])).is_err());

        assert!(validate_delegate_class("task_worker", &ids(&["task.accept.v1", "task.deliver.v1"])).is_ok());
        assert!(validate_delegate_class("task_worker", &[]).is_err());
        assert!(validate_delegate_class("task_worker", &ids(&["social.create_post.v1"])).is_err());
        assert!(validate_delegate_class("task_worker", &ids(&["task.accept.v1", "agent.revoke_child.v1"])).is_err());
        assert!(validate_delegate_class("task_worker", &ids(&["task.accept"])).is_err());
        let too_many: Vec<String> = (0..17).map(|i| format!("task.a{}.v1", "b".repeat(i % 3 + 1))).collect();
        assert!(validate_delegate_class("task_worker", &too_many).is_err());
        assert!(validate_delegate_class("root", &[]).is_err());
    }

    #[test]
    fn a_juror_and_a_keeper_may_only_be_allowed_their_own_actions() {
        let ids = |list: &[&str]| list.iter().map(|s| (*s).to_string()).collect::<Vec<_>>();
        assert!(validate_delegate_class("juror", &ids(&["jury.accept.v1", "jury.commit_vote.v1"])).is_ok());
        assert!(validate_delegate_class("juror", &ids(JUROR_ACTION_IDS)).is_ok());
        assert!(validate_delegate_class("jury_keeper", &ids(&["jury.select_jury.v1"])).is_ok());
        assert!(validate_delegate_class("jury_keeper", &ids(&KEEPER_ACTION_IDS[..16.min(KEEPER_ACTION_IDS.len())])).is_ok());

        // Never each other's, never a task action, never an unknown or malformed one.
        assert!(validate_delegate_class("juror", &ids(&["jury.select_jury.v1"])).is_err());
        assert!(validate_delegate_class("jury_keeper", &ids(&["jury.reveal_vote.v1"])).is_err());
        assert!(validate_delegate_class("juror", &ids(&["task.accept.v1"])).is_err());
        assert!(validate_delegate_class("task_worker", &ids(&["jury.accept.v1"])).is_err());
        assert!(validate_delegate_class("juror", &ids(&["jury.vote_for_me.v1"])).is_err());
        assert!(validate_delegate_class("juror", &ids(&["jury.accept"])).is_err());
        assert!(validate_delegate_class("juror", &[]).is_err());
        assert!(validate_delegate_class("memory", &ids(&["jury.accept.v1"])).is_err());
    }

    #[test]
    fn the_two_jury_action_lists_do_not_overlap_and_a_keeper_fits_one_delegate() {
        assert!(JUROR_ACTION_IDS.iter().all(|id| !KEEPER_ACTION_IDS.contains(id)));
        assert_eq!(JUROR_ACTION_IDS.len(), 4);
        assert_eq!(KEEPER_ACTION_IDS.len(), 14);
        assert!(KEEPER_ACTION_IDS.len() <= MAX_DELEGATE_ACTIONS);
        assert!(JUROR_ACTION_IDS.iter().chain(KEEPER_ACTION_IDS).all(|id| id.starts_with("jury.")));
    }

    #[test]
    fn each_class_subscribes_to_one_event_family() {
        assert_eq!(delegate_event_family("task_worker"), Some("task"));
        assert_eq!(delegate_event_family("juror"), Some("jury"));
        assert_eq!(delegate_event_family("jury_keeper"), Some("jury"));
        assert_eq!(delegate_event_family("memory"), None);
        assert_eq!(delegate_event_family("root"), None);
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
