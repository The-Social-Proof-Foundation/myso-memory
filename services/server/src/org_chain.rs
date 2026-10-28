//! Org memory authorization read directly from canonical chain state.
//!
//! An org's memory share group is the `PermissionedGroup<MemorySharePackage>` that
//! `memory::ensure_org_memory_group` claims from the org UID with `OrgMemoryGroupTag`, so
//! its address is derivable and cannot be squatted. Grants are `address -> VecSet<TypeName>`
//! dynamic fields on the group's `PermissionsTable`; revoking the last permission deletes
//! the field. Checks mirror `memory::has_org_permission` and
//! `assert_organization_belongs_to_account` against current object state — no indexer and
//! no cache, so a revocation applies as soon as the fullnode has executed it.
//!
//! Outcomes are binary on purpose: `Ok(perms)` when chain state was read (no access is
//! `OrgMemoryPerms::default()`), `Err(ChainUnavailable)` when it could not be verified.

use blake2::digest::{consts::U32, Digest};
use blake2::Blake2b;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// `HashingIntentScope::ChildObjectId` — prefix of `dynamic_field::hash_type_and_key`.
const CHILD_OBJECT_ID_SCOPE: u8 = 0xf0;
/// BCS variant index of `TypeTag::Struct`.
const TYPE_TAG_STRUCT: u8 = 7;
/// BCS of `DerivedObjectKey(OrgMemoryGroupTag())`: Move gives field-less structs a
/// `dummy_field: bool`, so the key is a single `false` byte.
const ORG_MEMORY_GROUP_KEY_BCS: [u8; 1] = [0];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrgMemoryPerms {
    pub reader: bool,
    pub writer: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GraphSellerAuthority {
    OrganizationAdmin,
    SellGraphDelegate,
}

/// The authenticated member whose org permissions are checked. Every field must come
/// from on-chain verified identity (the agent's `SubAgent` and `MemoryAccount`).
#[derive(Debug, Clone, Copy)]
pub struct OrgMember<'a> {
    pub organization_id: &'a str,
    pub account_id: &'a str,
    pub owner: &'a str,
    pub member: &'a str,
}

/// Chain state could not be read or had an unexpected shape. Callers fail closed.
#[derive(Debug)]
pub struct ChainUnavailable(pub String);

impl std::fmt::Display for ChainUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "org chain state unavailable: {}", self.0)
    }
}

impl std::error::Error for ChainUnavailable {}

/// Canonical object id of an org's memory share group (whether or not it exists yet).
pub fn org_memory_group_id(package_id: &str, organization_id: &str) -> Option<String> {
    let parent = parse_address(organization_id)?;
    let package = parse_address(package_id)?;
    let mut framework = [0u8; 32];
    framework[31] = 2;
    let tag_param = struct_type_tag(&package, "memory", "OrgMemoryGroupTag", &[]);
    let key_type = struct_type_tag(&framework, "derived_object", "DerivedObjectKey", &[tag_param]);

    let mut hasher = Blake2b::<U32>::new();
    hasher.update([CHILD_OBJECT_ID_SCOPE]);
    hasher.update(parent);
    hasher.update((ORG_MEMORY_GROUP_KEY_BCS.len() as u64).to_le_bytes());
    hasher.update(ORG_MEMORY_GROUP_KEY_BCS);
    hasher.update(key_type);
    Some(format!("0x{}", hex::encode(hasher.finalize())))
}

