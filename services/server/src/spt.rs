//! Bounded SPT trade preparation. Automatic buys require live per-action MYSO
//! limits and an exact MYSO coin owned by the authenticated agent address.
use crate::chain_reads::{id, object, same, u64_value};
use crate::types::{AppError, AppState, AuthInfo};
use num_bigint::BigUint;
use serde_json::{json, Value};

pub const BUY_ACTION: &str = "spt.buy.v1";
pub const SELL_ACTION: &str = "spt.sell.v1";
const MYSO_COIN: &str = "0x2::myso::MYSO";

fn bad() -> AppError { AppError::BadRequest("Invalid SPT trade parameters".into()) }
fn evidence_error() -> AppError { AppError::Internal("SPT chain evidence is invalid or unavailable".into()) }
fn quote_error() -> AppError { AppError::BadRequest("Invalid SPT quote request or live pool data".into()) }
fn object_arg(p: &Value, name: &str) -> Result<String, AppError> {
    id(p.get(name).and_then(Value::as_str).ok_or_else(bad)?)
}
fn amount_arg(p: &Value, name: &str, allow_zero: bool) -> Result<u64, AppError> {
    let value = p.get(name).ok_or_else(bad)?;
    let amount = u64_value(Some(value)).map_err(|_| bad())?;
    if !allow_zero && amount == 0 { return Err(bad()); }
    Ok(amount)
}
fn scope(state: &AppState, auth: &AuthInfo) -> Result<(), AppError> {
    if auth.capabilities & crate::memory_contract::CAP_TRADE_EXECUTE == 0 {
        return Err(AppError::Forbidden("Trade capability is required for SPT actions".into()));
    }
    if !state.config.spt_trading_enabled || !state.config.social_chain.is_configured()
        || state.config.social_chain.spt_registry_id.is_empty()
        || state.config.social_chain.spt_config_id.is_empty()
        || state.config.social_chain.ecosystem_treasury_id.is_empty() {
        return Err(AppError::Forbidden("SPT actions are not configured for this deployment".into()));
    }
    for platform in [&auth.platform_scope, &auth.platform_id].into_iter().flatten() {
        if !same(platform, &state.config.social_chain.platform_object_id) {
            return Err(AppError::Forbidden("SPT action is outside this platform".into()));
        }
    }
    Ok(())
}
fn validate_vaults(p: &Value) -> Result<(), AppError> {
    let vaults = p.get("beneficiaryVaults").and_then(Value::as_array).ok_or_else(bad)?;
    if vaults.len() > 32 { return Err(bad()); }
    let mut seen = std::collections::HashSet::new();
    for vault in vaults {
        let fields = vault.as_object().ok_or_else(bad)?;
        if fields.len() != 2 || !fields.contains_key("vaultId") || !fields.contains_key("minDepositBaseUnits") { return Err(bad()); }
        let vault_id = object_arg(vault, "vaultId")?;
        if !seen.insert(vault_id) { return Err(bad()); }
        amount_arg(vault, "minDepositBaseUnits", false)?;
    }
    Ok(())
}
async fn verify_pool(state: &AppState, pool_id: &str) -> Result<(), AppError> {
    let pool = object(state, pool_id).await?;
    let expected = format!("{}::social_proof_tokens::TokenPool", state.config.package_id);
    if !same(pool.get("objectId").and_then(Value::as_str).ok_or_else(evidence_error)?, pool_id)
        || pool.pointer("/owner/Shared").is_none()
        || pool.pointer("/content/type").and_then(Value::as_str).is_none_or(|ty| !ty.eq_ignore_ascii_case(&expected))
        || !same(&id(pool.pointer("/content/fields/id/id").and_then(Value::as_str).ok_or_else(evidence_error)?)?, pool_id) {
        return Err(AppError::Forbidden("The selected SPT pool is not a live shared pool in this package".into()));
    }
    Ok(())
}

fn fields(value: &Value) -> Result<&Value, AppError> {
    value.get("fields").ok_or_else(evidence_error)
}

fn big_to_u64(value: &BigUint) -> Result<u64, AppError> {
    let digits = value.to_u64_digits();
    if digits.len() > 1 { return Err(quote_error()); }
    Ok(digits.first().copied().unwrap_or(0))
}

