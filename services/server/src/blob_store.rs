//! Encrypted memory blobs in Cloudflare R2 (S3-compatible API).

use aws_credential_types::Credentials;
use aws_sdk_s3::config::{BehaviorVersion, Region};
use aws_sdk_s3::error::SdkError;
use aws_sdk_s3::operation::get_object::GetObjectError;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client as S3Client;

use crate::types::{AppError, AppState, Config};

pub const R2_BLOB_PREFIX: &str = "r2:";

#[derive(Clone)]
pub struct R2BlobStore {
    client: S3Client,
    bucket: String,
}

#[derive(Debug, Clone)]
pub struct MemoryBlobMetadata {
    pub agent_object_id: String,
    pub package_id: String,
    pub visibility: i16,
    pub organization_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ListedMemoryBlob {
    pub blob_id: String,
    pub package_id: String,
    pub visibility: i16,
    pub organization_id: Option<String>,
}

impl R2BlobStore {
    pub fn from_config(config: &Config) -> Result<Self, AppError> {
        let endpoint = config
            .r2_endpoint
            .as_deref()
            .ok_or_else(|| AppError::Internal("R2_ENDPOINT is required".into()))?;
        let bucket = config
            .r2_bucket
            .as_deref()
            .ok_or_else(|| AppError::Internal("R2_BUCKET is required".into()))?;
        let access_key_id = config
            .r2_access_key_id
            .as_deref()
            .ok_or_else(|| AppError::Internal("R2_ACCESS_KEY_ID is required".into()))?;
        let secret_access_key = config
            .r2_secret_access_key
            .as_deref()
            .ok_or_else(|| AppError::Internal("R2_SECRET_ACCESS_KEY is required".into()))?;
        let creds = Credentials::new(
            access_key_id,
            secret_access_key,
            None,
            None,
            "r2-static",
        );
        let conf = aws_sdk_s3::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .credentials_provider(creds)
            .endpoint_url(endpoint)
            .region(Region::new(config.r2_region.clone()))
            .force_path_style(true)
            .build();
        Ok(Self {
            client: S3Client::from_conf(conf),
            bucket: bucket.to_string(),
        })
    }

    pub async fn put_memory(
        &self,
        owner: &str,
        id: &str,
        metadata: &MemoryBlobMetadata,
        body: Vec<u8>,
    ) -> Result<(), AppError> {
        let key = object_key(owner, &metadata.agent_object_id, id);
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .metadata("agent-object-id", &metadata.agent_object_id)
            .metadata("package-id", &metadata.package_id)
            .metadata("visibility", metadata.visibility.to_string())
            .metadata("organization-id", metadata.organization_id.as_deref().unwrap_or("none"))
            .content_type("application/octet-stream")
            .body(ByteStream::from(body))
            .send()
            .await
            .map_err(|error| AppError::Internal(format!("R2 put: {error}")))?;
        Ok(())
    }

    pub async fn put_work_payload(&self, owner: &str, id: &str, body: Vec<u8>) -> Result<(), AppError> {
        self.put_at_key(&format!("work-payload/{owner}/{id}"), body).await
    }

    pub async fn put_task_artifact(&self, owner: &str, id: &str, body: Vec<u8>) -> Result<(), AppError> {
        self.put_at_key(&task_artifact_key(owner, id), body).await
    }

    /// Store opaque, client-encrypted room attachment bytes in the private bucket.
    pub async fn put_room_attachment(&self, group_id: &str, id: &str, body: Vec<u8>) -> Result<(), AppError> {
        self.put_at_key(&room_attachment_key(group_id, id), body).await
    }

