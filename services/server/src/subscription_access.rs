//! Fixed fullnode resolvers for owner-approved subscriptions. No caller-selected
//! endpoints/owners; amounts retain the explicit coin type and exact base units.
use crate::chain_reads::{address, coin_type, id, object, rpc, same, u64_value};
use crate::types::{AppError, AppState, AuthInfo, Config};
use futures::{stream, StreamExt, TryStreamExt};
use serde_json::{json, Map, Value};
use std::sync::Arc;

pub const ACTIONS: [&str; 6] = [
    "subscription.subscribe_to_plan.v1",
    "subscription.renew_subscription.v1",
    "subscription.cancel_subscription.v1",
    "subscription.enable_auto_renew.v1",
    "subscription.disable_auto_renew.v1",
    "subscription.change_service_payment_recipient.v1",
];
pub fn is_action(action: &str) -> bool {
    ACTIONS.contains(&action)
}
pub fn configured(c: &Config) -> bool {
    c.subscription_actions_enabled
        && !c.social_chain.subscription_config_id.is_empty()
        && !c.social_chain.ecosystem_treasury_id.is_empty()
        && c.social_chain.is_configured()
}
fn request_platform(state: &AppState, auth: &AuthInfo) -> Result<(), AppError> {
    for platform in [&auth.platform_scope, &auth.platform_id]
        .into_iter()
        .flatten()
    {
        if !same(platform, &state.config.social_chain.platform_object_id) {
            return Err(AppError::Forbidden(
                "Subscription request is outside the configured platform".into(),
            ));
        }
    }
    Ok(())
}
fn scope_allows(auth: &AuthInfo, platform: Option<&Value>) -> bool {
    match (
        auth.platform_scope.as_deref(),
        platform.and_then(Value::as_str),
    ) {
        (Some(scope), Some(platform)) => same(scope, platform),
        _ => true,
    }
}
fn invalid() -> AppError {
    AppError::Internal("Subscription chain data is invalid or unavailable".into())
}
fn bad(message: &str) -> AppError {
    AppError::BadRequest(message.into())
}
fn optional_id(v: Option<&Value>) -> Result<Option<String>, AppError> {
    match v {
        Some(Value::Null) => Ok(None),
        Some(v) => address(Some(v)).map(Some),
        None => Err(invalid()),
    }
}
fn optional_u64(v: Option<&Value>) -> Result<Option<String>, AppError> {
    match v {
        Some(Value::Null) => Ok(None),
        Some(v) => Ok(Some(u64_value(Some(v))?.to_string())),
        None => Err(invalid()),
    }
}