/// Mirrors reserve_myso_u256/curve_cost: the chain remains authoritative and
/// enforces state, fees, holdings and the caller's minimum output at execution.
fn reserve(quadratic: u64, launch_supply: u64, supply: u64) -> BigUint {
    let supply_big = BigUint::from(supply);
    if supply <= launch_supply { return supply_big; }
    let excess = BigUint::from(supply - launch_supply);
    let scale = BigUint::from(1_000_000_000u64);
    let denominator = BigUint::from(30_000u64) * &scale * &scale * &scale;
    let quad = BigUint::from(quadratic) * &excess * &excess * &excess / denominator;
    supply_big + quad
}

fn curve_cost(quadratic: u64, launch_supply: u64, supply: u64, amount: u64) -> Result<u64, AppError> {
    let after = supply.checked_add(amount).ok_or_else(quote_error)?;
    let before_reserve = reserve(quadratic, launch_supply, supply);
    let after_reserve = reserve(quadratic, launch_supply, after);
    big_to_u64(&(after_reserve - before_reserve))
}

fn quote_fee(amount: u64, bps: u64) -> Result<u64, AppError> {
    if bps > 10_000 { return Err(evidence_error()); }
    Ok(((amount as u128) * (bps as u128) / 10_000) as u64)
}

fn component_fee(amount: u64, component_bps: u64, total_bps: u64) -> Result<u64, AppError> {
    if total_bps == 0 { return Err(evidence_error()); }
    Ok(((amount as u128) * (component_bps as u128) / (total_bps as u128)) as u64)
}

fn escrow_beneficiaries(pool_fields: &Value, token_type: u64, creator_fee: u64) -> Result<Vec<String>, AppError> {
    if token_type != 2 || creator_fee == 0 { return Ok(Vec::new()); }
    let manifest_option = pool_fields.get("revenue_manifest").ok_or_else(evidence_error)?;
    let option_fields = fields(manifest_option)?;
    let manifests = option_fields.get("vec").and_then(Value::as_array).ok_or_else(evidence_error)?;
    if manifests.is_empty() { return Ok(Vec::new()); }
    if manifests.len() != 1 { return Err(evidence_error()); }
    let manifest_fields = fields(&manifests[0])?;
    let entries = manifest_fields.get("entries").and_then(Value::as_array).ok_or_else(evidence_error)?;
    let mut beneficiaries = Vec::new();
    for entry in entries {
        let entry = fields(entry)?;
        let share = u64_value(entry.get("share_bps"))?;
        let mode = u64_value(entry.get("payout_mode"))?;
        let slice = (creator_fee as u128) * (share as u128) / 10_000;
        if mode == 1 && slice > 0 {
            beneficiaries.push(id(entry.get("beneficiary").and_then(Value::as_str).ok_or_else(evidence_error)?)?);
        }
    }
    beneficiaries.sort();
    beneficiaries.dedup();
    Ok(beneficiaries)
}

