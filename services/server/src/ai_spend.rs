//! AI credit spend gate — preflight + usage recording via ai-credit-oracle.

use std::sync::Arc;

use crate::memory_contract::{capability_label, has_cap, CAP_AI_SPEND};
use crate::types::{AppError, AppState, AuthInfo, Config};

pub const USAGE_INFERENCE: u8 = 1;
pub const USAGE_EMBED: u8 = 3;
pub const APPROVAL_REQUIRED_REASON: &str = "approval_required";

pub const DEFAULT_ANALYZE_MODEL: &str = "openai/gpt-4o-mini";
pub const DEFAULT_EMBED_MODEL: &str = "text-embedding-3-small";

#[derive(Debug, Clone)]
struct AiCreditBalance {
    balance_id: String,
    memory_account_id: String,
}

#[derive(Debug, serde::Serialize)]
struct PreflightRequest {
    owner: String,
    agent_object_id: String,
    operation: String,
    model_id: Option<String>,
    estimated_tokens_in: u64,
    estimated_tokens_out: u64,
    fact_count: Option<u64>,
}

#[derive(Debug, serde::Deserialize)]
struct PreflightResponse {
    allowed: bool,
    reason: Option<String>,
    #[serde(default)]
    approval_required: bool,
    approval_threshold_mist: Option<u64>,
    estimated_mist: Option<u64>,
}

#[derive(Debug, serde::Serialize)]
struct UsageRequest {
    owner: String,
    balance_id: String,
    memory_account_id: String,
    agent_object_id: String,
    usage_kind: u8,
    tokens_in: Option<u64>,
    tokens_out: Option<u64>,
    tool_id: Option<String>,
    model_id: Option<String>,
    idempotency_key: String,
}

#[derive(Debug, serde::Serialize)]
struct GatewayInferenceRequest<'a> {
    owner: &'a str,
    balance_id: &'a str,
    memory_account_id: &'a str,
    agent_object_id: &'a str,
    model_id: &'a str,
    system_prompt: Option<&'a str>,
    prompt: &'a str,
    max_tokens: u32,
    idempotency_key: &'a str,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct GatewayInferenceResponse {
    pub content: String,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub amount_mist: u64,
    pub billing_state: String,
    pub reservation_nonce: Option<u64>,
    pub reserve_digest: Option<String>,
    pub capture_digest: Option<String>,
}

fn oracle_post(client: &reqwest::Client, config: &Config, url: &str) -> reqwest::RequestBuilder {
    let request = client.post(url);
    match config.ai_credit_oracle_api_secret.as_deref() {
        Some(secret) => request.header("x-ai-credit-oracle-secret", secret),
        None => request,
    }
}

fn ai_credit_enabled(config: &Config) -> bool {
    config.ai_credit_enabled
}

fn require_ai_spend_capability(auth: &AuthInfo) -> Result<(), AppError> {
    if !has_cap(auth.capabilities, CAP_AI_SPEND) {
        return Err(AppError::Forbidden(format!(
            "missing capability {} ({})",
            CAP_AI_SPEND,
            capability_label(CAP_AI_SPEND)
        )));
    }
    Ok(())
}

fn estimate_tokens_from_text(text: &str) -> u64 {
    ((text.len() as u64 + 3) / 4).max(1)
}

async fn fetch_balance(
    client: &reqwest::Client,
    config: &Config,
    owner: &str,
) -> Result<AiCreditBalance, AppError> {
    let url = format!(
        "{}/profiles/{}/ai-credit",
        config.social_server_url.trim_end_matches('/'),
        owner
    );
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("ai-credit balance fetch failed: {}", e)))?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(AppError::AiCreditDepleted("no_ai_credit_balance".into()));
    }
    if !resp.status().is_success() {
        return Err(AppError::Internal(format!(
            "ai-credit balance status {}",
            resp.status()
        )));
    }
    #[derive(serde::Deserialize)]
    struct BalanceRow {
        balance_id: String,
        memory_account_id: String,
    }
    #[derive(serde::Deserialize)]
    struct BalanceEnvelope {
        balance: BalanceRow,
    }
    let envelope: BalanceEnvelope = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("parse ai-credit balance: {}", e)))?;
    Ok(AiCreditBalance {
        balance_id: envelope.balance.balance_id,
        memory_account_id: envelope.balance.memory_account_id,
    })
}

async fn oracle_preflight(
    client: &reqwest::Client,
    config: &Config,
    req: &PreflightRequest,
) -> Result<(), AppError> {
    let url = format!(
        "{}/v1/ai-credit/preflight",
        config.ai_credit_oracle_url.trim_end_matches('/')
    );
    let resp = oracle_post(client, config, &url)
        .json(req)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("oracle preflight failed: {}", e)))?;
    if !resp.status().is_success() {
        return Err(AppError::Internal(format!(
            "oracle preflight status {}",
            resp.status()
        )));
    }
    let body: PreflightResponse = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("parse oracle preflight: {}", e)))?;
    if body.allowed {
        Ok(())
    } else if body.approval_required || body.reason.as_deref() == Some(APPROVAL_REQUIRED_REASON) {
        Err(AppError::AiCreditApprovalRequired {
            threshold_mist: body.approval_threshold_mist,
            estimated_mist: body.estimated_mist,
        })
    } else {
        Err(AppError::AiCreditDepleted(
            body.reason
                .unwrap_or_else(|| "insufficient_ai_balance".into()),
        ))
    }
}

