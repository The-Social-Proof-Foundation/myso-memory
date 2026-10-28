//! Owner-approved Orderbook v3 exact-input swaps, pinned to the live REST pool
//! catalog and fullnode object/coin state.
use crate::chain_reads::{address, coin_type, id, object, rpc, same, u64_value};
use crate::types::{AppError, AppState, AuthInfo};
use serde_json::{json, Value};

pub const ACTION: &str = "dex.swap.v1";
fn bad(message: &str) -> AppError { AppError::BadRequest(message.into()) }
fn invalid() -> AppError { AppError::Internal("Orderbook swap evidence is invalid or unavailable".into()) }
fn positive(v: &Value, name: &str) -> Result<u64, AppError> {
    let n = u64_value(Some(v)).map_err(|_| bad(&format!("{name} must be a positive u64 decimal string")))?;
    if n == 0 { return Err(bad(&format!("{name} must be positive"))); }
    Ok(n)
}
fn type_args(value: &str) -> Option<(String, String, String)> {
    let open = value.find('<')?;
    if !value.ends_with('>') { return None; }
    let root = &value[..open];
    let mut depth = 0i32;
    let mut split = None;
    for (i, c) in value[open + 1..value.len() - 1].char_indices() {
        match c { '<' => depth += 1, '>' => depth -= 1, ',' if depth == 0 => { split = Some(open + 1 + i); break; }, _ => {} }
    }
    let split = split?;
    Some((root.to_string(), value[open + 1..split].trim().to_string(), value[split + 1..value.len() - 1].trim().to_string()))
}
fn params(v: &Value) -> Result<Value, AppError> {
    let o = v.as_object().ok_or_else(|| bad("DEX swap parameters must be an object"))?;
    let allowed = ["poolId","poolName","orderbookPackageId","baseAssetType","quoteAssetType","direction","inputCoinId","amountInBaseUnits","minAmountOutBaseUnits","recipientAddress"];
    if o.len() != allowed.len() || o.keys().any(|k| !allowed.contains(&k.as_str())) { return Err(bad("Unexpected or missing DEX swap parameters")); }
    let text = |key: &str| v.get(key).and_then(Value::as_str).ok_or_else(|| bad(&format!("{key} is required")));
    let pool_name = text("poolName")?;
    if pool_name.is_empty() || pool_name.len() > 128 || !pool_name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b,b'_'|b'-'|b'.')) { return Err(bad("Invalid poolName")); }
    let direction = text("direction")?;
    if !["sell_base","buy_base"].contains(&direction) { return Err(bad("direction must be sell_base or buy_base")); }
    let base = coin_type(text("baseAssetType")?).map_err(|_| bad("Invalid baseAssetType"))?;
    let quote = coin_type(text("quoteAssetType")?).map_err(|_| bad("Invalid quoteAssetType"))?;
    Ok(json!({"poolId":id(text("poolId")?).map_err(|_|bad("Invalid poolId"))?,"poolName":pool_name,
      "orderbookPackageId":id(text("orderbookPackageId")?).map_err(|_|bad("Invalid orderbookPackageId"))?,
      "baseAssetType":base,"quoteAssetType":quote,"direction":direction,
      "inputCoinId":id(text("inputCoinId")?).map_err(|_|bad("Invalid inputCoinId"))?,
      "amountInBaseUnits":positive(v.get("amountInBaseUnits").ok_or_else(||bad("amountInBaseUnits is required"))?,"amountInBaseUnits")?.to_string(),
      "minAmountOutBaseUnits":positive(v.get("minAmountOutBaseUnits").ok_or_else(||bad("minAmountOutBaseUnits is required"))?,"minAmountOutBaseUnits")?.to_string(),
      "recipientAddress":id(text("recipientAddress")?).map_err(|_|bad("Invalid recipientAddress"))?}))
}
pub async fn validate_action(state: &AppState, auth: &AuthInfo, action: &str, input: &Value) -> Result<(), AppError> {
    if action != ACTION { return Ok(()); }
    if auth.capabilities & crate::memory_contract::CAP_TRADE_EXECUTE == 0 { return Err(AppError::Forbidden("Trade capability is required for DEX swaps".into())); }
    if !crate::platform_reads::orderbook_indexer_available(&state.config) { return Err(AppError::Forbidden("Orderbook Indexer is unavailable for this deployment".into())); }
    let p = params(input)?;
    if !same(p["recipientAddress"].as_str().ok_or_else(invalid)?, &auth.owner) { return Err(AppError::Forbidden("Swap outputs must return to the approving owner wallet".into())); }
    let catalog = crate::platform_reads::orderbook_markets(state).await?;
    let market = catalog.get("markets").and_then(Value::as_array).and_then(|rows| rows.iter().find(|m| m["poolName"].as_str() == p["poolName"].as_str())).ok_or_else(|| bad("poolName is not in the current Orderbook /get_pools catalog"))?;
    let pool_id = id(market["poolId"].as_str().ok_or_else(invalid)?)?;
    if !same(&pool_id, p["poolId"].as_str().ok_or_else(invalid)?) { return Err(AppError::Conflict("Selected pool no longer matches the current market catalog".into())); }
    let base = coin_type(market["baseAssetId"].as_str().ok_or_else(invalid)?)?;
    let quote = coin_type(market["quoteAssetId"].as_str().ok_or_else(invalid)?)?;
    if base != p["baseAssetType"] || quote != p["quoteAssetType"] { return Err(AppError::Conflict("Selected asset pair no longer matches the current market catalog".into())); }
    let pool = object(state, &pool_id).await?;
    if pool.pointer("/owner/Shared").is_none() { return Err(AppError::Forbidden("Orderbook pool is not a shared live pool".into())); }
    let pool_type = coin_type(pool.pointer("/content/type").and_then(Value::as_str).ok_or_else(invalid)?)?;
    let (package, actual_base, actual_quote) = type_args(&pool_type).filter(|(root,_,_)| root.ends_with("::pool::Pool")).ok_or_else(|| AppError::Conflict("Selected object is not an Orderbook v3 pool".into()))?;
    let package_id = id(package.split("::").next().ok_or_else(invalid)?)?;
    if package_id != id(p["orderbookPackageId"].as_str().ok_or_else(invalid)?)? || coin_type(&actual_base)? != base || coin_type(&actual_quote)? != quote { return Err(AppError::Conflict("Live pool type does not match the current market pair".into())); }
    let coin_id = p["inputCoinId"].as_str().ok_or_else(invalid)?;
    let coin = object(state, coin_id).await?;
    let expected_input = if p["direction"] == "sell_base" { &base } else { &quote };
    let expected_coin_type = coin_type(&format!("0x2::coin::Coin<{expected_input}>"))?;
    if !same(coin.pointer("/objectId").and_then(Value::as_str).ok_or_else(invalid)?, coin_id)
      || !same(&address(coin.pointer("/content/fields/id/id"))?, coin_id)
      || !same(&address(coin.pointer("/owner/AddressOwner"))?, &auth.owner)
      || coin_type(coin.pointer("/content/type").and_then(Value::as_str).ok_or_else(invalid)?)? != expected_coin_type { return Err(AppError::Forbidden("Exact input coin must be owned by the approving wallet and match the selected market side".into())); }
    let amount = positive(&p["amountInBaseUnits"], "amountInBaseUnits")?;
    if u64_value(coin.pointer("/content/fields/balance"))? < amount { return Err(bad("Input coin balance is below amountInBaseUnits")); }
    let lot = u64_value(market.get("lotSizeBaseUnits")).map_err(|_| invalid())?;
    let min_size = u64_value(market.get("minSizeBaseUnits")).map_err(|_| invalid())?;
    if lot == 0 { return Err(invalid()); }
    if p["direction"] == "sell_base" && (amount < min_size || amount % lot != 0) { return Err(bad("Sell amount must meet the catalog minimum and base-asset lot size")); }
    let min_out = positive(&p["minAmountOutBaseUnits"], "minAmountOutBaseUnits")?;
    if p["direction"] == "buy_base" && (min_out < min_size || min_out % lot != 0) { return Err(bad("Buy minimum output must meet the catalog minimum and base-asset lot size")); }
    Ok(())
}
pub fn receipt_context(p: &Value, owner: &str) -> Result<Value, AppError> {
    let p = params(p)?;
    Ok(json!({"poolId":p["poolId"],"poolName":p["poolName"],"packageId":p["orderbookPackageId"],"baseAssetType":p["baseAssetType"],"quoteAssetType":p["quoteAssetType"],"direction":p["direction"],"inputCoinId":p["inputCoinId"],"amountInBaseUnits":p["amountInBaseUnits"],"minAmountOutBaseUnits":p["minAmountOutBaseUnits"],"recipient":id(owner)?}))
}
pub async fn receipt(state: &AppState, auth: &AuthInfo, digest: &str) -> Result<Value, AppError> {
    let row = crate::chain_actions::get_by_digest(&state.db, &auth.account_id, &auth.agent_object_id, digest).await?.ok_or_else(|| AppError::BlobNotFound("Scoped DEX swap action was not found".into()))?;
    if row.registry_action != ACTION { return Err(AppError::Forbidden("Transaction is not a DEX swap action".into())); }
    let context = row.receipt_context.ok_or_else(invalid)?;
    let tx = rpc(state,"myso_getTransactionBlock",json!([digest,{"showInput":true,"showEffects":true,"showEvents":true}])).await?;
    let status = tx.pointer("/effects/status/status").and_then(Value::as_str);
    let checkpoint = tx.get("checkpoint").filter(|v|!v.is_null());
    let finalized = status == Some("success") && checkpoint.is_some();
    let sender = tx.pointer("/transaction/data/sender").and_then(Value::as_str).ok_or_else(invalid)?;
    if !same(sender, context["recipient"].as_str().unwrap_or("")) { return Err(AppError::Forbidden("Transaction sender differs from the scoped DEX approval".into())); }
    let package = context["packageId"].as_str().ok_or_else(invalid)?;
    let event_type = coin_type(&format!("{package}::order_info::OrderFilled"))?;
    let events = tx.get("events").and_then(Value::as_array).ok_or_else(invalid)?;
    let fills = events.iter().filter(|e| e.get("type").and_then(Value::as_str).and_then(|t|coin_type(t).ok()).as_deref()==Some(event_type.as_str()))
       .filter(|e| { let d=&e["parsedJson"]; same(d["pool_id"].as_str().unwrap_or(""),context["poolId"].as_str().unwrap_or("")) && d["taker_is_bid"].as_bool()==Some(context["direction"]=="buy_base") })
       .collect::<Vec<_>>();
    let output_key = if context["direction"] == "buy_base" { "base_quantity" } else { "quote_quantity" };
    let mut output = 0u128;
    let mut public_fills = Vec::new();
    for fill in &fills {
        let d = &fill["parsedJson"];
        let fill_amount = |key: &str| -> Result<String, AppError> {
            Ok(u64_value(d.get(key)).map_err(|_| invalid())?.to_string())
        };
        let n = fill_amount(output_key)?.parse::<u64>().map_err(|_| invalid())?;
        output = output.checked_add(n as u128).ok_or_else(invalid)?;
        public_fills.push(json!({
            "price": fill_amount("price")?,
            "baseQuantity": fill_amount("base_quantity")?,
            "quoteQuantity": fill_amount("quote_quantity")?,
            "takerFee": fill_amount("taker_fee")?,
            "takerFeeIsMyso": d.get("taker_fee_is_myso").and_then(Value::as_bool).ok_or_else(invalid)?,
        }));
    }
    let min_out=context["minAmountOutBaseUnits"].as_str().and_then(|v|v.parse::<u64>().ok()).ok_or_else(invalid)?;
    let verified = finalized && !fills.is_empty() && output >= min_out as u128;
    Ok(json!({"digest":digest,"registryAction":ACTION,"status":if status==Some("failure"){"failed"}else if verified{"finalized"}else if status==Some("success"){"checkpoint_pending_or_fill_unverified"}else{"unknown"},"finalized":finalized,"verified":verified,"checkpoint":checkpoint,"poolId":context["poolId"],"poolName":context["poolName"],"direction":context["direction"],"inputAmountBaseUnits":context["amountInBaseUnits"],"minimumOutputBaseUnits":min_out.to_string(),"actualOutputBaseUnits":output.to_string(),"outputAssetType":if context["direction"]=="buy_base"{&context["baseAssetType"]}else{&context["quoteAssetType"]},"fills":public_fills,"evidenceSource":"configured_fullnode_and_scoped_preparation"}))
}