pub async fn quote(state: &AppState, input: &crate::platform_reads::ReadQuery) -> Result<Value, AppError> {
    if !state.config.social_chain.is_configured() || state.config.social_chain.spt_config_id.is_empty() {
        return Err(AppError::Forbidden("SPT quote is not configured for this deployment".into()));
    }
    let pool_id = id(input.pool_id.as_deref().ok_or_else(quote_error)?)?;
    let kind = input.trade_kind.as_deref().ok_or_else(quote_error)?;
    if kind != "buy" && kind != "sell" { return Err(quote_error()); }
    let amount = input.amount_base_units.as_deref().ok_or_else(quote_error)?;
    if amount.is_empty() || amount.len() > 20 || !amount.bytes().all(|byte| byte.is_ascii_digit()) || amount.starts_with('0') {
        return Err(quote_error());
    }
    let amount: u64 = amount.parse().map_err(|_| quote_error())?;
    if amount == 0 { return Err(quote_error()); }

    let pool = object(state, &pool_id).await?;
    let expected_pool = format!("{}::social_proof_tokens::TokenPool", state.config.package_id);
    if !same(pool.get("objectId").and_then(Value::as_str).ok_or_else(evidence_error)?, &pool_id)
        || pool.pointer("/owner/Shared").is_none()
        || pool.pointer("/content/type").and_then(Value::as_str).is_none_or(|ty| !ty.eq_ignore_ascii_case(&expected_pool)) {
        return Err(AppError::Forbidden("The selected SPT pool is not a live shared pool in this package".into()));
    }
    let pool_fields = pool.pointer("/content/fields").ok_or_else(evidence_error)?;
    if !same(&id(pool_fields.pointer("/id/id").and_then(Value::as_str).ok_or_else(evidence_error)?)?, &pool_id) {
        return Err(evidence_error());
    }
    let info = fields(pool_fields.get("info").ok_or_else(evidence_error)?)?;
    let quadratic = u64_value(info.get("quadratic_coefficient"))?;
    let launch_supply = u64_value(info.get("launch_supply"))?;
    let supply = u64_value(info.get("circulating_supply"))?;
    let token_type = u64_value(info.get("token_type"))?;

    let config_id = id(&state.config.social_chain.spt_config_id)?;
    let config = object(state, &config_id).await?;
    let expected_config = format!("{}::social_proof_tokens::SocialProofTokensConfig", state.config.package_id);
    if !same(config.get("objectId").and_then(Value::as_str).ok_or_else(evidence_error)?, &config_id)
        || config.pointer("/content/type").and_then(Value::as_str).is_none_or(|ty| !ty.eq_ignore_ascii_case(&expected_config)) {
        return Err(evidence_error());
    }
    let config_fields = config.pointer("/content/fields").ok_or_else(evidence_error)?;
    if config_fields.get("trading_enabled").and_then(Value::as_bool) != Some(true) { return Err(AppError::Forbidden("SPT trading is currently disabled".into())); }
    let creator_bps = u64_value(config_fields.get("trading_creator_fee_bps"))?;
    let platform_bps = u64_value(config_fields.get("trading_platform_fee_bps"))?;
    let treasury_bps = u64_value(config_fields.get("trading_treasury_fee_bps"))?;
    let total_bps = creator_bps.checked_add(platform_bps).and_then(|value| value.checked_add(treasury_bps)).filter(|value| *value > 0 && *value <= 10_000).ok_or_else(evidence_error)?;

    let (curve, fee, creator_fee, output) = if kind == "buy" {
        let mut low = 0u64;
        let mut high = u64::MAX - supply;
        while low < high {
            let mid = low + (high - low) / 2 + 1;
            let affordable = curve_cost(quadratic, launch_supply, supply, mid)
                .ok().and_then(|cost| quote_fee(cost, total_bps).ok().and_then(|fee| cost.checked_add(fee)))
                .is_some_and(|all_in| all_in <= amount);
            if affordable { low = mid; } else { high = mid - 1; }
        }
        let curve = curve_cost(quadratic, launch_supply, supply, low)?;
        let fee = quote_fee(curve, total_bps)?;
        (curve, fee, component_fee(fee, creator_bps, total_bps)?, low)
    } else {
        if amount > supply { return Err(AppError::BadRequest("Sell amount exceeds live circulating supply".into())); }
        let before = reserve(quadratic, launch_supply, supply);
        let after = reserve(quadratic, launch_supply, supply - amount);
        let curve = big_to_u64(&(before - after))?;
        let fee = quote_fee(curve, total_bps)?;
        let creator_fee = component_fee(fee, creator_bps, total_bps)?;
        (curve, fee, creator_fee, curve.checked_sub(fee).ok_or_else(quote_error)?)
    };
    let beneficiaries = escrow_beneficiaries(pool_fields, token_type, creator_fee)?;
    Ok(json!({
        "kind": kind,
        "poolId": pool_id,
        "inputBaseUnits": amount.to_string(),
        "outputBaseUnits": output.to_string(),
        "curveBaseUnits": curve.to_string(),
        "feeBaseUnits": fee.to_string(),
        "creatorFeeBaseUnits": creator_fee.to_string(),
        "totalTradingFeeBps": total_bps,
        "currentSupplyBaseUnits": supply.to_string(),
        "requiredEscrowBeneficiaries": beneficiaries,
        "evidence": "latest_configured_fullnode_object_state",
        "executionAuthority": "indicative_only_move_rechecks_live_state_and_minimum_output"
    }))
}
pub async fn validate_action(state: &AppState, auth: &AuthInfo, action: &str, p: &Value) -> Result<(), AppError> {
    if action != BUY_ACTION && action != SELL_ACTION { return Ok(()); }
    scope(state, auth)?;
    let fields = p.as_object().ok_or_else(bad)?;
    validate_vaults(p)?;
    let pool_id = object_arg(p, "poolId")?;
    verify_pool(state, &pool_id).await?;
    if action == BUY_ACTION {
        let names = ["poolId", "paymentCoinId", "paymentAmountBaseUnits", "minTokensBaseUnits", "beneficiaryVaults"];
        if fields.len() != names.len() || fields.keys().any(|key| !names.contains(&key.as_str())) { return Err(bad()); }
        let payment_id = object_arg(p, "paymentCoinId")?;
        let amount = amount_arg(p, "paymentAmountBaseUnits", false)?;
        let funder = if auth.owner_co_signed { &auth.owner } else { &auth.derived_address };
        if !auth.owner_co_signed {
            let cap = auth.max_action_spend.filter(|value| *value > 0).ok_or_else(|| AppError::Forbidden("Automatic SPT buys require a live nonzero agent spend cap".into()))?;
            if amount > cap { return Err(AppError::Forbidden("SPT buy exceeds the agent's live MYSO spend cap".into())); }
        }
        amount_arg(p, "minTokensBaseUnits", true)?;
        let coin = object(state, &payment_id).await?;
        let details = crate::payments::coin_details(&coin, &payment_id, funder, MYSO_COIN)?;
        if u64_value(details.get("balanceBaseUnits"))? < amount { return Err(AppError::Forbidden("The selected agent-owned MYSO coin does not cover this SPT buy".into())); }
    } else {
        let names = ["poolId", "tokenObjectId", "amountBaseUnits", "minReceiveBaseUnits", "beneficiaryVaults"];
        if fields.len() != names.len() || fields.keys().any(|key| !names.contains(&key.as_str())) { return Err(bad()); }
        let token_id = object_arg(p, "tokenObjectId")?;
        let amount = amount_arg(p, "amountBaseUnits", false)?;
        amount_arg(p, "minReceiveBaseUnits", true)?;
        let token = object(state, &token_id).await?;
        let token_owner = if auth.owner_co_signed { &auth.owner } else { &auth.derived_address };
        let expected = format!("{}::social_proof_tokens::SocialToken", state.config.package_id);
        if !same(token.get("objectId").and_then(Value::as_str).ok_or_else(evidence_error)?, &token_id)
            || !same(&id(token.pointer("/owner/AddressOwner").and_then(Value::as_str).ok_or_else(evidence_error)?)?, token_owner)
            || token.pointer("/content/type").and_then(Value::as_str).is_none_or(|ty| !ty.eq_ignore_ascii_case(&expected))
            || !same(&id(token.pointer("/content/fields/pool_id").and_then(Value::as_str).ok_or_else(evidence_error)?)?, &pool_id)
            || amount > u64_value(token.pointer("/content/fields/amount"))? {
            return Err(AppError::Forbidden("The selected SPT object is not an owned token for this pool or does not cover the sell amount".into()));
        }
    }
    Ok(())
}

