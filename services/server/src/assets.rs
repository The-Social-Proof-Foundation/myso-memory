//! Fixed owner-wallet object transfers with scoped fullnode receipts.
use crate::chain_reads::{coin_type, digest_bytes, id, object, rpc, same};
use crate::types::{AppError, AppState, AuthInfo};
use serde_json::{json, Value};
use std::sync::Arc;

pub const ACTION: &str = "assets.transfer_object.v1";
pub const BURN_ACTION: &str = "assets.burn_object.v1";
fn bad(message: &str) -> AppError { AppError::BadRequest(message.into()) }
fn invalid() -> AppError { AppError::Internal("Asset transfer evidence is invalid or unavailable".into()) }
fn parameters(action: &str, value: &Value) -> Result<Value, AppError> {
    let fields = value.as_object().ok_or_else(|| bad("Asset transfer parameters must be an object"))?;
    if action == ACTION {
        if fields.len() != 3 || fields.keys().any(|key| !["objectId", "recipient", "objectType"].contains(&key.as_str())) {
            return Err(bad("Unexpected or missing asset transfer parameters"));
        }
        let object_id = id(value.get("objectId").and_then(Value::as_str).ok_or_else(|| bad("objectId is required"))?)
            .map_err(|_| bad("Invalid objectId"))?;
        let recipient = id(value.get("recipient").and_then(Value::as_str).ok_or_else(|| bad("recipient is required"))?)
            .map_err(|_| bad("Invalid recipient"))?;
        let object_type = coin_type(value.get("objectType").and_then(Value::as_str).ok_or_else(|| bad("objectType is required"))?)?;
        return Ok(json!({"objectId":object_id,"recipient":recipient,"objectType":object_type}));
    }
    if action == BURN_ACTION {
        if fields.len() != 2 || fields.keys().any(|key| !["coinObjectId", "coinType"].contains(&key.as_str())) {
            return Err(bad("Unexpected or missing zero-coin burn parameters"));
        }
        let object_id = id(value.get("coinObjectId").and_then(Value::as_str).ok_or_else(|| bad("coinObjectId is required"))?)
            .map_err(|_| bad("Invalid coinObjectId"))?;
        let coin_type = coin_type(value.get("coinType").and_then(Value::as_str).ok_or_else(|| bad("coinType is required"))?)?;
        if !coin_type.starts_with("0x0000000000000000000000000000000000000000000000000000000000000002::coin::Coin<") {
            return Err(bad("Only framework Coin<T> objects can be burned"));
        }
        return Ok(json!({"coinObjectId":object_id,"coinType":coin_type,"objectType":coin_type}));
    }
    Err(bad("Unknown asset action"))
}
async fn owner_object(state: &AppState, auth: &AuthInfo, action: &str, value: &Value) -> Result<Value, AppError> {
    if auth.capabilities & crate::memory_contract::CAP_TRADE_EXECUTE == 0 {
        return Err(AppError::Forbidden("Trade capability is required for object transfers".into()));
    }
    let p = parameters(action, value)?;
    if action == ACTION && same(p["recipient"].as_str().ok_or_else(invalid)?, &auth.owner) {
        return Err(bad("Recipient is already the approving owner"));
    }
    let object_id = if action == ACTION { p["objectId"].as_str() } else { p["coinObjectId"].as_str() }.ok_or_else(invalid)?;
    let data = object(state, object_id).await?;
    let object_type = coin_type(data.pointer("/content/type").and_then(Value::as_str).ok_or_else(invalid)?)?;
    let owner = data.pointer("/owner/AddressOwner").and_then(Value::as_str)
        .ok_or_else(|| AppError::Forbidden("Only directly owner-held objects can be transferred".into()))?;
    if !same(owner, &auth.owner) {
        return Err(AppError::Forbidden("Object is not owned by the approving wallet".into()));
    }
    if action == ACTION && object_type != p["objectType"].as_str().ok_or_else(invalid)? {
        return Err(AppError::Conflict("Object type changed after the transfer was requested".into()));
    }
    if action == BURN_ACTION {
        let expected_type = p["coinType"].as_str().ok_or_else(invalid)?;
        if object_type != expected_type {
            return Err(AppError::Conflict("Coin object type changed after the burn was requested".into()));
        }
        let balance = data.pointer("/content/fields/balance").and_then(|value| {
            value.as_str().and_then(|text| text.parse::<u64>().ok()).or_else(|| value.as_u64())
        }).ok_or_else(invalid)?;
        if balance != 0 {
            return Err(AppError::Conflict("Only a zero-balance Coin<T> can be burned".into()));
        }
    }
    let version = data.get("version").and_then(Value::as_str).ok_or_else(invalid)?;
    if version.is_empty() || !version.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(invalid());
    }
    Ok(json!({"parameters":p,"objectType":object_type,"objectVersion":version,"approvingOwner":id(&auth.owner)?,"executionPlatformId":id(&state.config.social_chain.platform_object_id)?,"approval":"owner_wallet","evidenceSource":"configured_fullnode"}))
}
pub async fn validate_action(state: &AppState, auth: &AuthInfo, action: &str, value: &Value) -> Result<(), AppError> {
    if action != ACTION && action != BURN_ACTION { return Ok(()); }
    tokio::time::timeout(std::time::Duration::from_secs(25), owner_object(state, auth, action, value))
        .await.map_err(|_| AppError::Internal("Asset transfer validation exceeded its read budget".into()))??;
    Ok(())
}
pub fn receipt_context(value: &Value, owner: &str, platform: &str) -> Result<Option<Value>, AppError> {
    let action = if value.get("coinObjectId").is_some() { BURN_ACTION } else { ACTION };
    let mut context = parameters(action, value)?;
    context["approvingOwner"] = json!(id(owner)?);
    context["executionPlatformId"] = json!(id(platform)?);
    Ok(Some(context))
}
async fn receipt(state: &AppState, auth: &AuthInfo, digest: &str) -> Result<Value, AppError> {
    digest_bytes(digest).map_err(|_| bad("Invalid asset transfer receipt digest"))?;
    let row = crate::chain_actions::get_by_digest(&state.db, &auth.account_id, &auth.agent_object_id, digest).await?
        .filter(|row| (row.registry_action == ACTION || row.registry_action == BURN_ACTION) && same(&row.package_id, &state.config.package_id))
        .ok_or_else(|| AppError::BlobNotFound("Asset transfer receipt is outside this account/agent scope".into()))?;
    let action = row.registry_action.as_str();
    let context = row.receipt_context.as_ref().ok_or_else(|| AppError::Conflict("Prepared asset receipt context is unavailable".into()))?;
    if !same(context["approvingOwner"].as_str().ok_or_else(invalid)?, &auth.owner)
        || !same(context["executionPlatformId"].as_str().ok_or_else(invalid)?, &state.config.social_chain.platform_object_id) {
        return Err(AppError::BlobNotFound("Asset transfer receipt is outside this principal or platform".into()));
    }
    let transaction = rpc(state, "myso_getTransactionBlock", json!([digest,{"showInput":true,"showEffects":true,"showEvents":true,"showObjectChanges":true}])).await?;
    if transaction["digest"].as_str() != Some(digest) { return Err(invalid()); }
    let sender = transaction.pointer("/transaction/data/sender").or_else(|| transaction.pointer("/transaction/sender"))
        .and_then(Value::as_str).ok_or_else(invalid)?;
    if !same(sender, &auth.owner) || !same(sender, &row.sender) {
        return Err(AppError::Conflict("Asset transfer sender does not match its approving owner".into()));
    }
    let status = transaction.pointer("/effects/status/status").and_then(Value::as_str);
    let checkpoint = transaction.get("checkpoint").filter(|value| !value.is_null());
    let finalized = status == Some("success") && checkpoint.is_some();
    let changes = transaction.get("objectChanges").and_then(Value::as_array).ok_or_else(invalid)?;
    let object_id = if action == ACTION { context["objectId"].as_str() } else { context["coinObjectId"].as_str() }.ok_or_else(invalid)?;
    let expected_type = coin_type(context.get("objectType").and_then(Value::as_str).ok_or_else(invalid)?)?;
    let effect_kind = if action == ACTION { "transferred" } else { "deleted" };
    let matches = changes.iter().filter(|change| change.get("type").and_then(Value::as_str) == Some(effect_kind))
        .filter(|change| change.get("objectId").and_then(Value::as_str).is_some_and(|actual| same(actual, object_id)))
        .filter(|change| change.get("objectType").and_then(Value::as_str).and_then(|actual| coin_type(actual).ok()).as_deref() == Some(expected_type.as_str()))
        .filter(|change| action != ACTION || change.pointer("/recipient/AddressOwner").and_then(Value::as_str).is_some_and(|actual| same(actual, context["recipient"].as_str().unwrap_or_default())))
        .collect::<Vec<_>>();
    if finalized && matches.len() != 1 { return Err(AppError::Conflict("Unique exact asset effect could not be verified".into())); }
    Ok(json!({"digest":digest,"registryAction":action,"status":match status{Some("success") if finalized=>"finalized",Some("success")=>"checkpoint_pending",Some("failure")=>"failed",_=>"unknown"},"checkpoint":checkpoint.map(Value::to_string),"objectChange":matches.first(),"evidenceSource":"configured_fullnode_and_scoped_preparation"}))
}
async fn owned_object_summary(state: &AppState, auth: &AuthInfo, object_id: &str) -> Result<Value, AppError> {
    let object_id = id(object_id).map_err(|_| bad("Invalid object ID"))?;
    let data = object(state, &object_id).await?;
    let owner = data.pointer("/owner/AddressOwner").and_then(Value::as_str)
        .ok_or_else(|| AppError::Forbidden("Only directly owned objects are available through this read".into()))?;
    if !same(owner, &auth.owner) { return Err(AppError::Forbidden("Object is not owned by the authenticated owner".into())); }
    let object_type = coin_type(data.pointer("/content/type").and_then(Value::as_str).ok_or_else(invalid)?)?;
    let balance = data.pointer("/content/fields/balance").and_then(|value| value.as_str().and_then(|text| text.parse::<u64>().ok()).or_else(|| value.as_u64()));
    Ok(json!({"objectId":object_id,"objectType":object_type,"version":data.get("version"),"coinBalanceBaseUnits":balance.map(|value|value.to_string()),"owner":id(&auth.owner)?,"evidenceSource":"configured_fullnode"}))
}
pub async fn read(state: &Arc<AppState>, auth: &AuthInfo, resource: &str, q: &crate::platform_reads::ReadQuery) -> Result<Value, AppError> {
    let allowed: &[&str] = match resource {
        "assets_transfer_receipt" | "assets_burn_receipt" | "assets_owned_object" => &["id"],
        "assets_owned_objects" => &["cursor", "limit"],
        _ => return Err(bad("unknown asset read resource")),
    };
    for (name, present) in [
        ("id", q.id.is_some()),
        ("cursor", q.cursor.is_some()),
        ("limit", q.limit.is_some()),
        ("offset", q.offset.is_some()),
        ("coinType", q.coin_type.is_some()),
        ("recipient", q.recipient.is_some()),
    ] {
        if present && !allowed.contains(&name) {
            return Err(bad("Unexpected asset read query parameter"));
        }
    }
    match resource {
        "assets_transfer_receipt" | "assets_burn_receipt" => receipt(state, auth, q.id.as_deref().ok_or_else(|| bad("id is required"))?).await,
        "assets_owned_object" => owned_object_summary(state, auth, q.id.as_deref().ok_or_else(|| bad("id is required"))?).await,
        "assets_owned_objects" => owned_objects(state, auth, q.cursor.as_deref(), q.limit.unwrap_or(20)).await,
        _ => Err(bad("unknown asset read resource")),
    }
}

