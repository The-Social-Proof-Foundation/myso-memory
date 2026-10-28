//! Organization treasury policy and exact event receipts.
use crate::chain_reads::{coin_type, digest_bytes, id, object, rpc, same, u64_value};
use crate::types::{AppError, AppState, AuthInfo};
use serde_json::{json, Value};
use std::sync::Arc;

pub const GRANT_ACTION: &str = "organization.grant_treasury_access.v1";
pub const WITHDRAW_ACTION: &str = "organization.withdraw_treasury.v1";
pub const FUND_ACTION: &str = "organization.fund_treasury.v1";

pub fn is_action(action: &str) -> bool {
    matches!(action, GRANT_ACTION | WITHDRAW_ACTION | FUND_ACTION)
}

fn bad(message: &str) -> AppError {
    AppError::BadRequest(message.into())
}
fn invalid() -> AppError {
    AppError::Internal("Organization treasury chain evidence is invalid or unavailable".into())
}

fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str, AppError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| bad(&format!("{key} is required")))
}

fn parse_coin(value: &str) -> Result<String, AppError> {
    let parsed = coin_type(value).map_err(|_| bad("coinType is invalid"))?;
    if parsed != value {
        return Err(bad("coinType must use its canonical fully qualified form"));
    }
    Ok(parsed)
}

async fn organization_scope(
    state: &AppState,
    auth: &AuthInfo,
    parameters: &Value,
    require_group: bool,
) -> Result<String, AppError> {
    let organization_id =
        id(required(parameters, "organizationId")?).map_err(|_| bad("Invalid organizationId"))?;
    let organization = object(state, &organization_id).await?;
    let expected_org_type = coin_type(&format!(
        "{}::memory::AgenticOrganization",
        state.config.package_id
    ))?;
    if coin_type(
        organization
            .pointer("/content/type")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?,
    )? != expected_org_type
    {
        return Err(AppError::Forbidden(
            "The selected object is not an organization in the configured package".into(),
        ));
    }
    let fields = organization
        .pointer("/content/fields")
        .ok_or_else(invalid)?;
    if !same(
        fields
            .get("memory_account_id")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?,
        &auth.account_id,
    ) || !same(
        fields
            .get("principal_owner")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?,
        &auth.owner,
    ) {
        return Err(AppError::Forbidden(
            "Organization is outside the authenticated MySo owner account".into(),
        ));
    }
    if fields.get("active").and_then(Value::as_bool) != Some(true) {
        return Err(AppError::Conflict(
            "Organization treasury actions require an active organization".into(),
        ));
    }
    let account = object(state, &auth.account_id).await?;
    let expected_account_type = coin_type(&format!(
        "{}::memory::MemoryAccount",
        state.config.package_id
    ))?;
    if coin_type(
        account
            .pointer("/content/type")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?,
    )? != expected_account_type
    {
        return Err(AppError::Forbidden(
            "Authenticated memory account is not the canonical owner account".into(),
        ));
    }
    let account_fields = account.pointer("/content/fields").ok_or_else(invalid)?;
    if account_fields.get("active").and_then(Value::as_bool) != Some(true)
        || !same(
            account_fields
                .get("owner")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?,
            &auth.owner,
        )
        || account_fields.get("profile_id") != fields.get("profile_id")
    {
        return Err(AppError::Forbidden("Organization and memory account are not active and linked to the authenticated owner profile".into()));
    }
    if require_group {
        let derived_group =
            crate::org_chain::org_memory_group_id(&state.config.package_id, &organization_id)
                .ok_or_else(invalid)?;
        let supplied_group = id(required(parameters, "orgMemoryGroupId")?)
            .map_err(|_| bad("Invalid orgMemoryGroupId"))?;
        if !same(&derived_group, &supplied_group) {
            return Err(AppError::Forbidden(
                "Organization memory group is not the canonical derived group".into(),
            ));
        }
        let group = object(state, &derived_group).await?;
        let expected_group_type = coin_type(&format!(
            "0x2::permissioned_group::PermissionedGroup<{}::memory::MemorySharePackage>",
            state.config.package_id
        ))?;
        if coin_type(
            group
                .pointer("/content/type")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?,
        )? != expected_group_type
        {
            return Err(AppError::Conflict(
                "Organization treasury administration requires its live memory permission group"
                    .into(),
            ));
        }
    }
    Ok(organization_id)
}