    /// Create an attachment object once. A stable idempotency-derived object ID
    /// lets retries recover the first result without overwriting different bytes.
    pub async fn put_room_attachment_once(&self, group_id: &str, id: &str, body: Vec<u8>) -> Result<bool, AppError> {
        let key = room_attachment_key(group_id, id);
        match self.client
            .put_object()
            .bucket(&self.bucket)
            .key(&key)
            .if_none_match("*")
            .body(ByteStream::from(body.clone()))
            .content_type("application/octet-stream")
            .send()
            .await
        {
            Ok(_) => Ok(false),
            Err(error) => {
                let exists = matches!(&error, SdkError::ServiceError(service_error) if service_error.raw().status().as_u16() == 412);
                if !exists {
                    return Err(AppError::Internal(format!("R2 conditional room attachment put: {error}")));
                }
                let existing = self.get_at_key(&key).await?;
                if existing != body {
                    return Err(AppError::Conflict("Room attachment idempotency key was already used with different ciphertext".into()));
                }
                Ok(true)
            }
        }
    }

    async fn put_at_key(&self, key: &str, body: Vec<u8>) -> Result<(), AppError> {
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .body(ByteStream::from(body))
            .content_type("application/octet-stream")
            .send()
            .await
            .map_err(|error| AppError::Internal(format!("R2 put: {error}")))?;
        Ok(())
    }

    pub async fn get(&self, owner: &str, agent_object_id: &str, id: &str) -> Result<Vec<u8>, AppError> {
        let key = object_key(owner, agent_object_id, id);
        self.get_at_key(&key).await
    }

    pub async fn get_task_artifact(&self, owner: &str, id: &str) -> Result<Vec<u8>, AppError> {
        self.get_at_key(&task_artifact_key(owner, id)).await
    }

    /// Retrieve opaque room attachment bytes after the caller's live room access check.
    pub async fn get_room_attachment(&self, group_id: &str, id: &str) -> Result<Vec<u8>, AppError> {
        self.get_at_key(&room_attachment_key(group_id, id)).await
    }

    /// Rebuild the vector index from objects in the private R2 bucket. The
    /// authenticated owner's private prefix is narrowed by the immutable agent
    /// identity persisted as object metadata when the ciphertext was written.
    pub async fn list_memory_blobs(
        &self,
        owner: &str,
        agent_object_id: &str,
    ) -> Result<Vec<ListedMemoryBlob>, AppError> {
        let prefix = format!("memory/{owner}/{agent_object_id}/");
        let mut token: Option<String> = None;
        let mut blobs = Vec::new();
        let mut scanned = 0usize;
        const MAX_OWNER_OBJECT_SCAN: usize = 100_000;
        loop {
            let mut request = self.client
                .list_objects_v2()
                .bucket(&self.bucket)
                .prefix(&prefix)
                .max_keys(1000);
            if let Some(value) = token.as_deref() {
                request = request.continuation_token(value);
            }
            let page = request.send().await
                .map_err(|error| AppError::Internal(format!("R2 list: {error}")))?;
            for object in page.contents() {
                scanned = scanned.saturating_add(1);
                if scanned > MAX_OWNER_OBJECT_SCAN {
                    return Err(AppError::BadRequest("R2 memory restore exceeds the 100,000-object owner scan limit".into()));
                }
                let Some(key) = object.key() else { continue; };
                let Some(id) = key.strip_prefix(&prefix) else { continue; };
                if id.is_empty() || id.contains('/') { continue; }
                let head = self.client.head_object().bucket(&self.bucket).key(key).send().await
                    .map_err(|error| AppError::Internal(format!("R2 head: {error}")))?;
                let Some(metadata) = head.metadata() else { continue; };
                if metadata.get("agent-object-id").map(String::as_str) != Some(agent_object_id) {
                    continue;
                }
                let package_id = metadata.get("package-id").cloned().unwrap_or_default();
                let visibility = metadata.get("visibility")
                    .and_then(|value| value.parse::<i16>().ok())
                    .unwrap_or(crate::types::VISIBILITY_PRIVATE);
                let organization_id = metadata.get("organization-id")
                    .filter(|value| value.as_str() != "none")
                    .cloned();
                blobs.push(ListedMemoryBlob {
                    blob_id: blob_id_for(id),
                    package_id,
                    visibility,
                    organization_id,
                });
            }
            if !page.is_truncated().unwrap_or(false) { break; }
            token = page.next_continuation_token().map(str::to_string);
            if token.is_none() { break; }
        }
        Ok(blobs)
    }