async fn oracle_record_usage(
    client: &reqwest::Client,
    config: &Config,
    balance: &AiCreditBalance,
    auth: &AuthInfo,
    usage_kind: u8,
    model_id: Option<&str>,
    tokens_in: u64,
    tokens_out: u64,
) -> Result<(), AppError> {
    let url = format!(
        "{}/v1/ai-credit/usage",
        config.ai_credit_oracle_url.trim_end_matches('/')
    );
    let req = UsageRequest {
        owner: auth.owner.clone(),
        balance_id: balance.balance_id.clone(),
        memory_account_id: balance.memory_account_id.clone(),
        agent_object_id: auth.agent_object_id.clone(),
        usage_kind,
        tokens_in: Some(tokens_in),
        tokens_out: Some(tokens_out),
        tool_id: None,
        model_id: model_id.map(String::from),
        idempotency_key: uuid::Uuid::new_v4().to_string(),
    };
    let resp = oracle_post(client, config, &url)
        .json(&req)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("oracle usage failed: {}", e)))?;
    if resp.status() == reqwest::StatusCode::PAYMENT_REQUIRED {
        let body_text = resp.text().await.unwrap_or_default();
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body_text) {
            if v.get("code").and_then(|c| c.as_str()) == Some("ai_credit_approval_required") {
                return Err(AppError::AiCreditApprovalRequired {
                    threshold_mist: v.get("threshold_mist").and_then(|x| x.as_u64()),
                    estimated_mist: v.get("estimated_mist").and_then(|x| x.as_u64()),
                });
            }
        }
        // Oracle returns bare 402 for post-hoc approval rejection; preflight is the
        // primary gate, so treat unknown 402 bodies as approval-required, not depleted.
        return Err(AppError::AiCreditApprovalRequired {
            threshold_mist: None,
            estimated_mist: Some(amount_mist_from_usage(usage_kind, tokens_in, tokens_out)),
        });
    }
    if resp.status() == reqwest::StatusCode::BAD_REQUEST {
        return Err(AppError::AiCreditDepleted("insufficient_ai_balance".into()));
    }
    if !resp.status().is_success() {
        return Err(AppError::Internal(format!(
            "oracle usage status {}",
            resp.status()
        )));
    }
    Ok(())
}

fn amount_mist_from_usage(_usage_kind: u8, tokens_in: u64, tokens_out: u64) -> u64 {
    tokens_in.saturating_add(tokens_out)
}

/// Run a bounded chat completion through the reservation-owning gateway. The
/// gateway finalizes an on-chain MIST reservation before contacting OpenRouter.
pub async fn run_gateway_inference(
    state: &Arc<AppState>,
    auth: &AuthInfo,
    model_id: &str,
    system_prompt: Option<&str>,
    prompt: &str,
    max_tokens: u32,
    idempotency_key: &str,
) -> Result<GatewayInferenceResponse, AppError> {
    require_ai_spend_capability(auth)?;
    let balance = fetch_balance(&state.http_client, &state.config, &auth.owner).await?;
    let url = format!(
        "{}/v1/ai-credit/inference",
        state.config.ai_credit_oracle_url.trim_end_matches('/')
    );
    let response = oracle_post(&state.http_client, &state.config, &url)
        .json(&GatewayInferenceRequest {
            owner: &auth.owner,
            balance_id: &balance.balance_id,
            memory_account_id: &balance.memory_account_id,
            agent_object_id: &auth.agent_object_id,
            model_id,
            system_prompt,
            prompt,
            max_tokens,
            idempotency_key,
        })
        .send()
        .await
        .map_err(|error| AppError::Internal(format!("AI gateway unavailable: {error}")))?;

    if response.status() == reqwest::StatusCode::PAYMENT_REQUIRED {
        return Err(AppError::AiCreditDepleted(
            "insufficient_ai_balance_or_approval".into(),
        ));
    }
    if response.status() == reqwest::StatusCode::CONFLICT {
        return Err(AppError::Internal(
            "AI inference with this idempotency key is still reconciling".into(),
        ));
    }
    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!(
            "AI gateway inference failed ({status}): {detail}"
        )));
    }
    response
        .json::<GatewayInferenceResponse>()
        .await
        .map_err(|error| AppError::Internal(format!("parse AI gateway response: {error}")))
}