pub async fn authorize_admin_read(
    state: &AppState,
    auth: &AuthInfo,
    organization: &str,
) -> Result<(), AppError> {
    let organization_id = id(organization).map_err(|_| bad("Invalid organizationId"))?;
    if !auth
        .organization_id
        .as_deref()
        .is_some_and(|bound| same(bound, &organization_id))
    {
        return Err(AppError::Forbidden(
            "Organization read is outside the authenticated organization scope".into(),
        ));
    }
    let group_id =
        crate::org_chain::org_memory_group_id(&state.config.package_id, &organization_id)
            .ok_or_else(invalid)?;
    let parameters = json!({"organizationId":organization_id,"orgMemoryGroupId":group_id});
    organization_scope(state, auth, &parameters, false).await?;
    let owner_is_admin = crate::org_chain::verify_org_treasury_admin(
        &state.http_client,
        &state.config.myso_rpc_url,
        &state.config.package_id,
        &organization_id,
        &auth.owner,
    )
    .await
    .map_err(|error| {
        AppError::Forbidden(format!(
            "live organization administrator verification failed: {error}"
        ))
    })?;
    let is_admin = if owner_is_admin {
        true
    } else {
        crate::org_chain::verify_org_treasury_admin(
            &state.http_client,
            &state.config.myso_rpc_url,
            &state.config.package_id,
            &organization_id,
            &auth.derived_address,
        )
        .await
        .map_err(|error| {
            AppError::Forbidden(format!(
                "live organization administrator verification failed: {error}"
            ))
        })?
    };
    if !is_admin {
        return Err(AppError::Forbidden("This organization list requires current organization-owner or group-administrator authority".into()));
    }
    Ok(())
}

/// Enforce the social-server's route-specific organization permission for a
/// relayed read. This mirrors its enterprise middleware, which checks active
/// indexed role-assignment and direct-memory-permission rows for the caller.
/// The internal endpoint is authenticated with the shared service secret and
/// returns only the permission decision, not organization membership data.
pub async fn authorize_read_permission(
    state: &AppState,
    auth: &AuthInfo,
    organization: &str,
    permission: &str,
) -> Result<(), AppError> {
    if !matches!(permission, "dashboard_viewer" | "auditor") {
        return Err(AppError::BadRequest(
            "unsupported organization read permission".into(),
        ));
    }
    let organization_id = id(organization).map_err(|_| bad("Invalid organizationId"))?;
    if !auth
        .organization_id
        .as_deref()
        .is_some_and(|bound| same(bound, &organization_id))
    {
        return Err(AppError::Forbidden(
            "Organization read is outside the authenticated organization scope".into(),
        ));
    }
    let group_id =
        crate::org_chain::org_memory_group_id(&state.config.package_id, &organization_id)
            .ok_or_else(invalid)?;
    organization_scope(
        state,
        auth,
        &json!({"organizationId":organization_id,"orgMemoryGroupId":group_id}),
        false,
    )
    .await?;

    let secret = state
        .config
        .internal_sync_secret
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            AppError::Internal("organization read authorization is not configured".into())
        })?;
    let url = format!(
        "{}/internal/organizations/{}/access",
        state.config.social_server_url.trim_end_matches('/'),
        organization_id
    );
    let mut candidates = vec![auth.owner.as_str(), auth.derived_address.as_str()];
    candidates.sort_unstable();
    candidates.dedup();
    for member in candidates {
        let response = state
            .http_client
            .get(&url)
            .header("x-internal-sync-secret", secret)
            .query(&[("member", member), ("permission", permission)])
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
            .map_err(|_| {
                AppError::Internal("organization role authorization is unavailable".into())
            })?;
        if !response.status().is_success() {
            return Err(AppError::Internal(
                "organization role authorization was rejected".into(),
            ));
        }
        let bytes = response.bytes().await.map_err(|_| {
            AppError::Internal("organization role authorization response could not be read".into())
        })?;
        if bytes.len() > 8 * 1024 {
            return Err(AppError::Internal(
                "organization role authorization response exceeded its limit".into(),
            ));
        }
        let decision: Value = serde_json::from_slice(&bytes).map_err(|_| {
            AppError::Internal("organization role authorization response was invalid".into())
        })?;
        if id(decision
            .get("organizationId")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?)?
            != organization_id
            || id(decision
                .get("member")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?)?
                != id(member)?
            || decision.get("permission").and_then(Value::as_str) != Some(permission)
            || decision.get("evidenceSource").and_then(Value::as_str)
                != Some("same_indexed_active_permission_rows_as_org_role_middleware")
        {
            return Err(AppError::Internal(
                "organization role authorization response did not match the request".into(),
            ));
        }
        if decision.get("allowed").and_then(Value::as_bool) == Some(true) {
            return Ok(());
        }
    }
    Err(AppError::Forbidden(
        "The authenticated owner and agent lack the required active organization read permission"
            .into(),
    ))
}

