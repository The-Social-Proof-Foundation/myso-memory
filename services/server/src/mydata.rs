use crate::types::{AppError, AuthInfo, SidecarError};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

/// Credential used to authorize a MYDATA decrypt request against the sidecar.
///
/// ENG-1697: `Session` (an exported `SessionKey`, built on the client) is
/// preferred. `MemoryDelegateKey` is the legacy path where the SDK transmits the
/// raw Ed25519 private key — retained temporarily so existing clients keep
/// working. At EOL the `MemoryDelegateKey` variant will be removed.
///
/// Owned so it can be cheaply cloned into async tasks.
#[derive(Debug, Clone)]
pub enum MyDataCredential {
    Session(String),
    MemoryDelegateKey(String),
}

impl MyDataCredential {
    /// Build the credential from an `AuthInfo`, preferring `mydata_session`
    /// when present. Falls back to `delegate_key` (legacy), then to a
    /// server-side fallback private key (used when a route lacks a user
    /// context). Returns `None` if no credential is available.
    pub fn from_auth_or_fallback(
        auth: &AuthInfo,
        fallback_private_key: Option<&str>,
    ) -> Option<Self> {
        if let Some(s) = auth.mydata_session.as_deref() {
            return Some(MyDataCredential::Session(s.to_string()));
        }
        if let Some(k) = auth.sub_agent_key.as_deref() {
            return Some(MyDataCredential::MemoryDelegateKey(k.to_string()));
        }
        fallback_private_key.map(|k| MyDataCredential::MemoryDelegateKey(k.to_string()))
    }
}

/// Request/response types for sidecar HTTP API
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MyDataEncryptRequest {
    data: String,
    owner: String,
    package_id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MyDataEncryptResponse {
    encrypted_data: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MyDataDecryptRequest {
    data: String,
    package_id: String,
    account_id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MyDataDecryptResponse {
    decrypted_data: String,
}

/// Encrypt plaintext using MYDATA threshold encryption via HTTP sidecar.
///
/// Calls the long-lived sidecar server at `POST /mydata/encrypt`.
/// The ciphertext is bound to the user's address via MYDATA key ID.
///
/// Returns: MYDATA encrypted bytes
pub async fn mydata_encrypt(
    client: &reqwest::Client,
    sidecar_url: &str,
    sidecar_secret: Option<&str>,
    data: &[u8],
    owner_address: &str,
    package_id: &str,
) -> Result<Vec<u8>, AppError> {
    let url = format!("{}/mydata/encrypt", sidecar_url);
    let data_b64 = BASE64.encode(data);

    let mut req = client
        .post(&url)
        .json(&MyDataEncryptRequest {
            data: data_b64,
            owner: owner_address.to_string(),
            package_id: package_id.to_string(),
        });
    if let Some(secret) = sidecar_secret {
        req = req.header("authorization", format!("Bearer {}", secret));
    }
    let resp = req
        .send()
        .await
        .map_err(|e| {
            AppError::Internal(format!("Sidecar mydata/encrypt request failed: {}. Is the sidecar running?", e))
        })?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        if let Ok(err) = serde_json::from_str::<SidecarError>(&body) {
            return Err(AppError::Internal(format!("mydata encrypt failed: {}", err.error)));
        }
        return Err(AppError::Internal(format!("mydata encrypt failed: {}", body)));
    }

    let result: MyDataEncryptResponse = resp.json().await.map_err(|e| {
        AppError::Internal(format!("Failed to parse mydata/encrypt response: {}", e))
    })?;

    let encrypted_bytes = BASE64.decode(&result.encrypted_data).map_err(|e| {
        AppError::Internal(format!("Failed to decode encrypted base64: {}", e))
    })?;

    tracing::info!(
        "mydata encrypt ok: {} bytes -> {} encrypted bytes",
        data.len(),
        encrypted_bytes.len()
    );

    Ok(encrypted_bytes)
}

/// Decrypt MYDATA-encrypted data via the sidecar.
///
/// Calls `POST /mydata/decrypt` on the long-lived sidecar server. The
/// credential (ENG-1697) is either an exported SessionKey token or a
/// legacy delegate private key. The client must have authority for
/// `approve_key_policy` against the given `account_id`.
///
/// Returns: decrypted plaintext bytes.
pub async fn mydata_decrypt(
    client: &reqwest::Client,
    sidecar_url: &str,
    sidecar_secret: Option<&str>,
    encrypted_data: &[u8],
    credential: &MyDataCredential,
    package_id: &str,
    account_id: &str,
) -> Result<Vec<u8>, AppError> {
    let url = format!("{}/mydata/decrypt", sidecar_url);
    let data_b64 = BASE64.encode(encrypted_data);

    let mut req = client
        .post(&url)
        .json(&MyDataDecryptRequest {
            data: data_b64,
            package_id: package_id.to_string(),
            account_id: account_id.to_string(),
        });
    req = match credential {
        MyDataCredential::Session(s) => req.header("x-mydata-session", s),
        MyDataCredential::MemoryDelegateKey(k) => req.header("x-delegate-key", k),
    };
    if let Some(secret) = sidecar_secret {
        req = req.header("authorization", format!("Bearer {}", secret));
    }
    let resp = req
        .send()
        .await
        .map_err(|e| {
            AppError::Internal(format!("Sidecar mydata/decrypt request failed: {}. Is the sidecar running?", e))
        })?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        if let Ok(err) = serde_json::from_str::<SidecarError>(&body) {
            return Err(AppError::Internal(format!("mydata decrypt failed: {}", err.error)));
        }
        return Err(AppError::Internal(format!("mydata decrypt failed: {}", body)));
    }

    let result: MyDataDecryptResponse = resp.json().await.map_err(|e| {
        AppError::Internal(format!("Failed to parse mydata/decrypt response: {}", e))
    })?;

    let decrypted_bytes = BASE64.decode(&result.decrypted_data).map_err(|e| {
        AppError::Internal(format!("Failed to decode decrypted base64: {}", e))
    })?;

    tracing::info!(
        "mydata decrypt ok: {} encrypted bytes -> {} decrypted bytes",
        encrypted_data.len(),
        decrypted_bytes.len()
    );

    Ok(decrypted_bytes)
}



