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
use crate::webhook::WebhookClient;
use crate::{
    AutomationJob, EventBus, EventTrigger, JobAction, MatchMode, PlatformEvent, RetryPolicy,
    TriggerKind, TriggerSet,
};

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<dyn AutomationStore>,
    pub bus: EventBus,
    pub run_ctx: Arc<RunContext>,
    pub internal_sync_secret: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct CreateJobRequest {
    #[serde(default)]
    pub idempotency_key: Option<Uuid>,
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
    pub retry_policy: RetryPolicy,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunNowRequest {
    pub request_id: Uuid,
}

/// Persist one owner-requested execution through the same inbox, leases and executor as events.
pub async fn run_job_now(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(request): Json<RunNowRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), AppError> {
    verify_internal_secret(&headers, &state.internal_sync_secret)?;
    let job = state
        .store
        .get_job(id)
        .await
        .map_err(AppError::store)?
        .ok_or(AppError::NotFound)?;
    if !job.enabled || job.archived {
        return Err(AppError::Conflict(
            "job must be enabled and unarchived before run-now".into(),
        ));
    }
    let key = format!("automation:manual:{}:{}", id, request.request_id);
    let event = PlatformEvent {
        event_version: 1,
        event_family: "automation".into(),
        event_type: "manual_run".into(),
        organization_id: Some(job.organization_id),
        account_id: Some(job.account_id),
        agent_object_id: Some(job.target_agent_object_id),
        payload: serde_json::json!({"requestId": request.request_id}),
        occurred_at_ms: chrono::Utc::now().timestamp_millis(),
        source_event_id: request.request_id.to_string(),
        deduplication_key: key,
        source_service: "automation_api".into(),
        target_job_id: Some(id),
    };
    let fresh = state
        .store
        .ingest_event_dedup(&event)
        .await
        .map_err(AppError::store)?;
    if fresh {
        state.bus.publish(event);
    }
    Ok((
        if fresh {
            StatusCode::ACCEPTED
        } else {
            StatusCode::OK
        },
        Json(serde_json::json!({
            "jobId": id, "requestId": request.request_id, "accepted": fresh,
            "deduplicated": !fresh, "status": if fresh { "queued" } else { "already_queued_or_processed" }
        })),
    ))
}

fn default_memory_scope() -> String {
    "private".into()
}

#[derive(serde::Serialize)]
pub struct JobResponse {
    pub id: Uuid,
    pub version: u64,
    pub name: String,
    pub enabled: bool,
    pub archived: bool,
}

/// Liveness plus wake-notification counters. Work is retained in the durable delivery inbox.
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
    Json(mut req): Json<CreateJobRequest>,
) -> Result<Json<JobResponse>, AppError> {
    // Job creation is a trusted-service operation: a job row names an
    // organization, an account, and an agent key ref. The browser never calls
    // this directly — it goes through the memory relayer, which enforces owner
    // auth and then presents the shared secret on the caller's behalf.
    verify_internal_secret(&headers, &state.internal_sync_secret)?;
    crate::trigger_eval::validate_trigger_set(&req.trigger_set).map_err(AppError::BadRequest)?;
    validate_job_action(&req.action, state.run_ctx.webhook.allow_private())
        .map_err(AppError::BadRequest)?;
    let request_key = req
        .idempotency_key
        .take()
        .ok_or_else(|| AppError::BadRequest("idempotency_key is required".into()))?;
    let mut fingerprint =
        serde_json::to_value(&req).map_err(|error| AppError::BadRequest(error.to_string()))?;
    if let Some(object) = fingerprint.as_object_mut() {
        object.remove("idempotency_key");
    }
    let request_hash = Sha256::digest(
        serde_json::to_vec(&fingerprint)
            .map_err(|error| AppError::BadRequest(error.to_string()))?,
    )
    .to_vec();

    let job = AutomationJob {
        id: Uuid::new_v4(),
        version: 1,
        organization_id: req.organization_id,
        account_id: req.account_id,
        owner_address: req.owner_address,
        name: req.name,
        enabled: true,
        archived: false,
        trigger_set: req.trigger_set,
        target_agent_object_id: req.target_agent_object_id,
        target_agent_key_ref: req.target_agent_key_ref,
        action: req.action,
        memory_scope: req.memory_scope,
        // Per-run spending ceilings are not an authorization source. The live
        // delegate and chain policy decide whether each action may execute.
        max_mist_per_run: 0,
        retry_policy: req.retry_policy,
    };
    let (saved, _) = state
        .store
        .create_job_idempotent(job, request_key, &request_hash)
        .await
        .map_err(AppError::store)?;
    Ok(Json(JobResponse {
        id: saved.id,
        version: saved.version,
        name: saved.name,
        enabled: saved.enabled,
        archived: saved.archived,
    }))
}

