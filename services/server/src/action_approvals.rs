use sqlx::FromRow;

use crate::db::VectorDb;
use crate::memory_contract::addresses_equal;
use crate::types::AppError;

#[derive(Debug, Clone, FromRow)]
pub struct ActionApprovalRow {
    pub approval_id: String,
    pub account_id: String,
    pub agent_object_id: String,
    pub registry_action: String,
    pub registry_version: String,
    pub idempotency_key: String,
    pub parameter_hash: String,
    pub required_capability: i64,
    pub risk_tier: String,
    pub owner_address: String,
    pub approval_intent: String,
    pub status: String,
    pub expires_at_ms: i64,
    pub consumed_action_scope: Option<String>,
}

pub struct NewActionApproval<'a> {
    pub approval_id: &'a str,
    pub account_id: &'a str,
    pub agent_object_id: &'a str,
    pub registry_action: &'a str,
    pub registry_version: &'a str,
    pub idempotency_key: &'a str,
    pub parameter_hash: &'a str,
    pub required_capability: u64,
    pub risk_tier: &'a str,
    pub owner_address: &'a str,
    pub approval_intent: &'a str,
    pub expires_at_ms: i64,
}

pub async fn create_or_get(
    db: &VectorDb,
    input: &NewActionApproval<'_>,
) -> Result<ActionApprovalRow, AppError> {
    sqlx::query(
        "INSERT INTO chain_action_approvals (
            approval_id,account_id,agent_object_id,registry_action,registry_version,
            idempotency_key,parameter_hash,required_capability,risk_tier,owner_address,
            approval_intent,expires_at_ms
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (account_id,agent_object_id,registry_action,idempotency_key) DO NOTHING",
    )
    .bind(input.approval_id)
    .bind(input.account_id)
    .bind(input.agent_object_id)
    .bind(input.registry_action)
    .bind(input.registry_version)
    .bind(input.idempotency_key)
    .bind(input.parameter_hash)
    .bind(
        i64::try_from(input.required_capability)
            .map_err(|_| AppError::BadRequest("capability exceeds BIGINT".into()))?,
    )
    .bind(input.risk_tier)
    .bind(input.owner_address)
    .bind(input.approval_intent)
    .bind(input.expires_at_ms)
    .execute(db.pool())
    .await
    .map_err(|error| AppError::Internal(format!("create action approval: {error}")))?;

    let row = get_by_identity(
        db,
        input.account_id,
        input.agent_object_id,
        input.registry_action,
        input.idempotency_key,
    )
    .await?
    .ok_or_else(|| AppError::Internal("action approval disappeared".into()))?;
    if row.registry_version != input.registry_version
        || row.parameter_hash != input.parameter_hash
        || row.required_capability != input.required_capability as i64
        || row.risk_tier != input.risk_tier
        || !addresses_equal(&row.owner_address, input.owner_address)
    {
        return Err(AppError::Conflict(
            "approval idempotency key was used with different input".into(),
        ));
    }
    Ok(row)
}

pub async fn get(db: &VectorDb, approval_id: &str) -> Result<Option<ActionApprovalRow>, AppError> {
    query_one(
        db,
        "SELECT approval_id,account_id,agent_object_id,registry_action,registry_version,idempotency_key,parameter_hash,required_capability,risk_tier,owner_address,approval_intent,status,expires_at_ms,consumed_action_scope FROM chain_action_approvals WHERE approval_id=$1",
        &[approval_id],
    )
    .await
}

async fn get_by_identity(
    db: &VectorDb,
    account_id: &str,
    agent_object_id: &str,
    registry_action: &str,
    idempotency_key: &str,
) -> Result<Option<ActionApprovalRow>, AppError> {
    sqlx::query_as::<_, ActionApprovalRow>(
        "SELECT approval_id,account_id,agent_object_id,registry_action,registry_version,idempotency_key,parameter_hash,required_capability,risk_tier,owner_address,approval_intent,status,expires_at_ms,consumed_action_scope FROM chain_action_approvals WHERE account_id=$1 AND agent_object_id=$2 AND registry_action=$3 AND idempotency_key=$4",
    )
    .bind(account_id)
    .bind(agent_object_id)
    .bind(registry_action)
    .bind(idempotency_key)
    .fetch_optional(db.pool())
    .await
    .map_err(|error| AppError::Internal(format!("read action approval: {error}")))
}

