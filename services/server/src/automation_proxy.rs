//! Owner-authenticated proxy to the automation engine.
//!
//! The engine's own job API is gated on a shared secret, because a job row
//! names an organization, an account, and an agent key ref, and creating one is
//! a trusted-service operation. A browser cannot hold that secret, so this
//! module is the only path from the chat-app to the engine: the caller signs
//! with an agent key, this service resolves the identity, and it forwards with
//! the secret attached.
//!
//! Ownership is enforced here rather than on the engine. The engine's
//! `GET /v1/automation/jobs/{id}` is keyed only by job id, so forwarding a
//! caller-supplied id unchecked would let any authenticated agent read any
//! tenant's job and run history. Every by-id route below therefore re-reads the
//! job and compares `account_id` against the authenticated identity first.
//!
//! Configure with `AUTOMATION_ENGINE_URL`. When unset, these routes return 503
//! rather than falling through to something less safe.

use std::sync::Arc;

use axum::{
    extract::{Extension, Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::types::{AppState, AuthInfo, Config};

/// How long a proxied engine call may take before it is abandoned.
const ENGINE_TIMEOUT_SECS: u64 = 20;
/// Cap on a proxied response body, so a misbehaving engine cannot stream
/// unbounded data into this process.
const MAX_ENGINE_BYTES: usize = 512 * 1024;

/// A proxy failure. Public because it is the error type of the public route
/// handlers, which axum requires to be nameable at their visibility.
#[derive(Debug)]
pub enum ProxyError {
    NotConfigured,
    /// A job that does not exist, or one owned by another account.
    ///
    /// Deliberately one variant for both cases: a distinct "forbidden" status
    /// would let a caller probe which job ids exist.
    NotFound,
    Conflict(String),
    InvalidRequest(String),
    EngineUnavailable(String),
}

impl IntoResponse for ProxyError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::NotConfigured => (
                StatusCode::SERVICE_UNAVAILABLE,
                "automation engine is not configured (set AUTOMATION_ENGINE_URL)".to_string(),
            ),
            Self::NotFound => (StatusCode::NOT_FOUND, "job not found".to_string()),
            Self::Conflict(msg) => (StatusCode::CONFLICT, msg),
            Self::InvalidRequest(msg) => (StatusCode::BAD_REQUEST, msg),
            Self::EngineUnavailable(msg) => (StatusCode::BAD_GATEWAY, msg),
        };
        (status, Json(serde_json::json!({ "error": message }))).into_response()
    }
}

/// A resolved, ready-to-call engine endpoint.
struct EngineClient<'a> {
    base_url: &'a str,
    secret: &'a str,
    http: reqwest::Client,
}

impl<'a> EngineClient<'a> {
    fn from_config(config: &'a Config) -> Result<Self, ProxyError> {
        let base_url = config
            .automation_engine_url
            .as_deref()
            .map(|u| u.trim_end_matches('/'))
            .ok_or(ProxyError::NotConfigured)?;
        let secret = config
            .automation_engine_secret
            .as_deref()
            .ok_or(ProxyError::NotConfigured)?;
        Ok(Self {
            base_url,
            secret,
            http: reqwest::Client::new(),
        })
    }

    async fn get(&self, path: &str) -> Result<Value, ProxyError> {
        let response = self
            .http
            .get(format!("{}{path}", self.base_url))
            .header("x-internal-sync-secret", self.secret)
            .timeout(std::time::Duration::from_secs(ENGINE_TIMEOUT_SECS))
            .send()
            .await
            .map_err(|e| ProxyError::EngineUnavailable(format!("automation engine unreachable: {e}")))?;

        let status = response.status();
        if status == StatusCode::NOT_FOUND {
            return Err(ProxyError::NotFound);
        }
        if status == StatusCode::CONFLICT {
            let detail = response.text().await.unwrap_or_default();
            return Err(ProxyError::Conflict(detail.trim().to_string()));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|e| ProxyError::EngineUnavailable(format!("reading engine response failed: {e}")))?;
        if bytes.len() > MAX_ENGINE_BYTES {
            return Err(ProxyError::EngineUnavailable(
                "automation engine response exceeded the proxy cap".into(),
            ));
        }
        if !status.is_success() {
            return Err(ProxyError::EngineUnavailable(format!(
                "automation engine returned {status}"
            )));
        }
        serde_json::from_slice(&bytes).map_err(|e| {
            ProxyError::EngineUnavailable(format!("automation engine returned unparseable JSON: {e}"))
        })
    }

    /// PUT/DELETE against an engine route that answers 204 with no body.
    async fn send_no_content(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<(), ProxyError> {
        let mut request = self
            .http
            .request(method, format!("{}{path}", self.base_url))
            .header("x-internal-sync-secret", self.secret)
            .timeout(std::time::Duration::from_secs(ENGINE_TIMEOUT_SECS));
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await.map_err(|e| {
            ProxyError::EngineUnavailable(format!("automation engine unreachable: {e}"))
        })?;
        let status = response.status();
        if status == StatusCode::NOT_FOUND {
            return Err(ProxyError::NotFound);
        }
        if status == StatusCode::CONFLICT {
            let detail = response.text().await.unwrap_or_default();
            return Err(ProxyError::Conflict(detail.trim().to_string()));
        }
        if status.is_success() {
            return Ok(());
        }
        let detail = response.text().await.unwrap_or_default();
        Err(if status.is_client_error() {
            ProxyError::InvalidRequest(detail.trim().to_string())
        } else {
            ProxyError::EngineUnavailable(format!("automation engine returned {status}"))
        })
    }

    async fn post(&self, path: &str, body: &Value) -> Result<Value, ProxyError> {
        let response = self
            .http
            .post(format!("{}{path}", self.base_url))
            .header("x-internal-sync-secret", self.secret)
            .json(body)
            .timeout(std::time::Duration::from_secs(ENGINE_TIMEOUT_SECS))
            .send()
            .await
            .map_err(|e| ProxyError::EngineUnavailable(format!("automation engine unreachable: {e}")))?;

        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|e| ProxyError::EngineUnavailable(format!("reading engine response failed: {e}")))?;
        if !status.is_success() {
            let detail = serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
                .unwrap_or_else(|| String::from_utf8_lossy(&bytes).trim().to_string());
            // A 4xx from the engine is the caller's payload to fix.
            return Err(if status == StatusCode::NOT_FOUND { ProxyError::NotFound }
            else if status == StatusCode::CONFLICT { ProxyError::Conflict(detail) }
            else if status.is_client_error() {
                ProxyError::InvalidRequest(detail)
            } else {
                ProxyError::EngineUnavailable(format!("automation engine returned {status}: {detail}"))
            });
        }
        serde_json::from_slice(&bytes).map_err(|e| {
            ProxyError::EngineUnavailable(format!("automation engine returned unparseable JSON: {e}"))
        })
    }

    async fn patch(&self, path: &str, body: &Value) -> Result<Value, ProxyError> {
        let response = self.http
            .patch(format!("{}{path}", self.base_url))
            .header("x-internal-sync-secret", self.secret)
            .json(body)
            .timeout(std::time::Duration::from_secs(ENGINE_TIMEOUT_SECS))
            .send().await
            .map_err(|e| ProxyError::EngineUnavailable(format!("automation engine unreachable: {e}")))?;
        let status = response.status();
        let bytes = response.bytes().await
            .map_err(|e| ProxyError::EngineUnavailable(format!("reading engine response failed: {e}")))?;
        if bytes.len() > MAX_ENGINE_BYTES {
            return Err(ProxyError::EngineUnavailable("automation engine response exceeded the proxy cap".into()));
        }
        if !status.is_success() {
            let detail = serde_json::from_slice::<Value>(&bytes).ok()
                .and_then(|v| v.get("error").and_then(Value::as_str).map(String::from))
                .unwrap_or_else(|| String::from_utf8_lossy(&bytes).trim().to_string());
            return Err(if status == StatusCode::NOT_FOUND { ProxyError::NotFound }
                else if status == StatusCode::CONFLICT { ProxyError::Conflict(detail) }
                else if status.is_client_error() { ProxyError::InvalidRequest(detail) }
                else { ProxyError::EngineUnavailable(format!("automation engine returned {status}: {detail}")) });
        }
        serde_json::from_slice(&bytes).map_err(|e| ProxyError::EngineUnavailable(format!("automation engine returned unparseable JSON: {e}")))
    }
}

/// `account_id` from the engine's own `AutomationJob` payload.
fn job_account_id(job: &Value) -> Option<&str> {
    job.get("account_id").and_then(|v| v.as_str())
}

/// Confirm the job belongs to the authenticated account.
///
/// Returns `NotFound` (not `Unauthorized`) on a mismatch so a caller cannot use
/// the status code to learn whether someone else's job id exists.
async fn assert_owned(
    engine: &EngineClient<'_>,
    job_id: &str,
    auth: &AuthInfo,
) -> Result<Value, ProxyError> {
    let job = engine.get(&format!("/v1/automation/jobs/{job_id}")).await?;
    match job_account_id(&job) {
        Some(owner) if canonical_object_id(owner) == canonical_object_id(&auth.account_id)
            && (auth.owner_co_signed || job.get("target_agent_object_id").and_then(Value::as_str).is_some_and(|agent|canonical_object_id(agent)==canonical_object_id(&auth.agent_object_id))) => Ok(job),
        Some(_) => Err(ProxyError::NotFound),
        None => Err(ProxyError::EngineUnavailable(
            "automation engine returned a job with no account_id".into(),
        )),
    }
}

