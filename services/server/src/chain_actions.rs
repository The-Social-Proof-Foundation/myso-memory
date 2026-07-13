use serde_json::Value;
use sqlx::FromRow;

use crate::db::VectorDb;
use crate::types::AppError;

pub const STATUS_PREPARING: &str = "preparing";
pub const STATUS_SPONSORED: &str = "sponsored";
pub const STATUS_SUBMITTING: &str = "submitting";
pub const STATUS_EXECUTED: &str = "executed";
pub const STATUS_FAILED: &str = "failed";

#[derive(Debug, Clone, FromRow)]
pub struct ChainActionRow {
    pub idempotency_scope: String,
    pub account_id: String,
    pub agent_object_id: String,
    pub registry_action: String,
    pub registry_version: String,
    pub idempotency_key: String,
    pub parameter_hash: String,
    pub transaction_kind_hash: String,
    pub package_id: String,
    pub package_version: String,
    pub sender: String,
    pub approval_id: Option<String>,
    pub sponsored_bytes: Option<String>,
    pub digest: Option<String>,
    pub signature_hash: Option<String>,
    pub status: String,
    pub simulation_response: Option<Value>,
    pub execution_response: Option<Value>,
    pub expires_at_ms: i64,
}

pub struct NewChainAction<'a> {
    pub idempotency_scope: &'a str,
    pub account_id: &'a str,
    pub agent_object_id: &'a str,
    pub registry_action: &'a str,
    pub registry_version: &'a str,
    pub idempotency_key: &'a str,
    pub parameter_hash: &'a str,
    pub transaction_kind_hash: &'a str,
    pub package_id: &'a str,
    pub package_version: &'a str,
    pub sender: &'a str,
    pub approval_id: Option<&'a str>,
    pub prepared_at_ms: i64,
    pub expires_at_ms: i64,
}

pub enum PrepareClaim {
    Created,
    Existing(ChainActionRow),
    InProgress,
    Conflict,
    Failed,
    Expired,
}

pub enum SubmitClaim {
    Execute(ChainActionRow),
    Existing(Value),
    Conflict,
    Failed,
    Expired,
}

fn same_preparation(row: &ChainActionRow, input: &NewChainAction<'_>) -> bool {
    row.account_id == input.account_id
        && row.agent_object_id == input.agent_object_id
        && row.registry_action == input.registry_action
        && row.registry_version == input.registry_version
        && row.idempotency_key == input.idempotency_key
        && row.parameter_hash == input.parameter_hash
        && row.transaction_kind_hash == input.transaction_kind_hash
        && row.package_id == input.package_id
        && row.package_version == input.package_version
        && row.sender == input.sender
        && row.approval_id.as_deref() == input.approval_id
}