/// Resolve `OrgMemoryReader` / `OrgMemoryWriter` for `member` from current chain state.
pub async fn resolve_org_memory_perms(
    http: &reqwest::Client,
    rpc_url: &str,
    package_id: &str,
    member: OrgMember<'_>,
) -> Result<OrgMemoryPerms, ChainUnavailable> {
    let org_id = canonical_address(member.organization_id)
        .ok_or_else(|| ChainUnavailable("organization id is not an address".into()))?;
    let member_address = canonical_address(member.member)
        .ok_or_else(|| ChainUnavailable("member is not an address".into()))?;
    let group_id = org_memory_group_id(package_id, &org_id)
        .ok_or_else(|| ChainUnavailable("package id is not an address".into()))?;

    let (account, org, group) = tokio::try_join!(
        get_object(http, rpc_url, member.account_id),
        get_object(http, rpc_url, &org_id),
        get_object(http, rpc_url, &group_id),
    )?;
    let Some(account) = account.filter(|o| is_memory_type(&o.type_, package_id, "MemoryAccount"))
    else {
        return Ok(OrgMemoryPerms::default());
    };
    let Some(org) = org.filter(|o| is_memory_type(&o.type_, package_id, "AgenticOrganization"))
    else {
        return Ok(OrgMemoryPerms::default());
    };
    if !org_belongs_to_member(&org.fields, &account.fields, &member)? {
        return Ok(OrgMemoryPerms::default());
    }
    let Some(group) = group.filter(|o| o.type_ == memory_share_group_type(package_id)) else {
        return Ok(OrgMemoryPerms::default());
    };

    let orgs_table = nested_uid(&account.fields, "organizations")?;
    let permissions_table = nested_uid(&group.fields, "permissions")?;
    let (registered, grants) = tokio::try_join!(
        get_dynamic_field(http, rpc_url, &orgs_table, "0x2::object::ID", &org_id),
        get_dynamic_field(http, rpc_url, &permissions_table, "address", &member_address),
    )?;
    if registered.is_none() {
        return Ok(OrgMemoryPerms::default());
    }
    match grants {
        Some(value) => perms_from_permission_set(&value, package_id),
        None => Ok(OrgMemoryPerms::default()),
    }
}

/// Look up a sub-agent object id in `MemoryAccount.agents` (keyed by derived address).
/// `Ok(None)` when the account has no such agent.
pub async fn agent_object_id_in_account(
    http: &reqwest::Client,
    rpc_url: &str,
    package_id: &str,
    account_id: &str,
    derived_address: &str,
) -> Result<Option<String>, ChainUnavailable> {
    let derived = canonical_address(derived_address)
        .ok_or_else(|| ChainUnavailable("derived address is not an address".into()))?;
    let Some(account) = get_object(http, rpc_url, account_id)
        .await?
        .filter(|o| is_memory_type(&o.type_, package_id, "MemoryAccount"))
    else {
        return Ok(None);
    };
    let agents_table = nested_uid(&account.fields, "agents")?;
    let Some(entry) = get_dynamic_field(http, rpc_url, &agents_table, "address", &derived).await?
    else {
        return Ok(None);
    };
    entry
        .pointer("/fields/agent_object_id")
        .and_then(Value::as_str)
        .map(|id| Some(id.to_string()))
        .ok_or_else(|| ChainUnavailable("agent registry entry has no agent_object_id".into()))
}

/// Read an org's principal owner, or `None` when the org object does not exist.
pub async fn org_principal_owner(
    http: &reqwest::Client,
    rpc_url: &str,
    package_id: &str,
    organization_id: &str,
) -> Result<Option<String>, ChainUnavailable> {
    let Some(org) = get_object(http, rpc_url, organization_id)
        .await?
        .filter(|o| is_memory_type(&o.type_, package_id, "AgenticOrganization"))
    else {
        return Ok(None);
    };
    string_field(&org.fields, "principal_owner").map(Some)
}

