//! Scoped receipts for organization lifecycle, role and invitation actions.
use crate::chain_reads::{coin_type, digest_bytes, id, rpc, same, u64_value};
use crate::types::{AppError, AppState, AuthInfo};
use serde_json::{json, Value};
use std::sync::Arc;

const ACTIONS: &[&str] = &[
    "organization.create.v1",
    "organization.update_metadata.v1",
    "organization.update_category.v1",
    "organization.deactivate.v1",
    "organization.ensure_memory_group.v1",
    "organization.define_role.v1",
    "organization.assign_role.v1",
    "organization.revoke_role.v1",
    "organization.create_invitation.v1",
    "organization.accept_invitation.v1",
    "organization.decline_invitation.v1",
];

fn invalid() -> AppError {
    AppError::Internal("Organization action chain evidence is invalid or unavailable".into())
}
fn bad(message: &str) -> AppError {
    AppError::BadRequest(message.into())
}

pub fn is_action(action: &str) -> bool {
    ACTIONS.contains(&action)
}

/// Store only bounded public action inputs plus the authenticated account binding.
/// The transaction sender is independently recorded by the preparation journal.
pub fn receipt_context(
    action: &str,
    parameters: &Value,
    owner: &str,
    account_id: &str,
) -> Result<Option<Value>, AppError> {
    if !is_action(action) {
        return Ok(None);
    }
    let mut context = parameters
        .as_object()
        .cloned()
        .ok_or_else(|| bad("Organization action parameters must be an object"))?;
    context.insert("owner".into(), json!(id(owner)?));
    context.insert("accountId".into(), json!(id(account_id)?));
    if action != "organization.create.v1" {
        let organization_id = id(context
            .get("organizationId")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?)?;
        context.insert("organizationId".into(), json!(organization_id));
    }
    if let Some(group) = context.get("orgMemoryGroupId").and_then(Value::as_str) {
        context.insert("orgMemoryGroupId".into(), json!(id(group)?));
    }
    if let Some(address) = context.get("memberAddress").and_then(Value::as_str) {
        context.insert("memberAddress".into(), json!(id(address)?));
    }
    if let Some(address) = context.get("invitee").and_then(Value::as_str) {
        context.insert("invitee".into(), json!(id(address)?));
    }
    if let Some(account) = context.get("organizationAccountId").and_then(Value::as_str) {
        context.insert("organizationAccountId".into(), json!(id(account)?));
    }
    Ok(Some(Value::Object(context)))
}

fn same_address_field(event: &Value, context: &Value, event_key: &str, context_key: &str) -> bool {
    event
        .get(event_key)
        .and_then(Value::as_str)
        .zip(context.get(context_key).and_then(Value::as_str))
        .is_some_and(|(actual, expected)| same(actual, expected))
}

fn same_string_field(event: &Value, context: &Value, event_key: &str, context_key: &str) -> bool {
    event.get(event_key).and_then(Value::as_str) == context.get(context_key).and_then(Value::as_str)
}

fn same_optional_field(event: &Value, context: &Value, field: &str) -> bool {
    let actual = event.get(field).filter(|value| !value.is_null());
    let expected = context.get(field).filter(|value| !value.is_null());
    actual == expected
}

fn same_u64_field(event: &Value, context: &Value, event_key: &str, context_key: &str) -> bool {
    u64_value(event.get(event_key)).ok()
        == context
            .get(context_key)
            .and_then(|value| u64_value(Some(value)).ok())
        && u64_value(event.get(event_key)).is_ok()
}

fn expected_event(action: &str) -> Option<&'static str> {
    Some(match action {
        "organization.create.v1" => "AgenticOrganizationCreated",
        "organization.update_metadata.v1" => "AgenticOrganizationUpdated",
        "organization.update_category.v1" => "AgenticOrganizationCategoryUpdated",
        "organization.deactivate.v1" => "AgenticOrganizationDeactivated",
        "organization.ensure_memory_group.v1" => "OrgMemoryGroupCreated",
        "organization.define_role.v1" => "OrgRoleDefined",
        "organization.assign_role.v1" => "OrgRoleAssigned",
        "organization.revoke_role.v1" => "OrgRoleRevoked",
        "organization.create_invitation.v1" => "OrgInvitationCreated",
        "organization.accept_invitation.v1" => "OrgInvitationAccepted",
        "organization.decline_invitation.v1" => "OrgInvitationDeclined",
        _ => return None,
    })
}

