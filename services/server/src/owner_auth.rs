//! Recovery authenticates the human owner, never the missing agent key.
use axum::{extract::State, http::{HeaderMap, StatusCode}, Json};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::types::Json as SqlJson;
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
/// Canonical empty value of a method-irrelevant 32-byte base64url field.
pub fn zero32() -> String { URL_SAFE_NO_PAD.encode([0u8; 32]) }
/// Custody purposes unlock one non-passkey method; the default purpose keeps the v1 message.
pub const DEFAULT_PURPOSE: &str = "unlock-agent-backups";
pub const CUSTODY_PURPOSES: [(&str, &str); 3] = [
    ("custody-unlock-zklogin-root-v1", "zklogin-root-v1"),
    ("custody-unlock-recovery-code-v1", "recovery-code-v1"),
    ("custody-unlock-device-key-v1", "device-key-v1"),
];
pub fn custody_method_for_purpose(purpose: &str) -> Option<&'static str> { CUSTODY_PURPOSES.iter().find(|(p,_)| *p == purpose).map(|(_,m)| *m) }
/// Neither the passkey tier nor any custody tier may be requested through an unknown purpose.
pub fn valid_purpose(purpose: &str) -> bool { purpose == DEFAULT_PURPOSE || custody_method_for_purpose(purpose).is_some() }
/// Non-passkey subjects are the account owner; the wrap row key is (method, subject).
pub fn custody_subject_ok(method: &str, subject: &str, owner: &str) -> bool { crate::types::CUSTODY_METHODS.contains(&method) && subject == owner }
/// Structured custody audit trail. Callers pass public metadata only: never tokens, PRF inputs,
/// ciphertexts, or signed message bytes.
pub fn audit(event: &str, fields: Value) { tracing::info!(target: "custody_audit", event = %event, fields = %fields); }
#[derive(Clone, Serialize, Deserialize)]
pub struct OwnerSession { pub account: String, pub owner: String, pub chain: String }
#[derive(Clone, Serialize)]
pub struct VaultSession { pub account: String, pub chain: String, pub method: String, pub subject: String }
impl<'de> Deserialize<'de> for VaultSession {
    /// Sessions minted before custody tiers carry only `credential`; they are passkey vaults.
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Raw { account: String, chain: String, #[serde(default)] method: String, #[serde(default)] subject: Option<String>, #[serde(default)] credential: Option<String> }
        let raw = Raw::deserialize(deserializer)?;
        let subject = raw.subject.or(raw.credential).ok_or_else(|| serde::de::Error::missing_field("subject"))?;
        let method = if raw.method.is_empty() { "passkey-prf-v1".to_string() } else { raw.method };
        Ok(VaultSession { account: raw.account, chain: raw.chain, method, subject })
    }
}
#[derive(Clone, Serialize, Deserialize)]
struct OwnerChallenge { session: OwnerSession, message: String, #[serde(default = "default_purpose")] purpose: String }
fn default_purpose() -> String { DEFAULT_PURPOSE.to_string() }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChallengeRequest { account_id: String, #[serde(default)] purpose: Option<String> }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VerifyRequest { challenge_id: String, signature: String }

pub fn validate_config(config: &crate::types::Config) -> std::result::Result<(), String> {
    for method in config.agent_key_custody_tiers.iter() {
        if !crate::types::CUSTODY_METHODS.contains(&method.as_str()) { return Err(format!("Unknown AGENT_KEY_CUSTODY_TIERS method {method}")); }
    }
    if let Some(required) = config.agent_key_require_tier.as_deref() {
        if !crate::types::CUSTODY_METHODS.contains(&required) { return Err(format!("Unknown AGENT_KEY_REQUIRE_TIER {required}")); }
        if !config.custody_method_enabled(required) { return Err(format!("AGENT_KEY_REQUIRE_TIER {required} is not an enabled custody tier")); }
    }
    // Passkey ceremony configuration is only required while the passkey tier is enabled.
    let passkey = config.custody_method_enabled("passkey-prf-v1");
    let rp = std::env::var("PASSKEY_RP_ID").unwrap_or_default();
    let origins = std::env::var("PASSKEY_ALLOWED_ORIGINS").unwrap_or_default();
    let service = std::env::var("KEY_BACKUP_SERVICE_ORIGIN").unwrap_or_default();
    if passkey && rp.is_empty() { return Err("PASSKEY_RP_ID required".into()); }
    if passkey && origins.trim().is_empty() { return Err("Passkey origins required".into()); }
    if passkey && service.is_empty() { return Err("KEY_BACKUP_SERVICE_ORIGIN required".into()); }
    if !rp.is_empty() && rp.contains(['/', ':', '*']) { return Err("Invalid PASSKEY_RP_ID".into()); }
    if !origins.trim().is_empty() {
        if rp.is_empty() { return Err("PASSKEY_RP_ID required".into()); }
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
    }
    if !service.is_empty() {
        let url = reqwest::Url::parse(&service).map_err(|_| "Invalid backup service origin")?;
        if !url.username().is_empty() || url.password().is_some() || service.contains(['*', '|']) || url.path() != "/" || url.query().is_some() || url.fragment().is_some()
            || !(url.scheme() == "https" || (url.host_str() == Some("localhost") && url.scheme() == "http")) {
            return Err("Invalid KEY_BACKUP_SERVICE_ORIGIN".into());
        }
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
/// Method-aware vault authorization: passkeys must still be an active/non-revoked credential,
/// every other tier must be enabled and carry the account owner as its subject.
pub async fn vault(state: &AppState, headers: &HeaderMap, s: &OwnerSession, require_active: bool) -> Result<VaultSession> {
    let id = headers.get("x-vault-token").and_then(|v| v.to_str().ok()).ok_or_else(|| error(StatusCode::UNAUTHORIZED, "custody_unlock_required"))?;
    let v: VaultSession = read(state, "vault", id, false).await?;
    if v.account != s.account || v.chain != s.chain { return Err(denied()); }
    if v.method == "passkey-prf-v1" {
        let valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM recovery_passkeys WHERE chain=$1 AND account_id=$2 AND credential_id=$3 AND NOT revoked AND (active OR NOT $4))").bind(&v.chain).bind(&v.account).bind(&v.subject).bind(require_active).fetch_one(state.db.pool()).await.map_err(|_| unavailable())?;
        if !valid { audit("vault_unlock", json!({"account":s.account,"method":v.method,"subject":v.subject,"result":"denied","reason":"passkey_inactive"})); return Err(denied()); }
        audit("vault_unlock", json!({"account":s.account,"method":v.method,"subject":v.subject,"result":"ok"}));
        return Ok(v);
    }
    if !state.config.custody_method_enabled(&v.method) { audit("vault_unlock", json!({"account":s.account,"method":v.method,"subject":v.subject,"result":"denied","reason":"method_disabled"})); return Err(error(StatusCode::FORBIDDEN, "custody_method_disabled")); }
    if !custody_subject_ok(&v.method, &v.subject, &s.owner) { audit("vault_unlock", json!({"account":s.account,"method":v.method,"subject":v.subject,"result":"denied","reason":"subject_mismatch"})); return Err(denied()); }
    audit("vault_unlock", json!({"account":s.account,"method":v.method,"subject":v.subject,"result":"ok"}));
    Ok(v)
}
/// Per-account fixed-window limiter shared by challenge issuance and custody verify. The key
/// carries the minute so a Redis restart or an idle window cannot accumulate credit.
pub async fn custody_limit(state: &AppState, s: &OwnerSession) -> Result<()> {
    let limit = state.config.agent_key_unlock_per_minute;
    if limit == 0 { audit("custody_rate_limited", json!({"account":s.account,"limit":limit})); return Err(error(StatusCode::TOO_MANY_REQUESTS, "custody_rate_limited")); }
    let key = format!("keybackup:custody-rate:{}:{}:{}", s.chain, s.account, chrono::Utc::now().timestamp()/60);
    let mut redis = state.redis.clone();
    let count: i64 = redis::cmd("INCR").arg(&key).query_async(&mut redis).await.map_err(|_| unavailable())?;
    if count == 1 { let _: () = redis.expire(&key, 60).await.map_err(|_| unavailable())?; }
    if count > limit as i64 { audit("custody_rate_limited", json!({"account":s.account,"chain":s.chain,"count":count,"limit":limit})); return Err(error(StatusCode::TOO_MANY_REQUESTS, "custody_rate_limited")); }
    Ok(())
}
/// A custody purpose may only mint an unlock path the account can actually use: enabled by config,
/// at or above the required tier, allowed by the account policy, and already set up (or the
/// account has no wraps yet, i.e. this request adopts the first tier).
pub async fn custody_unlock_allowed(state: &AppState, s: &OwnerSession, method: &str, purpose: &str) -> Result<()> {
    if !state.config.custody_method_enabled(method) { audit("custody_unlock", json!({"account":s.account,"method":method,"purpose":purpose,"result":"denied","reason":"method_disabled"})); return Err(error(StatusCode::FORBIDDEN, "custody_method_disabled")); }
    if let Some(required) = state.config.agent_key_require_tier.as_deref() {
        if !crate::types::custody_tier_satisfied(required, method) { audit("custody_unlock", json!({"account":s.account,"method":method,"purpose":purpose,"required":required,"result":"denied","reason":"tier_required"})); return Err(error(StatusCode::FORBIDDEN, "custody_tier_required")); }
    }
    if let Some(allowed) = allowed_methods(state, s).await? {
        if !allowed.iter().any(|m| m == method) { audit("custody_unlock", json!({"account":s.account,"method":method,"purpose":purpose,"result":"denied","reason":"method_not_allowed"})); return Err(error(StatusCode::FORBIDDEN, "custody_method_not_allowed")); }
    }
    let has_wrap: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM recovery_root_wraps WHERE chain=$1 AND account_id=$2 AND method=$3 AND subject=$4)").bind(&s.chain).bind(&s.account).bind(method).bind(&s.owner).fetch_one(state.db.pool()).await.map_err(|_| unavailable())?;
    let any_wrap: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM recovery_root_wraps WHERE chain=$1 AND account_id=$2)").bind(&s.chain).bind(&s.account).fetch_one(state.db.pool()).await.map_err(|_| unavailable())?;
    if !has_wrap && any_wrap { audit("custody_unlock", json!({"account":s.account,"method":method,"purpose":purpose,"result":"denied","reason":"method_unavailable"})); return Err(error(StatusCode::FORBIDDEN, "custody_method_unavailable")); }
    Ok(())
}
/// Operator/account custody policy for this account: `None` when no row exists.
pub async fn allowed_methods(state: &AppState, s: &OwnerSession) -> Result<Option<Vec<String>>> {
    let row: Option<SqlJson<Value>> = sqlx::query_scalar("SELECT allowed_methods FROM custody_policies WHERE chain=$1 AND account_id=$2").bind(&s.chain).bind(&s.account).fetch_optional(state.db.pool()).await.map_err(|_| unavailable())?;
    Ok(row.and_then(|v| v.0.as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())))
}
/// Signed owner intent. The default purpose keeps the exact v1 message bytes that deployed
/// clients and the sidecar already pin; custody purposes use the v2 prefix.
pub fn owner_message(purpose: &str, origin: &str, chain: &str, account: &str, owner: &str, nonce: &str, expires: i64) -> String {
    let version = if purpose == DEFAULT_PURPOSE { "v1" } else { "v2" };
    format!("mysocial-key-backup-owner-{version}|{origin}|{chain}|{account}|{owner}|{purpose}|{nonce}|{expires}")
}
pub async fn challenge(State(state): State<Arc<AppState>>, Json(input): Json<ChallengeRequest>) -> Result<Json<Value>> {
    let account = address(&input.account_id)?;
    let s = OwnerSession {owner: owner(&state, &account).await?, chain: chain(&state).await?, account};
    let purpose = input.purpose.unwrap_or_else(default_purpose);
    if !valid_purpose(&purpose) { audit("challenge_issued", json!({"account":s.account,"purpose":purpose,"result":"denied","reason":"unknown_purpose"})); return Err(bad()); }
    custody_limit(&state, &s).await?;
    let origin = std::env::var("KEY_BACKUP_SERVICE_ORIGIN").map_err(|_| unavailable())?;
    let message = owner_message(&purpose, &origin, &s.chain, &s.account, &s.owner, &token(), chrono::Utc::now().timestamp()+300);
    let id = save(&state, "challenge", &OwnerChallenge {session: s.clone(), message: message.clone(), purpose: purpose.clone()}, 300).await?;
    audit("challenge_issued", json!({"account":s.account,"owner":s.owner,"purpose":purpose,"result":"ok"}));
    Ok(Json(json!({"challenge_id":id,"message":message,"expires_in":300,"purpose":purpose})))
}
pub async fn verify(State(state): State<Arc<AppState>>, Json(input): Json<VerifyRequest>) -> Result<Json<Value>> {
    if input.signature.len() > 8192 { return Err(bad()); }
    let c: OwnerChallenge = read(&state, "challenge", &input.challenge_id, true).await?;
    if owner(&state, &c.session.account).await? != c.session.owner || chain(&state).await? != c.session.chain { return Err(denied()); }
    let r = sidecar(&state, "owner", json!({"message":c.message,"signature":input.signature,"owner":c.session.owner})).await?;
    if r.get("verified") != Some(&Value::Bool(true)) { audit("owner_verify", json!({"account":c.session.account,"purpose":c.purpose,"result":"denied"})); return Err(denied()); }
    // A custody purpose must be usable before any token is minted for it.
    if let Some(method) = custody_method_for_purpose(&c.purpose) {
        custody_limit(&state, &c.session).await?;
        custody_unlock_allowed(&state, &c.session, method, &c.purpose).await?;
    }
    let id = save(&state, "owner", &c.session, 900).await?;
    let mut body = json!({"owner_token":id,"expires_in":900,"owner":c.session.owner,"chain":c.session.chain,"package_id":address(&state.config.package_id)?});
    if let Some(method) = custody_method_for_purpose(&c.purpose) {
        let subject = c.session.owner.clone();
        let vt = save(&state, "vault", &VaultSession {account:c.session.account.clone(),chain:c.session.chain.clone(),method:method.to_string(),subject:subject.clone()}, 900).await?;
        audit("vault_minted", json!({"account":c.session.account,"method":method,"subject":subject,"purpose":c.purpose,"result":"ok"}));
        body["vault_token"] = json!(vt); body["vault_method"] = json!(method); body["vault_subject"] = json!(subject);
    }
    audit("owner_verify", json!({"account":c.session.account,"purpose":c.purpose,"result":"ok"}));
    Ok(Json(body))
}

