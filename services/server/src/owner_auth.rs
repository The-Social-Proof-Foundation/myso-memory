//! Recovery authenticates the human owner, never the missing agent key.
use axum::{extract::State, http::{HeaderMap, StatusCode}, Json};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use crate::types::AppState;

pub type Error = (StatusCode, Json<Value>);
pub type Result<T> = std::result::Result<T, Error>;
pub fn error(status: StatusCode, code: &str) -> Error { (status, Json(json!({"code": code}))) }
pub fn bad() -> Error { error(StatusCode::BAD_REQUEST, "invalid_backup_request") }
pub fn unavailable() -> Error { error(StatusCode::SERVICE_UNAVAILABLE, "backup_unavailable") }
pub fn denied() -> Error { error(StatusCode::FORBIDDEN, "backup_forbidden") }
pub fn missing() -> Error { error(StatusCode::NOT_FOUND, "backup_missing") }
pub fn conflict() -> Error { error(StatusCode::CONFLICT, "backup_revision_conflict") }
pub fn address(s: &str) -> Result<String> {
    let h = s.strip_prefix("0x").ok_or_else(bad)?;
    if h.is_empty() || h.len() > 64 || !h.bytes().all(|b| b.is_ascii_hexdigit()) { return Err(bad()); }
    Ok(format!("0x{:0>64}", h.to_ascii_lowercase()))
}
pub fn str_field<'a>(v: &'a Value, key: &str) -> Result<&'a str> { v.get(key).and_then(Value::as_str).ok_or_else(bad) }
pub fn encoded(s: &str, length: usize) -> Result<()> {
    let b = URL_SAFE_NO_PAD.decode(s).map_err(|_| bad())?;
    if b.len() != length || URL_SAFE_NO_PAD.encode(&b) != s { return Err(bad()); }
    Ok(())
}
pub fn token() -> String { format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple()) }
#[derive(Clone, Serialize, Deserialize)]
pub struct OwnerSession { pub account: String, pub owner: String, pub chain: String }
#[derive(Clone, Serialize, Deserialize)]
pub struct VaultSession { pub account: String, pub chain: String, pub credential: String }
#[derive(Clone, Serialize, Deserialize)]
struct OwnerChallenge { session: OwnerSession, message: String }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChallengeRequest { account_id: String }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VerifyRequest { challenge_id: String, signature: String }

