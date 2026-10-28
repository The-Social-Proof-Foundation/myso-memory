//! Fixed owner-wallet coin transfer resolver and historical object-effect receipts.
//! No generic programmable-call, RPC URL, signer, or owner parameter is accepted.
use crate::chain_reads::{address, coin_type, digest_bytes, id, object, rpc, same, u64_value};
use crate::types::{AppError, AppState, AuthInfo, Config};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{collections::HashSet, sync::Arc};

pub const ACTION: &str = "payments.send_token.v1";
pub fn configured(config: &Config) -> bool {
    config.token_transfers_enabled && config.social_chain.is_configured()
}
fn bad(message: &str) -> AppError {
    AppError::BadRequest(message.into())
}
fn invalid() -> AppError {
    AppError::Internal("Coin chain evidence is invalid or unavailable".into())
}
fn request_scope(state: &AppState, auth: &AuthInfo) -> Result<(), AppError> {
    if auth.capabilities & crate::memory_contract::CAP_TRADE_EXECUTE == 0 {
        return Err(AppError::Forbidden(
            "Trade capability is required for owner-wallet coin operations".into(),
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
                "Coin operation is outside this platform".into(),
            ));
        }
    }
    Ok(())
}
fn quantity(value: Option<&Value>) -> Result<String, AppError> {
    let string = value
        .and_then(Value::as_str)
        .ok_or_else(|| bad("amountBaseUnits must be a positive decimal u64 string"))?;
    let amount = u64_value(Some(&json!(string))).map_err(|_| bad("Invalid transfer amount"))?;
    if amount == 0 {
        return Err(bad("Transfer amount must be positive"));
    }
    Ok(amount.to_string())
}
fn requested_type(value: &str) -> Result<String, AppError> {
    coin_type(value).map_err(|_| bad("coinType must be a complete bounded Move struct tag"))
}
fn parameters(p: &Value) -> Result<Value, AppError> {
    let fields = p
        .as_object()
        .ok_or_else(|| bad("Transfer parameters must be an object"))?;
    let names = ["paymentCoinId", "recipient", "coinType", "amountBaseUnits"];
    if fields.len() != names.len() || fields.keys().any(|key| !names.contains(&key.as_str())) {
        return Err(bad("Unexpected or missing transfer parameters"));
    }
    Ok(
        json!({"paymentCoinId":address(p.get("paymentCoinId"))?,"recipient":address(p.get("recipient"))?,
        "coinType":requested_type(p["coinType"].as_str().ok_or_else(||bad("coinType is required"))?)?,
        "amountBaseUnits":quantity(p.get("amountBaseUnits"))?}),
    )
}
pub(crate) fn coin_details(
    data: &Value,
    object_id: &str,
    owner: &str,
    currency: &str,
) -> Result<Value, AppError> {
    if !same(data["objectId"].as_str().ok_or_else(invalid)?, object_id)
        || !same(&address(data.pointer("/content/fields/id/id"))?, object_id)
        || !same(&address(data.pointer("/owner/AddressOwner"))?, owner)
        || coin_type(
            data.pointer("/content/type")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?,
        )? != coin_type(&format!("0x2::coin::Coin<{currency}>"))?
    {
        return Err(AppError::Forbidden(
            "The exact coin is not owned by the approving wallet or has another type".into(),
        ));
    }
    Ok(
        json!({"coinObjectId":id(object_id)?,"coinType":coin_type(currency)?,
        "balanceBaseUnits":u64_value(data.pointer("/content/fields/balance"))?.to_string(),
        "version":u64_value(data.get("version"))?.to_string()}),
    )
}
async fn quote(state: &AppState, auth: &AuthInfo, p: &Value) -> Result<Value, AppError> {
    let p = parameters(p)?;
    if same(p["recipient"].as_str().unwrap(), &auth.owner) {
        return Err(bad("Self-transfers are not supported by this action"));
    }
    let coin_id = p["paymentCoinId"].as_str().unwrap();
    let data = object(state, coin_id).await?;
    let coin = coin_details(&data, coin_id, &auth.owner, p["coinType"].as_str().unwrap())?;
    if u64_value(coin.get("balanceBaseUnits"))? < u64_value(p.get("amountBaseUnits"))? {
        return Err(bad("Funding coin balance is below the exact amount"));
    }
    Ok(
        json!({"transferParameters":p,"fundingCoin":coin,"approvingOwner":id(&auth.owner)?,
        "evidenceSource":"configured_fullnode","writesEnabled":configured(&state.config),"fundingModel":"owned_coin_objects",
        "approval":"owner_wallet","quoteLocksFunds":false}),
    )
}
pub async fn validate_action(
    state: &AppState,
    auth: &AuthInfo,
    action: &str,
    p: &Value,
) -> Result<(), AppError> {
    if action != ACTION {
        return Ok(());
    }
    request_scope(state, auth)?;
    if !configured(&state.config) {
        return Err(AppError::Forbidden(
            "Token transfers are disabled for this deployment".into(),
        ));
    }
    tokio::time::timeout(std::time::Duration::from_secs(25), quote(state, auth, p))
        .await
        .map_err(|_| AppError::Internal("Transfer validation exceeded its read budget".into()))??;
    Ok(())
}
pub fn receipt_context(p: &Value, owner: &str, platform: &str) -> Result<Option<Value>, AppError> {
    let mut context = parameters(p)?;
    context["approvingOwner"] = json!(id(owner)?);
    context["executionPlatformId"] = json!(id(platform)?);
    Ok(Some(context))
}