async fn owned_objects(state: &AppState, auth: &AuthInfo, cursor: Option<&str>, limit: u32) -> Result<Value, AppError> {
    if !(1..=50).contains(&limit) { return Err(bad("Asset page limit must be between 1 and 50")); }
    let cursor = cursor.map(id).transpose()?;
    let page = rpc(state, "mysox_getOwnedObjects", json!([
        id(&auth.owner)?,
        {"options":{"showContent":true,"showOwner":true}},
        cursor,
        limit
    ])).await?;
    let rows = page.get("data").and_then(Value::as_array).ok_or_else(invalid)?;
    if rows.len() > limit as usize { return Err(invalid()); }
    let has_next = page.get("hasNextPage").and_then(Value::as_bool).ok_or_else(invalid)?;
    let next_cursor = match page.get("nextCursor") {
        Some(Value::Null) | None => None,
        Some(value) => Some(id(value.as_str().ok_or_else(invalid)?).map_err(|_| invalid())?),
    };
    let mut seen = std::collections::HashSet::new();
    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        let data = row.get("data").ok_or_else(invalid)?;
        let object_id = id(data.get("objectId").and_then(Value::as_str).ok_or_else(invalid)?).map_err(|_| invalid())?;
        if !seen.insert(object_id.clone()) { return Err(invalid()); }
        let owner = data.pointer("/owner/AddressOwner").and_then(Value::as_str).ok_or_else(invalid)?;
        if !same(owner, &auth.owner) { return Err(AppError::Forbidden("Fullnode returned an object outside the authenticated owner".into())); }
        let content = data.get("content").ok_or_else(invalid)?;
        let object_type = coin_type(content.get("type").and_then(Value::as_str).ok_or_else(invalid)?)?;
        let version = data.get("version").and_then(Value::as_str).ok_or_else(invalid)?;
        if version.is_empty() || !version.bytes().all(|byte| byte.is_ascii_digit()) { return Err(invalid()); }
        let balance = content.pointer("/fields/balance").and_then(|value| value.as_str().and_then(|raw| raw.parse::<u64>().ok()).or_else(|| value.as_u64()));
        items.push(json!({"objectId":object_id,"objectType":object_type,"version":version,"coinBalanceBaseUnits":balance.map(|value| value.to_string())}));
    }
    let last_id = items.last().and_then(|item| item.get("objectId")).and_then(Value::as_str);
    if has_next && (items.is_empty() || next_cursor.is_none() || cursor.as_deref() == next_cursor.as_deref() || last_id != next_cursor.as_deref()) {
        return Err(invalid());
    }
    Ok(json!({"items":items,"owner":id(&auth.owner)?,"hasNextPage":has_next,"nextCursor":if has_next {next_cursor} else {None},"evidenceSource":"configured_fullnode"}))
}