/// Native TypeName strings omit address prefixes; normalize those and RPC type tags
/// with the same bounded grammar as the SDK, including generic coin types.
fn named_coin(v: Option<&Value>) -> Result<String, AppError> {
    coin_type(
        v.and_then(|v| v.pointer("/fields/name").or_else(|| v.get("name")))
            .and_then(Value::as_str)
            .ok_or_else(invalid)?,
    )
}
fn fields<'a>(
    data: &'a Value,
    package: &str,
    name: &str,
) -> Result<&'a Map<String, Value>, AppError> {
    let expected = coin_type(&format!("{package}::subscription::{name}"))?;
    if coin_type(
        data.pointer("/content/type")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?,
    )? != expected
    {
        return Err(invalid());
    }
    data.pointer("/content/fields")
        .and_then(Value::as_object)
        .ok_or_else(invalid)
}
async fn service(state: &AppState, service_id: &str) -> Result<Value, AppError> {
    let data = object(state, service_id).await?;
    fields(
        &data,
        &state.config.package_id,
        "ProfileSubscriptionService",
    )?;
    Ok(data)
}
async fn service_payment_recipient(state: &AppState, service_id: &str, data: &Value) -> Result<String, AppError> {
    let f = fields(data, &state.config.package_id, "ProfileSubscriptionService")?;
    let owner = address(f.get("profile_owner"))?;
    let key = format!("{}::subscription::ServicePaymentRecipientKey", state.config.package_id);
    let dynamic = rpc(state, "mysox_getDynamicFieldObject", json!([service_id,{"type":key,"value":{}}])).await?;
    if missing_dynamic_field(&dynamic, service_id)? {
        return Ok(owner);
    }
    let value = dynamic_value(&dynamic, service_id, &key, "address")?;
    address(value.get("value"))
}
fn table_id(fields: &Map<String, Value>, name: &str) -> Result<String, AppError> {
    address(fields.get(name).and_then(|v| v.pointer("/fields/id/id")))
}
fn dynamic_value<'a>(
    result: &'a Value,
    parent: &str,
    name_type: &str,
    value_type: &str,
) -> Result<&'a Map<String, Value>, AppError> {
    let data = result.get("data").ok_or_else(invalid)?;
    let expected = format!("0x2::dynamic_field::Field<{name_type},{value_type}>");
    if coin_type(
        data.pointer("/content/type")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?,
    )? != coin_type(&expected)?
        || address(data.pointer("/owner/ObjectOwner"))? != id(parent)?
    {
        return Err(invalid());
    }
    data.pointer("/content/fields")
        .and_then(Value::as_object)
        .ok_or_else(invalid)
}
fn terms_from_plan(
    dynamic: &Value,
    parent: &str,
    package: &str,
    plan_id: &str,
    owner: &str,
) -> Result<(Value, bool), AppError> {
    let fields = dynamic_value(
        dynamic,
        parent,
        "0x2::object::ID",
        &format!("{package}::subscription::SubscriptionPlan"),
    )?;
    if address(fields.get("name"))? != id(plan_id)? {
        return Err(invalid());
    }
    let p = fields
        .get("value")
        .and_then(|v| v.get("fields"))
        .and_then(Value::as_object)
        .ok_or_else(invalid)?;
    let price = u64_value(p.get("price"))?;
    let duration = u64_value(p.get("duration_ms"))?;
    if price == 0 || duration == 0 {
        return Err(invalid());
    }
    let mut terms = json!({"planId":id(plan_id)?,"expectedProfileOwner":id(owner)?,"coinType":named_coin(p.get("coin_type"))?,"priceBaseUnits":price.to_string(),"durationMs":duration.to_string()});
    if let Some(tier) = optional_u64(p.get("tier_level"))? {
        terms["tierLevel"] = json!(tier);
    }
    if let Some(platform) = optional_id(p.get("platform_id"))? {
        terms["planPlatformId"] = json!(platform);
    }
    Ok((
        terms,
        p.get("active")
            .and_then(Value::as_bool)
            .ok_or_else(invalid)?,
    ))
}
fn plan_metadata(dynamic: &Value) -> Result<Value, AppError> {
    fn preview(value: &str, limit: usize) -> Value {
        let total = value.chars().count();
        json!({"text":value.chars().take(limit).collect::<String>(),"totalCharacters":total,"truncated":total>limit,"unit":"unicode_scalar"})
    }
    let fields = dynamic
        .pointer("/data/content/fields/value/fields")
        .and_then(Value::as_object)
        .ok_or_else(invalid)?;
    let title = fields
        .get("title")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    let description = match fields.get("description") {
        Some(Value::Null) => Value::Null,
        Some(Value::String(text)) => preview(text, 1024),
        _ => return Err(invalid()),
    };
    Ok(
        json!({"title":preview(title,256),"description":description,"source":"seller_supplied_on_chain"}),
    )
}
pub async fn plan_quote(
    state: &AppState,
    service_id: &str,
    plan_id: &str,
) -> Result<Value, AppError> {
    let data = service(state, service_id).await?;
    let f = fields(
        &data,
        &state.config.package_id,
        "ProfileSubscriptionService",
    )?;
    let table = table_id(f, "plans")?;
    let plan = rpc(
        state,
        "mysox_getDynamicFieldObject",
        json!([table,{"type":"0x2::object::ID","value":id(plan_id)?}]),
    )
    .await?;
    let (terms, active) = terms_from_plan(
        &plan,
        &table,
        &state.config.package_id,
        plan_id,
        &address(f.get("profile_owner"))?,
    )?;
    let payout_recipient = service_payment_recipient(state, service_id, &data).await?;
    let config = object(state, &state.config.social_chain.subscription_config_id).await?;
    let limits = fields(&config, &state.config.package_id, "SubscriptionConfig")?;
    Ok(
        json!({"serviceId":id(service_id)?,"serviceObjectVersion":u64_value(data.get("version"))?.to_string(),"paymentRecipient":payout_recipient,"terms":terms,"planMetadata":plan_metadata(&plan)?,"planActive":active,"serviceActive":f.get("active").and_then(Value::as_bool).ok_or_else(invalid)?,"maxRenewalPeriods":u64_value(limits.get("max_renewal_months"))?.to_string(),"deploymentEnabled":configured(&state.config),"quotedAtMs":chrono::Utc::now().timestamp_millis(),"source":"configured_fullnode","atomicTermsPinnedAtExecution":true}),
    )
}
fn subscription_metadata(data: &Value, package: &str, owner: &str) -> Result<Value, AppError> {
    let f = fields(data, package, "ProfileSubscription")?;
    let subscriber = address(f.get("subscriber"))?;
    if !same(&subscriber, owner) || !same(&address(data.pointer("/owner/AddressOwner"))?, owner) {
        return Err(AppError::BlobNotFound(
            "Subscription is outside this owner scope".into(),
        ));
    }
    Ok(
        json!({"subscriptionId":address(data.get("objectId"))?,"serviceId":address(f.get("service_id"))?,"planId":address(f.get("plan_id"))?,"subscriber":subscriber,"coinType":named_coin(f.get("coin_type"))?,"createdAtMs":u64_value(f.get("created_at"))?.to_string(),"expiresAtMs":u64_value(f.get("expires_at"))?.to_string(),"renewalCount":u64_value(f.get("renewal_count"))?.to_string(),"autoRenew":f.get("auto_renew").and_then(Value::as_bool).ok_or_else(invalid)?,"tierLevel":optional_u64(f.get("tier_level"))?,"planPlatformId":optional_id(f.get("platform_id"))?,"objectVersion":u64_value(data.get("version"))?.to_string(),"renewalBalanceBaseUnits":null,"balanceRead":false}),
    )
}
fn missing_dynamic_field(response: &Value, parent: &str) -> Result<bool, AppError> {
    if response.pointer("/error/code").and_then(Value::as_str) != Some("dynamicFieldNotFound") {
        return Ok(false);
    }
    if !same(
        &address(response.pointer("/error/parent_object_id"))?,
        parent,
    ) {
        return Err(invalid());
    }
    Ok(true)
}
async fn owned_subscription(
    state: &AppState,
    auth: &AuthInfo,
    subscription_id: &str,
    with_balance: bool,
) -> Result<Value, AppError> {
    let data = object(state, subscription_id).await?;
    let mut result = subscription_metadata(&data, &state.config.package_id, &auth.owner)?;
    if !scope_allows(auth, result.get("planPlatformId")) {
        return Err(AppError::BlobNotFound(
            "Subscription is outside this platform scope".into(),
        ));
    }
    if with_balance {
        let bag = table_id(
            fields(&data, &state.config.package_id, "ProfileSubscription")?,
            "renewal_balances",
        )?;
        let coin = result["coinType"].as_str().ok_or_else(invalid)?;
        let key = format!(
            "{}::subscription::RenewalBalanceKey<{coin}>",
            state.config.package_id
        );
        let dynamic = rpc(
            state,
            "mysox_getDynamicFieldObject",
            json!([bag,{"type":key,"value":{}}]),
        )
        .await?;
        let balance = if missing_dynamic_field(&dynamic, &bag)? {
            0
        } else {
            u64_value(
                dynamic_value(
                    &dynamic,
                    &bag,
                    &key,
                    &format!("0x2::balance::Balance<{coin}>"),
                )?
                .get("value"),
            )?
        };
        result["renewalBalanceBaseUnits"] = json!(balance.to_string());
        result["balanceRead"] = json!(true);
        result["balanceObservedAtMs"] = json!(chrono::Utc::now().timestamp_millis());
    }
    Ok(result)
}
fn supplied_terms_equal(a: &Value, b: &Value) -> Result<bool, AppError> {
    let mut a = a
        .as_object()
        .cloned()
        .ok_or_else(|| bad("Subscription terms must be an object"))?;
    let mut b = b.as_object().cloned().ok_or_else(invalid)?;
    for key in ["planId", "expectedProfileOwner", "planPlatformId"] {
        for map in [&mut a, &mut b] {
            if let Some(v) = map.get(key) {
                map.insert(key.into(), json!(address(Some(v))?));
            }
        }
    }
    for map in [&mut a, &mut b] {
        map.insert(
            "coinType".into(),
            json!(coin_type(
                map.get("coinType")
                    .and_then(Value::as_str)
                    .ok_or_else(invalid)?
            )?),
        );
    }
    Ok(a == b)
}
pub async fn validate_action(
    state: &AppState,
    auth: &AuthInfo,
    action: &str,
    p: &Value,
) -> Result<(), AppError> {
    if !is_action(action) {
        return Ok(());
    }
    tokio::time::timeout(
        std::time::Duration::from_secs(25),
        validate_action_inner(state, auth, action, p),
    )
    .await
    .map_err(|_| AppError::Internal("Subscription validation exceeded its read budget".into()))?
}
async fn validate_action_inner(
    state: &AppState,
    auth: &AuthInfo,
    action: &str,
    p: &Value,
) -> Result<(), AppError> {
    if !is_action(action) {
        return Ok(());
    }
    request_platform(state, auth)?;
    if !configured(&state.config) {
        return Err(AppError::Forbidden(
            "Subscription actions are not enabled for this deployment".into(),
        ));
    }
    let p = p
        .as_object()
        .ok_or_else(|| bad("Subscription parameters must be an object"))?;
    let allowed: &[&str] = match action {
        "subscription.subscribe_to_plan.v1" => &[
            "serviceId",
            "paymentCoinId",
            "terms",
            "autoRenew",
            "renewalPeriods",
            "platformObjectId",
        ],
        "subscription.renew_subscription.v1" => &[
            "serviceId",
            "subscriptionId",
            "paymentCoinId",
            "terms",
            "platformObjectId",
        ],
        "subscription.cancel_subscription.v1" => &["serviceId", "subscriptionId", "coinType"],
        "subscription.change_service_payment_recipient.v1" => &["serviceId", "newRecipient"],
        _ => &["serviceId", "subscriptionId"],
    };
    if p.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err(bad("Unexpected subscription parameter"));
    }
    let service_id = address(p.get("serviceId"))?;
    let sub = if action != "subscription.subscribe_to_plan.v1" && action != "subscription.change_service_payment_recipient.v1" {
        let sub =
            owned_subscription(state, auth, &address(p.get("subscriptionId"))?, false).await?;
        if sub["serviceId"].as_str() != Some(service_id.as_str()) {
            return Err(bad("Subscription service does not match"));
        }
        Some(sub)
    } else {
        None
    };
    if let Some(platform) = p.get("platformObjectId") {
        if !same(
            &address(Some(platform))?,
            &state.config.social_chain.platform_object_id,
        ) {
            return Err(AppError::Forbidden(
                "Subscription platform is outside this deployment".into(),
            ));
        }
    }
    if matches!(
        action,
        "subscription.subscribe_to_plan.v1" | "subscription.renew_subscription.v1"
    ) {
        let terms = p
            .get("terms")
            .ok_or_else(|| bad("Exact quoted terms are required"))?;
        let plan_id = address(terms.get("planId"))?;
        if sub
            .as_ref()
            .is_some_and(|sub| sub["planId"].as_str() != Some(plan_id.as_str()))
        {
            return Err(bad("Renewal terms describe another subscription plan"));
        }
        let quote = plan_quote(state, &service_id, &plan_id).await?;
        if action == "subscription.subscribe_to_plan.v1"
            && !scope_allows(auth, quote["terms"].get("planPlatformId"))
        {
            return Err(AppError::Forbidden(
                "Subscription plan is outside this agent's platform".into(),
            ));
        }
        if !supplied_terms_equal(terms, &quote["terms"])? {
            return Err(AppError::Conflict("Subscription quote changed".into()));
        }
        let mut total = u64_value(terms.get("priceBaseUnits"))?;
        if action == "subscription.subscribe_to_plan.v1" {
            if quote["serviceActive"] != true || quote["planActive"] != true {
                return Err(bad("This plan is not accepting new subscribers"));
            }
            let auto = p
                .get("autoRenew")
                .and_then(Value::as_bool)
                .ok_or_else(|| bad("autoRenew must be explicit"))?;
            let periods = p
                .get("renewalPeriods")
                .filter(|v| v.is_string())
                .ok_or_else(|| bad("renewalPeriods must be an exact decimal string"))?;
            let periods = u64_value(Some(periods))?;
            if (!auto && periods != 0)
                || (auto && periods > u64_value(quote.get("maxRenewalPeriods"))?)
            {
                return Err(bad("Renewal periods exceed the plan configuration"));
            }
            total = total
                .checked_mul(
                    periods
                        .checked_add(1)
                        .ok_or_else(|| bad("Subscription total exceeds u64"))?,
                )
                .ok_or_else(|| bad("Subscription total exceeds u64"))?;
        } else if coin_type(
            sub.as_ref().unwrap()["coinType"]
                .as_str()
                .ok_or_else(invalid)?,
        )? != coin_type(terms["coinType"].as_str().ok_or_else(invalid)?)?
        {
            return Err(bad("Subscription coin type does not match the plan"));
        }
        let coin = object(state, &address(p.get("paymentCoinId"))?).await?;
        if !same(&address(coin.pointer("/owner/AddressOwner"))?, &auth.owner) {
            return Err(AppError::Forbidden(
                "The payment coin is not owned by the approving wallet".into(),
            ));
        }
        let expected = format!(
            "0x2::coin::Coin<{}>",
            coin_type(terms["coinType"].as_str().ok_or_else(invalid)?)?
        );
        if coin_type(
            coin.pointer("/content/type")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?,
        )? != coin_type(&expected)?
            || u64_value(coin.pointer("/content/fields/balance"))? < total
        {
            return Err(bad(
                "Payment coin type or balance does not cover the exact quote",
            ));
        }
    } else {
        let service_data = service(state, &service_id).await?;
        if action == "subscription.change_service_payment_recipient.v1" {
            let f = fields(&service_data, &state.config.package_id, "ProfileSubscriptionService")?;
            if !same(&address(f.get("profile_owner"))?, &auth.owner) {
                return Err(AppError::Forbidden("Only the profile owner can change the service payment recipient".into()));
            }
            let recipient = address(p.get("newRecipient"))?;
            if recipient == "0x0" || recipient == "0x0000000000000000000000000000000000000000000000000000000000000000" {
                return Err(bad("The new payment recipient cannot be the zero address"));
            }
            if same(&service_payment_recipient(state, &service_id, &service_data).await?, &recipient) {
                return Err(bad("The new payment recipient is already active"));
            }
        }
        if action == "subscription.cancel_subscription.v1"
            && coin_type(
                p.get("coinType")
                    .and_then(Value::as_str)
                    .ok_or_else(invalid)?,
            )? != coin_type(
                sub.as_ref().unwrap()["coinType"]
                    .as_str()
                    .ok_or_else(invalid)?,
            )?
        {
            return Err(bad(
                "Cancellation coin type does not match the subscription",
            ));
        }
    }
    Ok(())
}