/// Decode exactly 32 canonical base58 bytes, including leading zero bytes.
/// Also used to identify native address-balance reservation placeholders.
fn amount128(value: Option<&Value>) -> Result<String, AppError> {
    let value = value.and_then(Value::as_str).ok_or_else(invalid)?;
    if value.is_empty()
        || (value != "0" && value.starts_with('0'))
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(invalid());
    }
    Ok(value.parse::<u128>().map_err(|_| invalid())?.to_string())
}
fn cursor(value: &str, currency: &str) -> Result<(u64, String), AppError> {
    if value.is_empty() || value.len() > 2048 {
        return Err(bad("Invalid coin cursor"));
    }
    let bytes = STANDARD
        .decode(value)
        .map_err(|_| bad("Invalid coin cursor"))?;
    if STANDARD.encode(&bytes) != value {
        return Err(bad("Noncanonical coin cursor"));
    }
    let data: Value = serde_json::from_slice(&bytes).map_err(|_| bad("Invalid coin cursor"))?;
    let fields = data.as_object().ok_or_else(|| bad("Invalid coin cursor"))?;
    if fields.len() != 3
        || fields
            .keys()
            .any(|key| !["coin_type", "inverted_balance", "object_id"].contains(&key.as_str()))
        || coin_type(data["coin_type"].as_str().ok_or_else(invalid)?)? != currency
    {
        return Err(bad("Coin cursor belongs to another currency"));
    }
    Ok((
        u64_value(data.get("inverted_balance"))?,
        address(data.get("object_id"))?,
    ))
}
fn coin_page(
    result: &Value,
    currency: &str,
    input_cursor: Option<&str>,
    limit: usize,
) -> Result<Value, AppError> {
    let rows = result["data"].as_array().ok_or_else(invalid)?;
    if rows.len() > limit {
        return Err(invalid());
    }
    let mut previous = input_cursor
        .map(|value| cursor(value, currency))
        .transpose()?;
    let mut ids = HashSet::new();
    let mut data = Vec::new();
    let mut excluded = 0;
    for coin in rows {
        if coin_type(coin["coinType"].as_str().ok_or_else(invalid)?)? != currency {
            return Err(invalid());
        }
        let object_id = address(coin.get("coinObjectId"))?;
        let amount = u64_value(coin.get("balance"))?;
        let position = (u64::MAX - amount, object_id.clone());
        if !ids.insert(object_id.clone())
            || previous
                .as_ref()
                .is_some_and(|previous| position <= *previous)
        {
            return Err(invalid());
        }
        previous = Some(position);
        let digest = coin["digest"].as_str().ok_or_else(invalid)?;
        if digest_bytes(digest)?[12..] == [0xacu8; 20] {
            excluded += 1;
            continue;
        }
        digest_bytes(coin["previousTransaction"].as_str().ok_or_else(invalid)?)?;
        data.push(json!({"coinObjectId":object_id,"coinType":currency,"balanceBaseUnits":amount.to_string(),
            "version":u64_value(coin.get("version"))?.to_string(),"digest":digest,"previousTransaction":coin["previousTransaction"]}));
    }
    let has_next = result["hasNextPage"].as_bool().ok_or_else(invalid)?;
    let next = match result.get("nextCursor") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => Some(value.as_str()),
        _ => return Err(invalid()),
    };
    if has_next && (rows.is_empty() || next.is_none() || next == input_cursor) {
        return Err(invalid());
    }
    if let Some(next) = next {
        if Some(cursor(next, currency)?) != previous {
            return Err(invalid());
        }
    }
    Ok(
        json!({"data":data,"hasNextPage":has_next,"nextCursor":if has_next {next} else {None},
        "excludedAddressBalanceReservations":excluded,"fundingModel":"owned_coin_objects"}),
    )
}

