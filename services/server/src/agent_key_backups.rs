//! Ciphertext storage and passkey lifecycle. No server key generation/decryption.
use axum::{extract::{State, Path, OriginalUri}, http::{HeaderMap, Method, StatusCode}, routing::{get, post}, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Row, types::Json as SqlJson};
use std::{collections::HashMap, sync::Arc};
use crate::{types::AppState, owner_auth::*};

#[derive(Serialize, Deserialize)]
struct Ceremony { account: String, chain: String, challenge: String, operation: String, approved_existing: bool, approved_by: Option<String> }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CeremonyResponse { ceremony_id: String, response: Value }

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/owner/auth/challenge", post(challenge))
        .route("/api/owner/auth/verify", post(verify))
        .route("/api/accounts/{account_id}/passkeys", get(passkeys))
        .route("/api/accounts/{account_id}/passkeys/{credential_id}", axum::routing::delete(remove_passkey))
        .route("/api/accounts/{account_id}/passkeys/{operation}/{step}", post(ceremony))
        .route("/api/accounts/{account_id}/recovery-root", get(backups).put(backups))
        .route("/api/accounts/{account_id}/recovery-roots", get(recovery_roots))
        .route("/api/accounts/{account_id}/custody-policy", get(custody_policy).put(custody_policy))
        .route("/api/accounts/{account_id}/agent-key-envelopes", get(backups))
        .route("/api/accounts/{account_id}/agent-key-drafts", get(backups))
        .route("/api/accounts/{account_id}/agent-key-drafts/{key_id}/intent", get(crate::agent_key_setup::intent).put(crate::agent_key_setup::intent))
        .route("/api/accounts/{account_id}/agent-key-setups", get(crate::agent_key_setup::setups))
        .route("/api/accounts/{account_id}/agents/{agent_id}/key-setup", get(crate::agent_key_setup::setups).put(crate::agent_key_setup::setups))
        .route("/api/accounts/{account_id}/agent-key-drafts/{key_id}", get(backups).put(backups).delete(backups))
        .route("/api/accounts/{account_id}/agent-key-drafts/{key_id}/finalize", post(backups))
        .route("/api/accounts/{account_id}/agents/{agent_id}/key-envelope", get(backups).put(backups).delete(backups))
}
async fn credential_rows(state: &AppState, s: &OwnerSession) -> Result<Vec<Value>> {
    let rows = sqlx::query("SELECT credential, prf_input, active FROM recovery_passkeys WHERE chain=$1 AND account_id=$2 AND NOT revoked ORDER BY created_at")
        .bind(&s.chain).bind(&s.account).fetch_all(state.db.pool()).await.map_err(|_| unavailable())?;
    rows.iter().map(|r| {
        let mut c: Value = r.try_get::<SqlJson<Value>,_>("credential").map_err(|_| unavailable())?.0;
        c["prfInput"] = json!(r.try_get::<String,_>("prf_input").map_err(|_| unavailable())?);
        c["active"] = json!(r.try_get::<bool,_>("active").map_err(|_| unavailable())?);
        Ok(c)
    }).collect()
}
async fn passkeys(State(state): State<Arc<AppState>>, Path(p): Path<HashMap<String,String>>, headers: HeaderMap) -> Result<Json<Value>> {
    let s = session(&state, &headers, &p["account_id"]).await?;
    let rows = credential_rows(&state, &s).await?;
    // Public key/counter are for the verifier, not a browser response.
    Ok(Json(json!(rows.iter().map(|v| json!({"id":v["id"],"active":v["active"],"prfInput":v["prfInput"],"transports":v["transports"]})).collect::<Vec<_>>())))
}
async fn remove_passkey(State(state): State<Arc<AppState>>, Path(p): Path<HashMap<String,String>>, headers: HeaderMap) -> Result<Json<Value>> {
    let s = session(&state,&headers,&p["account_id"]).await?;
    let v = vault(&state,&headers,&s,true).await?;
    if v.method == "passkey-prf-v1" && v.subject == p["credential_id"] { return Err(error(StatusCode::CONFLICT,"unlock_with_another_passkey")); }
    let mut tx = state.db.pool().begin().await.map_err(|_| unavailable())?;
    sqlx::query("SELECT root_id FROM recovery_roots WHERE chain=$1 AND account_id=$2 FOR UPDATE").bind(&s.chain).bind(&s.account).fetch_optional(&mut *tx).await.map_err(|_| unavailable())?;
    // Removing the last usable wrap would leave the account with no way to unwrap its root.
    let usable: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM recovery_root_wraps w WHERE w.chain=$1 AND w.account_id=$2 AND (w.method<>'passkey-prf-v1' OR EXISTS(SELECT 1 FROM recovery_passkeys r WHERE r.chain=w.chain AND r.account_id=w.account_id AND r.credential_id=w.subject AND NOT r.revoked))").bind(&s.chain).bind(&s.account).fetch_one(&mut *tx).await.map_err(|_| unavailable())?;
    let is_wrapped: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM recovery_root_wraps WHERE chain=$1 AND account_id=$2 AND method='passkey-prf-v1' AND subject=$3)").bind(&s.chain).bind(&s.account).bind(&p["credential_id"]).fetch_one(&mut *tx).await.map_err(|_| unavailable())?;
    if is_wrapped && usable <= 1 { audit("passkey_remove", json!({"account":s.account,"subject":p["credential_id"],"result":"denied","reason":"last_method"})); return Err(error(StatusCode::CONFLICT,"custody_last_method")); }
    let n = sqlx::query("UPDATE recovery_passkeys SET revoked=TRUE WHERE chain=$1 AND account_id=$2 AND credential_id=$3 AND NOT revoked").bind(&s.chain).bind(&s.account).bind(&p["credential_id"]).execute(&mut *tx).await.map_err(|_| unavailable())?.rows_affected();
    if n == 0 { return Err(missing()); }
    tx.commit().await.map_err(|_| unavailable())?;
    audit("passkey_remove", json!({"account":s.account,"method":v.method,"subject":p["credential_id"],"result":"ok"}));
    Ok(Json(json!({"removed":true})))
}
async fn recovery_roots(State(state): State<Arc<AppState>>, Path(p): Path<HashMap<String,String>>, headers: HeaderMap) -> Result<Json<Value>> {
    let s = session(&state,&headers,&p["account_id"]).await?;
    let rows = sqlx::query("SELECT method,subject,revision FROM recovery_root_wraps WHERE chain=$1 AND account_id=$2 ORDER BY method,subject")
        .bind(&s.chain).bind(&s.account).fetch_all(state.db.pool()).await.map_err(|_| unavailable())?;
    Ok(Json(json!(rows.iter().map(|r| json!({"method":r.get::<String,_>("method"),"subject":r.get::<String,_>("subject"),"revision":r.get::<i64,_>("revision")})).collect::<Vec<_>>())))
}
async fn custody_policy(State(state): State<Arc<AppState>>, Path(p): Path<HashMap<String,String>>, headers: HeaderMap, method: Method, body: axum::body::Bytes) -> Result<Json<Value>> {
    let s = session(&state,&headers,&p["account_id"]).await?;
    let stored = sqlx::query("SELECT allowed_methods,active_method,updated_at FROM custody_policies WHERE chain=$1 AND account_id=$2")
        .bind(&s.chain).bind(&s.account).fetch_optional(state.db.pool()).await.map_err(|_| unavailable())?;
    let current: Option<Vec<String>> = stored.as_ref().and_then(|r| r.get::<SqlJson<Value>,_>("allowed_methods").0.as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()));
    if method == Method::GET {
        let fallback: i64 = sqlx::query_scalar("SELECT COUNT(DISTINCT method) FROM recovery_root_wraps WHERE chain=$1 AND account_id=$2").bind(&s.chain).bind(&s.account).fetch_one(state.db.pool()).await.map_err(|_| unavailable())?;
        let only: Option<String> = if fallback == 1 { sqlx::query_scalar("SELECT method FROM recovery_root_wraps WHERE chain=$1 AND account_id=$2 LIMIT 1").bind(&s.chain).bind(&s.account).fetch_optional(state.db.pool()).await.map_err(|_| unavailable())? } else { None };
        let active: Option<String> = stored.as_ref().and_then(|r| r.get::<Option<String>,_>("active_method")).or(only);
        let allowed: Vec<String> = current.unwrap_or_else(|| state.config.agent_key_custody_tiers.clone());
        let updated: Option<chrono::DateTime<chrono::Utc>> = stored.as_ref().and_then(|r| r.get::<Option<chrono::DateTime<chrono::Utc>>,_>("updated_at"));
        return Ok(Json(json!({"allowed_methods":allowed,"active_method":active,"updated_at":updated})));
    }
    let v: Value = serde_json::from_slice(&body).map_err(|_| bad())?;
    let o = v.as_object().ok_or_else(bad)?;
    if o.len() != 2 || o.keys().any(|k| !["allowed_methods","active_method"].contains(&k.as_str())) { return Err(bad()); }
    let requested: Vec<String> = v["allowed_methods"].as_array().ok_or_else(bad)?.iter().map(|m| m.as_str().map(str::to_string).ok_or_else(bad)).collect::<Result<_>>()?;
    if requested.is_empty() || requested.len() > crate::types::CUSTODY_METHODS.len() || requested.iter().any(|m| requested.iter().filter(|o| *o == m).count() > 1) { return Err(bad()); }
    let active: Option<String> = match &v["active_method"] { Value::Null => None, Value::String(m) => Some(m.clone()), _ => return Err(bad()) };
    if active.as_ref().is_some_and(|m| !requested.contains(m)) { return Err(bad()); }
    for requested_method in requested.iter() {
        if !state.config.custody_method_enabled(requested_method) { audit("custody_policy_change", json!({"account":s.account,"method":requested_method,"result":"denied","reason":"method_disabled"})); return Err(error(StatusCode::FORBIDDEN,"custody_method_disabled")); }
        if let Some(required) = state.config.agent_key_require_tier.as_deref() {
            if !crate::types::custody_tier_satisfied(required, requested_method) { audit("custody_policy_change", json!({"account":s.account,"method":requested_method,"required":required,"result":"denied","reason":"tier_required"})); return Err(error(StatusCode::FORBIDDEN,"custody_tier_required")); }
        }
    }
    // Dropping a method that can unlock this account right now (a stored wrap or the recorded
    // active method) needs a live unlock from a method that will remain allowed.
    let mut live: Vec<String> = sqlx::query_scalar("SELECT DISTINCT method FROM recovery_root_wraps WHERE chain=$1 AND account_id=$2").bind(&s.chain).bind(&s.account).fetch_all(state.db.pool()).await.map_err(|_| unavailable())?;
    live.extend(stored.as_ref().and_then(|r| r.get::<Option<String>,_>("active_method")));
    let disabling = live.iter().any(|m| !requested.contains(m));
    if disabling {
        let vt = vault(&state,&headers,&s,true).await?;
        if !requested.contains(&vt.method) { audit("custody_policy_change", json!({"account":s.account,"method":vt.method,"result":"denied","reason":"unlock_method_disabled"})); return Err(denied()); }
    }
    sqlx::query("INSERT INTO custody_policies(chain,account_id,allowed_methods,active_method,updated_at) VALUES($1,$2,$3,$4,NOW()) ON CONFLICT(chain,account_id) DO UPDATE SET allowed_methods=EXCLUDED.allowed_methods,active_method=EXCLUDED.active_method,updated_at=NOW()")
        .bind(&s.chain).bind(&s.account).bind(SqlJson(json!(requested))).bind(&active).execute(state.db.pool()).await.map_err(|_| unavailable())?;
    audit("custody_policy_change", json!({"account":s.account,"allowed_methods":requested,"active_method":active,"result":"ok"}));
    Ok(Json(json!({"saved":true})))
}
async fn ceremony(State(state): State<Arc<AppState>>, Path(p): Path<HashMap<String,String>>, headers: HeaderMap, Json(body): Json<Value>) -> Result<Json<Value>> {
    let s = session(&state,&headers,&p["account_id"]).await?;
    let operation = p["operation"].as_str();
    if !["registration","authentication"].contains(&operation) { return Err(bad()); }
    let rp = std::env::var("PASSKEY_RP_ID").map_err(|_| unavailable())?;
    let origins: Vec<String> = std::env::var("PASSKEY_ALLOWED_ORIGINS").map_err(|_| unavailable())?.split(',').map(|s|s.trim().to_string()).collect();
    let rows = credential_rows(&state,&s).await?;
    let existing: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM recovery_roots WHERE chain=$1 AND account_id=$2)").bind(&s.chain).bind(&s.account).fetch_one(state.db.pool()).await.map_err(|_| unavailable())?;
    if p["step"] == "options" {
        if !body.as_object().is_some_and(|b| b.is_empty() || (operation == "authentication" && b.len()==1 && b.contains_key("credential_id"))) { return Err(bad()); }
        let approved_by = if operation == "registration" && existing { Some(vault(&state,&headers,&s,true).await?.subject) } else { None };
        let approved = approved_by.is_some();
        let selected: Vec<Value> = if let Some(id) = body.get("credential_id").and_then(Value::as_str) { rows.into_iter().filter(|v|v["id"]==id).collect() } else {rows};
        if operation == "authentication" && selected.is_empty() { return Err(missing()); }
        let options = sidecar(&state,&format!("{operation}-options"),json!({"rpId":rp,"owner":s.owner,"accountId":s.account,"credentials":selected})).await?;
        let challenge = str_field(&options,"challenge")?.to_string();
        let id = save(&state,"ceremony",&Ceremony {account:s.account.clone(),chain:s.chain.clone(),challenge,operation:operation.into(),approved_existing:approved,approved_by},300).await?;
        let public: Vec<Value> = selected.iter().map(|v|json!({"id":v["id"],"prfInput":v["prfInput"],"active":v["active"]})).collect();
        return Ok(Json(json!({"ceremony_id":id,"options":options,"credentials":public,"rp_id":rp})));
    }
    if p["step"] != "verify" { return Err(bad()); }
    let input: CeremonyResponse = serde_json::from_value(body).map_err(|_| bad())?;
    validate_webauthn_response(&input.response)?;
    let c: Ceremony = read(&state,"ceremony",&input.ceremony_id,true).await?;
    if c.account != s.account || c.chain != s.chain || c.operation != operation { return Err(denied()); }
    if operation == "registration" {
        if existing && !c.approved_existing { return Err(denied()); }
        if let Some(source)=c.approved_by.as_deref() {
            // `approved_by` is the subject of an already-active method: a passkey credential or
            // the owner subject of a non-passkey wrap of the same root.
            let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM recovery_passkeys WHERE chain=$1 AND account_id=$2 AND credential_id=$3 AND active AND NOT revoked) OR EXISTS(SELECT 1 FROM recovery_root_wraps WHERE chain=$1 AND account_id=$2 AND subject=$3)").bind(&s.chain).bind(&s.account).bind(source).fetch_one(state.db.pool()).await.map_err(|_|unavailable())?;
            if !active {return Err(denied());}
        }
        let credential = sidecar(&state,"registration-verify",json!({"rpId":rp,"origins":origins,"challenge":c.challenge,"response":input.response})).await?;
        let id = str_field(&credential,"id")?.to_string();
        let prf_input = base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, [uuid::Uuid::new_v4().as_bytes().as_slice(),uuid::Uuid::new_v4().as_bytes().as_slice()].concat());
        let n = sqlx::query("INSERT INTO recovery_passkeys(chain,account_id,credential_id,credential,prf_input,approved_existing,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING")
            .bind(&s.chain).bind(&s.account).bind(&id).bind(SqlJson(&credential)).bind(&prf_input).bind(c.approved_existing).bind(c.approved_by).execute(state.db.pool()).await.map_err(|_| unavailable())?.rows_affected();
        if n == 0 { return Err(conflict()); }
        audit("passkey_add", json!({"account":s.account,"method":"passkey-prf-v1","subject":id,"approved_existing":c.approved_existing,"result":"ok"}));
        return Ok(Json(json!({"credential_id":id,"prf_input":prf_input,"rp_id":rp})));
    }
    let id = str_field(&input.response,"id")?;
    let credential = rows.iter().find(|v|v["id"]==id).ok_or_else(denied)?;
    let verified = sidecar(&state,"authentication-verify",json!({"rpId":rp,"origins":origins,"challenge":c.challenge,"response":input.response,"credential":credential})).await?;
    let mut updated = credential.clone();
    updated.as_object_mut().unwrap().remove("prfInput"); updated.as_object_mut().unwrap().remove("active");
    updated["counter"] = verified["counter"].clone();
    // Compare previous counter to prevent a concurrent assertion overwriting a newer one.
    let n = sqlx::query("UPDATE recovery_passkeys SET credential=$1 WHERE chain=$2 AND account_id=$3 AND credential_id=$4 AND NOT revoked AND credential->'counter'=$5")
        .bind(SqlJson(updated)).bind(&s.chain).bind(&s.account).bind(id).bind(SqlJson(&credential["counter"])).execute(state.db.pool()).await.map_err(|_| unavailable())?.rows_affected();
    if n == 0 { return Err(conflict()); }
    let vt = save(&state,"vault",&VaultSession {account:s.account.clone(),chain:s.chain.clone(),method:"passkey-prf-v1".into(),subject:id.into()},900).await?;
    audit("vault_minted", json!({"account":s.account,"method":"passkey-prf-v1","subject":id,"result":"ok"}));
    Ok(Json(json!({"vault_token":vt,"expires_in":900})))
}
fn validate_webauthn_response(v: &Value) -> Result<()> {
    let object = v.as_object().ok_or_else(bad)?;
    if object.keys().any(|k| !["id","rawId","type","response","authenticatorAttachment","clientExtensionResults"].contains(&k.as_str())) { return Err(bad()); }
    if v.get("clientExtensionResults").is_some_and(|e| e.as_object().is_none_or(|o| !o.is_empty())) { return Err(bad()); }
    let response = v.get("response").and_then(Value::as_object).ok_or_else(bad)?;
    if response.keys().any(|k| !["clientDataJSON","attestationObject","authenticatorData","signature","userHandle","transports"].contains(&k.as_str())) { return Err(bad()); }
    Ok(())
}
fn revision(headers: &HeaderMap) -> Result<i64> {
    let n = headers.get("if-match").and_then(|v|v.to_str().ok()).ok_or_else(||error(StatusCode::PRECONDITION_REQUIRED,"revision_required"))?.parse::<i64>().map_err(|_|bad())?;
    if n < 0 || n >= u32::MAX as i64 { return Err(bad()); } Ok(n)
}
/// Strict key-set + semantics validator. Root wraps are v1 (passkey PRF, 15 keys) or v2
/// (custody method, 19 keys); agent envelopes are unchanged. Unknown keys are always rejected.
fn envelope(v: &Value, s: &OwnerSession, package: &str, root: bool, tiers: &[String]) -> Result<()> {
    let common = ["version","algorithm","kdf","chain","packageId","owner","accountId","rootId","revision","salt","nonce","ciphertext"];
    let extra = if root {
        if v["version"] == 2 {vec!["method","subject","credentialId","rpId","prfInput","codeKdf","codeSalt"]} else {vec!["credentialId","rpId","prfInput"]}
    } else {vec!["kind","signingScheme","intentHash","registrationIntent","keyId","organizationId","agentId","publicKey","derivedAddress"]};
    let o = v.as_object().ok_or_else(bad)?;
    if o.len()!=common.len()+extra.len() || o.keys().any(|k|!common.contains(&k.as_str())&&!extra.contains(&k.as_str())) { return Err(bad()); }
    if (v["version"] != 1 && !(root && v["version"] == 2)) || v["algorithm"] != "AES-256-GCM" || v["kdf"] != "HKDF-SHA256" { return Err(error(StatusCode::UNPROCESSABLE_ENTITY,"unsupported_envelope_version")); }
    if str_field(v,"chain")? != s.chain || address(str_field(v,"owner")?)? != s.owner || address(str_field(v,"accountId")?)? != s.account || address(str_field(v,"packageId")?)? != address(package)? { return Err(denied()); }
    for key in ["owner","accountId","packageId"] { if address(str_field(v,key)?)? != str_field(v,key)? { return Err(bad()); } }
    uuid::Uuid::parse_str(str_field(v,"rootId")?).map_err(|_|bad())?;
    if !v["revision"].as_u64().is_some_and(|r|r>0&&r<=u32::MAX as u64) { return Err(bad()); }
    for (k,n) in [("salt",32),("nonce",12),("ciphertext",48)] {encoded(str_field(v,k)?,n)?;}
    if root && v["version"] == 2 {
        let method = str_field(v,"method")?;
        if !crate::types::CUSTODY_METHODS.contains(&method) { return Err(error(StatusCode::UNPROCESSABLE_ENTITY,"unsupported_custody_method")); }
        if !tiers.iter().any(|tier| tier == method) { return Err(error(StatusCode::FORBIDDEN,"custody_method_disabled")); }
        let subject = str_field(v,"subject")?;
        // Canonical-empty rules: a wrap cannot be replayed under another method, and every
        // method-irrelevant field must carry its empty value.
        if method == "passkey-prf-v1" {
            if subject.is_empty() || subject.len() > 512 || subject != str_field(v,"credentialId")? { return Err(bad()); }
            let rp = str_field(v,"rpId")?;
            if rp.is_empty() || rp.len() > 253 || rp.contains(['/', ':', '*']) { return Err(bad()); }
            encoded(str_field(v,"prfInput")?,32)?;
            if str_field(v,"prfInput")? == zero32() || !str_field(v,"codeKdf")?.is_empty() || str_field(v,"codeSalt")? != zero32() { return Err(bad()); }
        } else {
            if !str_field(v,"credentialId")?.is_empty() || !str_field(v,"rpId")?.is_empty() || str_field(v,"prfInput")? != zero32() || address(subject)? != str_field(v,"owner")? { return Err(bad()); }
            if method == "recovery-code-v1" {
                if str_field(v,"codeKdf")?.strip_prefix("pbkdf2-sha256:").and_then(|n| n.parse::<u64>().ok()).is_none_or(|n| !(100000..=10000000).contains(&n)) { return Err(bad()); }
                encoded(str_field(v,"codeSalt")?,32)?;
                if str_field(v,"codeSalt")? == zero32() { return Err(bad()); }
            } else if !str_field(v,"codeKdf")?.is_empty() || str_field(v,"codeSalt")? != zero32() { return Err(bad()); }
        }
    } else if root {encoded(str_field(v,"prfInput")?,32)?;} else {
        if v["signingScheme"] != "Ed25519" { return Err(error(StatusCode::UNPROCESSABLE_ENTITY,"unsupported_signing_scheme")); }
        uuid::Uuid::parse_str(str_field(v,"keyId")?).map_err(|_|bad())?;
        for k in ["organizationId","agentId","derivedAddress"] {if address(str_field(v,k)?)? != str_field(v,k)? {return Err(bad());}}
        if !v["registrationIntent"].is_null() { crate::agent_key_setup::valid_intent(&v["registrationIntent"])?; }
        let digest = str_field(v,"intentHash")?;
        if digest.len()!=64 || !digest.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)) {return Err(bad());}
        let pk = str_field(v,"publicKey")?;
        if pk.len()!=64 || !pk.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)) {return Err(bad());}
        let bytes: [u8;32] = hex::decode(pk).map_err(|_|bad())?.try_into().map_err(|_|bad())?;
        if crate::myso::derived_address_from_public_key(&bytes) != str_field(v,"derivedAddress")? {return Err(bad());}
    }
    Ok(())
}
pub(crate) async fn registered(state: &AppState, s: &OwnerSession, v: &Value) -> Result<()> {
    let f = crate::myso::fetch_typed_object_fields(&state.http_client,&state.config.myso_rpc_url,str_field(v,"agentId")?,&state.config.package_id,"SubAgent").await.map_err(|_|unavailable())?;
    for (field,expected) in [("memory_account_id",s.account.as_str()),("principal_owner",s.owner.as_str()),("organization_id",str_field(v,"organizationId")?),("derived_address",str_field(v,"derivedAddress")?)] {
        if address(f.get(field).and_then(Value::as_str).ok_or_else(unavailable)?)? != expected {return Err(denied());}
    }
    let pk = hex::decode(str_field(v,"publicKey")?).map_err(|_|bad())?;
    let actual: Vec<u8> = f.get("public_key").and_then(Value::as_array).ok_or_else(unavailable)?.iter().map(|v|v.as_u64().and_then(|n|u8::try_from(n).ok()).ok_or_else(unavailable)).collect::<Result<_>>()?;
    if actual!=pk {return Err(denied());}
    Ok(())
}
/// Legacy passkey approval: the credential row must carry `approved_existing` and an
/// `approved_by` that is still an active method of the account — a passkey credential or the
/// subject of a non-passkey wrap (the owner address).
async fn passkey_approved(tx: &mut sqlx::PgConnection, chain: &str, account: &str, credential: &sqlx::postgres::PgRow) -> Result<bool> {
    if !credential.get::<bool,_>("approved_existing") { return Ok(false); }
    let source: Option<String> = credential.get("approved_by");
    let Some(source) = source else { return Ok(false); };
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM recovery_passkeys WHERE chain=$1 AND account_id=$2 AND credential_id=$3 AND active AND NOT revoked) OR EXISTS(SELECT 1 FROM recovery_root_wraps WHERE chain=$1 AND account_id=$2 AND subject=$3)")
        .bind(chain).bind(account).bind(source).fetch_one(tx).await.map_err(|_|unavailable())
}
async fn backups(State(state): State<Arc<AppState>>, Path(p): Path<HashMap<String,String>>, OriginalUri(uri): OriginalUri, method: Method, headers: HeaderMap, body: axum::body::Bytes) -> Result<Json<Value>> {
    let s=session(&state,&headers,&p["account_id"]).await?;
    let is_root=uri.path().ends_with("/recovery-root");
    let vt=vault(&state,&headers,&s,!is_root).await?;
    if is_root {
        if method==Method::GET {
            let wrap: Option<SqlJson<Value>>=sqlx::query_scalar("SELECT envelope FROM recovery_root_wraps WHERE chain=$1 AND account_id=$2 AND method=$3 AND subject=$4").bind(&s.chain).bind(&s.account).bind(&vt.method).bind(&vt.subject).fetch_optional(state.db.pool()).await.map_err(|_|unavailable())?;
            let Some(wrap)=wrap else {audit("wrap_get",json!({"account":s.account,"method":vt.method,"subject":vt.subject,"result":"denied","reason":"missing"}));return Err(missing());};
            return Ok(Json(wrap.0));
        }
        let v:Value=serde_json::from_slice(&body).map_err(|_|bad())?;
        envelope(&v,&s,&state.config.package_id,true,&state.config.agent_key_custody_tiers).map_err(|e|{audit("wrap_put",json!({"account":s.account,"result":"denied","reason":"envelope","status":e.0.as_u16()}));e})?;
        // The payload names the wrap row; `own` means the vault token belongs to that row.
        let payload_method=if v["version"]==2 {str_field(&v,"method")?} else {"passkey-prf-v1"};
        let payload_subject=if v["version"]==2 {str_field(&v,"subject")?} else {str_field(&v,"credentialId")?};
        let own=payload_method==vt.method && payload_subject==vt.subject;
        if payload_method=="passkey-prf-v1" && str_field(&v,"rpId")?!=std::env::var("PASSKEY_RP_ID").map_err(|_|unavailable())? {return Err(denied());}
        let old=revision(&headers)?;
        if v["revision"].as_i64()!=Some(old+1){audit("wrap_put",json!({"account":s.account,"method":payload_method,"subject":payload_subject,"revision":v["revision"],"if_match":old,"result":"denied","reason":"revision"}));return Err(conflict());}
        let mut tx=state.db.pool().begin().await.map_err(|_|unavailable())?;
        // Account advisory lock serializes first-root setup and additional method wrapping.
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))").bind(format!("{}:{}",s.chain,s.account)).execute(&mut *tx).await.map_err(|_|unavailable())?;
        let c=if payload_method=="passkey-prf-v1" {
            let c=sqlx::query("SELECT prf_input,approved_existing,approved_by FROM recovery_passkeys WHERE chain=$1 AND account_id=$2 AND credential_id=$3 AND NOT revoked FOR UPDATE").bind(&s.chain).bind(&s.account).bind(payload_subject).fetch_optional(&mut *tx).await.map_err(|_|unavailable())?.ok_or_else(denied)?;
            if c.get::<String,_>("prf_input")!=str_field(&v,"prfInput")? {return Err(denied());}
            Some(c)
        } else {None};
        // A wrap for a method/subject other than the vault token's own may only be added by an
        // already-active method of this account (today: an active passkey approving a new one).
        if !own {
            let source_active:bool=if vt.method=="passkey-prf-v1" {
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM recovery_passkeys WHERE chain=$1 AND account_id=$2 AND credential_id=$3 AND active AND NOT revoked)").bind(&s.chain).bind(&s.account).bind(&vt.subject).fetch_one(&mut *tx).await.map_err(|_|unavailable())?
            } else {
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM recovery_root_wraps WHERE chain=$1 AND account_id=$2 AND method=$3 AND subject=$4)").bind(&s.chain).bind(&s.account).bind(&vt.method).bind(&vt.subject).fetch_one(&mut *tx).await.map_err(|_|unavailable())?
            };
            if !source_active {audit("wrap_put",json!({"account":s.account,"method":payload_method,"subject":payload_subject,"vault_method":vt.method,"result":"denied","reason":"inactive_method"}));return Err(denied());}
            if let Some(c)=c.as_ref() {
                if !passkey_approved(&mut tx,&s.chain,&s.account,c).await? {audit("wrap_put",json!({"account":s.account,"method":payload_method,"subject":payload_subject,"result":"denied","reason":"passkey_approval"}));return Err(denied());}
            } else if let Some(allowed)=allowed_methods(&state,&s).await? {
                if !allowed.iter().any(|m|m==payload_method) {audit("wrap_put",json!({"account":s.account,"method":payload_method,"subject":payload_subject,"result":"denied","reason":"method_not_allowed"}));return Err(error(StatusCode::FORBIDDEN,"custody_method_not_allowed"));}
            }
        }
        let current:Option<String>=sqlx::query_scalar("SELECT root_id FROM recovery_roots WHERE chain=$1 AND account_id=$2").bind(&s.chain).bind(&s.account).fetch_optional(&mut *tx).await.map_err(|_|unavailable())?;
        if let Some(root)=current {
            if root!=str_field(&v,"rootId")? {audit("wrap_put",json!({"account":s.account,"method":payload_method,"subject":payload_subject,"root_id":str_field(&v,"rootId")?,"result":"denied","reason":"root_mismatch"}));return Err(conflict());}
            // A passkey's first wrap on an existing root needs the legacy ceremony approval.
            if own && c.is_some() {
                let same:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM recovery_root_wraps WHERE chain=$1 AND account_id=$2 AND method=$3 AND subject=$4)").bind(&s.chain).bind(&s.account).bind(payload_method).bind(payload_subject).fetch_one(&mut *tx).await.map_err(|_|unavailable())?;
                if !same && !passkey_approved(&mut tx,&s.chain,&s.account,c.as_ref().unwrap()).await? {return Err(denied());}
            }
        } else {
            sqlx::query("INSERT INTO recovery_roots VALUES($1,$2,$3)").bind(&s.chain).bind(&s.account).bind(str_field(&v,"rootId")?).execute(&mut *tx).await.map_err(|_|unavailable())?;
        }
        let previous: Option<i64> = sqlx::query_scalar("SELECT revision FROM recovery_root_wraps WHERE chain=$1 AND account_id=$2 AND method=$3 AND subject=$4")
            .bind(&s.chain).bind(&s.account).bind(payload_method).bind(payload_subject).fetch_optional(&mut *tx).await.map_err(|_|unavailable())?;
        if previous.unwrap_or(0) != old { return Err(conflict()); }
        let n=sqlx::query("INSERT INTO recovery_root_wraps(chain,account_id,method,subject,credential_id,envelope,revision) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(chain,account_id,method,subject) DO UPDATE SET envelope=EXCLUDED.envelope,revision=EXCLUDED.revision WHERE recovery_root_wraps.revision=$8")
            .bind(&s.chain).bind(&s.account).bind(payload_method).bind(payload_subject).bind((payload_method=="passkey-prf-v1").then_some(payload_subject)).bind(SqlJson(&v)).bind(old+1).bind(old).execute(&mut *tx).await.map_err(|_|unavailable())?.rows_affected();
        if n==0 || (old>0&&v["revision"]==1) {return Err(conflict());}
        // An absent row must have revision 1. Existing update is checked above.
        if c.is_some() {sqlx::query("UPDATE recovery_passkeys SET active=TRUE WHERE chain=$1 AND account_id=$2 AND credential_id=$3").bind(&s.chain).bind(&s.account).bind(&vt.subject).execute(&mut *tx).await.map_err(|_|unavailable())?;}
        tx.commit().await.map_err(|_|unavailable())?;
        audit("wrap_put",json!({"account":s.account,"method":payload_method,"subject":payload_subject,"root_id":str_field(&v,"rootId")?,"revision":old+1,"version":v["version"],"result":"ok"}));
        return Ok(Json(json!({"saved":true})));
    }
    let draft=uri.path().contains("/agent-key-drafts");
    let finalize=uri.path().ends_with("/finalize");
    let table=if draft&&!finalize{"agent_key_drafts"}else{"agent_key_envelopes"};
    let field=if table=="agent_key_drafts"{"key_id"}else{"agent_id"};
    let id=p.get(if draft{"key_id"}else{"agent_id"});
    if method==Method::GET {
        if let Some(id)=id {
            let query=format!("SELECT envelope FROM {table} WHERE chain=$1 AND account_id=$2 AND {field}=$3");
            let v:Option<SqlJson<Value>>=sqlx::query_scalar(&query).bind(&s.chain).bind(&s.account).bind(id).fetch_optional(state.db.pool()).await.map_err(|_|unavailable())?;
            let v=v.ok_or_else(missing)?.0;
            if !draft{registered(&state,&s,&v).await?;}
            return Ok(Json(v));
        }
        let query=format!("SELECT envelope FROM {table} WHERE chain=$1 AND account_id=$2 ORDER BY {field}");
        let rows:Vec<SqlJson<Value>>=sqlx::query_scalar(&query).bind(&s.chain).bind(&s.account).fetch_all(state.db.pool()).await.map_err(|_|unavailable())?;
        if !draft {for row in &rows{registered(&state,&s,&row.0).await?;}}
        return Ok(Json(json!(rows.into_iter().map(|v|v.0).collect::<Vec<_>>())));
    }
    if method==Method::DELETE {
        let old=revision(&headers)?;
        if !draft {
            let row:Option<SqlJson<Value>>=sqlx::query_scalar("SELECT envelope FROM agent_key_envelopes WHERE chain=$1 AND account_id=$2 AND agent_id=$3").bind(&s.chain).bind(&s.account).bind(id.ok_or_else(bad)?).fetch_optional(state.db.pool()).await.map_err(|_|unavailable())?;
            registered(&state,&s,&row.ok_or_else(missing)?.0).await?;
        }
        let query=format!("DELETE FROM {table} WHERE chain=$1 AND account_id=$2 AND {field}=$3 AND revision=$4");
        let n=sqlx::query(&query).bind(&s.chain).bind(&s.account).bind(id.ok_or_else(bad)?).bind(old).execute(state.db.pool()).await.map_err(|_|unavailable())?.rows_affected();
        if n==0{return Err(conflict());} return Ok(Json(json!({"deleted":true})));
    }
    let v:Value=serde_json::from_slice(&body).map_err(|_|bad())?;
    envelope(&v,&s,&state.config.package_id,false,&state.config.agent_key_custody_tiers)?;
    let root:Option<String>=sqlx::query_scalar("SELECT root_id FROM recovery_roots WHERE chain=$1 AND account_id=$2").bind(&s.chain).bind(&s.account).fetch_optional(state.db.pool()).await.map_err(|_|unavailable())?;
    if root.as_deref()!=Some(str_field(&v,"rootId")?){return Err(denied());}
    if draft && str_field(&v,"keyId")?!=id.ok_or_else(bad)? {return Err(bad());}
    if !draft && str_field(&v,"agentId")?!=id.ok_or_else(bad)? {return Err(bad());}
    if !draft||finalize {if v["kind"]!="agent"{return Err(bad());} registered(&state,&s,&v).await?;} else if v["kind"]!="draft" || address(str_field(&v,"agentId")?)?!=format!("0x{}","0".repeat(64)){return Err(bad());}
    let old=if finalize{0}else{revision(&headers)?};
    if v["revision"].as_i64()!=Some(old+1){return Err(conflict());}
    let mut tx=state.db.pool().begin().await.map_err(|_|unavailable())?;
    if finalize {
        let row:Option<SqlJson<Value>>=sqlx::query_scalar("SELECT envelope FROM agent_key_drafts WHERE chain=$1 AND account_id=$2 AND key_id=$3 FOR UPDATE").bind(&s.chain).bind(&s.account).bind(str_field(&v,"keyId")?).fetch_optional(&mut *tx).await.map_err(|_|unavailable())?;
        if let Some(row)=row {
            for key in ["rootId","keyId","publicKey","derivedAddress","organizationId","intentHash","registrationIntent"]{if row.0[key]!=v[key]{return Err(denied());}}
        } else {
            let same:Option<SqlJson<Value>>=sqlx::query_scalar("SELECT envelope FROM agent_key_envelopes WHERE chain=$1 AND account_id=$2 AND key_id=$3").bind(&s.chain).bind(&s.account).bind(str_field(&v,"keyId")?).fetch_optional(&mut *tx).await.map_err(|_|unavailable())?;
            if same.is_some_and(|e| ["rootId","keyId","agentId","publicKey","derivedAddress","organizationId","intentHash","registrationIntent"].iter().all(|k|e.0[*k]==v[*k])){return Ok(Json(json!({"saved":true})));} return Err(conflict());
        }
    }
    // Serialize by identity so nonexistent-row creation also honors If-Match.
    let identity=str_field(&v,if table=="agent_key_drafts"{"keyId"}else{"agentId"})?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))").bind(format!("{}:{}:{}:{}",s.chain,s.account,table,identity)).execute(&mut *tx).await.map_err(|_|unavailable())?;
    let existing_query=format!("SELECT revision FROM {table} WHERE chain=$1 AND account_id=$2 AND {field}=$3");
    let current:Option<i64>=sqlx::query_scalar(&existing_query).bind(&s.chain).bind(&s.account).bind(identity).fetch_optional(&mut *tx).await.map_err(|_|unavailable())?;
    if current.unwrap_or(0)!=old{return Err(conflict());}
    let query=if table=="agent_key_drafts" {"INSERT INTO agent_key_drafts(chain,account_id,key_id,envelope,revision,registration_intent) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(chain,account_id,key_id) DO UPDATE SET envelope=EXCLUDED.envelope,revision=EXCLUDED.revision,registration_intent=EXCLUDED.registration_intent"} else {"INSERT INTO agent_key_envelopes(chain,account_id,agent_id,envelope,revision,key_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(chain,account_id,agent_id) DO UPDATE SET envelope=EXCLUDED.envelope,revision=EXCLUDED.revision,key_id=EXCLUDED.key_id"};
    let query=sqlx::query(query).bind(&s.chain).bind(&s.account).bind(identity).bind(SqlJson(&v)).bind(old+1);
    let query=if table=="agent_key_envelopes"{query.bind(str_field(&v,"keyId")?)}else{query.bind(v.get("registrationIntent").filter(|v|!v.is_null()).cloned().map(SqlJson))};
    query.execute(&mut *tx).await.map_err(|_|conflict())?;
    if finalize {
        sqlx::query("UPDATE agent_key_envelopes SET registration_intent=(SELECT registration_intent FROM agent_key_drafts WHERE chain=$1 AND account_id=$2 AND key_id=$3) WHERE chain=$1 AND account_id=$2 AND key_id=$3")
            .bind(&s.chain).bind(&s.account).bind(str_field(&v,"keyId")?).execute(&mut *tx).await.map_err(|_|unavailable())?;
        sqlx::query("DELETE FROM agent_key_drafts WHERE chain=$1 AND account_id=$2 AND key_id=$3").bind(&s.chain).bind(&s.account).bind(str_field(&v,"keyId")?).execute(&mut *tx).await.map_err(|_|unavailable())?;}
    tx.commit().await.map_err(|_|unavailable())?;
    Ok(Json(json!({"saved":true})))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn rejects_extension_secrets(){assert!(validate_webauthn_response(&json!({"id":"a","response":{},"clientExtensionResults":{"prf":{"results":{"first":"secret"}}}})).is_err());}
    #[test] fn address_is_strict(){assert!(address("0xZZ").is_err());assert_eq!(address("0x1").unwrap().len(),66);}
    #[test] fn custody_root_wrap_key_sets_are_strict(){
        use base64::Engine;
        let s=OwnerSession{account:address("0x11").unwrap(),owner:address("0x22").unwrap(),chain:"test-chain".into()};
        let tiers=vec!["passkey-prf-v1".to_string(),"zklogin-root-v1".to_string()];
        let enc=|n|base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(vec![0u8;n]);
        let prf=base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([1u8;32]);
        let root_id=uuid::Uuid::new_v4().to_string();
        // v1 root wraps keep their exact 15-key shape.
        let v1=json!({"version":1,"algorithm":"AES-256-GCM","kdf":"HKDF-SHA256","chain":"test-chain","packageId":address("0x1").unwrap(),"owner":address("0x22").unwrap(),"accountId":address("0x11").unwrap(),"rootId":root_id,"credentialId":"AA","rpId":"localhost","prfInput":prf.clone(),"revision":1,"salt":enc(32),"nonce":enc(12),"ciphertext":enc(48)});
        assert!(envelope(&v1,&s,"0x1",true,&tiers).is_ok());
        assert!(envelope(&v1,&s,"0x1",false,&tiers).is_err());
        let v2=json!({"version":2,"algorithm":"AES-256-GCM","kdf":"HKDF-SHA256","method":"zklogin-root-v1","chain":"test-chain","packageId":address("0x1").unwrap(),"owner":address("0x22").unwrap(),"accountId":address("0x11").unwrap(),"rootId":root_id,"subject":address("0x22").unwrap(),"revision":1,"credentialId":"","rpId":"","prfInput":enc(32),"codeKdf":"","codeSalt":enc(32),"salt":enc(32),"nonce":enc(12),"ciphertext":enc(48)});
        assert!(envelope(&v2,&s,"0x1",true,&tiers).is_ok());
        let mut unknown=v2.clone();unknown["seed"]=json!("secret");
        assert!(envelope(&unknown,&s,"0x1",true,&tiers).is_err());
        let mut missing=v2.clone();missing.as_object_mut().unwrap().remove("codeKdf");
        assert!(envelope(&missing,&s,"0x1",true,&tiers).is_err());
        let mut leaked=v2.clone();leaked["credentialId"]=json!("AA");
        assert!(envelope(&leaked,&s,"0x1",true,&tiers).is_err());
        let mut empty=v2.clone();empty["prfInput"]=json!("");
        assert!(envelope(&empty,&s,"0x1",true,&tiers).is_err());
        let mut other_owner=v2.clone();other_owner["subject"]=json!(address("0x55").unwrap());
        assert!(envelope(&other_owner,&s,"0x1",true,&tiers).is_err());
        let mut code=v2.clone();code["method"]=json!("recovery-code-v1");code["codeKdf"]=json!("pbkdf2-sha256:99999");code["codeSalt"]=json!(prf);
        assert!(envelope(&code,&s,"0x1",true,&tiers).is_err());
        let mut disabled=v2.clone();disabled["method"]=json!("device-key-v1");
        assert_eq!(envelope(&disabled,&s,"0x1",true,&tiers).unwrap_err().0,StatusCode::FORBIDDEN);
        assert_eq!(envelope(&v2,&s,"0x1",true,&vec!["passkey-prf-v1".to_string()]).unwrap_err().0,StatusCode::FORBIDDEN);
    }
}