async fn validate_coin(
    state: &AppState,
    auth: &AuthInfo,
    coin_id: &str,
    coin_type_name: &str,
    amount: &str,
) -> Result<(), AppError> {
    let coin_id = id(coin_id).map_err(|_| bad("Invalid paymentCoinId"))?;
    let amount_value = amount
        .parse::<u64>()
        .map_err(|_| bad("amountBaseUnits must be a u64 decimal string"))?;
    if amount_value == 0 {
        return Err(bad("amountBaseUnits must be greater than zero"));
    }
    let data = object(state, &coin_id).await?;
    let expected_type = coin_type(&format!("0x2::coin::Coin<{coin_type_name}>"))?;
    if coin_type(
        data.pointer("/content/type")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?,
    )? != expected_type
        || !same(
            data.pointer("/owner/AddressOwner")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?,
            &auth.owner,
        )
    {
        return Err(AppError::Forbidden("Payment coin is not the selected canonical type and directly owned by the authenticated owner".into()));
    }
    let balance = data
        .pointer("/content/fields/balance")
        .ok_or_else(invalid)?;
    if u64_value(Some(balance))? < amount_value {
        return Err(AppError::Conflict(
            "Payment coin balance is below the selected treasury funding amount".into(),
        ));
    }
    Ok(())
}

async fn treasury_balance(
    state: &AppState,
    organization_id: &str,
    coin_type_name: &str,
) -> Result<u64, AppError> {
    let key_type = format!(
        "{}::memory::OrgTreasuryBalanceKey<{coin_type_name}>",
        state.config.package_id
    );
    let result = rpc(
        state,
        "mysox_getDynamicFieldObject",
        json!([organization_id,{"type":key_type,"value":{}}]),
    )
    .await?;
    if result
        .pointer("/error/code")
        .and_then(Value::as_str)
        .is_some_and(|code| matches!(code, "dynamicFieldNotFound" | "notExists" | "deleted"))
    {
        return Ok(0);
    }
    let value = result
        .pointer("/data/content/fields/value/fields/value")
        .ok_or_else(invalid)?;
    u64_value(Some(value))
}

pub async fn read_balance(
    state: &AppState,
    auth: &AuthInfo,
    organization: &str,
    coin_type_name: &str,
) -> Result<Value, AppError> {
    let organization_id = id(organization).map_err(|_| bad("Invalid organizationId"))?;
    let coin = parse_coin(coin_type_name)?;
    let group = crate::org_chain::org_memory_group_id(&state.config.package_id, &organization_id)
        .ok_or_else(invalid)?;
    let parameters = json!({"organizationId":organization_id,"orgMemoryGroupId":group});
    let organization_id = organization_scope(state, auth, &parameters, false).await?;
    authorize_admin_read(state, auth, &organization_id).await?;
    let balance = treasury_balance(state, &organization_id, &coin).await?;
    Ok(
        json!({"organizationId":organization_id,"coinType":coin,"balanceBaseUnits":balance.to_string(),"evidenceSource":"configured_fullnode_live_dynamic_field"}),
    )
}