async fn query_one(
    db: &VectorDb,
    sql: &str,
    bindings: &[&str],
) -> Result<Option<ActionApprovalRow>, AppError> {
    debug_assert_eq!(bindings.len(), 1);
    sqlx::query_as::<_, ActionApprovalRow>(sql)
        .bind(bindings[0])
        .fetch_optional(db.pool())
        .await
        .map_err(|error| AppError::Internal(format!("read action approval: {error}")))
}

pub async fn approve(
    db: &VectorDb,
    approval_id: &str,
    signer_address: &str,
    public_key_hex: &str,
    wallet_signature: &str,
    now_ms: i64,
) -> Result<ActionApprovalRow, AppError> {
    let row = get(db, approval_id)
        .await?
        .ok_or_else(|| AppError::BadRequest("unknown approval request".into()))?;
    if row.expires_at_ms <= now_ms {
        return Err(AppError::Conflict("approval request expired".into()));
    }
    if !addresses_equal(signer_address, &row.owner_address) {
        return Err(AppError::Forbidden(
            "approval wallet is not the account owner".into(),
        ));
    }
    let updated = sqlx::query(
        "UPDATE chain_action_approvals SET status='approved',owner_public_key=$2,owner_signature=$3,approved_at_ms=$4,updated_at=NOW() WHERE approval_id=$1 AND status='pending'",
    )
    .bind(approval_id)
    .bind(public_key_hex)
    .bind(wallet_signature)
    .bind(now_ms)
    .execute(db.pool())
    .await
    .map_err(|error| AppError::Internal(format!("approve action request: {error}")))?;
    if updated.rows_affected() == 0 && row.status != "approved" && row.status != "consumed" {
        return Err(AppError::Conflict("approval request is not pending".into()));
    }
    get(db, approval_id)
        .await?
        .ok_or_else(|| AppError::Internal("approved action request disappeared".into()))
}

pub fn assert_matches(
    row: &ActionApprovalRow,
    account_id: &str,
    agent_object_id: &str,
    registry_action: &str,
    registry_version: &str,
    idempotency_key: &str,
    parameter_hash: &str,
    required_capability: u64,
    risk_tier: &str,
    now_ms: i64,
) -> Result<(), AppError> {
    if row.expires_at_ms <= now_ms {
        return Err(AppError::Conflict("owner approval expired".into()));
    }
    if row.status != "approved" && row.status != "consumed" {
        return Err(AppError::ActionApprovalRequired(
            "the owner has not approved this action".into(),
        ));
    }
    if row.account_id != account_id
        || row.agent_object_id != agent_object_id
        || row.registry_action != registry_action
        || row.registry_version != registry_version
        || row.idempotency_key != idempotency_key
        || row.parameter_hash != parameter_hash
        || row.required_capability != required_capability as i64
        || row.risk_tier != risk_tier
    {
        return Err(AppError::Conflict(
            "owner approval does not match the requested action".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_match_binds_every_security_dimension() {
        let row = ActionApprovalRow {
            approval_id: "a".into(),
            account_id: "account".into(),
            agent_object_id: "agent".into(),
            registry_action: "social.delete_post.v1".into(),
            registry_version: "1.0.0".into(),
            idempotency_key: "delete-1".into(),
            parameter_hash: "sha256:p".into(),
            required_capability: 16,
            risk_tier: "3".into(),
            owner_address: "0x1".into(),
            approval_intent: "intent".into(),
            status: "approved".into(),
            expires_at_ms: 100,
            consumed_action_scope: None,
        };
        assert!(assert_matches(
            &row,
            "account",
            "agent",
            "social.delete_post.v1",
            "1.0.0",
            "delete-1",
            "sha256:p",
            16,
            "3",
            1
        )
        .is_ok());
        assert!(assert_matches(
            &row,
            "account",
            "agent",
            "social.delete_post.v1",
            "1.0.0",
            "delete-1",
            "sha256:other",
            16,
            "3",
            1
        )
        .is_err());
    }
}