#[cfg(test)]
mod integration {
    use super::*;
    use axum::{body::{Body,to_bytes},http::Request};
    use tower::ServiceExt;
    async fn call(app:&Router,method:&str,path:&str,owner:&str,vault:&str,value:Value,rev:Option<u32>)->(StatusCode,Value){
        let mut request=Request::builder().method(method).uri(path).header("content-type","application/json");
        if !owner.is_empty(){request=request.header("authorization",format!("Bearer {owner}"));}
        if !vault.is_empty(){request=request.header("x-vault-token",vault);}
        if let Some(rev)=rev{request=request.header("if-match",rev.to_string());}
        let response=app.clone().oneshot(request.body(Body::from(if value.is_null(){String::new()}else{value.to_string()})).unwrap()).await.unwrap();
        let status=response.status();let bytes=to_bytes(response.into_body(),65536).await.unwrap();
        (status,serde_json::from_slice(&bytes).unwrap_or_else(|_|json!({})))
    }
    #[tokio::test]
    #[ignore = "requires isolated PostgreSQL pgvector and Redis; see docs/agent-key-backups.md"]
    async fn key_backup_integration(){
        let database=std::env::var("TEST_KEY_BACKUP_DATABASE_URL").expect("isolated test database required");
        assert!(database.contains("agent_key_backup_test"),"Use a dedicated test database");
        let redis_url=std::env::var("TEST_KEY_BACKUP_REDIS_URL").expect("isolated Redis required");
        let account=address("0x11").unwrap();let owner_address=address("0x22").unwrap();let organization=address("0x33").unwrap();let agent=address("0x44").unwrap();
        let pk=ed25519_dalek::SigningKey::from_bytes(&[9u8;32]).verifying_key().to_bytes();
        let derived=crate::myso::derived_address_from_public_key(&pk);
        let account_copy=account.clone();let owner_copy=owner_address.clone();let org_copy=organization.clone();let agent_copy=agent.clone();let derived_copy=derived.clone();
        let mock=Router::new().route("/rpc",post(move |Json(v):Json<Value>|{
            let a=account_copy.clone();let o=owner_copy.clone();let org=org_copy.clone();let ag=agent_copy.clone();let d=derived_copy.clone();
            async move {Json(if v["method"]=="myso_getChainIdentifier"{json!({"result":"test-chain"})}else if v["params"][0]==a {json!({"result":{"data":{"content":{"type":"0x1::memory::MemoryAccount","fields":{"owner":o,"active":true}}}}})}else if v["params"][0]==ag{json!({"result":{"data":{"content":{"type":"0x1::memory::SubAgent","fields":{"memory_account_id":a,"principal_owner":o,"organization_id":org,"derived_address":d,"public_key":pk,"active":true}}}}})}else{json!({"error":"missing"})})}
        })).route("/key-backup/{op}",post(|Path(op):Path<String>,Json(v):Json<Value>|async move{
            Json(match op.as_str(){
                "owner"=>json!({"verified":true}),
                "registration-options"=>json!({"challenge":"Y2hhbGxlbmdl"}),
                "registration-verify"=>json!({"id":v["response"]["id"],"publicKey":"AA","counter":0,"transports":[]}),
                "authentication-options"=>json!({"challenge":"Y2hhbGxlbmdl"}),
                "authentication-verify"=>json!({"counter":0}),_=>json!({})})
        }));
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let endpoint=format!("http://{}",listener.local_addr().unwrap());
        let task=tokio::spawn(async move{axum::serve(listener,mock).await.unwrap();});
        let db=crate::db::VectorDb::new(&database).await.unwrap();
        // Reapplication verifies these migrations remain compatible with the existing startup runner.
        let _=crate::db::VectorDb::new(&database).await.unwrap();
        let mut config=crate::types::Config::from_env();config.package_id="0x1".into();config.myso_rpc_url=format!("{endpoint}/rpc");config.sidecar_url=endpoint;config.sidecar_secret=Some("test-service-auth".into());
        config.agent_key_custody_tiers=vec!["passkey-prf-v1".into(),"zklogin-root-v1".into(),"recovery-code-v1".into()];
        config.agent_key_require_tier=None;config.agent_key_unlock_per_minute=3;
        let redis=redis::Client::open(redis_url).unwrap().get_multiplexed_async_connection().await.unwrap();
        let state=Arc::new(AppState{db,config,http_client:reqwest::Client::new(),key_pool:crate::types::KeyPool::new(vec![]),redis,
            fallback_rate_limit:tokio::sync::Mutex::new(crate::rate_limit::InMemoryFallback::default()),org_summaries:crate::org_summary::OrgSummaryCache::new(),r2:None});
        // A run finishing inside the same minute must not consume this run's custody budget.
        let mut limiter=state.redis.clone();
        let _: i64=redis::cmd("DEL").arg(format!("keybackup:custody-rate:test-chain:{account}:{}",chrono::Utc::now().timestamp()/60)).query_async(&mut limiter).await.unwrap();
        let app=router().with_state(state.clone());let base=format!("/api/accounts/{account}");
        assert_eq!(call(&app,"GET",&format!("{base}/passkeys"),"","",Value::Null,None).await.0,StatusCode::UNAUTHORIZED);
        let (status,c)=call(&app,"POST","/api/owner/auth/challenge","","",json!({"account_id":account}),None).await;assert_eq!(status,StatusCode::OK);
        let verify_body=json!({"challenge_id":c["challenge_id"],"signature":"test-public-signature"});
        let (status,s)=call(&app,"POST","/api/owner/auth/verify","","",verify_body.clone(),None).await;assert_eq!(status,StatusCode::OK);
        assert_eq!(call(&app,"POST","/api/owner/auth/verify","","",verify_body,None).await.0,StatusCode::UNAUTHORIZED);
        let ot=s["owner_token"].as_str().unwrap();
        use base64::Engine;
        let enc=|n|base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(vec![0u8;n]);
        let root_id=uuid::Uuid::new_v4().to_string();let key_id=uuid::Uuid::new_v4().to_string();
        // Login-root custody: an account with zero passkeys adopts zklogin-root-v1 and stores the
        // first wrap of its root without any WebAuthn ceremony.
        let (status,cz)=call(&app,"POST","/api/owner/auth/challenge","","",json!({"account_id":account,"purpose":"custody-unlock-zklogin-root-v1"}),None).await;assert_eq!(status,StatusCode::OK);
        assert_eq!(cz["purpose"],json!("custody-unlock-zklogin-root-v1"));
        assert!(cz["message"].as_str().unwrap().starts_with("mysocial-key-backup-owner-v2|"));
        assert_eq!(call(&app,"POST","/api/owner/auth/challenge","","",json!({"account_id":account,"purpose":"custody-unlock-nope-v1"}),None).await.0,StatusCode::BAD_REQUEST);
        let (status,zs)=call(&app,"POST","/api/owner/auth/verify","","",json!({"challenge_id":cz["challenge_id"],"signature":"test-public-signature"}),None).await;assert_eq!(status,StatusCode::OK);
        assert_eq!(zs["vault_method"],json!("zklogin-root-v1"));assert_eq!(zs["vault_subject"],json!(owner_address));
        let zvt=zs["vault_token"].as_str().unwrap();
        let zwrap=json!({"version":2,"algorithm":"AES-256-GCM","kdf":"HKDF-SHA256","method":"zklogin-root-v1","chain":"test-chain","packageId":address("0x1").unwrap(),"owner":owner_address,"accountId":account,"rootId":root_id,"subject":owner_address,"revision":1,"credentialId":"","rpId":"","prfInput":enc(32),"codeKdf":"","codeSalt":enc(32),"salt":enc(32),"nonce":enc(12),"ciphertext":enc(48)});
        let mut violates=zwrap.clone();violates["rpId"]=json!("localhost");
        assert_eq!(call(&app,"PUT",&format!("{base}/recovery-root"),ot,zvt,violates,Some(0)).await.0,StatusCode::BAD_REQUEST);
        let mut unknown_field=zwrap.clone();unknown_field["seed"]=json!("secret");
        assert_eq!(call(&app,"PUT",&format!("{base}/recovery-root"),ot,zvt,unknown_field,Some(0)).await.0,StatusCode::BAD_REQUEST);
        let mut disabled=zwrap.clone();disabled["method"]=json!("device-key-v1");
        let (status,d)=call(&app,"PUT",&format!("{base}/recovery-root"),ot,zvt,disabled,Some(0)).await;assert_eq!(status,StatusCode::FORBIDDEN);assert_eq!(d["code"],json!("custody_method_disabled"));
        assert_eq!(call(&app,"PUT",&format!("{base}/recovery-root"),ot,zvt,zwrap.clone(),None).await.0,StatusCode::PRECONDITION_REQUIRED);
        assert_eq!(call(&app,"PUT",&format!("{base}/recovery-root"),ot,zvt,zwrap.clone(),Some(0)).await.0,StatusCode::OK);
        assert_eq!(call(&app,"PUT",&format!("{base}/recovery-root"),ot,zvt,zwrap.clone(),Some(0)).await.0,StatusCode::CONFLICT);
        assert_eq!(call(&app,"GET",&format!("{base}/recovery-root"),ot,zvt,Value::Null,None).await.1,zwrap);
        // Passkey registration on an account that already has a root needs a live unlock.
        assert_eq!(call(&app,"POST",&format!("{base}/passkeys/registration/options"),ot,"",json!({}),None).await.0,StatusCode::UNAUTHORIZED);
        let (_,options)=call(&app,"POST",&format!("{base}/passkeys/registration/options"),ot,zvt,json!({}),None).await;
        let response=json!({"id":"AA","response":{},"clientExtensionResults":{}});
        let (status,registered)=call(&app,"POST",&format!("{base}/passkeys/registration/verify"),ot,"",json!({"ceremony_id":options["ceremony_id"],"response":response}),None).await;assert_eq!(status,StatusCode::OK);
        let (_,options)=call(&app,"POST",&format!("{base}/passkeys/authentication/options"),ot,"",json!({"credential_id":"AA"}),None).await;
        let (status,verified)=call(&app,"POST",&format!("{base}/passkeys/authentication/verify"),ot,"",json!({"ceremony_id":options["ceremony_id"],"response":response}),None).await;assert_eq!(status,StatusCode::OK);
        let vt=verified["vault_token"].as_str().unwrap();
        assert_eq!(call(&app,"GET",&format!("{base}/agent-key-envelopes"),ot,vt,Value::Null,None).await.0,StatusCode::FORBIDDEN);
        let root=json!({"version":1,"algorithm":"AES-256-GCM","kdf":"HKDF-SHA256","chain":"test-chain","packageId":address("0x1").unwrap(),"owner":owner_address,"accountId":account,"rootId":root_id,"credentialId":"AA","rpId":"localhost","prfInput":registered["prf_input"],"revision":1,"salt":enc(32),"nonce":enc(12),"ciphertext":enc(48)});
        let mut wrong_root=root.clone();wrong_root["rootId"]=json!(uuid::Uuid::new_v4().to_string());
        assert_eq!(call(&app,"PUT",&format!("{base}/recovery-root"),ot,vt,wrong_root,Some(0)).await.0,StatusCode::CONFLICT);
        assert_eq!(call(&app,"PUT",&format!("{base}/recovery-root"),ot,vt,root.clone(),None).await.0,StatusCode::PRECONDITION_REQUIRED);
        let (status,_) =call(&app,"PUT",&format!("{base}/recovery-root"),ot,vt,root.clone(),Some(0)).await;assert_eq!(status,StatusCode::OK);
        assert_eq!(call(&app,"PUT",&format!("{base}/recovery-root"),ot,vt,root.clone(),Some(0)).await.0,StatusCode::CONFLICT);
        let draft=json!({"version":1,"algorithm":"AES-256-GCM","kdf":"HKDF-SHA256","kind":"draft","signingScheme":"Ed25519","intentHash":"0000000000000000000000000000000000000000000000000000000000000000","registrationIntent":null,"chain":"test-chain","packageId":address("0x1").unwrap(),"owner":owner_address,"accountId":account,"rootId":root_id,"keyId":key_id,"organizationId":organization,"agentId":address("0x0").unwrap(),"publicKey":hex::encode(pk),"derivedAddress":derived,"revision":1,"salt":enc(32),"nonce":enc(12),"ciphertext":enc(48)});
        let draft_path=format!("{base}/agent-key-drafts/{key_id}");
        assert_eq!(call(&app,"PUT",&draft_path,ot,vt,draft.clone(),Some(0)).await.0,StatusCode::OK);
        assert_eq!(call(&app,"PUT",&draft_path,ot,vt,draft.clone(),Some(0)).await.0,StatusCode::CONFLICT);
        let mut invalid=draft.clone();invalid["seed"]=json!("secret");
        assert_eq!(call(&app,"PUT",&draft_path,ot,vt,invalid,Some(0)).await.0,StatusCode::BAD_REQUEST);
        let mut final_envelope=draft.clone();final_envelope["kind"]=json!("agent");final_envelope["agentId"]=json!(agent);
        assert_eq!(call(&app,"POST",&format!("{draft_path}/finalize"),ot,vt,final_envelope.clone(),None).await.0,StatusCode::OK);
        assert_eq!(call(&app,"POST",&format!("{draft_path}/finalize"),ot,vt,final_envelope.clone(),None).await.0,StatusCode::OK);
        assert_eq!(call(&app,"GET",&draft_path,ot,vt,Value::Null,None).await.0,StatusCode::NOT_FOUND);
        assert_eq!(call(&app,"GET",&format!("{base}/agents/{agent}/key-envelope"),ot,vt,Value::Null,None).await.1,final_envelope);
        let other=address("0x99").unwrap();
        assert_eq!(call(&app,"GET",&format!("/api/accounts/{other}/agent-key-envelopes"),ot,vt,Value::Null,None).await.0,StatusCode::FORBIDDEN);
        // The account now has two independently encrypted wraps of one root, one per method.
        assert_eq!(call(&app,"GET",&format!("{base}/recovery-root"),ot,vt,Value::Null,None).await.1,root);
        assert_eq!(call(&app,"GET",&format!("{base}/recovery-root"),ot,zvt,Value::Null,None).await.1,zwrap);
        let (status,summaries)=call(&app,"GET",&format!("{base}/recovery-roots"),ot,"",Value::Null,None).await;assert_eq!(status,StatusCode::OK);
        let listed=summaries.as_array().unwrap();assert_eq!(listed.len(),2);
        assert!(listed.iter().any(|w|w["method"]==json!("passkey-prf-v1")&&w["subject"]==json!("AA")));
        assert!(listed.iter().any(|w|w["method"]==json!("zklogin-root-v1")&&w["subject"]==json!(owner_address)&&w["revision"]==json!(1)));
        let (status,policy)=call(&app,"GET",&format!("{base}/custody-policy"),ot,"",Value::Null,None).await;assert_eq!(status,StatusCode::OK);
        assert_eq!(policy["allowed_methods"],json!(["passkey-prf-v1","zklogin-root-v1","recovery-code-v1"]));
        assert!(policy["active_method"].is_null()&&policy["updated_at"].is_null());
        // Dropping a live method needs an unlock from a method that stays allowed.
        let narrowed=json!({"allowed_methods":["passkey-prf-v1"],"active_method":"passkey-prf-v1"});
        assert_eq!(call(&app,"PUT",&format!("{base}/custody-policy"),ot,"",narrowed.clone(),None).await.0,StatusCode::UNAUTHORIZED);
        assert_eq!(call(&app,"PUT",&format!("{base}/custody-policy"),ot,zvt,narrowed.clone(),None).await.0,StatusCode::FORBIDDEN);
        assert_eq!(call(&app,"PUT",&format!("{base}/custody-policy"),ot,vt,narrowed.clone(),None).await.0,StatusCode::OK);
        let (_,saved)=call(&app,"GET",&format!("{base}/custody-policy"),ot,"",Value::Null,None).await;
        assert_eq!(saved["allowed_methods"],json!(["passkey-prf-v1"]));assert_eq!(saved["active_method"],json!("passkey-prf-v1"));
        let (status,d)=call(&app,"PUT",&format!("{base}/custody-policy"),ot,vt,json!({"allowed_methods":["passkey-prf-v1","device-key-v1"],"active_method":null}),None).await;
        assert_eq!(status,StatusCode::FORBIDDEN);assert_eq!(d["code"],json!("custody_method_disabled"));
        // Per-account unlock throttling (AGENT_KEY_UNLOCK_PER_MINUTE).
        let mut limited=false;
        for _ in 0..8 {if call(&app,"POST","/api/owner/auth/challenge","","",json!({"account_id":account}),None).await.0==StatusCode::TOO_MANY_REQUESTS{limited=true;break;}}
        assert!(limited,"challenge issuance must be capped per account");
        assert_eq!(call(&app,"DELETE",&format!("{base}/passkeys/AA"),ot,vt,Value::Null,None).await.0,StatusCode::CONFLICT);
        sqlx::query("UPDATE recovery_passkeys SET revoked=TRUE WHERE chain='test-chain'").execute(state.db.pool()).await.unwrap();
        assert_eq!(call(&app,"GET",&format!("{base}/agent-key-envelopes"),ot,vt,Value::Null,None).await.0,StatusCode::FORBIDDEN);
        task.abort();
    }
}