async fn verify_organization_owner(
    state: &AppState,
    organization_id: &str,
    context: &Value,
    action: &str,
) -> Result<bool, AppError> {
    let object = crate::chain_reads::object(state, organization_id).await?;
    let expected_type = coin_type(&format!(
        "{}::memory::AgenticOrganization",
        state.config.package_id
    ))?;
    let actual_type = object
        .pointer("/content/type")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    if coin_type(actual_type)? != expected_type {
        return Ok(false);
    }
    let fields = object.pointer("/content/fields").ok_or_else(invalid)?;
    let account_key = if matches!(
        action,
        "organization.accept_invitation.v1" | "organization.decline_invitation.v1"
    ) {
        "organizationAccountId"
    } else {
        "accountId"
    };
    let account_matches = fields
        .get("memory_account_id")
        .and_then(Value::as_str)
        .is_some_and(|value| {
            context
                .get(account_key)
                .and_then(Value::as_str)
                .is_some_and(|expected| same(value, expected))
        });
    let owner_matches = matches!(
        action,
        "organization.accept_invitation.v1" | "organization.decline_invitation.v1"
    ) || fields
        .get("principal_owner")
        .and_then(Value::as_str)
        .is_some_and(|value| {
            context
                .get("owner")
                .and_then(Value::as_str)
                .is_some_and(|expected| same(value, expected))
        });
    Ok(account_matches && owner_matches)
}

fn event_matches(
    action: &str,
    event: &Value,
    context: &Value,
    sender: &str,
    package: &str,
) -> Result<bool, AppError> {
    let event_type = coin_type(event.get("type").and_then(Value::as_str).unwrap_or(""))?;
    if event_type
        != coin_type(&format!(
            "{package}::memory::{}",
            expected_event(action).ok_or_else(invalid)?
        ))?
    {
        return Ok(false);
    }
    let Some(data) = event.get("parsedJson") else {
        return Ok(false);
    };
    let org_matches = || same_address_field(data, context, "organization_id", "organizationId");
    let account_key = if matches!(
        action,
        "organization.accept_invitation.v1" | "organization.decline_invitation.v1"
    ) {
        "organizationAccountId"
    } else {
        "accountId"
    };
    let account_matches = || same_address_field(data, context, "account_id", account_key);
    let sender_matches = |key: &str| {
        data.get(key)
            .and_then(Value::as_str)
            .is_some_and(|value| same(value, sender))
    };
    let owner_signed = || {
        context
            .get("owner")
            .and_then(Value::as_str)
            .is_some_and(|owner| same(owner, sender))
    };
    Ok(match action {
        "organization.create.v1" => {
            same_address_field(data, context, "account_id", "accountId")
                && same_address_field(data, context, "principal_owner", "owner")
                && owner_signed()
                && same_u64_field(data, context, "org_type", "orgType")
                && same_optional_field(data, context, "name")
                && same_optional_field(data, context, "description")
        }
        "organization.update_metadata.v1" => {
            org_matches()
                && owner_signed()
                && same_optional_field(data, context, "name")
                && same_optional_field(data, context, "description")
        }
        "organization.update_category.v1" => {
            org_matches() && owner_signed() && same_u64_field(data, context, "org_type", "orgType")
        }
        "organization.deactivate.v1" => org_matches() && owner_signed(),
        "organization.ensure_memory_group.v1" => {
            org_matches()
                && owner_signed()
                && account_matches()
                && same_address_field(data, context, "principal_owner", "owner")
                && crate::org_chain::org_memory_group_id(
                    package,
                    context["organizationId"].as_str().ok_or_else(invalid)?,
                )
                .is_some_and(|expected| {
                    data.get("group_id")
                        .and_then(Value::as_str)
                        .is_some_and(|actual| same(actual, &expected))
                })
        }
        "organization.define_role.v1" => {
            org_matches()
                && account_matches()
                && same_string_field(data, context, "role_name", "roleName")
                && same_u64_field(data, context, "mask", "permissionsMask")
                && sender_matches("defined_by")
        }
        "organization.assign_role.v1" => {
            org_matches()
                && account_matches()
                && same_address_field(data, context, "member", "memberAddress")
                && same_string_field(data, context, "role_name", "roleName")
                && sender_matches("assigned_by")
                && crate::org_chain::org_memory_group_id(
                    package,
                    context["organizationId"].as_str().ok_or_else(invalid)?,
                )
                .is_some_and(|expected| {
                    data.get("group_id")
                        .and_then(Value::as_str)
                        .is_some_and(|actual| same(actual, &expected))
                })
        }
        "organization.revoke_role.v1" => {
            org_matches()
                && account_matches()
                && same_address_field(data, context, "member", "memberAddress")
                && same_string_field(data, context, "role_name", "roleName")
                && sender_matches("revoked_by")
                && crate::org_chain::org_memory_group_id(
                    package,
                    context["organizationId"].as_str().ok_or_else(invalid)?,
                )
                .is_some_and(|expected| {
                    data.get("group_id")
                        .and_then(Value::as_str)
                        .is_some_and(|actual| same(actual, &expected))
                })
        }
        "organization.create_invitation.v1" => {
            org_matches()
                && account_matches()
                && same_address_field(data, context, "invitee", "invitee")
                && data.get("role_name").unwrap_or(&Value::Null)
                    == context.get("roleName").unwrap_or(&Value::Null)
                && same_u64_field(data, context, "permissions_mask", "permissionsMask")
                && sender_matches("invited_by")
                && (context.get("expiresAtMs").is_none()
                    || data.get("expires_at_ms").unwrap_or(&Value::Null)
                        == context.get("expiresAtMs").unwrap_or(&Value::Null))
        }
        "organization.accept_invitation.v1" => {
            org_matches()
                && account_matches()
                && same_address_field(data, context, "invitee", "invitee")
                && sender_matches("accepted_by")
                && crate::org_chain::org_memory_group_id(
                    package,
                    context["organizationId"].as_str().ok_or_else(invalid)?,
                )
                .is_some_and(|expected| {
                    data.get("group_id")
                        .and_then(Value::as_str)
                        .is_some_and(|actual| same(actual, &expected))
                })
        }
        "organization.decline_invitation.v1" => {
            org_matches()
                && account_matches()
                && same_address_field(data, context, "invitee", "invitee")
                && sender_matches("declined_by")
        }
        _ => false,
    })
}