/// Validate the same authenticated job payload used by creation without storing or executing it.
pub async fn validate_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreateJobRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    verify_internal_secret(&headers, &state.internal_sync_secret)?;
    if req.name.trim().is_empty() || req.name.chars().count() > 200 {
        return Err(AppError::BadRequest(
            "job name must contain 1 to 200 characters".into(),
        ));
    }
    crate::trigger_eval::validate_trigger_set(&req.trigger_set).map_err(AppError::BadRequest)?;
    validate_job_action(&req.action, state.run_ctx.webhook.allow_private())
        .map_err(AppError::BadRequest)?;
    let action_kind = serde_json::to_value(&req.action.kind)
        .map_err(|error| AppError::BadRequest(error.to_string()))?;
    Ok(Json(serde_json::json!({
        "valid": true,
        "action_kind": action_kind,
        "trigger_count": req.trigger_set.triggers.len(),
        "enabled_on_create": true,
        "dispatch_performed": false,
        "notice": "Validation checked structure and configured policy only; no job was created and no action was dispatched."
    })))
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SimulateJobEventRequest {
    pub event_family: String,
    pub event_type: String,
    #[serde(default)]
    pub payload: serde_json::Value,
}

/// Evaluate one synthetic event against a saved job without persisting or dispatching it.
pub async fn simulate_job_event(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(request): Json<SimulateJobEventRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    verify_internal_secret(&headers, &state.internal_sync_secret)?;
    if request.event_family.trim().is_empty()
        || request.event_family.len() > 128
        || request.event_type.trim().is_empty()
        || request.event_type.len() > 128
        || !request.payload.is_object()
        || serde_json::to_vec(&request.payload)
            .map_err(|error| AppError::BadRequest(error.to_string()))?
            .len()
            > 32 * 1024
    {
        return Err(AppError::BadRequest(
            "event family/type or object payload is invalid or too large".into(),
        ));
    }
    let job = state
        .store
        .get_job(id)
        .await
        .map_err(AppError::store)?
        .ok_or(AppError::NotFound)?;
    let event = PlatformEvent {
        event_version: 1,
        event_family: request.event_family,
        event_type: request.event_type,
        organization_id: Some(job.organization_id.clone()),
        account_id: Some(job.account_id.clone()),
        agent_object_id: Some(job.target_agent_object_id.clone()),
        payload: request.payload,
        occurred_at_ms: 0,
        source_event_id: "simulation".into(),
        deduplication_key: "simulation".into(),
        source_service: "automation_simulation".into(),
        target_job_id: Some(id),
    };
    let matched: Vec<usize> = job
        .trigger_set
        .triggers
        .iter()
        .enumerate()
        .filter_map(|(index, trigger)| {
            crate::trigger_eval::event_matches_trigger(&event, trigger).then_some(index)
        })
        .collect();
    let would_satisfy =
        crate::trigger_eval::trigger_set_should_fire(&job.trigger_set, &matched, &[], 0, None);
    let event_trigger_count = job
        .trigger_set
        .triggers
        .iter()
        .filter(|trigger| trigger.kind == crate::TriggerKind::Event)
        .count();
    Ok(Json(serde_json::json!({
        "jobId": id,
        "eventFamily": event.event_family,
        "eventType": event.event_type,
        "matchedTriggerIndexes": matched,
        "eventTriggerCount": event_trigger_count,
        "nonEventTriggerCount": job.trigger_set.triggers.len() - event_trigger_count,
        "eventOnlyWouldSatisfyTriggerSet": would_satisfy,
        "dispatchPerformed": false,
        "persisted": false,
        "limitations": ["This simulation checks event-family/type/scope/payload matching only.", "It does not evaluate prior ALL-trigger history, debounce, cooldown, quota, replay, cron, interval, or future dispatch state."]
    })))
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
        crate::JobActionKind::WorkRun => crate::work_run::parse_config(&action.config).map(|_| ()),
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

/// Permanently delete an idle automation job. Its completed run/delivery
/// history is removed by the store's foreign-key cascade; active or uncertain
/// work must be reconciled first.
pub async fn delete_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Query(query): Query<JobVersionQuery>,
) -> Result<StatusCode, AppError> {
    verify_internal_secret(&headers, &state.internal_sync_secret)?;
    if !state
        .store
        .delete_job(id, query.expected_version)
        .await
        .map_err(AppError::store)?
    {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JobVersionQuery {
    pub expected_version: u64,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetJobEnabledRequest {
    pub expected_version: u64,
    pub enabled: bool,
}

/// Pause or resume an existing job. Event deliveries remain durable and can be
/// inspected after the job is paused; the scheduler ignores disabled jobs.
pub async fn set_job_enabled(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(req): Json<SetJobEnabledRequest>,
) -> Result<Json<JobResponse>, AppError> {
    verify_internal_secret(&headers, &state.internal_sync_secret)?;
    let job = state
        .store
        .set_job_enabled(id, req.expected_version, req.enabled)
        .await
        .map_err(AppError::store)?
        .ok_or(AppError::NotFound)?;
    Ok(Json(JobResponse {
        id: job.id,
        version: job.version,
        name: job.name,
        enabled: job.enabled,
        archived: job.archived,
    }))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelJobRequest {
    pub expected_version: u64,
    pub actor: String,
    pub note: String,
    pub confirmed: bool,
}

/// Disable a job and atomically cancel only deliveries that have not been claimed.
/// A claimed worker observes the durable cancellation marker before it can requeue pre-dispatch work.
pub async fn cancel_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(request): Json<CancelJobRequest>,
) -> Result<Json<crate::store::JobCancellationResult>, AppError> {
    verify_internal_secret(&headers, &state.internal_sync_secret)?;
    if !request.confirmed {
        return Err(AppError::BadRequest(
            "explicit job cancellation confirmation is required".into(),
        ));
    }
    if request.actor.trim().is_empty()
        || request.actor.chars().count() > 200
        || request.note.trim().len() < 8
        || request.note.chars().count() > 1000
    {
        return Err(AppError::BadRequest(
            "actor and an 8-1000 character cancellation note are required".into(),
        ));
    }
    state
        .store
        .cancel_job_queued_deliveries(
            id,
            request.expected_version,
            request.actor.trim(),
            request.note.trim(),
        )
        .await
        .map_err(AppError::store)?
        .map(Json)
        .ok_or(AppError::NotFound)
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenameJobRequest {
    pub expected_version: u64,
    pub name: String,
}

/// Rename an existing job. Execution settings and delegate authority are immutable here.
pub async fn rename_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(req): Json<RenameJobRequest>,
) -> Result<Json<JobResponse>, AppError> {
    verify_internal_secret(&headers, &state.internal_sync_secret)?;
    let name = req.name.trim();
    if name.is_empty() || name.chars().count() > 200 {
        return Err(AppError::BadRequest(
            "job name must contain 1 to 200 characters".into(),
        ));
    }
    let job = state
        .store
        .rename_job(id, req.expected_version, name)
        .await
        .map_err(AppError::store)?
        .ok_or(AppError::NotFound)?;
    Ok(Json(JobResponse {
        id: job.id,
        version: job.version,
        name: job.name,
        enabled: job.enabled,
        archived: job.archived,
    }))
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchiveJobRequest {
    pub expected_version: u64,
}

pub async fn archive_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(request): Json<ArchiveJobRequest>,
) -> Result<Json<JobResponse>, AppError> {
    set_archived(state, headers, id, request.expected_version, true).await
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RestoreJobRequest {
    pub expected_version: u64,
}

pub async fn restore_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(request): Json<RestoreJobRequest>,
) -> Result<Json<JobResponse>, AppError> {
    set_archived(state, headers, id, request.expected_version, false).await
}

async fn set_archived(
    state: AppState,
    headers: HeaderMap,
    id: Uuid,
    expected_version: u64,
    archived: bool,
) -> Result<Json<JobResponse>, AppError> {
    verify_internal_secret(&headers, &state.internal_sync_secret)?;
    let job = state
        .store
        .set_job_archived(id, expected_version, archived)
        .await
        .map_err(AppError::store)?
        .ok_or(AppError::NotFound)?;
    Ok(Json(JobResponse {
        id: job.id,
        version: job.version,
        name: job.name,
        enabled: job.enabled,
        archived: job.archived,
    }))
}

#[derive(serde::Deserialize)]
pub struct ListJobsQuery {
    pub target_agent_object_id: Option<String>,
    pub organization_id: Option<String>,
    pub account_id: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
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
    let filter = JobFilter::new(query.organization_id, query.account_id, query.limit)
        .with_agent(query.target_agent_object_id)
        .with_offset(query.offset);
    // An unscoped listing is a caller mistake, not a server fault.
    filter
        .validate()
        .map_err(|e| AppError::BadRequest(e.to_string()))?;
    let jobs = state
        .store
        .list_jobs(filter)
        .await
        .map_err(AppError::store)?;
    Ok(Json(jobs))
}

#[derive(serde::Deserialize)]
pub struct ListRunsQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
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
    if state
        .store
        .get_job(id)
        .await
        .map_err(AppError::store)?
        .is_none()
    {
        return Err(AppError::NotFound);
    }
    let runs = state
        .store
        .list_runs_page(
            id,
            query.limit.unwrap_or(crate::store::DEFAULT_LIST_LIMIT),
            query.offset.unwrap_or(0),
        )
        .await
        .map_err(AppError::store)?;
    Ok(Json(runs))
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResolveOrphanRunRequest {
    pub resolution: String,
    pub actor: String,
    pub note: String,
    pub confirmed: bool,
}

/// Close a stale run with no linked delivery. This endpoint never requeues work.
pub async fn resolve_orphan_run(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((job_id, run_id)): Path<(Uuid, Uuid)>,
    Json(request): Json<ResolveOrphanRunRequest>,
) -> Result<Json<crate::store::RunSummary>, AppError> {
    verify_internal_secret(&headers, &state.internal_sync_secret)?;
    if !request.confirmed {
        return Err(AppError::BadRequest("explicit orphan-run resolution confirmation is required".into()));
    }
    if !matches!(request.resolution.as_str(), "confirmed_succeeded" | "closed_uncertain_no_replay") {
        return Err(AppError::BadRequest("resolution must confirm success or close the uncertain run without replay".into()));
    }
    if request.actor.trim().is_empty()
        || request.actor.chars().count() > 200
        || request.note.trim().chars().count() < 8
        || request.note.chars().count() > 1000
    {
        return Err(AppError::BadRequest("actor and an 8-1000 character reconciliation note are required".into()));
    }
    state.store.resolve_orphan_run(job_id, run_id, &request.resolution, request.actor.trim(), request.note.trim())
        .await.map_err(AppError::store)?.map(Json).ok_or(AppError::NotFound)
}

/// Delivery metadata for one job. Payloads and signing material are never returned.
pub async fn list_event_deliveries(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(query): Query<ListRunsQuery>,
) -> Result<Json<Vec<crate::store::EventDeliverySummary>>, AppError> {
    Ok(Json(
        state
            .store
            .list_event_deliveries_page(id, query.limit.unwrap_or(20), query.offset.unwrap_or(0))
            .await
            .map_err(AppError::store)?,
    ))
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResolveEventDeliveryRequest {
    pub job_id: Uuid,
    pub resolution: String,
    pub actor: String,
    pub note: String,
    pub confirmed: bool,
}

/// Resolve an uncertain delivery from an explicit owner/operator observation.
/// Retry is permitted only when the caller confirms that the external action
/// never ran; the original event and stable action idempotency key are reused.
pub async fn resolve_event_delivery(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(request): Json<ResolveEventDeliveryRequest>,
) -> Result<Json<crate::store::EventDeliverySummary>, AppError> {
    verify_internal_secret(&headers, &state.internal_sync_secret)?;
    if !request.confirmed {
        return Err(AppError::BadRequest(
            "explicit resolution confirmation is required".into(),
        ));
    }
    if !matches!(
        request.resolution.as_str(),
        "confirmed_succeeded" | "confirmed_not_executed_retry"
    ) {
        return Err(AppError::BadRequest(
            "resolution must confirm success or confirm the action never executed".into(),
        ));
    }
    if request.actor.trim().is_empty()
        || request.actor.chars().count() > 200
        || request.note.trim().len() < 8
        || request.note.chars().count() > 1000
    {
        return Err(AppError::BadRequest(
            "actor and an 8-1000 character reconciliation note are required".into(),
        ));
    }
    state
        .store
        .resolve_event_delivery(
            id,
            request.job_id,
            &request.resolution,
            request.actor.trim(),
            request.note.trim(),
        )
        .await
        .map_err(AppError::store)?
        .map(Json)
        .ok_or(AppError::NotFound)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelEventDeliveryRequest {
    pub job_id: Uuid,
    pub actor: String,
    pub note: String,
    pub confirmed: bool,
}

/// Cancel only before worker claim. The update and claim contend on the same durable row.
pub async fn cancel_event_delivery(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(request): Json<CancelEventDeliveryRequest>,
) -> Result<Json<crate::store::EventDeliverySummary>, AppError> {
    verify_internal_secret(&headers, &state.internal_sync_secret)?;
    if !request.confirmed {
        return Err(AppError::BadRequest(
            "explicit cancellation confirmation is required".into(),
        ));
    }
    if request.actor.trim().is_empty()
        || request.actor.chars().count() > 200
        || request.note.trim().len() < 8
        || request.note.chars().count() > 1000
    {
        return Err(AppError::BadRequest(
            "actor and an 8-1000 character cancellation note are required".into(),
        ));
    }
    state
        .store
        .cancel_event_delivery(
            id,
            request.job_id,
            request.actor.trim(),
            request.note.trim(),
        )
        .await
        .map_err(AppError::store)?
        .map(Json)
        .ok_or_else(|| {
            AppError::Conflict(
                "delivery is no longer pending; claimed or uncertain work cannot be cancelled"
                    .into(),
            )
        })
}

/// Ingestion commits the event and per-job deliveries before publishing a wake hint.
///
/// Returns 202 after durable enqueue. The consumer polls persisted deliveries even when wake hints are lost.
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
    /// `memory` (default), `task_worker`, `juror` or `action_worker`.
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
pub const DELEGATE_CLASS_ACTION_WORKER: &str = "action_worker";
const MAX_DELEGATE_ACTIONS: usize = 16;

/// Production catalog actions that are enabled for unattended agent-capability execution.
/// Keep this list aligned with `CHAIN_CLASS_ACTIONS.action_worker` in the sidecar.
pub const ACTION_WORKER_ACTION_IDS: &[&str] = &[
    "access.publish_mydata_graph.v1",
    "access.purchase_mydata_access.v1",
    "access.purchase_post_access.v1",
    "task.create.v1",
    "spt.buy.v1",
    "social.react_to_post.v1",
    "social.remove_post_reaction.v1",
    "social.react_to_comment.v1",
    "social.remove_comment_reaction.v1",
    "social.create_post.v1",
    "social.edit_post.v1",
    "social.create_comment.v1",
    "social.edit_comment.v1",
    "social.create_repost.v1",
    "social.remove_repost.v1",
    "social.follow_profile.v1",
    "social.unfollow_profile.v1",
    "social.block_profile.v1",
    "social.unblock_profile.v1",
    "messaging.send_message.v1",
    "messaging.create_group.v1",
    "messaging.bind_room_to_task.v1",
    "organization.accept_invitation.v1",
    "organization.decline_invitation.v1",
    "agent.register_child.v1",
    "agent.update_child.v1",
    "agent.deactivate_child.v1",
    "agent.revoke_child.v1",
];

/// A juror's own steps. Must match `JUROR_ACTION_IDS` in the bridge and the relayer's policy.
pub const JUROR_ACTION_IDS: &[&str] = &[
    "jury.accept.v1",
    "jury.commit_vote.v1",
    "jury.reveal_vote.v1",
    "jury.claim_fee.v1",
];

/// The event family a class's jobs may subscribe to.
pub fn delegate_event_family(class: &str) -> Option<&'static str> {
    match class {
        DELEGATE_CLASS_TASK_WORKER => Some("task"),
        DELEGATE_CLASS_JUROR => Some("jury"),
        _ => None,
    }
}

/// Whether a delegate of `class` may be allowed to run `id`: a task worker any task market action, a
/// juror only its own four steps. The cranks run on the operator's key, never a delegate's.
pub fn class_may_run(class: &str, id: &str) -> bool {
    if !crate::registered_action::valid_action_id(id) {
        return false;
    }
    match class {
        DELEGATE_CLASS_TASK_WORKER => id.starts_with("task."),
        DELEGATE_CLASS_JUROR => JUROR_ACTION_IDS.contains(&id),
        DELEGATE_CLASS_ACTION_WORKER => ACTION_WORKER_ACTION_IDS.contains(&id),
        _ => false,
    }
}

/// A memory delegate runs no chain actions at all; every other class runs only its own. Checked
/// here and again by the bridge, so neither can be bypassed alone.
pub fn validate_delegate_class(class: &str, allowed_action_ids: &[String]) -> Result<(), String> {
    if allowed_action_ids
        .iter()
        .collect::<std::collections::HashSet<_>>()
        .len()
        != allowed_action_ids.len()
    {
        return Err("allowed_action_ids must not contain duplicates".into());
    }
    match class {
        DELEGATE_CLASS_MEMORY => {
            if allowed_action_ids.is_empty() {
                Ok(())
            } else {
                Err("a memory delegate cannot run chain actions; use task_worker, juror or action_worker".into())
            }
        }
        DELEGATE_CLASS_TASK_WORKER | DELEGATE_CLASS_JUROR | DELEGATE_CLASS_ACTION_WORKER => {
            if allowed_action_ids.is_empty() || allowed_action_ids.len() > MAX_DELEGATE_ACTIONS {
                return Err(format!(
                    "a {class} delegate needs 1 to {MAX_DELEGATE_ACTIONS} allowed_action_ids"
                ));
            }
            match allowed_action_ids
                .iter()
                .find(|id| !class_may_run(class, id))
            {
                Some(bad) => Err(format!(
                    "`{bad}` is not an action a {class} delegate may run"
                )),
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
        return Err(AppError::BadRequest(
            "encrypted is required and must be small".into(),
        ));
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
    pub expected_agent_object_id: Option<String>,
    pub account_id: Option<String>,
    pub delegate_ref: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<i64>,
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
        _ => Err(AppError::BadRequest(
            "a valid delegate_ref is required".into(),
        )),
    }
}

/// Metadata only. The encrypted key is never part of this response.
pub async fn list_delegates(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<DelegateScopeQuery>,
) -> Result<Json<crate::store::DelegatePage>, AppError> {
    verify_internal_secret(&headers, &state.internal_sync_secret)?;
    let account = require_account(&query)?;
    if query
        .cursor
        .as_deref()
        .is_some_and(|cursor| !valid_delegate_ref(cursor))
    {
        return Err(AppError::BadRequest(
            "cursor must be a valid delegate_ref".into(),
        ));
    }
    if query.expected_agent_object_id.as_deref().is_some_and(|id| {
        let raw = id
            .strip_prefix("0x")
            .or_else(|| id.strip_prefix("0X"))
            .unwrap_or(id);
        raw.is_empty() || raw.len() > 64 || !raw.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        return Err(AppError::BadRequest(
            "expected_agent_object_id must be a MySo object ID".into(),
        ));
    }
    let limit = query
        .limit
        .unwrap_or(crate::store::DEFAULT_DELEGATE_LIST_LIMIT);
    if !(1..=crate::store::MAX_DELEGATE_LIST_LIMIT).contains(&limit) {
        return Err(AppError::BadRequest(format!(
            "limit must be between 1 and {}",
            crate::store::MAX_DELEGATE_LIST_LIMIT
        )));
    }
    Ok(Json(
        state
            .store
            .list_delegates(
                account,
                query.expected_agent_object_id.as_deref(),
                query.cursor.as_deref(),
                limit,
            )
            .await
            .map_err(AppError::store)?,
    ))
}

pub async fn list_delegate_key_events(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<DelegateScopeQuery>,
) -> Result<Json<crate::store::DelegateKeyEventPage>, AppError> {
    verify_internal_secret(&headers, &state.internal_sync_secret)?;
    let account = require_account(&query)?;
    let after = query
        .cursor
        .as_deref()
        .map(|value| {
            value
                .parse::<i64>()
                .map_err(|_| AppError::BadRequest("cursor must be a positive event ID".into()))
        })
        .transpose()?;
    if after.is_some_and(|id| id <= 0) {
        return Err(AppError::BadRequest(
            "cursor must be a positive event ID".into(),
        ));
    }
    if query.expected_agent_object_id.as_deref().is_some_and(|id| {
        let raw = id
            .strip_prefix("0x")
            .or_else(|| id.strip_prefix("0X"))
            .unwrap_or(id);
        raw.is_empty() || raw.len() > 64 || !raw.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        return Err(AppError::BadRequest(
            "expected_agent_object_id must be a MySo object ID".into(),
        ));
    }
    let limit = query
        .limit
        .unwrap_or(crate::store::DEFAULT_DELEGATE_LIST_LIMIT);
    if !(1..=crate::store::MAX_DELEGATE_LIST_LIMIT).contains(&limit) {
        return Err(AppError::BadRequest(format!(
            "limit must be between 1 and {}",
            crate::store::MAX_DELEGATE_LIST_LIMIT
        )));
    }
    Ok(Json(
        state
            .store
            .list_delegate_key_events(
                account,
                query.expected_agent_object_id.as_deref(),
                after,
                limit,
            )
            .await
            .map_err(AppError::store)?,
    ))
}

/// Exact metadata lookup for trusted proxy identity fences; never returns ciphertext.
pub async fn get_delegate_summary(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<DelegateScopeQuery>,
) -> Result<Json<crate::store::DelegateSummary>, AppError> {
    verify_internal_secret(&headers, &state.internal_sync_secret)?;
    let account = require_account(&query)?;
    let delegate_ref = require_ref(&query)?;
    state
        .store
        .get_delegate_summary(account, delegate_ref)
        .await
        .map_err(AppError::store)?
        .map(Json)
        .ok_or(AppError::NotFound)
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

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateJobConfigurationRequest {
    pub expected_version: u64,
    pub trigger_set: TriggerSet,
    pub action: JobAction,
}

/// Replace trigger and action configuration only when the job is paused and has no
/// active or uncertain work. Identity, delegate, memory scope and spend limits stay fixed.
pub async fn update_job_configuration(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(request): Json<UpdateJobConfigurationRequest>,
) -> Result<Json<JobResponse>, AppError> {
    verify_internal_secret(&headers, &state.internal_sync_secret)?;
    crate::trigger_eval::validate_trigger_set(&request.trigger_set)
        .map_err(AppError::BadRequest)?;
    validate_job_action(&request.action, state.run_ctx.webhook.allow_private())
        .map_err(AppError::BadRequest)?;
    let _current = state
        .store
        .get_job(id)
        .await
        .map_err(AppError::store)?
        .ok_or(AppError::NotFound)?;
    let saved = state
        .store
        .update_job_configuration(
            id,
            request.expected_version,
            request.trigger_set,
            request.action,
        )
        .await
        .map_err(AppError::store)?
        .ok_or(AppError::NotFound)?;
    Ok(Json(JobResponse {
        id: saved.id,
        version: saved.version,
        name: saved.name,
        enabled: saved.enabled,
        archived: saved.archived,
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
        .delete_delegate_if_agent(
            account,
            delegate_ref,
            query.expected_agent_object_id.as_deref(),
        )
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
        timezone: None,
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
    Conflict(String),
    Store(String),
}

impl AppError {
    fn store(e: crate::store::StoreError) -> Self {
        match e {
            crate::store::StoreError::NotFound => Self::NotFound,
            crate::store::StoreError::Conflict => Self::Conflict(
                "job has active or uncertain work; reconcile it before deleting".into(),
            ),
            crate::store::StoreError::IdempotencyConflict => Self::Conflict(
                "this idempotency key was already used with different automation settings".into(),
            ),
            other => Self::Store(other.to_string()),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        match self {
            Self::NotFound => (StatusCode::NOT_FOUND, "not found").into_response(),
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized").into_response(),
            Self::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg).into_response(),
            Self::Conflict(msg) => (StatusCode::CONFLICT, msg).into_response(),
            Self::Store(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg).into_response(),
        }
    }
}

pub fn build_run_context(store: Arc<dyn AutomationStore>, config: &crate::Config) -> RunContext {
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
        assert!(validate_job_action(
            &registered(serde_json::json!({ "action_id": "nope" })),
            false
        )
        .is_err());
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

        assert!(validate_delegate_class(
            "task_worker",
            &ids(&["task.accept.v1", "task.deliver.v1"])
        )
        .is_ok());
        assert!(validate_delegate_class("task_worker", &[]).is_err());
        assert!(validate_delegate_class("task_worker", &ids(&["social.create_post.v1"])).is_err());
        assert!(validate_delegate_class(
            "task_worker",
            &ids(&["task.accept.v1", "agent.revoke_child.v1"])
        )
        .is_err());
        assert!(validate_delegate_class("task_worker", &ids(&["task.accept"])).is_err());
        let too_many: Vec<String> = (0..17)
            .map(|i| format!("task.a{}.v1", "b".repeat(i % 3 + 1)))
            .collect();
        assert!(validate_delegate_class("task_worker", &too_many).is_err());
        assert!(validate_delegate_class("root", &[]).is_err());
    }

    #[test]
    fn a_juror_may_only_be_allowed_its_own_actions() {
        let ids = |list: &[&str]| list.iter().map(|s| (*s).to_string()).collect::<Vec<_>>();
        assert!(
            validate_delegate_class("juror", &ids(&["jury.accept.v1", "jury.commit_vote.v1"]))
                .is_ok()
        );
        assert!(validate_delegate_class("juror", &ids(JUROR_ACTION_IDS)).is_ok());

        // Never a crank, never a task action, never an unknown or malformed one, and the old keeper
        // class is gone.
        assert!(validate_delegate_class("juror", &ids(&["jury.select_jury.v1"])).is_err());
        assert!(validate_delegate_class("jury_keeper", &ids(&["jury.select_jury.v1"])).is_err());
        assert!(validate_delegate_class("juror", &ids(&["task.accept.v1"])).is_err());
        assert!(validate_delegate_class("task_worker", &ids(&["jury.accept.v1"])).is_err());
        assert!(validate_delegate_class("juror", &ids(&["jury.vote_for_me.v1"])).is_err());
        assert!(validate_delegate_class("juror", &ids(&["jury.accept"])).is_err());
        assert!(validate_delegate_class("juror", &[]).is_err());
        assert!(validate_delegate_class("memory", &ids(&["jury.accept.v1"])).is_err());
    }

    #[test]
    fn the_juror_action_list_is_four_jury_steps() {
        assert_eq!(JUROR_ACTION_IDS.len(), 4);
        assert!(JUROR_ACTION_IDS.iter().all(|id| id.starts_with("jury.")));
    }

    #[test]
    fn each_class_subscribes_to_one_event_family() {
        assert_eq!(delegate_event_family("task_worker"), Some("task"));
        assert_eq!(delegate_event_family("juror"), Some("jury"));
        assert_eq!(delegate_event_family("jury_keeper"), None);
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
