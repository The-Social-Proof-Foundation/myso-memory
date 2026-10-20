use blake2::digest::{consts::U32, Digest};
use blake2::Blake2b;
use serde::Deserialize;

use crate::memory_contract::E_ACCOUNT_DEACTIVATED;

pub use crate::memory_contract::has_cap;

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
        .ok_or_else(|| {
            OnchainVerifyError::RpcError("Missing memory_account_id on SubAgent".into())
        })?;
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
    if !has_cap(capabilities, required_cap) {
        return Err(OnchainVerifyError::MissingCapability(format!(
            "SubAgent missing required capability bit {}",
            required_cap
        )));
    }

    Ok(SubAgentVerifyResult { owner })
}

/// Fetch MemoryAccount owner address (for owner co-sign verification).
pub async fn fetch_memory_account_owner(
    http_client: &reqwest::Client,
    rpc_url: &str,
    account_object_id: &str,
) -> Result<String, OnchainVerifyError> {
    verify_memory_account_active(http_client, rpc_url, account_object_id).await
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

    let active = fields
        .get("active")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    if !active {
        return Err(OnchainVerifyError::MemoryAccountDeactivated(format!(
            "Account {} has been deactivated (code={})",
            account_object_id, E_ACCOUNT_DEACTIVATED
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

    let stored_key = fields
        .get("public_key")
        .ok_or_else(|| OnchainVerifyError::RpcError("Missing public_key on SubAgent".into()))?;

    if let Some(stored_arr) = stored_key.as_array() {
        if *stored_arr == pk_as_numbers {
            return Ok(());
        }
    }

    Err(OnchainVerifyError::KeyNotFound(
        "Public key mismatch on SubAgent object".into(),
    ))
}

pub(crate) async fn fetch_object_fields(
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

    let rpc_response: RpcResponse = response.json().await.map_err(|e| {
        OnchainVerifyError::RpcError(format!("Failed to parse RPC response: {}", e))
    })?;

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
    crate::memory_contract::addresses_equal(a, b)
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
            OnchainVerifyError::MemoryAccountDeactivated(msg) => {
                write!(f, "Account deactivated: {}", msg)
            }
            OnchainVerifyError::SubAgentInactive(msg) => write!(f, "Sub-agent inactive: {}", msg),
            OnchainVerifyError::MissingCapability(msg) => write!(f, "Missing capability: {}", msg),
        }
    }
}

impl std::error::Error for OnchainVerifyError {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory_contract::{has_cap, CAP_MEMORY_READ, CAP_MEMORY_WRITE};

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
        assert!(has_cap(3, CAP_MEMORY_READ));
        assert!(has_cap(3, CAP_MEMORY_WRITE));
        assert!(!has_cap(CAP_MEMORY_READ, CAP_MEMORY_WRITE));
    }

    #[tokio::test]
    async fn canonical_agent_is_built_from_chain_alone() {
        let chain = crate::org_chain::mock_chain::MockChain::default();
        chain.put_object(
            "0x9d18",
            "0x00000000000000000000000000000000000000000000000000000000000050c1::memory::SubAgent",
            serde_json::json!({
                "memory_account_id": "0xacc0", "derived_address": "0xd399", "organization_id": "0xdea6",
                "label": "Chat assistant", "role_tags": "0", "registered_by": "0x0e7e", "created_at": "17",
                "active": true, "capabilities": "1048567", "delegatable_caps": "0", "identity_class": 1,
                "register_scope": 3, "depth": 1, "expires_at": null, "platform_scope": null,
                "parent_object_id": null,
                "constraints": { "fields": { "approval_required_caps": "0", "max_action_spend": null } },
            }),
        );
        let url = chain.serve().await;
        let package = crate::memory_contract::normalize_object_id("0x50c1");
        let agent = canonical_agent_by_object_id(&reqwest::Client::new(), &url, &package, "0x9d18")
            .await
            .unwrap();
        assert_eq!(agent.account_id, "0xacc0");
        assert_eq!(agent.organization_id.as_deref(), Some("0xdea6"));
        assert_eq!(agent.capabilities, 1048567);
        assert!(agent.active);
        assert_eq!(agent.created_at_ms, 17);

        let wrong_package = canonical_agent_by_object_id(&reqwest::Client::new(), &url, "0xbad", "0x9d18").await;
        assert!(wrong_package.is_err());
    }
}

/// Exact package/type verification for recovery ownership and registration bindings.
pub(crate) async fn fetch_typed_object_fields(http: &reqwest::Client, rpc: &str, id: &str, package: &str, name: &str) -> Result<serde_json::Map<String, serde_json::Value>, OnchainVerifyError> {
    let value: serde_json::Value = http.post(rpc).json(&serde_json::json!({"jsonrpc":"2.0","id":1,"method":"myso_getObject","params":[id,{"showContent":true}]})).send().await.map_err(|e| OnchainVerifyError::RpcError(e.to_string()))?.json().await.map_err(|e| OnchainVerifyError::RpcError(e.to_string()))?;
    let data = value.pointer("/result/data/content").ok_or_else(|| OnchainVerifyError::RpcError("Object missing".into()))?;
    let actual = data.get("type").and_then(|v| v.as_str()).unwrap_or_default();
    let mut parts = actual.split("::");
    if !addresses_equal(parts.next().unwrap_or_default(), package) || parts.next() != Some("memory") || parts.next() != Some(name) || parts.next().is_some() {
        return Err(OnchainVerifyError::RpcError("Unexpected recovery object type".into()));
    }
    data.get("fields").and_then(|v| v.as_object()).cloned().ok_or_else(|| OnchainVerifyError::RpcError("Object fields missing".into()))
}

/// Build the complete agent row from the on-chain `SubAgent` alone; indexers provide
/// discovery, never authority.
pub(crate) async fn canonical_agent_by_object_id(http: &reqwest::Client, rpc: &str, package: &str, agent_object_id: &str) -> Result<crate::social::SocialSubAgent, OnchainVerifyError> {
    use serde_json::Value;
    let f = fetch_typed_object_fields(http, rpc, agent_object_id, package, "SubAgent").await?;
    let fail = || OnchainVerifyError::RpcError("Incomplete canonical agent".into());
    let text = |key: &str| f.get(key).and_then(Value::as_str).map(String::from).ok_or_else(fail);
    let number = |key: &str| f.get(key).and_then(parse_u64_json).and_then(|n| i64::try_from(n).ok()).ok_or_else(fail);
    let created_at_ms = number("created_at")?;
    let row = crate::social::SocialSubAgent {
        agent_object_id: agent_object_id.to_string(),
        derived_address: text("derived_address")?,
        account_id: text("memory_account_id")?,
        label: text("label")?,
        identity_class: 0,
        role_tags: number("role_tags")?,
        capabilities: 0,
        delegatable_caps: 0,
        register_scope: 0,
        approval_required_caps: 0,
        max_action_spend: None,
        platform_scope: None,
        parent_object_id: None,
        depth: 0,
        registered_by: text("registered_by")?,
        expires_at_ms: None,
        active: false,
        created_at_ms,
        deactivated_at_ms: None,
        revoked_at_ms: None,
        updated_at_ms: created_at_ms,
        organization_id: None,
    };
    apply_canonical_agent_fields(row, &f)
}

fn apply_canonical_agent_fields(mut row: crate::social::SocialSubAgent, f: &serde_json::Map<String, serde_json::Value>) -> Result<crate::social::SocialSubAgent, OnchainVerifyError> {
    use serde_json::Value;
    let fail = || OnchainVerifyError::RpcError("Incomplete canonical agent policy".into());
    let number = |v: Option<&Value>| -> Result<u64, OnchainVerifyError> { v.and_then(|v|v.as_u64().or_else(||v.as_str()?.parse().ok())).ok_or_else(fail) };
    let string = |key: &str| -> Result<String,OnchainVerifyError> {f.get(key).and_then(Value::as_str).map(String::from).ok_or_else(fail)};
    let option = |v: Option<&Value>| -> Result<Option<Value>,OnchainVerifyError> {
        let v=v.ok_or_else(fail)?;
        if v.is_null(){return Ok(None);}
        if v.is_string() || v.is_number(){return Ok(Some(v.clone()));}
        let vec=v.get("vec").or_else(||v.pointer("/fields/vec")).and_then(Value::as_array).ok_or_else(fail)?;
        if vec.len()>1{return Err(fail());} Ok(vec.first().cloned())
    };
    if !addresses_equal(&string("memory_account_id")?, &row.account_id) || !addresses_equal(&string("derived_address")?, &row.derived_address) {return Err(fail());}
    row.account_id=string("memory_account_id")?;
    row.derived_address=string("derived_address")?;
    row.organization_id=Some(string("organization_id")?);
    row.active=f.get("active").and_then(Value::as_bool).ok_or_else(fail)?;
    row.capabilities=i64::try_from(number(f.get("capabilities"))?).map_err(|_|fail())?;
    row.delegatable_caps=i64::try_from(number(f.get("delegatable_caps"))?).map_err(|_|fail())?;
    row.identity_class=i16::try_from(number(f.get("identity_class"))?).map_err(|_|fail())?;
    row.register_scope=i16::try_from(number(f.get("register_scope"))?).map_err(|_|fail())?;
    row.depth=i16::try_from(number(f.get("depth"))?).map_err(|_|fail())?;
    let constraints=f.get("constraints").and_then(|v|v.get("fields").or(Some(v))).ok_or_else(fail)?;
    row.approval_required_caps=i64::try_from(number(constraints.get("approval_required_caps"))?).map_err(|_|fail())?;
    row.max_action_spend=option(constraints.get("max_action_spend"))?.map(|v| number(Some(&v)).and_then(|n|i64::try_from(n).map_err(|_|fail()))).transpose()?;
    row.expires_at_ms=option(f.get("expires_at"))?.map(|v| number(Some(&v)).and_then(|n|i64::try_from(n).map_err(|_|fail()))).transpose()?;
    row.platform_scope=option(f.get("platform_scope"))?.map(|v|v.as_str().map(String::from).ok_or_else(fail)).transpose()?;
    row.parent_object_id=option(f.get("parent_object_id"))?.map(|v|v.as_str().map(String::from).ok_or_else(fail)).transpose()?;
    row.revoked_at_ms=None;row.deactivated_at_ms=None;
    Ok(row)
}
