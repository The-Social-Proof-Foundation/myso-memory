//! Scoped durable run journal. MYDATA encrypts snapshots/results; SQL serializes intent before dispatch.
//! This is persistence, not a second scheduler. Only the automation service owns background execution.
use std::{collections::{HashMap, HashSet}, sync::Arc};
use axum::{extract::{Path, Query, State}, Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::Row;
use uuid::Uuid;
use crate::{mydata::{self, MyDataCredential}, types::{AppError, AppState, AuthInfo}};

const MAX_PAYLOAD: usize = 128 * 1024;
fn bad(message: &str) -> AppError { AppError::BadRequest(message.into()) }
fn db_error(_: sqlx::Error) -> AppError { AppError::Internal("work journal storage failed".into()) }
fn unavailable() -> AppError { AppError::BlobNotFound("work record unavailable".into()) }
fn conflict() -> AppError { AppError::Conflict("work revision or operation identity conflicts; reconcile before retrying".into()) }
fn uuid(value: &str) -> Result<Uuid, AppError> { Uuid::parse_str(value).map_err(|_| bad("invalid work record ID")) }
pub(crate) fn scope(state: &AppState, auth: &AuthInfo) -> (String, Value) {
    let norm = |id: &str| crate::memory_contract::normalize_object_id(id);
    let mut value = json!({ "network": state.config.myso_network, "owner": norm(&auth.owner),
        "accountId": norm(&auth.account_id), "agentId": norm(&auth.agent_object_id),
        "organizationId": auth.organization_id.as_deref().map(norm), "platformId": auth.platform_id.as_deref().map(norm) });
    value.as_object_mut().unwrap().retain(|_, value| !value.is_null());
    (hex::encode(Sha256::digest(value.to_string().as_bytes())), value)
}
pub(crate) async fn encrypt(state: &AppState, auth: &AuthInfo, value: &Value) -> Result<Vec<u8>, AppError> {
    let bytes = serde_json::to_vec(value).map_err(|_| bad("invalid work payload"))?;
    let stored = if bytes.len() > MAX_PAYLOAD { spill_oversized_payload(state, auth, value, &bytes).await? } else { value.clone() };
    let bytes = serde_json::to_vec(&stored).map_err(|_| bad("invalid work payload"))?;
    if bytes.len() > MAX_PAYLOAD { return Err(bad("work payload exceeds 128 KiB")); }
    tokio::time::timeout(std::time::Duration::from_secs(30), mydata::mydata_encrypt(&state.http_client, &state.config.sidecar_url, state.config.sidecar_secret.as_deref(),
        &bytes, &auth.owner, &state.config.package_id, 0, None)).await
        .map_err(|_| AppError::Internal("work payload encryption timed out".into()))?
        .map_err(|_| AppError::Internal("work payload encryption failed".into()))
}
async fn spill_oversized_payload(state: &AppState, auth: &AuthInfo, value: &Value, bytes: &[u8]) -> Result<Value, AppError> {
    let digest = hex::encode(Sha256::digest(bytes));
    let owner = crate::memory_contract::normalize_object_id(&auth.owner);
    let store = state.r2.as_ref().ok_or_else(|| AppError::Internal("Cloudflare R2 is not configured for oversized work payloads".into()))?;
    store.put_work_payload(&owner, &digest, bytes.to_vec()).await?;
    let uri = format!("r2://{owner}/{digest}");
    let pointer = format!("Oversized work payload omitted from the transcript. Reference {uri} ({} bytes, sha256 {digest}).", bytes.len());
    let mut stub = json!({
        "oversizedPayload": { "uri": uri, "contentLength": bytes.len(), "sha256": digest },
        "transcriptPointer": pointer,
        "messages": [{ "role": "system", "content": pointer }],
    });
    if let Some(object) = value.as_object() {
        for key in ["id", "status", "plan", "taskId", "revision"] {
            if let Some(kept) = object.get(key) { stub[key] = kept.clone(); }
        }
    }
    Ok(stub)
}

pub(crate) async fn decrypt(state: &AppState, auth: &AuthInfo, bytes: &[u8]) -> Result<Value, AppError> {
    // Never fall back to a service/root key for tenant work.
    let credential = MyDataCredential::from_auth_or_fallback(auth, None)
        .ok_or_else(|| AppError::Unauthorized("MYDATA session required for work access".into()))?;
    let data = tokio::time::timeout(std::time::Duration::from_secs(30), mydata::mydata_decrypt(&state.http_client, &state.config.sidecar_url, state.config.sidecar_secret.as_deref(),
        bytes, &credential, &state.config.package_id, &auth.account_id, auth.platform_id.as_deref(),
        auth.platform_scope.as_deref(), 0, &auth.owner, None, None)).await
        .map_err(|_| AppError::Internal("work payload decryption timed out".into()))?
        .map_err(|_| AppError::Forbidden("MYDATA work access denied or unavailable".into()))?;
    if data.len() > MAX_PAYLOAD { return Err(AppError::Internal("work payload exceeds limit".into())); }
    serde_json::from_slice(&data).map_err(|_| AppError::Internal("invalid encrypted work payload".into()))
}
fn plan_version(plan: &Value) -> Result<i64, AppError> {
    plan.get("version").and_then(Value::as_i64).filter(|v| *v > 0).ok_or_else(|| bad("positive plan version required"))
}
fn validate_plan(plan: &Value) -> Result<(), AppError> {
    plan_version(plan)?;
    let goal = plan.get("goal").and_then(Value::as_str).ok_or_else(|| bad("plan goal required"))?;
    if goal.is_empty() || goal.len() > 10000 { return Err(bad("invalid goal length")); }
    let steps = plan.get("steps").and_then(Value::as_array).filter(|s| !s.is_empty() && s.len() <= 100).ok_or_else(|| bad("plan needs 1-100 steps"))?;
    let mut deps: HashMap<String, Vec<String>> = HashMap::new();
    for step in steps {
        let id = step.get("id").and_then(Value::as_str).ok_or_else(|| bad("step ID required"))?;
        if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-') { return Err(bad("invalid step ID")); }
        let title = step.get("title").and_then(Value::as_str).ok_or_else(|| bad("step title required"))?;
        if title.is_empty() || title.len() > 200 { return Err(bad("invalid step title")); }
        let criteria = step.get("acceptanceCriteria").and_then(Value::as_array).filter(|c| !c.is_empty() && c.len() <= 30).ok_or_else(|| bad("acceptance criteria required"))?;
        if criteria.iter().any(|c| c.as_str().is_none_or(|s| s.is_empty() || s.len() > 2000)) { return Err(bad("invalid acceptance criterion")); }
        if let Some(events)=step.get("taskEvidenceEvents") {
            let events=events.as_array().filter(|events|!events.is_empty()&&events.len()<=13).ok_or_else(||bad("task evidence event requirements must contain 1-13 event names"))?;
            let mut unique=HashSet::new();
            for event in events {
                let event=event.as_str().ok_or_else(||bad("invalid task evidence event name"))?;
                if !["TaskOffered","TaskAccepted","TaskDelivered","TaskReceiptSettled","TaskRefunded","TaskCancelled","TaskDisputed","TaskDisputeFeePaid","TaskDisputeCancelled","TaskDisputeResolved","CaseOpened","CaseAppealed","CaseCancelled"].contains(&event) || !unique.insert(event) {
                    return Err(bad("task evidence event names must be supported and unique"));
                }
            }
        }
        if let Some(alternatives)=step.get("taskEvidenceEventAlternatives") {
            let alternatives=alternatives.as_array().filter(|groups|!groups.is_empty()&&groups.len()<=8).ok_or_else(||bad("task evidence alternatives must contain 1-8 event groups"))?;
            let mut unique_groups=HashSet::new();
            for group in alternatives {
                let events=group.as_array().filter(|events|!events.is_empty()&&events.len()<=13).ok_or_else(||bad("each task evidence alternative must contain 1-13 event names"))?;
                let mut unique_events=HashSet::new();
                let mut canonical=Vec::with_capacity(events.len());
                for event in events {
                    let event=event.as_str().ok_or_else(||bad("invalid task evidence alternative event name"))?;
                    if !["TaskOffered","TaskAccepted","TaskDelivered","TaskReceiptSettled","TaskRefunded","TaskCancelled","TaskDisputed","TaskDisputeFeePaid","TaskDisputeCancelled","TaskDisputeResolved","CaseOpened","CaseAppealed","CaseCancelled"].contains(&event) || !unique_events.insert(event) {
                        return Err(bad("task evidence alternative event names must be supported and unique"));
                    }
                    canonical.push(event);
                }
                canonical.sort_unstable();
                if !unique_groups.insert(canonical) { return Err(bad("task evidence alternative groups must be unique")); }
            }
        }
        if let Some(amount) = step.get("aiBudgetMist") {
            let amount = amount.as_str().ok_or_else(|| bad("legacy AI accounting field must be a decimal string"))?;
            if amount.is_empty() || (amount.len() > 1 && amount.starts_with('0')) || !amount.bytes().all(|c| c.is_ascii_digit()) || amount.parse::<u64>().is_err() { return Err(bad("legacy AI accounting field exceeds u64 or is not canonical")); }
        }
        if let Some(value) = step.get("actionBudgetMist") {
            let amount = value.as_str().ok_or_else(|| bad("legacy action journal field must be a decimal string"))?;
            if amount.is_empty() || (amount.len() > 1 && amount.starts_with('0')) || !amount.bytes().all(|c| c.is_ascii_digit()) || amount.parse::<u64>().is_err() { return Err(bad("legacy action journal field exceeds u64 or is not canonical")); }
        }
        let prerequisites = step.get("dependsOn").and_then(Value::as_array).filter(|d| d.len() <= 100).ok_or_else(|| bad("step dependencies required"))?;
        let mut unique = HashSet::new();
        let mut parsed = Vec::new();
        for item in prerequisites {
            let item = item.as_str().ok_or_else(|| bad("invalid prerequisite ID"))?;
            if !unique.insert(item) { return Err(bad("duplicate prerequisite")); }
            parsed.push(item.to_string());
        }
        if deps.insert(id.into(), parsed).is_some() { return Err(bad("duplicate step ID")); }
    }
    fn walk(id: &str, deps: &HashMap<String, Vec<String>>, visiting: &mut HashSet<String>, done: &mut HashSet<String>) -> Result<(), AppError> {
        if done.contains(id) { return Ok(()); }
        if !visiting.insert(id.into()) { return Err(bad("work plan is cyclic")); }
        for dependency in deps.get(id).ok_or_else(|| bad("unknown prerequisite"))? { walk(dependency, deps, visiting, done)?; }
        visiting.remove(id); done.insert(id.into()); Ok(())
    }
    let mut done = HashSet::new();
    for id in deps.keys() { walk(id, &deps, &mut HashSet::new(), &mut done)?; }
    Ok(())
}
fn action_spend_amount(tool_name: &str, tool_input: &Value) -> Result<Option<u64>, AppError> {
    let field = match tool_name {
        "access_purchase_mydata_access" | "access_purchase_post_access" => "priceMist",
        "task_create" => "amountMist",
        "spt_buy" => "paymentAmountBaseUnits",
        _ => return Ok(None),
    };
    let value = tool_input.get(field).and_then(Value::as_str).ok_or_else(|| bad("MYSO-funded action is missing its exact MIST amount"))?;
    if value.is_empty() || (value.len() > 1 && value.starts_with('0')) || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(bad("MYSO-funded action amount must be a canonical decimal MIST string"));
    }
    let amount = value.parse::<u64>().map_err(|_| bad("MYSO-funded action amount exceeds u64 MIST"))?;
    if amount == 0 { return Err(bad("MYSO-funded action amount must be positive")); }
    Ok(Some(amount))
}
pub(crate) fn active(status: &str) -> bool { matches!(status, "planned" | "running" | "yielded" | "waiting_for_input" | "waiting_for_approval") }
fn row_run(row: &sqlx::postgres::PgRow, mut snapshot: Value) -> Value {
    snapshot["id"] = json!(row.get::<Uuid,_>("id").to_string());
    snapshot["scope"] = row.get("scope"); snapshot["revision"] = json!(row.get::<i64,_>("revision"));
    snapshot["status"] = json!(row.get::<String,_>("status"));
    snapshot["cancelRequestedAt"] = row.try_get::<Option<chrono::DateTime<chrono::Utc>>,_>("cancel_requested_at")
        .ok().flatten().map(|value| json!(value.to_rfc3339())).unwrap_or(Value::Null);
    snapshot["createdAt"] = json!(row.get::<chrono::DateTime<chrono::Utc>,_>("created_at").to_rfc3339());
    snapshot["updatedAt"] = json!(row.get::<chrono::DateTime<chrono::Utc>,_>("updated_at").to_rfc3339());
    snapshot
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct Create { pub id: String, pub plan: Value, pub task_id: Option<String> }

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct IssueWorkerCredential {
    pub delegate_ref: String,
    pub ttl_seconds: i64,
    #[serde(default)]
    pub allow_private_graph: bool,
    #[serde(default)]
    pub allow_private_task_artifacts: bool,
    #[serde(default)]
    pub allow_room_history: bool,
    #[serde(default)]
    pub allow_private_content_sharing: bool,
}

/// Mint one opaque credential for an already-authorized action_worker. The
/// caller validates the delegate's live class/ancestry before reaching here;
/// this function binds the returned bearer to the exact scoped run and stores
/// only its digest. Issuance rotates any earlier credential for this run.
pub async fn issue_worker_credential(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Path(run_id): Path<String>,
    Json(input): Json<IssueWorkerCredential>,
) -> Result<Json<Value>, AppError> {
    let run_id = uuid(&run_id)?;
    let run=get(State(state.clone()),Extension(auth.clone()),Path(run_id.to_string())).await?;
    let linked_task_id=run.0.get("taskId").and_then(Value::as_str);
    Ok(Json(issue_worker_credential_for_parent(&state,&auth,run_id,&input.delegate_ref,input.ttl_seconds,input.allow_private_graph,input.allow_private_task_artifacts,input.allow_room_history,input.allow_private_content_sharing,linked_task_id).await?))
}

/// Internal scheduler variant. The caller must first validate the action-worker
/// MyData session against this exact run; this function then rechecks live
/// parent/child authority and stores only the credential digest.
pub async fn issue_worker_credential_for_parent(
    state: &Arc<AppState>,
    auth: &AuthInfo,
    run_id: Uuid,
    delegate_ref: &str,
    ttl_seconds: i64,
    allow_private_graph: bool,
    allow_private_task_artifacts: bool,
    allow_room_history: bool,
    allow_private_content_sharing: bool,
    linked_task_id: Option<&str>,
) -> Result<Value, AppError> {
    if !crate::automation_proxy::valid_delegate_ref_for_work(delegate_ref)
        || ttl_seconds < 60 || ttl_seconds > 1800
    {
        return Err(bad("worker credential needs a valid delegate reference and a 60–1800 second lifetime"));
    }
    if allow_private_content_sharing && !allow_private_task_artifacts && !allow_room_history && !allow_private_graph {
        return Err(bad("private-content sharing consent requires an approved private content source"));
    }
    let linked_task_id=linked_task_id.map(crate::chain_reads::id).transpose()?;
    if allow_private_task_artifacts && linked_task_id.is_none() {
        return Err(bad("private task-artifact consent requires a task-linked work run"));
    }
    let worker_agent_id = crate::automation_proxy::verify_action_worker_for_run(state, auth, delegate_ref)
        .await.map_err(|_| AppError::Forbidden("the selected action_worker is not active under this parent agent".into()))?;
    let (scope_key, _) = scope(state, auth);
    let mut tx = state.db.pool().begin().await.map_err(db_error)?;
    let run = sqlx::query("SELECT status FROM work_runs WHERE id=$1 AND scope_key=$2 FOR UPDATE")
        .bind(run_id).bind(&scope_key).fetch_optional(&mut *tx).await.map_err(db_error)?.ok_or_else(unavailable)?;
    if !active(run.get::<String, _>("status").as_str()) {
        return Err(conflict());
    }
    let raw = format!("mwr1.{}.{}", Uuid::new_v4(), Uuid::new_v4());
    let token_hash = Sha256::digest(raw.as_bytes()).to_vec();
    let credential_id = Uuid::new_v4();
    let expires_at = chrono::Utc::now() + chrono::Duration::seconds(ttl_seconds);
    sqlx::query("UPDATE work_run_worker_credentials SET revoked_at=now() WHERE run_id=$1 AND scope_key=$2 AND revoked_at IS NULL")
        .bind(run_id).bind(&scope_key).execute(&mut *tx).await.map_err(db_error)?;
    sqlx::query("INSERT INTO work_run_worker_credentials(id,run_id,scope_key,owner_address,account_id,parent_agent_id,delegate_ref,worker_agent_id,token_hash,expires_at,allow_private_graph,allow_room_history,allow_private_content_sharing,allow_private_task_artifacts,linked_task_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)")
        .bind(credential_id).bind(run_id).bind(&scope_key)
        .bind(crate::memory_contract::normalize_object_id(&auth.owner))
        .bind(crate::memory_contract::normalize_object_id(&auth.account_id))
        .bind(crate::memory_contract::normalize_object_id(&auth.agent_object_id))
        .bind(delegate_ref)
        .bind(crate::memory_contract::normalize_object_id(&worker_agent_id))
        .bind(token_hash).bind(expires_at)
        .bind(allow_private_graph).bind(allow_room_history).bind(allow_private_content_sharing).bind(allow_private_task_artifacts).bind(linked_task_id)
        .execute(&mut *tx).await.map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(json!({"credentialId":credential_id.to_string(),"credential":raw,"runId":run_id.to_string(),"delegateRef":delegate_ref,"workerAgentId":worker_agent_id,"expiresAt":expires_at.to_rfc3339()}))
}

pub async fn revoke_worker_credential(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Path(run_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let (scope_key, _) = scope(&state, &auth);
    let run_id = uuid(&run_id)?;
    let changed = sqlx::query("UPDATE work_run_worker_credentials SET revoked_at=now() WHERE run_id=$1 AND scope_key=$2 AND revoked_at IS NULL")
        .bind(run_id).bind(scope_key).execute(state.db.pool()).await.map_err(db_error)?;
    Ok(Json(json!({"runId":run_id.to_string(),"revoked":changed.rows_affected()>0})))
}

pub(crate) async fn validate_worker_credential(
    state: &AppState,
    auth: &AuthInfo,
    run_id: Uuid,
    worker_agent_id: &str,
    token: &str,
) -> Result<bool, AppError> {
    if token.len() > 128 || !token.starts_with("mwr1.") { return Ok(false); }
    let (scope_key, _) = scope(state, auth);
    let digest = Sha256::digest(token.as_bytes()).to_vec();
    let expected_worker = crate::memory_contract::normalize_object_id(worker_agent_id);
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM work_run_worker_credentials WHERE run_id=$1 AND scope_key=$2 AND parent_agent_id=$3 AND worker_agent_id=$4 AND token_hash=$5 AND revoked_at IS NULL AND expires_at>now())")
        .bind(run_id).bind(scope_key)
        .bind(crate::memory_contract::normalize_object_id(&auth.agent_object_id))
        .bind(expected_worker).bind(digest)
        .fetch_one(state.db.pool()).await.map_err(db_error)
}

/// Resolve a worker bearer without an owner OAuth session. Only the internal
/// MCP service can call this path; the credential remains scoped to one run.
pub(crate) async fn worker_credential_context(
    state: &AppState,
    token: &str,
) -> Result<Option<Value>, AppError> {
    if token.len() > 128 || !token.starts_with("mwr1.") { return Ok(None); }
    let digest = Sha256::digest(token.as_bytes()).to_vec();
    let row = sqlx::query("SELECT c.run_id,c.owner_address,c.account_id,c.parent_agent_id,c.delegate_ref,c.worker_agent_id,c.expires_at,c.allow_private_graph,c.allow_room_history,c.allow_private_content_sharing,c.allow_private_task_artifacts,c.linked_task_id,r.cancel_requested_at FROM work_run_worker_credentials c JOIN work_runs r ON r.id=c.run_id WHERE c.token_hash=$1 AND c.revoked_at IS NULL AND c.expires_at>now()")
        .bind(digest).fetch_optional(state.db.pool()).await.map_err(db_error)?;
    Ok(row.map(|row| json!({
        "runId": row.get::<Uuid,_>("run_id").to_string(),
        "ownerAddress": row.get::<String,_>("owner_address"),
        "accountId": row.get::<String,_>("account_id"),
        "parentAgentId": row.get::<String,_>("parent_agent_id"),
        "delegateRef": row.get::<String,_>("delegate_ref"),
        "workerAgentId": row.get::<String,_>("worker_agent_id"),
        "expiresAt": row.get::<chrono::DateTime<chrono::Utc>,_>("expires_at").to_rfc3339(),
        "allowPrivateGraph": row.get::<bool,_>("allow_private_graph"),
        "allowRoomHistory": row.get::<bool,_>("allow_room_history"),
        "allowPrivateTaskArtifacts": row.get::<bool,_>("allow_private_task_artifacts"),
        "taskId": row.get::<Option<String>,_>("linked_task_id"),
        "allowPrivateContentSharing": row.get::<bool,_>("allow_private_content_sharing"),
        "cancelRequestedAt": row.get::<Option<chrono::DateTime<chrono::Utc>>,_>("cancel_requested_at").map(|value| value.to_rfc3339()),
    })))
}

/// Extend the same opaque worker bearer while its single run remains active.
/// The internal route first revalidates the child against live chain state.
pub(crate) async fn renew_worker_credential(state: &AppState, token: &str) -> Result<Value, AppError> {
    if token.len() > 128 || !token.starts_with("mwr1.") { return Err(AppError::Unauthorized("work-run credential is invalid".into())); }
    let digest = Sha256::digest(token.as_bytes()).to_vec();
    let expires_at: Option<chrono::DateTime<chrono::Utc>> = sqlx::query_scalar(
        "UPDATE work_run_worker_credentials c SET expires_at=now()+interval '30 minutes' FROM work_runs r WHERE c.run_id=r.id AND c.token_hash=$1 AND c.revoked_at IS NULL AND c.expires_at>now() AND r.cancel_requested_at IS NULL AND r.status IN ('planned','running','yielded','waiting_for_input','waiting_for_approval') RETURNING c.expires_at"
    ).bind(digest).fetch_optional(state.db.pool()).await.map_err(db_error)?;
    Ok(match expires_at {
        Some(value) => json!({"renewed":true,"expiresAt":value.to_rfc3339()}),
        None => json!({"renewed":false,"expiresAt":null}),
    })
}

pub(crate) async fn resolve_worker_run_id(
    state: &AppState,
    auth: &AuthInfo,
    operation: &str,
    params: &Value,
) -> Result<Uuid, AppError> {
    if matches!(operation, "work_run_list" | "work_run_create") {
        return Err(AppError::Forbidden("worker credentials are limited to their single existing run".into()));
    }
    if operation == "work_run_settle_operation" {
        let operation_id = uuid(params.get("operationId").and_then(Value::as_str).ok_or_else(|| bad("operation ID is missing"))?)?;
        let (scope_key, _) = scope(state, auth);
        return sqlx::query_scalar("SELECT o.run_id FROM work_operations o JOIN work_runs r ON r.id=o.run_id WHERE o.id=$1 AND r.scope_key=$2")
            .bind(operation_id).bind(scope_key).fetch_optional(state.db.pool()).await.map_err(db_error)?
            .ok_or_else(unavailable);
    }
    if !matches!(operation,
        "work_run_get" | "work_run_list_operations" | "work_run_save_plan" |
        "work_run_refresh_task_history" |
        "work_run_reserve_operation" | "work_run_reconcile_action_receipt" | "work_run_reconcile_task_upload" | "work_run_append_action_receipt" |
        "work_run_append_task_artifact" | "work_run_update_step" |
        "work_run_acquire_turn" | "work_run_renew_turn" |
        "work_run_checkpoint" | "work_run_finish_turn" | "work_run_complete") {
        return Err(AppError::Forbidden("operation is unavailable to a run worker".into()));
    }
    uuid(params.get("runId").and_then(Value::as_str).ok_or_else(|| bad("run ID is missing"))?)
}

fn task_transition_status(event_type: &str) -> Option<i64> {
    match event_type.rsplit("::").next()? {
        "TaskOffered" => Some(0),
        "TaskAccepted" => Some(1),
        "TaskDelivered" => Some(2),
        "TaskReceiptSettled" => Some(3),
        "TaskRefunded" => Some(4),
        "TaskCancelled" => Some(5),
        "TaskDisputed" => Some(6),
        _ => None,
    }
}

fn task_history_order(event: &Value) -> Option<(u64, u64)> {
    let checkpoint = event.get("checkpoint").and_then(|value| {
        value.as_u64().or_else(|| value.as_str().and_then(|text| text.parse::<u64>().ok()))
    })?;
    let source = event.get("sourceEventId").and_then(Value::as_str)?;
    let sequence = source.rsplit_once(':')?.1.parse::<u64>().ok()?;
    Some((checkpoint, sequence))
}

/// Project the newest finalized transition represented in the checked history.
/// Checkpoint and event sequence order avoid relying on indexer timestamp ties.
fn project_verified_task_state(history: &Value, existing: Option<&Value>) -> Option<Value> {
    let mut newest: Option<((u64, u64), Value)> = None;
    for event in history.get("events").and_then(Value::as_array)? {
        if event.get("verification").and_then(Value::as_str) != Some("finalized_fullnode_task_event") { continue; }
        let Some(event_type) = event.get("eventType").and_then(Value::as_str) else { continue; };
        let Some(status) = task_transition_status(event_type) else { continue; };
        let Some(order) = task_history_order(event) else { continue; };
        let Some(digest) = event.get("digest").and_then(Value::as_str) else { continue; };
        let Some(task_id) = history.get("taskId").and_then(Value::as_str) else { continue; };
        let Some(source_event_id) = event.get("sourceEventId").and_then(Value::as_str) else { continue; };
        let state = json!({
            "taskId": task_id,
            "status": status,
            "transactionDigest": digest,
            "sourceEventId": source_event_id,
            "checkpoint": order.0.to_string(),
            "eventType": event_type,
            "evidence": "finalized_fullnode_task_event",
            "recordedAt": chrono::Utc::now().to_rfc3339()
        });
        if newest.as_ref().is_none_or(|(prior, _)| order > *prior) { newest = Some((order, state)); }
    }
    let (candidate_order, mut candidate) = newest?;
    if let Some(existing) = existing {
        let existing_order = existing.get("checkpoint").and_then(|value| {
            value.as_u64().or_else(|| value.as_str().and_then(|text| text.parse::<u64>().ok()))
        }).map(|checkpoint| {
            let sequence = existing.get("sourceEventId").and_then(Value::as_str)
                .and_then(|source| source.rsplit_once(':'))
                .and_then(|(_, sequence)| sequence.parse::<u64>().ok()).unwrap_or(0);
            (checkpoint, sequence)
        }).or_else(|| {
            history.get("events").and_then(Value::as_array)?.iter().find_map(|event| {
                (event.get("verification").and_then(Value::as_str) == Some("finalized_fullnode_task_event")
                    && event.get("digest").and_then(Value::as_str) == existing.get("transactionDigest").and_then(Value::as_str)
                    && event.get("eventType").and_then(Value::as_str) == existing.get("eventType").and_then(Value::as_str))
                    .then(|| task_history_order(event)).flatten()
            })
        });
        if let Some(order) = existing_order {
            if candidate_order <= order { return None; }
        } else if existing.get("transactionDigest").and_then(Value::as_str) == candidate.get("transactionDigest").and_then(Value::as_str)
            && existing.get("eventType").and_then(Value::as_str) == candidate.get("eventType").and_then(Value::as_str) {
            return None;
        } else {
            // Legacy action-derived states have no checkpoint. Their relative
            // chain order cannot be proven, so do not replace them speculatively.
            return None;
        }
        if existing.get("operationId").and_then(Value::as_str).is_some()
            && existing.get("transactionDigest").and_then(Value::as_str) == candidate.get("transactionDigest").and_then(Value::as_str)
            && existing.get("eventType").and_then(Value::as_str) == candidate.get("eventType").and_then(Value::as_str) {
            candidate["operationId"] = existing["operationId"].clone();
        }
    }
    Some(candidate)
}

pub async fn create(State(state): State<Arc<AppState>>, Extension(auth): Extension<AuthInfo>, Json(input): Json<Create>) -> Result<Json<Value>, AppError> {
    let id = uuid(&input.id)?; validate_plan(&input.plan)?;
    if plan_version(&input.plan)? != 1 { return Err(bad("initial plan version must be 1")); }
    let task_link = if let Some(task_id) = input.task_id.as_deref() {
        let task_id = crate::chain_reads::id(task_id)?;
        let task = crate::platform_reads::owned_task(&state, &auth, &task_id).await?;
        let buyer = task.get("buyerPrincipal").and_then(Value::as_str).is_some_and(|id| crate::chain_reads::same(id, &auth.owner))
            && task.get("buyerAgentId").and_then(Value::as_str).is_none_or(|id| crate::chain_reads::same(id, &auth.agent_object_id));
        let seller = task.get("sellerPrincipal").and_then(Value::as_str).is_some_and(|id| crate::chain_reads::same(id, &auth.owner));
        let seller_agent = task.get("sellerAgentId").and_then(Value::as_str).is_some_and(|id| crate::chain_reads::same(id, &auth.agent_object_id));
        let task_status=task.get("status").and_then(Value::as_i64);
        let buyer_can_coordinate=buyer&&matches!(task_status,Some(0|1));
        let seller_can_coordinate=seller&&seller_agent&&task_status==Some(1);
        if !(buyer_can_coordinate || seller_can_coordinate) {
            return Err(AppError::Forbidden("a buyer can coordinate an open or accepted task; the assigned seller agent can coordinate only after acceptance".into()));
        }
        let room = task.get("roomGroupId").and_then(Value::as_str).map(crate::chain_reads::id).transpose()?;
        let task_role = if seller_agent { "seller" } else { "buyer" };
        Some((task_id, room, task_role))
    } else { None };
    let (key, execution_scope) = scope(&state, &auth);
    let states: serde_json::Map<String, Value> = input.plan["steps"].as_array().unwrap().iter().map(|s| (s["id"].as_str().unwrap().into(), json!("pending"))).collect();
    let mut snapshot = json!({"plan": input.plan, "stepStatus": states, "stepEvidence": {}, "artifacts": [], "receipts": []});
    if let Some((task_id, room_id, task_role)) = &task_link {
        snapshot["taskId"] = json!(task_id);
        snapshot["taskRole"] = json!(task_role);
        if let Some(room_id) = room_id { snapshot["roomId"] = json!(room_id); }
        snapshot["taskHistory"] = match crate::platform_reads::task_lifecycle_history(&state, &auth, task_id, 100, 0).await {
            Ok(history) if history.get("taskId").and_then(Value::as_str).is_some_and(|value| crate::chain_reads::same(value, task_id)) => json!({
                "taskId": task_id,
                "events": history.get("events").cloned().unwrap_or_else(|| json!([])),
                "evidenceSource": "participant_indexed_history_with_fullnode_event_checks",
                "nextOffset": history.get("nextOffset").cloned().unwrap_or(Value::Null)
            }),
            _ => json!({"taskId":task_id,"events":[],"evidenceSource":"task_history_unavailable","nextOffset":null}),
        };
        if let Some(projected) = project_verified_task_state(&snapshot["taskHistory"], None) {
            snapshot["verifiedTaskState"] = projected;
        }
    }
    let encrypted = encrypt(&state, &auth, &snapshot).await?;
    let row = sqlx::query("INSERT INTO work_runs(id,scope_key,scope,status,plan_version,snapshot) VALUES($1,$2,$3,'planned',1,$4) ON CONFLICT(id) DO NOTHING RETURNING *")
        .bind(id).bind(&key).bind(execution_scope).bind(encrypted).fetch_optional(state.db.pool()).await.map_err(db_error)?;
    if let Some(row) = row { return Ok(Json(row_run(&row, snapshot))); }
    // Caller-generated UUID makes lost create responses recoverable without another run.
    let row = sqlx::query("SELECT * FROM work_runs WHERE id=$1 AND scope_key=$2").bind(id).bind(key).fetch_optional(state.db.pool()).await.map_err(db_error)?.ok_or_else(unavailable)?;
    let existing = decrypt(&state, &auth, &row.get::<Vec<u8>,_>("snapshot")).await?;
    if existing["plan"] != input.plan
        || existing.get("taskId").and_then(Value::as_str) != task_link.as_ref().map(|(task_id, _, _)| task_id.as_str())
        || existing.get("roomId").and_then(Value::as_str) != task_link.as_ref().and_then(|(_, room_id, _)| room_id.as_deref())
        || existing.get("taskRole").and_then(Value::as_str) != task_link.as_ref().map(|(_, _, role)| *role) { return Err(conflict()); }
    Ok(Json(row_run(&row, existing)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Page { pub limit: Option<i64>, pub offset: Option<i64> }
pub async fn list(State(state): State<Arc<AppState>>, Extension(auth): Extension<AuthInfo>, Query(page): Query<Page>) -> Result<Json<Value>, AppError> {
    let rows = sqlx::query("SELECT id,revision,status,created_at,updated_at,cancel_requested_at FROM work_runs WHERE scope_key=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3")
        .bind(scope(&state,&auth).0).bind(page.limit.unwrap_or(20).clamp(1,200)).bind(page.offset.unwrap_or(0).clamp(0,100000)).fetch_all(state.db.pool()).await.map_err(db_error)?;
    Ok(Json(json!({"runs":rows.iter().map(|r|json!({"id":r.get::<Uuid,_>("id").to_string(),"revision":r.get::<i64,_>("revision"),"status":r.get::<String,_>("status"),"createdAt":r.get::<chrono::DateTime<chrono::Utc>,_>("created_at").to_rfc3339(),"updatedAt":r.get::<chrono::DateTime<chrono::Utc>,_>("updated_at").to_rfc3339(),"cancelRequestedAt":r.get::<Option<chrono::DateTime<chrono::Utc>>,_>("cancel_requested_at").map(|value|value.to_rfc3339())})).collect::<Vec<_>>()})))
}
pub async fn get(State(state): State<Arc<AppState>>, Extension(auth): Extension<AuthInfo>, Path(id): Path<String>) -> Result<Json<Value>, AppError> {
    let row = sqlx::query("SELECT * FROM work_runs WHERE id=$1 AND scope_key=$2").bind(uuid(&id)?).bind(scope(&state,&auth).0).fetch_optional(state.db.pool()).await.map_err(db_error)?.ok_or_else(unavailable)?;
    let snapshot = decrypt(&state,&auth,&row.get::<Vec<u8>,_>("snapshot")).await?;
    Ok(Json(row_run(&row,snapshot)))
}

/// Append the next participant-scoped, fullnode-checked task history page to
/// the MYDATA-encrypted run snapshot. The caller supplies only the run ID;
/// task identity, cursor, events and evidence states all come from the stored
/// run and the authenticated task-history reader.
pub async fn refresh_task_history(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let run_id = uuid(&id)?;
    let scope_key = scope(&state, &auth).0;
    let initial = sqlx::query("SELECT * FROM work_runs WHERE id=$1 AND scope_key=$2")
        .bind(run_id).bind(&scope_key).fetch_optional(state.db.pool()).await.map_err(db_error)?.ok_or_else(unavailable)?;
    let initial_snapshot = decrypt(&state, &auth, &initial.get::<Vec<u8>, _>("snapshot")).await?;
    let task_id = initial_snapshot.get("taskId").and_then(Value::as_str).ok_or_else(|| bad("work run is not linked to a task"))?.to_owned();
    let initial_history = initial_snapshot.get("taskHistory").cloned().unwrap_or(Value::Null);
    let initial_source = initial_history.get("evidenceSource").and_then(Value::as_str);
    let offset = match (initial_source, initial_history.get("nextOffset")) {
        (Some("participant_indexed_history_with_fullnode_event_checks"), Some(Value::Null)) => {
            return Ok(Json(json!({"run": row_run(&initial, initial_snapshot), "added": 0, "complete": true})));
        }
        (_, Some(value)) => value.as_u64().unwrap_or(0),
        (_, None) => 0,
    };
    if offset > 100_000 { return Err(bad("task history cursor exceeded its supported offset")); }

    // This read rechecks task participation and every event against the configured
    // fullnode. It runs before the DB lock so a slow RPC cannot hold a transaction.
    let page = crate::platform_reads::task_lifecycle_history(&state, &auth, &task_id, 100, offset as u32).await?;
    if page.get("taskId").and_then(Value::as_str).is_none_or(|actual| !crate::chain_reads::same(actual, &task_id)) {
        return Err(AppError::Conflict("task history page did not match the linked task".into()));
    }
    let page_events = page.get("events").and_then(Value::as_array).ok_or_else(|| AppError::Internal("task history page omitted events".into()))?;
    if page_events.len() > 100 { return Err(AppError::Internal("task history page exceeded its bound".into())); }
    let page_next = page.get("nextOffset").cloned().unwrap_or(Value::Null);
    let page_complete = page_next.is_null();

    let mut tx = state.db.pool().begin().await.map_err(db_error)?;
    let current = sqlx::query("SELECT * FROM work_runs WHERE id=$1 AND scope_key=$2 FOR UPDATE")
        .bind(run_id).bind(&scope_key).fetch_optional(&mut *tx).await.map_err(db_error)?.ok_or_else(unavailable)?;
    let mut snapshot = decrypt(&state, &auth, &current.get::<Vec<u8>, _>("snapshot")).await?;
    if snapshot.get("taskId").and_then(Value::as_str).is_none_or(|actual| !crate::chain_reads::same(actual, &task_id)) {
        return Err(AppError::Conflict("linked task changed while refreshing history".into()));
    }
    let latest_history = snapshot.get("taskHistory").cloned().unwrap_or(Value::Null);
    let latest_source = latest_history.get("evidenceSource").and_then(Value::as_str);
    let latest_offset = match (latest_source, latest_history.get("nextOffset")) {
        (Some("participant_indexed_history_with_fullnode_event_checks"), Some(Value::Null)) => {
            return Ok(Json(json!({"run": row_run(&current, snapshot), "added": 0, "complete": true})));
        }
        (_, Some(value)) => value.as_u64().unwrap_or(0),
        (_, None) => 0,
    };
    if latest_offset != offset {
        return Err(conflict());
    }
    let mut history = latest_history;
    let stored_event_count = history.get("events").and_then(Value::as_array).map(Vec::len).unwrap_or(0);
    if stored_event_count >= 10_000 {
        history["truncated"] = json!(true);
        history["nextOffset"] = Value::Null;
        snapshot["taskHistory"] = history;
        let encrypted = encrypt(&state, &auth, &snapshot).await?;
        let updated = sqlx::query("UPDATE work_runs SET snapshot=$1,revision=revision+1,updated_at=now() WHERE id=$2 AND scope_key=$3 RETURNING *")
            .bind(encrypted).bind(run_id).bind(&scope_key).fetch_one(&mut *tx).await.map_err(db_error)?;
        tx.commit().await.map_err(db_error)?;
        return Ok(Json(json!({"run": row_run(&updated, snapshot), "added": 0, "complete": true})));
    }
    if history.get("events").and_then(Value::as_array).is_none() {
        history = json!({"taskId": task_id, "events": [], "evidenceSource": "participant_indexed_history_with_fullnode_event_checks", "nextOffset": Value::Null, "truncated": false});
    }
    let (added, cap_hit) = {
        let events = history["events"].as_array_mut().ok_or_else(|| AppError::Internal("stored task history events are invalid".into()))?;
        let before = events.len();
        for event in page_events {
            let key = (event.get("sourceEventId").and_then(Value::as_str).unwrap_or(""), event.get("eventType").and_then(Value::as_str).unwrap_or(""));
            if key.0.is_empty() || key.1.is_empty() { return Err(AppError::Internal("task history event omitted its stable identity".into())); }
            if !events.iter().any(|existing| existing.get("sourceEventId").and_then(Value::as_str) == Some(key.0) && existing.get("eventType").and_then(Value::as_str) == Some(key.1)) {
                if events.len() == 10_000 { break; }
                events.push(event.clone());
            }
        }
        (events.len().saturating_sub(before), events.len() >= 10_000 && !page_complete)
    };
    history["taskId"] = json!(task_id);
    history["evidenceSource"] = json!("participant_indexed_history_with_fullnode_event_checks");
    history["nextOffset"] = if cap_hit { Value::Null } else { page_next.clone() };
    history["truncated"] = json!(cap_hit);
    snapshot["taskHistory"] = history;
    if let Some(projected) = project_verified_task_state(
        &snapshot["taskHistory"],
        snapshot.get("verifiedTaskState"),
    ) {
        snapshot["verifiedTaskState"] = projected;
    }
    let encrypted = encrypt(&state, &auth, &snapshot).await?;
    let updated = sqlx::query("UPDATE work_runs SET snapshot=$1,revision=revision+1,updated_at=now() WHERE id=$2 AND scope_key=$3 RETURNING *")
        .bind(encrypted).bind(run_id).bind(&scope_key).fetch_one(&mut *tx).await.map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({"run": row_run(&updated, snapshot), "added": added, "complete": page_complete || cap_hit, "truncated": cap_hit})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CancelRun { pub confirmed: bool }

/// Explicitly close an execution after every planned step has durable evidence.
/// This closes only the harness run; task delivery and escrow settlement remain separate.
pub async fn complete(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Path(run_id): Path<String>,
    Json(input): Json<CancelRun>,
) -> Result<Json<Value>, AppError> {
    if !input.confirmed { return Err(bad("explicit completion confirmation is required")); }
    let run_id = uuid(&run_id)?;
    let scope_key = scope(&state, &auth).0;
    let mut tx = state.db.pool().begin().await.map_err(db_error)?;
    let row = sqlx::query("SELECT * FROM work_runs WHERE id=$1 AND scope_key=$2 FOR UPDATE")
        .bind(run_id).bind(&scope_key).fetch_optional(&mut *tx).await.map_err(db_error)?.ok_or_else(unavailable)?;
    let status: String = row.get("status");
    if status == "completed" {
        let snapshot = decrypt(&state, &auth, &row.get::<Vec<u8>, _>("snapshot")).await?;
        tx.commit().await.map_err(db_error)?;
        return Ok(Json(row_run(&row, snapshot)));
    }
    if !active(&status) || row.get::<Option<chrono::DateTime<chrono::Utc>>, _>("cancel_requested_at").is_some() {
        return Err(AppError::Conflict("only an active, non-cancelled work run can be completed".into()));
    }
    let now = chrono::Utc::now();
    let live_lease = row.get::<Option<Uuid>, _>("lease_token").is_some()
        && row.get::<Option<chrono::DateTime<chrono::Utc>>, _>("lease_until").is_some_and(|until| until > now);
    if live_lease { return Err(AppError::Conflict("a live work turn must finish before the run can be completed".into())); }
    let pending: i64 = sqlx::query_scalar("SELECT count(*) FROM work_operations WHERE run_id=$1 AND status IN ('pending','reconciling')")
        .bind(run_id).fetch_one(&mut *tx).await.map_err(db_error)?;
    if pending != 0 { return Err(AppError::Conflict("unresolved work operations must be reconciled before completion".into())); }
    let mut snapshot = decrypt(&state, &auth, &row.get::<Vec<u8>, _>("snapshot")).await?;
    let steps = snapshot.get("plan").and_then(|plan| plan.get("steps")).and_then(Value::as_array)
        .filter(|steps| !steps.is_empty()).ok_or_else(|| AppError::Conflict("the work run has no valid plan to complete".into()))?;
    let statuses = snapshot.get("stepStatus").and_then(Value::as_object).ok_or_else(|| AppError::Internal("work step statuses are missing".into()))?;
    let evidence = snapshot.get("stepEvidence").and_then(Value::as_object).ok_or_else(|| AppError::Conflict("completed work steps require durable evidence".into()))?;
    for step in steps {
        let step_id = step.get("id").and_then(Value::as_str).ok_or_else(|| AppError::Internal("work plan step ID is invalid".into()))?;
        if statuses.get(step_id).and_then(Value::as_str) != Some("succeeded")
            || evidence.get(step_id).and_then(Value::as_array).is_none_or(Vec::is_empty) {
            return Err(AppError::Conflict("every work-plan step must succeed with durable evidence before run completion".into()));
        }
    }
    let completed_at = now.to_rfc3339();
    snapshot["completedAt"] = json!(completed_at);
    let encrypted = encrypt(&state, &auth, &snapshot).await?;
    let updated = sqlx::query("UPDATE work_runs SET status='completed',snapshot=$1,lease_token=NULL,lease_until=NULL,revision=revision+1,updated_at=now() WHERE id=$2 AND scope_key=$3 RETURNING *")
        .bind(encrypted).bind(run_id).bind(&scope_key).fetch_one(&mut *tx).await.map_err(db_error)?;
    sqlx::query("UPDATE work_run_worker_credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE run_id=$1 AND scope_key=$2 AND revoked_at IS NULL")
        .bind(run_id).bind(&scope_key).execute(&mut *tx).await.map_err(db_error)?;
    sqlx::query("UPDATE work_turns SET status='finished',finished_at=COALESCE(finished_at,now()) WHERE run_id=$1 AND status='running'")
        .bind(run_id).execute(&mut *tx).await.map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(row_run(&updated, snapshot)))
}

/// Request durable cancellation. A live turn is stopped at its next lease
/// renewal; unresolved side effects remain in reconciliation instead of being
/// described as cancelled.
pub async fn cancel(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Path(run_id): Path<String>,
    Json(input): Json<CancelRun>,
) -> Result<Json<Value>, AppError> {
    if !input.confirmed { return Err(bad("explicit cancellation confirmation is required")); }
    let run_id = uuid(&run_id)?;
    let scope_key = scope(&state, &auth).0;
    let mut tx = state.db.pool().begin().await.map_err(db_error)?;
    let row = sqlx::query("SELECT status,lease_token,lease_until,cancel_requested_at FROM work_runs WHERE id=$1 AND scope_key=$2 FOR UPDATE")
        .bind(run_id).bind(&scope_key).fetch_optional(&mut *tx).await.map_err(db_error)?.ok_or_else(unavailable)?;
    let status: String = row.get("status");
    let terminal = matches!(status.as_str(), "completed" | "cancelled" | "failed" | "delivered" | "settled" | "disputed" | "refunded");
    let now = chrono::Utc::now();
    let live_lease = row.get::<Option<Uuid>,_>("lease_token").is_some()
        && row.get::<Option<chrono::DateTime<chrono::Utc>>,_>("lease_until").is_some_and(|until| until > now);
    let pending: i64 = sqlx::query_scalar("SELECT count(*) FROM work_operations WHERE run_id=$1 AND status IN ('pending','reconciling')")
        .bind(run_id).fetch_one(&mut *tx).await.map_err(db_error)?;
    let next_status = if terminal { status.clone() }
        else if live_lease { status.clone() }
        else if pending > 0 { "reconciling".to_string() }
        else { "cancelled".to_string() };
    let cancel_at: Option<chrono::DateTime<chrono::Utc>> = if terminal {
        row.get("cancel_requested_at")
    } else {
        Some(sqlx::query_scalar("UPDATE work_runs SET cancel_requested_at=COALESCE(cancel_requested_at,now()),status=$1,lease_token=CASE WHEN $2 THEN lease_token ELSE NULL END,lease_until=CASE WHEN $2 THEN lease_until ELSE NULL END,revision=revision+1,updated_at=now() WHERE id=$3 RETURNING cancel_requested_at")
            .bind(&next_status).bind(live_lease).bind(run_id).fetch_one(&mut *tx).await.map_err(db_error)?)
    };
    if !live_lease {
        sqlx::query("UPDATE work_run_worker_credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE run_id=$1 AND scope_key=$2 AND revoked_at IS NULL")
            .bind(run_id).bind(&scope_key).execute(&mut *tx).await.map_err(db_error)?;
    }
    if !live_lease && pending > 0 {
        sqlx::query("UPDATE work_turns SET status='reconciling' WHERE run_id=$1 AND status='running'")
            .bind(run_id).execute(&mut *tx).await.map_err(db_error)?;
    } else if !live_lease && !terminal {
        sqlx::query("UPDATE work_turns SET status='failed',finished_at=COALESCE(finished_at,now()) WHERE run_id=$1 AND status='running'")
            .bind(run_id).execute(&mut *tx).await.map_err(db_error)?;
    }
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({
        "runId": run_id.to_string(),
        "status": next_status,
        "cancelRequested": cancel_at.is_some(),
        "cancelRequestedAt": cancel_at.map(|value| value.to_rfc3339()),
        "alreadyTerminal": terminal,
        "reconciliationRequired": pending > 0,
    })))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OperationPage { pub limit: Option<i64>, pub offset: Option<i64> }
pub async fn list_operations(State(state):State<Arc<AppState>>,Extension(auth):Extension<AuthInfo>,Path(id):Path<String>,Query(page):Query<OperationPage>)->Result<Json<Value>,AppError>{
    let run_id=uuid(&id)?;let key=scope(&state,&auth).0;
    let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM work_runs WHERE id=$1 AND scope_key=$2)").bind(run_id).bind(&key).fetch_one(state.db.pool()).await.map_err(db_error)?;
    if !exists{return Err(unavailable());}
    let limit=page.limit.unwrap_or(100).clamp(1,200);let offset=page.offset.unwrap_or(0).clamp(0,100000);
    let rows=sqlx::query("SELECT *,max_amount_mist::text AS max_amount_mist_text FROM work_operations WHERE run_id=$1 ORDER BY created_at,id LIMIT $2 OFFSET $3").bind(run_id).bind(limit+1).bind(offset).fetch_all(state.db.pool()).await.map_err(db_error)?;
    let has_next=rows.len() as i64>limit;
    let mut operations=Vec::with_capacity(limit as usize);
    for row in rows.into_iter().take(limit as usize){operations.push(operation_value(&state,&auth,&row,false).await?);}
    Ok(Json(json!({"operations":operations,"hasNext":has_next,"nextOffset":if has_next {Some(offset+limit)} else {None}})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields,rename_all="camelCase")]
pub struct PlanUpdate { pub turn_token: Option<String>, pub expected_plan_version: i64, pub plan: Value }
pub async fn save_plan(State(state): State<Arc<AppState>>, Extension(auth): Extension<AuthInfo>, Path(id): Path<String>, Json(input): Json<PlanUpdate>) -> Result<Json<Value>,AppError> {
    validate_plan(&input.plan)?;
    let id=uuid(&id)?; let key=scope(&state,&auth).0;
    let row=sqlx::query("SELECT * FROM work_runs WHERE id=$1 AND scope_key=$2").bind(id).bind(&key).fetch_optional(state.db.pool()).await.map_err(db_error)?.ok_or_else(unavailable)?;
    crate::work_turns::require_lease(&row,input.turn_token.as_deref())?;
    if !active(row.get::<String,_>("status").as_str()) || row.get::<i64,_>("plan_version") != input.expected_plan_version || row.get::<i64,_>("plan_version").checked_add(1) != Some(plan_version(&input.plan)?) { return Err(conflict()); }
    let mut snapshot=decrypt(&state,&auth,&row.get::<Vec<u8>,_>("snapshot")).await?;
    let old_steps=snapshot["plan"]["steps"].as_array().ok_or_else(|| bad("invalid stored plan"))?;
    for step in old_steps {
        let id=step["id"].as_str().ok_or_else(|| bad("invalid stored step"))?;
        if snapshot["stepStatus"][id] != "pending" && !input.plan["steps"].as_array().unwrap().iter().any(|s|s==step) { return Err(bad("started steps cannot be redefined or removed")); }
    }
    let states:serde_json::Map<String,Value>=input.plan["steps"].as_array().unwrap().iter().map(|s|{let id=s["id"].as_str().unwrap();(id.into(),snapshot["stepStatus"].get(id).cloned().unwrap_or(json!("pending")))}).collect();
    snapshot["plan"]=input.plan; snapshot["stepStatus"]=json!(states);
    let encrypted=encrypt(&state,&auth,&snapshot).await?;
    let row=sqlx::query("UPDATE work_runs SET snapshot=$1,plan_version=$2,revision=revision+1,updated_at=now() WHERE id=$3 AND scope_key=$4 AND plan_version=$5 AND revision=$6 AND lease_token=$7 AND lease_until>now() RETURNING *")
        .bind(encrypted).bind(plan_version(&snapshot["plan"])?).bind(id).bind(key).bind(input.expected_plan_version).bind(row.get::<i64,_>("revision")).bind(input.turn_token.as_deref().and_then(|v|Uuid::parse_str(v).ok())).fetch_optional(state.db.pool()).await.map_err(db_error)?.ok_or_else(conflict)?;
    Ok(Json(row_run(&row,snapshot)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields,rename_all="camelCase")]
pub struct Reserve { pub turn_token: Option<String>, pub tool_call_id:String, pub tool_name:String, pub input_hash:String, pub tool_input:Option<Value>, pub max_amount_mist: Option<String>, pub step_id: Option<String> }
fn validate_task_run_action(snapshot:&Value,tool_name:&str,tool_input:Option<&Value>)->Result<(),AppError>{
    if !tool_name.starts_with("task_"){return Ok(());}
    let linked_task=snapshot.get("taskId").and_then(Value::as_str);
    if tool_name=="task_create" {
        return if linked_task.is_none(){Ok(())}else{Err(AppError::Forbidden("a work run may create only its first task offer".into()))};
    }
    // The reservation endpoint journals registered action calls, not task reads. Keep this
    // allowlist explicit so a new task action cannot silently inherit the participant policy.
    let required_role=match tool_name {
        "task_accept"|"task_decline"|"task_deliver"|"task_upload_deliverable"=>Some("seller"),
        "task_cancel_offer"|"task_settle"=>Some("buyer"),
        "task_refund"|"task_release"|"task_expire_offer"
        |"task_propose_refund"|"task_accept_refund"|"task_reject_refund"|"task_withdraw_refund"
        |"task_review"|"task_open_dispute"|"task_respond_dispute"|"task_dispute_evidence"
        |"task_appeal_dispute"|"task_cancel_dispute"|"task_propose_dispute_settlement"
        |"task_accept_dispute_settlement"|"task_clear_dispute_settlement"=>None,
        _=>return Err(AppError::Forbidden("task action is not enabled for work-run execution".into())),
    };
    let linked_task=linked_task.ok_or_else(||AppError::Forbidden("task actions in a work run require its finalized linked task offer".into()))?;
    let request=tool_input.and_then(|input|input.get("request"));
    let target=[
        request.and_then(|value|value.get("taskId")).and_then(Value::as_str),
        request.and_then(|value|value.get("task_id")).and_then(Value::as_str),
        tool_input.and_then(|value|value.get("taskId")).and_then(Value::as_str),
        tool_input.and_then(|value|value.get("task_id")).and_then(Value::as_str),
    ].into_iter().flatten().next().ok_or_else(||bad("task action request is missing its task ID"))?;
    if !crate::chain_reads::same(target,linked_task){return Err(AppError::Forbidden("task action target does not match this work run's linked task".into()));}
    let role=snapshot.get("taskRole").and_then(Value::as_str);
    if !matches!(role,Some("buyer"|"seller")) {
        return Err(AppError::Forbidden("task action requires a verified buyer or seller role on this work run".into()));
    }
    if let Some(required)=required_role {
        if role!=Some(required){return Err(AppError::Forbidden(format!("{tool_name} is available only to the {required} participant of this linked task")));}
    }
    if tool_name=="task_review" {
        let requested=request.and_then(|value|value.get("raterRole")).and_then(Value::as_str);
        if requested!=role{return Err(AppError::Forbidden("task review role must match this run's authenticated buyer or seller role".into()));}
    }
    // Refund and dispute actions can be initiated by either participant, while counterparty,
    // proposer, appellant, status and deadline rules depend on current shared state. Those
    // dynamic rules remain enforced by the native Move entry points at execution time.
    Ok(())
}
async fn operation_value(state:&AppState,auth:&AuthInfo,row:&sqlx::postgres::PgRow,acquired:bool)->Result<Value,AppError>{
    let mut value=json!({"id":row.get::<Uuid,_>("id").to_string(),"runId":row.get::<Uuid,_>("run_id").to_string(),"toolCallId":row.get::<String,_>("tool_call_id"),"toolName":row.get::<String,_>("tool_name"),"inputHash":row.get::<String,_>("input_hash"),"idempotencyKey":row.get::<String,_>("idempotency_key"),"status":row.get::<String,_>("status"),"acquired":acquired});
    if let Ok(Some(cap))=row.try_get::<Option<String>,_>("max_amount_mist_text"){value["maxAmountMist"]=json!(cap);}
    if let Ok(Some(step_id))=row.try_get::<Option<String>,_>("step_id"){value["stepId"]=json!(step_id);}
    if let Some(encrypted)=row.get::<Option<Vec<u8>>,_>("result") { let result=decrypt(state,auth,&encrypted).await?; if let Some(output)=result.get("result"){value["result"]=output.clone();} if let Some(error)=result.get("error"){value["error"]=error.clone();} }
    Ok(value)
}
pub(crate) async fn authorize_ai_operation(state:&AppState,auth:&AuthInfo,run_id:&str,operation_id:&str,idempotency_key:&str)->Result<Option<String>,AppError>{
    let run_id=uuid(run_id)?;let operation_id=uuid(operation_id)?;let key=scope(state,auth).0;
    let row=sqlx::query("SELECT o.status,o.tool_name,o.idempotency_key,o.max_amount_mist::text AS max_amount_mist_text,r.lease_until,r.status AS run_status,r.cancel_requested_at FROM work_operations o JOIN work_runs r ON r.id=o.run_id WHERE o.id=$1 AND o.run_id=$2 AND r.scope_key=$3")
        .bind(operation_id).bind(run_id).bind(key).fetch_optional(state.db.pool()).await.map_err(db_error)?.ok_or_else(unavailable)?;
    if row.get::<String,_>("tool_name")!="ai_chat" || row.get::<String,_>("status")!="pending"
        || !active(row.get::<String,_>("run_status").as_str())
        || row.get::<String,_>("idempotency_key")!=idempotency_key
        || row.get::<Option<chrono::DateTime<chrono::Utc>>,_>("cancel_requested_at").is_some()
        || row.get::<Option<chrono::DateTime<chrono::Utc>>,_>("lease_until").is_none_or(|until|until<=chrono::Utc::now()) {
        return Err(conflict());
    }
    Ok(row.get::<Option<String>,_>("max_amount_mist_text"))
}
pub async fn reserve(State(state):State<Arc<AppState>>,Extension(auth):Extension<AuthInfo>,Path(run_id):Path<String>,Json(input):Json<Reserve>)->Result<Json<Value>,AppError>{
    if input.tool_call_id.is_empty() || input.tool_call_id.len()>200 || input.tool_name.is_empty() || input.tool_name.len()>100 || input.input_hash.len()!=64 || !input.input_hash.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){return Err(bad("invalid operation identity"));}
    if let Some(tool_input)=input.tool_input.as_ref(){
        if hex::encode(Sha256::digest(canonical_json(tool_input).as_bytes()))!=input.input_hash{return Err(bad("tool input does not match its canonical journal hash"));}
    }else if input.tool_name!="ai_chat"{return Err(bad("registered action journal requires its encrypted original tool input"));}
    let action_amount = input.tool_input.as_ref().map(|tool_input| action_spend_amount(&input.tool_name, tool_input)).transpose()?.flatten();
    match (input.tool_name.as_str(), input.max_amount_mist.as_deref()) {
        ("ai_chat", Some(value)) if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) => { value.parse::<u64>().map_err(|_| bad("AI MIST reservation metadata exceeds u64"))?; },
        ("ai_chat", None) => {},
        (_, Some(value)) if action_amount.is_some_and(|amount| value==amount.to_string()) => {},
        (_, None) if action_amount.is_none() => {},
        (_, None) => return Err(bad("agent-funded MYSO actions must journal their exact supported amount")),
        (_, Some(_)) => return Err(bad("MYSO action reservation must exactly match the supported amount in its encrypted tool input")),
    };
    if input.tool_name!="ai_chat"&&action_amount.is_none()&&input.step_id.is_some(){return Err(bad("step attribution is valid only for AI inference or journaled MYSO actions"));}
    if action_amount.is_some()&&input.step_id.is_none(){return Err(bad("agent-funded MYSO actions must be attributed to an active work-plan step"));}
    if input.step_id.as_deref().is_some_and(|step_id|step_id.is_empty()||step_id.len()>64||!step_id.bytes().all(|byte|byte.is_ascii_lowercase()||byte.is_ascii_digit()||byte==b'_'||byte==b'-')){return Err(bad("invalid AI step attribution"));}
    let run_id=uuid(&run_id)?;let mut tx=state.db.pool().begin().await.map_err(db_error)?;
    let run=sqlx::query("SELECT status,lease_token,lease_until,snapshot,cancel_requested_at FROM work_runs WHERE id=$1 AND scope_key=$2 FOR UPDATE").bind(run_id).bind(scope(&state,&auth).0).fetch_optional(&mut *tx).await.map_err(db_error)?.ok_or_else(unavailable)?;
    crate::work_turns::require_lease(&run,input.turn_token.as_deref())?;
    let snapshot=decrypt(&state,&auth,&run.get::<Vec<u8>,_>("snapshot")).await?;
    validate_task_run_action(&snapshot,&input.tool_name,input.tool_input.as_ref())?;
    if let Some(step_id)=input.step_id.as_deref(){
        let step=snapshot["plan"]["steps"].as_array().and_then(|steps|steps.iter().find(|step|step["id"].as_str()==Some(step_id))).ok_or_else(||bad("operation attribution names an unknown work step"))?;
        if !matches!(snapshot["stepStatus"][step_id].as_str(),Some("running"|"verifying")){return Err(AppError::Conflict("journal attribution requires an active work step".into()));}
        let _ = step;
    }
    // Return a prior operation even when the run now needs reconciliation.
    let prior=sqlx::query("SELECT *,max_amount_mist::text AS max_amount_mist_text FROM work_operations WHERE run_id=$1 AND tool_call_id=$2").bind(run_id).bind(&input.tool_call_id).fetch_optional(&mut *tx).await.map_err(db_error)?;
    if let Some(row)=prior {
        let prior_cap=row.get::<Option<String>,_>("max_amount_mist_text");
        if row.get::<String,_>("input_hash")!=input.input_hash || row.get::<String,_>("tool_name")!=input.tool_name || prior_cap!=input.max_amount_mist || row.get::<Option<String>,_>("step_id")!=input.step_id{return Err(conflict());}
        tx.commit().await.map_err(db_error)?;return Ok(Json(operation_value(&state,&auth,&row,false).await?));
    }
    if !active(run.get::<String,_>("status").as_str()) || run.get::<Option<chrono::DateTime<chrono::Utc>>,_>("cancel_requested_at").is_some(){return Err(conflict());}
    // One unresolved side effect at a time, including model reservations.
    let unresolved:i64=sqlx::query_scalar("SELECT count(*) FROM work_operations WHERE run_id=$1 AND status IN ('pending','reconciling')").bind(run_id).fetch_one(&mut *tx).await.map_err(db_error)?;
    if unresolved>0{return Err(conflict());}
    let id=Uuid::new_v4();let key=format!("work:{id}");let encrypted_input=if let Some(tool_input)=input.tool_input.as_ref(){Some(encrypt(&state,&auth,tool_input).await?)}else{None};
    let row=sqlx::query("INSERT INTO work_operations(id,run_id,tool_call_id,tool_name,input_hash,input_payload,idempotency_key,status,max_amount_mist,step_id) VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8::numeric,$9) RETURNING *,max_amount_mist::text AS max_amount_mist_text").bind(id).bind(run_id).bind(input.tool_call_id).bind(input.tool_name).bind(input.input_hash).bind(encrypted_input).bind(key).bind(input.max_amount_mist.as_deref()).bind(input.step_id.as_deref()).fetch_one(&mut *tx).await.map_err(db_error)?;
    let fenced = sqlx::query("UPDATE work_runs SET status='running',revision=revision+1,updated_at=now() WHERE id=$1 AND lease_token=$2 AND lease_until>now()").bind(run_id).bind(input.turn_token.as_deref().and_then(|v|Uuid::parse_str(v).ok())).execute(&mut *tx).await.map_err(db_error)?;
    if fenced.rows_affected()!=1 { return Err(conflict()); }
    tx.commit().await.map_err(db_error)?;Ok(Json(operation_value(&state,&auth,&row,true).await?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields,rename_all="camelCase")]
pub struct Settle { pub turn_token: Option<String>, pub status:String, pub result:Option<Value>, pub error:Option<String> }
pub async fn settle(State(state):State<Arc<AppState>>,Extension(auth):Extension<AuthInfo>,Path(id):Path<String>,Json(input):Json<Settle>)->Result<Json<Value>,AppError>{
    if !["succeeded","failed","reconciling"].contains(&input.status.as_str()) || input.error.as_ref().is_some_and(|s|s.len()>2000) {return Err(bad("invalid operation outcome"));}
    let id=uuid(&id)?;let key=scope(&state,&auth).0;
    let run_id:Uuid=sqlx::query_scalar("SELECT o.run_id FROM work_operations o JOIN work_runs r ON r.id=o.run_id WHERE o.id=$1 AND r.scope_key=$2").bind(id).bind(&key).fetch_optional(state.db.pool()).await.map_err(db_error)?.ok_or_else(unavailable)?;
    let result=json!({"result":input.result,"error":input.error});let hash=hex::encode(Sha256::digest(result.to_string().as_bytes()));
    let encrypted=encrypt(&state,&auth,&result).await?;
    let mut tx=state.db.pool().begin().await.map_err(db_error)?;
    // Lock runs before operations in every transaction to avoid inverted lock ordering.
    let leased_run=sqlx::query("SELECT id,lease_token,lease_until FROM work_runs WHERE id=$1 AND scope_key=$2 FOR UPDATE").bind(run_id).bind(&key).fetch_optional(&mut *tx).await.map_err(db_error)?.ok_or_else(unavailable)?;
    crate::work_turns::require_lease(&leased_run,input.turn_token.as_deref())?;
    let old=sqlx::query("SELECT status,result_hash,tool_name,max_amount_mist::text AS max_amount_mist_text FROM work_operations WHERE id=$1 FOR UPDATE").bind(id).fetch_one(&mut *tx).await.map_err(db_error)?;
    let old_status:String=old.get("status");
    if old_status!="pending" {
        if old_status==input.status && old.get::<Option<String>,_>("result_hash").as_deref()==Some(&hash){return Ok(Json(json!({"ok":true})));}
        return Err(conflict()); // Reconciliation requires a verified receipt adapter, never another model assertion.
    }
    let mut billed_amount: Option<String> = None;
    if old.get::<String,_>("tool_name")=="ai_chat" && input.status=="succeeded" {
        let amount=input.result.as_ref().and_then(|result|result.get("amount_mist")).and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.bytes().all(|byte|byte.is_ascii_digit())).ok_or_else(||bad("successful AI operation must include its exact MIST charge"))?;
        let amount_value=amount.parse::<u64>().map_err(|_|bad("AI charge exceeds u64 MIST"))?;
        let cap=old.get::<Option<String>,_>("max_amount_mist_text").and_then(|value|value.parse::<u64>().ok());
        let billing_state=input.result.as_ref().and_then(|result|result.get("billing_state")).and_then(Value::as_str);
        if cap.is_some_and(|cap|amount_value>cap) || !matches!(billing_state,Some("captured"|"cancelled_zero_cost")) || (billing_state==Some("cancelled_zero_cost")&&amount_value!=0) {return Err(AppError::Conflict("AI billing result exceeded provider reservation metadata or lacks a valid terminal charge state".into()));}
        billed_amount=Some(amount.to_owned());
    }
    sqlx::query("UPDATE work_operations SET status=$1,result=$2,result_hash=$3,amount_mist=$4::numeric,updated_at=now() WHERE id=$5").bind(&input.status).bind(encrypted).bind(hash).bind(billed_amount.as_deref()).bind(id).execute(&mut *tx).await.map_err(db_error)?;
    let fenced=sqlx::query("UPDATE work_runs SET status=CASE WHEN $1='reconciling' THEN 'reconciling' ELSE status END,revision=revision+1,updated_at=now() WHERE id=$2 AND lease_token=$3 AND lease_until>now()")
        .bind(&input.status).bind(run_id).bind(input.turn_token.as_deref().and_then(|v|Uuid::parse_str(v).ok())).execute(&mut *tx).await.map_err(db_error)?;
    if fenced.rows_affected()!=1 { return Err(conflict()); }
    tx.commit().await.map_err(db_error)?;Ok(Json(json!({"ok":true})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields,rename_all="camelCase")]
pub struct ReconcileActionReceipt { pub operation_id:String }

fn canonical_json(value:&Value)->String {
    match value {
        Value::Null|Value::Bool(_)|Value::Number(_) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).unwrap_or_default(),
        Value::Array(values) => format!("[{}]",values.iter().map(canonical_json).collect::<Vec<_>>().join(",")),
        Value::Object(values) => {
            let mut keys=values.keys().collect::<Vec<_>>();keys.sort();
            format!("{{{}}}",keys.into_iter().map(|key|format!("{}:{}",serde_json::to_string(key).unwrap_or_default(),canonical_json(&values[key]))).collect::<Vec<_>>().join(","))
        }
    }
}

fn registered_action_tool_name(action:&str)->Option<String>{
    let stem=action.strip_suffix(".v1")?;
    if stem.is_empty()||!stem.contains('.') { return None; }
    Some(stem.replace('.',"_"))
}

/// Resolve a held operation only when its exact MYDATA-encrypted input matches
/// the write-ahead journal and its server-issued idempotency key identifies the
/// same registered action. The configured fullnode receipt, never a model or
/// browser assertion, supplies the terminal result.
pub async fn reconcile_action_receipt(State(state):State<Arc<AppState>>,Extension(auth):Extension<AuthInfo>,Path(run_id):Path<String>,Json(input):Json<ReconcileActionReceipt>)->Result<Json<Value>,AppError>{
    let run_id=uuid(&run_id)?;let operation_id=uuid(&input.operation_id)?;let scope_key=scope(&state,&auth).0;
    let mut tx=state.db.pool().begin().await.map_err(db_error)?;
    let run=sqlx::query("SELECT * FROM work_runs WHERE id=$1 AND scope_key=$2 FOR UPDATE").bind(run_id).bind(&scope_key).fetch_optional(&mut *tx).await.map_err(db_error)?.ok_or_else(unavailable)?;
    if run.get::<Option<Uuid>,_>("lease_token").is_some() && run.get::<Option<chrono::DateTime<chrono::Utc>>,_>("lease_until").is_some_and(|until|until>chrono::Utc::now()) { return Err(conflict()); }
    let operation=sqlx::query("SELECT tool_name,input_hash,input_payload,idempotency_key,status FROM work_operations WHERE id=$1 AND run_id=$2 FOR UPDATE").bind(operation_id).bind(run_id).fetch_optional(&mut *tx).await.map_err(db_error)?.ok_or_else(unavailable)?;
    let old_status:String=operation.get("status");
    if !matches!(old_status.as_str(),"pending"|"reconciling") { return Ok(Json(json!({"resolved":false,"status":old_status,"reason":"operation_already_terminal"}))); }
    let tool_name:String=operation.get("tool_name");
    let input_hash:String=operation.get("input_hash");
    let idempotency_key:String=operation.get("idempotency_key");
    let Some(encrypted_input)=operation.get::<Option<Vec<u8>>,_>("input_payload") else { return Err(AppError::Conflict("encrypted original tool input is unavailable; operation remains held".into())); };
    tx.commit().await.map_err(db_error)?;
    let arguments=decrypt(&state,&auth,&encrypted_input).await?;
    let computed_hash=hex::encode(Sha256::digest(canonical_json(&arguments).as_bytes()));
    if computed_hash!=input_hash { return Err(AppError::Conflict("saved tool arguments do not match the journal input hash; operation remains held".into())); }

    let action=crate::chain_actions::get_by_idempotency_key(&state.db,&auth.account_id,&auth.agent_object_id,&idempotency_key).await?.ok_or_else(||AppError::BlobNotFound("No registered chain action exists for this work operation yet".into()))?;
    if action.account_id!=auth.account_id||action.agent_object_id!=auth.agent_object_id||action.idempotency_key!=idempotency_key||registered_action_tool_name(&action.registry_action).as_deref()!=Some(tool_name.as_str()) {
        return Err(AppError::Conflict("registered action does not match the saved tool call".into()));
    }
    let Some(digest)=action.digest.as_deref() else { return Ok(Json(json!({"resolved":false,"status":action.status,"reason":"registered_action_has_no_digest"}))); };
    let verified=crate::platform_reads::verify_prepared_action_receipt(&state,&auth,digest).await?;
    let receipt_status=verified.get("status").and_then(Value::as_str).ok_or_else(||AppError::Internal("receipt verifier omitted status".into()))?;
    if !matches!(receipt_status,"finalized"|"failed") { return Ok(Json(json!({"resolved":false,"status":receipt_status,"digest":digest,"reason":"receipt_not_terminal"}))); }
    if verified.get("digest").and_then(Value::as_str)!=Some(digest)||verified.get("registryAction").and_then(Value::as_str)!=Some(action.registry_action.as_str())||verified.get("evidenceSource").and_then(Value::as_str)!=Some("configured_fullnode_and_scoped_preparation") {
        return Err(AppError::Conflict("fullnode receipt did not match the scoped prepared action; operation remains held".into()));
    }
    let successful=receipt_status=="finalized";
    let gas_cost_mist=verified.get("gasCostMist").and_then(Value::as_str).map(str::to_owned);
    if let Some(cost)=gas_cost_mist.as_deref() {
        if cost.is_empty() || (cost.len()>1&&cost.starts_with('0')) || !cost.bytes().all(|byte|byte.is_ascii_digit()) { return Err(AppError::Conflict("verified action gas charge is not canonical MIST".into())); }
        cost.parse::<u64>().map_err(|_|conflict())?;
    }
    let result=if successful {json!({"ok":true,"data":{"digest":digest,"transactionDigest":digest,"recoveredFromVerifiedReceipt":true}})}
        else {json!({"ok":false,"error":{"code":"CHAIN_ACTION_FAILED","message":"The configured fullnode verified that this registered action failed."}})};
    let stored=json!({"result":result,"error":if successful {Value::Null}else{json!("Verified failed transaction receipt")}});
    let stored_hash=hex::encode(Sha256::digest(stored.to_string().as_bytes()));
    let encrypted=encrypt(&state,&auth,&stored).await?;
    let mut tx=state.db.pool().begin().await.map_err(db_error)?;
    let leased=sqlx::query("SELECT * FROM work_runs WHERE id=$1 AND scope_key=$2 FOR UPDATE").bind(run_id).bind(&scope_key).fetch_optional(&mut *tx).await.map_err(db_error)?.ok_or_else(unavailable)?;
    if leased.get::<Option<Uuid>,_>("lease_token").is_some() && leased.get::<Option<chrono::DateTime<chrono::Utc>>,_>("lease_until").is_some_and(|until|until>chrono::Utc::now()) { return Err(conflict()); }
    let changed=sqlx::query("UPDATE work_operations SET status=$1,result=$2,result_hash=$3,amount_mist=CASE WHEN $7 THEN COALESCE(max_amount_mist,amount_mist) WHEN tool_name=ANY(ARRAY['access_purchase_mydata_access','access_purchase_post_access','task_create','spt_buy']) THEN 0 ELSE amount_mist END,gas_cost_mist=COALESCE($8::numeric,gas_cost_mist),updated_at=now() WHERE id=$4 AND run_id=$5 AND status IN ('pending','reconciling') AND idempotency_key=$6")
        .bind(if successful{"succeeded"}else{"failed"}).bind(encrypted).bind(stored_hash).bind(operation_id).bind(run_id).bind(&idempotency_key).bind(successful).bind(gas_cost_mist.as_deref()).execute(&mut *tx).await.map_err(db_error)?;
    if changed.rows_affected()!=1{return Err(conflict());}
    let updated=sqlx::query("UPDATE work_runs SET revision=revision+1,updated_at=now() WHERE id=$1 AND (lease_token IS NULL OR lease_until<=now())")
        .bind(run_id).execute(&mut *tx).await.map_err(db_error)?;
    if updated.rows_affected()!=1{return Err(conflict());}
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({"resolved":true,"status":if successful{"succeeded"}else{"failed"},"digest":digest,"registryAction":action.registry_action,"parameterHash":action.parameter_hash,"verification":receipt_status})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields,rename_all="camelCase")]
pub struct ReconcileTaskUpload { pub operation_id:String }

/// Recover an R2 task upload by its compact encrypted task/key/content-digest
/// reference. It verifies the participant ledger and the actual R2 bytes and
/// never repeats PutObject or accepts bytes from the caller.
pub async fn reconcile_task_upload(State(state):State<Arc<AppState>>,Extension(auth):Extension<AuthInfo>,Path(run_id):Path<String>,Json(input):Json<ReconcileTaskUpload>)->Result<Json<Value>,AppError>{
    let run_id=uuid(&run_id)?;let operation_id=uuid(&input.operation_id)?;let scope_key=scope(&state,&auth).0;
    let mut tx=state.db.pool().begin().await.map_err(db_error)?;
    let run=sqlx::query("SELECT * FROM work_runs WHERE id=$1 AND scope_key=$2 FOR UPDATE").bind(run_id).bind(&scope_key).fetch_optional(&mut *tx).await.map_err(db_error)?.ok_or_else(unavailable)?;
    if run.get::<Option<Uuid>,_>("lease_token").is_some()&&run.get::<Option<chrono::DateTime<chrono::Utc>>,_>("lease_until").is_some_and(|until|until>chrono::Utc::now()){return Err(conflict());}
    let operation=sqlx::query("SELECT tool_name,input_hash,input_payload,status FROM work_operations WHERE id=$1 AND run_id=$2 FOR UPDATE").bind(operation_id).bind(run_id).fetch_optional(&mut *tx).await.map_err(db_error)?.ok_or_else(unavailable)?;
    if operation.get::<String,_>("tool_name")!="task_upload_deliverable"{return Err(bad("operation is not a task artifact upload"));}
    let old_status:String=operation.get("status");
    let already_succeeded=old_status=="succeeded";
    if !already_succeeded&&!matches!(old_status.as_str(),"pending"|"reconciling"){return Ok(Json(json!({"resolved":false,"status":old_status,"reason":"operation_is_not_reconcilable"})));}
    let input_hash:String=operation.get("input_hash");
    let Some(encrypted_input)=operation.get::<Option<Vec<u8>>,_>("input_payload")else{return Err(AppError::Conflict("encrypted upload recovery reference is unavailable; operation remains held".into()));};
    let _=tx.commit().await.map_err(db_error)?;
    let tool_input=decrypt(&state,&auth,&encrypted_input).await?;
    if hex::encode(Sha256::digest(canonical_json(&tool_input).as_bytes()))!=input_hash{return Err(AppError::Conflict("encrypted upload reference does not match the operation hash".into()));}
    let raw_task_id=tool_input.pointer("/request/taskId").and_then(Value::as_str).ok_or_else(||bad("upload task ID is unavailable"))?;
    let raw_task_id=raw_task_id.strip_prefix("0x").unwrap_or(raw_task_id);
    if raw_task_id.is_empty()||raw_task_id.len()>64||!raw_task_id.bytes().all(|byte|byte.is_ascii_hexdigit()){return Err(bad("upload task ID is invalid"));}
    let task_id=format!("0x{:0>64}",raw_task_id.to_ascii_lowercase());
    let upload_key=tool_input.pointer("/request/idempotencyKey").and_then(Value::as_str).filter(|value|!value.is_empty()&&value.len()<=128).ok_or_else(||bad("upload idempotency key is unavailable"))?;
    let expected_digest=tool_input.pointer("/request/contentDigestHex").and_then(Value::as_str).filter(|value|value.len()==64&&value.bytes().all(|byte|byte.is_ascii_hexdigit())).ok_or_else(||bad("upload content digest is unavailable"))?.to_ascii_lowercase();
    let snapshot_row=sqlx::query("SELECT snapshot FROM work_runs WHERE id=$1 AND scope_key=$2").bind(run_id).bind(&scope_key).fetch_optional(state.db.pool()).await.map_err(db_error)?.ok_or_else(unavailable)?;
    let snapshot=decrypt(&state,&auth,&snapshot_row.get::<Vec<u8>,_>("snapshot")).await?;
    if snapshot.get("taskId").and_then(Value::as_str).is_none_or(|linked|!crate::chain_reads::same(linked,&task_id)){return Err(AppError::Forbidden("upload task does not match the linked work run".into()));}
    let retry=json!({"taskId":task_id,"idempotencyKey":upload_key,"digestHex":expected_digest});
    let Some((ledger_digest,ledger_status,ledger_uri,storage_namespace))=state.db.get_task_deliverable_upload(&auth.account_id,&auth.agent_object_id,&task_id,&upload_key).await?else{return Ok(Json(json!({"resolved":false,"status":"pending","reason":"no_upload_ledger_record","retry":retry})));};
    if ledger_digest!=expected_digest{return Err(AppError::Conflict("upload ledger content does not match the saved operation digest".into()));}
    let owner=crate::memory_contract::normalize_object_id(&auth.owner);
    let store=state.r2.as_ref().ok_or_else(||AppError::Internal("Cloudflare R2 is not configured for task artifact verification".into()))?;
    let (uri,object_id,needs_ledger_completion)=if ledger_status=="uploaded"{
        let uri=ledger_uri.ok_or_else(||AppError::Conflict("completed upload ledger has no R2 URI".into()))?;
        let prefix=format!("r2://{owner}/");
        let object_id=uri.strip_prefix(&prefix).filter(|value|value.len()==64&&value.bytes().all(|byte|byte.is_ascii_hexdigit())).ok_or_else(||AppError::Conflict("upload URI is not scoped to the authenticated R2 owner".into()))?.to_owned();
        (uri,object_id,false)
    }else if ledger_status=="pending"&&ledger_uri.is_none(){
        let suffix=storage_namespace.strip_prefix("task-deliverable-").filter(|value|value.len()==64&&value.bytes().all(|byte|byte.is_ascii_hexdigit())).ok_or_else(||AppError::Conflict("pending upload namespace is not a recognized R2 task artifact".into()))?;
        let object_id=hex::encode(Sha256::digest(storage_namespace.as_bytes()));
        let uri=format!("r2://{owner}/{object_id}");
        if object_id.len()!=64||suffix.len()!=64{return Err(conflict());}
        (uri,object_id,true)
    }else{return Ok(Json(json!({"resolved":false,"status":ledger_status,"reason":"r2_upload_is_not_recorded_complete"})));};
    let bytes=match store.get_task_artifact(&owner,&object_id).await{Ok(bytes)=>bytes,Err(AppError::BlobNotFound(_)) if ledger_status=="pending"||ledger_status=="uploaded"=>return Ok(Json(json!({"resolved":false,"status":"pending","reason":"r2_object_not_yet_available","retry":retry}))),Err(AppError::BlobNotFound(_))=>return Ok(Json(json!({"resolved":false,"status":"pending","reason":"r2_object_not_yet_available"}))),Err(error)=>return Err(error)};
    let content_length=bytes.len();
    if content_length==0||content_length>512*1024||hex::encode(Sha256::digest(&bytes))!=expected_digest{return Err(AppError::Conflict("stored R2 bytes do not match the saved artifact digest".into()));}
    if needs_ledger_completion{state.db.complete_task_deliverable_upload(&auth.account_id,&auth.agent_object_id,&task_id,&upload_key,&uri).await?;}
    if !state.db.task_deliverable_upload_matches(&auth.account_id,&auth.agent_object_id,&task_id,&uri,&expected_digest).await?{return Err(AppError::Conflict("R2 URI is not present in the authenticated participant upload ledger".into()));}
    let data=json!({"taskId":task_id,"uri":uri,"digestHex":expected_digest,"contentLength":content_length,"storage":"cloudflare_r2","idempotentReplay":true,"disclosure":"Artifact bytes are stored in the private Cloudflare R2 bucket and released only through participant-authorized task retrieval."});
    if already_succeeded{return Ok(Json(json!({"resolved":true,"status":"succeeded","taskId":task_id,"uri":uri,"digestHex":expected_digest,"contentLength":content_length,"verification":"participant_upload_ledger_and_r2_bytes"})));}
    let stored=json!({"result":{"ok":true,"data":data},"error":Value::Null});
    let stored_hash=hex::encode(Sha256::digest(stored.to_string().as_bytes()));
    let encrypted_result=encrypt(&state,&auth,&stored).await?;
    let mut tx=state.db.pool().begin().await.map_err(db_error)?;
    let leased=sqlx::query("SELECT * FROM work_runs WHERE id=$1 AND scope_key=$2 FOR UPDATE").bind(run_id).bind(&scope_key).fetch_optional(&mut *tx).await.map_err(db_error)?.ok_or_else(unavailable)?;
    if leased.get::<Option<Uuid>,_>("lease_token").is_some()&&leased.get::<Option<chrono::DateTime<chrono::Utc>>,_>("lease_until").is_some_and(|until|until>chrono::Utc::now()){return Err(conflict());}
    let changed=sqlx::query("UPDATE work_operations SET status='succeeded',result=$1,result_hash=$2,updated_at=now() WHERE id=$3 AND run_id=$4 AND status IN ('pending','reconciling') AND tool_name='task_upload_deliverable' AND input_hash=$5")
        .bind(encrypted_result).bind(stored_hash).bind(operation_id).bind(run_id).bind(&input_hash).execute(&mut *tx).await.map_err(db_error)?;
    if changed.rows_affected()!=1{return Err(conflict());}
    let updated=sqlx::query("UPDATE work_runs SET revision=revision+1,updated_at=now() WHERE id=$1 AND (lease_token IS NULL OR lease_until<=now())").bind(run_id).execute(&mut *tx).await.map_err(db_error)?;
    if updated.rows_affected()!=1{return Err(conflict());}
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({"resolved":true,"status":"succeeded","taskId":task_id,"uri":uri,"digestHex":expected_digest,"contentLength":content_length,"verification":"participant_upload_ledger_and_r2_bytes"})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields,rename_all="camelCase")]
pub struct AppendActionReceipt { pub turn_token:String, pub operation_id:String }

