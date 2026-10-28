//! Authenticated MCP orchestration for identity-verified beneficiary transfers.
//! The browser/MCP caller never supplies the wallet or network authority: both
//! are taken from the verified MySo agent session.
use axum::{extract::State, Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

use crate::types::{AppError, AppState, AuthInfo};

const FEATURE_ACTION: &str = "poc.beneficiary_transfer.v1";

#[derive(Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum TransferRequest {
    Start { identity_hash: String, beneficiary_id: String },
    Status { identity_hash: String, beneficiary_id: String },
    Propose { identity_hash: String, beneficiary_id: String, recipient_address: String },
    Job { identity_hash: String, job_id: String },
    ProposalReceipt { identity_hash: String, beneficiary_id: String, recipient_address: String, job_id: String },
}

pub fn configured(config: &crate::types::Config) -> bool {
    if !config.poc_beneficiary_transfer_enabled
        || !config.poc_oracle_service_key.as_deref().is_some_and(|key| key.as_bytes().len() >= 32)
        || config.social_chain.poc_config_id.is_empty()
        || !config.social_chain.is_configured()
    { return false; }
    let Some(raw) = config.poc_oracle_url.as_deref() else { return false; };
    let Ok(url) = reqwest::Url::parse(raw) else { return false; };
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    url.username().is_empty() && url.password().is_none() && url.query().is_none() && url.fragment().is_none()
        && (url.scheme() == "https" || (url.scheme() == "http" && loopback))
}

fn validate_identity_hash(value: &str) -> Result<String, AppError> {
    let text = value.trim();
    let Some(hex) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) else {
        return Err(AppError::BadRequest("identityHash must be 0x-prefixed hexadecimal".into()));
    };
    if !(2..=64).contains(&hex.len()) || hex.len() % 2 != 0 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::BadRequest("identityHash must contain 1 to 32 bytes of hexadecimal".into()));
    }
    Ok(format!("0x{}", hex.to_ascii_lowercase()))
}

fn query_url(base: &str, path: &str, pairs: &[(&str, &str)]) -> String {
    let mut url = reqwest::Url::parse(&format!("{}{}", base.trim_end_matches('/'), path))
        .expect("poc_transfer::configured validates the URL before request construction");
    url.query_pairs_mut().extend_pairs(pairs);
    url.to_string()
}

fn event_bytes(value: Option<&Value>) -> Option<Vec<u8>> {
    match value? {
        Value::Array(items) => items.iter().map(|item| item.as_u64().filter(|v| *v <= 255).map(|v| v as u8)).collect(),
        Value::String(text) => {
            let hex = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X"))?;
            if hex.len() % 2 != 0 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) { return None; }
            hex::decode(hex).ok()
        }
        _ => None,
    }
}