/// Store only public on-chain receipt context, atomically with prepared bytes.
/// No transcript, signing key or arbitrary action body is retained here.
pub fn receipt_context(action: &str, p: &Value, platform: &str) -> Result<Option<Value>, AppError> {
    if !is_action(action) {
        return Ok(None);
    }
    let mut out =
        json!({"serviceId":address(p.get("serviceId"))?,"executionPlatformId":id(platform)?});
    if action == "subscription.subscribe_to_plan.v1" {
        out["autoRenew"] = json!(p
            .get("autoRenew")
            .and_then(Value::as_bool)
            .ok_or_else(invalid)?);
    }
    if action == "subscription.change_service_payment_recipient.v1" {
        out["newRecipient"] = json!(address(p.get("newRecipient"))?);
        return Ok(Some(out));
    }
    if action != "subscription.subscribe_to_plan.v1" {
        out["subscriptionId"] = json!(address(p.get("subscriptionId"))?);
    }
    if let Some(terms) = p.get("terms") {
        out["coinType"] = json!(coin_type(
            terms
                .get("coinType")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?
        )?);
        out["planId"] = json!(address(terms.get("planId"))?);
        out["profileOwner"] = json!(address(terms.get("expectedProfileOwner"))?);
        out["priceBaseUnits"] = json!(u64_value(terms.get("priceBaseUnits"))?.to_string());
        out["durationMs"] = json!(u64_value(terms.get("durationMs"))?.to_string());
        let periods = if action == "subscription.subscribe_to_plan.v1" {
            u64_value(p.get("renewalPeriods"))?
        } else {
            0
        };
        out["prepaidRenewalPeriods"] = json!(periods.to_string());
        out["totalCommittedBaseUnits"] = json!(u64_value(terms.get("priceBaseUnits"))?
            .checked_mul(periods.checked_add(1).ok_or_else(invalid)?)
            .ok_or_else(invalid)?
            .to_string());
    } else if action == "subscription.cancel_subscription.v1" {
        out["coinType"] = json!(coin_type(
            p.get("coinType")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?
        )?);
    }
    if action == "subscription.enable_auto_renew.v1"
        || action == "subscription.disable_auto_renew.v1"
    {
        out["autoRenew"] = json!(action == "subscription.enable_auto_renew.v1");
    }
    Ok(Some(out))
}