/// Verify graph-selling authority against current canonical chain state. The
/// organization principal owner is an admin. An explicitly delegated member
/// must hold the existing `OrgAgentManager` permission in the org memory group;
/// the publication record narrows that broad org permission to graph selling.
pub async fn verify_graph_seller_authority(
    http: &reqwest::Client,
    rpc_url: &str,
    package_id: &str,
    organization_id: &str,
    seller_address: &str,
) -> Result<Option<GraphSellerAuthority>, ChainUnavailable> {
    let org_id = canonical_address(organization_id)
        .ok_or_else(|| ChainUnavailable("organization id is not an address".into()))?;
    let seller = canonical_address(seller_address)
        .ok_or_else(|| ChainUnavailable("seller address is not an address".into()))?;
    let Some(org) = get_object(http, rpc_url, &org_id)
        .await?
        .filter(|o| is_memory_type(&o.type_, package_id, "AgenticOrganization"))
    else {
        return Ok(None);
    };
    if !bool_field(&org.fields, "active")? {
        return Ok(None);
    }
    let account_id = string_field(&org.fields, "memory_account_id")?;
    let Some(account) = get_object(http, rpc_url, &account_id)
        .await?
        .filter(|o| is_memory_type(&o.type_, package_id, "MemoryAccount"))
    else {
        return Ok(None);
    };
    if !bool_field(&account.fields, "active")?
        || !same_address(&string_field(&org.fields, "principal_owner")?, &string_field(&account.fields, "owner")?)
        || org.fields.get("profile_id") != account.fields.get("profile_id")
    {
        return Ok(None);
    }
    let orgs_table = nested_uid(&account.fields, "organizations")?;
    if get_dynamic_field(http, rpc_url, &orgs_table, "0x2::object::ID", &org_id)
        .await?
        .is_none()
    {
        return Ok(None);
    }
    if same_address(&string_field(&org.fields, "principal_owner")?, &seller) {
        return Ok(Some(GraphSellerAuthority::OrganizationAdmin));
    }
    let group_id = org_memory_group_id(package_id, &org_id)
        .ok_or_else(|| ChainUnavailable("package id is not an address".into()))?;
    let Some(group) = get_object(http, rpc_url, &group_id)
        .await?
        .filter(|o| o.type_ == memory_share_group_type(package_id))
    else {
        return Ok(None);
    };
    let permissions_table = nested_uid(&group.fields, "permissions")?;
    let Some(grants) = get_dynamic_field(http, rpc_url, &permissions_table, "address", &seller).await? else {
        return Ok(None);
    };
    let manager = permission_type_name(package_id, "OrgAgentManager");
    let contents = grants.pointer("/fields/contents").and_then(Value::as_array)
        .ok_or_else(|| ChainUnavailable("permission set has no contents".into()))?;
    if contents.iter().filter_map(|entry| entry.pointer("/fields/name").and_then(Value::as_str)).any(|name| name == manager) {
        Ok(Some(GraphSellerAuthority::SellGraphDelegate))
    } else {
        Ok(None)
    }
}

/// Verify a treasury signer against the current organization owner or the live
/// ExtensionPermissionsAdmin grant on the organization's canonical memory group.
/// The caller must separately bind the organization to the authenticated owner.
pub async fn verify_org_treasury_admin(
    http: &reqwest::Client,
    rpc_url: &str,
    package_id: &str,
    organization_id: &str,
    signer_address: &str,
) -> Result<bool, ChainUnavailable> {
    let org_id = canonical_address(organization_id)
        .ok_or_else(|| ChainUnavailable("organization id is not an address".into()))?;
    let signer = canonical_address(signer_address)
        .ok_or_else(|| ChainUnavailable("treasury signer is not an address".into()))?;
    let Some(org) = get_object(http, rpc_url, &org_id)
        .await?
        .filter(|object| is_memory_type(&object.type_, package_id, "AgenticOrganization"))
    else {
        return Ok(false);
    };
    if !bool_field(&org.fields, "active")? {
        return Ok(false);
    }
    let principal_owner = canonical_address(&string_field(&org.fields, "principal_owner")?)
        .ok_or_else(|| ChainUnavailable("organization owner is not an address".into()))?;
    if principal_owner == signer {
        return Ok(true);
    }
    let group_id = org_memory_group_id(package_id, &org_id)
        .ok_or_else(|| ChainUnavailable("package id is not an address".into()))?;
    let Some(group) = get_object(http, rpc_url, &group_id)
        .await?
        .filter(|object| object.type_ == memory_share_group_type(package_id))
    else {
        return Ok(false);
    };
    let permissions_table = nested_uid(&group.fields, "permissions")?;
    let Some(grants) = get_dynamic_field(http, rpc_url, &permissions_table, "address", &signer).await? else {
        return Ok(false);
    };
    let contents = grants.pointer("/fields/contents").and_then(Value::as_array)
        .ok_or_else(|| ChainUnavailable("permission set has no contents".into()))?;
    let admin = permission_type_name(package_id, "ExtensionPermissionsAdmin");
    Ok(contents.iter().filter_map(|entry| entry.pointer("/fields/name").and_then(Value::as_str))
        .any(|name| name == admin))
}