async fn verify_proposal_receipt(
    state: &AppState,
    digest: &str,
    identity_hash: &str,
    beneficiary_id: &str,
    recipient: &str,
) -> Result<Value, AppError> {
    crate::chain_reads::digest_bytes(digest).map_err(|_| AppError::Internal("PoC oracle returned an invalid transaction digest".into()))?;
    let identity_hex = identity_hash.trim_start_matches("0x").trim_start_matches("0X");
    let identity = hex::decode(identity_hex).map_err(|_| AppError::BadRequest("Invalid identityHash".into()))?;
    let beneficiary = crate::chain_reads::id(beneficiary_id)?;
    let recipient = crate::chain_reads::id(recipient)?;
    let config_id = &state.config.social_chain.poc_config_id;
    let config = crate::chain_reads::object(state, config_id).await?;
    let expected_config_type = crate::chain_reads::coin_type(&format!("{}::proof_of_creativity::PoCConfig", state.config.package_id))?;
    let actual_config_type = config.pointer("/content/type").and_then(Value::as_str).ok_or_else(|| AppError::Internal("Configured PoC oracle config type is unavailable".into()))?;
    if crate::chain_reads::coin_type(actual_config_type)? != expected_config_type { return Err(AppError::Conflict("Configured PoC object is not the expected PoCConfig".into())); }
    let oracle = config.pointer("/content/fields/oracle_address").and_then(Value::as_str).ok_or_else(|| AppError::Internal("Configured PoC oracle authority is unavailable".into()))?;
    let transaction = crate::chain_reads::rpc(state, "myso_getTransactionBlock", json!([digest,{"showInput":true,"showEffects":true,"showEvents":true}])).await?;
    if transaction.get("digest").and_then(Value::as_str) != Some(digest) { return Err(AppError::Internal("PoC fullnode returned a different transaction digest".into())); }
    let sender = transaction.pointer("/transaction/data/sender").or_else(|| transaction.pointer("/transaction/sender")).and_then(Value::as_str).ok_or_else(|| AppError::Internal("PoC proposal sender is unavailable".into()))?;
    if !crate::chain_reads::same(sender, oracle) { return Err(AppError::Conflict("Proposal transaction was not submitted by the configured PoC oracle".into())); }
    let status = transaction.pointer("/effects/status/status").and_then(Value::as_str);
    let checkpoint = transaction.get("checkpoint").filter(|value| !value.is_null());
    let finalized = status == Some("success") && checkpoint.is_some();
    let expected_event = crate::chain_reads::coin_type(&format!("{}::proof_of_creativity::UsernameBeneficiaryTransferProposedEvent", state.config.package_id))?;
    let events = transaction.get("events").and_then(Value::as_array).ok_or_else(|| AppError::Internal("PoC proposal events are unavailable".into()))?;
    let matching: Vec<&Value> = events.iter().filter(|event| {
        let Some(event_type) = event.get("type").and_then(Value::as_str) else { return false; };
        if crate::chain_reads::coin_type(event_type).ok().as_deref() != Some(expected_event.as_str()) { return false; }
        let Some(data) = event.get("parsedJson") else { return false; };
        let identity_matches = event_bytes(data.get("identity_hash")).is_some_and(|value| value == identity);
        let evidence_valid = event_bytes(data.get("evidence_hash")).is_some_and(|value| value.len() == 32);
        identity_matches && evidence_valid
            && data.get("beneficiary_id").and_then(Value::as_str).is_some_and(|v| crate::chain_reads::same(v, &beneficiary))
            && data.get("recipient").and_then(Value::as_str).is_some_and(|v| crate::chain_reads::same(v, &recipient))
            && data.get("proposed_by").and_then(Value::as_str).is_some_and(|v| crate::chain_reads::same(v, oracle))
            && data.get("identity_source").and_then(Value::as_u64) == Some(1)
    }).collect();
    if finalized && matching.len() != 1 { return Err(AppError::Conflict("Unique identity-bound PoC beneficiary proposal event could not be verified".into())); }
    let mut result = json!({
        "digest": digest,
        "status": match status { Some("success") if finalized => "finalized", Some("success") => "checkpoint_pending", Some("failure") => "failed", _ => "unknown" },
        "checkpoint": checkpoint.map(Value::to_string),
        "identityHash": format!("0x{}", hex::encode(identity)),
        "beneficiaryId": beneficiary,
        "recipient": recipient,
        "proposal": matching.first().and_then(|event| event.get("parsedJson")),
        "proposalEventType": matching.first().and_then(|event| event.get("type")),
        "evidenceSource": "configured_fullnode_and_scoped_oracle_job"
    });
    crate::platform_reads::decimal_quantities(&mut result);
    Ok(result)
}

async fn oracle_request(
    state: &AppState,
    method: reqwest::Method,
    path: &str,
    pairs: &[(&str, &str)],
    body: Option<Value>,
) -> Result<Value, AppError> {
    if !configured(&state.config) { return Err(AppError::Forbidden("PoC beneficiary transfer is not configured for this deployment".into())); }
    let base = state.config.poc_oracle_url.as_deref().ok_or_else(|| AppError::Forbidden("PoC oracle is not configured".into()))?;
    let key = state.config.poc_oracle_service_key.as_deref().ok_or_else(|| AppError::Forbidden("PoC oracle service credential is not configured".into()))?;
    let url = query_url(base, path, pairs);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|_| AppError::Internal("PoC oracle HTTP client could not be configured".into()))?;
    let mut request = client.request(method, url).header("x-myso-poc-service-key", key).header("accept", "application/json");
    if let Some(body) = body { request = request.json(&body); }
    let mut response = request.send().await.map_err(|_| AppError::Internal("PoC identity service is unavailable".into()))?;
    let status = response.status();
    if response.content_length().is_some_and(|length| length > 32 * 1024) {
        return Err(AppError::Internal("PoC identity service response exceeded its size limit".into()));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| AppError::Internal("PoC identity service response could not be read".into()))? {
        if bytes.len().saturating_add(chunk.len()) > 32 * 1024 { return Err(AppError::Internal("PoC identity service response exceeded its size limit".into())); }
        bytes.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        return Err(match status.as_u16() {
            400 | 422 => AppError::BadRequest("PoC identity verification rejected the transfer request".into()),
            401 | 403 => AppError::Forbidden("PoC identity verification could not authorize this wallet".into()),
            404 => AppError::BlobNotFound("PoC transfer job was not found in this identity and wallet scope".into()),
            503 => AppError::Forbidden("PoC identity verification is not configured".into()),
            _ => AppError::Internal("PoC identity service could not complete the request".into()),
        });
    }
    serde_json::from_slice(&bytes).map_err(|_| AppError::Internal("PoC identity service returned invalid JSON".into()))
}

