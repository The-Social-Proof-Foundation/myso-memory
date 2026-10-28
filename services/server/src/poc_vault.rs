//! Owner-authorized creator-vault claims with scoped native-event receipts.
use crate::chain_reads::{coin_type, digest_bytes, id, object, rpc, same, u64_value};
use crate::types::{AppError, AppState, AuthInfo, Config};
use serde_json::{json, Value};
use std::sync::Arc;

pub const ACTION: &str = "poc.claim_creator_vault.v1";
pub const ACCEPT_TRANSFER_ACTION: &str = "poc.accept_beneficiary_transfer.v1";
pub fn configured(config: &Config) -> bool {
    config.poc_vault_claims_enabled
        && config.social_chain.is_configured()
        && !config.social_chain.poc_config_id.is_empty()
        && !config.social_chain.ecosystem_treasury_id.is_empty()
}
fn invalid() -> AppError { AppError::Internal("Creator-vault chain evidence is invalid or unavailable".into()) }
fn bad(message: &str) -> AppError { AppError::BadRequest(message.into()) }
fn named_coin(value: Option<&Value>) -> Result<String, AppError> {
    let name = value.and_then(|v| v.as_str().or_else(|| v.pointer("/fields/name").or_else(|| v.get("name")).and_then(Value::as_str))).ok_or_else(invalid)?;
    coin_type(name)
}
fn params(p: &Value) -> Result<Value, AppError> {
    let fields = p.as_object().ok_or_else(|| bad("Creator-vault claim parameters must be an object"))?;
    if fields.len() != 2 || fields.keys().any(|key| !["vaultId", "coinType"].contains(&key.as_str())) {
        return Err(bad("Unexpected or missing creator-vault claim parameters"));
    }
    let vault = id(p.get("vaultId").and_then(Value::as_str).ok_or_else(|| bad("vaultId is required"))?)
        .map_err(|_| bad("Invalid vaultId"))?;
    let coin = coin_type(p.get("coinType").and_then(Value::as_str).ok_or_else(|| bad("coinType is required"))?)
        .map_err(|_| bad("Invalid coinType"))?;
    Ok(json!({"vaultId":vault,"coinType":coin}))
}
async fn validate_owner_vault(state: &AppState, auth: &AuthInfo, p: &Value) -> Result<Value, AppError> {
    if auth.capabilities & crate::memory_contract::CAP_TRADE_EXECUTE == 0 {
        return Err(AppError::Forbidden("Trade capability is required for creator-vault claims".into()));
    }
    if !configured(&state.config) { return Err(AppError::Forbidden("Creator-vault claims are disabled for this deployment".into())); }
    let p = params(p)?;
    let vault_id = p["vaultId"].as_str().ok_or_else(invalid)?;
    let data = object(state, vault_id).await?;
    let expected_type = coin_type(&format!("{}::proof_of_creativity::PoCBeneficiaryVault", state.config.package_id))?;
    let actual_type = data.pointer("/content/type").and_then(Value::as_str).ok_or_else(invalid)?;
    let beneficiary = data.pointer("/content/fields/beneficiary").and_then(Value::as_str).ok_or_else(invalid)?;
    if coin_type(actual_type)? != expected_type || !same(beneficiary, &auth.owner) {
        return Err(AppError::Forbidden("Creator vault is not owned by the authenticated principal or has another type".into()));
    }
    Ok(json!({"claimParameters":p,"vaultId":vault_id,"beneficiary":id(&auth.owner)?,"coinType":p["coinType"],"evidenceSource":"configured_fullnode","approval":"owner_wallet","claimAmount":"resolved_by_native_claim_event"}))
}
pub async fn validate_action(state: &AppState, auth: &AuthInfo, action: &str, parameters: &Value) -> Result<(), AppError> {
    if action == ACCEPT_TRANSFER_ACTION {
        tokio::time::timeout(std::time::Duration::from_secs(25), validate_transfer_recipient(state, auth, parameters))
            .await.map_err(|_| AppError::Internal("Beneficiary recipient validation exceeded its read budget".into()))??;
        return Ok(());
    }
    if action != ACTION { return Ok(()); }
    tokio::time::timeout(std::time::Duration::from_secs(25), validate_owner_vault(state, auth, parameters))
        .await.map_err(|_| AppError::Internal("Creator-vault validation exceeded its read budget".into()))??;
    Ok(())
}