/// Approval requests pin terms before the owner chooses whether to sign. They may
/// reference either the agent's coin or the owner's coin, and intentionally do not
/// apply the automatic agent spend cap; execution revalidates with owner signature.
pub async fn validate_approval_request(state: &AppState, auth: &AuthInfo, action: &str, p: &Value) -> Result<(), AppError> {
    if action != BUY_ACTION && action != SELL_ACTION { return Ok(()); }
    scope(state, auth)?;
    validate_vaults(p)?;
    let pool_id = object_arg(p, "poolId")?;
    verify_pool(state, &pool_id).await?;
    if action == BUY_ACTION {
        let fields = p.as_object().ok_or_else(bad)?;
        let names = ["poolId", "paymentCoinId", "paymentAmountBaseUnits", "minTokensBaseUnits", "beneficiaryVaults"];
        if fields.len() != names.len() || fields.keys().any(|key| !names.contains(&key.as_str())) { return Err(bad()); }
        let coin_id = object_arg(p, "paymentCoinId")?;
        let amount = amount_arg(p, "paymentAmountBaseUnits", false)?;
        amount_arg(p, "minTokensBaseUnits", true)?;
        let coin = object(state, &coin_id).await?;
        let details = crate::payments::coin_details(&coin, &coin_id, &auth.owner, MYSO_COIN)
            .or_else(|_| crate::payments::coin_details(&coin, &coin_id, &auth.derived_address, MYSO_COIN))?;
        if u64_value(details.get("balanceBaseUnits"))? < amount { return Err(AppError::Forbidden("The selected MYSO coin does not cover this SPT buy".into())); }
    } else {
        let fields = p.as_object().ok_or_else(bad)?;
        let names = ["poolId", "tokenObjectId", "amountBaseUnits", "minReceiveBaseUnits", "beneficiaryVaults"];
        if fields.len() != names.len() || fields.keys().any(|key| !names.contains(&key.as_str())) { return Err(bad()); }
        let token_id = object_arg(p, "tokenObjectId")?;
        let amount = amount_arg(p, "amountBaseUnits", false)?;
        amount_arg(p, "minReceiveBaseUnits", true)?;
        let token = object(state, &token_id).await?;
        let expected = format!("{}::social_proof_tokens::SocialToken", state.config.package_id);
        let owner = id(token.pointer("/owner/AddressOwner").and_then(Value::as_str).ok_or_else(evidence_error)?)?;
        if !same(&owner, &auth.owner) && !same(&owner, &auth.derived_address) { return Err(AppError::Forbidden("The selected SPT token is not owned by this account".into())); }
        if !same(token.get("objectId").and_then(Value::as_str).ok_or_else(evidence_error)?, &token_id)
            || token.pointer("/content/type").and_then(Value::as_str).is_none_or(|ty| !ty.eq_ignore_ascii_case(&expected))
            || !same(&id(token.pointer("/content/fields/pool_id").and_then(Value::as_str).ok_or_else(evidence_error)?)?, &pool_id)
            || amount > u64_value(token.pointer("/content/fields/amount"))? {
            return Err(AppError::Forbidden("The selected SPT object does not match the requested sell".into()));
        }
    }
    Ok(())
}
pub fn receipt_context(action: &str, p: &Value, owner: &str, sender: &str, platform: &str) -> Result<Option<Value>, AppError> {
    if action != BUY_ACTION && action != SELL_ACTION { return Ok(None); }
    let mut context = json!({"tradeKind": if action == BUY_ACTION {"buy"} else {"sell"},
        "poolId":id(&object_arg(p,"poolId")?)?,"owner":id(owner)?,"sender":id(sender)?,"executionPlatformId":id(platform)?});
    if action == BUY_ACTION {
        context["paymentCoinId"] = json!(id(&object_arg(p,"paymentCoinId")?)?);
        context["paymentAmountBaseUnits"] = json!(amount_arg(p,"paymentAmountBaseUnits",false)?.to_string());
        context["minTokensBaseUnits"] = json!(amount_arg(p,"minTokensBaseUnits",true)?.to_string());
    } else {
        context["tokenObjectId"] = json!(id(&object_arg(p,"tokenObjectId")?)?);
        context["amountBaseUnits"] = json!(amount_arg(p,"amountBaseUnits",false)?.to_string());
        context["minReceiveBaseUnits"] = json!(amount_arg(p,"minReceiveBaseUnits",true)?.to_string());
    }
    Ok(Some(context))
}

