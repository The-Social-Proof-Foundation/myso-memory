//! Fenced foreground turn ownership. A lease token never substitutes for scoped agent authentication.
use std::sync::Arc;
use axum::{extract::{Path, State}, Extension, Json};
use serde::Deserialize;
use serde_json::{json,Value};
use sqlx::Row;
use uuid::Uuid;
use crate::{types::{AppError,AppState,AuthInfo},work_runs::{self,scope,decrypt,encrypt}};
fn db_error(_:sqlx::Error)->AppError{AppError::Internal("work turn storage failed".into())}
fn conflict()->AppError{AppError::Conflict("work turn is busy, expired or requires reconciliation".into())}
fn unavailable()->AppError{AppError::BlobNotFound("work record unavailable".into())}
fn id(value:&str)->Result<Uuid,AppError>{Uuid::parse_str(value).map_err(|_|AppError::BadRequest("invalid work ID".into()))}
pub fn require_lease(row:&sqlx::postgres::PgRow,token:Option<&str>)->Result<(),AppError>{
    let supplied=token.and_then(|v|Uuid::parse_str(v).ok()).ok_or_else(conflict)?;
    if row.get::<Option<Uuid>,_>("lease_token")!=Some(supplied) || row.get::<Option<chrono::DateTime<chrono::Utc>>,_>("lease_until").is_none_or(|until|until<=chrono::Utc::now()){return Err(conflict());}
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields,rename_all="camelCase")]
pub struct Acquire{pub request_id:String,pub input_hash:String,pub expected_revision:i64}
pub async fn acquire(State(state):State<Arc<AppState>>,Extension(auth):Extension<AuthInfo>,Path(run_id):Path<String>,Json(input):Json<Acquire>)->Result<Json<Value>,AppError>{
    let run_id=id(&run_id)?;let request_id=id(&input.request_id)?;
    if input.input_hash.len()!=64||!input.input_hash.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){return Err(AppError::BadRequest("invalid input hash".into()));}
    let mut tx=state.db.pool().begin().await.map_err(db_error)?;
    let run=sqlx::query("SELECT * FROM work_runs WHERE id=$1 AND scope_key=$2 FOR UPDATE").bind(run_id).bind(scope(&state,&auth).0).fetch_optional(&mut *tx).await.map_err(db_error)?.ok_or_else(unavailable)?;
    if run.get::<Option<Uuid>,_>("lease_token").is_some() && run.get::<Option<chrono::DateTime<chrono::Utc>>,_>("lease_until").is_none_or(|until|until<=chrono::Utc::now()) {
        let blocked:i64=sqlx::query_scalar("SELECT count(*) FROM work_operations WHERE run_id=$1 AND status IN ('pending','reconciling')").bind(run_id).fetch_one(&mut *tx).await.map_err(db_error)?;
        let cancelled=run.get::<Option<chrono::DateTime<chrono::Utc>>,_>("cancel_requested_at").is_some()&&blocked==0;
        sqlx::query("UPDATE work_turns SET status=CASE WHEN $2 THEN 'failed' ELSE 'reconciling' END,finished_at=CASE WHEN $2 THEN COALESCE(finished_at,now()) ELSE finished_at END WHERE run_id=$1 AND status='running'").bind(run_id).bind(cancelled).execute(&mut *tx).await.map_err(db_error)?;
        sqlx::query("UPDATE work_runs SET status=CASE WHEN $2 THEN 'cancelled' ELSE 'reconciling' END,lease_token=NULL,lease_until=NULL,revision=revision+1,updated_at=now() WHERE id=$1").bind(run_id).bind(cancelled).execute(&mut *tx).await.map_err(db_error)?;
        tx.commit().await.map_err(db_error)?; return Err(conflict());
    }
    let blocked:i64=sqlx::query_scalar("SELECT count(*) FROM work_operations WHERE run_id=$1 AND status IN ('pending','reconciling')").bind(run_id).fetch_one(&mut *tx).await.map_err(db_error)?;
    let status=run.get::<String,_>("status");
    // A run marked reconciling after an expired lease is recoverable only when every
    // write-ahead operation has a terminal journal result. Unknown side effects remain held.
    let recoverable=status=="reconciling" && blocked==0;
    if let Some(prior)=sqlx::query("SELECT id,input_hash,status FROM work_turns WHERE run_id=$1 AND request_id=$2 FOR UPDATE").bind(run_id).bind(request_id).fetch_optional(&mut *tx).await.map_err(db_error)?{
        if prior.get::<String,_>("input_hash")!=input.input_hash{return Err(conflict());}
        let prior_status=prior.get::<String,_>("status");let prior_id=prior.get::<Uuid,_>("id");
        if prior_status=="yielded" {
            let replay_status=if work_runs::active(&status){"yielded"}else{status.as_str()};
            return Ok(Json(json!({"acquired":false,"id":prior_id.to_string(),"status":replay_status})));
        }
        if prior_status=="finished" || (prior_status=="running" && run.get::<Option<chrono::DateTime<chrono::Utc>>,_>("lease_until").is_some_and(|until|until>chrono::Utc::now())) {
            return Ok(Json(json!({"acquired":false,"id":prior_id.to_string(),"status":prior_status})));
        }
        if blocked>0 || !matches!(prior_status.as_str(),"reconciling"|"failed") || (!work_runs::active(&status) && !recoverable) || run.get::<i64,_>("revision")!=input.expected_revision{return Err(conflict());}
        let token=Uuid::new_v4();
        sqlx::query("UPDATE work_turns SET status='running',finished_at=NULL WHERE id=$1").bind(prior_id).execute(&mut *tx).await.map_err(db_error)?;
        let until:chrono::DateTime<chrono::Utc>=sqlx::query_scalar("UPDATE work_runs SET lease_token=$1,lease_until=now()+interval '5 minutes',status='running',revision=revision+1,updated_at=now() WHERE id=$2 RETURNING lease_until").bind(token).bind(run_id).fetch_one(&mut *tx).await.map_err(db_error)?;
        tx.commit().await.map_err(db_error)?;
        return Ok(Json(json!({"acquired":true,"id":prior_id.to_string(),"token":token.to_string(),"leaseUntil":until.to_rfc3339(),"status":"running","resumed":true})));
    }
    if blocked>0 || (!work_runs::active(&status) && !recoverable) || run.get::<i64,_>("revision")!=input.expected_revision || run.get::<Option<chrono::DateTime<chrono::Utc>>,_>("lease_until").is_some_and(|until|until>chrono::Utc::now()){return Err(conflict());}
    // An abandoned turn stays visible even if all completed operations can be safely reused later.
    sqlx::query("UPDATE work_turns SET status='reconciling' WHERE run_id=$1 AND status='running'").bind(run_id).execute(&mut *tx).await.map_err(db_error)?;
    let turn_id=Uuid::new_v4();let token=Uuid::new_v4();
    sqlx::query("INSERT INTO work_turns(id,run_id,request_id,input_hash,status) VALUES($1,$2,$3,$4,'running')").bind(turn_id).bind(run_id).bind(request_id).bind(input.input_hash).execute(&mut *tx).await.map_err(db_error)?;
    let until:chrono::DateTime<chrono::Utc>=sqlx::query_scalar("UPDATE work_runs SET lease_token=$1,lease_until=now()+interval '5 minutes',status='running',revision=revision+1,updated_at=now() WHERE id=$2 RETURNING lease_until").bind(token).bind(run_id).fetch_one(&mut *tx).await.map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({"acquired":true,"id":turn_id.to_string(),"token":token.to_string(),"leaseUntil":until.to_rfc3339(),"status":"running"})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields,rename_all="camelCase")]