#[cfg(test)]
mod tests {
    use super::*;
    /// Byte-for-byte compatibility with the deployed v1 challenge message.
    #[test] fn default_purpose_keeps_the_v1_message(){
        assert_eq!(owner_message(DEFAULT_PURPOSE,"https://backup.example","test-chain","0x11","0x22","nonce",1700000000),
            "mysocial-key-backup-owner-v1|https://backup.example|test-chain|0x11|0x22|unlock-agent-backups|nonce|1700000000");
        assert_eq!(owner_message("custody-unlock-zklogin-root-v1","https://backup.example","test-chain","0x11","0x22","nonce",1700000000),
            "mysocial-key-backup-owner-v2|https://backup.example|test-chain|0x11|0x22|custody-unlock-zklogin-root-v1|nonce|1700000000");
        assert!(valid_purpose(DEFAULT_PURPOSE)&&valid_purpose("custody-unlock-device-key-v1")&&!valid_purpose("custody-unlock-passkey-prf-v1")&&!valid_purpose(""));
        assert_eq!(custody_method_for_purpose("custody-unlock-recovery-code-v1"),Some("recovery-code-v1"));
    }
    /// Sessions minted before custody tiers must still authorize their original passkey.
    #[test] fn legacy_vault_sessions_deserialize_as_passkeys(){
        let v: VaultSession = serde_json::from_str(r#"{"account":"0x11","chain":"test-chain","credential":"credential-a"}"#).unwrap();
        assert_eq!((v.method.as_str(),v.subject.as_str()),("passkey-prf-v1","credential-a"));
        assert!(serde_json::from_str::<VaultSession>(r#"{"account":"0x11","chain":"test-chain"}"#).is_err());
    }
}