pub async fn claim_preparation(
    db: &VectorDb,
    input: &NewChainAction<'_>,
    now_ms: i64,
) -> Result<PrepareClaim, AppError> {
    let mut tx =
        db.pool().begin().await.map_err(|error| {
            AppError::Internal(format!("begin chain action preparation: {error}"))
        })?;
    let inserted = sqlx::query(
        "INSERT INTO chain_action_requests (
            idempotency_scope, account_id, agent_object_id, registry_action,
            registry_version, idempotency_key, parameter_hash,
            transaction_kind_hash, package_id, package_version, sender, approval_id, status,
            prepared_at_ms, expires_at_ms
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'preparing',$13,$14)
         ON CONFLICT (account_id, agent_object_id, registry_action, idempotency_key)
         DO NOTHING",
    )
    .bind(input.idempotency_scope)
    .bind(input.account_id)
    .bind(input.agent_object_id)
    .bind(input.registry_action)
    .bind(input.registry_version)
    .bind(input.idempotency_key)
    .bind(input.parameter_hash)
    .bind(input.transaction_kind_hash)
    .bind(input.package_id)
    .bind(input.package_version)
    .bind(input.sender)
    .bind(input.approval_id)
    .bind(input.prepared_at_ms)
    .bind(input.expires_at_ms)
    .execute(&mut *tx)
    .await
    .map_err(|error| AppError::Internal(format!("claim chain action preparation: {error}")))?;

    let row = sqlx::query_as::<_, ChainActionRow>(
        "SELECT idempotency_scope, account_id, agent_object_id, registry_action,
                registry_version, idempotency_key, parameter_hash,
                transaction_kind_hash, package_id, package_version, sender, approval_id,
                sponsored_bytes, digest, signature_hash, status, simulation_response,
                execution_response, expires_at_ms
         FROM chain_action_requests
         WHERE account_id = $1 AND agent_object_id = $2
           AND registry_action = $3 AND idempotency_key = $4",
    )
    .bind(input.account_id)
    .bind(input.agent_object_id)
    .bind(input.registry_action)
    .bind(input.idempotency_key)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|error| AppError::Internal(format!("read claimed chain action: {error}")))?
    .ok_or_else(|| AppError::Internal("claimed chain action row disappeared".into()))?;

    if !same_preparation(&row, input) {
        tx.rollback().await.ok();
        return Ok(PrepareClaim::Conflict);
    }
    if row.expires_at_ms <= now_ms && row.status != STATUS_EXECUTED {
        tx.rollback().await.ok();
        return Ok(PrepareClaim::Expired);
    }
    if inserted.rows_affected() == 1 {
        if let Some(approval_id) = input.approval_id {
            let consumed = sqlx::query(
                "UPDATE chain_action_approvals SET status='consumed',consumed_action_scope=$2,updated_at=NOW() WHERE approval_id=$1 AND (status='approved' OR (status='consumed' AND consumed_action_scope=$2))",
            )
            .bind(approval_id)
            .bind(input.idempotency_scope)
            .execute(&mut *tx)
            .await
            .map_err(|error| AppError::Internal(format!("bind action approval: {error}")))?;
            if consumed.rows_affected() != 1 {
                tx.rollback().await.ok();
                return Ok(PrepareClaim::Conflict);
            }
        }
        tx.commit().await.map_err(|error| {
            AppError::Internal(format!("commit chain action preparation: {error}"))
        })?;
        return Ok(PrepareClaim::Created);
    }
    let claim = match row.status.as_str() {
        STATUS_SPONSORED | STATUS_EXECUTED => PrepareClaim::Existing(row),
        STATUS_PREPARING | STATUS_SUBMITTING => PrepareClaim::InProgress,
        STATUS_FAILED => PrepareClaim::Failed,
        _ => PrepareClaim::Conflict,
    };
    tx.commit()
        .await
        .map_err(|error| AppError::Internal(format!("commit chain action replay: {error}")))?;
    Ok(claim)
}

pub async fn complete_preparation(
    db: &VectorDb,
    idempotency_scope: &str,
    sponsored_bytes: &str,
    digest: &str,
    simulation: &Value,
) -> Result<(), AppError> {
    let result = sqlx::query(
        "UPDATE chain_action_requests
         SET status = 'sponsored', sponsored_bytes = $2, digest = $3,
             simulation_response = $4,
             updated_at = NOW()
         WHERE idempotency_scope = $1 AND status = 'preparing'",
    )
    .bind(idempotency_scope)
    .bind(sponsored_bytes)
    .bind(digest)
    .bind(simulation)
    .execute(db.pool())
    .await
    .map_err(|error| AppError::Internal(format!("complete chain action preparation: {error}")))?;
    if result.rows_affected() != 1 {
        return Err(AppError::Internal(
            "chain action preparation changed concurrently".into(),
        ));
    }
    Ok(())
}

pub async fn mark_failed(
    db: &VectorDb,
    idempotency_scope: &str,
    reason: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE chain_action_requests
         SET status = 'failed', failure_reason = $2, updated_at = NOW()
         WHERE idempotency_scope = $1 AND status <> 'executed'",
    )
    .bind(idempotency_scope)
    .bind(reason)
    .execute(db.pool())
    .await
    .map_err(|error| AppError::Internal(format!("mark chain action failed: {error}")))?;
    Ok(())
}

