//! Owner-approved, target-local agent policy changes and canonical account reads.
use crate::chain_reads::{address, coin_type, digest_bytes, id, object, rpc, same, u64_value};
use crate::memory_contract::{
    CAP_AGENT_REGISTER, CAP_AGENT_REVOKE, CAP_AGENT_UPDATE, CAP_BUDGET_MANAGE,
};
use crate::types::{AppError, AppState, AuthInfo, Config};
use futures::{StreamExt, TryStreamExt, stream};
use serde_json::{Map, Value, json};
use std::{collections::HashSet, sync::Arc};

pub const ACTIONS: [&str; 5] = [
    "agent.revoke_agent.v1",
    "agent.grant_capability.v1",
    "agent.revoke_capability.v1",
    "agent.raise_spending_limit.v1",
    "agent.lower_spending_limit.v1",
];
pub const SUPPORTED_GRANT_MASK: u64 = 524279; // memory::supported_agent_capabilities, named bits only.
pub fn is_action(action: &str) -> bool {
    ACTIONS.contains(&action) || action == "account.rotate_owner_key.v1"
}
pub fn configured(config: &Config) -> bool {
    config.owner_agent_actions_enabled && config.social_chain.is_configured()
}
pub fn can_read(caps: u64) -> bool {
    caps & (CAP_AGENT_REGISTER | CAP_AGENT_REVOKE | CAP_AGENT_UPDATE | CAP_BUDGET_MANAGE) != 0
}
fn invalid() -> AppError {
    AppError::Internal("Agent chain data is invalid or unavailable".into())
}
fn bad(message: &str) -> AppError {
    AppError::BadRequest(message.into())
}
fn require(value: Option<&Value>) -> Result<&str, AppError> {
    value
        .and_then(Value::as_str)
        .ok_or_else(|| bad("An exact agent policy value is required"))
}
fn decimal(value: Option<&Value>) -> Result<String, AppError> {
    let value = require(value)?;
    u64_value(Some(&json!(value)))
        .map(|n| n.to_string())
        .map_err(|_| bad("Agent policy values must be decimal u64 strings"))
}
fn scope(value: Option<&Value>) -> Result<String, AppError> {
    let value = require(value)?;
    if value == "global" {
        Ok(value.into())
    } else {
        id(value)
    }
}
fn limit(value: Option<&Value>) -> Result<String, AppError> {
    if value.and_then(Value::as_str) == Some("unlimited") {
        Ok("unlimited".into())
    } else {
        decimal(value)
    }
}
fn native_scope(value: Option<&Value>) -> Result<String, AppError> {
    match value {
        Some(Value::Null) => Ok("global".into()),
        Some(v) => address(Some(v)),
        None => Err(invalid()),
    }
}
fn native_limit(value: Option<&Value>) -> Result<String, AppError> {
    match value {
        Some(Value::Null) => Ok("unlimited".into()),
        Some(v) => Ok(u64_value(Some(v))?.to_string()),
        None => Err(invalid()),
    }
}
fn scope_allows(auth: &AuthInfo, target: &str) -> bool {
    target == "global"
        || auth
            .platform_scope
            .as_deref()
            .is_none_or(|scope| same(scope, target))
}
fn request_scope(state: &AppState, auth: &AuthInfo) -> Result<(), AppError> {
    if !can_read(auth.capabilities) {
        return Err(AppError::Forbidden(
            "An agent management capability is required".into(),
        ));
    }
    if !state.config.social_chain.is_configured() {
        return Err(invalid());
    }
    for platform in [&auth.platform_scope, &auth.platform_id]
        .into_iter()
        .flatten()
    {
        if !same(platform, &state.config.social_chain.platform_object_id) {
            return Err(AppError::Forbidden(
                "Agent administration is outside this deployment platform".into(),
            ));
        }
    }
    Ok(())
}
fn fields<'a>(
    data: &'a Value,
    package: &str,
    name: &str,
) -> Result<&'a Map<String, Value>, AppError> {
    if coin_type(
        data.pointer("/content/type")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?,
    )? != coin_type(&format!("{package}::memory::{name}"))?
    {
        return Err(invalid());
    }
    data.pointer("/content/fields")
        .and_then(Value::as_object)
        .ok_or_else(invalid)
}
async fn account(state: &AppState, auth: &AuthInfo) -> Result<Value, AppError> {
    let data = object(state, &auth.account_id).await?;
    let f = fields(&data, &state.config.package_id, "MemoryAccount")?;
    if !same(&address(f.get("owner"))?, &auth.owner) {
        return Err(AppError::Forbidden(
            "Account owner changed; refresh the authenticated context".into(),
        ));
    }
    Ok(data)
}

#[derive(Clone)]
struct PendingOwnerRotation {
    old_owner: String,
    new_owner: String,
    profile_id: String,
    agent_manifest: Vec<String>,
    organization_manifest: Vec<String>,
    updated_agents: Vec<String>,
    updated_organizations: Vec<String>,
}

async fn rotation_table_ids(state: &AppState, rotation: &Value, name: &str) -> Result<Vec<String>, AppError> {
    let table_fields = rotation.get(name).and_then(Value::as_object).and_then(|table| table.get("fields")).and_then(Value::as_object).ok_or_else(invalid)?;
    let table_id = address(table_fields.get("id").and_then(|value| value.get("id")))?;
    let count = u64_value(table_fields.get("size"))?;
    read_id_table(state, &table_id, count).await
}

async fn read_id_table(state: &AppState, table_id: &str, expected_count: u64) -> Result<Vec<String>, AppError> {
    if expected_count > 512 { return Err(bad("Owner migration tables exceed the supported 512-reference limit")); }
    let mut cursor: Option<String> = None;
    let mut field_ids = HashSet::new();
    let mut values = HashSet::new();
    let mut result = Vec::with_capacity(expected_count as usize);
    for _ in 0..12 {
        let page = rpc(state, "mysox_getDynamicFields", json!([table_id, cursor, 50])).await?;
        let rows = page.get("data").and_then(Value::as_array).ok_or_else(invalid)?;
        if rows.len() > 50 || rows.len() as u64 > expected_count.saturating_sub(result.len() as u64) { return Err(invalid()); }
        let mut last = None;
        for row in rows {
            let field_id = address(row.get("objectId"))?;
            if !field_ids.insert(field_id.clone()) { return Err(invalid()); }
            last = Some(field_id);
            if coin_type(row.pointer("/name/type").and_then(Value::as_str).ok_or_else(invalid)?)? != coin_type("0x2::object::ID")? { return Err(invalid()); }
            let value = address(row.pointer("/name/value"))?;
            if !values.insert(value.clone()) { return Err(invalid()); }
            result.push(value);
        }
        let has_next = page.get("hasNextPage").and_then(Value::as_bool).ok_or_else(invalid)?;
        let next = page.get("nextCursor").filter(|value| !value.is_null()).map(|value| address(Some(value))).transpose()?;
        if !has_next {
            if result.len() as u64 != expected_count { return Err(invalid()); }
            return Ok(result);
        }
        if rows.is_empty() || next.is_none() || next == cursor || next != last { return Err(invalid()); }
        cursor = next;
    }
    Err(invalid())
}

async fn pending_owner_rotation(state: &AppState, auth: &AuthInfo) -> Result<Option<PendingOwnerRotation>, AppError> {
    let key_type = format!("{}::memory::MemoryOwnerRotationKey", state.config.package_id);
    let value_type = format!("{}::memory::MemoryOwnerRotation", state.config.package_id);
    let result = rpc(state, "mysox_getDynamicFieldObject", json!([auth.account_id, {"type": key_type, "value": {}}])).await?;
    if result.pointer("/error/code").and_then(Value::as_str).is_some_and(|code| matches!(code, "dynamicFieldNotFound" | "notExists" | "deleted")) { return Ok(None); }
    let data = result.get("data").ok_or_else(invalid)?;
    let expected = coin_type(&format!("0x2::dynamic_field::Field<{key_type},{value_type}>"))?;
    if coin_type(data.pointer("/content/type").and_then(Value::as_str).ok_or_else(invalid)?)? != expected
        || !same(&address(data.pointer("/owner/ObjectOwner"))?, &auth.account_id) { return Err(invalid()); }
    let account_data = account(state, auth).await?;
    let account_fields = fields(&account_data, &state.config.package_id, "MemoryAccount")?;
    let profile_id = address(account_fields.get("profile_id"))?;
    let rotation = data.pointer("/content/fields/value/fields").ok_or_else(invalid)?;
    let rotation_fields = rotation.as_object().ok_or_else(invalid)?;
    let old_owner = address(rotation_fields.get("old_owner"))?;
    let new_owner = address(rotation_fields.get("new_owner"))?;
    if !same(&old_owner, &auth.owner) || same(&old_owner, &new_owner) { return Err(AppError::Conflict("Pending owner migration no longer matches the authenticated old owner".into())); }
    let agent_manifest = rotation_table_ids(state, rotation, "agent_manifest").await?;
    let organization_manifest = rotation_table_ids(state, rotation, "organization_manifest").await?;
    let updated_agents = rotation_table_ids(state, rotation, "updated_agents").await?;
    let updated_organizations = rotation_table_ids(state, rotation, "updated_organizations").await?;
    if updated_agents.iter().any(|id| !agent_manifest.iter().any(|expected| same(id, expected)))
        || updated_organizations.iter().any(|id| !organization_manifest.iter().any(|expected| same(id, expected))) { return Err(invalid()); }
    Ok(Some(PendingOwnerRotation { old_owner, new_owner, profile_id, agent_manifest, organization_manifest, updated_agents, updated_organizations }))
}