pub async fn read_access(
    state: &AppState,
    auth: &AuthInfo,
    organization: &str,
    recipient: &str,
) -> Result<Value, AppError> {
    let organization_id = id(organization).map_err(|_| bad("Invalid organizationId"))?;
    let recipient = id(recipient).map_err(|_| bad("Invalid recipient"))?;
    let group = crate::org_chain::org_memory_group_id(&state.config.package_id, &organization_id)
        .ok_or_else(invalid)?;
    let parameters = json!({"organizationId":organization_id,"orgMemoryGroupId":group});
    let organization_id = organization_scope(state, auth, &parameters, false).await?;
    authorize_admin_read(state, auth, &organization_id).await?;
    let key_type = format!("{}::memory::OrgTreasuryAccessKey", state.config.package_id);
    let result = rpc(
        state,
        "mysox_getDynamicFieldObject",
        json!([organization_id,{"type":key_type,"value":{"recipient":recipient}}]),
    )
    .await?;
    let access = if result
        .pointer("/error/code")
        .and_then(Value::as_str)
        .is_some_and(|code| matches!(code, "dynamicFieldNotFound" | "notExists" | "deleted"))
    {
        false
    } else {
        result
            .pointer("/data/content/fields/value")
            .and_then(Value::as_bool)
            .ok_or_else(invalid)?
    };
    Ok(
        json!({"organizationId":organization_id,"recipient":recipient,"hasTreasuryAccess":access,"evidenceSource":"configured_fullnode_live_dynamic_field"}),
    )
}

pub async fn validate_action(
    state: &AppState,
    auth: &AuthInfo,
    action: &str,
    parameters: &Value,
) -> Result<(), AppError> {
    if !is_action(action) {
        return Ok(());
    }
    let fields = parameters
        .as_object()
        .ok_or_else(|| bad("Organization treasury parameters must be an object"))?;
    let allowed: &[&str] = match action {
        GRANT_ACTION => &[
            "organizationId",
            "orgMemoryGroupId",
            "recipient",
            "hasAccess",
        ],
        WITHDRAW_ACTION => &[
            "organizationId",
            "orgMemoryGroupId",
            "recipient",
            "amountBaseUnits",
            "coinType",
        ],
        FUND_ACTION => &[
            "organizationId",
            "paymentCoinId",
            "amountBaseUnits",
            "coinType",
        ],
        _ => return Ok(()),
    };
    if fields.len() != allowed.len() || fields.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(bad(
            "Unexpected or missing organization treasury parameters",
        ));
    }
    let organization_id =
        organization_scope(state, auth, parameters, action != FUND_ACTION).await?;
    match action {
        GRANT_ACTION => {
            let recipient =
                id(required(parameters, "recipient")?).map_err(|_| bad("Invalid recipient"))?;
            if recipient == id("0x0")? {
                return Err(bad("recipient cannot be the zero address"));
            }
            if parameters
                .get("hasAccess")
                .and_then(Value::as_bool)
                .is_none()
            {
                return Err(bad("hasAccess must be boolean"));
            }
        }
        WITHDRAW_ACTION => {
            let recipient =
                id(required(parameters, "recipient")?).map_err(|_| bad("Invalid recipient"))?;
            if recipient == id("0x0")? {
                return Err(bad("recipient cannot be the zero address"));
            }
            let amount = required(parameters, "amountBaseUnits")?;
            let amount_value = amount
                .parse::<u64>()
                .map_err(|_| bad("amountBaseUnits must be a u64 decimal string"))?;
            if amount_value == 0 {
                return Err(bad("amountBaseUnits must be greater than zero"));
            }
            let coin = parse_coin(required(parameters, "coinType")?)?;
            if treasury_balance(state, &organization_id, &coin).await? < amount_value {
                return Err(AppError::Conflict(
                    "Organization treasury live balance is below the requested withdrawal".into(),
                ));
            }
        }
        FUND_ACTION => {
            let coin = parse_coin(required(parameters, "coinType")?)?;
            validate_coin(
                state,
                auth,
                required(parameters, "paymentCoinId")?,
                &coin,
                required(parameters, "amountBaseUnits")?,
            )
            .await?;
        }
        _ => unreachable!(),
    }
    Ok(())
}

