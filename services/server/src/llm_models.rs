//! Per-agent LLM choice backed by OpenRouter discovery, independent of billing auth.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};

use crate::types::{AppError, AppState, AuthInfo};

#[derive(Debug, Clone, Deserialize)]
struct OpenRouterCatalog {
    data: Vec<OpenRouterModel>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct OpenRouterModel {
    id: String,
    name: String,
    #[serde(default)]
    context_length: Option<u64>,
    architecture: ModelArchitecture,
    #[serde(default)]
    pricing: ModelPricing,
}

#[derive(Debug, Clone, Deserialize)]
struct ModelArchitecture {
    input_modalities: Vec<String>,
    output_modalities: Vec<String>,
}

#[derive(Debug, Default, Clone, Deserialize)]
struct ModelPricing {
    prompt: Option<String>,
    completion: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LlmModelOption {
    pub id: String,
    pub display_name: String,
    pub context_length: Option<u64>,
    // Provider list prices, not quotes in chain currency or an oracle billing rate.
    pub input_usd_per_1m: Option<f64>,
    pub output_usd_per_1m: Option<f64>,
}

struct CachedCatalog {
    url: String,
    fetched_at: Instant,
    models: Vec<OpenRouterModel>,
}

const CATALOG_TTL: Duration = Duration::from_secs(300);
static CATALOG_CACHE: tokio::sync::Mutex<Option<CachedCatalog>> =
    tokio::sync::Mutex::const_new(None);

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

fn usd_per_million(value: Option<&str>) -> Option<f64> {
    value
        .and_then(|value| value.parse::<f64>().ok())
        .map(|value| value * 1_000_000.0)
        .filter(|value| value.is_finite() && *value >= 0.0)
}

pub(crate) fn catalog_options(models: &[OpenRouterModel]) -> Vec<LlmModelOption> {
    let mut seen = HashSet::new();
    let mut rows = Vec::new();
    for model in models {
        let id = model.id.trim();
        // This endpoint feeds a text-chat selector, not image/video/embedding generation.
        if id.is_empty()
            || !model
                .architecture
                .input_modalities
                .iter()
                .any(|m| m == "text")
            || model.architecture.output_modalities != ["text"]
            || !seen.insert(id.to_string())
        {
            continue;
        }
        rows.push(LlmModelOption {
            id: id.to_string(),
            display_name: model.name.clone(),
            context_length: model.context_length,
            input_usd_per_1m: usd_per_million(model.pricing.prompt.as_deref()),
            output_usd_per_1m: usd_per_million(model.pricing.completion.as_deref()),
        });
    }
    rows.sort_by(|left, right| {
        left.display_name
            .cmp(&right.display_name)
            .then(left.id.cmp(&right.id))
    });
    rows
}

/// Preserve OpenRouter's id, including variants with the same display name.
/// Accept historical unprefixed OpenAI ids without accepting arbitrary model ids.
pub(crate) fn canonical_model_id(models: &[OpenRouterModel], requested: &str) -> Option<String> {
    let want = requested.trim();
    catalog_options(models)
        .into_iter()
        .find(|model| {
            model.id.eq_ignore_ascii_case(want)
                || model
                    .id
                    .strip_prefix("openai/")
                    .is_some_and(|id| id.eq_ignore_ascii_case(want))
        })
        .map(|model| model.id)
}

async fn fetch_openrouter_catalog(
    client: &reqwest::Client,
    url: &str,
) -> Result<Vec<OpenRouterModel>, AppError> {
    // Discovery is public: do not forward the user's agent token, OpenAI key,
    // or the private AI-credit-oracle service secret to this endpoint.
    let response = client
        .get(url)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| {
            AppError::Internal(format!("OpenRouter model discovery failed: {error}"))
        })?;
    if !response.status().is_success() {
        return Err(AppError::Internal(format!(
            "OpenRouter model discovery status {}",
            response.status()
        )));
    }
    let body: OpenRouterCatalog = response
        .json()
        .await
        .map_err(|error| AppError::Internal(format!("parse OpenRouter models: {error}")))?;
    if catalog_options(&body.data).is_empty() {
        return Err(AppError::Internal(
            "OpenRouter returned no text-chat models".into(),
        ));
    }
    Ok(body.data)
}

async fn fetch_catalog(state: &AppState) -> Result<Vec<OpenRouterModel>, AppError> {
    let url = format!(
        "{}/models",
        state.config.openrouter_api_base.trim_end_matches('/')
    );
    let mut cache = CATALOG_CACHE.lock().await;
    if let Some(cached) = cache.as_ref() {
        if cached.url == url && cached.fetched_at.elapsed() < CATALOG_TTL {
            return Ok(cached.models.clone());
        }
    }
    let models = fetch_openrouter_catalog(&state.http_client, &url).await?;
    *cache = Some(CachedCatalog {
        url,
        fetched_at: Instant::now(),
        models: models.clone(),
    });
    Ok(models)
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
    let saved = state.db.get_agent_llm_model(&auth.agent_object_id).await?;
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
    let model_id = canonical_model_id(&models, &body.model_id).ok_or_else(|| {
        AppError::BadRequest("model_id is not an available OpenRouter chat model".into())
    })?;
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

    fn sample() -> Vec<OpenRouterModel> {
        serde_json::from_value(serde_json::json!([{
            "id": "openai/gpt-4o-mini", "name": "GPT-4o mini", "context_length": 128000,
            "architecture": {"input_modalities": ["text", "image"], "output_modalities": ["text"]},
            "pricing": {"prompt": "0.00000015", "completion": "0.0000006"}
        }]))
        .unwrap()
    }

    #[test]
    fn pick_ask_model_prefers_explicit_then_saved_then_default() {
        assert_eq!(
            pick_ask_model(Some(" explicit "), Some("saved"), "default"),
            "explicit"
        );
        assert_eq!(
            pick_ask_model(Some("  "), Some("saved"), "default"),
            "saved"
        );
        assert_eq!(pick_ask_model(None, None, "default"), "default");
    }

    #[test]
    fn canonical_model_id_accepts_legacy_openai_ids() {
        let models = sample();
        assert_eq!(
            canonical_model_id(&models, "GPT-4o-mini").as_deref(),
            Some("openai/gpt-4o-mini")
        );
        assert_eq!(canonical_model_id(&models, "missing"), None);
        assert_eq!(canonical_model_id(&models, "  "), None);
    }

    #[test]
    fn catalog_options_deduplicate_ids_not_display_names() {
        let mut models = sample();
        models.push(models[0].clone());
        let mut variant = models[0].clone();
        variant.id = "openai/gpt-4o-mini:free".into();
        models.push(variant);
        let rows = catalog_options(&models);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "openai/gpt-4o-mini");
        assert_eq!(rows[0].display_name, "GPT-4o mini");
        assert_eq!(rows[0].input_usd_per_1m, Some(0.15));
        assert_eq!(rows[0].output_usd_per_1m, Some(0.6));
    }