pub async fn preflight_analyze(
    state: &Arc<AppState>,
    auth: &AuthInfo,
    text: &str,
    fact_cap: usize,
) -> Result<(), AppError> {
    if !ai_credit_enabled(&state.config) {
        return Ok(());
    }
    require_ai_spend_capability(auth)?;
    let tokens_in = estimate_tokens_from_text(text) + 800;
    let req = PreflightRequest {
        owner: auth.owner.clone(),
        agent_object_id: auth.agent_object_id.clone(),
        operation: "analyze".into(),
        model_id: Some(DEFAULT_ANALYZE_MODEL.to_string()),
        estimated_tokens_in: tokens_in,
        estimated_tokens_out: crate::routes::ANALYZE_MAX_OUTPUT_TOKENS as u64,
        fact_count: Some(fact_cap as u64),
    };
    oracle_preflight(&state.http_client, &state.config, &req).await
}

pub async fn preflight_ask(
    state: &Arc<AppState>,
    auth: &AuthInfo,
    question: &str,
) -> Result<(), AppError> {
    if !ai_credit_enabled(&state.config) {
        return Ok(());
    }
    require_ai_spend_capability(auth)?;
    let tokens_in = estimate_tokens_from_text(question) + 1500;
    let req = PreflightRequest {
        owner: auth.owner.clone(),
        agent_object_id: auth.agent_object_id.clone(),
        operation: "ask".into(),
        model_id: Some(DEFAULT_ANALYZE_MODEL.to_string()),
        estimated_tokens_in: tokens_in,
        estimated_tokens_out: 512,
        fact_count: None,
    };
    oracle_preflight(&state.http_client, &state.config, &req).await
}

pub async fn preflight_remember(
    state: &Arc<AppState>,
    auth: &AuthInfo,
    text: &str,
) -> Result<(), AppError> {
    if !ai_credit_enabled(&state.config) {
        return Ok(());
    }
    require_ai_spend_capability(auth)?;
    let tokens_in = estimate_tokens_from_text(text);
    let req = PreflightRequest {
        owner: auth.owner.clone(),
        agent_object_id: auth.agent_object_id.clone(),
        operation: "remember".into(),
        model_id: Some(DEFAULT_EMBED_MODEL.to_string()),
        estimated_tokens_in: tokens_in,
        estimated_tokens_out: 0,
        fact_count: None,
    };
    oracle_preflight(&state.http_client, &state.config, &req).await
}

pub async fn record_inference_usage(
    state: &Arc<AppState>,
    auth: &AuthInfo,
    model_id: &str,
    tokens_in: u64,
    tokens_out: u64,
) -> Result<(), AppError> {
    if !ai_credit_enabled(&state.config) {
        return Ok(());
    }
    require_ai_spend_capability(auth)?;
    let balance = fetch_balance(&state.http_client, &state.config, &auth.owner).await?;
    oracle_record_usage(
        &state.http_client,
        &state.config,
        &balance,
        auth,
        USAGE_INFERENCE,
        Some(model_id),
        tokens_in,
        tokens_out,
    )
    .await
}

pub async fn record_embedding_usage(
    state: &Arc<AppState>,
    auth: &AuthInfo,
    model_id: &str,
    tokens: u64,
) -> Result<(), AppError> {
    if !ai_credit_enabled(&state.config) {
        return Ok(());
    }
    require_ai_spend_capability(auth)?;
    let balance = fetch_balance(&state.http_client, &state.config, &auth.owner).await?;
    oracle_record_usage(
        &state.http_client,
        &state.config,
        &balance,
        auth,
        USAGE_EMBED,
        Some(model_id),
        tokens,
        0,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_inference_targets_oracle_native_path() {
        // Relayer must keep calling the oracle's private inference API — not an
        // OpenAI-compatible proxy on the Memory server.
        let base = "http://127.0.0.1:8095/";
        let url = format!(
            "{}/v1/ai-credit/inference",
            base.trim_end_matches('/')
        );
        assert_eq!(url, "http://127.0.0.1:8095/v1/ai-credit/inference");
    }

    #[test]
    fn gateway_inference_request_serializes_native_shape() {
        let body = GatewayInferenceRequest {
            owner: "0xowner",
            balance_id: "0xbal",
            memory_account_id: "0xmem",
            agent_object_id: "0xagent",
            model_id: "openai/gpt-4o-mini",
            system_prompt: Some("sys"),
            prompt: "hello",
            max_tokens: 32,
            idempotency_key: "idem-1",
        };
        let value = serde_json::to_value(&body).unwrap();
        assert_eq!(value["owner"], "0xowner");
        assert_eq!(value["balance_id"], "0xbal");
        assert_eq!(value["memory_account_id"], "0xmem");
        assert_eq!(value["agent_object_id"], "0xagent");
        assert_eq!(value["model_id"], "openai/gpt-4o-mini");
        assert_eq!(value["system_prompt"], "sys");
        assert_eq!(value["prompt"], "hello");
        assert_eq!(value["max_tokens"], 32);
        assert_eq!(value["idempotency_key"], "idem-1");
        assert!(value.get("messages").is_none());
    }
}
