//! Client-encrypted messaging attachments stored in the private Cloudflare R2 bucket.
//! Access is checked against the configured fullnode on every upload and download.

use axum::{extract::State, Extension, Json};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;

use crate::{platform_reads, types::{AppError, AppState, AuthInfo}};

const MAX_ATTACHMENT_BYTES: usize = 5 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UploadRequest {
    group_id: String,
    content_base64: String,
    #[serde(default)]
    idempotency_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DownloadRequest {
    storage_id: String,
}

fn bad(message: &str) -> AppError { AppError::BadRequest(message.into()) }

fn storage_ref(group_id: &str, id: &str) -> String {
    format!("r2room://{group_id}/{id}")
}

fn idempotent_attachment_id(auth: &AuthInfo, group_id: &str, key: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"myso.room.attachment.idempotency.v1\0");
    digest.update(auth.account_id.as_bytes());
    digest.update([0]);
    digest.update(auth.agent_object_id.as_bytes());
    digest.update([0]);
    digest.update(group_id.as_bytes());
    digest.update([0]);
    digest.update(key.as_bytes());
    let hash = digest.finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&hash[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(bytes).to_string()
}

fn parse_storage_ref(value: &str) -> Result<(String, String), AppError> {
    let raw = value.strip_prefix("r2room://").ok_or_else(|| bad("storageId must be an R2 room attachment reference"))?;
    let (group, id) = raw.split_once('/').ok_or_else(|| bad("storageId must include its room and object id"))?;
    let group_id = crate::chain_reads::id(group)?;
    let parsed = uuid::Uuid::parse_str(id).map_err(|_| bad("storageId has an invalid object id"))?;
    if parsed.to_string() != id.to_ascii_lowercase() { return Err(bad("storageId has a noncanonical object id")); }
    Ok((group_id, parsed.to_string()))
}

pub async fn upload(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Json(input): Json<UploadRequest>,
) -> Result<Json<Value>, AppError> {
    let group_id = crate::chain_reads::id(&input.group_id)?;
    platform_reads::require_messaging_permission(&state, &auth, &group_id, "MessagingSender").await?;
    if input.content_base64.len() > ((MAX_ATTACHMENT_BYTES + 2) / 3) * 4 {
        return Err(bad("encrypted room attachment exceeds the 5 MiB limit"));
    }
    let bytes = BASE64.decode(&input.content_base64).map_err(|_| bad("contentBase64 must be valid standard base64"))?;
    if bytes.is_empty() || bytes.len() > MAX_ATTACHMENT_BYTES || BASE64.encode(&bytes) != input.content_base64 {
        return Err(bad("encrypted room attachment must contain 1-5 MiB of canonical base64 bytes"));
    }
    let store = state.r2.as_ref().ok_or_else(|| AppError::Internal(
        "Cloudflare R2 is required for encrypted room attachments".into(),
    ))?;
    let (id, idempotent_replay) = if let Some(key) = input.idempotency_key.as_deref() {
        let parsed = uuid::Uuid::parse_str(key).map_err(|_| bad("idempotencyKey must be a UUID"))?;
        if parsed.to_string() != key {
            return Err(bad("idempotencyKey must use canonical UUID formatting"));
        }
        let canonical_key = parsed.to_string();
        let id = idempotent_attachment_id(&auth, &group_id, &canonical_key);
        let replay = store.put_room_attachment_once(&group_id, &id, bytes.clone()).await?;
        (id, replay)
    } else {
        let id = uuid::Uuid::new_v4().to_string();
        store.put_room_attachment(&group_id, &id, bytes.clone()).await?;
        (id, false)
    };
    let digest = hex::encode(Sha256::digest(&bytes));
    Ok(Json(json!({
        "groupId": group_id,
        "storageId": storage_ref(&group_id, &id),
        "contentLength": bytes.len(),
        "sha256Hex": digest,
        "storage": "cloudflare_r2",
        "ciphertextOnly": true,
        "idempotentReplay": idempotent_replay,
    })))
}

pub async fn download(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Json(input): Json<DownloadRequest>,
) -> Result<Json<Value>, AppError> {
    let (group_id, id) = parse_storage_ref(&input.storage_id)?;
    platform_reads::require_messaging_permission(&state, &auth, &group_id, "MessagingReader").await?;
    let store = state.r2.as_ref().ok_or_else(|| AppError::Internal(
        "Cloudflare R2 is required for encrypted room attachments".into(),
    ))?;
    let bytes = store.get_room_attachment(&group_id, &id).await?;
    if bytes.is_empty() || bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(AppError::Conflict("stored room attachment exceeds the supported size".into()));
    }
    let digest = hex::encode(Sha256::digest(&bytes));
    Ok(Json(json!({
        "groupId": group_id,
        "storageId": storage_ref(&group_id, &id),
        "contentLength": bytes.len(),
        "sha256Hex": digest,
        "contentBase64": BASE64.encode(bytes),
        "storage": "cloudflare_r2",
        "ciphertextOnly": true,
    })))
}
