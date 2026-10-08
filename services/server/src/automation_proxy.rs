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
            return Err(if status.is_client_error() {
                ProxyError::InvalidRequest(detail)
            } else {
                ProxyError::EngineUnavailable(format!("automation engine returned {status}: {detail}"))
            });
        }
        serde_json::from_slice(&bytes).map_err(|e| {
            ProxyError::EngineUnavailable(format!("automation engine returned unparseable JSON: {e}"))
        })
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
        Some(owner) if owner == auth.account_id => Ok(job),
        Some(_) => Err(ProxyError::NotFound),
        None => Err(ProxyError::EngineUnavailable(
            "automation engine returned a job with no account_id".into(),
        )),
    }
}

#[derive(Debug, Deserialize)]
pub struct ListJobsQuery {
    pub limit: Option<i64>,
}

/// `GET /api/automation/jobs` — jobs for the authenticated account.
pub async fn list_jobs(
    Extension(auth): Extension<AuthInfo>,
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListJobsQuery>,
) -> Result<Json<Value>, ProxyError> {
    let engine = EngineClient::from_config(&state.config)?;
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    // The account filter comes from the verified identity, never the query
    // string — otherwise a caller could ask for someone else's jobs.
    let path = format!(
        "/v1/automation/jobs?account_id={}&limit={limit}",
        urlencode(&auth.account_id)
    );
    Ok(Json(engine.get(&path).await?))
}

/// `GET /api/automation/jobs/:id` — one job, if it belongs to the caller.
pub async fn get_job(
    Extension(auth): Extension<AuthInfo>,
    State(state): State<Arc<AppState>>,
    Path(job_id): Path<String>,
) -> Result<Json<Value>, ProxyError> {
    let engine = EngineClient::from_config(&state.config)?;
    Ok(Json(assert_owned(&engine, &job_id, &auth).await?))
}

#[derive(Debug, Deserialize)]
pub struct ListRunsQuery {
    pub limit: Option<i64>,
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
    Ok(Json(
        engine
            .get(&format!("/v1/automation/jobs/{job_id}/runs?limit={limit}"))
            .await?,
    ))
}

/// `POST /api/automation/jobs` — create a job owned by the caller.
#[derive(Debug, Deserialize)]
pub struct CreateJobBody {
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

    // Ownership is stamped from the verified identity. `account_id`,
    // `owner_address` and `organization_id` are not accepted from the request
    // body at all. `owner_address` is what the AI credit oracle bills against.
    let payload = serde_json::json!({
        "organization_id": organization_id,
        "account_id": auth.account_id,
        "owner_address": auth.owner,
        "name": body.name,
        "trigger_set": body.trigger_set,
        "target_agent_object_id": body.target_agent_object_id,
        "target_agent_key_ref": body.target_agent_key_ref,
        "action": body.action,
        "memory_scope": body.memory_scope.unwrap_or_else(|| "chat-app".into()),
        "max_mist_per_run": body.max_mist_per_run.unwrap_or(0),
        "retry_policy": body.retry_policy.unwrap_or_else(|| {
            serde_json::json!({ "max_attempts": 3, "jitter_ms": 1000 })
        }),
    });

    Ok(Json(engine.post("/v1/automation/jobs", &payload).await?))
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
// Sealed automation delegates
// ---------------------------------------------------------------------------
//
// A delegate is a memory-only, expiring, spend-capped sub-agent the owner
// registered on-chain for unattended jobs. Its seed is sealed in the browser to
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

#[derive(Debug, Deserialize)]
pub struct PutDelegateBody {
    /// The on-chain `SubAgent` object this key signs as.
    pub agent_object_id: String,
    /// Which bridge seal key the envelope was sealed to.
    pub seal_key_id: String,
    /// The sealed envelope (base64url). Opaque to this service.
    pub sealed: String,
}

/// `PUT /api/automation/delegates/:ref` — store a sealed delegate key.
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
    // `account_id` comes from the verified signature, never the body.
    let payload = serde_json::json!({
        "account_id": auth.account_id,
        "delegate_ref": delegate_ref,
        "agent_object_id": body.agent_object_id,
        "seal_key_id": body.seal_key_id,
        "sealed": body.sealed,
    });
    engine
        .send_no_content(reqwest::Method::PUT, "/v1/automation/delegates", Some(&payload))
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/automation/delegates` — this account's delegates. Metadata only.
pub async fn list_delegates(
    Extension(auth): Extension<AuthInfo>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, ProxyError> {
    let engine = EngineClient::from_config(&state.config)?;
    let path = format!(
        "/v1/automation/delegates?account_id={}",
        urlencode(&auth.account_id)
    );
    Ok(Json(engine.get(&path).await?))
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
    let path = format!(
        "/v1/automation/delegates?account_id={}&delegate_ref={}",
        urlencode(&auth.account_id),
        urlencode(&delegate_ref)
    );
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