pub async fn read(state: &Arc<AppState>, auth: &AuthInfo, digest: &str) -> Result<Value, AppError> {
    digest_bytes(digest).map_err(|_| bad("Invalid organization action receipt digest"))?;
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
            "Organization action receipt is outside this account/agent scope".into(),
        )
    })?;
    let context = row.receipt_context.as_ref().ok_or_else(|| {
        AppError::Conflict("Organization action receipt context is unavailable".into())
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
            "Organization action receipt is outside this owner account".into(),
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
            "Organization action signer does not match the prepared signer".into(),
        ));
    }
    let chain_status = transaction
        .pointer("/effects/status/status")
        .and_then(Value::as_str);
    let checkpoint = transaction
        .get("checkpoint")
        .filter(|value| !value.is_null())
        .map(|value| u64_value(Some(value)))
        .transpose()?;
    let finalized = chain_status == Some("success") && checkpoint.is_some();
    let mut matches = Vec::new();
    if chain_status == Some("success") {
        for event in transaction
            .get("events")
            .and_then(Value::as_array)
            .ok_or_else(invalid)?
        {
            if event_matches(
                &row.registry_action,
                event,
                context,
                sender,
                &state.config.package_id,
            )? {
                let organization_id = if row.registry_action == "organization.create.v1" {
                    event
                        .pointer("/parsedJson/organization_id")
                        .and_then(Value::as_str)
                        .ok_or_else(invalid)?
                } else {
                    context
                        .get("organizationId")
                        .and_then(Value::as_str)
                        .ok_or_else(invalid)?
                };
                if !verify_organization_owner(state, organization_id, context, &row.registry_action)
                    .await?
                {
                    return Err(AppError::Conflict(
                        "The organization event is not linked to this authenticated MemoryAccount"
                            .into(),
                    ));
                }
                matches.push(event);
            }
        }
    }
    if chain_status == Some("success") && matches.len() != 1 {
        return Err(AppError::Conflict(
            "The successful transaction does not contain exactly one matching organization event"
                .into(),
        ));
    }
    Ok(
        json!({"digest":digest,"registryAction":row.registry_action,"accountId":auth.account_id,"agentId":auth.agent_object_id,
        "status":match chain_status {Some("success") if finalized=>"finalized",Some("success")=>"executed",Some("failure")=>"failed",_=>"unknown"},
        "checkpoint":checkpoint.map(|value|value.to_string()),"events":matches,"preparedContext":context,
        "evidenceSource":"configured_fullnode_and_scoped_preparation"}),
    )
}