fn org_belongs_to_member(
    org: &Map<String, Value>,
    account: &Map<String, Value>,
    member: &OrgMember<'_>,
) -> Result<bool, ChainUnavailable> {
    let account_owner = string_field(account, "owner")?;
    Ok(bool_field(account, "active")?
        && bool_field(org, "active")?
        && same_address(&string_field(org, "memory_account_id")?, member.account_id)
        && same_address(&string_field(org, "principal_owner")?, &account_owner)
        && same_address(&account_owner, member.owner)
        && org.get("profile_id") == account.get("profile_id"))
}

fn perms_from_permission_set(
    value: &Value,
    package_id: &str,
) -> Result<OrgMemoryPerms, ChainUnavailable> {
    let contents = value
        .pointer("/fields/contents")
        .and_then(Value::as_array)
        .ok_or_else(|| ChainUnavailable("permission set has no contents".into()))?;
    let reader = permission_type_name(package_id, "OrgMemoryReader");
    let writer = permission_type_name(package_id, "OrgMemoryWriter");
    let mut perms = OrgMemoryPerms::default();
    for name in contents
        .iter()
        .filter_map(|entry| entry.pointer("/fields/name").and_then(Value::as_str))
    {
        perms.reader |= name == reader;
        perms.writer |= name == writer;
    }
    Ok(perms)
}

/// `type_name::with_original_ids` rendering: unprefixed, zero-padded address.
fn permission_type_name(package_id: &str, permission: &str) -> String {
    let package = canonical_address(package_id).unwrap_or_default();
    format!("{}::memory::{}", package.trim_start_matches("0x"), permission)
}

fn memory_share_group_type(package_id: &str) -> String {
    format!(
        "0x2::permissioned_group::PermissionedGroup<{}::memory::MemorySharePackage>",
        canonical_address(package_id).unwrap_or_default()
    )
}

fn is_memory_type(actual: &str, package_id: &str, name: &str) -> bool {
    let mut parts = actual.split("::");
    parts.next().is_some_and(|address| same_address(address, package_id))
        && parts.next() == Some("memory")
        && parts.next() == Some(name)
        && parts.next().is_none()
}

struct ChainObject {
    type_: String,
    fields: Map<String, Value>,
}

async fn get_object(
    http: &reqwest::Client,
    rpc_url: &str,
    object_id: &str,
) -> Result<Option<ChainObject>, ChainUnavailable> {
    let result = rpc(
        http,
        rpc_url,
        "myso_getObject",
        json!([object_id, { "showContent": true }]),
    )
    .await?;
    if let Some(code) = result.pointer("/error/code").and_then(Value::as_str) {
        return match code {
            "notExists" | "deleted" => Ok(None),
            other => Err(ChainUnavailable(format!("object {object_id}: {other}"))),
        };
    }
    let content = result
        .pointer("/data/content")
        .ok_or_else(|| ChainUnavailable(format!("object {object_id} has no content")))?;
    let type_ = content
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| ChainUnavailable(format!("object {object_id} has no type")))?;
    let fields = content
        .get("fields")
        .and_then(Value::as_object)
        .ok_or_else(|| ChainUnavailable(format!("object {object_id} has no fields")))?;
    Ok(Some(ChainObject {
        type_: type_.to_string(),
        fields: fields.clone(),
    }))
}

/// Value of the dynamic field `name` on `parent`, or `None` when it does not exist.
async fn get_dynamic_field(
    http: &reqwest::Client,
    rpc_url: &str,
    parent: &str,
    name_type: &str,
    name_value: &str,
) -> Result<Option<Value>, ChainUnavailable> {
    let result = rpc(
        http,
        rpc_url,
        "mysox_getDynamicFieldObject",
        json!([parent, { "type": name_type, "value": name_value }]),
    )
    .await?;
    if let Some(code) = result.pointer("/error/code").and_then(Value::as_str) {
        return match code {
            "dynamicFieldNotFound" | "notExists" | "deleted" => Ok(None),
            other => Err(ChainUnavailable(format!("dynamic field on {parent}: {other}"))),
        };
    }
    result
        .pointer("/data/content/fields/value")
        .cloned()
        .map(Some)
        .ok_or_else(|| ChainUnavailable(format!("dynamic field on {parent} has no value")))
}

