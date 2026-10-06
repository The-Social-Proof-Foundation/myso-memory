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
    if v.credential == p["credential_id"] { return Err(error(StatusCode::CONFLICT,"unlock_with_another_passkey")); }
    let mut tx = state.db.pool().begin().await.map_err(|_| unavailable())?;
    sqlx::query("SELECT root_id FROM recovery_roots WHERE chain=$1 AND account_id=$2 FOR UPDATE").bind(&s.chain).bind(&s.account).fetch_optional(&mut *tx).await.map_err(|_| unavailable())?;
    let n = sqlx::query("UPDATE recovery_passkeys SET revoked=TRUE WHERE chain=$1 AND account_id=$2 AND credential_id=$3 AND NOT revoked").bind(&s.chain).bind(&s.account).bind(&p["credential_id"]).execute(&mut *tx).await.map_err(|_| unavailable())?.rows_affected();
    if n == 0 { return Err(missing()); }
    tx.commit().await.map_err(|_| unavailable())?;
    Ok(Json(json!({"removed":true})))
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
        let approved_by = if operation == "registration" && existing { Some(vault(&state,&headers,&s,true).await?.credential) } else { None };
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
            let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM recovery_passkeys WHERE chain=$1 AND account_id=$2 AND credential_id=$3 AND active AND NOT revoked)").bind(&s.chain).bind(&s.account).bind(source).fetch_one(state.db.pool()).await.map_err(|_|unavailable())?;
            if !active {return Err(denied());}
        }
        let credential = sidecar(&state,"registration-verify",json!({"rpId":rp,"origins":origins,"challenge":c.challenge,"response":input.response})).await?;
        let id = str_field(&credential,"id")?.to_string();
        let prf_input = base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, [uuid::Uuid::new_v4().as_bytes().as_slice(),uuid::Uuid::new_v4().as_bytes().as_slice()].concat());
        let n = sqlx::query("INSERT INTO recovery_passkeys(chain,account_id,credential_id,credential,prf_input,approved_existing,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING")
            .bind(&s.chain).bind(&s.account).bind(&id).bind(SqlJson(&credential)).bind(&prf_input).bind(c.approved_existing).bind(c.approved_by).execute(state.db.pool()).await.map_err(|_| unavailable())?.rows_affected();
        if n == 0 { return Err(conflict()); }
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
    let vt = save(&state,"vault",&VaultSession {account:s.account,chain:s.chain,credential:id.into()},900).await?;
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
fn envelope(v: &Value, s: &OwnerSession, package: &str, root: bool) -> Result<()> {
    let common = ["version","algorithm","kdf","chain","packageId","owner","accountId","rootId","revision","salt","nonce","ciphertext"];
    let extra = if root { vec!["credentialId","rpId","prfInput"] } else {vec!["kind","signingScheme","intentHash","registrationIntent","keyId","organizationId","agentId","publicKey","derivedAddress"]};
    let o = v.as_object().ok_or_else(bad)?;
    if o.len()!=common.len()+extra.len() || o.keys().any(|k|!common.contains(&k.as_str())&&!extra.contains(&k.as_str())) { return Err(bad()); }
    if v["version"] != 1 || v["algorithm"] != "AES-256-GCM" || v["kdf"] != "HKDF-SHA256" { return Err(error(StatusCode::UNPROCESSABLE_ENTITY,"unsupported_envelope_version")); }
    if str_field(v,"chain")? != s.chain || address(str_field(v,"owner")?)? != s.owner || address(str_field(v,"accountId")?)? != s.account || address(str_field(v,"packageId")?)? != address(package)? { return Err(denied()); }
    for key in ["owner","accountId","packageId"] { if address(str_field(v,key)?)? != str_field(v,key)? { return Err(bad()); } }
    uuid::Uuid::parse_str(str_field(v,"rootId")?).map_err(|_|bad())?;
    if !v["revision"].as_u64().is_some_and(|r|r>0&&r<=u32::MAX as u64) { return Err(bad()); }
    for (k,n) in [("salt",32),("nonce",12),("ciphertext",48)] {encoded(str_field(v,k)?,n)?;}
    if root {encoded(str_field(v,"prfInput")?,32)?;} else {
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
async fn backups(State(state): State<Arc<AppState>>, Path(p): Path<HashMap<String,String>>, OriginalUri(uri): OriginalUri, method: Method, headers: HeaderMap, body: axum::body::Bytes) -> Result<Json<Value>> {
    let s=session(&state,&headers,&p["account_id"]).await?;
    let is_root=uri.path().ends_with("/recovery-root");
    let vt=vault(&state,&headers,&s,!is_root).await?;
    if is_root {
        if method==Method::GET {
            let wrap: Option<SqlJson<Value>>=sqlx::query_scalar("SELECT envelope FROM recovery_root_wraps WHERE chain=$1 AND account_id=$2 AND credential_id=$3").bind(&s.chain).bind(&s.account).bind(&vt.credential).fetch_optional(state.db.pool()).await.map_err(|_|unavailable())?;
            return Ok(Json(wrap.ok_or_else(missing)?.0));
        }
        let v:Value=serde_json::from_slice(&body).map_err(|_|bad())?;
        envelope(&v,&s,&state.config.package_id,true)?;
        if str_field(&v,"credentialId")?!=vt.credential || str_field(&v,"rpId")?!=std::env::var("PASSKEY_RP_ID").map_err(|_|unavailable())? {return Err(denied());}
        let old=revision(&headers)?;
        if v["revision"].as_i64()!=Some(old+1){return Err(conflict());}
        let mut tx=state.db.pool().begin().await.map_err(|_|unavailable())?;
        // Account advisory lock serializes first-root setup and additional credential wrapping.
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))").bind(format!("{}:{}",s.chain,s.account)).execute(&mut *tx).await.map_err(|_|unavailable())?;
        let c=sqlx::query("SELECT prf_input,approved_existing,approved_by FROM recovery_passkeys WHERE chain=$1 AND account_id=$2 AND credential_id=$3 AND NOT revoked FOR UPDATE").bind(&s.chain).bind(&s.account).bind(&vt.credential).fetch_optional(&mut *tx).await.map_err(|_|unavailable())?.ok_or_else(denied)?;
        if c.get::<String,_>("prf_input")!=str_field(&v,"prfInput")? {return Err(denied());}
        let current:Option<String>=sqlx::query_scalar("SELECT root_id FROM recovery_roots WHERE chain=$1 AND account_id=$2").bind(&s.chain).bind(&s.account).fetch_optional(&mut *tx).await.map_err(|_|unavailable())?;
        if let Some(root)=current {
            if root!=str_field(&v,"rootId")? {return Err(conflict());}
            let same:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM recovery_root_wraps WHERE chain=$1 AND account_id=$2 AND credential_id=$3)").bind(&s.chain).bind(&s.account).bind(&vt.credential).fetch_one(&mut *tx).await.map_err(|_|unavailable())?;
            if !same&&!c.get::<bool,_>("approved_existing"){return Err(denied());}
            if !same {
                let source:Option<String>=c.get("approved_by");
                let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM recovery_passkeys WHERE chain=$1 AND account_id=$2 AND credential_id=$3 AND active AND NOT revoked)")
                    .bind(&s.chain).bind(&s.account).bind(source.ok_or_else(denied)?).fetch_one(&mut *tx).await.map_err(|_|unavailable())?;
                if !active{return Err(denied());}
            }
        } else {
            sqlx::query("INSERT INTO recovery_roots VALUES($1,$2,$3)").bind(&s.chain).bind(&s.account).bind(str_field(&v,"rootId")?).execute(&mut *tx).await.map_err(|_|unavailable())?;
        }
        let previous: Option<i64> = sqlx::query_scalar("SELECT revision FROM recovery_root_wraps WHERE chain=$1 AND account_id=$2 AND credential_id=$3")
            .bind(&s.chain).bind(&s.account).bind(&vt.credential).fetch_optional(&mut *tx).await.map_err(|_|unavailable())?;
        if previous.unwrap_or(0) != old { return Err(conflict()); }
        let n=sqlx::query("INSERT INTO recovery_root_wraps VALUES($1,$2,$3,$4,$5) ON CONFLICT(chain,account_id,credential_id) DO UPDATE SET envelope=EXCLUDED.envelope,revision=EXCLUDED.revision WHERE recovery_root_wraps.revision=$6")
            .bind(&s.chain).bind(&s.account).bind(&vt.credential).bind(SqlJson(&v)).bind(old+1).bind(old).execute(&mut *tx).await.map_err(|_|unavailable())?.rows_affected();
        if n==0 || (old>0&&v["revision"]==1) {return Err(conflict());}
        // An absent row must have revision 1. Existing update is checked above.
        sqlx::query("UPDATE recovery_passkeys SET active=TRUE WHERE chain=$1 AND account_id=$2 AND credential_id=$3").bind(&s.chain).bind(&s.account).bind(&vt.credential).execute(&mut *tx).await.map_err(|_|unavailable())?;
        tx.commit().await.map_err(|_|unavailable())?;
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
    envelope(&v,&s,&state.config.package_id,false)?;
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
        let redis=redis::Client::open(redis_url).unwrap().get_multiplexed_async_connection().await.unwrap();
        let state=Arc::new(AppState{db,config,http_client:reqwest::Client::new(),key_pool:crate::types::KeyPool::new(vec![]),redis,
            fallback_rate_limit:tokio::sync::Mutex::new(crate::rate_limit::InMemoryFallback::default()),org_summaries:crate::org_summary::OrgSummaryCache::new(),r2:None});
        let app=router().with_state(state.clone());let base=format!("/api/accounts/{account}");
        assert_eq!(call(&app,"GET",&format!("{base}/passkeys"),"","",Value::Null,None).await.0,StatusCode::UNAUTHORIZED);
        let (status,c)=call(&app,"POST","/api/owner/auth/challenge","","",json!({"account_id":account}),None).await;assert_eq!(status,StatusCode::OK);
        let verify_body=json!({"challenge_id":c["challenge_id"],"signature":"test-public-signature"});
        let (status,s)=call(&app,"POST","/api/owner/auth/verify","","",verify_body.clone(),None).await;assert_eq!(status,StatusCode::OK);
        assert_eq!(call(&app,"POST","/api/owner/auth/verify","","",verify_body,None).await.0,StatusCode::UNAUTHORIZED);
        let ot=s["owner_token"].as_str().unwrap();
        let (_,options)=call(&app,"POST",&format!("{base}/passkeys/registration/options"),ot,"",json!({}),None).await;
        let response=json!({"id":"AA","response":{},"clientExtensionResults":{}});
        let (status,registered)=call(&app,"POST",&format!("{base}/passkeys/registration/verify"),ot,"",json!({"ceremony_id":options["ceremony_id"],"response":response}),None).await;assert_eq!(status,StatusCode::OK);
        let (_,options)=call(&app,"POST",&format!("{base}/passkeys/authentication/options"),ot,"",json!({"credential_id":"AA"}),None).await;
        let (status,verified)=call(&app,"POST",&format!("{base}/passkeys/authentication/verify"),ot,"",json!({"ceremony_id":options["ceremony_id"],"response":response}),None).await;assert_eq!(status,StatusCode::OK);
        let vt=verified["vault_token"].as_str().unwrap();
        assert_eq!(call(&app,"GET",&format!("{base}/agent-key-envelopes"),ot,vt,Value::Null,None).await.0,StatusCode::FORBIDDEN);
        use base64::Engine;
        let enc=|n|base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(vec![0u8;n]);
        let root_id=uuid::Uuid::new_v4().to_string();let key_id=uuid::Uuid::new_v4().to_string();
        let root=json!({"version":1,"algorithm":"AES-256-GCM","kdf":"HKDF-SHA256","chain":"test-chain","packageId":address("0x1").unwrap(),"owner":owner_address,"accountId":account,"rootId":root_id,"credentialId":"AA","rpId":"localhost","prfInput":registered["prf_input"],"revision":1,"salt":enc(32),"nonce":enc(12),"ciphertext":enc(48)});
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
        assert_eq!(call(&app,"DELETE",&format!("{base}/passkeys/AA"),ot,vt,Value::Null,None).await.0,StatusCode::CONFLICT);
        sqlx::query("UPDATE recovery_passkeys SET revoked=TRUE WHERE chain='test-chain'").execute(state.db.pool()).await.unwrap();
        assert_eq!(call(&app,"GET",&format!("{base}/agent-key-envelopes"),ot,vt,Value::Null,None).await.0,StatusCode::FORBIDDEN);
        task.abort();
    }
}
