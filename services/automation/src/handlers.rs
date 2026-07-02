//! HTTP handlers: job CRUD, event ingestion (ingestion interface, not the bus itself).

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use uuid::Uuid;

use crate::clients::{AuditClient, OracleClient, WorkflowClient};
use crate::executor::RunContext;
use crate::store::AutomationStore;
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
    Json(req): Json<CreateJobRequest>,
) -> Result<Json<JobResponse>, AppError> {
    let job = AutomationJob {
        id: Uuid::new_v4(),
        organization_id: req.organization_id,
        account_id: req.account_id,
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
    Path(id): Path<Uuid>,
) -> Result<Json<AutomationJob>, AppError> {
    state
        .store
        .get_job(id)
        .await
        .map_err(AppError::store)?
        .ok_or(AppError::NotFound)
        .map(Json)
}

/// Ingestion interface — publishes to the in-process event bus (v1).
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
    state.bus.publish(event.clone());
    let jobs = state.store.list_enabled_jobs().await.map_err(AppError::store)?;
    if let Err(e) = state.run_ctx.evaluate_event_for_jobs(&event, &jobs).await {
        tracing::warn!("event evaluation error: {e}");
    }
    Ok(StatusCode::ACCEPTED)
}

fn verify_internal_secret(headers: &HeaderMap, secret: &str) -> Result<(), AppError> {
    let provided = headers
        .get("x-internal-sync-secret")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if provided != secret {
        return Err(AppError::Unauthorized);
    }
    Ok(())
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
}
