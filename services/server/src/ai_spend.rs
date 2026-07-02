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
    let resp = client.get(&url).send().await.map_err(|e| {
        AppError::Internal(format!("ai-credit balance fetch failed: {}", e))
    })?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(AppError::AiCreditDepleted(
            "no_ai_credit_balance".into(),
        ));
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
    let envelope: BalanceEnvelope = resp.json().await.map_err(|e| {
        AppError::Internal(format!("parse ai-credit balance: {}", e))
    })?;
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
    let resp = client
        .post(&url)
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
    let body: PreflightResponse = resp.json().await.map_err(|e| {
        AppError::Internal(format!("parse oracle preflight: {}", e))
    })?;
    if body.allowed {
        Ok(())
    } else if body.approval_required
        || body.reason.as_deref() == Some(APPROVAL_REQUIRED_REASON)
    {
        Err(AppError::AiCreditApprovalRequired {
            threshold_mist: body.approval_threshold_mist,
            estimated_mist: body.estimated_mist,
        })
    } else {
        Err(AppError::AiCreditDepleted(
            body.reason.unwrap_or_else(|| "insufficient_ai_credits".into()),
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
    };
    let resp = client
        .post(&url)
        .json(&req)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("oracle usage failed: {}", e)))?;
    if resp.status() == reqwest::StatusCode::PAYMENT_REQUIRED {
        let body_text = resp.text().await.unwrap_or_default();
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body_text) {
            if v.get("code").and_then(|c| c.as_str())
                == Some("ai_credit_approval_required")
            {
                return Err(AppError::AiCreditApprovalRequired {
                    threshold_mist: v
                        .get("threshold_mist")
                        .and_then(|x| x.as_u64()),
                    estimated_mist: v
                        .get("estimated_mist")
                        .and_then(|x| x.as_u64()),
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
        return Err(AppError::AiCreditDepleted("insufficient_ai_credits".into()));
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