async fn validate_transfer_recipient(state: &AppState, auth: &AuthInfo, parameters: &Value) -> Result<(), AppError> {
    if auth.capabilities & crate::memory_contract::CAP_TRADE_EXECUTE == 0 {
        return Err(AppError::Forbidden("Trade capability is required for beneficiary-transfer acceptance".into()));
    }
    if !state.config.social_chain.is_configured() {
        return Err(AppError::Forbidden("Beneficiary-transfer acceptance is unavailable for this deployment".into()));
    }
    let fields = parameters.as_object().ok_or_else(|| bad("Beneficiary acceptance parameters must be an object"))?;
    if fields.len() != 1 || !fields.contains_key("beneficiaryId") {
        return Err(bad("Unexpected or missing beneficiary acceptance parameters"));
    }
    let beneficiary_id = id(parameters["beneficiaryId"].as_str().ok_or_else(|| bad("beneficiaryId is required"))?)
        .map_err(|_| bad("Invalid beneficiaryId"))?;
    let beneficiary = object(state, &beneficiary_id).await?;
    let expected_type = coin_type(&format!("{}::poc_username_beneficiary::PoCUsernameBeneficiary", state.config.package_id))?;
    if coin_type(beneficiary.pointer("/content/type").and_then(Value::as_str).ok_or_else(invalid)?)? != expected_type {
        return Err(AppError::BadRequest("The selected object is not a creator beneficiary".into()));
    }
    let object_fields = beneficiary.pointer("/content/fields").and_then(Value::as_object).ok_or_else(invalid)?;
    let claimed_by = object_fields.get("claimed_by").ok_or_else(invalid)?;
    let is_unclaimed = claimed_by.is_null()
        || claimed_by.pointer("/fields/vec").and_then(Value::as_array).is_some_and(Vec::is_empty);
    if u64_value(object_fields.get("status"))? != 1 || !is_unclaimed {
        return Err(AppError::Conflict("The creator beneficiary is no longer active and unclaimed".into()));
    }
    let key_type = format!("{}::poc_username_beneficiary::PendingBeneficiaryTransferKey", state.config.package_id);
    let value_type = format!("{}::poc_username_beneficiary::PendingBeneficiaryTransfer", state.config.package_id);
    let pending = rpc(state, "mysox_getDynamicFieldObject", json!([beneficiary_id,{"type":key_type,"value":{}}])).await?;
    let pending_fields = pending.pointer("/data/content/fields").and_then(Value::as_object)
        .ok_or_else(|| AppError::Conflict("No active recipient proposal exists for this beneficiary".into()))?;
    let expected_dynamic_type = coin_type(&format!("0x2::dynamic_field::Field<{key_type},{value_type}>"))?;
    if coin_type(pending.pointer("/data/content/type").and_then(Value::as_str).ok_or_else(invalid)?)? != expected_dynamic_type
        || !same(pending.pointer("/data/owner/ObjectOwner").and_then(Value::as_str).ok_or_else(invalid)?, &beneficiary_id) {
        return Err(AppError::Conflict("Pending beneficiary transfer evidence is invalid".into()));
    }
    let recipient = pending_fields.get("value").and_then(|value| value.pointer("/fields/recipient")).and_then(Value::as_str).ok_or_else(invalid)?;
    if !same(recipient, &auth.owner) {
        return Err(AppError::Forbidden("Only the wallet named as the pending transfer recipient can accept it".into()));
    }
    Ok(())
}
pub fn receipt_context(action: &str, p: &Value, owner: &str, platform: &str) -> Result<Option<Value>, AppError> {
    if action == ACCEPT_TRANSFER_ACTION {
        let fields = p.as_object().ok_or_else(|| bad("Beneficiary acceptance parameters must be an object"))?;
        if fields.len() != 1 || !fields.contains_key("beneficiaryId") {
            return Err(bad("Unexpected or missing beneficiary acceptance parameters"));
        }
        return Ok(Some(json!({
            "beneficiaryId": id(p["beneficiaryId"].as_str().ok_or_else(|| bad("beneficiaryId is required"))?).map_err(|_| bad("Invalid beneficiaryId"))?,
            "recipient": id(owner)?,
            "executionPlatformId": id(platform)?
        })));
    }
    if action != ACTION { return Ok(None); }
    let mut context = params(p)?;
    context["beneficiary"] = json!(id(owner)?);
    context["executionPlatformId"] = json!(id(platform)?);
    Ok(Some(context))
}