pub async fn validate_approval_signer(
    state: &AppState,
    auth: &AuthInfo,
    action: &str,
    parameters: &Value,
    signer_address: &str,
) -> Result<(), AppError> {
    if !is_action(action) {
        if same(signer_address, &auth.owner) {
            return Ok(());
        }
        return Err(AppError::Forbidden(
            "A separate signer is supported only for organization treasury administration".into(),
        ));
    }
    if same(signer_address, &auth.owner) {
        return Ok(());
    }
    if !matches!(action, GRANT_ACTION | WITHDRAW_ACTION) {
        return Err(AppError::Forbidden(
            "Only the account owner may fund an organization treasury".into(),
        ));
    }
    let organization_id =
        id(required(parameters, "organizationId")?).map_err(|_| bad("Invalid organizationId"))?;
    organization_scope(state, auth, parameters, true).await?;
    let is_admin = crate::org_chain::verify_org_treasury_admin(
        &state.http_client,
        &state.config.myso_rpc_url,
        &state.config.package_id,
        &organization_id,
        signer_address,
    )
    .await
    .map_err(|error| {
        AppError::Forbidden(format!(
            "live organization treasury signer verification failed: {error}"
        ))
    })?;
    if !is_admin {
        return Err(AppError::Forbidden("Treasury signer is neither the organization owner nor a live permission-group administrator".into()));
    }
    Ok(())
}

pub fn receipt_context(
    action: &str,
    parameters: &Value,
    owner: &str,
    account_id: &str,
) -> Result<Option<Value>, AppError> {
    if !is_action(action) {
        return Ok(None);
    }
    let mut context = parameters.clone();
    let map = context
        .as_object_mut()
        .ok_or_else(|| bad("Organization treasury receipt parameters must be an object"))?;
    map.insert(
        "organizationId".into(),
        json!(id(required(parameters, "organizationId")?)
            .map_err(|_| bad("Invalid organizationId"))?),
    );
    map.insert("owner".into(), json!(id(owner)?));
    map.insert("accountId".into(), json!(id(account_id)?));
    if action != GRANT_ACTION {
        map.insert(
            "coinType".into(),
            json!(parse_coin(required(parameters, "coinType")?)?),
        );
    }
    Ok(Some(context))
}

