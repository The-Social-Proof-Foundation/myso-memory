use blake2::Blake2b;
use blake2::digest::{consts::U32, Digest};
use serde::Deserialize;

/// Capability bits from `social_contracts::memory`.
pub const CAP_MEMORY_READ: u64 = 1;
pub const CAP_MEMORY_WRITE: u64 = 2;

pub fn has_capability(capabilities: u64, required: u64) -> bool {
    capabilities & required == required
}

/// Derive a MySo address from an Ed25519 public key (scheme flag 0x00 + blake2b-256).
pub fn derived_address_from_public_key(public_key_bytes: &[u8; 32]) -> String {
    let mut input = [0u8; 33];
    input[0] = 0x00;
    input[1..].copy_from_slice(public_key_bytes);
    let hash = Blake2b::<U32>::digest(input);
    format!("0x{}", hex::encode(&hash[..32]))
}

pub struct SubAgentVerifyResult {
    pub owner: String,
    pub account_id: String,
    pub agent_object_id: String,
    pub derived_address: String,
    pub capabilities: u64,
}

/// Verify a sub-agent against on-chain SubAgent + MemoryAccount objects.
pub async fn verify_sub_agent_onchain(
    http_client: &reqwest::Client,
    rpc_url: &str,
    account_object_id: &str,
    agent_object_id: &str,
    public_key_bytes: &[u8; 32],
    required_cap: u64,
) -> Result<SubAgentVerifyResult, OnchainVerifyError> {
    let owner = verify_memory_account_active(http_client, rpc_url, account_object_id).await?;
    let agent_fields = fetch_object_fields(http_client, rpc_url, agent_object_id).await?;

    let memory_account_id = agent_fields
        .get("memory_account_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| OnchainVerifyError::RpcError("Missing memory_account_id on SubAgent".into()))?;
    if memory_account_id != account_object_id {
        return Err(OnchainVerifyError::RpcError(
            "SubAgent memory_account_id mismatch".into(),
        ));
    }

    let derived_address = agent_fields
        .get("derived_address")
        .and_then(|v| v.as_str())
        .ok_or_else(|| OnchainVerifyError::RpcError("Missing derived_address on SubAgent".into()))?
        .to_string();

    let expected_derived = derived_address_from_public_key(public_key_bytes);
    if !addresses_equal(&derived_address, &expected_derived) {
        return Err(OnchainVerifyError::KeyNotFound(
            "Public key does not match SubAgent derived_address".into(),
        ));
    }

    verify_public_key_field(&agent_fields, public_key_bytes)?;

    let active = agent_fields
        .get("active")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !active {
        return Err(OnchainVerifyError::SubAgentInactive(
            "SubAgent is deactivated".into(),
        ));
    }

    if let Some(expires_at) = agent_fields.get("expires_at").and_then(parse_u64_json) {
        let now_ms = chrono::Utc::now().timestamp_millis() as u64;
        if now_ms > expires_at {
            return Err(OnchainVerifyError::SubAgentInactive(
                "SubAgent has expired".into(),
            ));
        }
    }

    let capabilities = agent_fields
        .get("capabilities")
        .and_then(parse_u64_json)
        .unwrap_or(0);
    if !has_capability(capabilities, required_cap) {
        return Err(OnchainVerifyError::MissingCapability(format!(
            "SubAgent missing required capability bit {}",
            required_cap
        )));
    }

    Ok(SubAgentVerifyResult {
        owner,
        account_id: account_object_id.to_string(),
        agent_object_id: agent_object_id.to_string(),
        derived_address,
        capabilities,
    })
}

async fn verify_memory_account_active(
    http_client: &reqwest::Client,
    rpc_url: &str,
    account_object_id: &str,
) -> Result<String, OnchainVerifyError> {
    let fields = fetch_object_fields(http_client, rpc_url, account_object_id).await?;

    let owner = fields
        .get("owner")
        .and_then(|v| v.as_str())
        .ok_or_else(|| OnchainVerifyError::RpcError("Missing owner on MemoryAccount".into()))?
        .to_string();

    let active = fields.get("active").and_then(|v| v.as_bool()).unwrap_or(true);
    if !active {
        return Err(OnchainVerifyError::MemoryAccountDeactivated(format!(
            "Account {} has been deactivated",
            account_object_id
        )));
    }

    Ok(owner)
}

fn verify_public_key_field(
    fields: &serde_json::Map<String, serde_json::Value>,
    public_key_bytes: &[u8; 32],
) -> Result<(), OnchainVerifyError> {
    let pk_as_numbers: Vec<serde_json::Value> = public_key_bytes
        .iter()
        .map(|&b| serde_json::Value::Number(b.into()))
        .collect();

    let stored_key = fields.get("public_key").ok_or_else(|| {
        OnchainVerifyError::RpcError("Missing public_key on SubAgent".into())
    })?;

    if let Some(stored_arr) = stored_key.as_array() {
        if *stored_arr == pk_as_numbers {
            return Ok(());
        }
    }

    Err(OnchainVerifyError::KeyNotFound(
        "Public key mismatch on SubAgent object".into(),
    ))
}

async fn fetch_object_fields(
    http_client: &reqwest::Client,
    rpc_url: &str,
    object_id: &str,
) -> Result<serde_json::Map<String, serde_json::Value>, OnchainVerifyError> {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "myso_getObject",
        "params": [object_id, { "showContent": true }]
    });

    let response = http_client
        .post(rpc_url)
        .json(&body)
        .send()
        .await
        .map_err(|e| OnchainVerifyError::RpcError(format!("HTTP request failed: {}", e)))?;

    let rpc_response: RpcResponse = response
        .json()
        .await
        .map_err(|e| OnchainVerifyError::RpcError(format!("Failed to parse RPC response: {}", e)))?;

    if let Some(error) = rpc_response.error {
        return Err(OnchainVerifyError::RpcError(format!(
            "RPC error {}: {}",
            error.code, error.message
        )));
    }

    let fields = rpc_response
        .result
        .and_then(|r| r.data)
        .and_then(|d| d.content)
        .and_then(|c| c.fields)
        .ok_or_else(|| OnchainVerifyError::RpcError("Object has no fields".into()))?;

    Ok(fields)
}