async fn rpc(
    http: &reqwest::Client,
    rpc_url: &str,
    method: &str,
    params: Value,
) -> Result<Value, ChainUnavailable> {
    let response = http
        .post(rpc_url)
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }))
        .send()
        .await
        .map_err(|e| ChainUnavailable(format!("{method} request failed: {e}")))?;
    if !response.status().is_success() {
        return Err(ChainUnavailable(format!("{method} returned {}", response.status())));
    }
    let mut body: Value = response
        .json()
        .await
        .map_err(|e| ChainUnavailable(format!("{method} response invalid: {e}")))?;
    if let Some(error) = body.get("error") {
        return Err(ChainUnavailable(format!("{method} error: {error}")));
    }
    body.get_mut("result")
        .map(Value::take)
        .ok_or_else(|| ChainUnavailable(format!("{method} returned no result")))
}

fn nested_uid(fields: &Map<String, Value>, field: &str) -> Result<String, ChainUnavailable> {
    fields
        .get(field)
        .and_then(|v| v.pointer("/fields/id/id"))
        .and_then(Value::as_str)
        .map(String::from)
        .ok_or_else(|| ChainUnavailable(format!("{field} has no table id")))
}

fn string_field(fields: &Map<String, Value>, field: &str) -> Result<String, ChainUnavailable> {
    fields
        .get(field)
        .and_then(Value::as_str)
        .map(String::from)
        .ok_or_else(|| ChainUnavailable(format!("missing {field}")))
}

fn bool_field(fields: &Map<String, Value>, field: &str) -> Result<bool, ChainUnavailable> {
    fields
        .get(field)
        .and_then(Value::as_bool)
        .ok_or_else(|| ChainUnavailable(format!("missing {field}")))
}

fn struct_type_tag(address: &[u8; 32], module: &str, name: &str, params: &[Vec<u8>]) -> Vec<u8> {
    let mut out = vec![TYPE_TAG_STRUCT];
    out.extend_from_slice(address);
    push_identifier(&mut out, module);
    push_identifier(&mut out, name);
    out.push(params.len() as u8);
    for param in params {
        out.extend_from_slice(param);
    }
    out
}

/// BCS identifier: ULEB128 length (single byte for Move identifiers) + UTF-8 bytes.
fn push_identifier(out: &mut Vec<u8>, ident: &str) {
    out.push(ident.len() as u8);
    out.extend_from_slice(ident.as_bytes());
}

fn parse_address(value: &str) -> Option<[u8; 32]> {
    let hex = value.strip_prefix("0x").unwrap_or(value);
    if hex.is_empty() || hex.len() > 64 {
        return None;
    }
    let bytes = hex::decode(format!("{hex:0>64}")).ok()?;
    bytes.try_into().ok()
}

fn canonical_address(value: &str) -> Option<String> {
    parse_address(value).map(|bytes| format!("0x{}", hex::encode(bytes)))
}

fn same_address(a: &str, b: &str) -> bool {
    matches!((parse_address(a), parse_address(b)), (Some(a), Some(b)) if a == b)
}

#[cfg(test)]
pub(crate) mod mock_chain {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    use axum::{extract::State, routing::post, Json, Router};
    use serde_json::{json, Value};

    /// In-memory JSON-RPC fullnode serving `myso_getObject` and `mysox_getDynamicFieldObject`.
    #[derive(Clone, Default)]
    pub struct MockChain {
        objects: Arc<Mutex<HashMap<String, Value>>>,
        fields: Arc<Mutex<HashMap<(String, String), Value>>>,
    }

    impl MockChain {
        pub fn put_object(&self, id: &str, type_: &str, fields: Value) {
            let content = json!({ "data": { "content": { "type": type_, "fields": fields } } });
            self.objects.lock().unwrap().insert(key(id), content);
        }

        pub fn remove_object(&self, id: &str) {
            self.objects.lock().unwrap().remove(&key(id));
        }

        pub fn put_field(&self, parent: &str, name: &str, value: Value) {
            self.fields
                .lock()
                .unwrap()
                .insert((key(parent), key(name)), value);
        }

        pub fn remove_field(&self, parent: &str, name: &str) {
            self.fields.lock().unwrap().remove(&(key(parent), key(name)));
        }

