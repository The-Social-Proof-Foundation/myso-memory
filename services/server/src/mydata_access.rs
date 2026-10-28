//! Named P2P MyData quotes from chain state, never public-marketplace discovery.
//! The quote pins public ciphertext and terms; it does not decrypt content or prove quality.
use crate::types::{AppError, AppState, AuthInfo};
use crate::memory_contract;
use axum::{extract::State, Extension, Json};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use blake2::digest::consts::U32;
use blake2::Blake2b;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;

fn invalid() -> AppError {
    AppError::Internal("MyData chain record is invalid or unavailable".into())
}

const GRAPH_MANIFEST_MEDIA_TYPE: &str = "application/vnd.mysocial.graph-manifest+json;version=1";
const GRAPH_JSON_MEDIA_TYPE: &str = "application/vnd.mysocial.knowledge-graph+json;version=1";

struct GraphOfferCapsule {
    seller_public_key: [u8; 32], manifest_hash: [u8; 32], published_at_ms: u64,
    graph_id: Option<String>, graph_version: Option<u64>,
    authority_kind: u8, organization_id: [u8; 32], delegate_id: [u8; 32], checked_at_ms: u64,
    access_kind: u8, price_mist: u64, duration_days: u64, revocation: u8,
    entitlement: u8, series_id: String, signature: [u8; 64],
}

fn read_capsule_u64(bytes: &[u8], offset: &mut usize) -> Result<u64, AppError> {
    let end = offset.checked_add(8).ok_or_else(invalid)?;
    let slice: [u8; 8] = bytes.get(*offset..end).ok_or_else(invalid)?.try_into().map_err(|_| invalid())?;
    *offset = end; Ok(u64::from_le_bytes(slice))
}

fn graph_publication_capsule(tags: &[Value]) -> Result<Option<GraphOfferCapsule>, AppError> {
    let mut chunks = Vec::<(usize, usize, &str)>::new();
    for tag in tags.iter().filter_map(Value::as_str).filter(|tag| tag.starts_with("mysog1:")) {
        if tag.len() > 64 { return Err(AppError::Forbidden("Graph offer publication metadata is malformed".into())); }
        let rest = tag.strip_prefix("mysog1:").ok_or_else(invalid)?;
        let (sequence, payload) = rest.split_once(':').ok_or_else(invalid)?;
        let (index, count) = sequence.split_once('/').ok_or_else(invalid)?;
        if payload.is_empty() || !payload.bytes().all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b)) { return Err(AppError::Forbidden("Graph offer publication metadata is malformed".into())); }
        chunks.push((index.parse().map_err(|_| invalid())?, count.parse().map_err(|_| invalid())?, payload));
    }
    if chunks.is_empty() { return Ok(None); }
    if chunks.len() > 10 || chunks.iter().any(|(_, count, _)| *count != chunks.len()) { return Err(AppError::Forbidden("Graph offer publication proof is incomplete".into())); }
    chunks.sort_by_key(|(index, _, _)| *index);
    if chunks.iter().enumerate().any(|(expected, (index, _, _))| *index != expected + 1) { return Err(AppError::Forbidden("Graph offer publication proof is incomplete".into())); }
    let encoded: String = chunks.into_iter().map(|(_, _, payload)| payload).collect();
    let bytes = BASE64.decode(encoded).map_err(|_| AppError::Forbidden("Graph offer publication proof is malformed".into()))?;
    let mut offset = 0usize;
    let take = |offset: &mut usize, count: usize| -> Result<Vec<u8>, AppError> {
        let end = offset.checked_add(count).ok_or_else(invalid)?;
        let result = bytes.get(*offset..end).ok_or_else(invalid)?.to_vec(); *offset = end; Ok(result)
    };
    let magic = take(&mut offset, 5)?;
    if magic.get(..4) != Some(&[0x4d, 0x47, 0x50, 0x31][..]) || !matches!(magic.get(4), Some(1 | 2)) { return Err(AppError::Forbidden("Unsupported graph offer publication proof".into())); }
    let capsule_version = magic[4];
    let seller_public_key: [u8; 32] = take(&mut offset, 32)?.try_into().map_err(|_| invalid())?;
    let manifest_hash: [u8; 32] = take(&mut offset, 32)?.try_into().map_err(|_| invalid())?;
    let published_at_ms = read_capsule_u64(&bytes, &mut offset)?;
    let (graph_id, graph_version) = if capsule_version == 2 {
        let length = take(&mut offset, 1)?[0] as usize;
        if length == 0 || length > 128 { return Err(invalid()); }
        let id = String::from_utf8(take(&mut offset, length)?).map_err(|_| invalid())?;
        if !id.as_bytes()[0].is_ascii_alphanumeric() || !id.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte)) { return Err(invalid()); }
        let version = read_capsule_u64(&bytes, &mut offset)?;
        if version == 0 { return Err(invalid()); }
        (Some(id), Some(version))
    } else { (None, None) };
    let authority_kind = take(&mut offset, 1)?[0]; if authority_kind > 1 { return Err(invalid()); }
    let organization_id: [u8; 32] = take(&mut offset, 32)?.try_into().map_err(|_| invalid())?;
    let delegate_id: [u8; 32] = take(&mut offset, 32)?.try_into().map_err(|_| invalid())?;
    let checked_at_ms = read_capsule_u64(&bytes, &mut offset)?;
    let access_kind = take(&mut offset, 1)?[0];
    let price_mist = read_capsule_u64(&bytes, &mut offset)?;
    let duration_days = read_capsule_u64(&bytes, &mut offset)?;
    let revocation = take(&mut offset, 1)?[0]; let entitlement = take(&mut offset, 1)?[0];
    let series_length = take(&mut offset, 1)?[0] as usize;
    let series_id = String::from_utf8(take(&mut offset, series_length)?).map_err(|_| invalid())?;
    let signature: [u8; 64] = take(&mut offset, 64)?.try_into().map_err(|_| invalid())?;
    if offset != bytes.len() || access_kind != 2 && access_kind != 3 || revocation > 2 || entitlement > 1
        || (authority_kind == 0 && delegate_id.iter().any(|byte| *byte != 0))
        || (authority_kind == 1 && delegate_id.iter().all(|byte| *byte == 0))
        || (entitlement == 0 && !series_id.is_empty()) || (entitlement == 1 && series_id.is_empty())
    { return Err(AppError::Forbidden("Graph offer publication proof is inconsistent".into())); }
    Ok(Some(GraphOfferCapsule { seller_public_key, manifest_hash, published_at_ms, graph_id, graph_version, authority_kind, organization_id, delegate_id, checked_at_ms, access_kind, price_mist, duration_days, revocation, entitlement, series_id, signature }))
}

fn graph_publication_signature_message(capsule: &GraphOfferCapsule, seller: &str) -> Result<Vec<u8>, AppError> {
    let kind = if capsule.authority_kind == 0 { "organization_admin" } else { "sell_graph_delegate" };
    let mut authority = json!({"kind":kind,"organizationId":format!("0x{}",hex::encode(capsule.organization_id)),"capability":"sell_graph","checkedAtMs":capsule.checked_at_ms});
    if capsule.authority_kind == 1 { authority["delegateId"] = json!(format!("0x{}", hex::encode(capsule.delegate_id))); }
    let revocation = match capsule.revocation { 0 => "one_time_perpetual", 1 => "subscription_period_end", _ => "subscription_early_future_only" };
    let entitlement = if capsule.entitlement == 0 { "pinned_version" } else { "series_stream" };
    let mut terms = json!({"accessKind":capsule.access_kind,"priceMist":capsule.price_mist.to_string(),"durationDays":capsule.duration_days.to_string(),"revocationPolicy":revocation,"entitlement":entitlement,"audiencePolicy":"buyer_agent_or_explicit_org"});
    if !capsule.series_id.is_empty() { terms["seriesId"] = json!(capsule.series_id); }
    let mut signed = json!({"domain":"mysocial-graph-publication-v1","manifestHashHex":hex::encode(capsule.manifest_hash),
        "sellerAddress":seller,"publishedAtMs":capsule.published_at_ms,"authorityProof":authority,"offerTerms":terms});
    if let (Some(graph_id), Some(graph_version)) = (&capsule.graph_id, capsule.graph_version) {
        signed["graphId"] = json!(graph_id);
        signed["graphVersion"] = json!(graph_version);
    }
    serde_json::to_vec(&signed).map_err(|_| invalid())
}