pub fn validate_config() -> std::result::Result<(), String> {
    let rp = std::env::var("PASSKEY_RP_ID").map_err(|_| "PASSKEY_RP_ID required")?;
    let origins = std::env::var("PASSKEY_ALLOWED_ORIGINS").map_err(|_| "PASSKEY_ALLOWED_ORIGINS required")?;
    if rp.is_empty() || rp.contains(['/', ':', '*']) { return Err("Invalid PASSKEY_RP_ID".into()); }
    if origins.trim().is_empty() { return Err("Passkey origins required".into()); }
    for origin in origins.split(',') {
        let url = reqwest::Url::parse(origin.trim()).map_err(|_| "Invalid passkey origin")?;
        let host = url.host_str().ok_or("Origin host required")?;
        if origin.contains('*') || !(host == rp || host.ends_with(&format!(".{rp}")))
            || !(url.scheme() == "https" || (rp == "localhost" && url.scheme() == "http"))
            || url.path() != "/" || url.query().is_some() || url.fragment().is_some()
            || !url.username().is_empty() || url.password().is_some() {
            return Err("Passkey origins must be exact HTTPS origins within the configured RP (HTTP localhost is allowed)".into());
        }
    }
    let service = std::env::var("KEY_BACKUP_SERVICE_ORIGIN").map_err(|_| "KEY_BACKUP_SERVICE_ORIGIN required")?;
    let url = reqwest::Url::parse(&service).map_err(|_| "Invalid backup service origin")?;
    if !url.username().is_empty() || url.password().is_some() || service.contains(['*', '|']) || url.path() != "/" || url.query().is_some() || url.fragment().is_some()
        || !(url.scheme() == "https" || (url.host_str() == Some("localhost") && url.scheme() == "http")) {
        return Err("Invalid KEY_BACKUP_SERVICE_ORIGIN".into());
    }
    Ok(())
}
pub async fn chain(state: &AppState) -> Result<String> {
    let value: Value = state.http_client.post(&state.config.myso_rpc_url).json(&json!({"jsonrpc":"2.0","id":1,"method":"myso_getChainIdentifier","params":[]})).send().await.map_err(|_| unavailable())?.json().await.map_err(|_| unavailable())?;
    let id = value.get("result").and_then(Value::as_str).ok_or_else(unavailable)?;
    if id.is_empty() || id.len() > 128 { return Err(unavailable()); }
    Ok(id.to_string())
}
pub async fn owner(state: &AppState, account: &str) -> Result<String> {
    let fields = crate::myso::fetch_typed_object_fields(&state.http_client, &state.config.myso_rpc_url, account, &state.config.package_id, "MemoryAccount").await.map_err(|_| unavailable())?;
    if fields.get("active").and_then(Value::as_bool) != Some(true) { return Err(denied()); }
    address(fields.get("owner").and_then(Value::as_str).ok_or_else(unavailable)?)
}
pub async fn sidecar(state: &AppState, operation: &str, body: Value) -> Result<Value> {
    let secret = state.config.sidecar_secret.as_ref().ok_or_else(unavailable)?;
    let response = state.http_client.post(format!("{}/key-backup/{}", state.config.sidecar_url.trim_end_matches('/'), operation)).bearer_auth(secret).json(&body).send().await.map_err(|_| unavailable())?;
    if !response.status().is_success() { return Err(error(StatusCode::UNAUTHORIZED, "verification_rejected")); }
    response.json().await.map_err(|_| unavailable())
}
pub async fn save<T: Serialize>(state: &AppState, prefix: &str, value: &T, ttl: u64) -> Result<String> {
    let id = token();
    let mut redis = state.redis.clone();
    let data = serde_json::to_string(value).map_err(|_| unavailable())?;
    let _: () = redis.set_ex(format!("keybackup:{prefix}:{id}"), data, ttl).await.map_err(|_| unavailable())?;
    Ok(id)
}
pub async fn read<T: for<'de> Deserialize<'de>>(state: &AppState, prefix: &str, id: &str, consume: bool) -> Result<T> {
    if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) { return Err(error(StatusCode::UNAUTHORIZED, "session_expired")); }
    let mut redis = state.redis.clone();
    let data: Option<String> = redis::cmd(if consume {"GETDEL"} else {"GET"}).arg(format!("keybackup:{prefix}:{id}")).query_async(&mut redis).await.map_err(|_| unavailable())?;
    serde_json::from_str(&data.ok_or_else(|| error(StatusCode::UNAUTHORIZED, "session_expired"))?).map_err(|_| unavailable())
}
pub async fn session(state: &AppState, headers: &HeaderMap, account: &str) -> Result<OwnerSession> {
    let id = headers.get("authorization").and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).ok_or_else(|| error(StatusCode::UNAUTHORIZED, "owner_auth_required"))?;
    let s: OwnerSession = read(state, "owner", id, false).await?;
    if address(account)? != s.account || chain(state).await? != s.chain || owner(state, account).await? != s.owner { return Err(denied()); }
    Ok(s)
}
pub async fn vault(state: &AppState, headers: &HeaderMap, s: &OwnerSession, require_active: bool) -> Result<VaultSession> {
    let id = headers.get("x-vault-token").and_then(|v| v.to_str().ok()).ok_or_else(|| error(StatusCode::UNAUTHORIZED, "passkey_required"))?;
    let v: VaultSession = read(state, "vault", id, false).await?;
    if v.account != s.account || v.chain != s.chain { return Err(denied()); }
    let valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM recovery_passkeys WHERE chain=$1 AND account_id=$2 AND credential_id=$3 AND NOT revoked AND (active OR NOT $4))").bind(&v.chain).bind(&v.account).bind(&v.credential).bind(require_active).fetch_one(state.db.pool()).await.map_err(|_| unavailable())?;
    if !valid { return Err(denied()); }
    Ok(v)
}
pub async fn challenge(State(state): State<Arc<AppState>>, Json(input): Json<ChallengeRequest>) -> Result<Json<Value>> {
    let account = address(&input.account_id)?;
    let s = OwnerSession {owner: owner(&state, &account).await?, chain: chain(&state).await?, account};
    let origin = std::env::var("KEY_BACKUP_SERVICE_ORIGIN").map_err(|_| unavailable())?;
    let message = format!("mysocial-key-backup-owner-v1|{}|{}|{}|{}|unlock-agent-backups|{}|{}", origin, s.chain, s.account, s.owner, token(), chrono::Utc::now().timestamp()+300);
    let id = save(&state, "challenge", &OwnerChallenge {session: s, message: message.clone()}, 300).await?;
    Ok(Json(json!({"challenge_id":id,"message":message,"expires_in":300})))
}
pub async fn verify(State(state): State<Arc<AppState>>, Json(input): Json<VerifyRequest>) -> Result<Json<Value>> {
    if input.signature.len() > 8192 { return Err(bad()); }
    let c: OwnerChallenge = read(&state, "challenge", &input.challenge_id, true).await?;
    if owner(&state, &c.session.account).await? != c.session.owner || chain(&state).await? != c.session.chain { return Err(denied()); }
    let r = sidecar(&state, "owner", json!({"message":c.message,"signature":input.signature,"owner":c.session.owner})).await?;
    if r.get("verified") != Some(&Value::Bool(true)) { return Err(denied()); }
    let id = save(&state, "owner", &c.session, 900).await?;
    Ok(Json(json!({"owner_token":id,"expires_in":900,"owner":c.session.owner,"chain":c.session.chain,"package_id":address(&state.config.package_id)?})))
}