pub async fn handle(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Json(request): Json<TransferRequest>,
) -> Result<Json<Value>, AppError> {
    if auth.capabilities & crate::memory_contract::CAP_TRADE_EXECUTE == 0 {
        return Err(AppError::Forbidden("Trade capability is required for beneficiary transfer workflows".into()));
    }
    if !configured(&state.config) { return Err(AppError::Forbidden("PoC beneficiary transfer is not configured for this deployment".into())); }
    let network = state.config.myso_network.as_str();
    if !matches!(network, "mainnet" | "testnet" | "devnet" | "localnet") { return Err(AppError::Internal("Configured MySo network is unsupported for PoC identity verification".into())); }
    let owner = crate::chain_reads::id(&auth.owner)?;
    let result = match request {
        TransferRequest::Start { identity_hash, beneficiary_id } => {
            let identity = validate_identity_hash(&identity_hash)?;
            let beneficiary = crate::chain_reads::id(&beneficiary_id).map_err(|_| AppError::BadRequest("Invalid beneficiaryId".into()))?;
            let result = oracle_request(&state, reqwest::Method::POST, &format!("/oracle/beneficiaries/{identity}/transfer/oauth/start"), &[("network", network)], Some(json!({"claimant_address":owner,"beneficiary_id":beneficiary}))).await?;
            let authorize_url = result.get("authorize_url").and_then(Value::as_str).ok_or_else(|| AppError::Internal("Identity provider did not return an authorization URL".into()))?;
            let parsed = reqwest::Url::parse(authorize_url).map_err(|_| AppError::Internal("Identity provider returned an invalid authorization URL".into()))?;
            if parsed.scheme() != "https" || parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() {
                return Err(AppError::Internal("Identity provider returned an unsafe authorization URL".into()));
            }
            result
        }
        TransferRequest::Status { identity_hash, beneficiary_id } => {
            let identity = validate_identity_hash(&identity_hash)?;
            let beneficiary = crate::chain_reads::id(&beneficiary_id).map_err(|_| AppError::BadRequest("Invalid beneficiaryId".into()))?;
            let mut result = oracle_request(&state, reqwest::Method::GET, &format!("/oracle/beneficiaries/{identity}/transfer/status"), &[("claimant_address", &owner), ("beneficiary_id", &beneficiary), ("network", network)], None).await?;
            if result.get("beneficiary_id").and_then(Value::as_str).is_some_and(|v| !crate::chain_reads::same(v, &beneficiary)) {
                result["oauth_required"] = json!(true);
                result["oauth_complete"] = json!(false);
                result["attested_x_handle"] = Value::Null;
            }
            result
        }
        TransferRequest::Propose { identity_hash, beneficiary_id, recipient_address } => {
            let identity = validate_identity_hash(&identity_hash)?;
            let beneficiary = crate::chain_reads::id(&beneficiary_id).map_err(|_| AppError::BadRequest("Invalid beneficiaryId".into()))?;
            let recipient = crate::chain_reads::id(&recipient_address).map_err(|_| AppError::BadRequest("Invalid recipientAddress".into()))?;
            oracle_request(&state, reqwest::Method::POST, &format!("/oracle/beneficiaries/{identity}/transfer-proposal"), &[("network", network)], Some(json!({"verified_wallet":owner,"recipient_address":recipient,"beneficiary_id":beneficiary}))).await?
        }
        TransferRequest::Job { identity_hash, job_id } => {
            let identity = validate_identity_hash(&identity_hash)?;
            let job = uuid::Uuid::parse_str(&job_id).map_err(|_| AppError::BadRequest("Invalid jobId".into()))?;
            oracle_request(&state, reqwest::Method::GET, &format!("/oracle/beneficiary-transfer-jobs/{job}"), &[("identity_hash", &identity), ("verified_wallet", &owner)], None).await?
        }
        TransferRequest::ProposalReceipt { identity_hash, beneficiary_id, recipient_address, job_id } => {
            let identity = validate_identity_hash(&identity_hash)?;
            let beneficiary = crate::chain_reads::id(&beneficiary_id).map_err(|_| AppError::BadRequest("Invalid beneficiaryId".into()))?;
            let recipient = crate::chain_reads::id(&recipient_address).map_err(|_| AppError::BadRequest("Invalid recipientAddress".into()))?;
            let job = uuid::Uuid::parse_str(&job_id).map_err(|_| AppError::BadRequest("Invalid jobId".into()))?;
            let job_result = oracle_request(&state, reqwest::Method::GET, &format!("/oracle/beneficiary-transfer-jobs/{job}"), &[("identity_hash", &identity), ("verified_wallet", &owner)], None).await?;
            match job_result.get("status").and_then(Value::as_str) {
                Some("failed") => json!({"status":"failed","identityHash":identity,"beneficiaryId":beneficiary,"recipient":recipient,"error":"PoC oracle could not submit the proposal"}),
                Some("completed") => {
                    let digest = job_result.get("tx_digest").and_then(Value::as_str).ok_or_else(|| AppError::Conflict("Completed PoC proposal job has no transaction digest".into()))?;
                    verify_proposal_receipt(&state, digest, &identity, &beneficiary, &recipient).await?
                }
                _ => json!({"status":"queued","jobId":job.to_string(),"identityHash":identity,"beneficiaryId":beneficiary,"recipient":recipient}),
            }
        }
    };
    Ok(Json(result))
}

pub fn feature_action() -> &'static str { FEATURE_ACTION }
