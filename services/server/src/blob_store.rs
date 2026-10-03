//! Encrypted memory blobs in Cloudflare R2 (S3-compatible API).

use aws_credential_types::Credentials;
use aws_sdk_s3::config::{BehaviorVersion, Region};
use aws_sdk_s3::error::SdkError;
use aws_sdk_s3::operation::get_object::GetObjectError;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client as S3Client;

use crate::file_storage;
use crate::types::{AppError, Config};

pub const R2_BLOB_PREFIX: &str = "r2:";

#[derive(Clone)]
pub struct R2BlobStore {
    client: S3Client,
    bucket: String,
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

    pub async fn put(&self, owner: &str, id: &str, body: Vec<u8>) -> Result<(), AppError> {
        let key = object_key(owner, id);
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

    pub async fn get(&self, owner: &str, id: &str) -> Result<Vec<u8>, AppError> {
        let key = object_key(owner, id);
        let out = match self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(&key)
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

pub fn object_key(owner: &str, id: &str) -> String {
    format!("memory/{owner}/{id}")
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

/// Load ciphertext from R2 when the saved id has the `r2:` prefix, otherwise
/// from the File Storage aggregator.
pub async fn fetch_encrypted_blob(
    http: &reqwest::Client,
    aggregator_url: &str,
    r2: Option<&R2BlobStore>,
    owner: &str,
    blob_id: &str,
) -> Result<Vec<u8>, AppError> {
    let Some(id) = id_from_blob_id(blob_id) else {
        return file_storage::download_blob(http, aggregator_url, blob_id).await;
    };
    let store = r2.ok_or_else(|| {
        AppError::Internal("R2 blob store is not configured for this memory".into())
    })?;
    store.get(owner, id).await
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
            object_key("0xabc", id),
            "memory/0xabc/6f17f8a7-1998-4e02-9526-a7d1d75b1916"
        );
        assert_eq!(id_from_blob_id("file-storage-id"), None);
        assert_eq!(id_from_blob_id("r2:"), None);
    }
}