    async fn get_at_key(&self, key: &str) -> Result<Vec<u8>, AppError> {
        let out = match self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
        {
            Ok(out) => out,
            Err(error) => return Err(map_get_error(&key, error)),
        };
        out.body
            .collect()
            .await
            .map(|bytes| bytes.into_bytes().to_vec())
            .map_err(|error| AppError::Internal(format!("R2 body: {error}")))
    }
}

pub fn blob_id_for(id: &str) -> String {
    format!("{R2_BLOB_PREFIX}{id}")
}

/// Store newly written ciphertext and the minimal recovery metadata in the
/// private R2 bucket so the vector index can be rebuilt without File Storage.
pub async fn store_new_blob(
    state: &AppState,
    owner: &str,
    metadata: &MemoryBlobMetadata,
    body: Vec<u8>,
) -> Result<String, AppError> {
    let store = state.r2.as_ref().ok_or_else(|| {
        AppError::Internal("Cloudflare R2 is not configured for new blob writes".into())
    })?;
    let id = uuid::Uuid::new_v4().to_string();
    store.put_memory(owner, &id, metadata, body).await?;
    Ok(blob_id_for(&id))
}

pub fn object_key(owner: &str, agent_object_id: &str, id: &str) -> String {
    format!("memory/{owner}/{agent_object_id}/{id}")
}

pub fn task_artifact_key(owner: &str, id: &str) -> String {
    format!("task-artifacts/{owner}/{id}")
}

pub fn room_attachment_key(group_id: &str, id: &str) -> String {
    format!("room-attachments/{}/{id}", group_id.trim_start_matches("0x").to_ascii_lowercase())
}

fn id_from_blob_id(blob_id: &str) -> Option<&str> {
    blob_id
        .strip_prefix(R2_BLOB_PREFIX)
        .filter(|id| !id.is_empty())
}

fn map_get_error(key: &str, error: SdkError<GetObjectError>) -> AppError {
    match &error {
        SdkError::ServiceError(service) if service.err().is_no_such_key() => {
            AppError::BlobNotFound(format!("Blob {key} expired or not found"))
        }
        _ => AppError::Internal(format!("R2 get: {error}")),
    }
}

/// Load ciphertext only from the private R2 bucket. Legacy File Storage ids
/// are rejected explicitly because that service is not deployed for Agents.
pub async fn fetch_encrypted_blob(
    r2: Option<&R2BlobStore>,
    owner: &str,
    agent_object_id: &str,
    blob_id: &str,
) -> Result<Vec<u8>, AppError> {
    let Some(id) = id_from_blob_id(blob_id) else {
        return Err(AppError::BlobNotFound("Legacy File Storage blob is unavailable in the R2-only deployment".into()));
    };
    let store = r2.ok_or_else(|| {
        AppError::Internal("R2 blob store is not configured for this memory".into())
    })?;
    store.get(owner, agent_object_id, id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn r2_blob_id_round_trips_to_the_object_key() {
        let id = "6f17f8a7-1998-4e02-9526-a7d1d75b1916";
        let blob_id = blob_id_for(id);
        assert_eq!(blob_id, "r2:6f17f8a7-1998-4e02-9526-a7d1d75b1916");
        assert_eq!(id_from_blob_id(&blob_id), Some(id));
        assert_eq!(
            object_key("0xabc", "0xagent", id),
            "memory/0xabc/0xagent/6f17f8a7-1998-4e02-9526-a7d1d75b1916"
        );
        assert_eq!(id_from_blob_id("file-storage-id"), None);
        assert_eq!(id_from_blob_id("r2:"), None);
    }
}
