//! Public, resumable registration intent. This metadata never grants signing authority.
use axum::{extract::{State,Path}, http::{HeaderMap,Method}, Json};
use serde_json::{Value,json};
use sqlx::{Row,types::Json as SqlJson};
use std::{collections::HashMap,sync::Arc};
use crate::{types::AppState,owner_auth::*};

pub(crate) fn valid_intent(v:&Value)->Result<()> {
    let keys=["label","capabilities","delegatableCaps","expiresAtMs","parentAgentId","budget"];
    let o=v.as_object().ok_or_else(bad)?;
    if o.len()!=keys.len()||o.keys().any(|k|!keys.contains(&k.as_str())){return Err(bad());}
    if !v["label"].as_str().is_some_and(|s|!s.is_empty()&&s.len()<=256){return Err(bad());}
    for k in ["capabilities","delegatableCaps"]{if !v[k].as_u64().is_some_and(|n|n<=131071){return Err(bad());}}
    if !v["expiresAtMs"].is_null()&&!v["expiresAtMs"].as_u64().is_some_and(|n|n<=9007199254740991){return Err(bad());}
    if !v["parentAgentId"].is_null(){address(str_field(v,"parentAgentId")?)?;}
    if !v["budget"].is_null(){
        let budget=&v["budget"];let keys=["balanceId","budgetMist","dailyCapMist","monthlyCapMist","requireApprovalAboveMist"];
        let o=budget.as_object().ok_or_else(bad)?;
        if o.len()!=keys.len()||o.keys().any(|k|!keys.contains(&k.as_str())){return Err(bad());}
        address(str_field(budget,"balanceId")?)?;
        for k in ["budgetMist","dailyCapMist","monthlyCapMist","requireApprovalAboveMist"]{
            if budget[k].is_null(){continue;}
            let s=str_field(budget,k)?;
            if s.is_empty()||s.len()>20||!s.bytes().all(|b|b.is_ascii_digit())||s.parse::<u64>().is_err(){return Err(bad());}
        }
    }
    Ok(())
}
pub async fn intent(State(state):State<Arc<AppState>>,Path(p):Path<HashMap<String,String>>,headers:HeaderMap,method:Method,body:axum::body::Bytes)->Result<Json<Value>>{
    let s=session(&state,&headers,&p["account_id"]).await?;vault(&state,&headers,&s,true).await?;
    uuid::Uuid::parse_str(&p["key_id"]).map_err(|_|bad())?;
    let mut tx=state.db.pool().begin().await.map_err(|_|unavailable())?;
    let row=sqlx::query("SELECT registration_intent FROM agent_key_drafts WHERE chain=$1 AND account_id=$2 AND key_id=$3 FOR UPDATE")
        .bind(&s.chain).bind(&s.account).bind(&p["key_id"]).fetch_optional(&mut *tx).await.map_err(|_|unavailable())?.ok_or_else(missing)?;
    let current:Option<SqlJson<Value>>=row.try_get("registration_intent").map_err(|_|unavailable())?;
    if method==Method::GET{return Ok(Json(current.map(|v|v.0).unwrap_or(Value::Null)));}
    let v:Value=serde_json::from_slice(&body).map_err(|_|bad())?;valid_intent(&v)?;
    if let Some(current)=current{if current.0!=v{return Err(conflict());}}
    else{sqlx::query("UPDATE agent_key_drafts SET registration_intent=$1 WHERE chain=$2 AND account_id=$3 AND key_id=$4")
        .bind(SqlJson(&v)).bind(&s.chain).bind(&s.account).bind(&p["key_id"]).execute(&mut *tx).await.map_err(|_|unavailable())?;}
    tx.commit().await.map_err(|_|unavailable())?;Ok(Json(json!({"saved":true})))
}
pub async fn setups(State(state):State<Arc<AppState>>,Path(p):Path<HashMap<String,String>>,headers:HeaderMap,method:Method,body:axum::body::Bytes)->Result<Json<Value>>{
    let s=session(&state,&headers,&p["account_id"]).await?;vault(&state,&headers,&s,true).await?;
    if let Some(id)=p.get("agent_id"){
        let id=address(id)?;
        let row=sqlx::query("SELECT envelope,registration_intent,setup_state FROM agent_key_envelopes WHERE chain=$1 AND account_id=$2 AND agent_id=$3")
            .bind(&s.chain).bind(&s.account).bind(&id).fetch_optional(state.db.pool()).await.map_err(|_|unavailable())?.ok_or_else(missing)?;
        crate::agent_key_backups::registered(&state,&s,&row.get::<SqlJson<Value>,_>("envelope").0).await?;
        if method==Method::GET{return Ok(Json(json!({"agentId":id,"intent":row.get::<Option<SqlJson<Value>>,_>("registration_intent").map(|v|v.0),"state":row.get::<SqlJson<Value>,_>("setup_state").0})));}
        let v:Value=serde_json::from_slice(&body).map_err(|_|bad())?;
        if !v.as_object().is_some_and(|o|o.len()==2&&o.keys().all(|k|["vault","budget"].contains(&k.as_str())))
            || !["pending","complete"].contains(&str_field(&v,"vault")?)||!["pending","complete","skipped"].contains(&str_field(&v,"budget")?){return Err(bad());}
        sqlx::query("UPDATE agent_key_envelopes SET setup_state=$1 WHERE chain=$2 AND account_id=$3 AND agent_id=$4")
            .bind(SqlJson(v)).bind(&s.chain).bind(&s.account).bind(&id).execute(state.db.pool()).await.map_err(|_|unavailable())?;
        return Ok(Json(json!({"saved":true})));
    }
    let rows=sqlx::query("SELECT agent_id,registration_intent,setup_state FROM agent_key_envelopes WHERE chain=$1 AND account_id=$2 AND (setup_state->>'vault'='pending' OR setup_state->>'budget'='pending')")
        .bind(&s.chain).bind(&s.account).fetch_all(state.db.pool()).await.map_err(|_|unavailable())?;
    Ok(Json(json!(rows.into_iter().map(|r|json!({"agentId":r.get::<String,_>("agent_id"),"intent":r.get::<Option<SqlJson<Value>>,_>("registration_intent").map(|v|v.0),"state":r.get::<SqlJson<Value>,_>("setup_state").0})).collect::<Vec<_>>())))
}