/// Re-read an already journaled task action from the configured fullnode and
/// attach its scoped receipt. The caller supplies an operation ID, never a
/// digest or a claimed verification result.
pub async fn append_action_receipt(State(state):State<Arc<AppState>>,Extension(auth):Extension<AuthInfo>,Path(run_id):Path<String>,Json(input):Json<AppendActionReceipt>)->Result<Json<Value>,AppError>{
    let run_id=uuid(&run_id)?;let operation_id=uuid(&input.operation_id)?;let scope_key=scope(&state,&auth).0;
    let run=sqlx::query("SELECT * FROM work_runs WHERE id=$1 AND scope_key=$2").bind(run_id).bind(&scope_key).fetch_optional(state.db.pool()).await.map_err(db_error)?.ok_or_else(unavailable)?;
    crate::work_turns::require_lease(&run,Some(&input.turn_token))?;
    let operation=sqlx::query("SELECT tool_name,status,result FROM work_operations WHERE id=$1 AND run_id=$2").bind(operation_id).bind(run_id).fetch_optional(state.db.pool()).await.map_err(db_error)?.ok_or_else(unavailable)?;
    if operation.get::<String,_>("status")!="succeeded" { return Err(conflict()); }
    let tool_name:String=operation.get("tool_name");
    if tool_name=="task_upload_deliverable" { return Err(bad("R2 task uploads use the task-artifact evidence adapter")); }
    let encrypted=operation.get::<Option<Vec<u8>>,_>("result").ok_or_else(conflict)?;
    let outcome=decrypt(&state,&auth,&encrypted).await?;
    let data=outcome.get("result").and_then(|result|result.get("data")).ok_or_else(conflict)?;
    if outcome.get("result").and_then(|result|result.get("ok")).and_then(Value::as_bool)!=Some(true){return Err(conflict());}
    let digest=data.get("digest").or_else(||data.get("transactionDigest")).or_else(||data.get("txDigest")).or_else(||data.pointer("/chain/digest")).and_then(Value::as_str).ok_or_else(||bad("chain action did not return its submitted transaction digest"))?;
    let verified=crate::platform_reads::verify_prepared_action_receipt(&state,&auth,digest).await?;
    let status=verified.get("status").and_then(Value::as_str).ok_or_else(||AppError::Internal("task receipt verifier omitted status".into()))?;
    let verification=match status { "finalized"=>"verified", "failed"=>"rejected", _=>"pending" };
    let task_id=verified.get("taskId").filter(|value|!value.is_null()).cloned().or_else(||verified.pointer("/events/0/data/task_id").cloned());
    let now=chrono::Utc::now().to_rfc3339();
    let kind=match tool_name.as_str(){"task_deliver"=>"task_delivery","task_settle"=>"task_settlement",_=>"action"};
    let mut receipt=json!({"id":operation_id.to_string(),"kind":kind,"operationId":operation_id.to_string(),"digest":digest,"verification":verification,"recordedAt":now});
    let verified_gas_cost=verified.get("gasCostMist").and_then(Value::as_str).map(str::to_owned);
    if let Some(gas_cost)=verified_gas_cost.as_deref() {
        if gas_cost.is_empty() || (gas_cost.len() > 1 && gas_cost.starts_with('0')) || !gas_cost.bytes().all(|byte| byte.is_ascii_digit()) || gas_cost.parse::<u64>().is_err() {
            return Err(AppError::Conflict("Verified action gas charge is not canonical u64 MIST".into()));
        }
        receipt["gasCostMist"]=json!(gas_cost);
    }
    if let Some(task_id)=task_id.as_ref() { receipt["taskId"]=task_id.clone(); }
    if tool_name=="task_deliver" {
        if let Some(artifact_digest)=verified.get("deliverableDigestHex").and_then(Value::as_str) { receipt["artifactDigest"]=json!(artifact_digest); }
    }
    let operation_id_text=operation_id.to_string();
    let mut tx=state.db.pool().begin().await.map_err(db_error)?;
    let leased=sqlx::query("SELECT * FROM work_runs WHERE id=$1 AND scope_key=$2 FOR UPDATE").bind(run_id).bind(&scope_key).fetch_optional(&mut *tx).await.map_err(db_error)?.ok_or_else(unavailable)?;
    crate::work_turns::require_lease(&leased,Some(&input.turn_token))?;
    if let Some(gas_cost)=verified_gas_cost.as_deref() {
        sqlx::query("UPDATE work_operations SET gas_cost_mist=$1::numeric,updated_at=now() WHERE id=$2 AND run_id=$3")
            .bind(gas_cost).bind(operation_id).bind(run_id).execute(&mut *tx).await.map_err(db_error)?;
    }
    let mut snapshot=decrypt(&state,&auth,&leased.get::<Vec<u8>,_>("snapshot")).await?;
    let mut verified_task_state=None;
    let mut verified_task_history_rows=Vec::new();
    let mut verified_task_source_ids=Vec::new();
    let mut verified_task_event_evidence:Vec<Value>=Vec::new();
    let task_lifecycle = if tool_name=="task_create" && snapshot.get("taskId").and_then(Value::as_str).is_none() && verification!="verified" {
        // The offer has not reached a verified fullnode receipt yet. Keep the
        // operation pending/recoverable, but do not attach an unconfirmed task.
        None
    } else if tool_name.starts_with("task_") {
        let action=verified.get("registryAction").and_then(Value::as_str).filter(|action|action.starts_with("task.")&&action.ends_with(".v1")).ok_or_else(||AppError::Conflict("task receipt omitted its registered task action".into()))?;
        let linked_task=if tool_name=="task_create" {
            if snapshot.get("taskId").and_then(Value::as_str).is_some() || action!="task.create.v1" || verification!="verified" {
                return Err(AppError::Conflict("a work run may bind exactly one task, only after its finalized task.offer receipt".into()));
            }
            let created=crate::chain_reads::id(task_id.as_ref().and_then(Value::as_str).ok_or_else(||AppError::Conflict("finalized task offer omitted its task ID".into()))?)?;
            let offer_matches=verified.get("events").and_then(Value::as_array).is_some_and(|events|events.iter().any(|event|
                event.get("type").and_then(Value::as_str).is_some_and(|name|name.ends_with("::agent_task::TaskOffered"))
                    && event.pointer("/data/task_id").and_then(Value::as_str).is_some_and(|actual|crate::chain_reads::same(actual,&created))
            ));
            if !offer_matches { return Err(AppError::Conflict("task creation receipt lacks the exact finalized TaskOffered event".into())); }
            snapshot["taskId"]=json!(created);
            snapshot["taskRole"]=json!("buyer");
            snapshot.get("taskId").and_then(Value::as_str).ok_or_else(conflict)?
        } else {
            snapshot.get("taskId").and_then(Value::as_str).ok_or_else(||AppError::Conflict("task action receipt cannot attach to an unlinked work run".into()))?
        };
        if task_id.as_ref().and_then(Value::as_str).is_none_or(|actual|!crate::chain_reads::same(actual,linked_task)) {
            return Err(AppError::Conflict("task action receipt does not match the work run's linked task".into()));
        }
        let verified_events=verified.get("events").and_then(Value::as_array);
        let event_types=verified_events.map(|events|events.iter().filter_map(|event|event.get("type").and_then(Value::as_str).map(str::to_owned)).take(32).collect::<Vec<_>>()).unwrap_or_default();
        if verification=="verified" {
            for event in verified_events.into_iter().flatten() {
                let Some(event_type)=event.get("type").and_then(Value::as_str) else { continue; };
                let Some(sequence)=event.get("eventSeq").and_then(Value::as_str).and_then(|value|value.parse::<u64>().ok()) else { continue; };
                let source_event_id=format!("{digest}:{sequence}");
                let task_event=event_type.contains("::agent_task::")
                    && event.pointer("/data/task_id").and_then(Value::as_str).is_some_and(|id|crate::chain_reads::same(id,linked_task));
                let jury_event=event_type.contains("::jury::")
                    && verified.get("caseId").and_then(Value::as_str).is_some_and(|case_id|
                        event.pointer("/data/case_id").and_then(Value::as_str).is_some_and(|id|crate::chain_reads::same(id,case_id))
                    );
                if !task_event && !jury_event { continue; }
                if verified_task_event_evidence.len()<32 && !verified_task_event_evidence.iter().any(|item|item.get("sourceEventId").and_then(Value::as_str)==Some(source_event_id.as_str())) {
                    verified_task_event_evidence.push(json!({"eventType":event_type,"sourceEventId":source_event_id.clone()}));
                }
                if task_event&&!verified_task_source_ids.iter().any(|id|id==&source_event_id) { verified_task_source_ids.push(source_event_id.clone()); }
                if !task_event { continue; }
                let Some(status)=task_transition_status(event_type) else { continue; };
                let Some(occurred_at_ms)=event.get("occurredAtMs").and_then(Value::as_str).and_then(|value|value.parse::<u64>().ok()) else { continue; };
                let checkpoint=verified.get("checkpoint").and_then(|value|value.as_str().and_then(|text|text.parse::<u64>().ok()).or_else(||value.as_u64()));
                verified_task_history_rows.push(json!({
                    "eventType":event_type,
                    "occurredAtMs":occurred_at_ms,
                    "sourceEventId":source_event_id,
                    "status":status,
                    "digest":digest,
                    "verification":"finalized_fullnode_task_event",
                    "checkpoint":checkpoint.map(|value|value.to_string()),
                    "operationId":operation_id_text
                }));
            }
            let transition=verified_events.into_iter().flatten().rev().find_map(|event|{
                let event_type=event.get("type")?.as_str()?;
                let status=match event_type.rsplit("::").next()? {
                    "TaskOffered"=>0,"TaskAccepted"=>1,"TaskDelivered"=>2,"TaskReceiptSettled"=>3,
                    "TaskRefunded"=>4,"TaskCancelled"=>5,"TaskDisputed"=>6,_=>return None,
                };
                let event_task_id=event.pointer("/data/task_id")?.as_str()?;
                if !crate::chain_reads::same(event_task_id,linked_task) { return None; }
                let sequence=event.get("eventSeq").and_then(|value|value.as_str().and_then(|text|text.parse::<u64>().ok()));
                Some((status,event_type.to_owned(),sequence))
            });
            if let Some((status,event_type,sequence))=transition {
                let checkpoint=verified.get("checkpoint").and_then(|value|value.as_str().map(str::to_owned).or_else(||value.as_u64().map(|number|number.to_string())));
                let mut state=json!({"taskId":linked_task,"status":status,"transactionDigest":digest,"operationId":operation_id_text,"eventType":event_type,"evidence":"finalized_fullnode_task_event","recordedAt":now});
                if let Some(checkpoint)=checkpoint { state["checkpoint"]=json!(checkpoint); }
                if let Some(sequence)=sequence { state["sourceEventId"]=json!(format!("{digest}:{sequence}")); }
                verified_task_state=Some(state);
            }
        }
        Some(json!({"taskId":linked_task,"action":action,"operationId":operation_id_text,"digest":digest,"verification":verification,"eventTypes":event_types,"sourceEvidenceIds":verified_task_source_ids.clone(),"eventEvidence":verified_task_event_evidence.clone(),"recordedAt":now}))
    } else { None };
    if verification=="verified"&&!verified_task_source_ids.is_empty() {
        receipt["sourceEvidenceIds"]=json!(verified_task_source_ids);
    }
    if verification=="verified"&&!verified_task_event_evidence.is_empty() {
        receipt["eventEvidence"]=json!(verified_task_event_evidence);
    }
    if tool_name=="task_deliver" && verification=="verified" {
        let task_id=verified.get("taskId").and_then(Value::as_str).ok_or_else(||AppError::Internal("verified delivery omitted task identity".into()))?;
        let artifact_digest=verified.get("deliverableDigestHex").and_then(Value::as_str).ok_or_else(||AppError::Internal("verified delivery omitted artifact digest".into()))?;
        let source_event_id=verified_task_history_rows.iter().find(|event|event.get("eventType").and_then(Value::as_str).and_then(|name|name.rsplit("::").next())==Some("TaskDelivered")&&event.get("digest").and_then(Value::as_str)==Some(digest)).and_then(|event|event.get("sourceEventId")).and_then(Value::as_str).ok_or_else(||AppError::Conflict("verified task delivery omitted its finalized TaskDelivered evidence identity".into()))?.to_owned();
        receipt["sourceEvidenceIds"]=json!([source_event_id]);
        let artifacts=snapshot["artifacts"].as_array_mut().ok_or_else(||AppError::Internal("invalid work artifact list".into()))?;
        let artifact=artifacts.iter_mut().find(|item| item.get("taskId").and_then(Value::as_str).is_some_and(|id|crate::chain_reads::same(id,task_id)) && item.get("contentDigest").and_then(Value::as_str)==Some(artifact_digest));
        if let Some(artifact)=artifact {
            artifact["verification"]=json!("verified");
            artifact["transactionDigest"]=json!(digest);
            let links=artifact["sourceEvidenceIds"].as_array_mut().ok_or_else(||AppError::Internal("task artifact evidence links are invalid".into()))?;
            if !links.iter().any(|value|value.as_str()==Some(source_event_id.as_str())) { links.push(json!(source_event_id)); }
        }
    }
    let receipts=snapshot["receipts"].as_array_mut().ok_or_else(||AppError::Internal("invalid work receipt list".into()))?;
    if receipts.len()>1000{return Err(bad("work receipt limit reached"));}
    if let Some(existing)=receipts.iter_mut().find(|item|item.get("operationId").and_then(Value::as_str)==Some(operation_id_text.as_str())){
        if existing.get("digest").and_then(Value::as_str)!=Some(digest){return Err(conflict());}
        *existing=receipt.clone();
    }else{receipts.push(receipt.clone());}
    if let Some(lifecycle)=task_lifecycle {
        let events=snapshot["taskLifecycleEvents"].as_array_mut();
        if events.is_none() { snapshot["taskLifecycleEvents"]=json!([]); }
        let events=snapshot["taskLifecycleEvents"].as_array_mut().ok_or_else(||AppError::Internal("invalid task lifecycle event list".into()))?;
        if events.len()>500 { return Err(bad("task lifecycle event limit reached")); }
        if let Some(existing)=events.iter_mut().find(|item|item.get("operationId").and_then(Value::as_str)==Some(operation_id_text.as_str())) { *existing=lifecycle; }
        else { events.push(lifecycle); }
    }
    if let Some(task_state)=verified_task_state {
        snapshot["verifiedTaskState"]=task_state;
    }
    if !verified_task_history_rows.is_empty() {
        if snapshot.get("taskHistory").and_then(Value::as_object).is_none() {
            snapshot["taskHistory"]=json!({"taskId":snapshot.get("taskId").cloned().unwrap_or(Value::Null),"events":[],"evidenceSource":"participant_indexed_history_with_fullnode_event_checks","nextOffset":0,"truncated":false});
        }
        let history=&mut snapshot["taskHistory"];
        let mut cap_hit=false;
        {
            let events=history.get_mut("events").and_then(Value::as_array_mut).ok_or_else(||AppError::Internal("invalid work task history list".into()))?;
            for event in verified_task_history_rows {
                let source_id=event.get("sourceEventId").and_then(Value::as_str).unwrap_or("");
                let event_type=event.get("eventType").and_then(Value::as_str).unwrap_or("");
                if !events.iter().any(|existing|existing.get("sourceEventId").and_then(Value::as_str)==Some(source_id)&&existing.get("eventType").and_then(Value::as_str)==Some(event_type)) {
                    if events.len()>=10_000 { cap_hit=true; break; }
                    events.push(event);
                }
            }
            events.sort_by(|left,right| {
                let order=|event:&Value| {
                    let checkpoint=event.get("checkpoint").and_then(|value|value.as_str().and_then(|text|text.parse::<u64>().ok())).unwrap_or(0);
                    let sequence=event.get("sourceEventId").and_then(Value::as_str).and_then(|source|source.rsplit_once(':')).and_then(|(_,value)|value.parse::<u64>().ok()).unwrap_or(0);
                    (checkpoint,sequence)
                };
                order(left).cmp(&order(right))
            });
        }
        if cap_hit { history["truncated"]=json!(true); history["nextOffset"]=Value::Null; }
    }
    if let Some(projected)=project_verified_task_state(&snapshot["taskHistory"],snapshot.get("verifiedTaskState")) {
        snapshot["verifiedTaskState"]=projected;
    }
    if verification=="rejected" {
        sqlx::query("UPDATE work_operations SET amount_mist=0,updated_at=now() WHERE id=$1 AND run_id=$2 AND tool_name=ANY(ARRAY['access_purchase_mydata_access','access_purchase_post_access','task_create','spt_buy'])")
            .bind(operation_id).bind(run_id).execute(&mut *tx).await.map_err(db_error)?;
    }
    let encrypted_snapshot=encrypt(&state,&auth,&snapshot).await?;
    let saved=sqlx::query("UPDATE work_runs SET snapshot=$1,revision=revision+1,updated_at=now() WHERE id=$2 AND scope_key=$3 AND lease_token=$4 AND lease_until>now() RETURNING id")
        .bind(encrypted_snapshot).bind(run_id).bind(scope_key).bind(Uuid::parse_str(&input.turn_token).map_err(|_|bad("invalid work turn token"))?).fetch_optional(&mut *tx).await.map_err(db_error)?.ok_or_else(conflict)?;
    drop(saved);tx.commit().await.map_err(db_error)?;Ok(Json(json!({"receipt":receipt,"verificationEvidence":verified})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields,rename_all="camelCase")]
pub struct AppendTaskArtifact { pub turn_token:String, pub operation_id:String }

/// Attach a successful, R2-backed task upload to the linked encrypted work run.
/// Upload identity and content digest are re-read from the encrypted operation and
/// checked against the service's durable upload ledger; callers cannot assert them.
pub async fn append_task_artifact(State(state):State<Arc<AppState>>,Extension(auth):Extension<AuthInfo>,Path(run_id):Path<String>,Json(input):Json<AppendTaskArtifact>)->Result<Json<Value>,AppError>{
    let run_id=uuid(&run_id)?;let operation_id=uuid(&input.operation_id)?;let scope_key=scope(&state,&auth).0;
    let run=sqlx::query("SELECT * FROM work_runs WHERE id=$1 AND scope_key=$2").bind(run_id).bind(&scope_key).fetch_optional(state.db.pool()).await.map_err(db_error)?.ok_or_else(unavailable)?;
    crate::work_turns::require_lease(&run,Some(&input.turn_token))?;
    let operation=sqlx::query("SELECT tool_name,status,result FROM work_operations WHERE id=$1 AND run_id=$2").bind(operation_id).bind(run_id).fetch_optional(state.db.pool()).await.map_err(db_error)?.ok_or_else(unavailable)?;
    if operation.get::<String,_>("status")!="succeeded"||operation.get::<String,_>("tool_name")!="task_upload_deliverable" { return Err(bad("operation is not a successful task artifact upload")); }
    let encrypted=operation.get::<Option<Vec<u8>>,_>("result").ok_or_else(conflict)?;
    let outcome=decrypt(&state,&auth,&encrypted).await?;
    if outcome.pointer("/result/ok").and_then(Value::as_bool)!=Some(true) { return Err(conflict()); }
    let data=outcome.pointer("/result/data").ok_or_else(conflict)?;
    let task_id=crate::chain_reads::id(data.get("taskId").and_then(Value::as_str).ok_or_else(conflict)?)?;
    let digest_value=data.get("digestHex").and_then(Value::as_str).ok_or_else(conflict)?;
    let digest=digest_value.strip_prefix("0x").unwrap_or(digest_value).to_ascii_lowercase();
    if digest.len()!=64||!digest.bytes().all(|byte|byte.is_ascii_hexdigit()) { return Err(conflict()); }
    let uri=data.get("uri").and_then(Value::as_str).ok_or_else(conflict)?;
    let expected_prefix=format!("r2://{}/",crate::memory_contract::normalize_object_id(&auth.owner));
    let object_id=uri.strip_prefix(&expected_prefix).ok_or_else(||bad("uploaded artifact URI is not owner-scoped R2"))?;
    if object_id.len()!=64||!object_id.bytes().all(|byte|byte.is_ascii_hexdigit())||data.get("storage").and_then(Value::as_str)!=Some("cloudflare_r2") { return Err(conflict()); }
    let content_length=data.get("contentLength").and_then(Value::as_u64).filter(|size|*size>0&&*size<=512*1024).ok_or_else(conflict)?;
    if !state.db.task_deliverable_upload_matches(&auth.account_id,&auth.agent_object_id,&task_id,uri,&digest).await? { return Err(AppError::Conflict("R2 artifact does not match the durable participant upload record".into())); }
    let owner=crate::memory_contract::normalize_object_id(&auth.owner);
    let store=state.r2.as_ref().ok_or_else(||AppError::Internal("Cloudflare R2 is not configured for task artifact verification".into()))?;
    let bytes=store.get_task_artifact(&owner,object_id).await?;
    if bytes.len() as u64!=content_length||hex::encode(Sha256::digest(&bytes))!=digest { return Err(AppError::Conflict("R2 artifact bytes do not match the journaled upload digest and length".into())); }
    let mut tx=state.db.pool().begin().await.map_err(db_error)?;
    let leased=sqlx::query("SELECT * FROM work_runs WHERE id=$1 AND scope_key=$2 FOR UPDATE").bind(run_id).bind(&scope_key).fetch_optional(&mut *tx).await.map_err(db_error)?.ok_or_else(unavailable)?;
    crate::work_turns::require_lease(&leased,Some(&input.turn_token))?;
    let mut snapshot=decrypt(&state,&auth,&leased.get::<Vec<u8>,_>("snapshot")).await?;
    if snapshot.get("taskId").and_then(Value::as_str).is_none_or(|id|!crate::chain_reads::same(id,&task_id)) { return Err(AppError::Forbidden("artifact task does not match the linked work run".into())); }
    let artifacts=snapshot["artifacts"].as_array_mut().ok_or_else(||AppError::Internal("invalid work artifact list".into()))?;
    if artifacts.len()>1000 { return Err(bad("work artifact limit reached")); }
    let operation_id_text=operation_id.to_string();
    let artifact=json!({"id":operation_id_text,"uri":uri,"contentDigest":digest,"mediaType":"application/octet-stream","ownerAccountId":crate::memory_contract::normalize_object_id(&auth.account_id),"taskId":task_id,"sourceEvidenceIds":[],"verification":"pending","contentLength":content_length});
    if let Some(existing)=artifacts.iter_mut().find(|item|item.get("id").and_then(Value::as_str)==Some(operation_id_text.as_str())) {
        if existing.get("uri").and_then(Value::as_str)!=Some(uri)||existing.get("contentDigest").and_then(Value::as_str)!=Some(digest.as_str()) { return Err(conflict()); }
        *existing=artifact.clone();
    }else{artifacts.push(artifact.clone());}
    let encrypted_snapshot=encrypt(&state,&auth,&snapshot).await?;
    let saved=sqlx::query("UPDATE work_runs SET snapshot=$1,revision=revision+1,updated_at=now() WHERE id=$2 AND scope_key=$3 AND lease_token=$4 AND lease_until>now() RETURNING id")
        .bind(encrypted_snapshot).bind(run_id).bind(scope_key).bind(Uuid::parse_str(&input.turn_token).map_err(|_|bad("invalid work turn token"))?).fetch_optional(&mut *tx).await.map_err(db_error)?.ok_or_else(conflict)?;
    drop(saved);tx.commit().await.map_err(db_error)?;Ok(Json(json!({"artifact":artifact})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields,rename_all="camelCase")]
pub struct UpdateStep { pub turn_token:String, pub expected_status:String, pub status:String, #[serde(default)] pub evidence_ids:Vec<String> }

/// Apply one fenced DAG transition. A step can only be completed with durable
/// successful operation IDs or already verified artifacts/receipts from this run.
pub async fn update_step(State(state):State<Arc<AppState>>,Extension(auth):Extension<AuthInfo>,Path((run_id,step_id)):Path<(String,String)>,Json(input):Json<UpdateStep>)->Result<Json<Value>,AppError>{
    let run_id=uuid(&run_id)?;let scope_key=scope(&state,&auth).0;
    if step_id.is_empty()||step_id.len()>64||!step_id.bytes().all(|byte|byte.is_ascii_lowercase()||byte.is_ascii_digit()||matches!(byte,b'_'|b'-')) { return Err(bad("invalid work step ID")); }
    if input.evidence_ids.len()>50||input.evidence_ids.iter().collect::<HashSet<_>>().len()!=input.evidence_ids.len(){return Err(bad("work step evidence must be unique and limited to 50 IDs"));}
    let mut tx=state.db.pool().begin().await.map_err(db_error)?;
    let row=sqlx::query("SELECT * FROM work_runs WHERE id=$1 AND scope_key=$2 FOR UPDATE").bind(run_id).bind(&scope_key).fetch_optional(&mut *tx).await.map_err(db_error)?.ok_or_else(unavailable)?;
    crate::work_turns::require_lease(&row,Some(&input.turn_token))?;
    if !active(row.get::<String,_>("status").as_str()) { return Err(conflict()); }
    let mut snapshot=decrypt(&state,&auth,&row.get::<Vec<u8>,_>("snapshot")).await?;
    let step=snapshot.get("plan").and_then(|plan|plan.get("steps")).and_then(Value::as_array).and_then(|steps|steps.iter().find(|step|step.get("id").and_then(Value::as_str)==Some(step_id.as_str()))).cloned().ok_or_else(||bad("work step is not in the current plan"))?;
    if step.get("assigneeAgentId").and_then(Value::as_str).is_some_and(|agent|!crate::chain_reads::same(agent,&auth.agent_object_id)) { return Err(AppError::Forbidden("step is assigned to another agent".into())); }
    let statuses=snapshot.get("stepStatus").and_then(Value::as_object).ok_or_else(||AppError::Internal("invalid work step state".into()))?;
    let current=statuses.get(&step_id).and_then(Value::as_str).ok_or_else(||AppError::Internal("work step status is missing".into()))?;
    if current!=input.expected_status { return Err(conflict()); }
    let allowed=match current {
        "pending"=>matches!(input.status.as_str(),"running"|"cancelled"),
        "running"=>matches!(input.status.as_str(),"verifying"|"failed"|"cancelled"),
        "verifying"=>matches!(input.status.as_str(),"succeeded"|"failed"|"cancelled"),
        "failed"=>matches!(input.status.as_str(),"running"|"cancelled"),
        _=>false,
    };
    if !allowed { return Err(bad("invalid work step status transition")); }
    if input.status=="running" {
        let steps=snapshot["stepStatus"].as_object().ok_or_else(||AppError::Internal("invalid work step state".into()))?;
        if steps.iter().any(|(id,status)|id!=&step_id&&matches!(status.as_str(),Some("running"|"verifying"))) { return Err(AppError::Conflict("another work step is already active".into())); }
        if step.get("dependsOn").and_then(Value::as_array).is_none_or(|dependencies|dependencies.iter().any(|dependency|dependency.as_str().is_none_or(|id|steps.get(id).and_then(Value::as_str)!=Some("succeeded")))) { return Err(AppError::Conflict("all prerequisite steps must succeed before this step starts".into())); }
    }
    if input.status=="succeeded" {
        if input.evidence_ids.is_empty() { return Err(bad("a completed step requires durable evidence IDs")); }
        let required_task_events=step.get("taskEvidenceEvents").and_then(Value::as_array);
        let alternative_task_events=step.get("taskEvidenceEventAlternatives").and_then(Value::as_array);
        if (required_task_events.is_some()||alternative_task_events.is_some())&&snapshot.get("taskId").and_then(Value::as_str).is_none() { return Err(bad("task transition evidence requires a task-linked work run")); }
        let mut observed_task_events=HashSet::new();
        let mut observed_task_event_digests:HashMap<String,HashSet<String>>=HashMap::new();
        for evidence_id in &input.evidence_ids {
            let task_event=snapshot.get("taskHistory").and_then(|history|history.get("events")).and_then(Value::as_array).and_then(|events|events.iter().find(|event|event.get("sourceEventId").and_then(Value::as_str)==Some(evidence_id.as_str())));
            let task_history_matches=task_event.is_some_and(|event|
                event.get("verification").and_then(Value::as_str)==Some("finalized_fullnode_task_event")
                    && snapshot.get("taskHistory").and_then(|history|history.get("taskId")).and_then(Value::as_str).zip(snapshot.get("taskId").and_then(Value::as_str)).is_some_and(|(actual,linked)|crate::chain_reads::same(actual,linked))
            );
            let receipt_event=snapshot.get("receipts").and_then(Value::as_array).and_then(|receipts|receipts.iter().find_map(|receipt|{
                let receipt_matches=receipt.get("verification").and_then(Value::as_str)==Some("verified")
                    && receipt.get("taskId").and_then(Value::as_str).zip(snapshot.get("taskId").and_then(Value::as_str)).is_some_and(|(actual,linked)|crate::chain_reads::same(actual,linked));
                if !receipt_matches { return None; }
                receipt.get("eventEvidence").and_then(Value::as_array).and_then(|events|events.iter().find(|event|event.get("sourceEventId").and_then(Value::as_str)==Some(evidence_id.as_str())))
            }));
            let history_event_type=task_event.and_then(|event|event.get("eventType")).and_then(Value::as_str).and_then(|name|name.rsplit("::").next());
            let receipt_event_type=receipt_event.and_then(|event|event.get("eventType")).and_then(Value::as_str).and_then(|name|name.rsplit("::").next());
            let task_event_type=if task_history_matches { history_event_type } else { receipt_event_type };
            let allowed_task_event=task_history_matches||receipt_event.is_some();
            if task_event.is_some()&&!allowed_task_event { return Err(AppError::Forbidden("task event evidence must be finalized and declared by this step's typed task-event requirements".into())); }
            if let Some(event_type)=task_event_type.filter(|_|allowed_task_event) {
                let required=required_task_events.is_some_and(|events|events.iter().any(|required|required.as_str()==Some(event_type)));
                let alternative=alternative_task_events.is_some_and(|groups|groups.iter().filter_map(Value::as_array).any(|group|group.iter().any(|required|required.as_str()==Some(event_type))));
                if required||alternative {
                    observed_task_events.insert(event_type.to_owned());
                    if alternative {
                        if let Some((digest,_))=evidence_id.split_once(':').filter(|(digest,sequence)|!digest.is_empty()&&!sequence.is_empty()) {
                            observed_task_event_digests.entry(event_type.to_owned()).or_default().insert(digest.to_owned());
                        }
                    }
                }
            }
            let trusted_local=allowed_task_event
                || snapshot.get("artifacts").and_then(Value::as_array).is_some_and(|items|items.iter().any(|item|item.get("id").and_then(Value::as_str)==Some(evidence_id)&&item.get("verification").and_then(Value::as_str)==Some("verified")))
                || snapshot.get("receipts").and_then(Value::as_array).is_some_and(|items|items.iter().any(|item|item.get("id").and_then(Value::as_str)==Some(evidence_id)&&item.get("verification").and_then(Value::as_str)==Some("verified")));
            let operation=if !trusted_local { if let Ok(id)=Uuid::parse_str(evidence_id) { sqlx::query("SELECT tool_name,status FROM work_operations WHERE id=$1 AND run_id=$2").bind(id).bind(run_id).fetch_optional(&mut *tx).await.map_err(db_error)? } else { None } } else { None };
            let trusted_operation=if let Some(operation)=operation {
                if operation.get::<String,_>("status")=="succeeded" {
                    let name=operation.get::<String,_>("tool_name");
                    if name.starts_with("task_") {
                        snapshot.get("receipts").and_then(Value::as_array).is_some_and(|items|items.iter().any(|item|item.get("operationId").and_then(Value::as_str)==Some(evidence_id)&&item.get("verification").and_then(Value::as_str)==Some("verified")))
                    } else { true }
                } else { false }
            } else { false };
            if !trusted_local&&!trusted_operation { return Err(AppError::Forbidden("work step evidence must reference a successful operation or verified artifact/receipt in this run".into())); }
        }
        if let Some(required)=required_task_events {
            if required.iter().filter_map(Value::as_str).any(|event_type|!observed_task_events.contains(event_type)) {
                return Err(AppError::Forbidden("work step is missing one or more declared finalized task transition events".into()));
            }
        }
        if let Some(alternatives)=alternative_task_events {
            let matched=alternatives.iter().filter_map(Value::as_array).any(|group| {
                if group.is_empty() { return false; }
                let mut shared_digests:Option<HashSet<String>>=None;
                for event_type in group.iter().filter_map(Value::as_str) {
                    let Some(digests)=observed_task_event_digests.get(event_type) else { return false; };
                    match &mut shared_digests {
                        Some(shared)=>shared.retain(|digest|digests.contains(digest)),
                        None=>shared_digests=Some(digests.clone()),
                    }
                }
                shared_digests.is_some_and(|digests|!digests.is_empty())
            });
            if !matched { return Err(AppError::Forbidden("work step is missing every declared finalized task transition outcome".into())); }
        }
    } else if !input.evidence_ids.is_empty() { return Err(bad("evidence IDs are accepted only when completing a step")); }
    if snapshot.get("stepEvidence").and_then(Value::as_object).is_none() { snapshot["stepEvidence"]=json!({}); }
    snapshot["stepStatus"][&step_id]=json!(input.status);
    if input.status=="succeeded" { snapshot["stepEvidence"][&step_id]=json!(input.evidence_ids); }
    if input.status=="failed"||input.status=="cancelled" { snapshot["stepEvidence"].as_object_mut().map(|evidence|evidence.remove(&step_id)); }
    let encrypted=encrypt(&state,&auth,&snapshot).await?;
    let saved=sqlx::query("UPDATE work_runs SET snapshot=$1,revision=revision+1,updated_at=now() WHERE id=$2 AND scope_key=$3 AND lease_token=$4 AND lease_until>now() RETURNING *")
        .bind(encrypted).bind(run_id).bind(scope_key).bind(Uuid::parse_str(&input.turn_token).map_err(|_|bad("invalid work turn token"))?).fetch_optional(&mut *tx).await.map_err(db_error)?.ok_or_else(conflict)?;
    let result=row_run(&saved,snapshot);tx.commit().await.map_err(db_error)?;Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeListing { pub mydata_id: String }

pub async fn purge_revoked_listing(State(state): State<Arc<AppState>>, Extension(auth): Extension<AuthInfo>, Json(input): Json<PurgeListing>) -> Result<Json<Value>, AppError> {
    let listing = crate::chain_reads::id(&input.mydata_id)?;
    let (scope_key, _) = scope(&state, &auth);
    let rows = sqlx::query("SELECT id, snapshot FROM work_runs WHERE scope_key=$1 ORDER BY updated_at DESC LIMIT 50").bind(&scope_key).fetch_all(state.db.pool()).await.map_err(db_error)?;
    let mut purged = 0u32;
    for row in rows {
        let snapshot = match decrypt(&state, &auth, &row.get::<Vec<u8>, _>("snapshot")).await { Ok(value) => value, Err(_) => continue };
        let encoded = snapshot.to_string();
        if !encoded.to_ascii_lowercase().contains(&listing.to_ascii_lowercase()) { continue; }
        let cleaned = redact_listing(&snapshot, &listing);
        let encrypted = encrypt(&state, &auth, &cleaned).await?;
        sqlx::query("UPDATE work_runs SET snapshot=$1, revision=revision+1, updated_at=now() WHERE id=$2 AND scope_key=$3").bind(encrypted).bind(row.get::<Uuid, _>("id")).bind(&scope_key).execute(state.db.pool()).await.map_err(db_error)?;
        purged += 1;
    }
    Ok(Json(json!({ "purged": purged, "scanned": 50 })))
}

fn redact_listing(value: &Value, listing: &str) -> Value {
    match value {
        Value::String(text) if text.to_ascii_lowercase().contains(&listing.to_ascii_lowercase()) => Value::String("[revoked listing removed]".into()),
        Value::Array(items) => Value::Array(items.iter().map(|item| redact_listing(item, listing)).collect()),
        Value::Object(items) => Value::Object(items.iter().map(|(key, item)| (key.clone(), redact_listing(item, listing))).collect()),
        other => other.clone(),
    }
}