        /// Serve on an ephemeral port; returns the RPC URL.
        pub async fn serve(&self) -> String {
            let app = Router::new()
                .route("/", post(handle))
                .with_state(self.clone());
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/", listener.local_addr().unwrap());
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            url
        }
    }

    fn key(id: &str) -> String {
        super::canonical_address(id).unwrap_or_else(|| id.to_string())
    }

    async fn handle(State(chain): State<MockChain>, Json(request): Json<Value>) -> Json<Value> {
        let params = &request["params"];
        let result = match request["method"].as_str() {
            Some("myso_getObject") => {
                let id = key(params[0].as_str().unwrap_or_default());
                chain.objects.lock().unwrap().get(&id).cloned().unwrap_or_else(
                    || json!({ "error": { "code": "notExists", "object_id": id } }),
                )
            }
            Some("mysox_getDynamicFieldObject") => {
                let parent = key(params[0].as_str().unwrap_or_default());
                let name = key(params[1]["value"].as_str().unwrap_or_default());
                match chain.fields.lock().unwrap().get(&(parent.clone(), name)) {
                    Some(value) => json!({ "data": { "content": { "fields": { "value": value } } } }),
                    None => json!({ "error": { "code": "dynamicFieldNotFound", "parent_object_id": parent } }),
                }
            }
            _ => return Json(json!({ "jsonrpc": "2.0", "id": 1, "error": { "code": -32601, "message": "Method not found" } })),
        };
        Json(json!({ "jsonrpc": "2.0", "id": 1, "result": result }))
    }
}

#[cfg(test)]
mod tests {
    use super::mock_chain::MockChain;
    use super::*;

    const PACKAGE: &str = "0x50c1";
    const ACCOUNT: &str = "0xacc0";
    const OWNER: &str = "0x0e7e";
    const PROFILE: &str = "0xf00d";
    const ORG: &str = "0xdea6f72a785af43953dc1fea191135cbce5d5e2fd6fb787d9639a26f64f12e43";
    const AGENT: &str = "0xa9e7";
    const ORGS_TABLE: &str = "0x0261";
    const AGENTS_TABLE: &str = "0x0262";
    const PERMISSIONS_TABLE: &str = "0x0263";

    fn package_type(name: &str) -> String {
        format!("{}::memory::{name}", canonical_address(PACKAGE).unwrap())
    }

    fn permission_set(names: &[&str]) -> Value {
        let contents: Vec<Value> = names
            .iter()
            .map(|name| json!({ "type": "0x1::type_name::TypeName", "fields": { "name": name } }))
            .collect();
        json!({ "type": "0x2::vec_set::VecSet<0x1::type_name::TypeName>", "fields": { "contents": contents } })
    }

    fn reader() -> String {
        permission_type_name(PACKAGE, "OrgMemoryReader")
    }

    fn writer() -> String {
        permission_type_name(PACKAGE, "OrgMemoryWriter")
    }

    /// A consistent org: active account + org, registered org, created share group.
    fn org_chain() -> (MockChain, String) {
        let chain = MockChain::default();
        chain.put_object(
            ACCOUNT,
            &package_type("MemoryAccount"),
            json!({
                "owner": OWNER, "active": true, "profile_id": PROFILE,
                "organizations": { "fields": { "id": { "id": ORGS_TABLE }, "size": "1" } },
                "agents": { "fields": { "id": { "id": AGENTS_TABLE }, "size": "1" } },
            }),
        );
        chain.put_object(
            ORG,
            &package_type("AgenticOrganization"),
            json!({
                "active": true, "memory_account_id": ACCOUNT,
                "principal_owner": OWNER, "profile_id": PROFILE,
            }),
        );
        let group = org_memory_group_id(PACKAGE, ORG).unwrap();
        chain.put_object(
            &group,
            &memory_share_group_type(PACKAGE),
            json!({ "permissions": { "fields": { "id": { "id": PERMISSIONS_TABLE }, "length": "1" } } }),
        );
        chain.put_field(ORGS_TABLE, ORG, json!({ "fields": { "active": true } }));
        (chain, group)
    }

