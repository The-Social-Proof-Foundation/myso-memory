use crate::types::{AppError, AuthInfo, SidecarError, VISIBILITY_ORG};
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
    #[serde(skip_serializing_if = "Option::is_none")]
    platform_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    platform_scope: Option<String>,
    /// Optional MYDATA identity hint for org vs owner policy routing on the sidecar.
    #[serde(skip_serializing_if = "Option::is_none")]
    mydata_owner: Option<String>,
    /// AgenticOrganization object id — required by the sidecar to build
    /// `approve_org_key_policy` for org-identity blobs.
    #[serde(skip_serializing_if = "Option::is_none")]
    organization_id: Option<String>,
    /// The org's `PermissionedGroup<MemorySharePackage>` object id, fetched from
    /// social-server's org summary endpoint (never derived locally).
    #[serde(skip_serializing_if = "Option::is_none")]
    org_memory_group_id: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MyDataDecryptResponse {
    decrypted_data: String,
}

/// Select the MYDATA `owner` / key identity used at encrypt time.
///
/// Private and account-visible blobs bind to the human owner address. Org-visible
/// blobs (visibility tier 1 / `VISIBILITY_ORG`) bind to the organization object id
/// so org members share a cryptographic namespace gated by `approve_org_key_policy`.
/// When org visibility is requested without an organization id, fall back to the
/// owner address so legacy rows and callers keep working.
pub fn select_mydata_owner(
    visibility: i16,
    owner: &str,
    organization_id: Option<&str>,
) -> String {
    if visibility == VISIBILITY_ORG {
        organization_id
            .filter(|id| !id.is_empty())
            .unwrap_or(owner)
            .to_string()
    } else {
        owner.to_string()
    }
}