fn verify_graph_publication_signature(capsule: &GraphOfferCapsule, seller: &str) -> Result<(), AppError> {
    let derived = Blake2b::<U32>::digest([&[0u8][..], &capsule.seller_public_key].concat());
    let derived_address = format!("0x{}", hex::encode(derived));
    if !crate::memory_contract::addresses_equal(&derived_address, seller) { return Err(AppError::Forbidden("Graph offer signer does not match the on-chain seller".into())); }
    let public_key = VerifyingKey::from_bytes(&capsule.seller_public_key).map_err(|_| invalid())?;
    let signature = Signature::from_bytes(&capsule.signature);
    public_key.verify(&graph_publication_signature_message(capsule, &crate::memory_contract::normalize_object_id(seller))?, &signature)
        .map_err(|_| AppError::Forbidden("Graph offer seller signature is invalid".into()))
}
fn u64_field(value: Option<&Value>) -> Result<u64, AppError> {
    match value {
        Some(Value::String(text))
            if !text.is_empty()
                && (text == "0" || !text.starts_with('0'))
                && text.bytes().all(|b| b.is_ascii_digit()) =>
        {
            text.parse().map_err(|_| invalid())
        }
        Some(Value::Number(number)) => number.as_u64().ok_or_else(invalid),
        _ => Err(invalid()),
    }
}
fn bytes(value: Option<&Value>, max: usize) -> Result<Vec<u8>, AppError> {
    let values = value.and_then(Value::as_array).ok_or_else(invalid)?;
    if values.is_empty() || values.len() > max {
        return Err(invalid());
    }
    values
        .iter()
        .map(|value| {
            value
                .as_u64()
                .and_then(|byte| u8::try_from(byte).ok())
                .ok_or_else(invalid)
        })
        .collect()
}
fn address(value: Option<&Value>) -> Result<String, AppError> {
    let text = value.and_then(Value::as_str).ok_or_else(invalid)?;
    let hex = text.strip_prefix("0x").ok_or_else(invalid)?;
    if hex.is_empty() || hex.len() > 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid());
    }
    Ok(crate::memory_contract::normalize_object_id(text))
}
fn optional_address(value: Option<&Value>) -> Result<Option<String>, AppError> {
    match value {
        Some(Value::Null) => Ok(None),
        Some(value) => address(Some(value)).map(Some),
        None => Err(invalid()),
    }
}
async fn chain_rpc(state: &AppState, method: &str, params: Value) -> Result<Value, AppError> {
    let mut response = state
        .http_client
        .post(&state.config.myso_rpc_url)
        .timeout(std::time::Duration::from_secs(15))
        .json(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
        .send()
        .await
        .map_err(|_| invalid())?;
    if !response.status().is_success() {
        return Err(invalid());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| invalid())? {
        if body.len().saturating_add(chunk.len()) > 2 * 1024 * 1024 {
            return Err(invalid());
        }
        body.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&body).map_err(|_| invalid())?;
    value
        .get("result")
        .filter(|value| !value.is_null())
        .cloned()
        .ok_or_else(|| AppError::BlobNotFound("MyData chain record unavailable".into()))
}
fn listing_fields<'a>(
    data: &'a Value,
    package: &str,
    id: &str,
) -> Result<&'a Map<String, Value>, AppError> {
    let content = data.get("content").ok_or_else(invalid)?;
    let mut type_parts = content
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?
        .split("::");
    if !crate::memory_contract::addresses_equal(type_parts.next().unwrap_or_default(), package)
        || type_parts.next() != Some("mydata")
        || type_parts.next() != Some("MyData")
        || type_parts.next().is_some()
    {
        return Err(invalid());
    }
    if address(data.get("objectId"))? != crate::memory_contract::normalize_object_id(id) {
        return Err(invalid());
    }
    let fields: &Map<String, Value> = content
        .get("fields")
        .and_then(Value::as_object)
        .ok_or_else(invalid)?;
    Ok(fields)
}
fn quote(data: &Value, package: &str, id: &str, buyer: &str) -> Result<Value, AppError> {
    let fields = listing_fields(data, package, id)?;
    let access = fields.get("access").ok_or_else(invalid)?;
    let access_fields = access
        .get("fields")
        .and_then(Value::as_object)
        .ok_or_else(invalid)?;
    let (kind, duration) = match access.get("variant").and_then(Value::as_str) {
        Some("MarketplaceOneTime") => (2, 0),
        Some("MarketplaceRecurring") => (3, u64_field(access_fields.get("duration_days"))?),
        _ => {
            return Err(AppError::BadRequest(
                "This MyData listing does not use direct one-time or recurring access".into(),
            ))
        }
    };
    let price = u64_field(access_fields.get("price"))?;
    if price == 0 || (kind == 3 && duration == 0) {
        return Err(invalid());
    }
    let seller = address(fields.get("owner"))?;
    let media_type = fields.get("media_type").and_then(Value::as_str).filter(|value| !value.is_empty() && value.len() <= 1024).ok_or_else(invalid)?;
    let tags = fields.get("tags").and_then(Value::as_array).filter(|values| values.len() <= 10)
        .ok_or_else(invalid)?;
    if tags.iter().any(|value| value.as_str().map_or(true, |tag| tag.len() > 64)) { return Err(invalid()); }
    let encryption_id = bytes(fields.get("encryption_id"), 1024)?;
    let ciphertext = bytes(fields.get("encrypted_data"), 262144)?;
    let platform = optional_address(fields.get("platform_id"))?;
    let mut parameters = json!({
        "mydataId": id, "expectedSeller": seller, "accessKind": kind,
        "priceMist": price.to_string(), "durationDays": duration.to_string(),
        "encryptionIdHex": hex::encode(encryption_id),
        "encryptedDataDigestHex": hex::encode(Sha256::digest(ciphertext)),
    });
    if let Some(platform) = platform {
        parameters["expectedListingPlatformId"] = json!(platform);
    }
    Ok(json!({
        "mydataId": id, "buyerAddress": buyer, "objectVersion": u64_field(data.get("version"))?.to_string(),
        "mediaType": media_type, "tags": tags,
        "quotedAtMs": chrono::Utc::now().timestamp_millis(), "purchaseParameters": parameters,
        "entitlementAddress": buyer, "requiresMarketplaceDiscovery": false,
        "deploymentEnabled": false,
        "chain": {"source":"myso_getObject","termsPinnedAtExecution":true},
    }))
}

pub async fn get_quote(state: &AppState, auth: &AuthInfo, id: &str) -> Result<Value, AppError> {
    let response = chain_rpc(state, "myso_getObject", json!([id,{"showContent":true}])).await?;
    let data = response
        .get("data")
        .ok_or_else(|| AppError::BlobNotFound("MyData record unavailable".into()))?;
    let mut result = quote(&data, &state.config.package_id, id, &auth.derived_address)?;
    result["deploymentEnabled"] = json!(
        state.config.mydata_bounded_purchase_enabled
            && !state.config.social_chain.mydata_config_id.is_empty()
            && !state.config.social_chain.ecosystem_treasury_id.is_empty()
    );
    Ok(result)
}

/// Graph purchases are rejected unless the public seller capsule, exact quote,
/// signature, and live organization authority all pass before the transaction is
/// prepared. This is independent of a preceding UI/MCP verification call.
pub async fn validate_action(
    state: &AppState,
    auth: &AuthInfo,
    action: &str,
    parameters: &Value,
) -> Result<(), AppError> {
    if action == "access.publish_mydata_graph.v1" {
        return validate_graph_listing_publication(state, auth, parameters).await;
    }
    if action != "access.purchase_mydata_access.v1" { return Ok(()); }
    let id = parameters.get("mydataId").and_then(Value::as_str).filter(|id| valid_id(id))
        .ok_or_else(|| AppError::BadRequest("Invalid MyData listing ID".into()))?;
    let id = crate::memory_contract::normalize_object_id(id);
    let response = chain_rpc(state, "myso_getObject", json!([id,{"showContent":true}])).await?;
    let data = response.get("data").ok_or_else(invalid)?;
    let fields = listing_fields(data, &state.config.package_id, &id)?;
    let media_type = fields.get("media_type").and_then(Value::as_str).ok_or_else(invalid)?;
    if media_type == GRAPH_JSON_MEDIA_TYPE {
        return Err(AppError::Forbidden("Legacy unsigned graph listings cannot be purchased; the seller must republish a signed GraphManifest".into()));
    }
    if media_type != GRAPH_MANIFEST_MEDIA_TYPE { return Ok(()); }
    match parameters.get("audienceKind").and_then(Value::as_str) {
        Some("agent") if parameters.get("organizationAudienceId").is_none() => {},
        Some("organization") => {
            let selected = parameters.get("organizationAudienceId").and_then(Value::as_str).filter(|id| valid_id(id)).ok_or_else(|| AppError::BadRequest("organizationAudienceId is required for organization graph access".into()))?;
            if auth.organization_id.as_deref().is_none_or(|current| !crate::memory_contract::addresses_equal(current, selected)) { return Err(AppError::Forbidden("Selected graph audience must be an organization this agent currently belongs to".into())); }
        }
        _ => return Err(AppError::BadRequest("Graph purchases require an explicit agent or organization audience".into())),
    }
    let quoted = quote(data, &state.config.package_id, &id, &auth.derived_address)?;
    let purchase = quoted.get("purchaseParameters").ok_or_else(invalid)?;
    for (parameter, quote_field) in [("expectedSeller", "expectedSeller"), ("accessKind", "accessKind"), ("priceMist", "priceMist"), ("durationDays", "durationDays"), ("encryptionIdHex", "encryptionIdHex"), ("encryptedDataDigestHex", "encryptedDataDigestHex")] {
        if parameters.get(parameter) != purchase.get(quote_field) { return Err(AppError::Conflict("Graph purchase parameters differ from the current MyData quote".into())); }
    }
    let tags = fields.get("tags").and_then(Value::as_array).ok_or_else(invalid)?;
    let capsule = graph_publication_capsule(tags)?.ok_or_else(|| AppError::Forbidden("GraphManifest purchase requires a seller-signed public proof in MyData tags".into()))?;
    let seller = purchase.get("expectedSeller").and_then(Value::as_str).ok_or_else(invalid)?;
    verify_graph_publication_signature(&capsule, seller)?;
    let graph_id = parameters.get("graphId").and_then(Value::as_str).ok_or_else(|| AppError::BadRequest("Graph purchases must pin graphId".into()))?;
    let graph_version = u64_field(parameters.get("graphVersion"))?;
    let manifest_hash = parameters.get("manifestHashHex").and_then(Value::as_str).ok_or_else(invalid)?;
    let publication_signature = parameters.get("publicationSignatureHex").and_then(Value::as_str).ok_or_else(invalid)?;
    let manifest_hash = hex::decode(manifest_hash).map_err(|_| invalid())?;
    let publication_signature = hex::decode(publication_signature).map_err(|_| invalid())?;
    if capsule.graph_id.as_deref() != Some(graph_id)
        || capsule.graph_version != Some(graph_version)
        || capsule.manifest_hash.as_slice() != manifest_hash
        || capsule.signature.as_slice() != publication_signature
    { return Err(AppError::Conflict("Graph purchase snapshot differs from the seller-signed publication".into())); }
    if capsule.authority_kind == 1 {
        let seller_hex = seller.strip_prefix("0x").ok_or_else(invalid)?;
        let seller_bytes: [u8; 32] = hex::decode(format!("{seller_hex:0>64}")).map_err(|_| invalid())?.try_into().map_err(|_| invalid())?;
        if capsule.delegate_id != seller_bytes { return Err(AppError::Forbidden("Graph publication delegate does not match the signing seller".into())); }
    }
    let expected_kind = purchase.get("accessKind").and_then(Value::as_u64).ok_or_else(invalid)? as u8;
    let expected_price = purchase.get("priceMist").and_then(Value::as_str).ok_or_else(invalid)?.parse::<u64>().map_err(|_| invalid())?;
    let expected_duration = purchase.get("durationDays").and_then(Value::as_str).ok_or_else(invalid)?.parse::<u64>().map_err(|_| invalid())?;
    if capsule.access_kind != expected_kind || capsule.price_mist != expected_price || capsule.duration_days != expected_duration
        || (expected_kind == 2 && (expected_duration != 0 || capsule.revocation != 0 || capsule.entitlement != 0))
        || (expected_kind == 3 && (expected_duration == 0 || capsule.revocation == 0 || capsule.entitlement != 0 || !capsule.series_id.is_empty()))
    { return Err(AppError::Conflict("Signed graph offer does not match the quote or promises unsupported future-version access; republish it as a pinned immutable graph version".into())); }
    let organization_id = format!("0x{}", hex::encode(capsule.organization_id));
    let authority = crate::org_chain::verify_graph_seller_authority(&state.http_client, &state.config.myso_rpc_url,
        &state.config.package_id, &organization_id, seller).await
        .map_err(|_| AppError::Internal("Graph seller authority could not be verified".into()))?;
    let authority_matches = matches!((capsule.authority_kind, authority),
        (0, Some(crate::org_chain::GraphSellerAuthority::OrganizationAdmin))
        | (1, Some(crate::org_chain::GraphSellerAuthority::SellGraphDelegate)));
    if !authority_matches { return Err(AppError::Forbidden("Graph seller no longer has the authority stated in the publication".into())); }
    Ok(())
}