pub struct Renew{pub turn_token:String}
pub async fn renew(State(state):State<Arc<AppState>>,Extension(auth):Extension<AuthInfo>,Path(run_id):Path<String>,Json(input):Json<Renew>)->Result<Json<Value>,AppError>{
    let until:Option<chrono::DateTime<chrono::Utc>>=sqlx::query_scalar("UPDATE work_runs SET lease_until=now()+interval '5 minutes' WHERE id=$1 AND scope_key=$2 AND lease_token=$3 AND lease_until>now() AND cancel_requested_at IS NULL RETURNING lease_until").bind(id(&run_id)?).bind(scope(&state,&auth).0).bind(id(&input.turn_token)?).fetch_optional(state.db.pool()).await.map_err(db_error)?;
    Ok(Json(json!({"renewed":until.is_some(),"leaseUntil":until.map(|v|v.to_rfc3339())})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields,rename_all="camelCase")]
pub struct Checkpoint{pub turn_token:String,pub messages:Vec<Value>}
async fn save(state:&AppState,auth:&AuthInfo,run_id:Uuid,token:&str,messages:&[Value],finish:Option<(&str,&str)>)->Result<Value,AppError>{
    if messages.len()>2048 || messages.iter().any(|m|!m.is_object()||!matches!(m.get("role").and_then(Value::as_str),Some("system"|"user"|"assistant"|"toolResult"|"custom"))){return Err(AppError::BadRequest("invalid work transcript".into()));}
    let mut tx=state.db.pool().begin().await.map_err(db_error)?;
    let row=sqlx::query("SELECT * FROM work_runs WHERE id=$1 AND scope_key=$2 FOR UPDATE").bind(run_id).bind(scope(state,auth).0).fetch_optional(&mut *tx).await.map_err(db_error)?.ok_or_else(unavailable)?;
    require_lease(&row,Some(token))?;
    let mut snapshot=decrypt(state,auth,&row.get::<Vec<u8>,_>("snapshot")).await?;snapshot["messages"]=json!(messages);
    let encrypted=encrypt(state,auth,&snapshot).await?;
    // MYDATA calls may outlive the lease: the SQL CAS rechecks server time before accepting the write.
    let updated=sqlx::query("UPDATE work_runs SET snapshot=$1,revision=revision+1,updated_at=now() WHERE id=$2 AND lease_token=$3 AND lease_until>now() RETURNING id").bind(encrypted).bind(run_id).bind(id(token)?).fetch_optional(&mut *tx).await.map_err(db_error)?.ok_or_else(conflict)?;drop(updated);
    if let Some((turn_id,disposition))=finish{
        let cancelled=row.get::<Option<chrono::DateTime<chrono::Utc>>,_>("cancel_requested_at").is_some();
        let status=if disposition=="failed"||cancelled{"failed"}else if disposition=="yielded"{"yielded"}else{"finished"};
        let changed=sqlx::query("UPDATE work_turns SET status=$1,finished_at=now() WHERE id=$2 AND run_id=$3 AND status='running'").bind(status).bind(id(turn_id)?).bind(run_id).execute(&mut *tx).await.map_err(db_error)?;
        if changed.rows_affected()!=1{return Err(conflict());}
        let blocked:i64=sqlx::query_scalar("SELECT count(*) FROM work_operations WHERE run_id=$1 AND status IN ('pending','reconciling')").bind(run_id).fetch_one(&mut *tx).await.map_err(db_error)?;
        let run_status=if blocked>0{"reconciling"}else if cancelled{"cancelled"}else if disposition=="yielded"{"yielded"}else if disposition=="waiting_for_input"{"waiting_for_input"}else if disposition=="waiting_for_approval"{"waiting_for_approval"}else{"running"};
        sqlx::query("UPDATE work_runs SET status=$1,lease_token=NULL,lease_until=NULL WHERE id=$2").bind(run_status).bind(run_id).execute(&mut *tx).await.map_err(db_error)?;
        if blocked>0 {sqlx::query("UPDATE work_turns SET status='reconciling' WHERE id=$1").bind(id(turn_id)?).execute(&mut *tx).await.map_err(db_error)?;}
    }
    tx.commit().await.map_err(db_error)?;Ok(json!({"ok":true}))
}
pub async fn checkpoint(State(state):State<Arc<AppState>>,Extension(auth):Extension<AuthInfo>,Path(run_id):Path<String>,Json(input):Json<Checkpoint>)->Result<Json<Value>,AppError>{Ok(Json(save(&state,&auth,id(&run_id)?,&input.turn_token,&input.messages,None).await?))}
#[derive(Deserialize)]
#[serde(deny_unknown_fields,rename_all="camelCase")]
pub struct Finish{pub turn_token:String,pub turn_id:String,pub messages:Vec<Value>,pub disposition:String}
pub async fn finish(State(state):State<Arc<AppState>>,Extension(auth):Extension<AuthInfo>,Path(run_id):Path<String>,Json(input):Json<Finish>)->Result<Json<Value>,AppError>{
    if !["idle","yielded","waiting_for_input","waiting_for_approval","failed"].contains(&input.disposition.as_str()){return Err(AppError::BadRequest("invalid turn disposition".into()));}
    Ok(Json(save(&state,&auth,id(&run_id)?,&input.turn_token,&input.messages,Some((&input.turn_id,&input.disposition))).await?))
}