    fn member() -> OrgMember<'static> {
        OrgMember {
            organization_id: ORG,
            account_id: ACCOUNT,
            owner: OWNER,
            member: AGENT,
        }
    }

    async fn perms(rpc_url: &str) -> Result<OrgMemoryPerms, ChainUnavailable> {
        resolve_org_memory_perms(&reqwest::Client::new(), rpc_url, PACKAGE, member()).await
    }

    #[test]
    fn group_id_matches_localnet_derivation() {
        assert_eq!(
            org_memory_group_id(PACKAGE, ORG).unwrap(),
            "0x1df5e95f4f37a414b4e257aadcb658d285418689b2f76532ffac0018a36e5b2f"
        );
        assert!(org_memory_group_id(PACKAGE, "not-hex").is_none());
    }

    #[test]
    fn permission_names_use_unprefixed_original_ids() {
        assert_eq!(
            reader(),
            "00000000000000000000000000000000000000000000000000000000000050c1::memory::OrgMemoryReader"
        );
        assert!(!same_address("0x2", "0x3"));
        assert!(same_address("0x2", &format!("0x{:0>64}", "2")));
    }

    #[tokio::test]
    async fn reader_and_writer_grants_are_read_from_the_permissions_table() {
        let (chain, _) = org_chain();
        chain.put_field(PERMISSIONS_TABLE, AGENT, permission_set(&[&reader(), &writer()]));
        let url = chain.serve().await;
        assert_eq!(perms(&url).await.unwrap(), OrgMemoryPerms { reader: true, writer: true });
    }

    #[tokio::test]
    async fn reader_only_member_cannot_write() {
        let (chain, _) = org_chain();
        chain.put_field(PERMISSIONS_TABLE, AGENT, permission_set(&[&reader()]));
        let url = chain.serve().await;
        assert_eq!(perms(&url).await.unwrap(), OrgMemoryPerms { reader: true, writer: false });
    }

    #[tokio::test]
    async fn non_member_has_no_access() {
        let (chain, _) = org_chain();
        let url = chain.serve().await;
        assert_eq!(perms(&url).await.unwrap(), OrgMemoryPerms::default());
    }

    #[tokio::test]
    async fn same_named_permission_from_another_package_is_ignored() {
        let (chain, _) = org_chain();
        let spoofed = permission_type_name("0xbad", "OrgMemoryWriter");
        chain.put_field(PERMISSIONS_TABLE, AGENT, permission_set(&[&spoofed]));
        let url = chain.serve().await;
        assert_eq!(perms(&url).await.unwrap(), OrgMemoryPerms::default());
    }

    #[tokio::test]
    async fn revocations_apply_on_the_next_check() {
        let (chain, _) = org_chain();
        chain.put_field(PERMISSIONS_TABLE, AGENT, permission_set(&[&reader(), &writer()]));
        let url = chain.serve().await;
        assert!(perms(&url).await.unwrap().writer);

        chain.put_field(PERMISSIONS_TABLE, AGENT, permission_set(&[&reader()]));
        assert_eq!(perms(&url).await.unwrap(), OrgMemoryPerms { reader: true, writer: false });

        // Revoking the last permission removes the member's field entirely.
        chain.remove_field(PERMISSIONS_TABLE, AGENT);
        assert_eq!(perms(&url).await.unwrap(), OrgMemoryPerms::default());
    }

    #[tokio::test]
    async fn inactive_org_grants_nothing() {
        let (chain, _) = org_chain();
        chain.put_field(PERMISSIONS_TABLE, AGENT, permission_set(&[&reader(), &writer()]));
        chain.put_object(
            ORG,
            &package_type("AgenticOrganization"),
            json!({ "active": false, "memory_account_id": ACCOUNT, "principal_owner": OWNER, "profile_id": PROFILE }),
        );
        let url = chain.serve().await;
        assert_eq!(perms(&url).await.unwrap(), OrgMemoryPerms::default());
    }

    #[tokio::test]
    async fn org_of_another_account_grants_nothing() {
        let (chain, _) = org_chain();
        chain.put_field(PERMISSIONS_TABLE, AGENT, permission_set(&[&reader(), &writer()]));
        chain.put_object(
            ORG,
            &package_type("AgenticOrganization"),
            json!({ "active": true, "memory_account_id": "0xbeef", "principal_owner": OWNER, "profile_id": PROFILE }),
        );
        let url = chain.serve().await;
        assert_eq!(perms(&url).await.unwrap(), OrgMemoryPerms::default());
    }

    #[tokio::test]
    async fn caller_owner_must_match_the_account_owner() {
        let (chain, _) = org_chain();
        chain.put_field(PERMISSIONS_TABLE, AGENT, permission_set(&[&reader(), &writer()]));
        let url = chain.serve().await;
        let impostor = OrgMember { owner: "0x1337", ..member() };
        let result =
            resolve_org_memory_perms(&reqwest::Client::new(), &url, PACKAGE, impostor).await;
        assert_eq!(result.unwrap(), OrgMemoryPerms::default());
    }

    #[tokio::test]
    async fn org_missing_from_account_registry_grants_nothing() {
        let (chain, _) = org_chain();
        chain.put_field(PERMISSIONS_TABLE, AGENT, permission_set(&[&reader(), &writer()]));
        chain.remove_field(ORGS_TABLE, ORG);
        let url = chain.serve().await;
        assert_eq!(perms(&url).await.unwrap(), OrgMemoryPerms::default());
    }

    #[tokio::test]
    async fn object_at_group_address_with_wrong_type_grants_nothing() {
        let (chain, group) = org_chain();
        chain.put_field(PERMISSIONS_TABLE, AGENT, permission_set(&[&reader(), &writer()]));
        chain.put_object(
            &group,
            "0x2::permissioned_group::PermissionedGroup<0xbad::memory::MemorySharePackage>",
            json!({ "permissions": { "fields": { "id": { "id": PERMISSIONS_TABLE } } } }),
        );
        let url = chain.serve().await;
        assert_eq!(perms(&url).await.unwrap(), OrgMemoryPerms::default());
    }

    #[tokio::test]
    async fn uncreated_group_grants_nothing() {
        let (chain, group) = org_chain();
        chain.put_field(PERMISSIONS_TABLE, AGENT, permission_set(&[&reader(), &writer()]));
        chain.remove_object(&group);
        let url = chain.serve().await;
        assert_eq!(perms(&url).await.unwrap(), OrgMemoryPerms::default());
    }

    #[tokio::test]
    async fn unreachable_fullnode_is_unavailable_not_denied() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        drop(listener);
        assert!(perms(&url).await.is_err());
    }

    #[tokio::test]
    async fn rpc_level_errors_are_unavailable() {
        let app = axum::Router::new().route(
            "/",
            axum::routing::post(|| async {
                axum::Json(json!({ "jsonrpc": "2.0", "id": 1, "error": { "code": -32000, "message": "lagging" } }))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        assert!(perms(&url).await.is_err());
    }

    #[tokio::test]
    async fn malformed_permission_set_is_unavailable() {
        let (chain, _) = org_chain();
        chain.put_field(PERMISSIONS_TABLE, AGENT, json!({ "fields": {} }));
        let url = chain.serve().await;
        assert!(perms(&url).await.is_err());
    }

    #[tokio::test]
    async fn agent_lookup_reads_the_account_registry() {
        let (chain, _) = org_chain();
        chain.put_field(AGENTS_TABLE, "0xd399", json!({ "fields": { "agent_object_id": "0x9d18" } }));
        let url = chain.serve().await;
        let http = reqwest::Client::new();
        let found = agent_object_id_in_account(&http, &url, PACKAGE, ACCOUNT, "0xd399").await;
        assert_eq!(found.unwrap().as_deref(), Some("0x9d18"));
        let missing = agent_object_id_in_account(&http, &url, PACKAGE, ACCOUNT, "0x1").await;
        assert_eq!(missing.unwrap(), None);
    }

    #[tokio::test]
    async fn principal_owner_comes_from_the_org_object() {
        let (chain, _) = org_chain();
        let url = chain.serve().await;
        let http = reqwest::Client::new();
        let owner = org_principal_owner(&http, &url, PACKAGE, ORG).await.unwrap();
        assert_eq!(owner.as_deref(), Some(OWNER));
        assert_eq!(org_principal_owner(&http, &url, PACKAGE, "0x1").await.unwrap(), None);
    }
}