/// A split-and-transfer creates one fresh Coin<T>. Net balance changes alone
/// cannot prove its amount when the recipient is also the gas sponsor.
fn created_coin(transaction: &Value, context: &Value, sender: &str) -> Result<Value, AppError> {
    if !same(
        transaction
            .pointer("/transaction/data/sender")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?,
        sender,
    ) || !same(
        context["approvingOwner"].as_str().ok_or_else(invalid)?,
        sender,
    ) {
        return Err(invalid());
    }
    let expected = coin_type(&format!(
        "0x2::coin::Coin<{}>",
        context["coinType"].as_str().ok_or_else(invalid)?
    ))?;
    let changes = transaction["objectChanges"]
        .as_array()
        .ok_or_else(invalid)?;
    let mut matches = Vec::new();
    for change in changes {
        if change["type"] != "created" {
            continue;
        }
        if coin_type(change["objectType"].as_str().ok_or_else(invalid)?)? != expected {
            continue;
        }
        if !same(
            &address(change.pointer("/owner/AddressOwner"))?,
            context["recipient"].as_str().ok_or_else(invalid)?,
        ) || !same(change["sender"].as_str().ok_or_else(invalid)?, sender)
        {
            continue;
        }
        let object_id = address(change.get("objectId"))?;
        let version = u64_value(change.get("version"))?.to_string();
        let digest = change["digest"].as_str().ok_or_else(invalid)?;
        digest_bytes(digest)?;
        matches.push(json!({"objectId":object_id,"version":version,"digest":digest}));
    }
    if matches.len() != 1 {
        return Err(AppError::Conflict(
            "Exact transferred coin effect could not be verified".into(),
        ));
    }
    Ok(matches.remove(0))
}
fn historical_coin(
    result: &Value,
    created: &Value,
    context: &Value,
    digest: &str,
) -> Result<Value, AppError> {
    if result["status"] != "VersionFound" {
        return Err(AppError::Conflict(
            "Historical transferred coin version is unavailable; reconcile this receipt".into(),
        ));
    }
    let data = &result["details"];
    let coin = coin_details(
        data,
        created["objectId"].as_str().ok_or_else(invalid)?,
        context["recipient"].as_str().ok_or_else(invalid)?,
        context["coinType"].as_str().ok_or_else(invalid)?,
    )?;
    if data["digest"] != created["digest"]
        || coin["version"] != created["version"]
        || coin["balanceBaseUnits"] != context["amountBaseUnits"]
        || data["previousTransaction"].as_str() != Some(digest)
    {
        return Err(AppError::Conflict(
            "Historical coin amount/version does not match the prepared transfer".into(),
        ));
    }
    Ok(
        json!({"coinObjectId":created["objectId"],"version":created["version"],"objectDigest":created["digest"],
        "recipient":context["recipient"],"coinType":context["coinType"],"amountBaseUnits":context["amountBaseUnits"],
        "proof":"created_coin_at_effect_version","currentOwnership":"not_checked"}),
    )
}
fn historical_read_params(created: &Value) -> Result<Value, AppError> {
    // The core read API's SequenceNumber is a JSON u64, not a response-style string.
    Ok(
        json!([created["objectId"],u64_value(created.get("version"))?,{"showContent":true,"showOwner":true,"showPreviousTransaction":true}]),
    )
}
async fn receipt(state: &AppState, auth: &AuthInfo, digest: &str) -> Result<Value, AppError> {
    digest_bytes(digest).map_err(|_| bad("Invalid transfer transaction digest"))?;
    let row = crate::chain_actions::get_by_digest(
        &state.db,
        &auth.account_id,
        &auth.agent_object_id,
        digest,
    )
    .await?
    .filter(|row| row.registry_action == ACTION && same(&row.package_id, &state.config.package_id))
    .ok_or_else(|| AppError::BlobNotFound("Transfer is outside this account/agent scope".into()))?;
    let context = row
        .receipt_context
        .as_ref()
        .ok_or_else(|| AppError::Conflict("Prepared transfer context is unavailable".into()))?;
    if !same(
        context["executionPlatformId"]
            .as_str()
            .ok_or_else(invalid)?,
        &state.config.social_chain.platform_object_id,
    ) {
        return Err(AppError::BlobNotFound(
            "Transfer is outside this platform".into(),
        ));
    }
    let transaction = rpc(
        state,
        "myso_getTransactionBlock",
        json!([digest,{"showInput":true,"showEffects":true,"showObjectChanges":true}]),
    )
    .await?;
    if transaction["digest"].as_str() != Some(digest) {
        return Err(invalid());
    }
    let checkpoint = transaction
        .get("checkpoint")
        .filter(|value| !value.is_null())
        .map(|value| u64_value(Some(value)))
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
    let transfer = if matches!(status, "finalized" | "executed") {
        let created = created_coin(&transaction, context, &row.sender)?;
        let historical = rpc(
            state,
            "myso_tryGetPastObject",
            historical_read_params(&created)?,
        )
        .await?;
        Some(historical_coin(&historical, &created, context, digest)?)
    } else {
        None
    };
    Ok(
        json!({"digest":digest,"registryAction":ACTION,"accountId":auth.account_id,"agentId":auth.agent_object_id,
        "status":status,"checkpoint":checkpoint.map(|value|value.to_string()),"transfer":transfer,
        "preparedContext":context,"evidenceSource":"configured_fullnode_and_scoped_preparation"}),
    )
}
pub async fn read(
    state: &Arc<AppState>,
    auth: &AuthInfo,
    resource: &str,
    q: &crate::platform_reads::ReadQuery,
) -> Result<Value, AppError> {
    request_scope(state, auth)?;
    tokio::time::timeout(
        std::time::Duration::from_secs(28),
        read_inner(state, auth, resource, q),
    )
    .await
    .map_err(|_| AppError::Internal("Coin read exceeded its read budget".into()))?
}
fn validate_query(resource: &str, q: &crate::platform_reads::ReadQuery) -> Result<(), AppError> {
    let allowed: &[&str] = match resource {
        "payments_quote" => &["id", "coinType", "recipient", "amountBaseUnits"],
        "payments_coins" => &["coinType", "cursor", "limit"],
        "payments_balance" => &["coinType"],
        "payments_receipt" => &["id"],
        _ => return Err(AppError::BlobNotFound("Unsupported coin resource".into())),
    };
    for (name, present) in [
        ("id", q.id.is_some()),
        ("coinType", q.coin_type.is_some()),
        ("recipient", q.recipient.is_some()),
        ("amountBaseUnits", q.amount_base_units.is_some()),
        ("cursor", q.cursor.is_some()),
        ("limit", q.limit.is_some()),
        ("offset", q.offset.is_some()),
        ("address", q.address.is_some()),
        ("role", q.role.is_some()),
        ("status", q.status.is_some()),
        ("serviceId", q.service_id.is_some()),
        ("planId", q.plan_id.is_some()),
    ] {
        if present && !allowed.contains(&name) {
            return Err(bad("Unexpected coin query parameter"));
        }
    }
    Ok(())
}
async fn read_inner(
    state: &AppState,
    auth: &AuthInfo,
    resource: &str,
    q: &crate::platform_reads::ReadQuery,
) -> Result<Value, AppError> {
    validate_query(resource, q)?;
    let required = |value: Option<&str>| {
        value
            .map(str::to_owned)
            .ok_or_else(|| bad("A required coin query value is missing"))
    };
    if resource == "payments_receipt" {
        return receipt(state, auth, &required(q.id.as_deref())?).await;
    }
    let currency = requested_type(&required(q.coin_type.as_deref())?)?;
    match resource {
        "payments_quote"=>quote(state,auth,&json!({"paymentCoinId":required(q.id.as_deref())?,"coinType":currency,
            "recipient":required(q.recipient.as_deref())?,"amountBaseUnits":required(q.amount_base_units.as_deref())?})).await,
        "payments_coins"=>{
            let limit=q.limit.unwrap_or(20);if !(1..=50).contains(&limit) {return Err(bad("Coin limit must be between 1 and 50"));}
            if let Some(value)=q.cursor.as_deref() {cursor(value,&currency)?;}
            let result=rpc(state,"mysox_getCoins",json!([id(&auth.owner)?,currency,q.cursor,limit])).await?;
            let mut page=coin_page(&result,&currency,q.cursor.as_deref(),limit as usize)?;
            page["approvingOwner"]=json!(id(&auth.owner)?);page["evidenceSource"]=json!("configured_fullnode");Ok(page)
        },
        "payments_balance"=>{
            let balance=rpc(state,"mysox_getBalance",json!([id(&auth.owner)?,currency])).await?;
            if coin_type(balance["coinType"].as_str().ok_or_else(invalid)?)?!=currency {return Err(invalid());}
            let total=amount128(balance.get("totalBalance"))?;
            let address_balance=match balance.get("fundsInAddressBalance") {Some(value)=>amount128(Some(value))?,None=>"0".into()};
            if address_balance.parse::<u128>().unwrap()>total.parse::<u128>().unwrap() {return Err(invalid());}
            Ok(json!({"approvingOwner":id(&auth.owner)?,"coinType":currency,"totalBalanceBaseUnits":total,
                "fundsInAddressBalanceBaseUnits":address_balance,"coinObjectCount":u64_value(balance.get("coinObjectCount"))?.to_string(),
                "transferFundingModel":"owned_coin_objects","evidenceSource":"configured_fullnode"}))
        },
        _=>Err(AppError::BlobNotFound("Unsupported coin resource".into()))
    }
}