fn requested_ids(value: Option<&Value>, maximum: usize, label: &str) -> Result<Vec<String>, AppError> {
    let items = value.and_then(Value::as_array).ok_or_else(|| bad("Owner migration reference arrays are required"))?;
    if items.len() > maximum { return Err(bad("Owner migration reference batch exceeds six objects")); }
    let mut seen = HashSet::new();
    let mut result = Vec::with_capacity(items.len());
    for value in items {
        let item = address(Some(value)).map_err(|_| bad("Owner migration reference contains an invalid object ID"))?;
        if !seen.insert(item.clone()) { return Err(bad("Owner migration reference batch contains duplicates")); }
        result.push(item);
    }
    let _ = label;
    Ok(result)
}

pub async fn validate_owner_rotation_action(state: &AppState, auth: &AuthInfo, p: &Value) -> Result<(), AppError> {
    request_scope(state, auth)?;
    if !configured(&state.config) { return Err(AppError::Forbidden("Owner migration actions are not enabled".into())); }
    let stage = p.get("stage").and_then(Value::as_str).unwrap_or("propose");
    let (agent_ids, organization_ids) = if stage == "cancel" {
        (Vec::new(), Vec::new())
    } else {
        (requested_ids(p.get("agentObjectIds"), if stage == "propose" { 512 } else { 6 }, "agents")?, requested_ids(p.get("organizationObjectIds"), if stage == "propose" { 512 } else { 6 }, "organizations")?)
    };
    let mut all = HashSet::new();
    if agent_ids.iter().chain(&organization_ids).any(|id| !all.insert(id.clone())) { return Err(bad("Owner migration contains duplicate references")); }
    let pending = pending_owner_rotation(state, auth).await?;
    match stage {
        "propose" => {
            if pending.is_some() { return Err(AppError::Conflict("An owner migration is already pending".into())); }
            let current_account = account(state, auth).await?;
            let account_fields = fields(&current_account, &state.config.package_id, "MemoryAccount")?;
            let expected_profile = address(account_fields.get("profile_id"))?;
            let supplied_profile = address(p.get("profileId"))?;
            let new_owner = address(p.get("newOwner"))?;
            if !same(&expected_profile, &supplied_profile) || same(&new_owner, &auth.owner) { return Err(AppError::Conflict("Owner migration proposal does not match the live profile or recipient".into())); }
            let agent_table = account_fields.get("agent_ids").and_then(|v| v.get("fields")).and_then(Value::as_object).ok_or_else(invalid)?;
            let org_table = account_fields.get("organizations").and_then(|v| v.get("fields")).and_then(Value::as_object).ok_or_else(invalid)?;
            let registered_agents = read_id_table(state, &address(agent_table.get("id").and_then(|v| v.get("id")))?, u64_value(agent_table.get("size"))?).await?;
            let registered_organizations = read_id_table(state, &address(org_table.get("id").and_then(|v| v.get("id")))?, u64_value(org_table.get("size"))?).await?;
            if agent_ids.len() != registered_agents.len() || organization_ids.len() != registered_organizations.len()
                || agent_ids.iter().any(|id| !registered_agents.iter().any(|registered| same(id, registered)))
                || organization_ids.iter().any(|id| !registered_organizations.iter().any(|registered| same(id, registered))) { return Err(AppError::Conflict("Owner migration proposal must include the exact live registered-reference manifest".into())); }
        }
        "accept" => {
            let pending = pending.ok_or_else(|| AppError::Conflict("No owner migration is pending".into()))?;
            if !same(&address(p.get("profileId"))?, &pending.profile_id) || !same(&address(p.get("newOwner"))?, &pending.new_owner) || agent_ids.len() + organization_ids.len() > 6 { return Err(AppError::Conflict("Owner migration acceptance does not match the pending account, recipient, or six-reference limit".into())); }
            if agent_ids.iter().any(|id| !pending.agent_manifest.iter().any(|v| same(id, v)) || pending.updated_agents.iter().any(|v| same(id, v)))
                || organization_ids.iter().any(|id| !pending.organization_manifest.iter().any(|v| same(id, v)) || pending.updated_organizations.iter().any(|v| same(id, v))) { return Err(AppError::Conflict("Acceptance batch contains a reference outside the pending unupdated manifest".into())); }
            let finalizes = p.get("finalize").and_then(Value::as_bool).ok_or_else(|| bad("finalize must be a boolean"))?;
            if agent_ids.is_empty() && organization_ids.is_empty() && !finalizes { return Err(bad("An empty acceptance batch is only valid for finalization")); }
            if finalizes {
                let all_agents_updated = pending.agent_manifest.iter().all(|id| pending.updated_agents.iter().chain(&agent_ids).any(|updated| same(id, updated)));
                let all_orgs_updated = pending.organization_manifest.iter().all(|id| pending.updated_organizations.iter().chain(&organization_ids).any(|updated| same(id, updated)));
                if !all_agents_updated || !all_orgs_updated { return Err(AppError::Conflict("Final acceptance must include the final outstanding references".into())); }
            }
        }
        "rollback" => {
            let pending = pending.ok_or_else(|| AppError::Conflict("No owner migration is pending".into()))?;
            if !same(&address(p.get("newOwner"))?, &pending.new_owner) { return Err(AppError::Conflict("Rollback recipient does not match the pending owner migration".into())); }
            if agent_ids.is_empty() && organization_ids.is_empty() { return Err(bad("Rollback requires at least one reference")); }
            if agent_ids.iter().any(|id| !pending.updated_agents.iter().any(|v| same(id, v))) || organization_ids.iter().any(|id| !pending.updated_organizations.iter().any(|v| same(id, v))) { return Err(AppError::Conflict("Rollback batch contains a reference not yet updated in this migration".into())); }
        }
        "cancel" => {
            let pending = pending.ok_or_else(|| AppError::Conflict("No owner migration is pending".into()))?;
            if !pending.updated_agents.is_empty() || !pending.updated_organizations.is_empty() { return Err(AppError::Conflict("Every updated reference must be rolled back before cancellation".into())); }
            if !agent_ids.is_empty() || !organization_ids.is_empty() { return Err(bad("Cancellation does not accept reference IDs")); }
        }
        _ => return Err(bad("stage must be propose, accept, rollback, or cancel")),
    }
    Ok(())
}

pub async fn validate_owner_rotation_signer(state: &AppState, auth: &AuthInfo, p: &Value, signer: &str) -> Result<(), AppError> {
    let stage = p.get("stage").and_then(Value::as_str).unwrap_or("propose");
    if stage == "propose" {
        if !same(signer, &auth.owner) { return Err(AppError::Forbidden("Only the current owner can propose an owner migration".into())); }
        return Ok(());
    }
    let pending = pending_owner_rotation(state, auth).await?.ok_or_else(|| AppError::Conflict("No owner migration is pending for this wallet approval".into()))?;
    let allowed = match stage {
        "accept" => same(signer, &pending.new_owner),
        "rollback" => same(signer, &pending.old_owner) || same(signer, &pending.new_owner),
        "cancel" => same(signer, &pending.old_owner),
        _ => false,
    };
    if !allowed { return Err(AppError::Forbidden("Wallet signer is not an authorized party to this pending owner migration".into())); }
    Ok(())
}

