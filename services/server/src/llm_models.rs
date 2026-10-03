//! Per-agent LLM choice and a signed view of the oracle pricing catalog.

use std::collections::HashSet;
use std::sync::Arc;

use axum::extract::State;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};

use crate::types::{AppError, AppState, AuthInfo};

#[derive(Debug, Clone, Deserialize)]
struct OracleCatalog {
    models: Vec<OracleModel>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct OracleModel {
    pub aliases: Vec<String>,
    pub display_name: String,
    pub input_mist_per_1m: u64,
    pub output_mist_per_1m: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LlmModelOption {
    pub id: String,
    pub display_name: String,
    pub input_mist_per_1m: u64,
    pub output_mist_per_1m: u64,
}

#[derive(Debug, Serialize)]
pub struct LlmModelListResponse {
    pub models: Vec<LlmModelOption>,
}

#[derive(Debug, Serialize)]
pub struct AgentLlmModelResponse {
    pub model_id: String,
    pub source: &'static str,
}

#[derive(Debug, Deserialize)]
pub struct SetAgentLlmModelRequest {
    pub model_id: String,
}

/// Request model, then the saved agent model, then the server default.
pub(crate) fn pick_ask_model(
    explicit: Option<&str>,
    saved: Option<&str>,
    default_model: &str,
) -> String {
    explicit
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .or_else(|| saved.map(str::trim).filter(|model| !model.is_empty()))
        .unwrap_or(default_model)
        .to_string()
}

pub(crate) fn catalog_options(models: &[OracleModel]) -> Vec<LlmModelOption> {
    let mut seen = HashSet::new();
    let mut rows = Vec::new();
    for model in models {
        let Some(id) = model
            .aliases
            .first()
            .map(|alias| alias.trim())
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        if !seen.insert(model.display_name.clone()) {
            continue;
        }
        rows.push(LlmModelOption {
            id: id.to_string(),
            display_name: model.display_name.clone(),
            input_mist_per_1m: model.input_mist_per_1m,
            output_mist_per_1m: model.output_mist_per_1m,
        });
    }
    rows.sort_by(|left, right| left.display_name.cmp(&right.display_name));
    rows
}

/// Map any catalog alias to the first alias, which is the id ask bills.
pub(crate) fn canonical_model_id(models: &[OracleModel], requested: &str) -> Option<String> {
    let want = requested.trim().to_lowercase();
    if want.is_empty() {
        return None;
    }
    models.iter().find_map(|model| {
        let matches = model
            .aliases
            .iter()
            .any(|alias| alias.trim().to_lowercase() == want);
        if !matches {
            return None;
        }
        model
            .aliases
            .first()
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty())
    })
}

async fn fetch_catalog(state: &AppState) -> Result<Vec<OracleModel>, AppError> {
    let url = format!(
        "{}/v1/ai-credit/catalog",
        state.config.ai_credit_oracle_url.trim_end_matches('/')
    );
    let mut request = state.http_client.get(url);
    if let Some(secret) = state.config.ai_credit_oracle_api_secret.as_deref() {
        request = request.header("x-ai-credit-oracle-secret", secret);
    }
    let response = request
        .send()
        .await
        .map_err(|error| AppError::Internal(format!("oracle catalog failed: {error}")))?;
    if !response.status().is_success() {
        return Err(AppError::Internal(format!(
            "oracle catalog status {}",
            response.status()
        )));
    }
    let body: OracleCatalog = response
        .json()
        .await
        .map_err(|error| AppError::Internal(format!("parse oracle catalog: {error}")))?;
    Ok(body.models)
}

pub async fn list_models(
    State(state): State<Arc<AppState>>,
    Extension(_auth): Extension<AuthInfo>,
) -> Result<Json<LlmModelListResponse>, AppError> {
    let models = fetch_catalog(&state).await?;
    Ok(Json(LlmModelListResponse {
        models: catalog_options(&models),
    }))
}

pub async fn get_llm_model(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
) -> Result<Json<AgentLlmModelResponse>, AppError> {
    let saved = state
        .db
        .get_agent_llm_model(&auth.agent_object_id)
        .await?;
    let (model_id, source) = match saved.filter(|model| !model.trim().is_empty()) {
        Some(model_id) => (model_id, "saved"),
        None => (state.config.default_llm_model.clone(), "default"),
    };
    Ok(Json(AgentLlmModelResponse { model_id, source }))
}

pub async fn set_llm_model(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Json(body): Json<SetAgentLlmModelRequest>,
) -> Result<Json<AgentLlmModelResponse>, AppError> {
    if body.model_id.trim().is_empty() {
        return Err(AppError::BadRequest("model_id cannot be empty".into()));
    }
    let models = fetch_catalog(&state).await?;
    let model_id = canonical_model_id(&models, &body.model_id)
        .ok_or_else(|| AppError::BadRequest("model_id is not in the pricing catalog".into()))?;
    state
        .db
        .upsert_agent_llm_model(&auth.agent_object_id, &model_id)
        .await?;
    Ok(Json(AgentLlmModelResponse {
        model_id,
        source: "saved",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Vec<OracleModel> {
        vec![OracleModel {
            aliases: vec!["openai/gpt-4o-mini".into(), "gpt-4o-mini".into()],
            display_name: "GPT-4o mini".into(),
            input_mist_per_1m: 1,
            output_mist_per_1m: 4,
        }]
    }

    #[test]
    fn pick_ask_model_prefers_explicit_then_saved_then_default() {
        assert_eq!(
            pick_ask_model(Some(" explicit "), Some("saved"), "default"),
            "explicit"
        );
        assert_eq!(pick_ask_model(Some("  "), Some("saved"), "default"), "saved");
        assert_eq!(pick_ask_model(None, None, "default"), "default");
    }

    #[test]
    fn canonical_model_id_uses_the_first_alias() {
        let models = sample();
        assert_eq!(
            canonical_model_id(&models, "GPT-4o-mini").as_deref(),
            Some("openai/gpt-4o-mini")
        );
        assert_eq!(canonical_model_id(&models, "missing"), None);
        assert_eq!(canonical_model_id(&models, "  "), None);
    }

    #[test]
    fn catalog_options_keep_one_row_per_display_name() {
        let mut models = sample();
        models.push(models[0].clone());
        let rows = catalog_options(&models);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "openai/gpt-4o-mini");
        assert_eq!(rows[0].display_name, "GPT-4o mini");
    }
}