/// Enumerate only the authenticated agent's native MYSO coin objects for a
/// bounded MyData purchase. Owner funding coins are exposed through the separate
/// payments reader and are never substituted for this agent-funded path.
pub async fn read_agent_mydata_funding_coins(
    state: &AppState,
    auth: &AuthInfo,
    q: &crate::platform_reads::ReadQuery,
) -> Result<Value, AppError> {
    read_agent_funding_coins(state, auth, q, crate::memory_contract::CAP_MYDATA_READ, "MyData purchase capability is required", "a bounded MyData purchase").await
}

pub async fn read_agent_task_funding_coins(
    state: &AppState,
    auth: &AuthInfo,
    q: &crate::platform_reads::ReadQuery,
) -> Result<Value, AppError> {
    read_agent_funding_coins(state, auth, q, crate::memory_contract::CAP_TASK_TRADE, "Task Marketplace capability is required", "a bounded task offer").await
}

async fn read_agent_funding_coins(
    state: &AppState,
    auth: &AuthInfo,
    q: &crate::platform_reads::ReadQuery,
    required_capability: u64,
    capability_message: &str,
    purpose: &str,
) -> Result<Value, AppError> {
    if auth.capabilities & required_capability == 0 {
        return Err(AppError::Forbidden(capability_message.into()));
    }
    if q.address.is_some() || q.id.is_some() || q.coin_type.is_some() || q.recipient.is_some()
        || q.amount_base_units.is_some() || q.offset.is_some() || q.member.is_some()
    {
        return Err(bad("Unexpected agent funding-coin query parameter"));
    }
    let limit = q.limit.unwrap_or(20);
    if !(1..=50).contains(&limit) { return Err(bad("Coin limit must be between 1 and 50")); }
    let currency = requested_type("0x2::myso::MYSO")?;
    if let Some(value) = q.cursor.as_deref() { cursor(value, &currency)?; }
    let agent = id(&auth.derived_address)?;
    let result = rpc(state, "mysox_getCoins", json!([agent, currency, q.cursor, limit])).await?;
    let mut page = coin_page(&result, &currency, q.cursor.as_deref(), limit as usize)?;
    page["agentAddress"] = json!(agent);
    page["maxActionSpendMist"] = json!(auth.max_action_spend.map(|limit| limit.to_string()));
    page["evidenceSource"] = json!("configured_fullnode");
    page["notice"] = json!(format!("These are the authenticated agent's own MYSO coin objects. A live registered-action check enforces current on-chain capability, approval policy and per-action spend limit when {purpose} is prepared."));
    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::*;
    const DIGEST: &str = "11111111111111111111111111111111";
    const RESERVED: &str = "1111111111113QXbS2JhjXfRix46R7vSecDcsvio";
    fn params() -> Value {
        json!({"paymentCoinId":"0x1","recipient":"0x2","coinType":"0x3::coin::USD","amountBaseUnits":"9007199254740993"})
    }
    fn context() -> Value {
        receipt_context(&params(), "0x4", "0x5").unwrap().unwrap()
    }
    fn created() -> Value {
        json!({"objectId":id("0x6").unwrap(),"version":"18446744073709551615","digest":DIGEST})
    }
    fn historical() -> Value {
        json!({"status":"VersionFound","details":{
            "objectId":"0x6","version":"18446744073709551615","digest":DIGEST,"previousTransaction":DIGEST,
            "owner":{"AddressOwner":"0x2"},"content":{"type":"0x2::coin::Coin<0x3::coin::USD>","fields":{"id":{"id":"0x6"},"balance":"9007199254740993"}}
        }})
    }
    fn page_cursor(balance: u64, object_id: &str) -> String {
        STANDARD.encode(serde_json::to_vec(&json!({"coin_type":"0x3::coin::USD","inverted_balance":u64::MAX-balance,"object_id":id(object_id).unwrap()})).unwrap())
    }
    fn listed(balance: &str, object_id: &str, digest: &str) -> Value {
        json!({"coinType":"0x3::coin::USD","coinObjectId":object_id,"balance":balance,"digest":digest,"previousTransaction":DIGEST,"version":"9007199254740993"})
    }
    #[test]
    fn exact_context_has_no_arbitrary_body_or_rounded_amounts() {
        let context = context();
        assert_eq!(context["amountBaseUnits"], "9007199254740993");
        assert_eq!(context.as_object().unwrap().len(), 6);
        let mut p = params();
        p["amountBaseUnits"] = json!(9007199254740993u64);
        assert!(parameters(&p).is_err());
        p = params();
        p["amountBaseUnits"] = json!("18446744073709551616");
        assert!(parameters(&p).is_err());
        p = params();
        p["target"] = json!("arbitrary::transfer");
        assert!(parameters(&p).is_err());
    }
    #[test]
    fn historical_receipt_checks_exact_currency_recipient_amount_and_creation_version() {
        assert_eq!(
            historical_coin(&historical(), &created(), &context(), DIGEST).unwrap()
                ["amountBaseUnits"],
            "9007199254740993"
        );
        for (pointer, value) in [
            ("/details/content/fields/balance", json!("9007199254740992")),
            ("/details/owner/AddressOwner", json!("0x9")),
            (
                "/details/content/type",
                json!("0x2::coin::Coin<0x3::coin::OTHER>"),
            ),
            ("/details/version", json!("1")),
            ("/details/previousTransaction", json!("other")),
        ] {
            let mut h = historical();
            *h.pointer_mut(pointer).unwrap() = value;
            assert!(historical_coin(&h, &created(), &context(), DIGEST).is_err());
        }
        assert!(historical_coin(
            &json!({"status":"VersionNotFound"}),
            &created(),
            &context(),
            DIGEST
        )
        .is_err());
        // Core SequenceNumber input is a JSON integer; no JS conversion occurs.
        let rpc = historical_read_params(&created()).unwrap();
        assert_eq!(rpc[1].as_u64(), Some(u64::MAX));
        assert!(!rpc[1].is_string());
    }
    #[test]
    fn recipient_effect_must_be_unique_and_signed_by_the_prepared_owner() {
        let c = context();
        let effect = json!({"type":"created","sender":"0x4","owner":{"AddressOwner":"0x2"},"objectType":"0x2::coin::Coin<0x3::coin::USD>","objectId":"0x6","version":"18446744073709551615","digest":DIGEST});
        let mut tx =
            json!({"transaction":{"data":{"sender":"0x4"}},"objectChanges":[effect.clone()]});
        assert_eq!(created_coin(&tx, &c, "0x4").unwrap(), created());
        tx["objectChanges"] = json!([effect.clone(), effect]);
        assert!(created_coin(&tx, &c, "0x4").is_err());
        tx["transaction"]["data"]["sender"] = json!("0x9");
        assert!(created_coin(&tx, &c, "0x4").is_err());
    }
    #[test]
    fn canonical_digest_recognizes_native_reservations() {
        assert_eq!(digest_bytes(DIGEST).unwrap(), [0u8; 32]);
        assert_eq!(digest_bytes(RESERVED).unwrap()[12..], [0xacu8; 20]);
        assert!(digest_bytes("0").is_err());
        assert!(digest_bytes(&"1".repeat(44)).is_err());
    }
    #[test]
    fn raw_coin_cursors_preserve_progress_across_filtered_reservations() {
        let currency = coin_type("0x3::coin::USD").unwrap();
        let next = page_cursor(9, "0x2");
        let result = json!({"data":[listed("10","0x1",RESERVED),listed("9","0x2",DIGEST)],"hasNextPage":true,"nextCursor":next});
        let page = coin_page(&result, &currency, None, 20).unwrap();
        assert_eq!(page["data"].as_array().unwrap().len(), 1);
        assert_eq!(page["excludedAddressBalanceReservations"], 1);
        assert_eq!(page["nextCursor"], next);
        assert!(coin_page(&result, &currency, Some(&next), 20).is_err());
        let mut wrong = result.clone();
        wrong["nextCursor"] = json!(page_cursor(8, "0x3"));
        assert!(coin_page(&wrong, &currency, None, 20).is_err());
        assert!(cursor(&next, &coin_type("0x3::coin::OTHER").unwrap()).is_err());
        assert!(coin_page(
            &json!({"data":[],"hasNextPage":true,"nextCursor":next}),
            &currency,
            None,
            20
        )
        .is_err());
    }
    #[test]
    fn balance_totals_preserve_u128_and_query_filters_cannot_override_identity() {
        assert_eq!(
            amount128(Some(&json!(u128::MAX.to_string()))).unwrap(),
            u128::MAX.to_string()
        );
        assert!(amount128(Some(&json!("340282366920938463463374607431768211456"))).is_err());
        let q: crate::platform_reads::ReadQuery =
            serde_json::from_value(json!({"coinType":"0x3::coin::USD","recipient":"0x2"})).unwrap();
        assert!(validate_query("payments_balance", &q).is_err());
        assert!(
            serde_json::from_value::<crate::platform_reads::ReadQuery>(json!({"owner":"0x9"}))
                .is_err()
        );
    }
}