/// The transaction sender, which is the agent for automatic purchases and the
/// owner for owner-approved purchases, must own the exact selected MYSO coin.
pub async fn validate_funding_coin(
    state: &AppState,
    auth: &AuthInfo,
    parameters: &Value,
    transaction_sender: &str,
) -> Result<(), AppError> {
    let coin_id = parameters.get("paymentCoinId").and_then(Value::as_str)
        .filter(|value| valid_id(value)).ok_or_else(|| AppError::BadRequest("paymentCoinId is required".into()))?;
    let coin_id = crate::chain_reads::id(coin_id)?;
    let coin = crate::chain_reads::object(state, &coin_id).await?;
    let owner = crate::chain_reads::address(coin.pointer("/owner/AddressOwner"))?;
    let sender = crate::chain_reads::id(transaction_sender)?;
    let expected_type = crate::chain_reads::coin_type("0x2::coin::Coin<0x2::myso::MYSO>")?;
    let actual_type = coin.pointer("/content/type").and_then(Value::as_str).ok_or_else(invalid)?;
    let sender_is_agent = crate::chain_reads::same(&sender, &auth.derived_address);
    let sender_is_owner = crate::chain_reads::same(&sender, &auth.owner);
    if (!sender_is_agent && !sender_is_owner)
        || !crate::chain_reads::same(&owner, &sender)
        || crate::chain_reads::coin_type(actual_type)? != expected_type
    {
        return Err(AppError::Forbidden("The selected MYSO coin must be owned by the authorized transaction sender".into()));
    }
    let balance = crate::chain_reads::u64_value(coin.pointer("/content/fields/balance"))?;
    let price = parameters.get("priceMist").and_then(Value::as_str).and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| AppError::BadRequest("priceMist must be a valid decimal u64 string".into()))?;
    if sender_is_agent && !auth.owner_co_signed {
        let cap = auth.max_action_spend.filter(|value| *value > 0)
            .ok_or_else(|| AppError::Forbidden("Automatic purchases require a live nonzero agent spend cap".into()))?;
        if price > cap { return Err(AppError::Forbidden("Purchase exceeds the agent's live MYSO spend cap".into())); }
    }
    if balance < price { return Err(AppError::Conflict("The selected agent or owner MYSO coin no longer covers the exact quoted price".into())); }
    Ok(())
}

async fn validate_graph_listing_publication(
    state: &AppState,
    auth: &AuthInfo,
    parameters: &Value,
) -> Result<(), AppError> {
    if parameters.get("mediaType").and_then(Value::as_str) != Some(GRAPH_MANIFEST_MEDIA_TYPE) {
        return Err(AppError::Forbidden("Graph listing must use the MySocial GraphManifest media type".into()));
    }
    let tags = parameters.get("tags").and_then(Value::as_array).ok_or_else(invalid)?;
    let capsule = graph_publication_capsule(tags)?.ok_or_else(|| AppError::Forbidden("Graph listing requires a seller-signed public proof in MyData tags".into()))?;
    if capsule.graph_id.is_none() || capsule.graph_version.is_none() {
        return Err(AppError::Forbidden("New GraphManifest listings require a signed graph ID and immutable version".into()));
    }
    if u64_field(parameters.get("timestampStart"))? != capsule.published_at_ms {
        return Err(AppError::Conflict("Graph listing timestamp differs from its seller-signed publication".into()));
    }
    let encrypted_hex = parameters.get("encryptedDataHex").and_then(Value::as_str).ok_or_else(invalid)?;
    if encrypted_hex.len() > 524_288 || encrypted_hex.len() % 2 != 0 { return Err(AppError::BadRequest("Invalid encrypted GraphManifest bytes".into())); }
    let encrypted = hex::decode(encrypted_hex).map_err(|_| AppError::BadRequest("Invalid encrypted GraphManifest bytes".into()))?;
    if encrypted.is_empty() || encrypted.len() > 262_144 { return Err(AppError::BadRequest("Encrypted GraphManifest exceeds the MyData listing limit".into())); }
    let encryption_id_hex = parameters.get("encryptionIdHex").and_then(Value::as_str).filter(|id| !id.is_empty() && id.len() <= 2048 && id.len() % 2 == 0).ok_or_else(invalid)?;
    let encrypted_digest_hex = hex::encode(Sha256::digest(&encrypted));
    let was_encrypted_by_graph_service = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM mydata_graph_publication_encryptions WHERE account_id=$1 AND agent_object_id=$2 AND encryption_id_hex=$3 AND encrypted_data_digest_hex=$4 AND publication_tags_hash_hex=$5)",
    ).bind(&auth.account_id).bind(&auth.agent_object_id).bind(encryption_id_hex).bind(&encrypted_digest_hex)
        .bind(hex::encode(Sha256::digest(serde_json::to_vec(tags).map_err(|_| invalid())?)))
        .fetch_one(state.db.pool()).await.map_err(|_| AppError::Internal("Graph encryption provenance could not be checked".into()))?;
    if !was_encrypted_by_graph_service { return Err(AppError::Forbidden("Graph listing ciphertext must come from the signed MyData publication encryption path".into())); }
    let seller = crate::memory_contract::normalize_object_id(&auth.derived_address);
    verify_graph_publication_signature(&capsule, &seller)?;
    if capsule.authority_kind == 1 {
        let seller_hex = seller.strip_prefix("0x").ok_or_else(invalid)?;
        let seller_bytes: [u8; 32] = hex::decode(format!("{seller_hex:0>64}")).map_err(|_| invalid())?.try_into().map_err(|_| invalid())?;
        if capsule.delegate_id != seller_bytes { return Err(AppError::Forbidden("Graph publication delegate does not match the authenticated seller".into())); }
    }
    let access_kind = parameters.get("accessKind").and_then(Value::as_u64).ok_or_else(invalid)? as u8;
    let price = u64_field(parameters.get("priceMist"))?;
    let duration = u64_field(parameters.get("durationDays"))?;
    if capsule.access_kind != access_kind || capsule.price_mist != price || capsule.duration_days != duration
        || (access_kind == 2 && (duration != 0 || capsule.revocation != 0 || capsule.entitlement != 0))
        || (access_kind == 3 && (duration == 0 || capsule.revocation == 0 || capsule.entitlement != 0 || !capsule.series_id.is_empty()))
    { return Err(AppError::Forbidden("Graph listing terms differ from its seller-signed publication proof or promise unsupported future-version access".into())); }
    let organization_id = format!("0x{}", hex::encode(capsule.organization_id));
    let authority = crate::org_chain::verify_graph_seller_authority(&state.http_client, &state.config.myso_rpc_url,
        &state.config.package_id, &organization_id, &seller).await
        .map_err(|_| AppError::Internal("Graph seller authority could not be verified".into()))?;
    let authority_matches = matches!((capsule.authority_kind, authority),
        (0, Some(crate::org_chain::GraphSellerAuthority::OrganizationAdmin))
        | (1, Some(crate::org_chain::GraphSellerAuthority::SellGraphDelegate)));
    if !authority_matches { return Err(AppError::Forbidden("Seller no longer has the authority stated in the graph publication".into())); }
    Ok(())
}

