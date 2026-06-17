//! Background remember job execution.

use std::sync::Arc;

use axum::http::StatusCode;
use uuid::Uuid;

use crate::file_storage;
use crate::mydata;
use crate::rate_limit;
use crate::types::{AppError, AppState, AuthInfo};
use crate::vault::ensure_agent_vault;

/// Shared remember pipeline used by async jobs and synchronous analyze paths.
pub async fn execute_remember_text(
    state: &Arc<AppState>,
    auth: &AuthInfo,
    text: &str,
    sub_label: Option<&str>,
    importance: f32,
) -> Result<(String, String, String), AppError> {
    if text.is_empty() {
        return Err(AppError::BadRequest("Text cannot be empty".into()));
    }
    if text.len() > crate::routes::MAX_REMEMBER_TEXT_BYTES {
        return Err(AppError::BadRequest(format!(
            "Text exceeds maximum length of {} bytes",
            crate::routes::MAX_REMEMBER_TEXT_BYTES
        )));
    }

    let owner = &auth.owner;
    let agent_object_id = &auth.agent_object_id;

    ensure_agent_vault(state, auth).await?;

    let embed_fut = crate::routes::generate_embedding(&state.http_client, &state.config, text);
    let encrypt_fut = mydata::mydata_encrypt(
        &state.http_client,
        &state.config.sidecar_url,
        state.config.sidecar_secret.as_deref(),
        text.as_bytes(),
        owner,
        &state.config.package_id,
    );
    let (vector_result, encrypted_result) = tokio::join!(embed_fut, encrypt_fut);
    let vector = vector_result?;
    let encrypted = encrypted_result?;

    rate_limit::check_storage_quota(state, owner, encrypted.len() as i64).await?;

    let key_index = state
        .key_pool
        .next_index()
        .ok_or_else(|| {
            AppError::Internal(
                "No MySo keys configured (set SERVER_MYSO_PRIVATE_KEYS or SERVER_MYSO_PRIVATE_KEY)"
                    .into(),
            )
        })?;
    let upload_result = file_storage::upload_blob(
        &state.http_client,
        &state.config.sidecar_url,
        state.config.sidecar_secret.as_deref(),
        &encrypted,
        50,
        owner,
        key_index,
        agent_object_id,
        &state.config.package_id,
        Some(&auth.agent_object_id),
    )
    .await?;
    let blob_id = upload_result.blob_id;

    let blob_size = encrypted.len() as i64;
    let id = Uuid::new_v4().to_string();
    state
        .db
        .insert_vector(
            &id,
            owner,
            agent_object_id,
            sub_label,
            &blob_id,
            &vector,
            blob_size,
            importance,
        )
        .await?;

    tracing::info!(
        "remember complete: job_id={} blob_id={} owner={} agent={}",
        id,
        blob_id,
        owner,
        agent_object_id
    );

    Ok((id, blob_id, owner.clone()))
}

pub fn spawn_remember_job(
    state: Arc<AppState>,
    job_id: String,
    text: String,
    auth: AuthInfo,
    sub_label: Option<String>,
) {
    tokio::spawn(async move {
        if let Err(e) = set_job_status(&state, &job_id, "running", None, None).await {
            tracing::error!("remember job {} failed to mark running: {}", job_id, e);
            return;
        }

        let result = execute_remember_text(
            &state,
            &auth,
            &text,
            sub_label.as_deref(),
            0.5,
        )
        .await;

        match result {
            Ok((id, blob_id, _owner)) => {
                if let Err(e) =
                    set_job_status(&state, &job_id, "done", Some(&blob_id), None).await
                {
                    tracing::error!("remember job {} failed to mark done: {}", job_id, e);
                }
                let _ = id;
            }
            Err(e) => {
                let msg = format!("{}", e);
                if let Err(err) =
                    set_job_status(&state, &job_id, "failed", None, Some(&msg)).await
                {
                    tracing::error!("remember job {} failed to mark failed: {}", job_id, err);
                }
            }
        }
    });
}

async fn set_job_status(
    state: &AppState,
    job_id: &str,
    status: &str,
    blob_id: Option<&str>,
    error_msg: Option<&str>,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE remember_jobs SET status = $1, blob_id = COALESCE($2, blob_id),
         error_msg = $3, updated_at = NOW() WHERE id = $4",
    )
    .bind(status)
    .bind(blob_id)
    .bind(error_msg)
    .bind(job_id)
    .execute(state.db.pool())
    .await
    .map_err(|e| AppError::Internal(format!("Failed to update remember job: {}", e)))?;
    Ok(())
}

pub async fn create_remember_job(
    state: &AppState,
    owner: &str,
    agent_object_id: &str,
    sub_label: &str,
) -> Result<String, AppError> {
    let job_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO remember_jobs (id, owner, agent_object_id, sub_label, status)
         VALUES ($1, $2, $3, $4, 'pending')",
    )
    .bind(&job_id)
    .bind(owner)
    .bind(agent_object_id)
    .bind(sub_label)
    .execute(state.db.pool())
    .await
    .map_err(|e| AppError::Internal(format!("Failed to create remember job: {}", e)))?;
    Ok(job_id)
}

pub async fn get_remember_job_status(
    state: &AppState,
    job_id: &str,
    owner: &str,
) -> Result<Option<RememberJobRow>, AppError> {
    let row: Option<(String, String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT id, status, agent_object_id, blob_id, error_msg FROM remember_jobs
         WHERE id = $1 AND owner = $2",
    )
    .bind(job_id)
    .bind(owner)
    .fetch_optional(state.db.pool())
    .await
    .map_err(|e| AppError::Internal(format!("Failed to query remember job: {}", e)))?;

    Ok(row.map(
        |(id, status, agent_object_id, blob_id, error_msg)| RememberJobRow {
            job_id: id,
            status,
            agent_object_id,
            blob_id,
            error_msg,
        },
    ))
}

pub struct RememberJobRow {
    pub job_id: String,
    pub status: String,
    pub agent_object_id: String,
    pub blob_id: Option<String>,
    pub error_msg: Option<String>,
}

pub async fn create_bulk_remember_jobs(
    state: &AppState,
    owner: &str,
    agent_object_id: &str,
    sub_label: &str,
    count: usize,
) -> Result<Vec<String>, AppError> {
    let mut job_ids = Vec::with_capacity(count);
    for _ in 0..count {
        job_ids.push(create_remember_job(state, owner, agent_object_id, sub_label).await?);
    }
    Ok(job_ids)
}

pub fn spawn_bulk_remember_jobs(
    state: Arc<AppState>,
    job_ids: Vec<String>,
    texts: Vec<String>,
    auth: AuthInfo,
    sub_label: Option<String>,
) {
    for (job_id, text) in job_ids.into_iter().zip(texts) {
        spawn_remember_job(state.clone(), job_id, text, auth.clone(), sub_label.clone());
    }
}

/// Reject SDK versions below server minimum when client sends compatibility header.
pub fn check_sdk_compatibility_header(sdk_version: Option<&str>) -> Result<(), StatusCode> {
    if let Some(ver) = sdk_version {
        if !crate::compatibility::is_compatible_sdk_version(ver) {
            return Err(StatusCode::UPGRADE_REQUIRED);
        }
    }
    Ok(())
}