async fn receipt(state: &AppState, auth: &AuthInfo, digest: &str) -> Result<Value, AppError> {
    digest_bytes(digest).map_err(|_| bad("Invalid organization treasury receipt digest"))?;
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
        AppError::BlobNotFound(
            "Organization treasury receipt is outside this account/agent scope".into(),
        )
    })?;
    let context = row.receipt_context.as_ref().ok_or_else(|| {
        AppError::Conflict("Organization treasury receipt context is unavailable".into())
    })?;
    if !same(
        context
            .get("owner")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?,
        &auth.owner,
    ) || !same(
        context
            .get("accountId")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?,
        &auth.account_id,
    ) {
        return Err(AppError::BlobNotFound(
            "Organization treasury receipt is outside this owner account".into(),
        ));
    }
    let transaction = rpc(
        state,
        "myso_getTransactionBlock",
        json!([digest,{"showEffects":true,"showEvents":true}]),
    )
    .await?;
    if transaction.get("digest").and_then(Value::as_str) != Some(digest) {
        return Err(invalid());
    }
    let sender = transaction
        .pointer("/transaction/data/sender")
        .or_else(|| transaction.pointer("/transaction/sender"))
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    if !same(sender, &row.sender) {
        return Err(AppError::Conflict(
            "Organization treasury receipt signer does not match the exact approved signer".into(),
        ));
    }
    let chain_status = transaction
        .pointer("/effects/status/status")
        .and_then(Value::as_str);
    let checkpoint = transaction
        .get("checkpoint")
        .filter(|value| !value.is_null());
    let finalized = chain_status == Some("success") && checkpoint.is_some();
    let event_name = match row.registry_action.as_str() {
        GRANT_ACTION => "OrgTreasuryAccessChanged",
        WITHDRAW_ACTION => "OrgTreasuryWithdrawn",
        FUND_ACTION => "OrgTreasuryFunded",
        _ => return Err(invalid()),
    };
    let expected_event = coin_type(&format!(
        "{}::memory::{event_name}",
        state.config.package_id
    ))?;
    let events = transaction
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    let matches: Vec<&Value> = events
        .iter()
        .filter(|event| {
            let Ok(event_type) = coin_type(event.get("type").and_then(Value::as_str).unwrap_or(""))
            else {
                return false;
            };
            if event_type != expected_event {
                return false;
            }
            let Some(data) = event.get("parsedJson") else {
                return false;
            };
            if !data
                .get("organization_id")
                .and_then(Value::as_str)
                .is_some_and(|v| same(v, context["organizationId"].as_str().unwrap_or("")))
            {
                return false;
            }
            match row.registry_action.as_str() {
                GRANT_ACTION => {
                    data.get("recipient")
                        .and_then(Value::as_str)
                        .is_some_and(|v| same(v, context["recipient"].as_str().unwrap_or("")))
                        && data.get("has_access") == context.get("hasAccess")
                        && data
                            .get("updated_by")
                            .and_then(Value::as_str)
                            .is_some_and(|v| same(v, &row.sender))
                }
                WITHDRAW_ACTION => {
                    data.get("recipient")
                        .and_then(Value::as_str)
                        .is_some_and(|v| same(v, context["recipient"].as_str().unwrap_or("")))
                        && data
                            .get("withdrawn_by")
                            .and_then(Value::as_str)
                            .is_some_and(|v| same(v, &row.sender))
                        && data.get("amount").is_some_and(|v| {
                            u64_value(Some(v)).ok()
                                == context
                                    .get("amountBaseUnits")
                                    .and_then(Value::as_str)
                                    .and_then(|s| s.parse::<u64>().ok())
                        })
                        && event_coin_matches(data.get("coin_type"), context.get("coinType"))
                }
                FUND_ACTION => {
                    data.get("amount").is_some_and(|v| {
                        u64_value(Some(v)).ok()
                            == context
                                .get("amountBaseUnits")
                                .and_then(Value::as_str)
                                .and_then(|s| s.parse::<u64>().ok())
                    }) && data
                        .get("funded_by")
                        .and_then(Value::as_str)
                        .is_some_and(|v| same(v, &auth.owner))
                        && event_coin_matches(data.get("coin_type"), context.get("coinType"))
                }
                _ => false,
            }
        })
        .collect();
    if finalized && matches.len() != 1 {
        return Err(AppError::Conflict(
            "Unique organization treasury event could not be verified".into(),
        ));
    }
    Ok(
        json!({"digest":digest,"registryAction":row.registry_action,"status":match chain_status {Some("success") if finalized=>"finalized",Some("success")=>"checkpoint_pending",Some("failure")=>"failed",_=>"unknown"},"checkpoint":checkpoint.map(Value::to_string),"organizationId":context["organizationId"],"event":matches.first().map(|value|*value),"evidenceSource":"configured_fullnode_and_scoped_preparation"}),
    )
}

fn event_coin_matches(value: Option<&Value>, expected: Option<&Value>) -> bool {
    let Some(expected) = expected.and_then(Value::as_str) else {
        return false;
    };
    let actual = value.and_then(|v| {
        v.as_str().or_else(|| {
            v.pointer("/fields/name")
                .or_else(|| v.get("name"))
                .and_then(Value::as_str)
        })
    });
    actual
        .and_then(|value| coin_type(value).ok())
        .is_some_and(|value| value == expected)
}

pub async fn read(state: &Arc<AppState>, auth: &AuthInfo, digest: &str) -> Result<Value, AppError> {
    receipt(state, auth, digest).await
}
