//! MLS device state for agents (E2EE: agents as hosted MLS devices).
//!
//! The MCP / automation bridge keeps each agent's MLS device here: one opaque blob, sealed by the
//! caller with a key derived from the agent's own signing key (the server never sees plaintext).
//! Exactly one writer at a time: a caller takes a short lease, every write must hold it and name
//! the version it read, and the caller persists before it posts anything to the relayer. MLS
//! state must never fork, because two writers encrypting from the same state would reuse AES-GCM
//! nonces.
//!
//! Scoped to the authenticated agent (its derived address); `/api/messaging/*` already requires
//! the message-read capability.

use std::sync::Arc;

use axum::{extract::State, Extension, Json};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;

use crate::types::{AppError, AppState, AuthInfo};

/// Lease length; callers renew while working.
const LEASE_SECS: i64 = 60;
/// Max sealed blob size.
pub const MAX_STATE_BYTES: usize = 16 * 1024 * 1024;

fn device_id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b':')
}

fn agent(auth: &AuthInfo) -> String {
    auth.derived_address.trim().to_ascii_lowercase()
}

/// A taken lease and the state it guards.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lease {
    pub token: String,
    pub until_ms: i64,
    pub version: i64,
    pub blob: Option<Vec<u8>>,
}

fn db_err(e: sqlx::Error) -> AppError {
    AppError::Internal(format!("mls state: {e}"))
}

/// Take the lease if free or expired; `None` while someone else holds it.
pub async fn take_lease(pool: &sqlx::PgPool, agent: &str, device_id: &str, account_id: &str) -> Result<Option<Lease>, AppError> {
    let token = uuid::Uuid::new_v4().to_string();
    let row = sqlx::query(
        "INSERT INTO mls_agent_device_state (agent_address, device_id, account_id, lease_token, lease_until) \
         VALUES ($1, $2, $3, $4, NOW() + make_interval(secs => $5)) \
         ON CONFLICT (agent_address, device_id) DO UPDATE \
           SET lease_token = EXCLUDED.lease_token, lease_until = EXCLUDED.lease_until \
           WHERE mls_agent_device_state.lease_until IS NULL OR mls_agent_device_state.lease_until < NOW() \
         RETURNING version, blob, (EXTRACT(EPOCH FROM lease_until) * 1000)::BIGINT AS until_ms",
    )
    .bind(agent)
    .bind(device_id)
    .bind(account_id)
    .bind(&token)
    .bind(LEASE_SECS as f64)
    .fetch_optional(pool)
    .await
    .map_err(db_err)?;
    Ok(row.map(|r| Lease { token, until_ms: r.get("until_ms"), version: r.get("version"), blob: r.get("blob") }))
}

/// Extend a held lease; `None` if it was lost (expired / taken over).
pub async fn renew_lease(pool: &sqlx::PgPool, agent: &str, device_id: &str, token: &str) -> Result<Option<i64>, AppError> {
    let row = sqlx::query(
        "UPDATE mls_agent_device_state SET lease_until = NOW() + make_interval(secs => $4) \
         WHERE agent_address = $1 AND device_id = $2 AND lease_token = $3 AND lease_until >= NOW() \
         RETURNING (EXTRACT(EPOCH FROM lease_until) * 1000)::BIGINT AS until_ms",
    )
    .bind(agent)
    .bind(device_id)
    .bind(token)
    .bind(LEASE_SECS as f64)
    .fetch_optional(pool)
    .await
    .map_err(db_err)?;
    Ok(row.map(|r| r.get("until_ms")))
}

pub async fn release_lease(pool: &sqlx::PgPool, agent: &str, device_id: &str, token: &str) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE mls_agent_device_state SET lease_token = NULL, lease_until = NULL \
         WHERE agent_address = $1 AND device_id = $2 AND lease_token = $3",
    )
    .bind(agent)
    .bind(device_id)
    .bind(token)
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(())
}

