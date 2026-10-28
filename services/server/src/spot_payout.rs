//! Owner-authorized resolved spot payout claims and scoped native-event receipts.
use crate::chain_reads::{address, coin_type, digest_bytes, id, object, rpc, same, u64_value};
use crate::types::{AppError, AppState, AuthInfo, Config};
use serde_json::{json, Value};
use std::sync::Arc;

pub const ACTION: &str = "spot.claim_payout.v1";
pub const BET_ACTION: &str = "spot.place_bet.v1";
pub const CREATE_MARKET_ACTION: &str = "spot.create_market.v1";
pub fn configured(c: &Config) -> bool { c.spot_payout_claims_enabled && c.social_chain.is_configured() && !c.social_chain.spot_config_id.is_empty() }
pub fn betting_configured(c:&Config)->bool{c.spot_betting_enabled&&c.social_chain.is_configured()&&!c.social_chain.spot_config_id.is_empty()&&!c.social_chain.spot_claim_registry_id.is_empty()}
pub fn market_creation_configured(c:&Config)->bool{c.spot_market_creation_enabled&&c.social_chain.is_configured()&&!c.social_chain.spot_config_id.is_empty()&&!c.social_chain.spot_claim_registry_id.is_empty()}
fn invalid() -> AppError { AppError::Internal("Spot payout chain evidence is invalid or unavailable".into()) }
fn bad(s: &str) -> AppError { AppError::BadRequest(s.into()) }
fn params(v: &Value) -> Result<Value, AppError> {
    let o=v.as_object().ok_or_else(||bad("Spot payout parameters must be an object"))?;
    if o.len()!=2 || o.keys().any(|k| !["marketId","postId"].contains(&k.as_str())) { return Err(bad("Unexpected or missing spot payout parameters")); }
    Ok(json!({"marketId":id(v["marketId"].as_str().ok_or_else(||bad("marketId is required"))?).map_err(|_|bad("Invalid marketId"))?,"postId":id(v["postId"].as_str().ok_or_else(||bad("postId is required"))?).map_err(|_|bad("Invalid postId"))?}))
}
fn u64v(v: Option<&Value>) -> Result<u64,AppError> { v.and_then(|x|x.as_u64().or_else(||x.as_str()?.parse().ok())).ok_or_else(invalid) }
async fn verify_claimable(s:&AppState,a:&AuthInfo,p:&Value)->Result<Value,AppError> {
    if a.capabilities & crate::memory_contract::CAP_TRADE_EXECUTE == 0 { return Err(AppError::Forbidden("Trade capability is required for spot payout claims".into())); }
    if !configured(&s.config) { return Err(AppError::Forbidden("Spot payout claims are disabled for this deployment".into())); }
    let p=params(p)?; let market_id=p["marketId"].as_str().ok_or_else(invalid)?; let post_id=p["postId"].as_str().ok_or_else(invalid)?;
    let market=object(s,market_id).await?; let post=object(s,post_id).await?;
    let expected=coin_type(&format!("{}::social_proof_of_truth::SpotMarket",s.config.package_id))?;
    let mtype=market.pointer("/content/type").and_then(Value::as_str).ok_or_else(invalid)?;
    let ptype=post.pointer("/content/type").and_then(Value::as_str).ok_or_else(invalid)?;
    if coin_type(mtype)?!=expected || coin_type(ptype)?!=coin_type(&format!("{}::post::Post",s.config.package_id))? || !same(market.pointer("/content/fields/primary_post_id").and_then(Value::as_str).ok_or_else(invalid)?,post_id) { return Err(AppError::Forbidden("Spot market does not match the requested post".into())); }
    let fields=market.pointer("/content/fields").ok_or_else(invalid)?;
    if u64v(fields.get("status"))?!=3 || fields.pointer("/outcome/fields/vec/0").is_none() { return Err(AppError::Conflict("Spot market is not resolved".into())); }
    let payout_table=fields.pointer("/pending_payouts/fields/id/id").and_then(Value::as_str).ok_or_else(invalid)?;
    let payout=rpc(s,"mysox_getDynamicFieldObject",json!([payout_table,{"type":"address","value":a.owner}])).await?;
    let data=payout.get("data").ok_or_else(||AppError::Conflict("No pending payout exists for this owner".into()))?;
    if coin_type(data.pointer("/content/type").and_then(Value::as_str).ok_or_else(invalid)?)?!=coin_type("0x2::dynamic_field::Field<address,u64>")? { return Err(invalid()); }
    if !same(data.pointer("/owner/ObjectOwner").and_then(Value::as_str).ok_or_else(invalid)?, payout_table)
        || !same(data.pointer("/content/fields/name").and_then(Value::as_str).ok_or_else(invalid)?, &a.owner) { return Err(invalid()); }
    let amount=u64v(data.pointer("/content/fields/value"))?;
    if amount==0 { return Err(AppError::Conflict("No positive payout exists for this owner".into())); }
    Ok(json!({"claimParameters":p,"marketId":market_id,"postId":post_id,"beneficiary":id(&a.owner)?,"expectedAmountBaseUnits":amount.to_string(),"evidenceSource":"configured_fullnode","approval":"owner_wallet"}))
}
fn bet_params(v:&Value)->Result<Value,AppError>{
    let o=v.as_object().ok_or_else(||bad("Spot bet parameters must be an object"))?;
    if o.keys().any(|k|!["marketId","postId","paymentCoinId","amountBaseUnits","optionId","referrerPostId"].contains(&k.as_str()))||["marketId","postId","paymentCoinId","amountBaseUnits","optionId"].iter().any(|k|!o.contains_key(*k)){return Err(bad("Unexpected or missing spot bet parameters"));}
    let amount=u64_value(v.get("amountBaseUnits")).map_err(|_|bad("amountBaseUnits must be a positive u64 decimal string"))?;
    if amount==0{return Err(bad("Spot bet amount must be positive"));}
    let option=v["optionId"].as_u64().filter(|x|*x<=255).ok_or_else(||bad("optionId must be an integer from 0 to 255"))?;
    let mut out=json!({"marketId":id(v["marketId"].as_str().ok_or_else(||bad("marketId is required"))?).map_err(|_|bad("Invalid marketId"))?,"postId":id(v["postId"].as_str().ok_or_else(||bad("postId is required"))?).map_err(|_|bad("Invalid postId"))?,"paymentCoinId":id(v["paymentCoinId"].as_str().ok_or_else(||bad("paymentCoinId is required"))?).map_err(|_|bad("Invalid paymentCoinId"))?,"amountBaseUnits":amount.to_string(),"optionId":option});
    if let Some(referrer)=v.get("referrerPostId"){if !referrer.is_null(){out["referrerPostId"]=json!(id(referrer.as_str().ok_or_else(||bad("referrerPostId must be a chain object ID"))?).map_err(|_|bad("Invalid referrerPostId"))?);}}
    Ok(out)
}
async fn verify_bet(s:&AppState,a:&AuthInfo,v:&Value)->Result<Value,AppError>{
    if a.capabilities&crate::memory_contract::CAP_TRADE_EXECUTE==0{return Err(AppError::Forbidden("Trade capability is required for spot betting".into()));}
    if !betting_configured(&s.config){return Err(AppError::Forbidden("Spot betting is disabled for this deployment".into()));}
    let p=bet_params(v)?;let market_id=p["marketId"].as_str().ok_or_else(invalid)?;let post_id=p["postId"].as_str().ok_or_else(invalid)?;
    let market=object(s,market_id).await?;let post=object(s,post_id).await?;let coin=object(s,p["paymentCoinId"].as_str().ok_or_else(invalid)?).await?;
    if coin_type(market.pointer("/content/type").and_then(Value::as_str).ok_or_else(invalid)?)?!=coin_type(&format!("{}::social_proof_of_truth::SpotMarket",s.config.package_id))?
        ||!same(market.pointer("/content/fields/primary_post_id").and_then(Value::as_str).ok_or_else(invalid)?,post_id)
        ||u64v(market.pointer("/content/fields/status"))?!=1
        ||coin_type(post.pointer("/content/type").and_then(Value::as_str).ok_or_else(invalid)?)?!=coin_type(&format!("{}::post::Post",s.config.package_id))?{
        return Err(AppError::Forbidden("Spot market is not open for the requested post".into()));
    }
    let coin_id=p["paymentCoinId"].as_str().ok_or_else(invalid)?;
    if !same(coin.pointer("/objectId").and_then(Value::as_str).ok_or_else(invalid)?,coin_id)||!same(&address(coin.pointer("/content/fields/id/id"))?,coin_id)||!same(&address(coin.pointer("/owner/AddressOwner"))?,&a.owner)||coin_type(coin.pointer("/content/type").and_then(Value::as_str).ok_or_else(invalid)?)?!=coin_type("0x2::coin::Coin<0x2::myso::MYSO>")?{
        return Err(AppError::Forbidden("The exact MYSO coin is not owned by the approving wallet".into()));
    }
    let balance=u64_value(coin.pointer("/content/fields/balance"))?;let amount=u64_value(p.get("amountBaseUnits"))?;
    if balance<amount{return Err(bad("Funding coin balance is below the exact spot bet"));}
    let fields=market.pointer("/content/fields").ok_or_else(invalid)?;let options=fields.get("betting_options").and_then(Value::as_array).ok_or_else(invalid)?;
    if p["optionId"].as_u64().ok_or_else(invalid)? as usize>=options.len(){return Err(bad("optionId does not exist in this market"));}
    Ok(json!({"betParameters":p,"owner":id(&a.owner)?,"fundingCoinBalanceBaseUnits":balance.to_string(),"marketId":market_id,"postId":post_id,"evidenceSource":"configured_fullnode","approval":"owner_wallet","quoteLocksFunds":false}))
}
fn digest32(value:Option<&Value>,label:&str)->Result<String,AppError>{let s=value.and_then(Value::as_str).ok_or_else(||bad(label))?;let h=s.strip_prefix("0x").ok_or_else(||bad(label))?;if h.len()!=64||!h.bytes().all(|b|b.is_ascii_hexdigit()){return Err(bad(label));}Ok(format!("0x{}",h.to_ascii_lowercase()))}
fn market_params(v:&Value)->Result<Value,AppError>{
    let o=v.as_object().ok_or_else(||bad("Spot market parameters must be an object"))?;
    let allowed=["postId","spotOracleAdminCapId","semanticClaimHashHex","marketKeyHashHex","resolutionPolicyHashHex","bettingOptions","resolutionAtMs","maxResolutionWindowMs"];
    if o.keys().any(|k|!allowed.contains(&k.as_str()))||["postId","spotOracleAdminCapId","semanticClaimHashHex","marketKeyHashHex","resolutionPolicyHashHex","bettingOptions","resolutionAtMs"].iter().any(|k|!o.contains_key(*k)){return Err(bad("Unexpected or missing spot market parameters"));}
    let post=id(v["postId"].as_str().ok_or_else(||bad("postId is required"))?).map_err(|_|bad("Invalid postId"))?;
    let cap=id(v["spotOracleAdminCapId"].as_str().ok_or_else(||bad("spotOracleAdminCapId is required"))?).map_err(|_|bad("Invalid spotOracleAdminCapId"))?;
    let options=v["bettingOptions"].as_array().ok_or_else(||bad("bettingOptions must be an array"))?;
    if !(2..=16).contains(&options.len())||options.iter().any(|x|x.as_str().is_none_or(|s|s.is_empty()||s.len()>128)){return Err(bad("bettingOptions must contain 2 to 16 bounded labels"));}
    let mut unique=std::collections::HashSet::new();for option in options{if !unique.insert(option.as_str().unwrap()){return Err(bad("bettingOptions must be unique"));}}
    let resolution=u64_value(v.get("resolutionAtMs")).map_err(|_|bad("resolutionAtMs must be a decimal u64 string"))?;
    let max=v.get("maxResolutionWindowMs").filter(|x|!x.is_null()).map(|x|u64_value(Some(x)).map(|n|n.to_string()).map_err(|_|bad("maxResolutionWindowMs must be a decimal u64 string"))).transpose()?;
    Ok(json!({"postId":post,"spotOracleAdminCapId":cap,"semanticClaimHashHex":digest32(v.get("semanticClaimHashHex"),"semanticClaimHashHex")?,"marketKeyHashHex":digest32(v.get("marketKeyHashHex"),"marketKeyHashHex")?,"resolutionPolicyHashHex":digest32(v.get("resolutionPolicyHashHex"),"resolutionPolicyHashHex")?,"bettingOptions":options,"resolutionAtMs":resolution.to_string(),"maxResolutionWindowMs":max}))
}
async fn verify_market_creation(s:&AppState,a:&AuthInfo,v:&Value)->Result<Value,AppError>{
    if a.capabilities&crate::memory_contract::CAP_TRADE_EXECUTE==0{return Err(AppError::Forbidden("Trade capability is required for spot market administration".into()));}
    if !market_creation_configured(&s.config){return Err(AppError::Forbidden("Spot market creation is disabled for this deployment".into()));}
    let p=market_params(v)?;let post_id=p["postId"].as_str().ok_or_else(invalid)?;let cap_id=p["spotOracleAdminCapId"].as_str().ok_or_else(invalid)?;
    let post=object(s,post_id).await?;let cap=object(s,cap_id).await?;let cfg=object(s,&s.config.social_chain.spot_config_id).await?;let registry=object(s,&s.config.social_chain.spot_claim_registry_id).await?;
    if coin_type(post.pointer("/content/type").and_then(Value::as_str).ok_or_else(invalid)?)?!=coin_type(&format!("{}::post::Post",s.config.package_id))?{return Err(AppError::Forbidden("Requested post has another chain type".into()));}
    if coin_type(cap.pointer("/content/type").and_then(Value::as_str).ok_or_else(invalid)?)?!=coin_type(&format!("{}::social_proof_of_truth::SpotOracleAdminCap",s.config.package_id))?||!same(&address(cap.pointer("/owner/AddressOwner"))?,&a.owner){return Err(AppError::Forbidden("Spot oracle admin capability is not owned by the approving wallet".into()));}
    for (data,ty) in [(&cfg,"SpotConfig"),(&registry,"SpotClaimRegistry")]{if coin_type(data.pointer("/content/type").and_then(Value::as_str).ok_or_else(invalid)?)?!=coin_type(&format!("{}::social_proof_of_truth::{ty}",s.config.package_id))?{return Err(invalid());}}
    let fields=cfg.pointer("/content/fields").ok_or_else(invalid)?;let count=p["bettingOptions"].as_array().ok_or_else(invalid)?.len() as u64;
    if count<u64v(fields.get("min_betting_options"))?||count>u64v(fields.get("max_betting_options"))?{return Err(bad("bettingOptions count is outside the deployed market limits"));}
    Ok(json!({"marketParameters":p,"approvingOwner":id(&a.owner)?,"spotConfigId":id(&s.config.social_chain.spot_config_id)? ,"spotClaimRegistryId":id(&s.config.social_chain.spot_claim_registry_id)?,"evidenceSource":"configured_fullnode","approval":"owner_wallet","nativeOracleCapabilityRequired":true}))
}
pub async fn validate_action(s:&AppState,a:&AuthInfo,action:&str,p:&Value)->Result<(),AppError>{if action==ACTION{tokio::time::timeout(std::time::Duration::from_secs(25),verify_claimable(s,a,p)).await.map_err(|_|AppError::Internal("Spot payout validation exceeded its read budget".into()))??;}else if action==BET_ACTION{tokio::time::timeout(std::time::Duration::from_secs(25),verify_bet(s,a,p)).await.map_err(|_|AppError::Internal("Spot bet validation exceeded its read budget".into()))??;}else if action==CREATE_MARKET_ACTION{tokio::time::timeout(std::time::Duration::from_secs(25),verify_market_creation(s,a,p)).await.map_err(|_|AppError::Internal("Spot market validation exceeded its read budget".into()))??;}Ok(())}
pub fn receipt_context(p:&Value,owner:&str,platform:&str)->Result<Option<Value>,AppError>{let mut v=if p.get("spotOracleAdminCapId").is_some(){market_params(p)?}else if p.get("paymentCoinId").is_some(){bet_params(p)?}else{params(p)?};v["beneficiary"]=json!(id(owner)?);v["executionPlatformId"]=json!(id(platform)?);Ok(Some(v))}
async fn receipt(s:&AppState,a:&AuthInfo,digest:&str)->Result<Value,AppError>{
    digest_bytes(digest).map_err(|_|bad("Invalid spot payout receipt digest"))?;
    let row=crate::chain_actions::get_by_digest(&s.db,&a.account_id,&a.agent_object_id,digest).await?.filter(|r|r.registry_action==ACTION&&same(&r.package_id,&s.config.package_id)).ok_or_else(||AppError::BlobNotFound("Spot payout receipt is outside this account/agent scope".into()))?;
    let c=row.receipt_context.as_ref().ok_or_else(||AppError::Conflict("Prepared spot payout context is unavailable".into()))?;
    if !same(c["beneficiary"].as_str().ok_or_else(invalid)?,&a.owner)||!same(c["executionPlatformId"].as_str().ok_or_else(invalid)?,&s.config.social_chain.platform_object_id){return Err(AppError::BlobNotFound("Spot payout receipt is outside this principal or platform".into()));}
    let tx=rpc(s,"myso_getTransactionBlock",json!([digest,{"showInput":true,"showEffects":true,"showEvents":true}])).await?;
    let sender=tx.pointer("/transaction/data/sender").or_else(||tx.pointer("/transaction/sender")).and_then(Value::as_str).ok_or_else(invalid)?;
    if !same(sender,&a.owner)||!same(sender,&row.sender){return Err(AppError::Conflict("Payout sender does not match approving principal".into()));}
    let status=tx.pointer("/effects/status/status").and_then(Value::as_str);let checkpoint=tx.get("checkpoint").filter(|v|!v.is_null());let finalized=status==Some("success")&&checkpoint.is_some();
    let expected=coin_type(&format!("{}::social_proof_of_truth::SpotPayoutEvent",s.config.package_id))?;
    let events=tx.get("events").and_then(Value::as_array).ok_or_else(invalid)?;
    let matches=events.iter().filter(|e|e.get("type").and_then(Value::as_str).and_then(|t|coin_type(t).ok()).as_deref()==Some(expected.as_str())).filter(|e|{let d=&e["parsedJson"];same(d["post_id"].as_str().unwrap_or(""),c["postId"].as_str().unwrap_or(""))&&same(d["user"].as_str().unwrap_or(""),c["beneficiary"].as_str().unwrap_or(""))}).collect::<Vec<_>>();
    if finalized&&(matches.len()!=1||u64v(matches[0]["parsedJson"].get("amount"))?==0){return Err(AppError::Conflict("Unique spot payout event could not be verified".into()));}
    Ok(json!({"digest":digest,"registryAction":ACTION,"status":match status{Some("success") if finalized=>"finalized",Some("success")=>"checkpoint_pending",Some("failure")=>"failed",_=>"unknown"},"checkpoint":checkpoint.map(|v|v.to_string()),"claim":matches.first().map(|e|&e["parsedJson"]),"evidenceSource":"configured_fullnode_and_scoped_preparation"}))
}
async fn bet_receipt(s:&AppState,a:&AuthInfo,digest:&str)->Result<Value,AppError>{
    digest_bytes(digest).map_err(|_|bad("Invalid spot bet receipt digest"))?;
    let row=crate::chain_actions::get_by_digest(&s.db,&a.account_id,&a.agent_object_id,digest).await?.filter(|r|r.registry_action==BET_ACTION&&same(&r.package_id,&s.config.package_id)).ok_or_else(||AppError::BlobNotFound("Spot bet receipt is outside this account/agent scope".into()))?;
    let c=row.receipt_context.as_ref().ok_or_else(||AppError::Conflict("Prepared spot bet context is unavailable".into()))?;
    if !same(c["beneficiary"].as_str().ok_or_else(invalid)?,&a.owner)||!same(c["executionPlatformId"].as_str().ok_or_else(invalid)?,&s.config.social_chain.platform_object_id){return Err(AppError::BlobNotFound("Spot bet receipt is outside this principal or platform".into()));}
    let tx=rpc(s,"myso_getTransactionBlock",json!([digest,{"showInput":true,"showEffects":true,"showEvents":true}])).await?;let sender=tx.pointer("/transaction/data/sender").or_else(||tx.pointer("/transaction/sender")).and_then(Value::as_str).ok_or_else(invalid)?;
    if !same(sender,&a.owner)||!same(sender,&row.sender){return Err(AppError::Conflict("Spot bet sender does not match approving principal".into()));}
    let status=tx.pointer("/effects/status/status").and_then(Value::as_str);let checkpoint=tx.get("checkpoint").filter(|v|!v.is_null());let finalized=status==Some("success")&&checkpoint.is_some();let expected=coin_type(&format!("{}::social_proof_of_truth::SpotBetPlacedEvent",s.config.package_id))?;
    let events=tx.get("events").and_then(Value::as_array).ok_or_else(invalid)?;let matches=events.iter().filter(|e|e.get("type").and_then(Value::as_str).and_then(|t|coin_type(t).ok()).as_deref()==Some(expected.as_str())).filter(|e|{let d=&e["parsedJson"];same(d["market_id"].as_str().unwrap_or(""),c["marketId"].as_str().unwrap_or(""))&&same(d["post_id"].as_str().unwrap_or(""),c["postId"].as_str().unwrap_or(""))&&same(d["user"].as_str().unwrap_or(""),c["beneficiary"].as_str().unwrap_or(""))&&d["option_id"].as_u64()==c["optionId"].as_u64()&&u64v(d.get("amount")).ok()==u64v(c.get("amountBaseUnits")).ok()}).collect::<Vec<_>>();
    if finalized&&matches.len()!=1{return Err(AppError::Conflict("Unique exact spot bet event could not be verified".into()));}
    Ok(json!({"digest":digest,"registryAction":BET_ACTION,"status":match status{Some("success") if finalized=>"finalized",Some("success")=>"checkpoint_pending",Some("failure")=>"failed",_=>"unknown"},"checkpoint":checkpoint.map(|v|v.to_string()),"bet":matches.first().map(|e|&e["parsedJson"]),"evidenceSource":"configured_fullnode_and_scoped_preparation"}))
}
fn hex_bytes(s:&str)->Result<Vec<u64>,AppError>{let h=s.strip_prefix("0x").ok_or_else(invalid)?;if h.len()!=64{return Err(invalid());}Ok((0..32).map(|i|u64::from_str_radix(&h[i*2..i*2+2],16).map_err(|_|invalid())).collect::<Result<Vec<_>,_>>()?)}
fn event_bytes_match(v:Option<&Value>,expected:&[u64])->bool{v.and_then(Value::as_array).is_some_and(|bytes|bytes.len()==expected.len()&&bytes.iter().zip(expected).all(|(actual,want)|actual.as_u64()==Some(*want)))}
async fn market_receipt(s:&AppState,a:&AuthInfo,digest:&str)->Result<Value,AppError>{
    digest_bytes(digest).map_err(|_|bad("Invalid spot market receipt digest"))?;
    let row=crate::chain_actions::get_by_digest(&s.db,&a.account_id,&a.agent_object_id,digest).await?.filter(|r|r.registry_action==CREATE_MARKET_ACTION&&same(&r.package_id,&s.config.package_id)).ok_or_else(||AppError::BlobNotFound("Spot market receipt is outside this account/agent scope".into()))?;
    let c=row.receipt_context.as_ref().ok_or_else(||AppError::Conflict("Prepared spot market context is unavailable".into()))?;
    if !same(c["beneficiary"].as_str().ok_or_else(invalid)?,&a.owner)||!same(c["executionPlatformId"].as_str().ok_or_else(invalid)?,&s.config.social_chain.platform_object_id){return Err(AppError::BlobNotFound("Spot market receipt is outside this principal or platform".into()));}
    let tx=rpc(s,"myso_getTransactionBlock",json!([digest,{"showInput":true,"showEffects":true,"showEvents":true}])).await?;let sender=tx.pointer("/transaction/data/sender").or_else(||tx.pointer("/transaction/sender")).and_then(Value::as_str).ok_or_else(invalid)?;
    if !same(sender,&a.owner)||!same(sender,&row.sender){return Err(AppError::Conflict("Market creator does not match approving principal".into()));}
    let status=tx.pointer("/effects/status/status").and_then(Value::as_str);let checkpoint=tx.get("checkpoint").filter(|v|!v.is_null());let finalized=status==Some("success")&&checkpoint.is_some();let expected=coin_type(&format!("{}::social_proof_of_truth::SpotMarketCreatedEvent",s.config.package_id))?;let claim_type=coin_type(&format!("{}::social_proof_of_truth::SpotClaimCreatedEvent",s.config.package_id))?;let expected_key=hex_bytes(c["marketKeyHashHex"].as_str().ok_or_else(invalid)?)?;let expected_claim=hex_bytes(c["semanticClaimHashHex"].as_str().ok_or_else(invalid)?)?;
    let expected_policy=hex_bytes(c["resolutionPolicyHashHex"].as_str().ok_or_else(invalid)?)?;let events=tx.get("events").and_then(Value::as_array).ok_or_else(invalid)?;let matches=events.iter().filter(|e|e.get("type").and_then(Value::as_str).and_then(|t|coin_type(t).ok()).as_deref()==Some(expected.as_str())).filter(|e|{let d=&e["parsedJson"];event_bytes_match(d.get("market_key_hash"),&expected_key)&&event_bytes_match(d.get("resolution_policy_hash"),&expected_policy)&&same(d["primary_post_id"].as_str().unwrap_or(""),c["postId"].as_str().unwrap_or(""))&&d.get("betting_options")==c.get("bettingOptions")&&u64v(d.get("resolution_at_ms")).ok()==u64v(c.get("resolutionAtMs")).ok()}).collect::<Vec<_>>();
    let claim_events=events.iter().filter(|e|e.get("type").and_then(Value::as_str).and_then(|t|coin_type(t).ok()).as_deref()==Some(claim_type.as_str())).filter(|e|event_bytes_match(e.pointer("/parsedJson/semantic_claim_hash"),&expected_claim)).collect::<Vec<_>>();
    if finalized&&(matches.len()!=1||claim_events.len()!=1){return Err(AppError::Conflict("Unique exact spot market and claim creation events could not be verified".into()));}
    Ok(json!({"digest":digest,"registryAction":CREATE_MARKET_ACTION,"status":match status{Some("success") if finalized=>"finalized",Some("success")=>"checkpoint_pending",Some("failure")=>"failed",_=>"unknown"},"checkpoint":checkpoint.map(|v|v.to_string()),"market":matches.first().map(|e|&e["parsedJson"]),"claim":claim_events.first().map(|e|&e["parsedJson"]),"evidenceSource":"configured_fullnode_and_scoped_preparation"}))
}
pub async fn read(s:&Arc<AppState>,a:&AuthInfo,resource:&str,idv:Option<&str>)->Result<Value,AppError>{match resource{"spot_claim_receipt"=>receipt(s,a,idv.ok_or_else(||bad("id is required"))?).await,"spot_bet_receipt"=>bet_receipt(s,a,idv.ok_or_else(||bad("id is required"))?).await,"spot_market_receipt"=>market_receipt(s,a,idv.ok_or_else(||bad("id is required"))?).await,_=>Err(bad("unknown spot market read resource"))}}