#[derive(Debug, Deserialize)]
pub struct ListJobsQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// `GET /api/automation/jobs` — jobs for the authenticated account.
pub async fn list_jobs(
    Extension(auth): Extension<AuthInfo>,
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListJobsQuery>,
) -> Result<Json<Value>, ProxyError> {
    let engine = EngineClient::from_config(&state.config)?;
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    let offset=query.offset.unwrap_or(0).clamp(0,100_000);
    // The account filter comes from the verified identity, never the query
    // string — otherwise a caller could ask for someone else's jobs.
    let mut path = format!(
        "/v1/automation/jobs?account_id={}&limit={limit}&offset={offset}",
        urlencode(&auth.account_id)
    );
    if !auth.owner_co_signed { path.push_str(&format!("&target_agent_object_id={}",urlencode(&auth.agent_object_id))); }
    let mut jobs = engine.get(&path).await?;
    if let Some(list) = jobs.as_array_mut() {
        list.iter_mut().for_each(redact_job_secrets);
    }
    Ok(Json(jobs))
}

/// `GET /api/automation/jobs/:id` — one job, if it belongs to the caller.
pub async fn get_job(
    Extension(auth): Extension<AuthInfo>,
    State(state): State<Arc<AppState>>,
    Path(job_id): Path<String>,
) -> Result<Json<Value>, ProxyError> {
    let engine = EngineClient::from_config(&state.config)?;
    let mut job = assert_owned(&engine, &job_id, &auth).await?;
    redact_job_secrets(&mut job);
    Ok(Json(job))
}