/// Replace the blob under a live lease at `expected_version`; `None` if the lease or version moved.
pub async fn write_state(
    pool: &sqlx::PgPool,
    agent: &str,
    device_id: &str,
    token: &str,
    expected_version: i64,
    blob: &[u8],
) -> Result<Option<i64>, AppError> {
    let row = sqlx::query(
        "UPDATE mls_agent_device_state SET blob = $5, version = version + 1, updated_at = NOW() \
         WHERE agent_address = $1 AND device_id = $2 AND lease_token = $3 AND lease_until >= NOW() AND version = $4 \
         RETURNING version",
    )
    .bind(agent)
    .bind(device_id)
    .bind(token)
    .bind(expected_version)
    .bind(blob)
    .fetch_optional(pool)
    .await
    .map_err(db_err)?;
    Ok(row.map(|r| r.get("version")))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LeaseRequest {
    pub device_id: String,
}

/// `POST /api/messaging/mls/lease` — take the device's lease (if free or expired) and return its
/// current state. `409` while another caller holds it.
pub async fn acquire(
    Extension(auth): Extension<AuthInfo>,
    State(state): State<Arc<AppState>>,
    Json(req): Json<LeaseRequest>,
) -> Result<Json<Value>, AppError> {
    if !device_id_ok(&req.device_id) {
        return Err(AppError::BadRequest("invalid device_id".into()));
    }
    let lease = take_lease(state.db.pool(), &agent(&auth), &req.device_id, &auth.account_id)
        .await?
        .ok_or_else(|| AppError::Conflict("this agent's MLS device is busy; retry shortly".into()))?;
    Ok(Json(json!({
        "lease_token": lease.token,
        "lease_until_ms": lease.until_ms,
        "version": lease.version,
        "blob": lease.blob.map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
    })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LeaseTokenRequest {
    pub device_id: String,
    pub lease_token: String,
}

/// `POST /api/messaging/mls/lease/renew` — extend a held lease.
pub async fn renew(
    Extension(auth): Extension<AuthInfo>,
    State(state): State<Arc<AppState>>,
    Json(req): Json<LeaseTokenRequest>,
) -> Result<Json<Value>, AppError> {
    let until = renew_lease(state.db.pool(), &agent(&auth), &req.device_id, &req.lease_token)
        .await?
        .ok_or_else(|| AppError::Conflict("MLS device lease lost".into()))?;
    Ok(Json(json!({ "lease_until_ms": until })))
}

/// `POST /api/messaging/mls/lease/release` — give the lease back (idempotent).
pub async fn release(
    Extension(auth): Extension<AuthInfo>,
    State(state): State<Arc<AppState>>,
    Json(req): Json<LeaseTokenRequest>,
) -> Result<Json<Value>, AppError> {
    release_lease(state.db.pool(), &agent(&auth), &req.device_id, &req.lease_token).await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PutStateRequest {
    pub device_id: String,
    pub lease_token: String,
    /// The version this write replaces.
    pub expected_version: i64,
    /// Base64 sealed blob.
    pub blob: String,
}

/// `PUT /api/messaging/mls/state` — replace the blob. Requires the live lease and the expected
/// version; `409` otherwise (the caller must stop: another writer took over).
pub async fn put_state(
    Extension(auth): Extension<AuthInfo>,
    State(state): State<Arc<AppState>>,
    Json(req): Json<PutStateRequest>,
) -> Result<Json<Value>, AppError> {
    let blob = base64::engine::general_purpose::STANDARD
        .decode(req.blob.as_bytes())
        .map_err(|_| AppError::BadRequest("blob must be base64".into()))?;
    if blob.is_empty() || blob.len() > MAX_STATE_BYTES {
        return Err(AppError::BadRequest("blob must be 1..=16 MiB".into()));
    }
    let version = write_state(state.db.pool(), &agent(&auth), &req.device_id, &req.lease_token, req.expected_version, &blob)
        .await?
        .ok_or_else(|| AppError::Conflict("MLS device lease lost or state changed".into()))?;
    Ok(Json(json!({ "version": version })))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool() -> sqlx::PgPool {
        let url = std::env::var("TEST_MLS_STATE_DATABASE_URL").expect("isolated test database required");
        let pool = sqlx::PgPool::connect(&url).await.unwrap();
        sqlx::raw_sql(include_str!("../migrations/033_mls_agent_device_state.sql")).execute(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    #[ignore = "needs TEST_MLS_STATE_DATABASE_URL (isolated Postgres)"]
    async fn one_writer_at_a_time_and_writes_need_the_lease_and_version() {
        let pool = pool().await;
        let agent = format!("0x{}", uuid::Uuid::new_v4().simple());
        let a = take_lease(&pool, &agent, "mcp-1", "acct").await.unwrap().expect("free lease");
        assert_eq!((a.version, a.blob.clone()), (0, None));
        // A second instance can't take it while it's held.
        assert!(take_lease(&pool, &agent, "mcp-1", "acct").await.unwrap().is_none());
        // Writes need the lease and the version they read.
        assert_eq!(write_state(&pool, &agent, "mcp-1", &a.token, 0, b"s1").await.unwrap(), Some(1));
        assert_eq!(write_state(&pool, &agent, "mcp-1", &a.token, 0, b"stale").await.unwrap(), None);
        assert_eq!(write_state(&pool, &agent, "mcp-1", "not-the-token", 1, b"x").await.unwrap(), None);
        assert!(renew_lease(&pool, &agent, "mcp-1", &a.token).await.unwrap().is_some());
        release_lease(&pool, &agent, "mcp-1", &a.token).await.unwrap();
        // Next holder sees the latest state; the old token can't write any more.
        let b = take_lease(&pool, &agent, "mcp-1", "acct").await.unwrap().expect("released");
        assert_eq!((b.version, b.blob.as_deref()), (1, Some(&b"s1"[..])));
        assert_eq!(write_state(&pool, &agent, "mcp-1", &a.token, 1, b"old holder").await.unwrap(), None);
        // An expired lease can be taken over.
        sqlx::query("UPDATE mls_agent_device_state SET lease_until = NOW() - INTERVAL '1 second' WHERE agent_address = $1")
            .bind(&agent).execute(&pool).await.unwrap();
        let c = take_lease(&pool, &agent, "mcp-1", "acct").await.unwrap().expect("expired lease taken over");
        assert!(renew_lease(&pool, &agent, "mcp-1", &b.token).await.unwrap().is_none(), "old lease is gone");
        assert_eq!(write_state(&pool, &agent, "mcp-1", &c.token, 1, b"s2").await.unwrap(), Some(2));
        // Devices and agents are independent.
        assert!(take_lease(&pool, &agent, "mcp-2", "acct").await.unwrap().is_some());
    }
}