fn page_cursor(
    result: &Value,
    requested: Option<&str>,
    limit: usize,
) -> Result<(Option<String>, bool), AppError> {
    let rows = result
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    if rows.len() > limit {
        return Err(invalid());
    }
    let has = result
        .get("hasNextPage")
        .and_then(Value::as_bool)
        .ok_or_else(invalid)?;
    let cursor = optional_id(result.get("nextCursor"))?;
    if has
        && (cursor.is_none()
            || requested
                .zip(cursor.as_deref())
                .is_some_and(|(a, b)| same(a, b)))
    {
        return Err(invalid());
    }
    Ok((if has { cursor } else { None }, has))
}
pub async fn read(
    state: &Arc<AppState>,
    auth: &AuthInfo,
    resource: &str,
    q: &crate::platform_reads::ReadQuery,
) -> Result<Value, AppError> {
    tokio::time::timeout(
        std::time::Duration::from_secs(28),
        read_inner(state, auth, resource, q),
    )
    .await
    .map_err(|_| AppError::Internal("Subscription read exceeded its time budget".into()))?
}
async fn read_inner(
    state: &Arc<AppState>,
    auth: &AuthInfo,
    resource: &str,
    q: &crate::platform_reads::ReadQuery,
) -> Result<Value, AppError> {
    request_platform(state, auth)?;
    let required = |v: Option<&str>| {
        v.map(str::to_owned)
            .ok_or_else(|| bad("A required subscription identity is missing"))
    };
    match resource {
        "subscription_quote" => {
            let quote = plan_quote(
                state,
                &required(q.service_id.as_deref())?,
                &required(q.plan_id.as_deref())?,
            )
            .await?;
            if !scope_allows(auth, quote["terms"].get("planPlatformId")) {
                return Err(AppError::Forbidden(
                    "Subscription plan is outside this agent's platform".into(),
                ));
            }
            Ok(quote)
        }
        "subscription_renewal_quote" => {
            let sub = owned_subscription(state, auth, &required(q.id.as_deref())?, false).await?;
            let mut quote = plan_quote(
                state,
                sub["serviceId"].as_str().ok_or_else(invalid)?,
                sub["planId"].as_str().ok_or_else(invalid)?,
            )
            .await?;
            if quote["terms"]["coinType"] != sub["coinType"] {
                return Err(AppError::Conflict(
                    "The plan coin no longer matches the stored subscription".into(),
                ));
            }
            quote["retainedAccess"] = json!({"tierLevel":sub["tierLevel"],"platformId":sub["planPlatformId"],"source":"immutable_subscription_fields"});
            quote["subscription"] = sub;
            quote["nativeRenewalRetainsStoredAccess"] = json!(true);
            Ok(quote)
        }
        "subscription_get" => {
            owned_subscription(state, auth, &required(q.id.as_deref())?, true).await
        }
        "subscription_list" => {
            let cursor = q.cursor.as_deref().map(id).transpose()?;
            let limit = q.limit.unwrap_or(20).clamp(1, 50);
            let result=rpc(state,"mysox_getOwnedObjects",json!([id(&auth.owner)?,{"filter":{"StructType":format!("{}::subscription::ProfileSubscription",state.config.package_id)},"options":{"showContent":true,"showOwner":true}},cursor,limit])).await?;
            let (next, has) = page_cursor(&result, q.cursor.as_deref(), limit as usize)?;
            let items = result
                .get("data")
                .and_then(Value::as_array)
                .ok_or_else(invalid)?
                .iter()
                .map(|r| {
                    subscription_metadata(
                        r.get("data").ok_or_else(invalid)?,
                        &state.config.package_id,
                        &auth.owner,
                    )
                })
                .collect::<Result<Vec<_>, _>>()?;
            let items: Vec<_> = items
                .into_iter()
                .filter(|item| scope_allows(auth, item.get("planPlatformId")))
                .collect();
            Ok(
                json!({"items":items,"nextCursor":next,"hasNextPage":has,"owner":auth.owner,"source":"configured_fullnode"}),
            )
        }
        "subscription_plans" => {
            let service_id = required(q.service_id.as_deref())?;
            let service = service(state, &service_id).await?;
            let f = fields(
                &service,
                &state.config.package_id,
                "ProfileSubscriptionService",
            )?;
            let payout_recipient = service_payment_recipient(state, &service_id, &service).await?;
            let table = table_id(f, "plans")?;
            let cursor = q.cursor.as_deref().map(id).transpose()?;
            let result = rpc(
                state,
                "mysox_getDynamicFields",
                json!([table, cursor, q.limit.unwrap_or(20).clamp(1, 50)]),
            )
            .await?;
            let (next, has) = page_cursor(
                &result,
                q.cursor.as_deref(),
                q.limit.unwrap_or(20).clamp(1, 50) as usize,
            )?;
            let mut plan_ids = Vec::new();
            for item in result
                .get("data")
                .and_then(Value::as_array)
                .ok_or_else(invalid)?
            {
                if coin_type(
                    item.pointer("/name/type")
                        .and_then(Value::as_str)
                        .ok_or_else(invalid)?,
                )? != coin_type("0x2::object::ID")?
                {
                    return Err(invalid());
                }
                plan_ids.push(address(item.pointer("/name/value"))?);
            }
            let profile_owner = address(f.get("profile_owner"))?;
            // Preserve fullnode cursor order while bounding both fanout and wall time.
            let items=stream::iter(plan_ids).map(|plan_id|{let table=&table;let owner=&profile_owner;async move {
                let dynamic=rpc(state,"mysox_getDynamicFieldObject",json!([table,{"type":"0x2::object::ID","value":plan_id}])).await?;
                let (terms,active)=terms_from_plan(&dynamic,table,&state.config.package_id,&plan_id,owner)?;
                Ok::<_,AppError>(if scope_allows(auth,terms.get("planPlatformId")){Some(json!({"terms":terms,"active":active,"planMetadata":plan_metadata(&dynamic)?}))}else{None})
            }}).buffered(4).try_collect::<Vec<_>>().await?.into_iter().flatten().collect::<Vec<_>>();
            Ok(
                json!({"serviceId":id(&service_id)?,"paymentRecipient":payout_recipient,"profileOwner":address(f.get("profile_owner"))?,"items":items,"nextCursor":next,"hasNextPage":has,"source":"configured_fullnode"}),
            )
        }
        "subscription_receipt" => receipt(state, auth, &required(q.id.as_deref())?).await,
        _ => Err(bad("Unknown subscription read")),
    }
}