fn parse_u64_json(value: &serde_json::Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|n| u64::try_from(n).ok()))
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
}

fn addresses_equal(a: &str, b: &str) -> bool {
    a.trim_start_matches("0x")
        .eq_ignore_ascii_case(b.trim_start_matches("0x"))
}

#[derive(Debug, Deserialize)]
struct RpcResponse {
    result: Option<RpcResult>,
    error: Option<RpcError>,
}

#[derive(Debug, Deserialize)]
struct RpcError {
    code: i64,
    message: String,
}

#[derive(Debug, Deserialize)]
struct RpcResult {
    data: Option<ObjectData>,
}

#[derive(Debug, Deserialize)]
struct ObjectData {
    content: Option<ObjectContent>,
}

#[derive(Debug, Deserialize)]
struct ObjectContent {
    fields: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug)]
pub enum OnchainVerifyError {
    RpcError(String),
    KeyNotFound(String),
    MemoryAccountDeactivated(String),
    SubAgentInactive(String),
    MissingCapability(String),
}

impl std::fmt::Display for OnchainVerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OnchainVerifyError::RpcError(msg) => write!(f, "MySo RPC error: {}", msg),
            OnchainVerifyError::KeyNotFound(msg) => write!(f, "Key not found: {}", msg),
            OnchainVerifyError::MemoryAccountDeactivated(msg) => write!(f, "Account deactivated: {}", msg),
            OnchainVerifyError::SubAgentInactive(msg) => write!(f, "Sub-agent inactive: {}", msg),
            OnchainVerifyError::MissingCapability(msg) => write!(f, "Missing capability: {}", msg),
        }
    }
}

impl std::error::Error for OnchainVerifyError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derived_address_is_deterministic() {
        let pk = [7u8; 32];
        let a = derived_address_from_public_key(&pk);
        let b = derived_address_from_public_key(&pk);
        assert_eq!(a, b);
        assert!(a.starts_with("0x"));
        assert_eq!(a.len(), 66);
    }

    #[test]
    fn capability_check_requires_all_bits() {
        assert!(has_capability(3, CAP_MEMORY_READ));
        assert!(has_capability(3, CAP_MEMORY_WRITE));
        assert!(!has_capability(CAP_MEMORY_READ, CAP_MEMORY_WRITE));
    }

    #[test]
    fn addresses_equal_ignores_case_and_prefix() {
        assert!(addresses_equal("0xAbCd", "0xabcd"));
        assert!(addresses_equal("AbCd", "0xabcd"));
    }
}