    #[test]
    fn discovery_omits_non_chat_models_and_preserves_unknown_prices() {
        let mut models = sample();
        let mut image = models[0].clone();
        image.id = "image/generator".into();
        image.architecture.output_modalities = vec!["image".into()];
        models.push(image);
        models[0].pricing.prompt = Some("-1".into());
        assert_eq!(catalog_options(&models).len(), 1);
        assert_eq!(catalog_options(&models)[0].input_usd_per_1m, None);
        assert_eq!(canonical_model_id(&models, "image/generator"), None);
        assert_eq!(usd_per_million(Some("NaN")), None);
    }

    #[tokio::test]
    async fn model_discovery_uses_public_openrouter_not_oracle_auth() {
        use axum::{routing::get, Router};
        let app = Router::new().route(
            "/models",
            get(|headers: axum::http::HeaderMap| async move {
                assert!(!headers.contains_key("authorization"));
                assert!(!headers.contains_key("x-ai-credit-oracle-secret"));
                Json(serde_json::json!({"data": [{
                    "id": "anthropic/claude-test", "name": "Claude test",
                    "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]},
                    "pricing": {"prompt": "0.000003", "completion": "0.000015"}
                }]}))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/models", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let models = fetch_openrouter_catalog(&reqwest::Client::new(), &url)
            .await
            .unwrap();
        assert_eq!(
            canonical_model_id(&models, "anthropic/claude-test").as_deref(),
            Some("anthropic/claude-test")
        );
        assert_eq!(catalog_options(&models)[0].input_usd_per_1m, Some(3.0));
        server.abort();
    }
}