pub async fn claim_submission(
    db: &VectorDb,
    account_id: &str,
    agent_object_id: &str,
    registry_action: &str,
    idempotency_key: &str,
    digest: &str,
    signature_hash: &str,
    now_ms: i64,
) -> Result<SubmitClaim, AppError> {
    let Some(row) = get_by_identity(
        db,
        account_id,
        agent_object_id,
        registry_action,
        idempotency_key,
    )
    .await?
    else {
        return Ok(SubmitClaim::Conflict);
    };

    if row.digest.as_deref() != Some(digest) {
        return Ok(SubmitClaim::Conflict);
    }
    if row.expires_at_ms <= now_ms && row.status != STATUS_EXECUTED {
        return Ok(SubmitClaim::Expired);
    }
    if row.status == STATUS_EXECUTED {
        return Ok(row
            .execution_response
            .map(SubmitClaim::Existing)
            .unwrap_or(SubmitClaim::Conflict));
    }
    if row.status == STATUS_FAILED {
        return Ok(SubmitClaim::Failed);
    }
    if row.status == STATUS_SUBMITTING {
        return Ok(if row.signature_hash.as_deref() == Some(signature_hash) {
            SubmitClaim::Execute(row)
        } else {
            SubmitClaim::Conflict
        });
    }
    if row.status != STATUS_SPONSORED {
        return Ok(SubmitClaim::Conflict);
    }

    let updated = sqlx::query(
        "UPDATE chain_action_requests
         SET status = 'submitting', signature_hash = $2, updated_at = NOW()
         WHERE idempotency_scope = $1 AND status = 'sponsored'",
    )
    .bind(&row.idempotency_scope)
    .bind(signature_hash)
    .execute(db.pool())
    .await
    .map_err(|error| AppError::Internal(format!("claim chain action submission: {error}")))?;
    if updated.rows_affected() != 1 {
        return Ok(SubmitClaim::Conflict);
    }
    Ok(SubmitClaim::Execute(row))
}

pub async fn complete_submission(
    db: &VectorDb,
    idempotency_scope: &str,
    response: &Value,
) -> Result<(), AppError> {
    let result = sqlx::query(
        "UPDATE chain_action_requests
         SET status = 'executed', execution_response = $2, updated_at = NOW()
         WHERE idempotency_scope = $1 AND status = 'submitting'",
    )
    .bind(idempotency_scope)
    .bind(response)
    .execute(db.pool())
    .await
    .map_err(|error| AppError::Internal(format!("complete chain action submission: {error}")))?;
    if result.rows_affected() != 1 {
        return Err(AppError::Internal(
            "chain action submission changed concurrently".into(),
        ));
    }
    Ok(())
}

pub async fn get_by_identity(
    db: &VectorDb,
    account_id: &str,
    agent_object_id: &str,
    registry_action: &str,
    idempotency_key: &str,
) -> Result<Option<ChainActionRow>, AppError> {
    sqlx::query_as::<_, ChainActionRow>(
        "SELECT idempotency_scope, account_id, agent_object_id, registry_action,
                registry_version, idempotency_key, parameter_hash,
                transaction_kind_hash, package_id, package_version, sender, approval_id,
                sponsored_bytes, digest, signature_hash, status, simulation_response,
                execution_response, expires_at_ms
         FROM chain_action_requests
         WHERE account_id = $1 AND agent_object_id = $2
           AND registry_action = $3 AND idempotency_key = $4",
    )
    .bind(account_id)
    .bind(agent_object_id)
    .bind(registry_action)
    .bind(idempotency_key)
    .fetch_optional(db.pool())
    .await
    .map_err(|error| AppError::Internal(format!("read chain action request: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row() -> ChainActionRow {
        ChainActionRow {
            idempotency_scope: "scope".into(),
            account_id: "account".into(),
            agent_object_id: "agent".into(),
            registry_action: "social.react_to_post.v1".into(),
            registry_version: "1.0.0".into(),
            idempotency_key: "request-1".into(),
            parameter_hash: "sha256:params".into(),
            transaction_kind_hash: "sha256:tx".into(),
            package_id: "0x50c1".into(),
            package_version: "1".into(),
            sender: "0xsender".into(),
            approval_id: None,
            sponsored_bytes: None,
            digest: None,
            signature_hash: None,
            status: STATUS_PREPARING.into(),
            simulation_response: None,
            execution_response: None,
            expires_at_ms: 2,
        }
    }

    #[test]
    fn idempotency_replay_requires_exact_metadata() {
        let row = row();
        let matching = NewChainAction {
            idempotency_scope: "scope",
            account_id: "account",
            agent_object_id: "agent",
            registry_action: "social.react_to_post.v1",
            registry_version: "1.0.0",
            idempotency_key: "request-1",
            parameter_hash: "sha256:params",
            transaction_kind_hash: "sha256:tx",
            package_id: "0x50c1",
            package_version: "1",
            sender: "0xsender",
            approval_id: None,
            prepared_at_ms: 1,
            expires_at_ms: 2,
        };
        assert!(same_preparation(&row, &matching));
        let conflicting = NewChainAction {
            parameter_hash: "sha256:different",
            ..matching
        };
        assert!(!same_preparation(&row, &conflicting));
    }
}