/// Read only bounded purchase events for the authenticated agent and deployment.
/// A recorded purchase is separate from current access, revocation or graph truth.
pub async fn get_receipt(
    state: &AppState,
    auth: &AuthInfo,
    digest: &str,
) -> Result<Value, AppError> {
    if !(43..=44).contains(&digest.len())
        || !digest
            .bytes()
            .all(|b| b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".contains(&b))
    {
        return Err(AppError::BadRequest("Invalid transaction digest".into()));
    }
    let result = chain_rpc(
        state,
        "myso_getTransactionBlock",
        json!([digest,{"showEffects":true,"showEvents":true}]),
    )
    .await?;
    if result.get("digest").and_then(Value::as_str) != Some(digest) {
        return Err(invalid());
    }
    let checkpoint = result
        .get("checkpoint")
        .filter(|value| !value.is_null())
        .map(|value| u64_field(Some(value)))
        .transpose()?;
    let status = match result
        .pointer("/effects/status/status")
        .and_then(Value::as_str)
    {
        Some("success") if checkpoint.is_some() => "finalized",
        Some("success") => "executed",
        Some("failure") => "failed",
        _ => "unknown",
    };
    let mut receipts = Vec::new();
    if status == "finalized" || status == "executed" {
        for event in result
            .get("events")
            .and_then(Value::as_array)
            .ok_or_else(invalid)?
        {
            let mut parts = event
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .split("::");
            if !crate::memory_contract::addresses_equal(
                parts.next().unwrap_or_default(),
                &state.config.package_id,
            ) || parts.next() != Some("mydata")
                || parts.next() != Some("BoundedPurchaseEvent")
                || parts.next().is_some()
            {
                continue;
            }
            let parsed = event.get("parsedJson").ok_or_else(invalid)?;
            let buyer = address(parsed.get("buyer"))?;
            let buyer_is_agent = crate::memory_contract::addresses_equal(&buyer, &auth.derived_address);
            let buyer_is_owner = crate::memory_contract::addresses_equal(&buyer, &auth.owner);
            if !buyer_is_agent && !buyer_is_owner {
                continue;
            }
            let buyer_account = address(parsed.get("buyer_memory_account_id"))?;
            let buyer_agent = optional_address(parsed.get("buyer_agent_id"))?;
            let account_matches = crate::memory_contract::addresses_equal(&buyer_account, &auth.account_id);
            let agent_matches = buyer_agent.as_deref().is_some_and(|agent| crate::memory_contract::addresses_equal(agent, &auth.agent_object_id));
            // Agent-auto purchases are keyed by the derived sender and exact agent ID.
            // Owner-approved purchases execute with the owner as sender; scope those
            // receipts to the owner's authenticated MemoryAccount and require the
            // human-actor event shape (no sub-agent ID). The UI separately grants the
            // selected agent's address access after this purchase is finalized.
            if !account_matches || (buyer_is_agent && !agent_matches) || (buyer_is_owner && buyer_agent.is_some()) {
                continue;
            }
            let fee_platform = address(parsed.get("fee_platform_id"))?;
            if !crate::memory_contract::addresses_equal(
                &fee_platform,
                &state.config.social_chain.platform_object_id,
            ) || auth.platform_id.as_deref().is_some_and(|platform| {
                !crate::memory_contract::addresses_equal(platform, &fee_platform)
            }) {
                continue;
            }
            let kind = u64_field(parsed.get("access_kind"))?;
            let duration = u64_field(parsed.get("duration_days"))?;
            if !matches!(kind, 2 | 3)
                || (kind == 2 && duration != 0)
                || (kind == 3 && duration == 0)
            {
                return Err(invalid());
            }
            let data_digest = bytes(parsed.get("encrypted_data_digest"), 32)?;
            let identity_digest = bytes(parsed.get("encryption_id_digest"), 32)?;
            if data_digest.len() != 32 || identity_digest.len() != 32 {
                return Err(invalid());
            }
            let mydata_id = address(parsed.get("mydata_id"))?;
            let seller = address(parsed.get("seller"))?;
            let events = result.get("events").and_then(Value::as_array).ok_or_else(invalid)?;
            let mut organization_audiences = Vec::new();
            for audience_event in events {
                let mut audience_type = audience_event.get("type").and_then(Value::as_str).unwrap_or_default().split("::");
                if !crate::memory_contract::addresses_equal(audience_type.next().unwrap_or_default(), &state.config.package_id)
                    || audience_type.next() != Some("mydata") || audience_type.next() != Some("OrgGraphAudienceBoundEvent") || audience_type.next().is_some() { continue; }
                let audience = audience_event.get("parsedJson").ok_or_else(invalid)?;
                if !crate::memory_contract::addresses_equal(&address(audience.get("mydata_id"))?, &mydata_id)
                    || !crate::memory_contract::addresses_equal(&address(audience.get("buyer"))?, &buyer)
                    || bytes(audience.get("encrypted_data_digest"),32)? != data_digest
                    || bytes(audience.get("encryption_id_digest"),32)? != identity_digest
                    || u64_field(audience.get("access_kind"))? != kind { continue; }
                organization_audiences.push(address(audience.get("organization_id"))?);
            }
            if organization_audiences.len() > 1 { return Err(invalid()); }
            let mut graph_snapshots = Vec::new();
            for snapshot_event in events {
                let mut snapshot_type = snapshot_event.get("type").and_then(Value::as_str).unwrap_or_default().split("::");
                if !crate::memory_contract::addresses_equal(snapshot_type.next().unwrap_or_default(), &state.config.package_id)
                    || snapshot_type.next() != Some("mydata") || snapshot_type.next() != Some("GraphPurchaseSnapshotEvent") || snapshot_type.next().is_some() { continue; }
                let snapshot = snapshot_event.get("parsedJson").ok_or_else(invalid)?;
                if !crate::memory_contract::addresses_equal(&address(snapshot.get("mydata_id"))?, &mydata_id)
                    || !crate::memory_contract::addresses_equal(&address(snapshot.get("buyer"))?, &buyer)
                    || !crate::memory_contract::addresses_equal(&address(snapshot.get("buyer_memory_account_id"))?, &buyer_account)
                    || !crate::memory_contract::addresses_equal(&address(snapshot.get("seller"))?, &seller) { continue; }
                let graph_id = snapshot.get("graph_id").and_then(Value::as_str).filter(|value| !value.is_empty() && value.len() <= 128).ok_or_else(invalid)?;
                let graph_version = u64_field(snapshot.get("graph_version"))?;
                let manifest_hash = bytes(snapshot.get("manifest_hash"),32)?;
                let signature_digest = bytes(snapshot.get("publication_signature_digest"),32)?;
                if graph_version == 0 || graph_version > 9_007_199_254_740_991 || manifest_hash.len()!=32 || signature_digest.len()!=32 { return Err(invalid()); }
                let organization_id = optional_address(snapshot.get("organization_id"))?;
                if organization_id.as_deref() != organization_audiences.first().map(String::as_str) { return Err(invalid()); }
                graph_snapshots.push(json!({"graphId":graph_id,"graphVersion":graph_version,"manifestHashHex":hex::encode(manifest_hash),"publicationSignatureDigestHex":hex::encode(signature_digest),"organizationId":organization_id}));
            }
            if graph_snapshots.len() > 1 { return Err(invalid()); }
            let mut linked_posts = Vec::new();
            for post_event in events {
                let mut post_type = post_event.get("type").and_then(Value::as_str).unwrap_or_default().split("::");
                if !crate::memory_contract::addresses_equal(post_type.next().unwrap_or_default(), &state.config.package_id)
                    || post_type.next() != Some("post") || post_type.next() != Some("PostAccessPurchaseEvent") || post_type.next().is_some() {
                    continue;
                }
                let post = post_event.get("parsedJson").ok_or_else(invalid)?;
                if !crate::memory_contract::addresses_equal(&address(post.get("mydata_id"))?, &mydata_id)
                    || !crate::memory_contract::addresses_equal(&address(post.get("buyer"))?, &buyer)
                    || !crate::memory_contract::addresses_equal(&address(post.get("seller"))?, &seller) {
                    continue;
                }
                linked_posts.push(address(post.get("post_id"))?);
            }
            if linked_posts.len() > 1 { return Err(invalid()); }
            receipts.push(json!({
                "mydataId": mydata_id, "buyerAddress": buyer,
                "buyerAccountId": buyer_account, "buyerAgentId": buyer_agent,
                "buyerExecution": if buyer_is_owner {"owner_approved"} else {"agent_automated"},
                "organizationAudienceId": organization_audiences.first(),
                "seller": seller, "postId": linked_posts.first(), "accessKind": kind,
                "priceMist": u64_field(parsed.get("price"))?.to_string(), "durationDays": duration.to_string(),
                "encryptedDataDigestHex": hex::encode(data_digest), "encryptionIdDigestHex": hex::encode(identity_digest),
                "listingPlatformId": optional_address(parsed.get("listing_platform_id"))?,
                "feePlatformId": fee_platform, "purchasedAtMs": u64_field(parsed.get("timestamp"))?.to_string(),
                "graphSnapshot":graph_snapshots.first(),
            }));
        }
    }
    Ok(
        json!({"digest":digest,"status":status,"checkpoint":checkpoint.map(|value|value.to_string()),
        "receipts":receipts,"evidenceSource":"configured_fullnode","currentAccess":"not_checked"}),
    )
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadContentRequest {
    pub mydata_id: String,
    pub encrypted_data_digest_hex: String,
    pub format: ContentFormat,
    pub offset: u32,
    pub limit: u32,
    #[serde(default)]
    pub organization_audience_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckCurrentAccessRequest {
    pub mydata_id: String,
    pub encrypted_data_digest_hex: String,
    #[serde(default)]
    pub organization_audience_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerifyGraphSellerRequest {
    pub organization_id: String,
    pub seller_address: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EncryptGraphManifestRequest {
    pub document: Value,
    pub tags: Vec<Value>,
    pub encryption_id: String,
    pub idempotency_key: String,
}

/// Validate the signed immutable graph publication and encrypt it with the
/// configured MyData threshold service before the registered create-listing
/// action can place ciphertext on chain.
pub async fn encrypt_graph_manifest(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Json(input): Json<EncryptGraphManifestRequest>,
) -> Result<Json<Value>, AppError> {
    if !memory_contract::has_cap(auth.capabilities, memory_contract::CAP_MYDATA_READ) {
        return Err(AppError::Forbidden("MyData read capability is required to publish a graph".into()));
    }
    if input.encryption_id.is_empty() || input.encryption_id.len() > 256
        || !input.encryption_id.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err(AppError::BadRequest("Invalid GraphManifest encryption identity".into()));
    }
    if !(8..=128).contains(&input.idempotency_key.len())
        || !input.idempotency_key.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._:/-".contains(&byte)) {
        return Err(AppError::BadRequest("Invalid graph publication idempotency key".into()));
    }
    let plaintext = serde_json::to_vec(&input.document).map_err(|_| invalid())?;
    if plaintext.is_empty() || plaintext.len() > 180 * 1024 {
        return Err(AppError::BadRequest("GraphManifest exceeds the supported encrypted listing size".into()));
    }
    let manifest = input.document.get("manifest").ok_or_else(invalid)?;
    let graph_id = manifest.get("graphId").and_then(Value::as_str).ok_or_else(invalid)?;
    let graph_version = u64_field(manifest.get("graphVersion"))?;
    let manifest_bytes = serde_json::to_vec(manifest).map_err(|_| invalid())?;
    let manifest_hash = Sha256::digest(&manifest_bytes);
    let tags_hash = hex::encode(Sha256::digest(serde_json::to_vec(&input.tags).map_err(|_| invalid())?));
    let request_fingerprint = Sha256::digest(serde_json::to_vec(&json!({"document":&input.document,"tags":&input.tags,"encryptionId":&input.encryption_id})).map_err(|_| invalid())?);
    let capsule = graph_publication_capsule(&input.tags)?.ok_or_else(|| AppError::Forbidden("GraphManifest encryption requires its signed listing proof".into()))?;
    if capsule.manifest_hash != manifest_hash.as_slice() {
        return Err(AppError::Forbidden("GraphManifest does not match the seller-signed publication hash".into()));
    }
    if capsule.graph_id.as_deref() != Some(graph_id) || capsule.graph_version != Some(graph_version) {
        return Err(AppError::Forbidden("GraphManifest identity does not match its signed public publication".into()));
    }
    let seller = crate::memory_contract::normalize_object_id(&auth.derived_address);
    verify_graph_publication_signature(&capsule, &seller)?;
    let organization_id = format!("0x{}", hex::encode(capsule.organization_id));
    let authority = crate::org_chain::verify_graph_seller_authority(&state.http_client, &state.config.myso_rpc_url,
        &state.config.package_id, &organization_id, &seller).await
        .map_err(|_| AppError::Internal("Graph seller authority could not be verified".into()))?;
    let authority_matches = matches!((capsule.authority_kind, authority),
        (0, Some(crate::org_chain::GraphSellerAuthority::OrganizationAdmin))
        | (1, Some(crate::org_chain::GraphSellerAuthority::SellGraphDelegate)));
    if !authority_matches { return Err(AppError::Forbidden("Seller no longer has the authority stated in the graph publication".into())); }
    if let Some(existing) = sqlx::query_as::<_, (String, String, String, String)>(
        "SELECT request_hash_hex, encrypted_data_base64, encrypted_data_digest_hex, encryption_id_hex FROM mydata_graph_publication_encryptions WHERE account_id=$1 AND agent_object_id=$2 AND idempotency_key=$3",
    ).bind(&auth.account_id).bind(&auth.agent_object_id).bind(&input.idempotency_key).fetch_optional(state.db.pool()).await
        .map_err(|_| AppError::Internal("Graph publication idempotency lookup failed".into()))? {
        if existing.0 != hex::encode(request_fingerprint) { return Err(AppError::Conflict("Graph publication idempotency key was reused with different input".into())); }
        return Ok(Json(json!({"encryptedDataBase64":existing.1,"encryptedDataDigestHex":existing.2,"encryptionIdHex":existing.3,
            "mediaType":GRAPH_MANIFEST_MEDIA_TYPE,"manifestHashHex":hex::encode(manifest_hash)})));
    }
    let encrypted = crate::mydata::mydata_encrypt(&state.http_client, &state.config.sidecar_url,
        state.config.sidecar_secret.as_deref(), &plaintext, &input.encryption_id,
        &state.config.package_id, 0, None).await?;
    if encrypted.is_empty() || encrypted.len() > 262_144 {
        return Err(AppError::BadRequest("Encrypted GraphManifest exceeds the MyData on-chain listing limit".into()));
    }
    let encrypted_base64 = BASE64.encode(&encrypted);
    let encrypted_digest = hex::encode(Sha256::digest(&encrypted));
    let encryption_id_hex = hex::encode(input.encryption_id.as_bytes());
    let fingerprint_hex = hex::encode(request_fingerprint);
    sqlx::query("INSERT INTO mydata_graph_publication_encryptions (account_id,agent_object_id,idempotency_key,request_hash_hex,encrypted_data_base64,encrypted_data_digest_hex,encryption_id_hex,manifest_hash_hex,publication_tags_hash_hex) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (account_id,agent_object_id,idempotency_key) DO NOTHING")
        .bind(&auth.account_id).bind(&auth.agent_object_id).bind(&input.idempotency_key).bind(&fingerprint_hex).bind(&encrypted_base64).bind(&encrypted_digest).bind(&encryption_id_hex).bind(hex::encode(manifest_hash)).bind(&tags_hash)
        .execute(state.db.pool()).await.map_err(|_| AppError::Internal("Graph publication encryption could not be recorded".into()))?;
    let stored = sqlx::query_as::<_, (String, String, String, String)>(
        "SELECT request_hash_hex, encrypted_data_base64, encrypted_data_digest_hex, encryption_id_hex FROM mydata_graph_publication_encryptions WHERE account_id=$1 AND agent_object_id=$2 AND idempotency_key=$3",
    ).bind(&auth.account_id).bind(&auth.agent_object_id).bind(&input.idempotency_key).fetch_one(state.db.pool()).await
        .map_err(|_| AppError::Internal("Graph publication idempotency record could not be read".into()))?;
    if stored.0 != fingerprint_hex { return Err(AppError::Conflict("Graph publication idempotency key was reused with different input".into())); }
    Ok(Json(json!({"encryptedDataBase64":stored.1,"encryptedDataDigestHex":stored.2,
        "encryptionIdHex":stored.3,"mediaType":GRAPH_MANIFEST_MEDIA_TYPE,"manifestHashHex":hex::encode(manifest_hash)})))
}

/// Read live graph-selling authority from the fullnode for a publication being
/// checked by an authenticated MyData reader.
pub async fn verify_graph_seller(
    State(state): State<Arc<AppState>>,
    Extension(_auth): Extension<AuthInfo>,
    Json(input): Json<VerifyGraphSellerRequest>,
) -> Result<Json<Value>, AppError> {
    if !valid_id(&input.organization_id) || !valid_id(&input.seller_address) {
        return Err(AppError::BadRequest("Invalid graph seller authority request".into()));
    }
    let authority = crate::org_chain::verify_graph_seller_authority(
        &state.http_client,
        &state.config.myso_rpc_url,
        &state.config.package_id,
        &input.organization_id,
        &input.seller_address,
    ).await.map_err(|_| AppError::Internal("Graph seller authority could not be verified".into()))?;
    let (authorized, kind) = match authority {
        Some(crate::org_chain::GraphSellerAuthority::OrganizationAdmin) => (true, Some("organization_admin")),
        Some(crate::org_chain::GraphSellerAuthority::SellGraphDelegate) => (true, Some("sell_graph_delegate")),
        None => (false, None),
    };
    Ok(Json(json!({"organizationId": input.organization_id, "sellerAddress": input.seller_address,
        "authorized": authorized, "kind": kind, "capability": "sell_graph",
        "checkedAtMs": chrono::Utc::now().timestamp_millis(), "source": "configured_fullnode"})))
}
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ContentFormat {
    Utf8,
    Base64,
}

fn valid_id(value: &str) -> bool {
    value.strip_prefix("0x").is_some_and(|hex| {
        !hex.is_empty() && hex.len() <= 64 && hex.bytes().all(|b| b.is_ascii_hexdigit())
    })
}
fn content_page(
    bytes: &[u8],
    format: ContentFormat,
    offset: u32,
    limit: u32,
) -> Result<Value, AppError> {
    if limit == 0 || limit > 8000 || offset > 262144 {
        return Err(AppError::BadRequest("Invalid content page range".into()));
    }
    let (data, total, count, unit) = match format {
        ContentFormat::Utf8 => {
            let text = std::str::from_utf8(bytes).map_err(|_| {
                AppError::BadRequest("This content is binary; request base64 pages".into())
            })?;
            let total = text.chars().count();
            let page: String = text
                .chars()
                .skip(offset as usize)
                .take(limit as usize)
                .collect();
            let count = page.chars().count();
            (page, total, count, "unicode_scalar")
        }
        ContentFormat::Base64 => {
            let start = (offset as usize).min(bytes.len());
            let end = start.saturating_add(limit as usize).min(bytes.len());
            (
                BASE64.encode(&bytes[start..end]),
                bytes.len(),
                end - start,
                "byte",
            )
        }
    };
    if offset as usize > total {
        return Err(AppError::BadRequest(
            "Content page starts after the end".into(),
        ));
    }
    let next = offset as usize + count;
    Ok(
        json!({"data":data,"format":format,"offset":offset,"offsetUnit":unit,"total":total,
        "nextOffset":if next < total {Some(next)} else {None},"hasNext":next < total}),
    )
}

/// Disclosure endpoint: only the caller's current MYDATA session can release keys.
/// Ciphertext is pinned before and after decrypt; no service/owner-key fallback exists.
pub async fn read_content(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Json(input): Json<ReadContentRequest>,
) -> Result<axum::response::Response, AppError> {
    use axum::response::IntoResponse;
    if !state.config.mydata_listing_access_enabled {
        return Err(AppError::Forbidden(
            "Direct MyData access is not enabled for this deployment".into(),
        ));
    }
    if !valid_id(&input.mydata_id)
        || input.encrypted_data_digest_hex.len() != 64
        || !input
            .encrypted_data_digest_hex
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || input.limit == 0
        || input.limit > 8000
        || input.offset > 262144
    {
        return Err(AppError::BadRequest(
            "Invalid named MyData content request".into(),
        ));
    }
    let org_audience = if let Some(org_id) = input.organization_audience_id.as_deref() {
        if !valid_id(org_id) || auth.organization_id.as_deref().map_or(true, |bound| !memory_contract::addresses_equal(bound, org_id)) {
            return Err(AppError::Forbidden("The requested graph audience is not the authenticated agent's organization".into()));
        }
        let group_id = crate::org_chain::org_memory_group_id(&state.config.package_id, org_id)
            .ok_or_else(|| AppError::BadRequest("Invalid organization graph audience".into()))?;
        Some((memory_contract::normalize_object_id(org_id), group_id))
    } else { None };
    let session = auth
        .mydata_session
        .as_deref()
        .ok_or_else(|| AppError::Forbidden("A caller-bound MyData session is required".into()))?;
    let id = crate::memory_contract::normalize_object_id(&input.mydata_id);
    let response = chain_rpc(&state, "myso_getObject", json!([id,{"showContent":true}])).await?;
    let data = response.get("data").ok_or_else(invalid)?;
    let quoted = quote(data, &state.config.package_id, &id, &auth.derived_address)?;
    if quoted
        .pointer("/purchaseParameters/encryptedDataDigestHex")
        .and_then(Value::as_str)
        != Some(&input.encrypted_data_digest_hex)
    {
        return Err(AppError::Conflict(
            "The requested MyData ciphertext version changed".into(),
        ));
    }
    let fields = data
        .pointer("/content/fields")
        .and_then(Value::as_object)
        .ok_or_else(invalid)?;
    let ciphertext = bytes(fields.get("encrypted_data"), 262144)?;
    let mut sidecar_body = json!({"data":BASE64.encode(ciphertext),"packageId":state.config.package_id,
            "accountId":auth.account_id,"callerAddress":auth.derived_address,"mydataId":id,
            "encryptionIdHex":quoted["purchaseParameters"]["encryptionIdHex"],"encryptedDataDigestHex":input.encrypted_data_digest_hex});
    if let Some((organization_id, group_id)) = &org_audience {
        sidecar_body["organizationId"] = json!(organization_id);
        sidecar_body["organizationMemoryGroupId"] = json!(group_id);
    }
    let mut request = state.http_client.post(format!("{}/mydata/decrypt-listing", state.config.sidecar_url.trim_end_matches('/')))
        .timeout(std::time::Duration::from_secs(45)).header("x-mydata-session", session)
        .json(&sidecar_body);
    if let Some(secret) = &state.config.sidecar_secret {
        request = request.bearer_auth(secret);
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| AppError::Internal("MyData content access is unavailable".into()))?;
    match response.status().as_u16() {
        200 => {}
        409 => {
            return Err(AppError::Conflict(
                "MyData data identity or key-server configuration changed".into(),
            ))
        }
        415 => {
            return Err(AppError::BadRequest(
                "Unsupported MyData content encryption".into(),
            ))
        }
        _ => {
            return Err(AppError::Forbidden(
                "MyData content access could not be authorized".into(),
            ))
        }
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| invalid())? {
        if body.len().saturating_add(chunk.len()) > 384 * 1024 {
            body.fill(0);
            return Err(invalid());
        }
        body.extend_from_slice(&chunk);
    }
    let decoded = serde_json::from_slice::<Value>(&body);
    body.fill(0);
    let value = decoded.map_err(|_| invalid())?;
    let mut plaintext = BASE64
        .decode(
            value
                .get("decryptedData")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?,
        )
        .map_err(|_| invalid())?;
    if plaintext.len() > 262144 {
        plaintext.fill(0);
        return Err(invalid());
    }
    let result = content_page(&plaintext, input.format, input.offset, input.limit);
    plaintext.fill(0);
    let mut page = result?;
    // Re-read the listing after key release: an owner update cannot silently turn
    // this response into a different graph/version than the requested ciphertext.
    let current = get_quote(&state, &auth, &id).await?;
    if current.pointer("/purchaseParameters/encryptedDataDigestHex")
        != quoted.pointer("/purchaseParameters/encryptedDataDigestHex")
        || current.pointer("/purchaseParameters/encryptionIdHex")
            != quoted.pointer("/purchaseParameters/encryptionIdHex")
    {
        return Err(AppError::Conflict(
            "The MyData listing changed during the content request".into(),
        ));
    }
    page["mydataId"] = json!(id);
    page["encryptedDataDigestHex"] = json!(input.encrypted_data_digest_hex);
    page["objectVersion"] = quoted["objectVersion"].clone();
    let mut access = json!({"source":"current_key_server_policy","callerAddress":auth.derived_address,
        "accountId":auth.account_id,"agentId":auth.agent_object_id,"network":state.config.myso_network,"sharedDerivedKeyCache":false});
    if let Some((organization_id, _)) = org_audience {
        access["organizationAudienceId"] = json!(organization_id);
    }
    access["purchaseQuote"] = json!({
        "expectedSeller": quoted["purchaseParameters"]["expectedSeller"],
        "mediaType": quoted["mediaType"],
        "tags": quoted["tags"],
        "accessKind": quoted["purchaseParameters"]["accessKind"],
        "priceMist": quoted["purchaseParameters"]["priceMist"],
        "durationDays": quoted["purchaseParameters"]["durationDays"],
    });
    page["access"] = access;
    Ok((
        [
            ("Cache-Control", "no-store"),
            ("X-Content-Type-Options", "nosniff"),
        ],
        Json(page),
    )
        .into_response())
}

/// Check whether the caller's current MyData session can obtain key shares for
/// this exact listing version. This performs a fresh key-server policy check,
/// but deliberately does not decrypt or return listing plaintext.
pub async fn check_current_access(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Json(input): Json<CheckCurrentAccessRequest>,
) -> Result<axum::response::Response, AppError> {
    use axum::response::IntoResponse;
    if !state.config.mydata_listing_access_enabled {
        return Err(AppError::Forbidden("Direct MyData access is not enabled for this deployment".into()));
    }
    if !valid_id(&input.mydata_id)
        || input.encrypted_data_digest_hex.len() != 64
        || !input.encrypted_data_digest_hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err(AppError::BadRequest("Invalid named MyData access request".into()));
    }
    let org_audience = if let Some(org_id) = input.organization_audience_id.as_deref() {
        if !valid_id(org_id) || auth.organization_id.as_deref().map_or(true, |bound| !memory_contract::addresses_equal(bound, org_id)) {
            return Err(AppError::Forbidden("The requested graph audience is not the authenticated agent's organization".into()));
        }
        let group_id = crate::org_chain::org_memory_group_id(&state.config.package_id, org_id)
            .ok_or_else(|| AppError::BadRequest("Invalid organization graph audience".into()))?;
        Some((memory_contract::normalize_object_id(org_id), group_id))
    } else { None };
    let session = auth.mydata_session.as_deref()
        .ok_or_else(|| AppError::Forbidden("A caller-bound MyData session is required".into()))?;
    let id = memory_contract::normalize_object_id(&input.mydata_id);
    let response = chain_rpc(&state, "myso_getObject", json!([id,{"showContent":true}])).await?;
    let data = response.get("data").ok_or_else(invalid)?;
    let quoted = quote(data, &state.config.package_id, &id, &auth.derived_address)?;
    if quoted.pointer("/purchaseParameters/encryptedDataDigestHex").and_then(Value::as_str) != Some(&input.encrypted_data_digest_hex) {
        return Err(AppError::Conflict("The requested MyData ciphertext version changed".into()));
    }
    let fields = data.pointer("/content/fields").and_then(Value::as_object).ok_or_else(invalid)?;
    let ciphertext = bytes(fields.get("encrypted_data"), 262144)?;
    let mut sidecar_body = json!({"data":BASE64.encode(ciphertext),"packageId":state.config.package_id,
        "accountId":auth.account_id,"callerAddress":auth.derived_address,"mydataId":id,
        "encryptionIdHex":quoted["purchaseParameters"]["encryptionIdHex"],"encryptedDataDigestHex":input.encrypted_data_digest_hex});
    if let Some((organization_id, group_id)) = &org_audience {
        sidecar_body["organizationId"] = json!(organization_id);
        sidecar_body["organizationMemoryGroupId"] = json!(group_id);
    }
    let mut request = state.http_client.post(format!("{}/mydata/check-listing-access", state.config.sidecar_url.trim_end_matches('/')))
        .timeout(std::time::Duration::from_secs(45)).header("x-mydata-session", session).json(&sidecar_body);
    if let Some(secret) = &state.config.sidecar_secret { request = request.bearer_auth(secret); }
    let response = request.send().await.map_err(|_| AppError::Internal("MyData access check is unavailable".into()))?;
    match response.status().as_u16() {
        200 => {
            let evidence = response.json::<Value>().await.map_err(|_| invalid())?;
            if evidence.get("authorized") != Some(&json!(true)) || evidence.get("source").and_then(Value::as_str) != Some("current_key_server_policy") {
                return Err(invalid());
            }
        },
        409 => return Err(AppError::Conflict("MyData data identity or key-server configuration changed".into())),
        415 => return Err(AppError::BadRequest("Unsupported MyData content encryption".into())),
        500..=599 => return Err(AppError::Internal("MyData access could not be checked because the key service is unavailable".into())),
        _ => return Err(AppError::Forbidden("Current MyData access could not be authorized".into())),
    }
    let current = get_quote(&state, &auth, &id).await?;
    if current.pointer("/purchaseParameters/encryptedDataDigestHex") != quoted.pointer("/purchaseParameters/encryptedDataDigestHex")
        || current.pointer("/purchaseParameters/encryptionIdHex") != quoted.pointer("/purchaseParameters/encryptionIdHex") {
        return Err(AppError::Conflict("The MyData listing changed during the access check".into()));
    }
    let mut result = json!({"authorized":true,"mydataId":id,"encryptedDataDigestHex":input.encrypted_data_digest_hex,
        "objectVersion":quoted["objectVersion"],"source":"current_key_server_policy","callerAddress":auth.derived_address,
        "accountId":auth.account_id,"agentId":auth.agent_object_id,"network":state.config.myso_network,
        "plaintextReturned":false,"sharedDerivedKeyCache":false});
    if let Some((organization_id, _)) = org_audience { result["organizationAudienceId"] = json!(organization_id); }
    Ok(([ ("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff") ], Json(result)).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn listing() -> Value {
        json!({"objectId":"0x9","version":"9007199254740993","content":{
            "type":"0x50c1::mydata::MyData","fields":{
                "owner":"0xa","platform_id":null,"encrypted_data":[1,2,3],"encryption_id":[9,8],
                "media_type":"application/vnd.mysocial.graph-manifest+json;version=1","tags":["mysograph1.1/1:example"],
                "access":{"variant":"MarketplaceOneTime","fields":{"price":"18446744073709551615"}}
            }
        }})
    }
    #[test]
    fn content_pages_preserve_unicode_boundaries_and_report_units() {
        let first = content_page("A🌿éZ".as_bytes(), ContentFormat::Utf8, 1, 2).unwrap();
        assert_eq!(first["data"], "🌿é");
        assert_eq!(first["total"], 4);
        assert_eq!(first["nextOffset"], 3);
        assert_eq!(first["offsetUnit"], "unicode_scalar");
        let last = content_page("A🌿éZ".as_bytes(), ContentFormat::Utf8, 3, 2).unwrap();
        assert_eq!(last["data"], "Z");
        assert_eq!(last["hasNext"], false);
        assert!(last["nextOffset"].is_null());
    }
    #[test]
    fn binary_pages_count_source_bytes_and_reject_invalid_ranges() {
        let page = content_page(&[0, 255, 128, 1], ContentFormat::Base64, 1, 2).unwrap();
        assert_eq!(page["data"], BASE64.encode([255, 128]));
        assert_eq!(page["offsetUnit"], "byte");
        assert_eq!(page["nextOffset"], 3);
        assert!(content_page(&[255], ContentFormat::Utf8, 0, 1).is_err());
        for (offset, limit) in [(0, 0), (0, 8001), (5, 1), (262145, 1)] {
            assert!(content_page(&[1, 2, 3, 4], ContentFormat::Base64, offset, limit).is_err());
        }
        assert_eq!(
            content_page(&[], ContentFormat::Utf8, 0, 1).unwrap()["hasNext"],
            false
        );
    }
    #[test]
    fn owner_changes_require_the_seller_and_matching_explicit_grant_terms() {
        let data = listing();
        let fields = listing_fields(&data, "0x50c1", "0x9").unwrap();
        let grant = json!({"recipient":"0xb","accessType":0});
        assert!(owner_change_fields(fields, "0xa", "access.share_mydata.v1", &grant).is_ok());
        assert!(owner_change_fields(fields, "0xb", "access.share_mydata.v1", &grant).is_err());
        assert!(owner_change_fields(
            fields,
            "0xa",
            "access.share_mydata.v1",
            &json!({"recipient":"0xb","accessType":1,"subscriptionDays":"30"})
        )
        .is_err());
        assert!(owner_change_fields(
            fields,
            "0xa",
            "access.share_mydata.v1",
            &json!({"recipient":"0xa","accessType":0})
        )
        .is_err());
        assert!(owner_change_fields(
            fields,
            "0xa",
            "access.revoke_mydata_share.v1",
            &json!({"recipient":"0xb","accessType":2})
        )
        .is_ok());
    }
    #[test]
    fn owner_event_parser_rejects_lookalike_namespaces_and_preserves_u64_time() {
        let event = json!({"type":"0x50c1::mydata::AccessGrantedEvent","parsedJson":{"ip_id":"0x9","user":"0xb","granted_by":"0xa","access_type":"subscription","timestamp":"18446744073709551615"}});
        let parsed = owner_access_event(&event, "0x50c1", "access.share_mydata.v1", "0xa")
            .unwrap()
            .unwrap();
        assert_eq!(parsed["timestampMs"], "18446744073709551615");
        assert!(
            owner_access_event(&event, "0xbad", "access.share_mydata.v1", "0xa")
                .unwrap()
                .is_none()
        );
        assert!(
            owner_access_event(&event, "0x50c1", "access.share_mydata.v1", "0xb")
                .unwrap()
                .is_none()
        );
        assert!(
            owner_access_event(&event, "0x50c1", "access.revoke_mydata_share.v1", "0xa")
                .unwrap()
                .is_none()
        );
        let mut wrong = event.clone();
        wrong["type"] = json!("0x50c1::mydata::AccessGrantedEvent::lookalike");
        assert!(
            owner_access_event(&wrong, "0x50c1", "access.share_mydata.v1", "0xa")
                .unwrap()
                .is_none()
        );
    }
    #[test]
    fn quote_keeps_chain_money_and_version_exact() {
        let result = quote(&listing(), "0x50c1", "0x9", "0xb").unwrap();
        assert_eq!(
            result["purchaseParameters"]["priceMist"],
            "18446744073709551615"
        );
        assert_eq!(result["objectVersion"], "9007199254740993");
        assert_eq!(result["purchaseParameters"]["durationDays"], "0");
        assert!(result["purchaseParameters"]
            .get("expectedListingPlatformId")
            .is_none());
        assert!(result.get("encrypted_data").is_none());
    }
    #[test]
    fn quote_rejects_lookalike_types_and_another_object() {
        assert!(quote(&listing(), "0xbad", "0x9", "0xb").is_err());
        assert!(quote(&listing(), "0x50c1", "0x8", "0xb").is_err());
    }
    #[test]
    fn recurring_terms_use_the_actual_period_without_a_new_app_limit() {
        let mut data = listing();
        data["content"]["fields"]["access"] = json!({"variant":"MarketplaceRecurring","fields":{"price":"9007199254740993","duration_days":"730"}});
        let result = quote(&data, "0x50c1", "0x9", "0xb").unwrap();
        assert_eq!(result["purchaseParameters"]["accessKind"], 3);
        assert_eq!(result["purchaseParameters"]["durationDays"], "730");
        data["content"]["fields"]["access"]["fields"]["duration_days"] = json!("0");
        assert!(quote(&data, "0x50c1", "0x9", "0xb").is_err());
    }
}

/// Owner-wallet actions use existing native owner rights. Buyers cannot reshare.
/// Resolve the current listing before asking for an exact-input owner signature.
pub async fn validate_owner_change(
    state: &AppState,
    auth: &AuthInfo,
    action: &str,
    parameters: &Value,
) -> Result<(), AppError> {
    if !matches!(
        action,
        "access.share_mydata.v1" | "access.revoke_mydata_share.v1"
    ) {
        return Ok(());
    }
    let id = parameters
        .get("mydataId")
        .and_then(Value::as_str)
        .filter(|id| valid_id(id))
        .ok_or_else(|| AppError::BadRequest("Invalid MyData listing ID".into()))?;
    let normalized = crate::memory_contract::normalize_object_id(id);
    let response = chain_rpc(
        state,
        "myso_getObject",
        json!([normalized,{"showContent":true}]),
    )
    .await?;
    let fields = listing_fields(
        response.get("data").ok_or_else(invalid)?,
        &state.config.package_id,
        &normalized,
    )?;
    owner_change_fields(fields, &auth.owner, action, parameters)
}
fn owner_change_fields(
    fields: &Map<String, Value>,
    expected_owner: &str,
    action: &str,
    parameters: &Value,
) -> Result<(), AppError> {
    let input = parameters
        .as_object()
        .ok_or_else(|| AppError::BadRequest("Access change parameters must be an object".into()))?;
    let allowed: &[&str] = if action == "access.share_mydata.v1" {
        &["mydataId", "recipient", "accessType", "subscriptionDays"]
    } else {
        &["mydataId", "recipient", "accessType"]
    };
    if input.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(AppError::BadRequest(
            "Unexpected access change parameter".into(),
        ));
    }
    if action == "access.share_mydata.v1"
        && parameters.get("accessType").and_then(Value::as_u64) == Some(1)
        && !parameters
            .get("subscriptionDays")
            .is_some_and(Value::is_string)
    {
        return Err(AppError::BadRequest(
            "An exact decimal-string subscription day count is required".into(),
        ));
    }
    let recipient = address(parameters.get("recipient"))
        .map_err(|_| AppError::BadRequest("Invalid access recipient".into()))?;
    let owner = address(fields.get("owner"))?;
    let listing_kind = match fields
        .get("access")
        .and_then(|value| value.get("variant"))
        .and_then(Value::as_str)
    {
        Some("MarketplaceOneTime") => 0,
        Some("MarketplaceRecurring") => 1,
        _ => {
            return Err(AppError::BadRequest(
                "Owner access changes require a direct one-time or recurring listing".into(),
            ))
        }
    };
    if !crate::memory_contract::addresses_equal(&owner, expected_owner) {
        return Err(AppError::Forbidden(
            "Only the listing owner can grant or revoke access".into(),
        ));
    }
    if crate::memory_contract::addresses_equal(&recipient, &owner) {
        return Err(AppError::BadRequest(
            "The listing owner cannot be an access recipient".into(),
        ));
    }
    let kind = parameters
        .get("accessType")
        .and_then(Value::as_u64)
        .ok_or_else(|| AppError::BadRequest("Invalid access type".into()))?;
    if action == "access.share_mydata.v1" {
        if kind > 1 || listing_kind != kind {
            return Err(AppError::BadRequest(
                "Grant type does not match the current listing".into(),
            ));
        }
        if kind == 0 && parameters.get("subscriptionDays").is_some() {
            return Err(AppError::BadRequest(
                "One-time grants have no subscription period".into(),
            ));
        }
        if kind == 1
            && u64_field(parameters.get("subscriptionDays")).map_err(|_| {
                AppError::BadRequest("An exact subscription day count is required".into())
            })? == 0
        {
            return Err(AppError::BadRequest(
                "Subscription period must be positive".into(),
            ));
        }
    } else if kind > 2 {
        return Err(AppError::BadRequest("Invalid revocation type".into()));
    }
    Ok(())
}

pub async fn get_owner_receipt(
    state: &AppState,
    auth: &AuthInfo,
    digest: &str,
) -> Result<Value, AppError> {
    if !(43..=44).contains(&digest.len())
        || !digest
            .bytes()
            .all(|b| b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".contains(&b))
    {
        return Err(AppError::BadRequest("Invalid transaction digest".into()));
    }
    let row=sqlx::query_as::<_,(String,String,String)>("SELECT registry_action,sender,package_id FROM chain_action_requests WHERE account_id=$1 AND agent_object_id=$2 AND digest=$3 AND registry_action IN ('access.share_mydata.v1','access.revoke_mydata_share.v1') LIMIT 1")
        .bind(&auth.account_id).bind(&auth.agent_object_id).bind(digest).fetch_optional(state.db.pool()).await.map_err(|_|invalid())?
        .ok_or_else(||AppError::BlobNotFound("Owner access transaction unavailable in this agent scope".into()))?;
    if !crate::memory_contract::addresses_equal(&row.2, &state.config.package_id) {
        return Err(AppError::BlobNotFound(
            "Owner access transaction is outside this deployment".into(),
        ));
    }
    let result = chain_rpc(
        state,
        "myso_getTransactionBlock",
        json!([digest,{"showEffects":true,"showEvents":true}]),
    )
    .await?;
    if result.get("digest").and_then(Value::as_str) != Some(digest) {
        return Err(invalid());
    }
    let checkpoint = result
        .get("checkpoint")
        .filter(|v| !v.is_null())
        .map(|v| u64_field(Some(v)))
        .transpose()?;
    let status = match result
        .pointer("/effects/status/status")
        .and_then(Value::as_str)
    {
        Some("success") if checkpoint.is_some() => "finalized",
        Some("success") => "executed",
        Some("failure") => "failed",
        _ => "unknown",
    };
    let mut events = Vec::new();
    if status == "finalized" || status == "executed" {
        for event in result
            .get("events")
            .and_then(Value::as_array)
            .ok_or_else(invalid)?
        {
            if let Some(parsed) =
                owner_access_event(event, &state.config.package_id, &row.0, &row.1)?
            {
                events.push(parsed);
            }
        }
    }
    Ok(
        json!({"digest":digest,"registryAction":row.0,"accountId":auth.account_id,"agentId":auth.agent_object_id,"status":status,"checkpoint":checkpoint.map(|v|v.to_string()),"events":events,"evidenceSource":"configured_fullnode","currentAccess":"not_checked","previouslyDisclosedDataErased":false}),
    )
}

/// Recover owner-approved share/revoke operations for this authenticated account/agent.
/// The journal supplies candidate digests; each digest is independently checked through
/// `get_owner_receipt` against the configured fullnode before it is returned.
pub async fn list_owner_access_history(
    state: &AppState,
    auth: &AuthInfo,
    limit: u32,
    offset: u32,
) -> Result<Value, AppError> {
    let limit = limit.clamp(1, 50);
    let offset = offset.min(100_000);
    let rows = sqlx::query_as::<_, (String, String, Option<String>, String)>(
        "SELECT registry_action, status, digest, created_at::text FROM chain_action_requests \
         WHERE account_id=$1 AND agent_object_id=$2 \
           AND registry_action IN ('access.share_mydata.v1','access.revoke_mydata_share.v1') \
         ORDER BY created_at DESC, idempotency_scope DESC LIMIT $3 OFFSET $4",
    )
    .bind(&auth.account_id)
    .bind(&auth.agent_object_id)
    .bind(i64::from(limit) + 1)
    .bind(i64::from(offset))
    .fetch_all(state.db.pool())
    .await
    .map_err(|_| invalid())?;
    let has_more = rows.len() > limit as usize;
    let mut entries = Vec::with_capacity(rows.len().min(limit as usize));
    for (registry_action, action_status, digest, created_at) in rows.into_iter().take(limit as usize) {
        let receipt = if let Some(digest) = digest.as_deref() {
            Some(get_owner_receipt(state, auth, digest).await?)
        } else {
            None
        };
        entries.push(json!({
            "registryAction": registry_action,
            "actionStatus": action_status,
            "digest": digest,
            "createdAt": created_at,
            "chainReceipt": receipt,
        }));
    }
    Ok(json!({
        "accountId": auth.account_id,
        "agentId": auth.agent_object_id,
        "ownerAddress": auth.owner,
        "agentAddress": auth.derived_address,
        "entries": entries,
        "limit": limit,
        "offset": offset,
        "hasMore": has_more,
        "evidenceSource": "authenticated_action_journal_and_configured_fullnode",
        "notice": "Only owner grant/revoke operations recorded under this account and agent are listed. A receipt proves its event and finality, not current key access or erasure of data already fetched."
    }))
}

fn owner_access_event(
    event: &Value,
    package: &str,
    action: &str,
    expected_owner: &str,
) -> Result<Option<Value>, AppError> {
    let (expected, actor) = match action {
        "access.share_mydata.v1" => ("AccessGrantedEvent", "granted_by"),
        "access.revoke_mydata_share.v1" => ("AccessRevokedEvent", "revoked_by"),
        _ => return Ok(None),
    };
    let mut parts = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .split("::");
    if !crate::memory_contract::addresses_equal(parts.next().unwrap_or_default(), package)
        || parts.next() != Some("mydata")
        || parts.next() != Some(expected)
        || parts.next().is_some()
    {
        return Ok(None);
    }
    let parsed = event.get("parsedJson").ok_or_else(invalid)?;
    let owner = address(parsed.get(actor))?;
    if !crate::memory_contract::addresses_equal(&owner, expected_owner) {
        return Ok(None);
    }
    let access = parsed
        .get("access_type")
        .and_then(Value::as_str)
        .filter(|kind| matches!(*kind, "one_time" | "subscription" | "all"))
        .ok_or_else(invalid)?;
    if expected == "AccessGrantedEvent" && access == "all" {
        return Err(invalid());
    }
    Ok(Some(
        json!({"kind":expected,"mydataId":address(parsed.get("ip_id"))?,"recipient":address(parsed.get("user"))?,"owner":owner,"accessType":access,"timestampMs":u64_field(parsed.get("timestamp"))?.to_string()}),
    ))
}