/// Permanently delete an owned job after the engine confirms it has no active
/// run or pending/uncertain event delivery.
pub async fn delete_job(
    Extension(auth): Extension<AuthInfo>,
    State(state): State<Arc<AppState>>,
    Path(job_id): Path<String>,
    Json(body): Json<JobVersionBody>,
) -> Result<StatusCode, ProxyError> {
    let engine = EngineClient::from_config(&state.config)?;
    assert_owned(&engine, &job_id, &auth).await?;
    engine.send_no_content(reqwest::Method::DELETE, &format!("/v1/automation/jobs/{job_id}?expected_version={}",body.expected_version), None).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetJobEnabledBody { pub expected_version: u64, pub enabled: bool }

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CancelJobBody { pub expected_version: u64, pub note: String, pub confirmed: bool }

pub async fn cancel_job(
    Extension(auth): Extension<AuthInfo>, State(state): State<Arc<AppState>>, Path(job_id): Path<String>, Json(body): Json<CancelJobBody>,
) -> Result<Json<Value>, ProxyError> {
    if !body.confirmed { return Err(ProxyError::InvalidRequest("explicit job cancellation confirmation is required".into())); }
    if body.note.trim().chars().count() < 8 || body.note.trim().chars().count() > 1000 {
        return Err(ProxyError::InvalidRequest("cancellation note must contain 8 to 1000 characters".into()));
    }
    let engine = EngineClient::from_config(&state.config)?;
    assert_owned(&engine, &job_id, &auth).await?;
    let result = engine.post(&format!("/v1/automation/jobs/{job_id}/cancel"), &serde_json::json!({
        "expectedVersion": body.expected_version,
        "actor": auth.account_id,
        "note": body.note.trim(),
        "confirmed": true,
    })).await?;
    Ok(Json(result))
}

/// Pause or resume a job only after confirming it belongs to this account and
/// authenticated agent. The engine rechecks its internal service secret.
pub async fn set_job_enabled(
    Extension(auth): Extension<AuthInfo>,
    State(state): State<Arc<AppState>>,
    Path(job_id): Path<String>,
    Json(body): Json<SetJobEnabledBody>,
) -> Result<Json<Value>, ProxyError> {
    let engine = EngineClient::from_config(&state.config)?;
    assert_owned(&engine, &job_id, &auth).await?;
    let result = engine.post(&format!("/v1/automation/jobs/{job_id}"), &serde_json::json!({"expected_version":body.expected_version,"enabled":body.enabled})).await?;
    Ok(Json(result))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenameJobBody { pub expected_version: u64, pub name: String }

pub async fn rename_job(
    Extension(auth): Extension<AuthInfo>,
    State(state): State<Arc<AppState>>,
    Path(job_id): Path<String>,
    Json(body): Json<RenameJobBody>,
) -> Result<Json<Value>, ProxyError> {
    let engine = EngineClient::from_config(&state.config)?;
    assert_owned(&engine, &job_id, &auth).await?;
    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > 200 {
        return Err(ProxyError::InvalidRequest("job name must contain 1 to 200 characters".into()));
    }
    Ok(Json(engine.patch(&format!("/v1/automation/jobs/{job_id}"), &serde_json::json!({"expected_version":body.expected_version,"name":name})).await?))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JobVersionBody { pub expected_version: u64 }

pub async fn archive_job(
    Extension(auth): Extension<AuthInfo>, State(state): State<Arc<AppState>>, Path(job_id): Path<String>, Json(body): Json<JobVersionBody>,
) -> Result<Json<Value>, ProxyError> {
    set_job_archived(auth, state, job_id, body.expected_version, true).await
}

pub async fn restore_job(
    Extension(auth): Extension<AuthInfo>, State(state): State<Arc<AppState>>, Path(job_id): Path<String>, Json(body): Json<JobVersionBody>,
) -> Result<Json<Value>, ProxyError> {
    set_job_archived(auth, state, job_id, body.expected_version, false).await
}

async fn set_job_archived(auth: AuthInfo, state: Arc<AppState>, job_id: String, expected_version: u64, archived: bool) -> Result<Json<Value>, ProxyError> {
    let engine = EngineClient::from_config(&state.config)?;
    assert_owned(&engine, &job_id, &auth).await?;
    let action = if archived { "archive" } else { "restore" };
    Ok(Json(engine.post(&format!("/v1/automation/jobs/{job_id}/{action}"), &serde_json::json!({"expected_version":expected_version})).await?))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateJobConfigurationBody {
    pub expected_version: u64,
    pub trigger_set: Value,
    pub action: Value,
}

/// Replace an owned job's trigger/action configuration after rechecking the same
/// live delegate, action, event-scope and trigger rules used at creation.
pub async fn update_job_configuration(
    Extension(auth): Extension<AuthInfo>,
    State(state): State<Arc<AppState>>,
    Path(job_id): Path<String>,
    Json(body): Json<UpdateJobConfigurationBody>,
) -> Result<Json<Value>, ProxyError> {
    let engine = EngineClient::from_config(&state.config)?;
    let current = assert_owned(&engine, &job_id, &auth).await?;
    if current.get("enabled").and_then(Value::as_bool) != Some(false) {
        return Err(ProxyError::Conflict("pause the automation job before changing its triggers or action".into()));
    }
    let name = current.get("name").and_then(Value::as_str)
        .ok_or_else(|| ProxyError::EngineUnavailable("automation engine returned a job with no name".into()))?.to_owned();
    let target_agent_object_id = current.get("target_agent_object_id").and_then(Value::as_str)
        .ok_or_else(|| ProxyError::EngineUnavailable("automation engine returned a job with no target agent".into()))?.to_owned();
    let target_agent_key_ref = current.get("target_agent_key_ref").and_then(Value::as_str)
        .ok_or_else(|| ProxyError::EngineUnavailable("automation engine returned a job with no delegate reference".into()))?.to_owned();
    let memory_scope = current.get("memory_scope").and_then(Value::as_str).unwrap_or("chat-app").to_owned();
    let max_mist_per_run = current.get("max_mist_per_run").and_then(Value::as_u64).unwrap_or(0);
    let retry_policy = current.get("retry_policy").cloned().unwrap_or_else(|| serde_json::json!({"max_attempts":3,"jitter_ms":1000}));
    let (engine, payload) = prepare_job_payload(&auth, &state, CreateJobBody {
        name,
        idempotency_key: None,
        trigger_set: body.trigger_set,
        target_agent_object_id,
        target_agent_key_ref,
        action: body.action,
        memory_scope: Some(memory_scope),
        max_mist_per_run: Some(max_mist_per_run),
        retry_policy: Some(retry_policy),
    }).await?;
    Ok(Json(engine.patch(&format!("/v1/automation/jobs/{job_id}/configuration"), &serde_json::json!({
        "expected_version": body.expected_version,
        "trigger_set": payload["trigger_set"],
        "action": payload["action"],
    })).await?))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SimulateJobEventBody {
    pub event_family: String,
    pub event_type: String,
    pub payload: Option<Value>,
}

/// Preview one synthetic event against an owned job. The engine never persists or dispatches it.
pub async fn simulate_job_event(
    Extension(auth): Extension<AuthInfo>,
    State(state): State<Arc<AppState>>,
    Path(job_id): Path<String>,
    Json(body): Json<SimulateJobEventBody>,
) -> Result<Json<Value>, ProxyError> {
    let engine = EngineClient::from_config(&state.config)?;
    let _job = assert_owned(&engine, &job_id, &auth).await?;
    let request = serde_json::json!({
        "event_family": body.event_family,
        "event_type": body.event_type,
        "payload": body.payload.unwrap_or_else(|| serde_json::json!({})),
    });
    Ok(Json(engine.post(&format!("/v1/automation/jobs/{job_id}/simulate-event"), &request).await?))
}

/// A webhook job carries its HMAC secret in `action.config`. The owner supplied it, so there is
/// no reason to ever send it back to a browser.
fn redact_job_secrets(job: &mut Value) {
    let Some(config) = job.pointer_mut("/action/config").and_then(Value::as_object_mut) else {
        return;
    };
    if config.remove("secret").is_some() {
        config.insert("secret_set".into(), Value::Bool(true));
    }
}

#[derive(Debug, Deserialize)]
pub struct ListRunsQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunNowBody {
    pub request_id: String,
}

/// Queue one deduplicated, owner-authorized execution of an enabled job.
pub async fn run_job_now(
    Extension(auth): Extension<AuthInfo>,
    State(state): State<Arc<AppState>>,
    Path(job_id): Path<String>,
    Json(body): Json<RunNowBody>,
) -> Result<Json<Value>, ProxyError> {
    let engine = EngineClient::from_config(&state.config)?;
    assert_owned(&engine, &job_id, &auth).await?;
    let request_id = uuid::Uuid::parse_str(body.request_id.trim())
        .map_err(|_| ProxyError::InvalidRequest("requestId must be a UUID".into()))?;
    let job = engine.get(&format!("/v1/automation/jobs/{job_id}")).await?;
    if job.get("enabled").and_then(Value::as_bool) != Some(true)
        || job.get("archived").and_then(Value::as_bool) == Some(true)
    {
        return Err(ProxyError::Conflict("job must be enabled and unarchived before run-now".into()));
    }
    Ok(Json(engine.post(
        &format!("/v1/automation/jobs/{job_id}/run-now"),
        &serde_json::json!({"requestId": request_id.to_string()}),
    ).await?))
}

/// `GET /api/automation/jobs/:id/runs` — run history for a job the caller owns.
pub async fn list_runs(
    Extension(auth): Extension<AuthInfo>,
    State(state): State<Arc<AppState>>,
    Path(job_id): Path<String>,
    Query(query): Query<ListRunsQuery>,
) -> Result<Json<Value>, ProxyError> {
    let engine = EngineClient::from_config(&state.config)?;
    // Ownership first: run history names failures and costs, so it is not
    // something an unrelated tenant should be able to read.
    assert_owned(&engine, &job_id, &auth).await?;
    let limit = query.limit.unwrap_or(20).clamp(1, 200);
    let offset=query.offset.unwrap_or(0).clamp(0,100_000);
    Ok(Json(
        engine
            .get(&format!("/v1/automation/jobs/{job_id}/runs?limit={limit}&offset={offset}"))
            .await?,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveOrphanRunBody {
    pub resolution: String,
    pub note: String,
    pub confirmed: bool,
}

/// Owner-directed resolution for a stale run with no linked event delivery.
/// The action only closes the row; it never replays the original work.
pub async fn resolve_orphan_run(
    Extension(auth): Extension<AuthInfo>,
    State(state): State<Arc<AppState>>,
    Path((job_id, run_id)): Path<(String, String)>,
    Json(body): Json<ResolveOrphanRunBody>,
) -> Result<Json<Value>, ProxyError> {
    let engine = EngineClient::from_config(&state.config)?;
    let job_id = Uuid::parse_str(&job_id).map_err(|_| ProxyError::InvalidRequest("job id must be a UUID".into()))?.to_string();
    let run_id = Uuid::parse_str(&run_id).map_err(|_| ProxyError::InvalidRequest("run id must be a UUID".into()))?.to_string();
    assert_owned(&engine, &job_id, &auth).await?;
    if !body.confirmed || !matches!(body.resolution.as_str(), "confirmed_succeeded" | "closed_uncertain_no_replay") {
        return Err(ProxyError::InvalidRequest("confirm success or close the uncertain run without replay".into()));
    }
    if body.note.trim().chars().count() < 8 || body.note.chars().count() > 1000 {
        return Err(ProxyError::InvalidRequest("provide an 8-1000 character reconciliation note".into()));
    }
    let request = serde_json::json!({
        "resolution": body.resolution,
        "actor": auth.account_id,
        "note": body.note.trim(),
        "confirmed": body.confirmed,
    });
    Ok(Json(engine.post(
        &format!("/v1/automation/jobs/{job_id}/runs/{run_id}/reconcile"),
        &request,
    ).await?))
}

/// Delivery/reconciliation metadata, scoped by the same job-ownership check as run history.
pub async fn list_event_deliveries(
    Extension(auth): Extension<AuthInfo>, State(state): State<Arc<AppState>>, Path(job_id): Path<String>, Query(query): Query<ListRunsQuery>,
) -> Result<Json<Value>, ProxyError> {
    let engine = EngineClient::from_config(&state.config)?;
    assert_owned(&engine, &job_id, &auth).await?;
    let limit = query.limit.unwrap_or(20).clamp(1, 200);
    let offset=query.offset.unwrap_or(0).clamp(0,100_000);
    Ok(Json(engine.get(&format!("/v1/automation/jobs/{job_id}/deliveries?limit={limit}&offset={offset}")).await?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ResolveEventDeliveryBody {
    pub job_id: String,
    pub resolution: String,
    pub note: String,
    pub confirmed: bool,
}

/// Reconcile only a delivery belonging to a job owned by this authenticated
/// principal. The actor is supplied by the auth layer, never by the MCP caller.
pub async fn resolve_event_delivery(
    Extension(auth): Extension<AuthInfo>,
    State(state): State<Arc<AppState>>,
    Path(delivery_id): Path<String>,
    Json(body): Json<ResolveEventDeliveryBody>,
) -> Result<Json<Value>, ProxyError> {
    let engine = EngineClient::from_config(&state.config)?;
    assert_owned(&engine, &body.job_id, &auth).await?;
    if !body.confirmed || !matches!(body.resolution.as_str(), "confirmed_succeeded" | "confirmed_not_executed_retry") {
        return Err(ProxyError::InvalidRequest("confirm either that the action succeeded or that it never executed".into()));
    }
    if body.note.trim().chars().count() < 8 || body.note.chars().count() > 1000 {
        return Err(ProxyError::InvalidRequest("provide an 8-1000 character reconciliation note".into()));
    }
    let request = serde_json::json!({
        "job_id": body.job_id,
        "resolution": body.resolution,
        "actor": auth.account_id,
        "note": body.note.trim(),
        "confirmed": body.confirmed,
    });
    Ok(Json(engine.post(&format!("/v1/automation/deliveries/{delivery_id}/reconcile"), &request).await?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelEventDeliveryBody {
    pub job_id: String,
    pub note: String,
    pub confirmed: bool,
}

/// Cancel a pending delivery after rechecking the authenticated account/agent owns its job.
pub async fn cancel_event_delivery(
    Extension(auth): Extension<AuthInfo>,
    State(state): State<Arc<AppState>>,
    Path(delivery_id): Path<String>,
    Json(body): Json<CancelEventDeliveryBody>,
) -> Result<Json<Value>, ProxyError> {
    let engine = EngineClient::from_config(&state.config)?;
    assert_owned(&engine, &body.job_id, &auth).await?;
    if !body.confirmed || body.note.trim().chars().count() < 8 || body.note.chars().count() > 1000 {
        return Err(ProxyError::InvalidRequest("confirm cancellation and provide an 8-1000 character audit note".into()));
    }
    Ok(Json(engine.post(
        &format!("/v1/automation/deliveries/{delivery_id}/cancel"),
        &serde_json::json!({"jobId":body.job_id,"actor":auth.account_id,"note":body.note.trim(),"confirmed":true}),
    ).await?))
}

/// `POST /api/automation/jobs` — create a job owned by the caller.
#[derive(Debug, Deserialize)]
pub struct CreateJobBody {
    #[serde(default)]
    pub idempotency_key: Option<String>,
    pub name: String,
    pub trigger_set: Value,
    pub target_agent_object_id: String,
    pub target_agent_key_ref: String,
    pub action: Value,
    pub memory_scope: Option<String>,
    pub max_mist_per_run: Option<u64>,
    pub retry_policy: Option<Value>,
}

pub async fn create_job(
    Extension(auth): Extension<AuthInfo>,
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateJobBody>,
) -> Result<Json<Value>, ProxyError> {
    let (engine, payload) = prepare_job_payload(&auth, &state, body).await?;
    Ok(Json(engine.post("/v1/automation/jobs", &payload).await?))
}

/// Validate a proposed job with the same authenticated delegate and engine checks as creation,
/// without persisting a job or dispatching an event.
pub async fn validate_job(
    Extension(auth): Extension<AuthInfo>,
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateJobBody>,
) -> Result<Json<Value>, ProxyError> {
    let (engine, payload) = prepare_job_payload(&auth, &state, body).await?;
    Ok(Json(engine.post("/v1/automation/jobs/validate", &payload).await?))
}

async fn prepare_job_payload<'a>(
    auth: &AuthInfo,
    state: &'a Arc<AppState>,
    body: CreateJobBody,
) -> Result<(EngineClient<'a>, Value), ProxyError> {
    let engine = EngineClient::from_config(&state.config)?;
    if body.name.trim().is_empty() {
        return Err(ProxyError::InvalidRequest("name is required".into()));
    }
    let organization_id = auth.organization_id.clone().ok_or_else(|| {
        ProxyError::InvalidRequest(
            "this agent is not bound to an organization, so it cannot own a job".into(),
        )
    })?;
    ensure_target_is_caller(&body.target_agent_object_id, &auth.agent_object_id)?;
    let work_run_action = body.action.get("kind").and_then(Value::as_str) == Some("work_run");
    if is_chain_action(&body.action) && body.max_mist_per_run.unwrap_or(0) > 0 {
        return Err(ProxyError::InvalidRequest(
            "max_mist_per_run applies only to AI-credit memory actions; chain actions use the live on-chain delegate spend limit".into(),
        ));
    }
    let mut trigger_set = body.trigger_set;
    if let Some(key)=body.idempotency_key.as_deref(){
        Uuid::parse_str(key).map_err(|_|ProxyError::InvalidRequest("idempotency_key must be a UUID".into()))?;
    }
    let delegate = if body.target_agent_key_ref == OPERATOR_KEY_REF {
        if !is_chain_action(&body.action) { return Err(ProxyError::InvalidRequest("operator keys cannot perform memory actions".into())); }
        operator_signer(&auth.account_id, state.config.jury_crank_operator_id.as_deref())?
    } else {
        let delegate = find_delegate(&engine, &auth.account_id, &body.target_agent_key_ref).await?;
        if work_run_action {
            if delegate.class != "action_worker" {
                return Err(ProxyError::InvalidRequest("durable harness runs require an action_worker delegate".into()));
            }
            let delegate_ref = body.target_agent_key_ref.strip_prefix("delegate:").ok_or_else(|| ProxyError::InvalidRequest("work_run jobs require a delegate:<name> key ref".into()))?;
            let live_worker = verify_action_worker_for_run(state, auth, delegate_ref).await?;
            if canonical_object_id(&live_worker) != canonical_object_id(&delegate.agent_object_id) {
                return Err(ProxyError::InvalidRequest("the stored action_worker does not match its live chain identity".into()));
            }
        } else {
            ensure_target_is_caller(&canonical_object_id(&delegate.agent_object_id), &canonical_object_id(&auth.agent_object_id))?;
        }
        delegate
    };
    if let Some(override_key) = body.action.pointer("/config/key_ref").and_then(Value::as_str) {
        if override_key != body.target_agent_key_ref { return Err(ProxyError::InvalidRequest("action key_ref must match the authenticated job delegate".into())); }
    }
    if is_chain_action(&body.action) {
        validate_chain_job(
            &body.action,
            &mut trigger_set,
            &auth.account_id,
            &delegate,
            &state.config.automation_webhook_allowed_hosts,
        )?;
    }
    // Caller/account/org identity is stamped from authenticated state, never the request body.
    let payload = serde_json::json!({
        "organization_id": organization_id,
        "account_id": auth.account_id,
        "owner_address": auth.owner,
        "name": body.name,
        "trigger_set": trigger_set,
        "target_agent_object_id": body.target_agent_object_id,
        "target_agent_key_ref": body.target_agent_key_ref,
        "action": body.action,
        "memory_scope": body.memory_scope.unwrap_or_else(|| "chat-app".into()),
        "max_mist_per_run": body.max_mist_per_run.unwrap_or(0),
        "retry_policy": body.retry_policy.unwrap_or_else(|| {
            serde_json::json!({ "max_attempts": 3, "jitter_ms": 1000 })
        }),
        "idempotency_key": body.idempotency_key,
    });
    Ok((engine, payload))
}

/// A job spends the target agent's AI credit and signs as it, so a caller may
/// only schedule work for the agent whose signature authenticated the request.
fn ensure_target_is_caller(target: &str, caller: &str) -> Result<(), ProxyError> {
    if target.trim().eq_ignore_ascii_case(caller.trim()) {
        Ok(())
    } else {
        Err(ProxyError::InvalidRequest(
            "target_agent_object_id must be the authenticated agent".into(),
        ))
    }
}

// ---------------------------------------------------------------------------
// Encrypted automation delegates
// ---------------------------------------------------------------------------
//
// A delegate is a memory-only, expiring, spend-capped sub-agent the owner
// registered on-chain for unattended jobs. Its seed is encrypted in the browser to
// the memory bridge's public key, so this service only ever relays ciphertext.
// It cannot open it, and none of these routes ever returns it.
//
// Rows are not authority: the bridge verifies the sub-agent on-chain before
// every signature. What the account stamp below prevents is one account
// filling, reading or deleting another account's rows.

/// Mirrors the engine's `valid_delegate_ref`; checked here so a bad name is a
/// 400 from the relayer rather than an opaque pass-through.
fn valid_delegate_ref(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

pub(crate) fn valid_delegate_ref_for_work(value: &str) -> bool {
    valid_delegate_ref(value)
}

#[derive(Debug, Deserialize)]
pub struct PutDelegateBody {
    /// The on-chain `SubAgent` object this key signs as.
    pub agent_object_id: String,
    /// Which bridge MyData key the envelope was encrypted to.
    pub mydata_key_id: String,
    /// The encrypted envelope (base64url). Opaque to this service.
    pub encrypted_key: String,
    /// `memory` (default), `task_worker`, `juror` or `action_worker`.
    pub delegate_class: Option<String>,
    /// The actions a chain-acting delegate may run. Must be empty or absent for `memory`.
    pub allowed_action_ids: Option<Vec<String>>,
}

fn canonical_id(value: &str) -> String {
    format!("0x{:0>64}", value.trim().trim_start_matches("0x").to_ascii_lowercase())
}

/// A parent agent may store a freshly registered child's ciphertext, but only
/// when the live chain objects prove that exact parent-child relationship and
/// the child has the narrow policy supported by the automation bridge. This
/// keeps the browser's parent signer local without requiring an owner-co-signed
/// MCP session or accepting arbitrary sibling/descendant envelopes.
async fn authorize_delegate_storage(
    auth: &AuthInfo,
    state: &AppState,
    child_id: &str,
    delegate_class: &str,
    allowed_action_ids: &[String],
) -> Result<(), ProxyError> {
    if auth.owner_co_signed || canonical_id(child_id) == canonical_id(&auth.agent_object_id) {
        return Ok(());
    }
    let package = &state.config.package_id;
    let rpc = &state.config.myso_rpc_url;
    let parent = crate::myso::canonical_agent_by_object_id(
        &state.http_client,
        rpc,
        package,
        &auth.agent_object_id,
    )
    .await
    .map_err(|_| ProxyError::NotFound)?;
    let child = crate::myso::canonical_agent_by_object_id(
        &state.http_client,
        rpc,
        package,
        child_id,
    )
    .await
    .map_err(|_| ProxyError::NotFound)?;
    let child_capabilities = u64::try_from(child.capabilities).map_err(|_| ProxyError::NotFound)?;
    let parent_capabilities = u64::try_from(parent.capabilities).map_err(|_| ProxyError::NotFound)?;
    let parent_delegatable = u64::try_from(parent.delegatable_caps).map_err(|_| ProxyError::NotFound)?;
    let (required_capabilities, expected_actions): (u64, &[&str]) = match delegate_class {
        "memory" => (0b111, &[]),
        "task_worker" => (0b111 | (1 << 17), TASK_ACTION_IDS),
        "juror" => (0b111 | (1 << 18), JUROR_ACTION_IDS),
        "action_worker" => (child_capabilities, ACTION_WORKER_ACTION_IDS),
        _ => return Err(ProxyError::InvalidRequest("unknown delegate_class".into())),
    };
    let action_worker_policy_valid = delegate_class != "action_worker"
        || (child_capabilities & 0b111 == 0b111
            && child_capabilities & !ACTION_WORKER_CAPABILITY_MASK == 0
            && !allowed_action_ids.is_empty()
            && allowed_action_ids.len() <= 16
            && allowed_action_ids.iter().all(|action| expected_actions.contains(&action.as_str())));
    if canonical_id(&parent.account_id) != canonical_id(&auth.account_id)
        || canonical_id(&parent.agent_object_id) != canonical_id(&auth.agent_object_id)
        || canonical_id(&parent.derived_address) != canonical_id(&auth.derived_address)
        || canonical_id(&child.account_id) != canonical_id(&auth.account_id)
        || canonical_id(&child.parent_object_id.clone().unwrap_or_default())
            != canonical_id(&auth.agent_object_id)
        || canonical_id(&child.organization_id.clone().unwrap_or_default())
            != canonical_id(&parent.organization_id.clone().unwrap_or_default())
        || canonical_id(&child.registered_by) != canonical_id(&parent.derived_address)
        || !parent.active
        || !child.active
        || parent.expires_at_ms.is_some_and(|expiry| expiry <= chrono::Utc::now().timestamp_millis())
        || child.expires_at_ms.is_none_or(|expiry| expiry <= chrono::Utc::now().timestamp_millis())
        || parent_capabilities & (1 << 13) == 0
        || parent_delegatable & required_capabilities != required_capabilities
        || (delegate_class != "action_worker" && child_capabilities != required_capabilities)
        || !action_worker_policy_valid
        || child.identity_class != 1
        || child.register_scope != 3
        || child.delegatable_caps != 0
        || child.approval_required_caps != 0
        || child.max_action_spend.is_none() && delegate_class != "juror"
        || delegate_class == "juror" && child.max_action_spend != Some(0)
        || parent.max_action_spend.is_some_and(|limit| child.max_action_spend.is_none_or(|spend| spend > limit))
        || parent.expires_at_ms.is_some_and(|limit| child.expires_at_ms.is_none_or(|expiry| expiry > limit))
        || parent.platform_scope.as_deref() != child.platform_scope.as_deref()
        || (delegate_class != "action_worker" && allowed_action_ids.len() != expected_actions.len())
        || allowed_action_ids.iter().any(|action| !expected_actions.contains(&action.as_str()))
    {
        return Err(ProxyError::NotFound);
    }
    Ok(())
}

/// Resolve and revalidate the encrypted action-worker record before minting a
/// run credential. The parent identity, delegate class, action allowlist,
/// ancestry, live chain state, expiry, delegated capabilities and spend ceiling
/// all come from the engine metadata plus fullnode state, never from the app's
/// request body.
pub(crate) async fn verify_action_worker_for_run(
    state: &AppState,
    auth: &AuthInfo,
    delegate_ref: &str,
) -> Result<String, ProxyError> {
    if !valid_delegate_ref(delegate_ref) {
        return Err(ProxyError::InvalidRequest("invalid delegate reference".into()));
    }
    let engine = EngineClient::from_config(&state.config)?;
    let delegate = find_delegate(&engine, &auth.account_id, &format!("delegate:{delegate_ref}")).await?;
    if delegate.class != "action_worker"
        || delegate.allowed_action_ids.is_empty()
        || delegate.allowed_action_ids.len() > 16
        || delegate.allowed_action_ids.iter().any(|action| !class_may_run("action_worker", action))
        || canonical_object_id(&delegate.agent_object_id) == canonical_object_id(&auth.agent_object_id)
    {
        return Err(ProxyError::NotFound);
    }
    let mut parent_auth = auth.clone();
    // Owner-co-signed calls still must select a child of this run's parent
    // agent; an account-wide signature cannot widen the run's execution scope.
    parent_auth.owner_co_signed = false;
    authorize_delegate_storage(
        &parent_auth,
        state,
        &delegate.agent_object_id,
        "action_worker",
        &delegate.allowed_action_ids,
    ).await?;
    Ok(canonical_object_id(&delegate.agent_object_id))
}

const TASK_ACTION_IDS: &[&str] = &[
    "task.create.v1", "task.accept.v1", "task.decline.v1", "task.cancel_offer.v1",
    "task.deliver.v1", "task.settle.v1", "task.refund.v1", "task.release.v1",
    "task.expire_offer.v1", "task.propose_refund.v1", "task.accept_refund.v1",
    "task.reject_refund.v1", "task.withdraw_refund.v1", "task.review.v1",
];

/// `PUT /api/automation/delegates/:ref` — store a encrypted delegate key.
pub async fn put_delegate(
    Extension(auth): Extension<AuthInfo>,
    State(state): State<Arc<AppState>>,
    Path(delegate_ref): Path<String>,
    Json(body): Json<PutDelegateBody>,
) -> Result<StatusCode, ProxyError> {
    let engine = EngineClient::from_config(&state.config)?;
    if !valid_delegate_ref(&delegate_ref) {
        return Err(ProxyError::InvalidRequest(
            "delegate name must be 1-64 characters of letters, digits, '.', '_' or '-'".into(),
        ));
    }
    let delegate_class = body.delegate_class.clone().unwrap_or_else(|| "memory".into());
    let allowed_action_ids = body.allowed_action_ids.clone().unwrap_or_default();
    validate_delegate_class(&delegate_class, &allowed_action_ids)?;
    authorize_delegate_storage(&auth, &state, &body.agent_object_id, &delegate_class, &allowed_action_ids).await?;
    if !auth.owner_co_signed {
        let path = format!("/v1/automation/delegates/summary?account_id={}&delegate_ref={}",urlencode(&auth.account_id),urlencode(&delegate_ref));
        match engine.get(&path).await {
            Ok(prior) if !prior.get("agent_object_id").and_then(Value::as_str).is_some_and(|agent|canonical_object_id(agent)==canonical_object_id(&body.agent_object_id)) => return Err(ProxyError::NotFound),
            Ok(_) | Err(ProxyError::NotFound) => {},
            Err(error) => return Err(error),
        }
    }
    // `account_id` comes from the verified signature, never the body.
    let payload = serde_json::json!({
        "account_id": auth.account_id,
        "delegate_ref": delegate_ref,
        "agent_object_id": canonical_object_id(&body.agent_object_id),
        "mydata_key_id": body.mydata_key_id,
        "encrypted_key": body.encrypted_key,
        "delegate_class": delegate_class,
        "allowed_action_ids": allowed_action_ids,
    });
    engine
        .send_no_content(reqwest::Method::PUT, "/v1/automation/delegates", Some(&payload))
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// A juror's own steps. Must match the engine's and the bridge's lists.
const JUROR_ACTION_IDS: &[&str] = &[
    "jury.accept.v1",
    "jury.commit_vote.v1",
    "jury.reveal_vote.v1",
    "jury.claim_fee.v1",
];

/// The permissionless jury cranks. Must match `CRANK_ACTION_IDS` in the bridge.
const CRANK_ACTION_IDS: &[&str] = &[
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
    "jury.sweep_vote_refunds.v1",
    "jury.refresh_roster_entry.v1",
    "jury.evict_ineligible.v1",
];

/// The key ref of the bridge's crank signer. Only the configured crank operator's jobs may use it.
const OPERATOR_KEY_REF: &str = "operator:jury";

/// Not a delegate class anyone can register: the stand-in for jobs that sign with the operator key.
const OPERATOR_CLASS: &str = "jury_operator";

/// The event family a chain-acting class's jobs may subscribe to.
fn class_event_family(class: &str) -> Option<&'static str> {
    match class {
        "task_worker" | "action_worker" => Some("task"),
        "juror" | OPERATOR_CLASS => Some("jury"),
        _ => None,
    }
}

/// Whether a delegate of `class` may be allowed to run `id`.
fn class_may_run(class: &str, id: &str) -> bool {
    match class {
        "task_worker" => is_action_id_in(id, "task"),
        "juror" => is_action_id_in(id, "jury") && JUROR_ACTION_IDS.contains(&id),
        "action_worker" => ACTION_WORKER_ACTION_IDS.contains(&id),
        OPERATOR_CLASS => is_action_id_in(id, "jury") && CRANK_ACTION_IDS.contains(&id),
        _ => false,
    }
}

/// Must match the automation engine's ACTION_WORKER_ACTION_IDS and the
/// production actions selected by CHAIN_CLASS_ACTIONS.action_worker in the
/// sidecar. This is a storage allowlist; the bridge still checks live
/// capabilities and the per-action MYSO cap before execution.
const ACTION_WORKER_ACTION_IDS: &[&str] = &[
    "access.publish_mydata_graph.v1", "access.purchase_mydata_access.v1",
    "access.purchase_post_access.v1", "task.create.v1", "spt.buy.v1",
    "social.react_to_post.v1",
    "social.remove_post_reaction.v1", "social.react_to_comment.v1",
    "social.remove_comment_reaction.v1", "social.create_post.v1",
    "social.edit_post.v1", "social.create_comment.v1", "social.edit_comment.v1",
    "social.create_repost.v1", "social.remove_repost.v1", "social.follow_profile.v1",
    "social.unfollow_profile.v1", "social.block_profile.v1", "social.unblock_profile.v1",
    "messaging.send_message.v1", "messaging.create_group.v1",
    "messaging.bind_room_to_task.v1", "organization.accept_invitation.v1",
    "organization.decline_invitation.v1", "agent.register_child.v1",
    "agent.update_child.v1", "agent.deactivate_child.v1", "agent.revoke_child.v1",
];

const ACTION_WORKER_CAPABILITY_MASK: u64 = 0b111
    | (1 << 8)  // trade execute
    | (1 << 4)  // post publish
    | (1 << 9)  // comment
    | (1 << 10) // react
    | (1 << 5)  // message read
    | (1 << 6)  // message send
    | (1 << 11) // agent revoke
    | (1 << 12) // agent update
    | (1 << 13) // agent register
    | (1 << 15) // budget manage
    | (1 << 16) // social graph
    | (1 << 17); // task trade

/// Mirrors the engine's rule: a memory delegate runs no chain actions; every other class runs only
/// its own. The engine and the bridge check it again.
fn validate_delegate_class(class: &str, allowed_action_ids: &[String]) -> Result<(), ProxyError> {
    let invalid = |message: &str| Err(ProxyError::InvalidRequest(message.to_string()));
    match class {
        "memory" if allowed_action_ids.is_empty() => Ok(()),
        "memory" => invalid(
            "a memory delegate cannot run chain actions; use task_worker, juror or action_worker",
        ),
        "task_worker" | "juror" | "action_worker" => {
            if allowed_action_ids.is_empty() || allowed_action_ids.len() > 16 {
                return invalid("a chain-acting delegate needs 1 to 16 allowed_action_ids");
            }
            if allowed_action_ids.iter().any(|id| !class_may_run(class, id)) {
                return invalid("allowed_action_ids includes an action this delegate class may not run");
            }
            Ok(())
        }
        _ => invalid("unknown delegate_class"),
    }
}

/// `<namespace>.<name>.v<digits>` with lowercase letters and underscores in the name.
fn is_action_id_in(id: &str, expected_namespace: &str) -> bool {
    let parts: Vec<&str> = id.split('.').collect();
    let [namespace, name, version] = parts.as_slice() else {
        return false;
    };
    *namespace == expected_namespace
        && !name.is_empty()
        && name.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
        && version.len() > 1
        && version.starts_with('v')
        && version[1..].bytes().all(|b| b.is_ascii_digit())
}

/// What the proxy needs to know about a stored delegate to authorize a job against it.
#[derive(Debug, Clone, PartialEq)]
struct DelegateInfo {
    agent_object_id: String,
    class: String,
    allowed_action_ids: Vec<String>,
}

/// A crank job signs with the bridge's operator key, so only the configured operator may schedule
/// one, and it may run the cranks and nothing else.
fn operator_signer(account_id: &str, operator_id: Option<&str>) -> Result<DelegateInfo, ProxyError> {
    let is_operator = operator_id
        .is_some_and(|operator| canonical_object_id(operator) == canonical_object_id(account_id));
    if !is_operator {
        return Err(ProxyError::InvalidRequest(
            "only the jury crank operator may use the operator:jury key".into(),
        ));
    }
    Ok(DelegateInfo {
        agent_object_id: String::new(),
        class: OPERATOR_CLASS.into(),
        allowed_action_ids: CRANK_ACTION_IDS.iter().map(|id| (*id).to_string()).collect(),
    })
}

fn is_chain_action(action: &Value) -> bool {
    matches!(
        action.get("kind").and_then(Value::as_str),
        Some("registered_action" | "webhook" | "work_run")
    )
}

/// Resolve `delegate:<name>` to the caller's own stored delegate. Only that account's rows are
/// listed, so a job can never be bound to another account's delegate.
async fn find_delegate(
    engine: &EngineClient<'_>,
    account_id: &str,
    key_ref: &str,
) -> Result<DelegateInfo, ProxyError> {
    let name = key_ref.strip_prefix("delegate:").ok_or_else(|| {
        ProxyError::InvalidRequest("chain actions must use a delegate:<name> key ref".into())
    })?;
    let row = engine
        .get(&format!(
            "/v1/automation/delegates/summary?account_id={}&delegate_ref={}",
            urlencode(account_id),
            urlencode(name),
        ))
        .await
        .map_err(|error| match error {
            ProxyError::NotFound => ProxyError::InvalidRequest(format!("no delegate named `{name}` is registered")),
            other => other,
        })?;
    Ok(DelegateInfo {
        agent_object_id: row
            .get("agent_object_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        class: row
            .get("delegate_class")
            .and_then(Value::as_str)
            .unwrap_or("memory")
            .to_string(),
        allowed_action_ids: row
            .get("allowed_action_ids")
            .and_then(Value::as_array)
            .map(|ids| ids.iter().filter_map(|id| id.as_str().map(String::from)).collect())
            .unwrap_or_default(),
    })
}

/// The form the indexer writes object ids in: `0x` and 64 lowercase hex digits. The engine matches
/// a trigger's account and agent against an event by exact string, so a delegate stored as `0xAB`
/// would otherwise never fire.
fn canonical_object_id(id: &str) -> String {
    let hex = id.trim().trim_start_matches("0x").trim_start_matches("0X").to_ascii_lowercase();
    format!("0x{hex:0>64}")
}

fn host_of(url: &str) -> Option<String> {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_ascii_lowercase))
}

/// Authorize a `registered_action` / `webhook` job and bind its triggers to the delegate.
///
/// The job may only name actions the delegate was registered for, may only fire on `task` events,
/// and its triggers are stamped with the caller's account and the delegate's agent, so an owner
/// cannot subscribe to another account's events or act outside the delegate's scope.
fn validate_chain_job(
    action: &Value,
    trigger_set: &mut Value,
    account_id: &str,
    delegate: &DelegateInfo,
    webhook_allowed_hosts: &[String],
) -> Result<(), ProxyError> {
    let invalid = |message: String| Err(ProxyError::InvalidRequest(message));
    let Some(family) = class_event_family(&delegate.class) else {
        return invalid("chain actions need a task_worker or juror delegate".into());
    };
    let config = action.get("config").cloned().unwrap_or(Value::Null);
    let permitted = |id: &str| delegate.allowed_action_ids.iter().any(|allowed| allowed == id);

    match action.get("kind").and_then(Value::as_str) {
        Some("registered_action") => {
            let id = config.get("action_id").and_then(Value::as_str).unwrap_or_default();
            if !class_may_run(&delegate.class, id) || !permitted(id) {
                return invalid(format!("`{id}` is not an action this delegate may run"));
            }
        }
        Some("webhook") => {
            let ids: Vec<&str> = config
                .get("allowed_action_ids")
                .and_then(Value::as_array)
                .map(|ids| ids.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            if ids.is_empty() || ids.iter().any(|id| !class_may_run(&delegate.class, id) || !permitted(id)) {
                return invalid(
                    "webhook allowed_action_ids must be actions this delegate may run".into(),
                );
            }
            if !webhook_allowed_hosts.is_empty() {
                let host = config.get("url").and_then(Value::as_str).and_then(host_of);
                if !host.is_some_and(|host| webhook_allowed_hosts.iter().any(|allowed| *allowed == host)) {
                    return invalid("the webhook host is not on this deployment's allowlist".into());
                }
            }
        }
        Some("work_run") => {
            if delegate.class != "action_worker" {
                return invalid("work_run jobs require an action_worker delegate".into());
            }
            if config.get("runId").and_then(Value::as_str).and_then(|id| uuid::Uuid::parse_str(id).ok()).is_none()
                || config.get("turn").and_then(Value::as_object).is_none() {
                return invalid("work_run config must bind a run and bounded turn settings".into());
            }
        }
        _ => return invalid("not a chain action".into()),
    }
    if let Some(key_ref) = config.get("key_ref") {
        if !key_ref.is_null() {
            return invalid("key_ref is set by the job, not its action config".into());
        }
    }

    let triggers = trigger_set
        .get_mut("triggers")
        .and_then(Value::as_array_mut)
        .filter(|triggers| !triggers.is_empty())
        .ok_or_else(|| ProxyError::InvalidRequest("a chain action needs at least one trigger".into()))?;
    for trigger in triggers.iter_mut() {
        let is_family_event = trigger.get("kind").and_then(Value::as_str) == Some("event")
            && trigger.get("event_family").and_then(Value::as_str) == Some(family);
        if !is_family_event {
            return invalid(format!("this delegate's jobs may only use {family} event triggers"));
        }
        let Some(object) = trigger.as_object_mut() else {
            return invalid("malformed trigger".into());
        };
        object.remove("organization_id");
        object.insert("account_id".into(), Value::String(canonical_object_id(account_id)));
        if delegate.class == OPERATOR_CLASS {
            // A crank event belongs to the operator's account, not to one agent, so an agent filter
            // would never match it.
            object.remove("agent_object_id");
        } else {
            object.insert(
                "agent_object_id".into(),
                Value::String(canonical_object_id(&delegate.agent_object_id)),
            );
        }
    }
    Ok(())
}

/// `GET /api/automation/delegates` — this account's delegates. Metadata only.
#[derive(Deserialize)]
pub struct DelegateListQuery {
    pub limit: Option<i64>,
    pub cursor: Option<String>,
    pub agent_object_id: Option<String>,
}

pub async fn list_delegates(
    Extension(auth): Extension<AuthInfo>,
    State(state): State<Arc<AppState>>,
    Query(query): Query<DelegateListQuery>,
) -> Result<Json<Value>, ProxyError> {
    let engine = EngineClient::from_config(&state.config)?;
    let limit = query.limit.unwrap_or(50);
    if !(1..=200).contains(&limit) {
        return Err(ProxyError::InvalidRequest("limit must be between 1 and 200".into()));
    }
    if query.cursor.as_deref().is_some_and(|cursor| !valid_delegate_ref(cursor)) {
        return Err(ProxyError::InvalidRequest("cursor must be a valid delegate reference".into()));
    }
    let agent = if auth.owner_co_signed {
        query.agent_object_id.as_deref()
    } else {
        Some(auth.agent_object_id.as_str())
    };
    if agent.is_some_and(|id| !valid_myso_object_id(id)) {
        return Err(ProxyError::InvalidRequest("agent_object_id must be a MySo object ID".into()));
    }
    let mut path = format!("/v1/automation/delegates?account_id={}&limit={limit}", urlencode(&auth.account_id));
    if let Some(cursor) = query.cursor.as_deref() { path.push_str(&format!("&cursor={}", urlencode(cursor))); }
    if let Some(agent) = agent { path.push_str(&format!("&expected_agent_object_id={}", urlencode(agent))); }
    Ok(Json(engine.get(&path).await?))
}

#[derive(Deserialize)]
pub struct DelegateKeyEventListQuery {
    pub limit: Option<i64>,
    pub cursor: Option<String>,
    pub agent_object_id: Option<String>,
}

/// `GET /api/automation/delegates/events` — append-only metadata history for this account.
/// This is key-envelope storage history, not proof of on-chain registration or revocation.
pub async fn list_delegate_key_events(
    Extension(auth): Extension<AuthInfo>,
    State(state): State<Arc<AppState>>,
    Query(query): Query<DelegateKeyEventListQuery>,
) -> Result<Json<Value>, ProxyError> {
    let engine=EngineClient::from_config(&state.config)?;
    let limit=query.limit.unwrap_or(50);
    if !(1..=200).contains(&limit) { return Err(ProxyError::InvalidRequest("limit must be between 1 and 200".into())); }
    if query.cursor.as_deref().is_some_and(|value| value.parse::<i64>().ok().filter(|id|*id>0).is_none()) { return Err(ProxyError::InvalidRequest("cursor must be a positive event ID".into())); }
    let agent=if auth.owner_co_signed { query.agent_object_id.as_deref() } else { Some(auth.agent_object_id.as_str()) };
    if agent.is_some_and(|id|!valid_myso_object_id(id)) { return Err(ProxyError::InvalidRequest("agent_object_id must be a MySo object ID".into())); }
    let mut path=format!("/v1/automation/delegates/events?account_id={}&limit={limit}",urlencode(&auth.account_id));
    if let Some(cursor)=query.cursor.as_deref(){path.push_str(&format!("&cursor={}",urlencode(cursor)));}
    if let Some(agent)=agent{path.push_str(&format!("&expected_agent_object_id={}",urlencode(agent)));}
    Ok(Json(engine.get(&path).await?))
}

fn valid_myso_object_id(value: &str) -> bool {
    let raw = value.strip_prefix("0x").or_else(|| value.strip_prefix("0X")).unwrap_or(value);
    !raw.is_empty() && raw.len() <= 64 && raw.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// `GET /api/automation/delegates/:ref/status` — live chain authority and expiry.
///
/// The bridge opens the caller's encrypted delegate envelope and inspects the
/// current on-chain SubAgent. The MCP/browser never receives the signing key.
pub async fn get_delegate_status(
    Extension(auth): Extension<AuthInfo>,
    State(state): State<Arc<AppState>>,
    Path(delegate_ref): Path<String>,
) -> Result<Json<Value>, ProxyError> {
    if !valid_delegate_ref(&delegate_ref) {
        return Err(ProxyError::InvalidRequest("invalid delegate name".into()));
    }
    let engine = EngineClient::from_config(&state.config)?;
    let delegate = find_delegate(
        &engine,
        &auth.account_id,
        &format!("delegate:{delegate_ref}"),
    )
    .await?;
    if !auth.owner_co_signed
        && canonical_object_id(&delegate.agent_object_id)
            != canonical_object_id(&auth.agent_object_id)
    {
        return Err(ProxyError::NotFound);
    }

    let secret = state
        .config
        .internal_sync_secret
        .as_deref()
        .ok_or(ProxyError::NotConfigured)?;
    let url = format!(
        "{}/internal/chain/delegate-status",
        state.config.sidecar_url.trim_end_matches('/')
    );
    let response = state
        .http_client
        .post(url)
        .header("x-internal-sync-secret", secret)
        .json(&serde_json::json!({
            "key_ref": format!("delegate:{delegate_ref}"),
            "account_id": auth.account_id,
        }))
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| ProxyError::EngineUnavailable(format!("automation bridge unreachable: {e}")))?;
    let status = response.status();
    if status == StatusCode::NOT_FOUND {
        return Err(ProxyError::NotFound);
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| ProxyError::EngineUnavailable(format!("reading bridge response failed: {e}")))?;
    if bytes.len() > 16 * 1024 {
        return Err(ProxyError::EngineUnavailable(
            "automation bridge status response exceeded the proxy cap".into(),
        ));
    }
    if !status.is_success() {
        return Err(if status.is_client_error() {
            ProxyError::InvalidRequest("automation bridge could not inspect this delegate".into())
        } else {
            ProxyError::EngineUnavailable(format!("automation bridge returned {status}"))
        });
    }
    let result: Value = serde_json::from_slice(&bytes).map_err(|_| {
        ProxyError::EngineUnavailable("automation bridge returned invalid delegate status".into())
    })?;
    let valid_status = matches!(result.get("status").and_then(Value::as_str), Some("active" | "inactive"));
    let valid_class = result.get("delegate_class").and_then(Value::as_str)
        == Some(delegate.class.as_str());
    let valid_expiry = ["expires_at_ms", "expires_in_ms"].iter().all(|field| {
        result.get(*field).is_some_and(|value| value.is_null() || value.as_i64().is_some())
    });
    if !valid_status || !valid_class || !valid_expiry {
        return Err(ProxyError::EngineUnavailable(
            "automation bridge returned inconsistent delegate status".into(),
        ));
    }
    Ok(Json(result))
}

/// Return only the bridge's configured public encryption keys so clients can
/// encrypt delegate seeds without inventing or pinning an operator URL.
pub async fn list_delegate_public_keys(
    Extension(_auth): Extension<AuthInfo>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, ProxyError> {
    let url = format!("{}/mydata-keys", state.config.sidecar_url.trim_end_matches('/'));
    let response = state.http_client.get(url).timeout(std::time::Duration::from_secs(10)).send().await
        .map_err(|e| ProxyError::EngineUnavailable(format!("automation bridge unreachable: {e}")))?;
    if !response.status().is_success() {
        return Err(ProxyError::EngineUnavailable(format!("automation bridge returned {}", response.status())));
    }
    let value: Value = response.json().await
        .map_err(|e| ProxyError::EngineUnavailable(format!("invalid automation bridge key response: {e}")))?;
    let valid = value.get("keys").and_then(Value::as_array).is_some_and(|keys| {
        keys.len() <= 32 && keys.iter().all(|key| {
            key.get("id").and_then(Value::as_str).is_some_and(|id| !id.is_empty() && id.len() <= 200)
                && key.get("publicKey").and_then(Value::as_str).is_some_and(|public_key| {
                    public_key.len() == 43 && public_key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                })
        })
    });
    if !valid {
        return Err(ProxyError::EngineUnavailable("automation bridge returned invalid public keys".into()));
    }
    Ok(Json(value))
}

/// `DELETE /api/automation/delegates/:ref` — drop the stored copy.
///
/// This removes our ciphertext, nothing more. The delegate stays valid on-chain
/// until the owner revokes it there, which is the real kill switch.
pub async fn delete_delegate(
    Extension(auth): Extension<AuthInfo>,
    State(state): State<Arc<AppState>>,
    Path(delegate_ref): Path<String>,
) -> Result<StatusCode, ProxyError> {
    let engine = EngineClient::from_config(&state.config)?;
    if !valid_delegate_ref(&delegate_ref) {
        return Err(ProxyError::InvalidRequest("invalid delegate name".into()));
    }
    if !auth.owner_co_signed {
        let delegate = find_delegate(&engine,&auth.account_id,&format!("delegate:{delegate_ref}")).await?;
        if canonical_object_id(&delegate.agent_object_id)!=canonical_object_id(&auth.agent_object_id){return Err(ProxyError::NotFound);}
    }
    let mut path = format!(
        "/v1/automation/delegates?account_id={}&delegate_ref={}",
        urlencode(&auth.account_id),
        urlencode(&delegate_ref)
    );
    if !auth.owner_co_signed { path.push_str(&format!("&expected_agent_object_id={}",urlencode(&auth.agent_object_id))); }
    engine
        .send_no_content(reqwest::Method::DELETE, &path, None)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/automation/health` — engine reachability, without leaking config.
#[derive(Debug, Serialize)]
pub struct AutomationHealth {
    pub status: String,
    pub service: String,
    pub configured: bool,
}

pub async fn health(
    State(state): State<Arc<AppState>>,
) -> Result<Json<AutomationHealth>, ProxyError> {
    let engine = EngineClient::from_config(&state.config)?;
    let body = engine.get("/health").await?;
    Ok(Json(AutomationHealth {
        status: body
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string(),
        service: body
            .get("service")
            .and_then(|v| v.as_str())
            .unwrap_or("myso-automation")
            .to_string(),
        configured: true,
    }))
}

/// Minimal percent-encoding for a query-string value.
///
/// Account ids and job ids are hex-ish in practice, but an unescaped `&` or `#`
/// would silently change the filter, so anything outside the unreserved set is
/// encoded.
fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delegate_names_are_plain_names() {
        assert!(valid_delegate_ref("nightly-digest.v2_a"));
        assert!(!valid_delegate_ref(""));
        assert!(!valid_delegate_ref("a/b"));
        assert!(!valid_delegate_ref("a&account_id=x"));
        assert!(!valid_delegate_ref(&"a".repeat(65)));
    }

    #[test]
    fn urlencode_leaves_unreserved_characters_alone() {
        assert_eq!(urlencode("0xabc-123_XY.Z~"), "0xabc-123_XY.Z~");
    }

    #[test]
    fn urlencode_escapes_query_metacharacters() {
        // An unescaped `&` would inject an extra filter parameter.
        assert_eq!(urlencode("a&account_id=b"), "a%26account_id%3Db");
        assert_eq!(urlencode("a b"), "a%20b");
        assert_eq!(urlencode("a#b"), "a%23b");
        assert_eq!(urlencode("a+b"), "a%2Bb");
    }

    #[test]
    fn target_must_be_the_authenticated_agent() {
        assert!(ensure_target_is_caller("0xAbC", "0xabc").is_ok());
        assert!(ensure_target_is_caller("0xother", "0xabc").is_err());
        assert!(ensure_target_is_caller("", "0xabc").is_err());
    }

    fn worker() -> DelegateInfo {
        DelegateInfo {
            agent_object_id: "0xagent".into(),
            class: "task_worker".into(),
            allowed_action_ids: vec!["task.accept.v1".into(), "task.deliver.v1".into()],
        }
    }

    fn task_triggers() -> Value {
        serde_json::json!({
            "match_mode": "any",
            "triggers": [{
                "kind": "event", "event_family": "task", "event_type": "offered",
                "organization_id": "0xother-org", "account_id": "0xsomeone-else",
                "agent_object_id": "0xsomeone-elses-agent",
            }],
        })
    }

    fn accept_action() -> Value {
        serde_json::json!({ "kind": "registered_action", "config": { "action_id": "task.accept.v1" } })
    }

    #[test]
    fn chain_jobs_are_bound_to_the_callers_account_and_delegate() {
        let mut triggers = task_triggers();
        validate_chain_job(&accept_action(), &mut triggers, "0xmine", &worker(), &[]).unwrap();
        let trigger = &triggers["triggers"][0];
        // The caller cannot subscribe to another account's or agent's events.
        assert_eq!(trigger["account_id"], canonical_object_id("0xmine"));
        assert_eq!(trigger["agent_object_id"], canonical_object_id("0xagent"));
        assert!(trigger.get("organization_id").is_none());
    }

    #[test]
    fn trigger_ids_use_the_form_the_indexer_writes() {
        assert_eq!(canonical_object_id("0xAB"), format!("0x{}ab", "0".repeat(62)));
        assert_eq!(canonical_object_id("ab"), canonical_object_id("0xAB"));
        let full = format!("0x{}", "1f".repeat(32));
        assert_eq!(canonical_object_id(&full.to_uppercase().replace("0X", "0x")), full);
        assert_eq!(canonical_object_id(&full).len(), 66);
    }

    #[test]
    fn chain_jobs_may_only_run_actions_the_delegate_was_registered_for() {
        let run = |action: Value| validate_chain_job(&action, &mut task_triggers(), "0xmine", &worker(), &[]);
        assert!(run(accept_action()).is_ok());
        for id in ["task.settle.v1", "social.create_post.v1", "agent.revoke_child.v1", "0x2::coin::transfer"] {
            let action = serde_json::json!({ "kind": "registered_action", "config": { "action_id": id } });
            assert!(run(action).is_err(), "{id}");
        }
    }

    #[test]
    fn chain_jobs_need_a_task_worker_delegate() {
        let mut memory_only = worker();
        memory_only.class = "memory".into();
        assert!(validate_chain_job(&accept_action(), &mut task_triggers(), "0xmine", &memory_only, &[]).is_err());
    }

    #[test]
    fn chain_jobs_only_fire_on_task_events() {
        for bad in [
            serde_json::json!({ "kind": "event", "event_family": "memory", "event_type": "created" }),
            serde_json::json!({ "kind": "interval", "event_family": "task", "event_type": "offered", "interval_ms": 1000 }),
        ] {
            let mut triggers = serde_json::json!({ "match_mode": "any", "triggers": [bad] });
            assert!(validate_chain_job(&accept_action(), &mut triggers, "0xmine", &worker(), &[]).is_err());
        }
        let mut none = serde_json::json!({ "match_mode": "any", "triggers": [] });
        assert!(validate_chain_job(&accept_action(), &mut none, "0xmine", &worker(), &[]).is_err());
    }

    #[test]
    fn webhook_jobs_are_checked_against_the_delegate_and_the_host_allowlist() {
        let webhook = |ids: Value, url: &str| {
            serde_json::json!({ "kind": "webhook", "config": { "url": url, "allowed_action_ids": ids } })
        };
        let hosts = vec!["worker.example.com".to_string()];
        let ok = webhook(serde_json::json!(["task.deliver.v1"]), "https://worker.example.com/hook");
        assert!(validate_chain_job(&ok, &mut task_triggers(), "0xmine", &worker(), &hosts).is_ok());

        let wider = webhook(serde_json::json!(["task.deliver.v1", "task.settle.v1"]), "https://worker.example.com/hook");
        assert!(validate_chain_job(&wider, &mut task_triggers(), "0xmine", &worker(), &hosts).is_err());
        let elsewhere = webhook(serde_json::json!(["task.deliver.v1"]), "https://evil.example.com/hook");
        assert!(validate_chain_job(&elsewhere, &mut task_triggers(), "0xmine", &worker(), &hosts).is_err());
        // With no deployment allowlist the engine's per-job allowed_hosts is the only host rule.
        assert!(validate_chain_job(&elsewhere, &mut task_triggers(), "0xmine", &worker(), &[]).is_ok());
        let empty = webhook(serde_json::json!([]), "https://worker.example.com/hook");
        assert!(validate_chain_job(&empty, &mut task_triggers(), "0xmine", &worker(), &[]).is_err());
    }

    #[test]
    fn an_action_config_cannot_name_a_different_key_ref() {
        let action = serde_json::json!({
            "kind": "registered_action",
            "config": { "action_id": "task.accept.v1", "key_ref": "delegate:someone-else" },
        });
        assert!(validate_chain_job(&action, &mut task_triggers(), "0xmine", &worker(), &[]).is_err());
    }

    #[test]
    fn delegate_classes_are_validated_before_they_reach_the_engine() {
        let ids = |list: &[&str]| list.iter().map(|s| (*s).to_string()).collect::<Vec<_>>();
        assert!(validate_delegate_class("memory", &[]).is_ok());
        assert!(validate_delegate_class("memory", &ids(&["task.accept.v1"])).is_err());
        assert!(validate_delegate_class("task_worker", &ids(&["task.accept.v1"])).is_ok());
        assert!(validate_delegate_class("task_worker", &[]).is_err());
        assert!(validate_delegate_class("task_worker", &ids(&["social.create_post.v1"])).is_err());
        assert!(validate_delegate_class("task_worker", &ids(&["task.accept"])).is_err());
        assert!(validate_delegate_class("admin", &[]).is_err());
    }

    fn juror() -> DelegateInfo {
        DelegateInfo {
            agent_object_id: "0xjuror".into(),
            class: "juror".into(),
            allowed_action_ids: vec!["jury.accept.v1".into(), "jury.commit_vote.v1".into()],
        }
    }

    fn operator() -> DelegateInfo {
        operator_signer("0xmine", Some("0xMINE")).unwrap()
    }

    #[test]
    fn only_the_configured_operator_may_sign_with_the_operator_key() {
        assert!(operator_signer("0xmine", None).is_err());
        assert!(operator_signer("0xmine", Some("0xsomeone-else")).is_err());
        assert_eq!(operator().allowed_action_ids.len(), CRANK_ACTION_IDS.len());
    }

    fn jury_triggers(event_type: &str) -> Value {
        serde_json::json!({
            "match_mode": "any",
            "triggers": [{
                "kind": "event", "event_family": "jury", "event_type": event_type,
                "organization_id": "0xother-org", "account_id": "0xsomeone-else",
                "agent_object_id": "0xsomeone-elses-agent",
            }],
        })
    }

    fn registered(id: &str) -> Value {
        serde_json::json!({ "kind": "registered_action", "config": { "action_id": id } })
    }

    #[test]
    fn a_jurors_jobs_are_bound_to_its_account_and_agent_on_jury_events() {
        let mut triggers = jury_triggers("duty_drafted");
        validate_chain_job(&registered("jury.accept.v1"), &mut triggers, "0xmine", &juror(), &[]).unwrap();
        let trigger = &triggers["triggers"][0];
        assert_eq!(trigger["account_id"], canonical_object_id("0xmine"));
        assert_eq!(trigger["agent_object_id"], canonical_object_id("0xjuror"));
        assert!(trigger.get("organization_id").is_none());
    }

    #[test]
    fn an_operators_jobs_are_bound_to_its_account_only() {
        let mut triggers = jury_triggers("round_finalize_due");
        validate_chain_job(&registered("jury.finalize_round.v1"), &mut triggers, "0xmine", &operator(), &[]).unwrap();
        let trigger = &triggers["triggers"][0];
        assert_eq!(trigger["account_id"], canonical_object_id("0xmine"));
        // Crank events name no agent, so the foreign agent filter must be removed, not replaced.
        assert!(trigger.get("agent_object_id").is_none());
    }

    #[test]
    fn jury_delegates_cannot_run_each_others_actions_or_task_actions() {
        let run = |id: &str, delegate: &DelegateInfo| {
            validate_chain_job(&registered(id), &mut jury_triggers("x"), "0xmine", delegate, &[])
        };
        assert!(run("jury.accept.v1", &juror()).is_ok());
        assert!(run("jury.finalize_round.v1", &juror()).is_err());
        assert!(run("jury.accept.v1", &operator()).is_err());
        assert!(run("task.settle.v1", &juror()).is_err());
        assert!(run("task.settle.v1", &operator()).is_err());
        assert!(run("jury.sweep_vote_refunds.v1", &operator()).is_ok());
        // Allowed by the class but not registered for this delegate.
        assert!(run("jury.claim_fee.v1", &juror()).is_err());
    }

    #[test]
    fn each_class_may_only_subscribe_to_its_own_event_family() {
        let on_family = |family: &str, delegate: &DelegateInfo, id: &str| {
            let mut triggers = serde_json::json!({
                "match_mode": "any",
                "triggers": [{ "kind": "event", "event_family": family, "event_type": "x" }],
            });
            validate_chain_job(&registered(id), &mut triggers, "0xmine", delegate, &[])
        };
        assert!(on_family("jury", &juror(), "jury.accept.v1").is_ok());
        assert!(on_family("task", &juror(), "jury.accept.v1").is_err());
        assert!(on_family("task", &worker(), "task.accept.v1").is_ok());
        assert!(on_family("jury", &worker(), "task.accept.v1").is_err());
        assert!(on_family("jury", &operator(), "jury.select_jury.v1").is_ok());
        assert!(on_family("memory", &operator(), "jury.select_jury.v1").is_err());
    }

    #[test]
    fn jury_classes_are_validated_before_they_reach_the_engine() {
        let ids = |list: &[&str]| list.iter().map(|s| (*s).to_string()).collect::<Vec<_>>();
        assert!(validate_delegate_class("juror", &ids(&["jury.accept.v1", "jury.reveal_vote.v1"])).is_ok());
        assert!(validate_delegate_class("juror", &ids(&["jury.select_jury.v1"])).is_err());
        // Nobody registers a crank delegate: the keeper class is gone and the operator class is internal.
        assert!(validate_delegate_class("jury_keeper", &ids(CRANK_ACTION_IDS)).is_err());
        assert!(validate_delegate_class(OPERATOR_CLASS, &ids(CRANK_ACTION_IDS)).is_err());
        assert!(validate_delegate_class("juror", &ids(&["task.accept.v1"])).is_err());
        assert!(validate_delegate_class("task_worker", &ids(&["jury.accept.v1"])).is_err());
        assert!(validate_delegate_class("juror", &[]).is_err());
        assert_eq!(JUROR_ACTION_IDS.len(), 4);
        assert_eq!(CRANK_ACTION_IDS.len(), 15);
        assert!(JUROR_ACTION_IDS.iter().all(|id| !CRANK_ACTION_IDS.contains(id)));
    }

    #[test]
    fn the_webhook_secret_is_never_returned_to_the_browser() {
        let mut job = serde_json::json!({
            "id": "j1",
            "action": { "kind": "webhook", "config": { "url": "https://w.example.com/", "secret": "hunter2hunter2hunter2" } },
        });
        redact_job_secrets(&mut job);
        assert!(job["action"]["config"].get("secret").is_none());
        assert_eq!(job["action"]["config"]["secret_set"], true);
        assert!(!job.to_string().contains("hunter2"));

        let mut memory = serde_json::json!({ "action": { "kind": "memory_relayer_call", "config": {} } });
        redact_job_secrets(&mut memory);
        assert!(memory["action"]["config"].get("secret_set").is_none());
    }

    #[test]
    fn job_account_id_reads_the_engine_payload() {
        let job = serde_json::json!({ "id": "j1", "account_id": "0xacct" });
        assert_eq!(job_account_id(&job), Some("0xacct"));
    }

    #[test]
    fn job_account_id_is_none_when_absent_or_not_a_string() {
        assert_eq!(job_account_id(&serde_json::json!({})), None);
        assert_eq!(job_account_id(&serde_json::json!({ "account_id": 7 })), None);
    }

    #[test]
    fn an_unconfigured_engine_is_a_503_not_a_bypass() {
        let response = ProxyError::NotConfigured.into_response();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn a_missing_or_foreign_job_is_a_404_without_saying_which() {
        // One variant covers "does not exist" and "belongs to someone else", so
        // the response cannot be used to enumerate another tenant's job ids.
        let response = ProxyError::NotFound.into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn engine_failures_are_502_so_a_client_may_retry() {
        let response =
            ProxyError::EngineUnavailable("unreachable".into()).into_response();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let response = ProxyError::InvalidRequest("name is required".into()).into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
