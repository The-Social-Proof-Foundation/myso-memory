//! Bounded task artifact uploads with durable, account/agent/task-scoped idempotency.
use axum::{extract::State, Extension, Json};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;

use crate::{platform_reads, types::{AppError, AppState, AuthInfo}};

const MAX_ARTIFACT_BYTES: usize = 512 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UploadRequest {
    task_id: String,
    content_base64: String,
    idempotency_key: String,
}

fn bad(message: &str) -> AppError { AppError::BadRequest(message.into()) }

fn normalized_id(value: &str) -> Result<String, AppError> {
    let raw = value.strip_prefix("0x").unwrap_or(value);
    if raw.is_empty() || raw.len() > 64 || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(bad("taskId must be a valid object ID"));
    }
    Ok(format!("0x{:0>64}", raw.to_ascii_lowercase()))
}

fn validate_key(value: &str) -> Result<(), AppError> {
    if !(8..=128).contains(&value.len()) || !value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'/' | b'-')) {
        return Err(bad("idempotencyKey must be 8-128 URL-safe characters"));
    }
    Ok(())
}

fn response(task_id: &str, uri: String, digest: &str, size: usize, reconciled: bool) -> Json<Value> {
    Json(json!({
        "taskId": task_id,
        "uri": uri,
        "digestHex": digest,
        "contentLength": size,
        "encoding": "base64",
        "storage": "cloudflare_r2",
        "idempotentReplay": reconciled,
        "disclosure": "Artifact bytes are stored in the private Cloudflare R2 bucket and released only through participant-authorized task retrieval.",
    }))
}

pub async fn upload(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Json(input): Json<UploadRequest>,
) -> Result<Json<Value>, AppError> {
    validate_key(&input.idempotency_key)?;
    let task_id = normalized_id(&input.task_id)?;
    if input.content_base64.len() > ((MAX_ARTIFACT_BYTES + 2) / 3) * 4 {
        return Err(bad("task artifact exceeds the 512 KiB upload limit"));
    }
    let bytes = BASE64.decode(&input.content_base64).map_err(|_| bad("contentBase64 must be valid standard base64"))?;
    if bytes.is_empty() || bytes.len() > MAX_ARTIFACT_BYTES || BASE64.encode(&bytes) != input.content_base64 {
        return Err(bad("task artifact must contain 1-512 KiB of canonical base64 bytes"));
    }
    let store = state.r2.as_ref().ok_or_else(|| AppError::Internal(
        "Cloudflare R2 is required for task artifacts; configure R2_BUCKET, R2_ENDPOINT, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY".into(),
    ))?;

    let task = platform_reads::owned_task(&state, &auth, &task_id).await?;
    let status = task.get("status").and_then(Value::as_i64).ok_or_else(|| AppError::Internal("task status is unavailable".into()))?;
    let seller_account = task.get("sellerMemoryAccountId").and_then(Value::as_str).ok_or_else(|| AppError::Internal("task seller account is unavailable".into()))?;
    let seller_agent = task.get("sellerAgentId").and_then(Value::as_str).ok_or_else(|| AppError::Internal("task seller agent is unavailable".into()))?;
    if crate::memory_contract::normalize_object_id(seller_account) != crate::memory_contract::normalize_object_id(&auth.account_id)
        || crate::memory_contract::normalize_object_id(seller_agent) != crate::memory_contract::normalize_object_id(&auth.agent_object_id) {
        return Err(AppError::Forbidden("only the assigned seller agent can upload or recover this task artifact".into()));
    }

    let digest = hex::encode(Sha256::digest(&bytes));
    let storage_owner = crate::memory_contract::normalize_object_id(&auth.owner);
    if status != 1 {
        // Permit a post-delivery repair only for the exact already-completed
        // upload. This cannot create a new artifact or replace a different one.
        let Some((saved_digest, saved_status, saved_uri, _)) = state.db.get_task_deliverable_upload(
            &auth.account_id, &auth.agent_object_id, &task_id, &input.idempotency_key,
        ).await? else {
            return Err(AppError::Forbidden("new task artifacts can only be uploaded for an accepted task".into()));
        };
        if saved_status != "uploaded" || saved_digest != digest {
            return Err(AppError::Forbidden("only the exact bytes of an already-completed upload can be recovered after task delivery".into()));
        }
        let uri = saved_uri.ok_or_else(|| AppError::Conflict("completed upload ledger has no R2 URI".into()))?;
        let prefix = format!("r2://{storage_owner}/");
        let object_id = uri.strip_prefix(&prefix).filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .ok_or_else(|| AppError::Conflict("completed upload URI is outside the authenticated owner's R2 namespace".into()))?;
        match store.get_task_artifact(&storage_owner, object_id).await {
            Ok(existing) if hex::encode(Sha256::digest(&existing)) == digest => {
                return Ok(response(&task_id, uri, &digest, bytes.len(), true));
            }
            Ok(_) => return Err(AppError::Conflict("existing R2 object does not match the completed upload digest".into())),
            Err(AppError::BlobNotFound(_)) => {
                store.put_task_artifact(&storage_owner, object_id, bytes.clone()).await?;
                let restored = store.get_task_artifact(&storage_owner, object_id).await?;
                if restored.len() != bytes.len() || hex::encode(Sha256::digest(&restored)) != digest {
                    return Err(AppError::Conflict("restored R2 object failed exact length and digest verification".into()));
                }
                return Ok(response(&task_id, uri, &digest, bytes.len(), true));
            }
            Err(error) => return Err(error),
        }
    }
    let namespace_seed = format!("{}:{}:{}:{}", crate::memory_contract::normalize_object_id(&auth.account_id), crate::memory_contract::normalize_object_id(&auth.agent_object_id), task_id, input.idempotency_key);
    let namespace = format!("task-deliverable-{}", hex::encode(Sha256::digest(namespace_seed.as_bytes())));
    let (status, existing_uri) = state.db.reserve_task_deliverable_upload(
        &auth.account_id, &auth.agent_object_id, &task_id, &input.idempotency_key, &digest, &namespace,
    ).await?;
    if status == "uploaded" {
        let uri = existing_uri.ok_or_else(|| AppError::Internal("uploaded task artifact is missing its URI".into()))?;
        if !uri.starts_with("r2://") {
            return Err(AppError::Conflict("this idempotency key belongs to a legacy File Storage upload; it cannot be replayed as a MySo Agent artifact".into()));
        }
        return Ok(response(&task_id, uri, &digest, bytes.len(), true));
    }

    // R2 PutObject is atomic and idempotent for a deterministic key. Repeating
    // the same reserved operation after a lost response writes the exact same
    // bytes to the same private object; the database rejects key reuse for any
    // different content digest.
    let object_id = hex::encode(Sha256::digest(namespace.as_bytes()));
    store.put_task_artifact(&storage_owner, &object_id, bytes.clone()).await?;
    let uri = format!("r2://{}/{}", storage_owner, object_id);
    state.db.complete_task_deliverable_upload(&auth.account_id, &auth.agent_object_id, &task_id, &input.idempotency_key, &uri).await?;
    Ok(response(&task_id, uri, &digest, bytes.len(), status != "pending_new"))
}