pub async fn validate_pending_owner_rotation_signer(state: &AppState, auth: &AuthInfo, signer: &str) -> Result<(), AppError> {
    if same(signer, &auth.owner) { return Ok(()); }
    let pending = pending_owner_rotation(state, auth).await?.ok_or_else(|| AppError::Conflict("The owner migration is no longer pending".into()))?;
    if !same(signer, &pending.new_owner) { return Err(AppError::Forbidden("Approval signer is not a party to the pending owner migration".into())); }
    Ok(())
}
fn agent_metadata(
    data: &Value,
    account: &Value,
    package: &str,
    auth: &AuthInfo,
) -> Result<Value, AppError> {
    let f = fields(data, package, "SubAgent")?;
    let a = fields(account, package, "MemoryAccount")?;
    if !same(&address(f.get("memory_account_id"))?, &auth.account_id)
        || !same(&address(f.get("principal_owner"))?, &auth.owner)
        || address(f.get("profile_id"))? != address(a.get("profile_id"))?
    {
        return Err(AppError::BlobNotFound(
            "Agent is outside this account".into(),
        ));
    }
    let platform = native_scope(f.get("platform_scope"))?;
    if !scope_allows(auth, &platform) {
        return Err(AppError::BlobNotFound(
            "Agent is outside this platform scope".into(),
        ));
    }
    let constraints = f
        .get("constraints")
        .and_then(|v| v.get("fields"))
        .and_then(Value::as_object)
        .ok_or_else(invalid)?;
    let label = f.get("label").and_then(Value::as_str).ok_or_else(invalid)?;
    let parent = match f.get("parent_object_id") {
        Some(Value::Null) => None,
        Some(v) => Some(address(Some(v))?),
        None => return Err(invalid()),
    };
    let expires = match f.get("expires_at") {
        Some(Value::Null) => None,
        Some(v) => Some(u64_value(Some(v))?.to_string()),
        None => return Err(invalid()),
    };
    let mut out = json!({"agentObjectId":address(data.get("objectId"))?,"expectedDerivedAddress":address(f.get("derived_address"))?,
        "expectedPlatformScope":platform,"expectedCapabilities":u64_value(f.get("capabilities"))?.to_string(),
        "expectedLimitMist":native_limit(constraints.get("max_action_spend"))?,"delegatableCaps":u64_value(f.get("delegatable_caps"))?.to_string(),
        "approvalRequiredCaps":u64_value(constraints.get("approval_required_caps"))?.to_string(),
        "organizationId":address(f.get("organization_id"))?,"active":f.get("active").and_then(Value::as_bool).ok_or_else(invalid)?,
        "parentObjectId":parent,"expiresAtMs":expires,"createdAtMs":u64_value(f.get("created_at"))?.to_string(),
        "identityClass":u64_value(f.get("identity_class"))?.to_string(),"roleTags":u64_value(f.get("role_tags"))?.to_string(),
        "registerScope":u64_value(f.get("register_scope"))?.to_string(),"depth":u64_value(f.get("depth"))?.to_string(),
        "objectVersion":u64_value(data.get("version"))?.to_string(),
        "labelPreview":{"text":label.chars().take(256).collect::<String>(),"truncated":label.chars().count()>256,"source":"on_chain_label_untrusted"}});
    out["effectiveAuthority"] = json!("not_computed");
    Ok(out)
}
async fn target(
    state: &AppState,
    auth: &AuthInfo,
    target_id: &str,
    account: &Value,
) -> Result<Value, AppError> {
    let data = object(state, target_id).await?;
    agent_metadata(&data, account, &state.config.package_id, auth)
}

