//! Guarded owner-wallet actions requiring the deployed PlatformAdminCap.
use crate::chain_reads::{coin_type, digest_bytes, id, object, rpc, same};
use crate::types::{AppError, AppState, AuthInfo};
use serde_json::{json, Value};
use std::sync::Arc;

pub const TRANSFER: &str = "platform.transfer_platform.v1";
pub const FEE_RECIPIENT: &str = "platform.update_fee_recipient.v1";
pub fn is_action(action: &str) -> bool { matches!(action, TRANSFER | FEE_RECIPIENT) }
fn bad(message: &str) -> AppError { AppError::BadRequest(message.into()) }
fn invalid() -> AppError { AppError::Internal("Platform administration evidence is invalid or unavailable".into()) }
fn required<'a>(value:&'a Value,key:&str)->Result<&'a str,AppError>{value.get(key).and_then(Value::as_str).ok_or_else(||bad(&format!("{key} is required")))}
fn address(value:&str,label:&str)->Result<String,AppError>{id(value).map_err(|_|bad(&format!("Invalid {label}")))}
async fn admin_cap(state:&AppState,auth:&AuthInfo,cap_id:&str)->Result<(),AppError>{
    let cap=object(state,&address(cap_id,"platformAdminCapId")?).await?;
    let expected=coin_type(&format!("{}::platform::PlatformAdminCap",state.config.package_id))?;
    if coin_type(cap.pointer("/content/type").and_then(Value::as_str).ok_or_else(invalid)?)?!=expected || !same(cap.pointer("/owner/AddressOwner").and_then(Value::as_str).ok_or_else(invalid)?,&auth.owner){return Err(AppError::Forbidden("PlatformAdminCap must be directly owned by the authenticated owner wallet".into()));}
    Ok(())
}
pub async fn validate_action(state:&AppState,auth:&AuthInfo,action:&str,parameters:&Value)->Result<(),AppError>{
    if !is_action(action){return Ok(());}
    let fields=parameters.as_object().ok_or_else(||bad("Platform administration parameters must be an object"))?;
    let allowed:&[&str]=if action==TRANSFER { &["platformId","platformAdminCapId","newDeveloper"] } else { &["platformAdminCapId","newRecipient"] };
    if fields.len()!=allowed.len()||fields.keys().any(|key|!allowed.contains(&key.as_str())){return Err(bad("Unexpected or missing platform administration parameters"));}
    admin_cap(state,auth,required(parameters,"platformAdminCapId")?).await?;
    if action==TRANSFER {
        let platform_id=address(required(parameters,"platformId")?,"platformId")?;
        if !same(&platform_id,&state.config.social_chain.platform_object_id){return Err(AppError::Forbidden("Platform transfer is limited to the configured platform object".into()));}
        let platform=object(state,&platform_id).await?;
        let expected=coin_type(&format!("{}::platform::Platform",state.config.package_id))?;
        if coin_type(platform.pointer("/content/type").and_then(Value::as_str).ok_or_else(invalid)?)?!=expected{return Err(AppError::Forbidden("Selected object is not a platform in the configured package".into()));}
        let current=platform.pointer("/content/fields/developer").and_then(Value::as_str).ok_or_else(invalid)?;
        let next=address(required(parameters,"newDeveloper")?,"newDeveloper")?;
        if same(&next,"0x0")||same(current,&next){return Err(bad("New platform developer must be nonzero and differ from the current developer"));}
    } else {
        let task_id=address(&state.config.social_chain.task_config_id,"taskConfigId")?;
        let config=object(state,&task_id).await?;
        let expected=coin_type(&format!("{}::agent_task::TaskConfig",state.config.package_id))?;
        if coin_type(config.pointer("/content/type").and_then(Value::as_str).ok_or_else(invalid)?)?!=expected{return Err(AppError::Conflict("Configured task market object is not the canonical TaskConfig".into()));}
        let current=config.pointer("/content/fields/ecosystem_fee_recipient").and_then(Value::as_str).ok_or_else(invalid)?;
        let next=address(required(parameters,"newRecipient")?,"newRecipient")?;
        if same(&next,"0x0")||same(current,&next){return Err(bad("New fee recipient must be nonzero and differ from the current recipient"));}
    }
    Ok(())
}
pub fn receipt_context(action:&str,parameters:&Value,owner:&str)->Result<Option<Value>,AppError>{
    if !is_action(action){return Ok(None);}
    let mut context=parameters.clone();let map=context.as_object_mut().ok_or_else(||bad("Receipt context must be an object"))?;
    map.insert("owner".into(),json!(address(owner,"owner")?));
    if action==TRANSFER{map.insert("platformId".into(),json!(address(required(parameters,"platformId")?,"platformId")?));map.insert("newDeveloper".into(),json!(address(required(parameters,"newDeveloper")?,"newDeveloper")?));}
    else {map.insert("newRecipient".into(),json!(address(required(parameters,"newRecipient")?,"newRecipient")?));}
    Ok(Some(context))
}
async fn read_receipt(state:&AppState,auth:&AuthInfo,digest:&str)->Result<Value,AppError>{
    digest_bytes(digest).map_err(|_|bad("Invalid platform administration receipt digest"))?;
    let row=crate::chain_actions::get_by_digest(&state.db,&auth.account_id,&auth.agent_object_id,digest).await?.filter(|row|is_action(&row.registry_action)&&same(&row.package_id,&state.config.package_id)).ok_or_else(||AppError::BlobNotFound("Platform administration receipt is outside this account/agent scope".into()))?;
    let context=row.receipt_context.as_ref().ok_or_else(||AppError::Conflict("Platform administration receipt context is unavailable".into()))?;
    if !same(context.get("owner").and_then(Value::as_str).ok_or_else(invalid)?,&auth.owner){return Err(AppError::BlobNotFound("Platform administration receipt is outside this owner account".into()));}
    let transaction=rpc(state,"myso_getTransactionBlock",json!([digest,{"showEffects":true,"showEvents":true}])).await?;
    if transaction.get("digest").and_then(Value::as_str)!=Some(digest){return Err(invalid());}
    let sender=transaction.pointer("/transaction/data/sender").or_else(||transaction.pointer("/transaction/sender")).and_then(Value::as_str).ok_or_else(invalid)?;
    if !same(sender,&auth.owner)||!same(sender,&row.sender){return Err(AppError::Conflict("Platform administration receipt signer does not match the authenticated owner".into()));}
    let status=transaction.pointer("/effects/status/status").and_then(Value::as_str);let checkpoint=transaction.get("checkpoint").filter(|value|!value.is_null());let finalized=status==Some("success")&&checkpoint.is_some();
    let (event_name,expected_type)=if row.registry_action==TRANSFER {("PlatformDeveloperChangedEvent",coin_type(&format!("{}::platform::PlatformDeveloperChangedEvent",state.config.package_id))?)}else{("TaskFeeRecipientChanged",coin_type(&format!("{}::agent_task::TaskFeeRecipientChanged",state.config.package_id))?)};
    let events=transaction.get("events").and_then(Value::as_array).ok_or_else(invalid)?;
    let matches:Vec<&Value>=events.iter().filter(|event|{
        if coin_type(event.get("type").and_then(Value::as_str).unwrap_or("")).ok().as_deref()!=Some(expected_type.as_str()){return false;}
        let Some(data)=event.get("parsedJson") else{return false;};
        if row.registry_action==TRANSFER {
            data.get("platform_id").and_then(Value::as_str).is_some_and(|v|same(v,context["platformId"].as_str().unwrap_or("")))&&data.get("new_developer").and_then(Value::as_str).is_some_and(|v|same(v,context["newDeveloper"].as_str().unwrap_or("")))&&data.get("changed_by").and_then(Value::as_str).is_some_and(|v|same(v,&auth.owner))
        } else {data.get("new_recipient").and_then(Value::as_str).is_some_and(|v|same(v,context["newRecipient"].as_str().unwrap_or("")))&&data.get("updated_by").and_then(Value::as_str).is_some_and(|v|same(v,&auth.owner))}
    }).collect();
    if finalized&&matches.len()!=1{return Err(AppError::Conflict(format!("Unique {event_name} receipt could not be verified")));}
    Ok(json!({"digest":digest,"registryAction":row.registry_action,"status":match status{Some("success") if finalized=>"finalized",Some("success")=>"checkpoint_pending",Some("failure")=>"failed",_=>"unknown"},"checkpoint":checkpoint.map(Value::to_string),"event":matches.first().map(|value|*value),"evidenceSource":"configured_fullnode_and_scoped_preparation"}))
}
pub async fn read(state:&Arc<AppState>,auth:&AuthInfo,digest:&str)->Result<Value,AppError>{read_receipt(state,auth,digest).await}