/// Encrypt plaintext using MYDATA threshold encryption via HTTP sidecar.
///
/// Calls the long-lived sidecar server at `POST /mydata/encrypt`.
/// Org-visible rows use `organization_id` as the MYDATA owner field; other tiers
/// use the human owner address.
///
/// Returns: MYDATA encrypted bytes
pub async fn mydata_encrypt(
    client: &reqwest::Client,
    sidecar_url: &str,
    sidecar_secret: Option<&str>,
    data: &[u8],
    owner_address: &str,
    package_id: &str,
    visibility: i16,
    organization_id: Option<&str>,
) -> Result<Vec<u8>, AppError> {
    let mydata_owner = select_mydata_owner(visibility, owner_address, organization_id);
    let url = format!("{}/mydata/encrypt", sidecar_url);
    let data_b64 = BASE64.encode(data);

    let mut req = client
        .post(&url)
        .json(&MyDataEncryptRequest {
            data: data_b64,
            owner: mydata_owner,
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
        "mydata encrypt ok: {} bytes -> {} encrypted bytes (visibility={})",
        data.len(),
        encrypted_bytes.len(),
        visibility
    );

    Ok(encrypted_bytes)
}

/// Decrypt MYDATA-encrypted data via the sidecar, with dual-identity fallback
/// for org-visible blobs.
///
/// Calls `POST /mydata/decrypt` on the long-lived sidecar server. The
/// credential (ENG-1697) is either an exported SessionKey token or a
/// legacy delegate private key.
///
/// Org-visible blobs try the organization identity first (the sidecar routes to
/// `approve_org_key_policy` using `org_memory_group_id`), then fall back to the
/// owner identity so legacy pre-org blobs keep decrypting. Other tiers use the
/// owner-suffix `approve_key_policy` path unchanged.
///
/// Returns: decrypted plaintext bytes.
#[allow(clippy::too_many_arguments)]
pub async fn mydata_decrypt(
    client: &reqwest::Client,
    sidecar_url: &str,
    sidecar_secret: Option<&str>,
    encrypted_data: &[u8],
    credential: &MyDataCredential,
    package_id: &str,
    account_id: &str,
    platform_id: Option<&str>,
    platform_scope: Option<&str>,
    visibility: i16,
    owner: &str,
    organization_id: Option<&str>,
    org_memory_group_id: Option<&str>,
) -> Result<Vec<u8>, AppError> {
    if visibility != VISIBILITY_ORG {
        return mydata_decrypt_with_owner_hint(
            client,
            sidecar_url,
            sidecar_secret,
            encrypted_data,
            credential,
            package_id,
            account_id,
            platform_id,
            platform_scope,
            None,
            None,
            None,
        )
        .await;
    }

    if let Some(org_id) = organization_id.filter(|id| !id.is_empty()) {
        match mydata_decrypt_with_owner_hint(
            client,
            sidecar_url,
            sidecar_secret,
            encrypted_data,
            credential,
            package_id,
            account_id,
            platform_id,
            platform_scope,
            Some(org_id),
            Some(org_id),
            org_memory_group_id,
        )
        .await
        {
            Ok(bytes) => return Ok(bytes),
            Err(e) => {
                tracing::debug!(
                    "org MYDATA identity decrypt failed (org={}), trying owner legacy: {}",
                    org_id,
                    e
                );
            }
        }
    }

    mydata_decrypt_with_owner_hint(
        client,
        sidecar_url,
        sidecar_secret,
        encrypted_data,
        credential,
        package_id,
        account_id,
        platform_id,
        platform_scope,
        Some(owner),
        None,
        None,
    )
    .await
}

/// Restore-path decrypt. Same dual-identity behavior as [`mydata_decrypt`];
/// kept as a named entry point for restore call-site clarity.
#[allow(clippy::too_many_arguments)]
pub async fn mydata_decrypt_restore(
    client: &reqwest::Client,
    sidecar_url: &str,
    sidecar_secret: Option<&str>,
    encrypted_data: &[u8],
    credential: &MyDataCredential,
    package_id: &str,
    account_id: &str,
    platform_id: Option<&str>,
    platform_scope: Option<&str>,
    visibility: i16,
    owner: &str,
    organization_id: Option<&str>,
    org_memory_group_id: Option<&str>,
) -> Result<Vec<u8>, AppError> {
    mydata_decrypt(
        client,
        sidecar_url,
        sidecar_secret,
        encrypted_data,
        credential,
        package_id,
        account_id,
        platform_id,
        platform_scope,
        visibility,
        owner,
        organization_id,
        org_memory_group_id,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn mydata_decrypt_with_owner_hint(
    client: &reqwest::Client,
    sidecar_url: &str,
    sidecar_secret: Option<&str>,
    encrypted_data: &[u8],
    credential: &MyDataCredential,
    package_id: &str,
    account_id: &str,
    platform_id: Option<&str>,
    platform_scope: Option<&str>,
    mydata_owner_hint: Option<&str>,
    organization_id: Option<&str>,
    org_memory_group_id: Option<&str>,
) -> Result<Vec<u8>, AppError> {
    let url = format!("{}/mydata/decrypt", sidecar_url);
    let data_b64 = BASE64.encode(encrypted_data);

    let mut req = client
        .post(&url)
        .json(&MyDataDecryptRequest {
            data: data_b64,
            package_id: package_id.to_string(),
            account_id: account_id.to_string(),
            platform_id: platform_id.map(|s| s.to_string()),
            platform_scope: platform_scope.map(|s| s.to_string()),
            mydata_owner: mydata_owner_hint.map(|s| s.to_string()),
            organization_id: organization_id.map(|s| s.to_string()),
            org_memory_group_id: org_memory_group_id.map(|s| s.to_string()),
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

#[cfg(test)]
mod tests {
    use super::select_mydata_owner;
    use crate::types::{VISIBILITY_ACCOUNT, VISIBILITY_ORG, VISIBILITY_PRIVATE};

    #[test]
    fn select_mydata_owner_private_uses_owner() {
        assert_eq!(
            select_mydata_owner(VISIBILITY_PRIVATE, "0xowner", Some("0xorg")),
            "0xowner"
        );
    }

    #[test]
    fn select_mydata_owner_account_uses_owner() {
        assert_eq!(
            select_mydata_owner(VISIBILITY_ACCOUNT, "0xowner", Some("0xorg")),
            "0xowner"
        );
    }

    #[test]
    fn select_mydata_owner_org_uses_organization_id() {
        assert_eq!(
            select_mydata_owner(VISIBILITY_ORG, "0xowner", Some("0xorg")),
            "0xorg"
        );
    }

    #[test]
    fn select_mydata_owner_org_without_org_id_falls_back_to_owner() {
        assert_eq!(
            select_mydata_owner(VISIBILITY_ORG, "0xowner", None),
            "0xowner"
        );
        assert_eq!(
            select_mydata_owner(VISIBILITY_ORG, "0xowner", Some("")),
            "0xowner"
        );
    }
}