/// Computes the policy that Move will see for this agent from one bounded sequence of live
/// fullnode reads. Move remains authoritative at execution time; this is a current snapshot only.
async fn effective_authority(
    state: &AppState,
    auth: &AuthInfo,
    account: &Value,
    target_data: &Value,
) -> Result<Value, AppError> {
    let clock = object(state, "0x6").await?;
    let clock_type = coin_type(
        clock
            .pointer("/content/type")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?,
    )?;
    if clock_type != coin_type("0x2::clock::Clock")? {
        return Err(invalid());
    }
    let now_ms = u64_value(clock.pointer("/content/fields/timestamp_ms"))?;

    let config = object(state, &state.config.social_chain.memory_config_id).await?;
    let config_fields = fields(&config, &state.config.package_id, "MemoryConfig")?;
    let max_depth = u64_value(config_fields.get("max_agent_depth"))?;
    let account_fields = fields(account, &state.config.package_id, "MemoryAccount")?;
    let account_active = account_fields
        .get("active")
        .and_then(Value::as_bool)
        .ok_or_else(invalid)?;

    let mut chain = Vec::new();
    let mut seen = HashSet::new();
    let mut current_id = address(target_data.get("objectId"))?;
    let mut target_capabilities = None;
    let mut target_limit = None;
    let mut chain_active = account_active;
    let mut depth = 0u64;
    loop {
        if !seen.insert(current_id.clone()) {
            return Err(invalid());
        }
        let data = if depth == 0 {
            target_data.clone()
        } else {
            object(state, &current_id).await?
        };
        let metadata = agent_metadata(&data, account, &state.config.package_id, auth)?;
        let active = metadata
            .get("active")
            .and_then(Value::as_bool)
            .ok_or_else(invalid)?;
        let expires_at = metadata.get("expiresAtMs").cloned().ok_or_else(invalid)?;
        let expired = match &expires_at {
            Value::Null => false,
            Value::String(value) => u64_value(Some(&Value::String(value.clone())))? < now_ms,
            _ => return Err(invalid()),
        };
        chain_active &= active && !expired;
        if depth == 0 {
            target_capabilities = Some(u64_value(metadata.get("expectedCapabilities"))?);
            target_limit = metadata
                .get("expectedLimitMist")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        let parent_id = match metadata.get("parentObjectId") {
            Some(Value::Null) => None,
            Some(Value::String(parent)) => Some(parent.clone()),
            _ => return Err(invalid()),
        };
        chain.push(json!({
            "agentObjectId":current_id,
            "parentObjectId":parent_id,
            "active":active,
            "expired":expired,
            "expiresAtMs":expires_at,
            "depth":metadata.get("depth")
        }));
        match parent_id {
            None => break,
            Some(parent) => {
                if depth >= max_depth {
                    return Err(invalid());
                }
                current_id = parent;
                depth += 1;
            }
        }
    }

    let capabilities = target_capabilities.ok_or_else(invalid)?;
    let spend_limit = target_limit.ok_or_else(invalid)?;
    Ok(json!({
        "computed":true,
        "activeNow":chain_active,
        "accountActive":account_active,
        "currentTimeMs":now_ms.to_string(),
        "effectiveExecutionCapabilitiesMask":if chain_active { capabilities.to_string() } else { "0".to_owned() },
        "effectivePerActionSpendLimitMist":if chain_active { spend_limit } else { "0".to_owned() },
        "limitSemantics":"per_action_not_cumulative",
        "activeChain":chain,
        "evidenceSource":"configured_fullnode_live_object_snapshot",
        "executionRechecksAuthority":true
    }))
}

fn parameters(action: &str, p: &Value) -> Result<Value, AppError> {
    let f = p
        .as_object()
        .ok_or_else(|| bad("Agent parameters must be an object"))?;
    let names: &[&str] = match action {
        "agent.revoke_agent.v1" => &[
            "agentObjectId",
            "expectedDerivedAddress",
            "expectedPlatformScope",
        ],
        "agent.grant_capability.v1" | "agent.revoke_capability.v1" => &[
            "agentObjectId",
            "expectedDerivedAddress",
            "expectedPlatformScope",
            "expectedCapabilities",
            "capabilityMask",
        ],
        "agent.raise_spending_limit.v1" => &[
            "agentObjectId",
            "expectedDerivedAddress",
            "expectedPlatformScope",
            "expectedLimitMist",
            "newLimitMist",
        ],
        "agent.lower_spending_limit.v1" => &[
            "agentObjectId",
            "expectedDerivedAddress",
            "expectedPlatformScope",
            "expectedLimitMist",
            "newLimitMist",
        ],
        _ => return Err(bad("Unknown owner agent action")),
    };
    if f.len() != names.len() || f.keys().any(|key| !names.contains(&key.as_str())) {
        return Err(bad("Unexpected or missing owner agent parameter"));
    }
    let mut out = json!({"agentObjectId":address(p.get("agentObjectId"))?,"expectedDerivedAddress":address(p.get("expectedDerivedAddress"))?,"expectedPlatformScope":scope(p.get("expectedPlatformScope"))?});
    if matches!(
        action,
        "agent.grant_capability.v1" | "agent.revoke_capability.v1"
    ) {
        let old = decimal(p.get("expectedCapabilities"))?;
        let mask = decimal(p.get("capabilityMask"))?;
        let old_value = old.parse::<u64>().unwrap();
        let mask_value = mask.parse::<u64>().unwrap();
        if mask_value == 0
            || (action == "agent.grant_capability.v1"
                && (mask_value & SUPPORTED_GRANT_MASK != mask_value
                    || old_value | mask_value == old_value))
            || (action == "agent.revoke_capability.v1" && old_value & mask_value == 0)
        {
            return Err(bad("Execution capability mask has no supported change"));
        }
        out["expectedCapabilities"] = json!(old);
        out["capabilityMask"] = json!(mask);
    } else if action == "agent.raise_spending_limit.v1" {
        let old = decimal(p.get("expectedLimitMist"))?;
        let next = limit(p.get("newLimitMist"))?;
        if next != "unlimited" && next.parse::<u64>().unwrap() <= old.parse::<u64>().unwrap() {
            return Err(bad("The finite per-action ceiling must increase"));
        }
        out["expectedLimitMist"] = json!(old);
        out["newLimitMist"] = json!(next);
    } else if action == "agent.lower_spending_limit.v1" {
        let old = limit(p.get("expectedLimitMist"))?;
        let next = decimal(p.get("newLimitMist"))?;
        if old != "unlimited" && next.parse::<u64>().unwrap() >= old.parse::<u64>().unwrap() {
            return Err(bad("The finite per-action ceiling must decrease"));
        }
        out["expectedLimitMist"] = json!(old);
        out["newLimitMist"] = json!(next);
    }
    Ok(out)
}
fn snapshot_matches(action: &str, p: &Value, agent: &Value) -> bool {
    [
        "agentObjectId",
        "expectedDerivedAddress",
        "expectedPlatformScope",
    ]
    .iter()
    .all(|key| p[*key] == agent[*key])
        && (!matches!(
            action,
            "agent.grant_capability.v1" | "agent.revoke_capability.v1"
        ) || p["expectedCapabilities"] == agent["expectedCapabilities"])
        && (!matches!(action,"agent.raise_spending_limit.v1"|"agent.lower_spending_limit.v1")
            || p["expectedLimitMist"] == agent["expectedLimitMist"])
}
pub async fn validate_action(
    state: &AppState,
    auth: &AuthInfo,
    action: &str,
    p: &Value,
) -> Result<(), AppError> {
    if action == "account.rotate_owner_key.v1" {
        return validate_owner_rotation_action(state, auth, p).await;
    }
    if !is_action(action) {
        return Ok(());
    }
    request_scope(state, auth)?;
    if !configured(&state.config) {
        return Err(AppError::Forbidden(
            "Owner agent actions are not enabled".into(),
        ));
    }
    let p = parameters(action, p)?;
    tokio::time::timeout(std::time::Duration::from_secs(25), async {
        let account = account(state, auth).await?;
        let agent = target(state, auth, require(p.get("agentObjectId"))?, &account).await?;
        if !snapshot_matches(action, &p, &agent) {
            return Err(AppError::Conflict(
                "Agent policy changed; obtain a new owned-agent quote".into(),
            ));
        }
        Ok(())
    })
    .await
    .map_err(|_| AppError::Internal("Agent validation exceeded its read budget".into()))?
}
pub fn receipt_context(
    action: &str,
    p: &Value,
    account: &str,
    owner: &str,
    signer: &str,
    platform: &str,
) -> Result<Option<Value>, AppError> {
    if action == "account.rotate_owner_key.v1" {
        let mut context = p.clone();
        if !context.is_object() { return Err(bad("Owner migration parameters must be an object")); }
        if context.get("stage").is_none() { context["stage"] = json!("propose"); }
        context["accountId"] = json!(id(account)?);
        context["approvingOwner"] = json!(id(owner)?);
        context["expectedSigner"] = json!(id(signer)?);
        context["executionPlatformId"] = json!(id(platform)?);
        return Ok(Some(context));
    }
    let mut context = parameters(action, p)?;
    context["accountId"] = json!(id(account)?);
    context["approvingOwner"] = json!(id(owner)?);
    context["expectedSigner"] = json!(id(signer)?);
    context["executionPlatformId"] = json!(id(platform)?);
    Ok(Some(context))
}
fn event_receipt(
    event: &Value,
    action: &str,
    package: &str,
    context: &Value,
    sender: &str,
    transaction: &Value,
) -> Result<Option<Value>, AppError> {
    let name = if action == "agent.revoke_agent.v1" {
        "SubAgentRevoked"
    } else {
        "SubAgentOwnerPolicyChanged"
    };
    if coin_type(event["type"].as_str().ok_or_else(invalid)?)?
        != coin_type(&format!("{package}::memory::{name}"))?
    {
        return Ok(None);
    }
    let p = &event["parsedJson"];
    if !same(event["sender"].as_str().ok_or_else(invalid)?, sender)
        || !same(p["principal_owner"].as_str().ok_or_else(invalid)?, sender)
        || !same(
            p["account_id"].as_str().ok_or_else(invalid)?,
            require(context.get("accountId"))?,
        )
        || !same(
            p["agent_object_id"].as_str().ok_or_else(invalid)?,
            require(context.get("agentObjectId"))?,
        )
        || !same(
            p["derived_address"].as_str().ok_or_else(invalid)?,
            require(context.get("expectedDerivedAddress"))?,
        )
    {
        return Err(invalid());
    }
    if action == "agent.revoke_agent.v1" {
        let deleted = transaction["objectChanges"]
            .as_array()
            .ok_or_else(invalid)?
            .iter()
            .any(|change| {
                change["type"] == "deleted"
                    && change["objectId"].as_str().is_some_and(|value| {
                        same(value, context["agentObjectId"].as_str().unwrap())
                    })
            });
        if !deleted {
            return Err(AppError::Conflict(
                "Agent revocation deletion was not verified".into(),
            ));
        }
        return Ok(Some(
            json!({"agentObjectId":context["agentObjectId"],"derivedAddress":context["expectedDerivedAddress"],"proof":"native_revocation_event_and_object_deletion_with_scoped_preparation","futureCredentialAccess":"revoked"}),
        ));
    }
    if native_scope(p.get("platform_scope"))? != require(context.get("expectedPlatformScope"))? {
        return Err(invalid());
    }
    let kind = u64_value(p.get("change_kind"))?;
    let before = u64_value(p.get("previous_capabilities"))?;
    let after = u64_value(p.get("next_capabilities"))?;
    let mask = u64_value(p.get("capability_mask"))?;
    let old_limit = native_limit(p.get("previous_max_action_spend"))?;
    let new_limit = native_limit(p.get("next_max_action_spend"))?;
    let expected_kind = match action {
        "agent.grant_capability.v1" => 1,
        "agent.revoke_capability.v1" => 2,
        "agent.raise_spending_limit.v1" => 3,
        "agent.lower_spending_limit.v1" => 4,
        _ => return Err(invalid()),
    };
    if kind != expected_kind {
        return Err(invalid());
    }
    if kind == 3 || kind == 4 {
        let valid_limit_change = if kind == 3 {
            new_limit == "unlimited"
                || (old_limit != "unlimited"
                    && old_limit.parse::<u64>().map_err(|_| invalid())?
                        < new_limit.parse::<u64>().map_err(|_| invalid())?)
        } else {
            new_limit != "unlimited"
                && (old_limit == "unlimited"
                    || new_limit.parse::<u64>().map_err(|_| invalid())?
                        < old_limit.parse::<u64>().map_err(|_| invalid())?)
        };
        if mask != 0
            || before != after
            || old_limit != require(context.get("expectedLimitMist"))?
            || new_limit != require(context.get("newLimitMist"))?
            || !valid_limit_change
        {
            return Err(invalid());
        }
    } else {
        if before != u64_value(context.get("expectedCapabilities"))?
            || mask != u64_value(context.get("capabilityMask"))?
            || old_limit != new_limit
            || after
                != if kind == 1 {
                    before | mask
                } else {
                    before ^ (before & mask)
                }
        {
            return Err(invalid());
        }
    }
    Ok(Some(
        json!({"agentObjectId":context["agentObjectId"],"derivedAddress":context["expectedDerivedAddress"],"changeKind":kind,
        "previousCapabilities":before.to_string(),"nextCapabilities":after.to_string(),"capabilityMask":mask.to_string(),
        "delegatableCaps":u64_value(p.get("delegatable_caps"))?.to_string(),"previousLimitMist":old_limit,"nextLimitMist":new_limit,
        "platformScope":context["expectedPlatformScope"],"timestampMs":u64_value(p.get("timestamp_ms"))?.to_string(),"proof":"native_owner_policy_delta"}),
    ))
}
async fn receipt(state: &AppState, auth: &AuthInfo, digest: &str) -> Result<Value, AppError> {
    digest_bytes(digest).map_err(|_| bad("Invalid agent receipt digest"))?;
    let row = crate::chain_actions::get_by_digest(
        &state.db,
        &auth.account_id,
        &auth.agent_object_id,
        digest,
    )
    .await?
    .filter(|row| {
        is_action(&row.registry_action) && same(&row.package_id, &state.config.package_id)
    })
    .ok_or_else(|| {
        AppError::BlobNotFound("Agent policy receipt is outside this recording-agent scope".into())
    })?;
    let context = row
        .receipt_context
        .as_ref()
        .ok_or_else(|| AppError::Conflict("Prepared agent policy context is unavailable".into()))?;
    if !same(require(context.get("accountId"))?, &auth.account_id)
        || !same(
            require(context.get("executionPlatformId"))?,
            &state.config.social_chain.platform_object_id,
        )
        || !scope_allows(auth, require(context.get("expectedPlatformScope"))?)
    {
        return Err(AppError::BlobNotFound(
            "Agent receipt is outside this scope".into(),
        ));
    }
    let transaction = rpc(
        state,
        "myso_getTransactionBlock",
        json!([digest,{"showEffects":true,"showEvents":true,"showObjectChanges":true}]),
    )
    .await?;
    if transaction["digest"].as_str() != Some(digest) {
        return Err(invalid());
    }
    let checkpoint = transaction
        .get("checkpoint")
        .filter(|value| !value.is_null())
        .map(|v| u64_value(Some(v)))
        .transpose()?;
    let status = match transaction
        .pointer("/effects/status/status")
        .and_then(Value::as_str)
    {
        Some("success") if checkpoint.is_some() => "finalized",
        Some("success") => "executed",
        Some("failure") => "failed",
        _ => "unknown",
    };
    let mut evidence = Vec::new();
    if matches!(status, "finalized" | "executed") {
        for event in transaction["events"].as_array().ok_or_else(invalid)? {
            if let Some(event) = event_receipt(
                event,
                &row.registry_action,
                &state.config.package_id,
                context,
                &row.sender,
                &transaction,
            )? {
                evidence.push(event);
            }
        }
        if evidence.len() != 1 {
            return Err(AppError::Conflict(
                "Expected native agent policy evidence could not be verified".into(),
            ));
        }
    }
    Ok(
        json!({"digest":digest,"registryAction":row.registry_action,"accountId":auth.account_id,"agentId":auth.agent_object_id,
        "status":status,"checkpoint":checkpoint.map(|v|v.to_string()),"evidence":evidence,"preparedContext":context,
        "evidenceSource":"configured_fullnode_and_scoped_preparation","currentEffectiveAuthority":"not_computed"}),
    )
}

async fn rotation_receipt(state: &AppState, auth: &AuthInfo, digest: &str) -> Result<Value, AppError> {
    digest_bytes(digest).map_err(|_| bad("Invalid owner migration receipt digest"))?;
    let row = crate::chain_actions::get_by_digest(&state.db, &auth.account_id, &auth.agent_object_id, digest).await?
        .filter(|row| row.registry_action == "account.rotate_owner_key.v1" && same(&row.package_id, &state.config.package_id))
        .ok_or_else(|| AppError::BlobNotFound("Owner migration receipt is outside this account/agent scope".into()))?;
    let context = row.receipt_context.as_ref().ok_or_else(|| AppError::Conflict("Prepared owner migration context is unavailable".into()))?;
    let account_id = require(context.get("accountId"))?;
    let old_owner = require(context.get("approvingOwner"))?;
    let signer = require(context.get("expectedSigner"))?;
    let platform = require(context.get("executionPlatformId"))?;
    let stage = require(context.get("stage"))?;
    if !same(account_id, &auth.account_id) || !same(platform, &state.config.social_chain.platform_object_id)
        || !same(signer, &row.sender) {
        return Err(AppError::BlobNotFound("Owner migration receipt is outside its prepared signer and deployment scope".into()));
    }
    let transaction = rpc(state, "myso_getTransactionBlock", json!([digest,{"showEffects":true,"showEvents":true}])).await?;
    if transaction.get("digest").and_then(Value::as_str) != Some(digest) { return Err(invalid()); }
    let tx_status = transaction.pointer("/effects/status/status").and_then(Value::as_str).ok_or_else(invalid)?;
    let checkpoint = transaction.get("checkpoint").filter(|v| !v.is_null()).map(|v| u64_value(Some(v))).transpose()?;
    let status = if tx_status == "success" { if checkpoint.is_some() {"finalized"} else {"executed"} } else if tx_status == "failure" {"failed"} else {"unknown"};
    if tx_status != "success" { return Ok(json!({"digest":digest,"accountId":auth.account_id,"stage":stage,"status":status,"evidence":[],"preparedContext":context})); }
    let events = transaction.get("events").and_then(Value::as_array).ok_or_else(invalid)?;
    let package = &state.config.package_id;
    let proposal_type = coin_type(&format!("{package}::memory::MemoryAccountOwnerRotationProposed"))?;
    let reference_type = coin_type(&format!("{package}::memory::MemoryAccountOwnerRotationReferenceUpdated"))?;
    let rotated_type = coin_type(&format!("{package}::memory::MemoryAccountOwnerRotated"))?;
    let profile_type = coin_type(&format!("{package}::profile::ProfileOwnerRotatedEvent"))?;
    let mut proposals = Vec::new(); let mut references = Vec::new(); let mut rotations = Vec::new(); let mut profiles = Vec::new();
    for event in events {
        let event_type = coin_type(event.get("type").and_then(Value::as_str).ok_or_else(invalid)?)?;
        if event_type == proposal_type { proposals.push(event); }
        else if event_type == reference_type { references.push(event); }
        else if event_type == rotated_type { rotations.push(event); }
        else if event_type == profile_type { profiles.push(event); }
    }
    let new_owner = address(context.get("newOwner"))?;
    let context_profile = context.get("profileId").map(|v| address(Some(v))).transpose()?;
    match stage {
        "propose" => {
            if proposals.len()!=1 || !references.is_empty() || !rotations.is_empty() || !profiles.is_empty() { return Err(AppError::Conflict("Owner migration proposal events do not match the prepared action".into())); }
            let p = proposals[0].get("parsedJson").and_then(Value::as_object).ok_or_else(invalid)?;
            if !same(&address(p.get("account_id"))?, account_id) || !same(&address(p.get("old_owner"))?, old_owner) || !same(&address(p.get("new_owner"))?, &new_owner) || !same(&address(proposals[0].get("sender"))?, signer)
                || u64_value(p.get("agent_count"))? != context["agentObjectIds"].as_array().ok_or_else(invalid)?.len() as u64
                || u64_value(p.get("organization_count"))? != context["organizationObjectIds"].as_array().ok_or_else(invalid)?.len() as u64 { return Err(invalid()); }
            Ok(json!({"digest":digest,"accountId":account_id,"stage":stage,"status":status,"oldOwner":old_owner,"newOwner":new_owner,"evidence":proposals,"preparedContext":context,"checkpoint":checkpoint.map(|v|v.to_string())}))
        }
        "accept" | "rollback" => {
            let agents = context["agentObjectIds"].as_array().ok_or_else(invalid)?;
            let organizations = context["organizationObjectIds"].as_array().ok_or_else(invalid)?;
            if proposals.len()!=0 || references.len()!=agents.len()+organizations.len() { return Err(AppError::Conflict("Owner migration reference events do not match the prepared batch".into())); }
            let expected_old = if stage == "accept" { old_owner } else { &new_owner };
            let expected_new = if stage == "accept" { &new_owner } else { old_owner };
            let mut seen = HashSet::new();
            for event in &references {
                let p = event.get("parsedJson").and_then(Value::as_object).ok_or_else(invalid)?;
                let reference_id = address(p.get("reference_id"))?;
                let kind = u64_value(p.get("reference_kind"))?;
                let expected_kind = if agents.iter().any(|v| address(Some(v)).is_ok_and(|id| same(&id,&reference_id))) {1} else if organizations.iter().any(|v| address(Some(v)).is_ok_and(|id| same(&id,&reference_id))) {2} else {0};
                if expected_kind==0 || kind!=expected_kind || !seen.insert(reference_id.clone()) || !same(&address(p.get("account_id"))?,account_id) || !same(&address(p.get("old_owner"))?,expected_old) || !same(&address(p.get("new_owner"))?,expected_new) || !same(&address(p.get("updated_by"))?,signer) || !same(&address(event.get("sender"))?,signer) { return Err(invalid()); }
            }
            let finalizes = context.get("finalize").and_then(Value::as_bool).unwrap_or(false);
            if (stage == "accept" && finalizes && (rotations.len()!=1 || profiles.len()!=1)) || ((stage != "accept" || !finalizes) && (!rotations.is_empty() || !profiles.is_empty())) { return Err(AppError::Conflict("Owner migration finalization events do not match the prepared batch".into())); }
            if finalizes {
                let r = rotations[0].get("parsedJson").and_then(Value::as_object).ok_or_else(invalid)?;
                let profile = profiles[0].get("parsedJson").and_then(Value::as_object).ok_or_else(invalid)?;
                if !same(&address(r.get("account_id"))?,account_id) || !same(&address(r.get("old_owner"))?,old_owner) || !same(&address(r.get("new_owner"))?,&new_owner) || !same(&address(r.get("profile_id"))?,context_profile.as_deref().ok_or_else(invalid)?) || !same(&address(profile.get("memory_account_id"))?,account_id) || !same(&address(profile.get("profile_id"))?,context_profile.as_deref().ok_or_else(invalid)?) || !same(&address(profile.get("old_owner"))?,old_owner) || !same(&address(profile.get("new_owner"))?,&new_owner) { return Err(invalid()); }
            }
            Ok(json!({"digest":digest,"accountId":account_id,"stage":stage,"status":status,"referenceEvents":references,"finalized":finalizes,"evidence":references,"preparedContext":context,"checkpoint":checkpoint.map(|v|v.to_string())}))
        }
        "cancel" => {
            if !proposals.is_empty() || !references.is_empty() || !rotations.is_empty() || !profiles.is_empty() || !same(signer,old_owner) { return Err(invalid()); }
            if pending_owner_rotation(state, auth).await?.is_some() { return Err(AppError::Conflict("Owner migration cancellation is not reflected in live state".into())); }
            Ok(json!({"digest":digest,"accountId":account_id,"stage":stage,"status":status,"evidence":[],"preparedContext":context,"checkpoint":checkpoint.map(|v|v.to_string())}))
        }
        _ => Err(invalid()),
    }
}
fn query(resource: &str, q: &crate::platform_reads::ReadQuery) -> Result<(), AppError> {
    let allowed: &[&str] = match resource {
        "agent_admin_quote" | "agent_admin_receipt" | "agent_admin_rotation_receipt" | "agent_admin_registered_rotation_receipt" => &["id"],
        "agent_admin_list" => &["limit", "cursor"],
        "agent_admin_rotation_manifest" | "agent_admin_rotation_progress" => {
            &["state", "limit", "cursor"]
        }
        "agent_admin_rotation_status" => &[],
        _ => {
            return Err(AppError::BlobNotFound(
                "Unknown owner agent resource".into(),
            ));
        }
    };
    for (name, present) in [
        ("id", q.id.is_some()),
        ("state", q.state.is_some()),
        ("limit", q.limit.is_some()),
        ("cursor", q.cursor.is_some()),
        ("offset", q.offset.is_some()),
        ("role", q.role.is_some()),
        ("status", q.status.is_some()),
        ("serviceId", q.service_id.is_some()),
        ("planId", q.plan_id.is_some()),
        ("coinType", q.coin_type.is_some()),
        ("recipient", q.recipient.is_some()),
        ("amountBaseUnits", q.amount_base_units.is_some()),
    ] {
        if present && !allowed.contains(&name) {
            return Err(bad("Unexpected owner agent query parameter"));
        }
    }
    Ok(())
}
pub async fn read(
    state: &Arc<AppState>,
    auth: &AuthInfo,
    resource: &str,
    q: &crate::platform_reads::ReadQuery,
) -> Result<Value, AppError> {
    request_scope(state, auth)?;
    query(resource, q)?;
    tokio::time::timeout(
        std::time::Duration::from_secs(28),
        read_inner(state, auth, resource, q),
    )
    .await
    .map_err(|_| AppError::Internal("Agent read exceeded its read budget".into()))?
}
async fn read_inner(
    state: &AppState,
    auth: &AuthInfo,
    resource: &str,
    q: &crate::platform_reads::ReadQuery,
) -> Result<Value, AppError> {
    if resource == "agent_admin_receipt" {
        return receipt(
            state,
            auth,
            q.id.as_deref().ok_or_else(|| bad("id is required"))?,
        )
        .await;
    }
    if resource == "agent_admin_registered_rotation_receipt" {
        return rotation_receipt(state, auth, q.id.as_deref().ok_or_else(|| bad("id is required"))?).await;
    }
    let account = if resource == "agent_admin_rotation_receipt" {
        object(state, &auth.account_id).await?
    } else {
        account(state, auth).await?
    };
    if resource == "agent_admin_rotation_status" {
        let key_type = format!(
            "{}::memory::MemoryOwnerRotationKey",
            state.config.package_id
        );
        let value_type = format!("{}::memory::MemoryOwnerRotation", state.config.package_id);
        let result = rpc(
            state,
            "mysox_getDynamicFieldObject",
            json!([
                auth.account_id,
                {"type": key_type, "value": {}}
            ]),
        )
        .await?;
        if result
            .pointer("/error/code")
            .and_then(Value::as_str)
            .is_some_and(|code| matches!(code, "dynamicFieldNotFound" | "notExists" | "deleted"))
        {
            return Ok(
                json!({"accountId":auth.account_id,"pending":false,"evidenceSource":"configured_fullnode_live_dynamic_field"}),
            );
        }
        let data = result.pointer("/data").ok_or_else(invalid)?;
        let expected = coin_type(&format!(
            "0x2::dynamic_field::Field<{key_type},{value_type}>"
        ))?;
        if coin_type(
            data.pointer("/content/type")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?,
        )? != expected
            || !same(
                &address(data.pointer("/owner/ObjectOwner"))?,
                &auth.account_id,
            )
        {
            return Err(invalid());
        }
        let rotation = data
            .pointer("/content/fields/value/fields")
            .and_then(Value::as_object)
            .ok_or_else(invalid)?;
        let old_owner = address(rotation.get("old_owner"))?;
        let new_owner = address(rotation.get("new_owner"))?;
        if !same(&old_owner, &auth.owner) || same(&old_owner, &new_owner) {
            return Err(AppError::Conflict(
                "The pending owner migration no longer matches the authenticated account owner"
                    .into(),
            ));
        }
        let table_count = |name: &str| -> Result<String, AppError> {
            let size = rotation
                .get(name)
                .and_then(|table| table.pointer("/fields/size"))
                .ok_or_else(invalid)?;
            Ok(u64_value(Some(size))?.to_string())
        };
        let proposed_at_ms = u64_value(rotation.get("proposed_at_ms"))?.to_string();
        return Ok(json!({
            "accountId":auth.account_id,"pending":true,"oldOwner":old_owner,"newOwner":new_owner,
            "agentCount":table_count("agent_manifest")?,"organizationCount":table_count("organization_manifest")?,
            "updatedAgentCount":table_count("updated_agents")?,"updatedOrganizationCount":table_count("updated_organizations")?,
            "proposedAtMs":proposed_at_ms,"evidenceSource":"configured_fullnode_live_dynamic_field"
        }));
    }
    if resource == "agent_admin_rotation_progress" {
        let kind = q
            .state
            .as_deref()
            .ok_or_else(|| bad("state must be agents or organizations"))?;
        if !matches!(kind, "agents" | "organizations") {
            return Err(bad("state must be agents or organizations"));
        }
        let limit = q.limit.unwrap_or(50);
        if !(1..=50).contains(&limit) {
            return Err(bad(
                "Owner migration progress page limit must be between 1 and 50",
            ));
        }
        let cursor = q.cursor.as_deref().map(id).transpose()?;
        let key_type = format!(
            "{}::memory::MemoryOwnerRotationKey",
            state.config.package_id
        );
        let value_type = format!("{}::memory::MemoryOwnerRotation", state.config.package_id);
        let pending = rpc(
            state,
            "mysox_getDynamicFieldObject",
            json!([
                auth.account_id,
                {"type":key_type,"value":{}}
            ]),
        )
        .await?;
        if pending.pointer("/error/code").and_then(Value::as_str) == Some("dynamicFieldNotFound") {
            return Err(AppError::Conflict(
                "There is no pending owner migration".into(),
            ));
        }
        let expected_field = coin_type(&format!(
            "0x2::dynamic_field::Field<{key_type},{value_type}>"
        ))?;
        if coin_type(
            pending
                .pointer("/data/content/type")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?,
        )? != expected_field
            || !same(
                &address(pending.pointer("/data/owner/ObjectOwner"))?,
                &auth.account_id,
            )
        {
            return Err(invalid());
        }
        let rotation = pending
            .pointer("/data/content/fields/value/fields")
            .and_then(Value::as_object)
            .ok_or_else(invalid)?;
        let old_owner = address(rotation.get("old_owner"))?;
        let new_owner = address(rotation.get("new_owner"))?;
        if !same(&old_owner, &auth.owner) || same(&old_owner, &new_owner) {
            return Err(AppError::Conflict(
                "The pending owner migration no longer matches the authenticated account owner"
                    .into(),
            ));
        }
        let table_name = if kind == "agents" {
            "updated_agents"
        } else {
            "updated_organizations"
        };
        let table = rotation
            .get(table_name)
            .and_then(Value::as_object)
            .ok_or_else(invalid)?;
        let table_fields = table
            .get("fields")
            .and_then(Value::as_object)
            .ok_or_else(invalid)?;
        let table_id = address(table_fields.get("id").and_then(|value| value.get("id")))?;
        let updated_count = u64_value(table_fields.get("size"))?;
        let page = rpc(
            state,
            "mysox_getDynamicFields",
            json!([table_id, cursor, limit]),
        )
        .await?;
        let rows = page
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(invalid)?;
        if rows.len() > limit as usize || rows.len() as u64 > updated_count {
            return Err(invalid());
        }
        let mut field_ids = HashSet::new();
        let mut reference_ids = HashSet::new();
        let mut items = Vec::with_capacity(rows.len());
        let mut last = None;
        for row in rows {
            let field_id = address(row.get("objectId"))?;
            if !field_ids.insert(field_id.clone()) {
                return Err(invalid());
            }
            last = Some(field_id);
            if coin_type(
                row.pointer("/name/type")
                    .and_then(Value::as_str)
                    .ok_or_else(invalid)?,
            )? != coin_type("0x2::object::ID")?
            {
                return Err(invalid());
            }
            let reference_id = address(row.pointer("/name/value"))?;
            if !reference_ids.insert(reference_id.clone()) {
                return Err(invalid());
            }
            items.push(reference_id);
        }
        let has_next = page
            .get("hasNextPage")
            .and_then(Value::as_bool)
            .ok_or_else(invalid)?;
        let next_cursor = page
            .get("nextCursor")
            .filter(|value| !value.is_null())
            .map(|value| address(Some(value)))
            .transpose()?;
        if has_next
            && (items.is_empty()
                || next_cursor.is_none()
                || next_cursor == cursor
                || next_cursor != last)
        {
            return Err(invalid());
        }
        return Ok(json!({
            "state":kind,"accountId":auth.account_id,"oldOwner":old_owner,"newOwner":new_owner,
            "updatedCount":updated_count.to_string(),"items":items,"hasNextPage":has_next,
            "nextCursor":if has_next {next_cursor} else {None::<String>},
            "evidenceSource":"configured_fullnode_live_dynamic_field"
        }));
    }
    if resource == "agent_admin_quote" {
        let target_id = q.id.as_deref().ok_or_else(|| bad("id is required"))?;
        let target_data = object(state, target_id).await?;
        let mut agent = agent_metadata(&target_data, &account, &state.config.package_id, auth)?;
        agent["effectiveAuthority"] =
            effective_authority(state, auth, &account, &target_data).await?;
        return Ok(
            json!({"accountId":auth.account_id,"agent":agent,"supportedGrantMask":SUPPORTED_GRANT_MASK.to_string(),"writesEnabled":configured(&state.config),"authority":"owner_wallet","evidenceSource":"configured_fullnode"}),
        );
    }
    if resource == "agent_admin_rotation_receipt" {
        let digest = q.id.as_deref().ok_or_else(|| bad("id is required"))?;
        digest_bytes(digest).map_err(|_| bad("Invalid owner migration receipt digest"))?;
        let transaction = rpc(
            state,
            "myso_getTransactionBlock",
            json!([
                digest,
                {"showEffects":true,"showEvents":true}
            ]),
        )
        .await?;
        if transaction.get("digest").and_then(Value::as_str) != Some(digest) {
            return Err(invalid());
        }
        let status = transaction
            .pointer("/effects/status/status")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?;
        if status != "success" {
            return Ok(
                json!({"digest":digest,"accountId":auth.account_id,"status":"failed","evidence":[],"evidenceSource":"configured_fullnode_transaction"}),
            );
        }
        let events = transaction
            .get("events")
            .and_then(Value::as_array)
            .ok_or_else(invalid)?;
        let package = &state.config.package_id;
        let proposal_type = coin_type(&format!(
            "{package}::memory::MemoryAccountOwnerRotationProposed"
        ))?;
        let rotated_type = coin_type(&format!("{package}::memory::MemoryAccountOwnerRotated"))?;
        let reference_type = coin_type(&format!(
            "{package}::memory::MemoryAccountOwnerRotationReferenceUpdated"
        ))?;
        let profile_type = coin_type(&format!("{package}::profile::ProfileOwnerRotatedEvent"))?;
        let parsed_events = events
            .iter()
            .map(|event| {
                let name = coin_type(
                    event
                        .get("type")
                        .and_then(Value::as_str)
                        .ok_or_else(invalid)?,
                )?;
                Ok::<_, AppError>((event, name))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let matching = |event_type: &str| {
            parsed_events
                .iter()
                .filter(|(_, name)| name == event_type)
                .map(|(event, _)| *event)
                .collect::<Vec<_>>()
        };
        let proposal_events = matching(&proposal_type);
        let rotated_events = matching(&rotated_type);
        if proposal_events.len() == 1 && rotated_events.is_empty() {
            let event = proposal_events[0];
            let parsed = event
                .get("parsedJson")
                .and_then(Value::as_object)
                .ok_or_else(invalid)?;
            let account_id = address(parsed.get("account_id"))?;
            let old_owner = address(parsed.get("old_owner"))?;
            let new_owner = address(parsed.get("new_owner"))?;
            let sender = address(event.get("sender"))?;
            let account_fields = fields(&account, package, "MemoryAccount")?;
            let current_owner = address(account_fields.get("owner"))?;
            let expected_agents = account_fields
                .get("agent_ids")
                .and_then(|value| value.pointer("/fields/size"))
                .ok_or_else(invalid)
                .and_then(|value| u64_value(Some(value)))?;
            let expected_organizations = account_fields
                .get("organizations")
                .and_then(|value| value.pointer("/fields/size"))
                .ok_or_else(invalid)
                .and_then(|value| u64_value(Some(value)))?;
            let agent_count = u64_value(parsed.get("agent_count"))?;
            let organization_count = u64_value(parsed.get("organization_count"))?;
            if !same(&account_id, &auth.account_id)
                || !same(&old_owner, &sender)
                || !same(&current_owner, &old_owner)
                || (!same(&auth.owner, &old_owner) && !same(&auth.owner, &new_owner))
                || same(&old_owner, &new_owner)
                || agent_count != expected_agents
                || organization_count != expected_organizations
            {
                return Err(AppError::BlobNotFound(
                    "Owner migration proposal receipt is outside this account and wallet scope"
                        .into(),
                ));
            }
            return Ok(json!({
                "digest":digest,"accountId":account_id,"status":if transaction.get("checkpoint").is_some_and(|v| !v.is_null()) {"finalized"} else {"executed"},
                "stage":"proposal","oldOwner":old_owner,"newOwner":new_owner,
                "agentCount":agent_count.to_string(),
                "organizationCount":organization_count.to_string(),
                "proposedAtMs":u64_value(parsed.get("proposed_at_ms"))?.to_string(),
                "evidenceSource":"configured_fullnode_scoped_native_event"
            }));
        }
        if rotated_events.len() != 1 || proposal_events.len() > 1 {
            return Err(AppError::BlobNotFound(
                "No unique owner migration receipt was found in this account scope".into(),
            ));
        }
        let account_fields = fields(&account, package, "MemoryAccount")?;
        let profile_id = address(account_fields.get("profile_id"))?;
        let current_owner = address(account_fields.get("owner"))?;
        let rotated = rotated_events[0]
            .get("parsedJson")
            .and_then(Value::as_object)
            .ok_or_else(invalid)?;
        let account_id = address(rotated.get("account_id"))?;
        let old_owner = address(rotated.get("old_owner"))?;
        let new_owner = address(rotated.get("new_owner"))?;
        let event_profile_id = address(rotated.get("profile_id"))?;
        if !same(&account_id, &auth.account_id)
            || !same(&event_profile_id, &profile_id)
            || !same(&current_owner, &new_owner)
            || (!same(&auth.owner, &old_owner) && !same(&auth.owner, &new_owner))
            || same(&old_owner, &new_owner)
            || !same(&address(rotated_events[0].get("sender"))?, &new_owner)
        {
            return Err(AppError::BlobNotFound(
                "Owner migration receipt is outside this account and current-owner scope".into(),
            ));
        }
        let profiles = matching(&profile_type);
        if profiles.len() != 1 {
            return Err(invalid());
        }
        let profile = profiles[0]
            .get("parsedJson")
            .and_then(Value::as_object)
            .ok_or_else(invalid)?;
        if !same(&address(profile.get("profile_id"))?, &profile_id)
            || !same(&address(profile.get("memory_account_id"))?, &account_id)
            || !same(&address(profile.get("old_owner"))?, &old_owner)
            || !same(&address(profile.get("new_owner"))?, &new_owner)
        {
            return Err(invalid());
        }
        let references = matching(&reference_type);
        let mut reference_ids = HashSet::new();
        let mut agent_updates = 0u64;
        let mut organization_updates = 0u64;
        for event in references {
            let parsed = event
                .get("parsedJson")
                .and_then(Value::as_object)
                .ok_or_else(invalid)?;
            if !same(&address(parsed.get("account_id"))?, &account_id)
                || !same(&address(parsed.get("old_owner"))?, &old_owner)
                || !same(&address(parsed.get("new_owner"))?, &new_owner)
                || !same(&address(parsed.get("updated_by"))?, &new_owner)
                || !same(&address(event.get("sender"))?, &new_owner)
                || !reference_ids.insert(address(parsed.get("reference_id"))?)
            {
                return Err(invalid());
            }
            match u64_value(parsed.get("reference_kind"))? {
                1 => agent_updates += 1,
                2 => organization_updates += 1,
                _ => return Err(invalid()),
            }
        }
        let expected_agents = account_fields
            .get("agent_ids")
            .and_then(|v| v.pointer("/fields/size"))
            .ok_or_else(invalid)
            .and_then(|v| u64_value(Some(v)))?;
        let expected_organizations = account_fields
            .get("organizations")
            .and_then(|v| v.pointer("/fields/size"))
            .ok_or_else(invalid)
            .and_then(|v| u64_value(Some(v)))?;
        return Ok(json!({
            "digest":digest,"accountId":account_id,"profileId":profile_id,
            "status":if transaction.get("checkpoint").is_some_and(|v| !v.is_null()) {"finalized"} else {"executed"},
            "stage":"accepted","oldOwner":old_owner,"newOwner":new_owner,
            "updatedAgentCount":expected_agents.to_string(),"updatedOrganizationCount":expected_organizations.to_string(),
            "finalTransactionAgentUpdateCount":agent_updates.to_string(),"finalTransactionOrganizationUpdateCount":organization_updates.to_string(),
            "finalTransactionUniqueReferenceCount":reference_ids.len(),
            "completionProof":"Move accepted owner rotation only after every immutable manifest reference was updated",
            "evidenceSource":"configured_fullnode_scoped_native_events_live_registry_counts_and_move_completion_guard"
        }));
    }
    if resource == "agent_admin_rotation_manifest" {
        let kind = q
            .state
            .as_deref()
            .ok_or_else(|| bad("state must be agents or organizations"))?;
        if !matches!(kind, "agents" | "organizations") {
            return Err(bad("state must be agents or organizations"));
        }
        let limit = q.limit.unwrap_or(50);
        if !(1..=50).contains(&limit) {
            return Err(bad(
                "Owner rotation manifest page limit must be between 1 and 50",
            ));
        }
        let cursor = q.cursor.as_deref().map(id).transpose()?;
        let account_fields = fields(&account, &state.config.package_id, "MemoryAccount")?;
        let profile_id = address(account_fields.get("profile_id"))?;
        let table_name = if kind == "agents" {
            "agent_ids"
        } else {
            "organizations"
        };
        let table_fields = account_fields
            .get(table_name)
            .and_then(|v| v.get("fields"))
            .and_then(Value::as_object)
            .ok_or_else(invalid)?;
        let table_id = address(table_fields.get("id").and_then(|v| v.get("id")))?;
        let expected_count = u64_value(table_fields.get("size"))?;
        let page = rpc(
            state,
            "mysox_getDynamicFields",
            json!([table_id, cursor, limit]),
        )
        .await?;
        let rows = page["data"].as_array().ok_or_else(invalid)?;
        if rows.len() > limit as usize || rows.len() as u64 > expected_count {
            return Err(invalid());
        }
        let mut field_ids = HashSet::new();
        let mut object_ids = HashSet::new();
        let mut targets = Vec::with_capacity(rows.len());
        let mut last = None;
        for row in rows {
            let field_id = address(row.get("objectId"))?;
            if !field_ids.insert(field_id.clone()) {
                return Err(invalid());
            }
            last = Some(field_id);
            if coin_type(
                row.pointer("/name/type")
                    .and_then(Value::as_str)
                    .ok_or_else(invalid)?,
            )? != coin_type("0x2::object::ID")?
            {
                return Err(invalid());
            }
            let object_id = address(row.pointer("/name/value"))?;
            if !object_ids.insert(object_id.clone()) {
                return Err(invalid());
            }
            targets.push(object_id);
        }
        let has_next = page["hasNextPage"].as_bool().ok_or_else(invalid)?;
        let next = match page.get("nextCursor") {
            None | Some(Value::Null) => None,
            Some(value) => Some(address(Some(value))?),
        };
        if has_next && (targets.is_empty() || next.is_none() || next == cursor || next != last) {
            return Err(invalid());
        }
        let expected_type = if kind == "agents" {
            "SubAgent"
        } else {
            "AgenticOrganization"
        };
        let expected_account = auth.account_id.clone();
        let expected_owner = auth.owner.clone();
        let expected_profile = profile_id.clone();
        let checked_ids = stream::iter(targets)
            .map(|object_id| {
                let expected_account = expected_account.clone();
                let expected_owner = expected_owner.clone();
                let expected_profile = expected_profile.clone();
                async move {
                    let data = object(state, &object_id).await?;
                    let child = fields(&data, &state.config.package_id, expected_type)?;
                    if !same(&address(child.get("memory_account_id"))?, &expected_account)
                        || !same(&address(child.get("principal_owner"))?, &expected_owner)
                        || !same(&address(child.get("profile_id"))?, &expected_profile)
                        || !same(&address(data.get("objectId"))?, &object_id)
                    {
                        return Err(invalid());
                    }
                    Ok(object_id)
                }
            })
            .buffered(4)
            .try_collect::<Vec<_>>()
            .await?;
        return Ok(json!({
            "kind": kind,
            "accountId": auth.account_id,
            "owner": auth.owner,
            "profileId": profile_id,
            "tableCount": expected_count.to_string(),
            "items": checked_ids,
            "hasNextPage": has_next,
            "nextCursor": if has_next { next } else { None },
            "evidenceSource": "configured_fullnode",
        }));
    }
    let limit = q.limit.unwrap_or(20);
    if !(1..=50).contains(&limit) {
        return Err(bad("Agent page limit must be between 1 and 50"));
    }
    let cursor = q.cursor.as_deref().map(id).transpose()?;
    let table = address(account.pointer("/content/fields/agent_ids/fields/id/id"))?;
    let page = rpc(
        state,
        "mysox_getDynamicFields",
        json!([table, cursor, limit]),
    )
    .await?;
    let rows = page["data"].as_array().ok_or_else(invalid)?;
    if rows.len() > limit as usize {
        return Err(invalid());
    }
    let mut field_ids = HashSet::new();
    let mut agent_ids = HashSet::new();
    let mut targets = Vec::new();
    let mut last = None;
    for row in rows {
        let field = address(row.get("objectId"))?;
        if !field_ids.insert(field.clone()) {
            return Err(invalid());
        }
        last = Some(field);
        if coin_type(
            row.pointer("/name/type")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?,
        )? != coin_type("0x2::object::ID")?
        {
            return Err(invalid());
        }
        let agent = address(row.pointer("/name/value"))?;
        if !agent_ids.insert(agent.clone()) {
            return Err(invalid());
        }
        targets.push(agent);
    }
    let has_next = page["hasNextPage"].as_bool().ok_or_else(invalid)?;
    let next = match page.get("nextCursor") {
        None | Some(Value::Null) => None,
        Some(v) => Some(address(Some(v))?),
    };
    if has_next && (targets.is_empty() || next.is_none() || next == cursor || next != last) {
        return Err(invalid());
    }
    let account_ref = &account;
    let data = stream::iter(targets)
        .map(|target_id| async move {
            let data = object(state, &target_id).await?;
            // A filtered platform row must not silently hide malformed chain data.
            let f = fields(&data, &state.config.package_id, "SubAgent")?;
            if !same(&address(f.get("memory_account_id"))?, &auth.account_id) {
                return Err(invalid());
            }
            let platform = native_scope(f.get("platform_scope"))?;
            if !scope_allows(auth, &platform) {
                return Ok(None);
            }
            agent_metadata(&data, account_ref, &state.config.package_id, auth).map(Some)
        })
        .buffered(4)
        .try_collect::<Vec<_>>()
        .await?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    Ok(
        json!({"accountId":auth.account_id,"data":data,"hasNextPage":has_next,"nextCursor":if has_next{next}else{None},"evidenceSource":"configured_fullnode","effectiveAuthority":"not_computed"}),
    )
}