pub async fn receipt(state: &AppState, auth: &AuthInfo, digest: &str) -> Result<Value, AppError> {
    use crate::chain_reads::{coin_type, digest_bytes, rpc};
    digest_bytes(digest).map_err(|_| AppError::BadRequest("Invalid SPT receipt digest".into()))?;
    let row = crate::chain_actions::get_by_digest(&state.db, &auth.account_id, &auth.agent_object_id, digest).await?
        .filter(|row| (row.registry_action == BUY_ACTION || row.registry_action == SELL_ACTION) && same(&row.package_id, &state.config.package_id))
        .ok_or_else(|| AppError::BlobNotFound("SPT receipt is outside this account/agent scope".into()))?;
    let context = row.receipt_context.as_ref().ok_or_else(|| AppError::Conflict("Prepared SPT trade context is unavailable".into()))?;
    if !same(context["owner"].as_str().ok_or_else(evidence_error)?, &auth.owner)
        || !same(context["executionPlatformId"].as_str().ok_or_else(evidence_error)?, &state.config.social_chain.platform_object_id) {
        return Err(AppError::BlobNotFound("SPT receipt is outside this principal or platform".into()));
    }
    let transaction = rpc(state, "myso_getTransactionBlock", json!([digest,{"showInput":true,"showEffects":true,"showEvents":true}])).await?;
    if transaction["digest"].as_str() != Some(digest) { return Err(evidence_error()); }
    let sender = transaction.pointer("/transaction/data/sender").or_else(|| transaction.pointer("/transaction/sender"))
        .and_then(Value::as_str).ok_or_else(evidence_error)?;
    if !same(sender, context["sender"].as_str().ok_or_else(evidence_error)?) || !same(sender, &row.sender) { return Err(AppError::Conflict("SPT trade sender does not match its prepared transaction".into())); }
    let status = transaction.pointer("/effects/status/status").and_then(Value::as_str);
    let checkpoint = transaction.get("checkpoint").filter(|value| !value.is_null());
    let finalized = status == Some("success") && checkpoint.is_some();
    let events = transaction.get("events").and_then(Value::as_array).ok_or_else(evidence_error)?;
    let trade_name = if row.registry_action == BUY_ACTION { "TokenBoughtEvent" } else { "TokenSoldEvent" };
    let trade_type = coin_type(&format!("{}::social_proof_tokens::{trade_name}", state.config.package_id))?;
    let settle_type = coin_type(&format!("{}::social_proof_tokens::TokenCreatorFeeSettledEvent", state.config.package_id))?;
    let matching = events.iter().filter(|event| event.get("type").and_then(Value::as_str).and_then(|value| coin_type(value).ok()).as_deref() == Some(trade_type.as_str()))
        .filter(|event| {
            let data = &event["parsedJson"];
            same(data["id"].as_str().unwrap_or(""), context["poolId"].as_str().unwrap_or(""))
                && if row.registry_action == BUY_ACTION {
                    same(data["buyer"].as_str().unwrap_or(""), sender)
                        && u64_value(data.get("amount")).ok().is_some_and(|amount| amount >= u64_value(context.get("minTokensBaseUnits")).unwrap_or(u64::MAX))
                        && u64_value(data.get("myso_amount")).ok().is_some_and(|amount| amount <= u64_value(context.get("paymentAmountBaseUnits")).unwrap_or(0))
                } else {
                    same(data["seller"].as_str().unwrap_or(""), sender)
                        && u64_value(data.get("amount")).ok() == u64_value(context.get("amountBaseUnits")).ok()
                        && u64_value(data.get("myso_amount")).ok().zip(u64_value(data.get("fee_amount")).ok()).is_some_and(|(gross,fee)| gross.saturating_sub(fee) >= u64_value(context.get("minReceiveBaseUnits")).unwrap_or(u64::MAX))
                }
        }).collect::<Vec<_>>();
    let settlements = events.iter().filter(|event| event.get("type").and_then(Value::as_str).and_then(|value| coin_type(value).ok()).as_deref() == Some(settle_type.as_str()))
        .filter(|event| same(event.pointer("/parsedJson/pool_id").and_then(Value::as_str).unwrap_or(""), context["poolId"].as_str().unwrap_or(""))
            && same(event.pointer("/parsedJson/trader").and_then(Value::as_str).unwrap_or(""), sender)).collect::<Vec<_>>();
    if finalized && (matching.len() != 1 || settlements.len() != 1) {
        return Err(AppError::Conflict("Unique exact SPT trade and creator-fee settlement events could not be verified".into()));
    }
    Ok(json!({"digest":digest,"registryAction":row.registry_action,"status":match status {Some("success") if finalized=>"finalized",Some("success")=>"checkpoint_pending",Some("failure")=>"failed",_=>"unknown"},
        "checkpoint":checkpoint.map(Value::to_string),"trade":matching.first().map(|event|&event["parsedJson"]),"creatorFeeSettlement":settlements.first().map(|event|&event["parsedJson"]),"evidenceSource":"configured_fullnode_and_scoped_preparation"}))
}