async fn receipt(state: &AppState, auth: &AuthInfo, digest: &str) -> Result<Value, AppError> {
    if !(43..=44).contains(&digest.len())
        || !digest
            .bytes()
            .all(|b| b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".contains(&b))
    {
        return Err(bad("Invalid transaction digest"));
    }
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
        AppError::BlobNotFound("Subscription transaction is outside this agent scope".into())
    })?;
    let context = row.receipt_context.as_ref().ok_or_else(|| {
        AppError::Conflict(
            "Prepared currency context is unavailable; reconcile this transaction".into(),
        )
    })?;
    if !context
        .get("executionPlatformId")
        .and_then(Value::as_str)
        .is_some_and(|platform| same(platform, &state.config.social_chain.platform_object_id))
    {
        return Err(AppError::BlobNotFound(
            "Subscription transaction is outside this platform".into(),
        ));
    }
    let result = rpc(
        state,
        "myso_getTransactionBlock",
        json!([digest,{"showEffects":true,"showEvents":true,"showObjectChanges":true}]),
    )
    .await?;
    if result.get("digest").and_then(Value::as_str) != Some(digest) {
        return Err(invalid());
    }
    let checkpoint = result
        .get("checkpoint")
        .filter(|v| !v.is_null())
        .map(|v| u64_value(Some(v)))
        .transpose()?;
    let status = match result
        .pointer("/effects/status/status")
        .and_then(Value::as_str)
    {
        Some("success") if checkpoint.is_some() => "finalized",
        Some("success") => "executed",
        Some("failure") => "failed",
        _ => "unknown",
    };
    let mut events = Vec::new();
    if status == "finalized" || status == "executed" {
        for event in result
            .get("events")
            .and_then(Value::as_array)
            .ok_or_else(invalid)?
        {
            if let Some(event) = receipt_event(
                event,
                &state.config.package_id,
                &row.registry_action,
                &row.sender,
                context,
                &result,
            )? {
                events.push(event);
            }
        }
    }
    if (status == "finalized" || status == "executed") && events.len() != 1 {
        return Err(AppError::Conflict(
            "The successful transaction's expected subscription event could not be verified".into(),
        ));
    }
    Ok(
        json!({"digest":digest,"registryAction":row.registry_action,"accountId":auth.account_id,"agentId":auth.agent_object_id,"status":status,"checkpoint":checkpoint.map(|v|v.to_string()),"events":events,"preparedContext":context,"evidenceSource":"configured_fullnode_and_scoped_preparation","currentAccess":"not_checked"}),
    )
}
fn receipt_event(
    event: &Value,
    package: &str,
    action: &str,
    owner: &str,
    context: &Value,
    transaction: &Value,
) -> Result<Option<Value>, AppError> {
    let name = match action {
        "subscription.subscribe_to_plan.v1" => "ProfileSubscriptionCreatedEvent",
        "subscription.renew_subscription.v1" => "ProfileSubscriptionRenewedEvent",
        "subscription.cancel_subscription.v1" => "ProfileSubscriptionCancelledEvent",
        "subscription.enable_auto_renew.v1" | "subscription.disable_auto_renew.v1" => {
            "SubscriptionAutoRenewUpdatedEvent"
        }
        "subscription.change_service_payment_recipient.v1" => "ServicePaymentRecipientUpdatedEvent",
        _ => return Ok(None),
    };
    let expected = coin_type(&format!("{package}::subscription::{name}"))?;
    if coin_type(event.get("type").and_then(Value::as_str).unwrap_or(""))
        .ok()
        .as_ref()
        != Some(&expected)
    {
        return Ok(None);
    }
    let p = event.get("parsedJson").ok_or_else(invalid)?;
    if action == "subscription.change_service_payment_recipient.v1" {
        let service_id = address(p.get("service_id"))?;
        let previous = address(p.get("previous_recipient"))?;
        let recipient = address(p.get("new_recipient"))?;
        if !same(&service_id, context["serviceId"].as_str().ok_or_else(invalid)?)
            || !same(&address(p.get("updated_by"))?, owner)
            || !same(&recipient, context["newRecipient"].as_str().ok_or_else(invalid)?)
            || same(&previous, &recipient)
        { return Err(invalid()); }
        return Ok(Some(json!({"kind":name,"serviceId":service_id,"previousRecipient":previous,"newRecipient":recipient,"updatedBy":id(owner)?,"timestampMs":u64_value(p.get("timestamp"))?.to_string()})));
    }
    if !same(&address(p.get("subscriber"))?, owner) {
        return Ok(None);
    }
    let subscription_id = address(p.get("subscription_id"))?;
    if context.get("subscriptionId").is_some()
        && !same(
            &subscription_id,
            context["subscriptionId"].as_str().ok_or_else(invalid)?,
        )
    {
        return Err(invalid());
    }
    let mut out = json!({"kind":name,"subscriptionId":subscription_id,"subscriber":id(owner)?});
    if let Some(service) = p.get("service_id") {
        if !same(
            &address(Some(service))?,
            context["serviceId"].as_str().ok_or_else(invalid)?,
        ) {
            return Err(invalid());
        }
    }
    if name == "ProfileSubscriptionCreatedEvent" || name == "ProfileSubscriptionRenewedEvent" {
        let currency = named_coin(p.get("coin_type"))?;
        if Some(currency.as_str()) != context["coinType"].as_str()
            || !same(
                &address(p.get("plan_id"))?,
                context["planId"].as_str().ok_or_else(invalid)?,
            )
            || u64_value(p.get("price"))? != u64_value(context.get("priceBaseUnits"))?
            || u64_value(p.get("duration_ms"))? != u64_value(context.get("durationMs"))?
        {
            return Err(invalid());
        }
        if name == "ProfileSubscriptionRenewedEvent"
            && p.get("auto_renewed").and_then(Value::as_bool) != Some(false)
        {
            return Err(invalid());
        }
        out["coinType"] = json!(currency);
        out["priceBaseUnits"] = json!(u64_value(p.get("price"))?.to_string());
        out["expiresAtMs"] = json!(u64_value(p.get(
            if name == "ProfileSubscriptionCreatedEvent" {
                "expires_at"
            } else {
                "new_expires_at"
            }
        ))?
        .to_string());
        for (source, target) in [
            ("platform_fee", "platformFeeBaseUnits"),
            ("ecosystem_fee", "ecosystemFeeBaseUnits"),
            ("creator_amount", "creatorAmountBaseUnits"),
        ] {
            out[target] = json!(u64_value(p.get(source))?.to_string());
        }
        let distributed = (u64_value(p.get("platform_fee"))? as u128)
            + (u64_value(p.get("ecosystem_fee"))? as u128)
            + (u64_value(p.get("creator_amount"))? as u128);
        if distributed != u64_value(p.get("price"))? as u128 {
            return Err(invalid());
        }
        out["accessTierLevel"] = json!(optional_u64(p.get("tier_level"))?);
        out["accessPlatformId"] = json!(optional_id(p.get("platform_id"))?);
        out["durationMs"] = json!(u64_value(p.get("duration_ms"))?.to_string());
        if name == "ProfileSubscriptionCreatedEvent"
            && p.get("auto_renew").and_then(Value::as_bool)
                != context.get("autoRenew").and_then(Value::as_bool)
        {
            return Err(invalid());
        }
    } else if name == "ProfileSubscriptionCancelledEvent" {
        let deleted = transaction
            .get("objectChanges")
            .and_then(Value::as_array)
            .is_some_and(|rows| {
                rows.iter().any(|r| {
                    r.get("type").and_then(Value::as_str) == Some("deleted")
                        && r.get("objectId")
                            .and_then(Value::as_str)
                            .is_some_and(|object| same(object, &subscription_id))
                })
            });
        // Insufficient prepaid balance emits this event without deleting the subscription.
        if !deleted {
            return Err(AppError::Conflict(
                "Cancellation event has no matching object deletion".into(),
            ));
        }
        out["refundBaseUnits"] = json!(u64_value(p.get("refunded_amount"))?.to_string());
        out["coinType"] = context["coinType"].clone();
        out["coinTypeSource"] = json!("scoped_exact_input_preparation");
        out["objectDeleted"] = json!(true);
    } else {
        let enabled = p
            .get("auto_renew")
            .and_then(Value::as_bool)
            .ok_or_else(invalid)?;
        if Some(enabled) != context.get("autoRenew").and_then(Value::as_bool) {
            return Err(invalid());
        }
        out["autoRenew"] = json!(enabled);
        out["timestampMs"] = json!(u64_value(p.get("timestamp"))?.to_string());
        out["newFundingBaseUnits"] = json!("0");
    }
    Ok(Some(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn plan() -> Value {
        json!({"data":{"owner":{"ObjectOwner":"0x7"},"content":{"type":"0x2::dynamic_field::Field<0x2::object::ID,0x50c1::subscription::SubscriptionPlan>","fields":{"name":"0x9","value":{"type":"0x50c1::subscription::SubscriptionPlan","fields":{"price":"9007199254740993","duration_ms":"2592000000","tier_level":null,"platform_id":null,"coin_type":{"type":"0x1::type_name::TypeName","fields":{"name":"2::myso::MYSO"}},"active":true}}}}}})
    }
    #[test]
    fn fullnode_plan_decoder_binds_table_plan_and_defining_package() {
        let data = plan();
        let (terms, active) = terms_from_plan(&data, "0x7", "0x50c1", "0x9", "0xa").unwrap();
        assert!(active);
        assert_eq!(terms["priceBaseUnits"], "9007199254740993");
        assert!(!terms.as_object().unwrap().contains_key("tierLevel"));
        assert!(terms_from_plan(&data, "0x8", "0x50c1", "0x9", "0xa").is_err());
        assert!(terms_from_plan(&data, "0x7", "0xbad", "0x9", "0xa").is_err());
        assert!(terms_from_plan(&data, "0x7", "0x50c1", "0x8", "0xa").is_err());
        let mut rounded = terms.clone();
        rounded["priceBaseUnits"] = json!(9007199254740992u64);
        assert!(!supplied_terms_equal(&rounded, &terms).unwrap());
    }
    #[test]
    fn coin_types_support_native_typename_and_rpc_struct_shapes() {
        assert_eq!(
            coin_type("2::myso::MYSO").unwrap(),
            coin_type("0x2::myso::MYSO").unwrap()
        );
        assert!(coin_type("0x2::wrapper::Coin<0x3::token::USD,vector<u8>>").is_ok());
        for bad in [
            "u64",
            "0x2::x::Coin<u64>junk",
            "0x2::x::Coin<>",
            "0x2::x::Coin<u64",
            "0x2::x::Coin;evil()",
        ] {
            assert!(coin_type(bad).is_err(), "{bad}");
        }
        assert_eq!(
            named_coin(Some(&json!({"name":"2::myso::MYSO"}))).unwrap(),
            named_coin(Some(&json!({"fields":{"name":"0x2::myso::MYSO"}}))).unwrap()
        );
    }
    #[test]
    fn cancellation_named_event_requires_actual_subscription_deletion() {
        let e = json!({"type":"0x50c1::subscription::ProfileSubscriptionCancelledEvent","parsedJson":{"subscription_id":"0x9","subscriber":"0xa","refunded_amount":"18446744073709551615"}});
        let context = json!({"subscriptionId":"0x9","serviceId":"0xb","coinType":coin_type("0x2::myso::MYSO").unwrap()});
        assert!(receipt_event(
            &e,
            "0x50c1",
            ACTIONS[2],
            "0xa",
            &context,
            &json!({"objectChanges":[]})
        )
        .is_err());
        let tx = json!({"objectChanges":[{"type":"deleted","objectId":"0x9"}]});
        let parsed = receipt_event(&e, "0x50c1", ACTIONS[2], "0xa", &context, &tx)
            .unwrap()
            .unwrap();
        assert_eq!(parsed["refundBaseUnits"], "18446744073709551615");
        assert_eq!(parsed["objectDeleted"], true);
        assert!(
            receipt_event(&e, "0x50c1", ACTIONS[2], "0xb", &context, &tx)
                .unwrap()
                .is_none()
        );
        assert!(receipt_event(&e, "0xbad", ACTIONS[2], "0xa", &context, &tx)
            .unwrap()
            .is_none());
    }
    #[test]
    fn receipt_context_tracks_exact_commitment_and_no_arbitrary_text() {
        let p = json!({"serviceId":"0xb","terms":{"planId":"0x9","coinType":"0x2::myso::MYSO","expectedProfileOwner":"0xc","priceBaseUnits":"9007199254740993","durationMs":"2592000000"},"autoRenew":true,"renewalPeriods":"2","secret":"not copied"});
        let c = receipt_context(ACTIONS[0], &p, "0xd").unwrap().unwrap();
        assert_eq!(c["totalCommittedBaseUnits"], "27021597764222979");
        assert!(c.get("secret").is_none());
        assert_eq!(c["autoRenew"], true);
        let mut overflow = p.clone();
        overflow["renewalPeriods"] = json!("18446744073709551615");
        assert!(receipt_context(ACTIONS[0], &overflow, "0xd").is_err());
    }
    #[test]
    fn creation_receipt_preserves_currency_and_verifies_price_distribution() {
        let p = json!({"serviceId":"0xb","terms":{"planId":"0x9","coinType":"0x2::myso::MYSO","expectedProfileOwner":"0xc","priceBaseUnits":"9007199254740993","durationMs":"2592000000"},"autoRenew":false,"renewalPeriods":"0"});
        let context = receipt_context(ACTIONS[0], &p, "0xd").unwrap().unwrap();
        let event = json!({"type":"0x50c1::subscription::ProfileSubscriptionCreatedEvent","parsedJson":{"service_id":"0xb","subscription_id":"0xe","subscriber":"0xa","plan_id":"0x9","coin_type":{"name":"2::myso::MYSO"},"price":"9007199254740993","duration_ms":"2592000000","expires_at":"18446744073709551615","tier_level":"1","platform_id":null,"auto_renew":false,"platform_fee":"0","ecosystem_fee":"0","creator_amount":"9007199254740993"}});
        let parsed = receipt_event(&event, "0x50c1", ACTIONS[0], "0xa", &context, &json!({}))
            .unwrap()
            .unwrap();
        assert_eq!(parsed["priceBaseUnits"], "9007199254740993");
        assert_eq!(parsed["expiresAtMs"], "18446744073709551615");
        assert_eq!(parsed["accessTierLevel"], "1");
        assert_eq!(parsed["coinType"], coin_type("0x2::myso::MYSO").unwrap());
        let mut invalid = event.clone();
        invalid["parsedJson"]["coin_type"] = json!({"name":"3::token::USD"});
        assert!(
            receipt_event(&invalid, "0x50c1", ACTIONS[0], "0xa", &context, &json!({})).is_err()
        );
        invalid = event.clone();
        invalid["parsedJson"]["creator_amount"] = json!("1");
        assert!(
            receipt_event(&invalid, "0x50c1", ACTIONS[0], "0xa", &context, &json!({})).is_err()
        );
    }
    #[test]
    fn absent_renewal_balance_is_zero_only_for_the_requested_bag() {
        assert!(missing_dynamic_field(
            &json!({"error":{"code":"dynamicFieldNotFound","parent_object_id":"0xa"}}),
            "0xa"
        )
        .unwrap());
        assert!(missing_dynamic_field(
            &json!({"error":{"code":"dynamicFieldNotFound","parent_object_id":"0xb"}}),
            "0xa"
        )
        .is_err());
        assert!(!missing_dynamic_field(
            &json!({"error":{"code":"notExists","object_id":"0xa"}}),
            "0xa"
        )
        .unwrap());
    }
    #[test]
    fn seller_metadata_previews_report_unicode_truncation() {
        let data = json!({"data":{"content":{"fields":{"value":{"fields":{"title":"🌿".repeat(300),"description":"é".repeat(2000)}}}}}});
        let meta = plan_metadata(&data).unwrap();
        assert_eq!(meta["title"]["text"].as_str().unwrap().chars().count(), 256);
        assert_eq!(meta["title"]["totalCharacters"], 300);
        assert_eq!(meta["title"]["truncated"], true);
        assert_eq!(meta["description"]["totalCharacters"], 2000);
        assert_eq!(meta["description"]["truncated"], true);
    }
    #[test]
    fn bounded_pages_require_an_advancing_cursor_when_more_data_exists() {
        assert!(page_cursor(
            &json!({"data":[],"hasNextPage":true,"nextCursor":null}),
            None,
            20
        )
        .is_err());
        assert!(page_cursor(
            &json!({"data":[],"hasNextPage":true,"nextCursor":"0xa"}),
            Some("0xa"),
            20
        )
        .is_err());
        assert!(page_cursor(
            &json!({"data":[1,2],"hasNextPage":false,"nextCursor":null}),
            None,
            1
        )
        .is_err());
        assert_eq!(
            page_cursor(
                &json!({"data":[],"hasNextPage":false,"nextCursor":null}),
                None,
                20
            )
            .unwrap(),
            (None, false)
        );
    }
    #[test]
    fn owned_metadata_checks_wallet_owner_and_stored_subscriber() {
        let data = json!({"objectId":"0x9","version":"9007199254740993","owner":{"AddressOwner":"0xa"},"content":{"type":"0x50c1::subscription::ProfileSubscription","fields":{"subscriber":"0xa","service_id":"0xb","plan_id":"0xc","coin_type":{"fields":{"name":"2::myso::MYSO"}},"created_at":"0","expires_at":"18446744073709551615","renewal_count":"0","auto_renew":false,"tier_level":null,"platform_id":null}}});
        let result = subscription_metadata(&data, "0x50c1", "0xa").unwrap();
        assert_eq!(result["expiresAtMs"], "18446744073709551615");
        assert_eq!(result["balanceRead"], false);
        assert!(result["renewalBalanceBaseUnits"].is_null());
        assert!(subscription_metadata(&data, "0x50c1", "0xb").is_err());
    }
}