async fn acceptance_receipt(state: &AppState, auth: &AuthInfo, digest: &str) -> Result<Value, AppError> {
    digest_bytes(digest).map_err(|_| bad("Invalid beneficiary-transfer receipt digest"))?;
    let row = crate::chain_actions::get_by_digest(&state.db, &auth.account_id, &auth.agent_object_id, digest).await?
        .filter(|row| row.registry_action == ACCEPT_TRANSFER_ACTION && same(&row.package_id, &state.config.package_id))
        .ok_or_else(|| AppError::BlobNotFound("Beneficiary-transfer receipt is outside this account/agent scope".into()))?;
    let context = row.receipt_context.as_ref().ok_or_else(|| AppError::Conflict("Prepared beneficiary-transfer receipt context is unavailable".into()))?;
    let beneficiary_id = id(context.get("beneficiaryId").and_then(Value::as_str).ok_or_else(invalid)?)?;
    let recipient = id(context.get("recipient").and_then(Value::as_str).ok_or_else(invalid)?)?;
    if !same(&recipient, &auth.owner)
        || !same(context.get("executionPlatformId").and_then(Value::as_str).ok_or_else(invalid)?, &state.config.social_chain.platform_object_id) {
        return Err(AppError::BlobNotFound("Beneficiary-transfer receipt is outside this recipient or platform scope".into()));
    }
    let transaction = rpc(state, "myso_getTransactionBlock", json!([digest,{"showInput":true,"showEffects":true,"showEvents":true}])).await?;
    if transaction["digest"].as_str() != Some(digest) { return Err(invalid()); }
    let sender = transaction.pointer("/transaction/data/sender").or_else(|| transaction.pointer("/transaction/sender"))
        .and_then(Value::as_str).ok_or_else(invalid)?;
    if !same(sender, &recipient) || !same(sender, &row.sender) { return Err(AppError::Conflict("Acceptance sender does not match the proposed recipient".into())); }
    let status = transaction.pointer("/effects/status/status").and_then(Value::as_str);
    let checkpoint = transaction.get("checkpoint").filter(|v| !v.is_null());
    let finalized = status == Some("success") && checkpoint.is_some();
    let expected_event = coin_type(&format!("{}::proof_of_creativity::UsernameBeneficiaryTransferAcceptedEvent", state.config.package_id))?;
    let events = transaction.get("events").and_then(Value::as_array).ok_or_else(invalid)?;
    let matches_found: Vec<&Value> = events.iter().filter(|event| {
        let Ok(event_type) = coin_type(event.get("type").and_then(Value::as_str).unwrap_or("")) else { return false; };
        if event_type != expected_event { return false; }
        let Some(data) = event.get("parsedJson") else { return false; };
        data.get("beneficiary_id").and_then(Value::as_str).is_some_and(|v| same(v, &beneficiary_id))
            && data.get("recipient").and_then(Value::as_str).is_some_and(|v| same(v, &recipient))
    }).collect();
    if finalized && matches_found.len() != 1 { return Err(AppError::Conflict("Unique beneficiary-transfer acceptance event could not be verified".into())); }
    let mut result = json!({
        "digest": digest,
        "registryAction": ACCEPT_TRANSFER_ACTION,
        "status": match status { Some("success") if finalized => "finalized", Some("success") => "checkpoint_pending", Some("failure") => "failed", _ => "unknown" },
        "checkpoint": checkpoint.map(Value::to_string),
        "beneficiaryId": beneficiary_id,
        "recipient": recipient,
        "acceptance": matches_found.first().map(|event| *event),
        "evidenceSource": "configured_fullnode_and_scoped_preparation"
    });
    crate::platform_reads::decimal_quantities(&mut result);
    Ok(result)
}
async fn receipt(state: &AppState, auth: &AuthInfo, digest: &str) -> Result<Value, AppError> {
    digest_bytes(digest).map_err(|_| bad("Invalid creator-vault receipt digest"))?;
    let row = crate::chain_actions::get_by_digest(&state.db, &auth.account_id, &auth.agent_object_id, digest).await?
        .filter(|row| row.registry_action == ACTION && same(&row.package_id, &state.config.package_id))
        .ok_or_else(|| AppError::BlobNotFound("Creator-vault receipt is outside this account/agent scope".into()))?;
    let context = row.receipt_context.as_ref().ok_or_else(|| AppError::Conflict("Prepared creator-vault receipt context is unavailable".into()))?;
    if !same(context["beneficiary"].as_str().ok_or_else(invalid)?, &auth.owner)
        || !same(context["executionPlatformId"].as_str().ok_or_else(invalid)?, &state.config.social_chain.platform_object_id) {
        return Err(AppError::BlobNotFound("Creator-vault receipt is outside this principal or platform".into()));
    }
    let transaction = rpc(state, "myso_getTransactionBlock", json!([digest,{"showInput":true,"showEffects":true,"showEvents":true}])).await?;
    if transaction["digest"].as_str() != Some(digest) { return Err(invalid()); }
    let sender = transaction.pointer("/transaction/data/sender").or_else(|| transaction.pointer("/transaction/sender"))
        .and_then(Value::as_str).ok_or_else(invalid)?;
    if !same(sender, &auth.owner) || !same(sender, &row.sender) { return Err(AppError::Conflict("Claim sender does not match its approving principal".into())); }
    let status = transaction.pointer("/effects/status/status").and_then(Value::as_str);
    let checkpoint = transaction.get("checkpoint").filter(|v| !v.is_null());
    let finalized = status == Some("success") && checkpoint.is_some();
    let expected_event = coin_type(&format!("{}::proof_of_creativity::PoCBeneficiaryVaultClaimedEvent", state.config.package_id))?;
    let events = transaction.get("events").and_then(Value::as_array).ok_or_else(invalid)?;
    let mut matches = Vec::new();
    for event in events {
        if coin_type(event.get("type").and_then(Value::as_str).ok_or_else(invalid)?)? != expected_event { continue; }
        let data = event.get("parsedJson").ok_or_else(invalid)?;
        if same(data.get("vault_id").and_then(Value::as_str).ok_or_else(invalid)?, context["vaultId"].as_str().ok_or_else(invalid)?)
            && same(data.get("beneficiary").and_then(Value::as_str).ok_or_else(invalid)?, context["beneficiary"].as_str().ok_or_else(invalid)?)
            && named_coin(data.get("coin_type"))? == context["coinType"].as_str().ok_or_else(invalid)? {
            matches.push(data.clone());
        }
    }
    if finalized && matches.len() != 1 { return Err(AppError::Conflict("Unique creator-vault claim event could not be verified".into())); }
    let mut result = json!({"digest":digest,"registryAction":ACTION,"status":match status {Some("success") if finalized=>"finalized",Some("success")=>"checkpoint_pending",Some("failure")=>"failed",_=>"unknown"},"checkpoint":checkpoint.map(|v|v.to_string()),"claim":matches.first(),"evidenceSource":"configured_fullnode_and_scoped_preparation","currentVaultBalance":"not_checked"});
    if let Some(claim) = result.get_mut("claim").and_then(Value::as_object_mut) {
        for key in ["treasury_amount", "referrer_amount", "beneficiary_amount"] {
            let amount = claim.get(key).and_then(Value::as_number).map(ToString::to_string);
            if let Some(amount) = amount {
                claim.insert(key.to_owned(), Value::String(amount));
            }
        }
    }
    crate::platform_reads::decimal_quantities(&mut result);
    Ok(result)
}
pub async fn read(state: &Arc<AppState>, auth: &AuthInfo, resource: &str, id_value: Option<&str>) -> Result<Value, AppError> {
    match resource {
        "poc_claim_receipt" => receipt(state, auth, id_value.ok_or_else(|| bad("id is required"))?).await,
        "poc_beneficiary_transfer_receipt" => acceptance_receipt(state, auth, id_value.ok_or_else(|| bad("id is required"))?).await,
        _ => Err(bad("unknown creator-vault read resource")),
    }
}
