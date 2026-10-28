//! Structured chat access through the authenticated agent gateway, preserving paid call identity.
use std::sync::Arc;
use axum::{extract::State, Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::types::{AppError, AppState, AuthInfo};

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FunctionCall { pub name: String, pub arguments: String }
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub function: FunctionCall,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ChatMessage {
    pub role: String,
    pub content: Option<String>,
    pub tool_call_id: Option<String>,
    pub tool_calls: Option<Vec<ToolCall>>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChatRequest {
    pub model_id: String,
    pub idempotency_key: String,
    pub messages: Vec<ChatMessage>,
    pub tools: Option<Vec<Value>>,
    pub tool_choice: Option<Value>,
    pub max_tokens: Option<u32>,
    /// Optional provider reservation metadata. Work plans do not use it as a
    /// spending limit; the AI-credit service and current on-chain authority decide.
    pub max_amount_mist: Option<String>,
    /// When inference is part of a durable run, bind this charge to the
    /// journaled pending operation and its exact idempotency key.
    pub work_run_id: Option<String>,
    pub work_operation_id: Option<String>,
}

pub async fn chat(
    State(state): State<Arc<AppState>>, Extension(auth): Extension<AuthInfo>, Json(mut input): Json<ChatRequest>,
) -> Result<Json<crate::ai_spend::StructuredInferenceResponse>, AppError> {
    if input.model_id.trim().is_empty() || input.model_id.len() > 200 {
        return Err(AppError::BadRequest("model_id is required".into()));
    }
    if !(8..=128).contains(&input.idempotency_key.len()) || !input.idempotency_key.bytes().all(|c| c.is_ascii_alphanumeric() || b"._:/-".contains(&c)) {
        return Err(AppError::BadRequest("a stable 8-128 character idempotency_key is required".into()));
    }
    match (input.work_run_id.as_deref(), input.work_operation_id.as_deref()) {
        (Some(run_id), Some(operation_id)) => {
            let reserved = crate::work_runs::authorize_ai_operation(&state, &auth, run_id, operation_id, &input.idempotency_key).await?;
            if input.max_amount_mist.as_deref().is_some_and(|provided|Some(provided)!=reserved.as_deref()) { return Err(AppError::Conflict("AI reservation metadata differs from the durable work record".into())); }
            input.max_amount_mist=reserved;
        }
        (None, None) => {},
        _ => return Err(AppError::BadRequest("work_run_id and work_operation_id must be supplied together".into())),
    }
    if input.messages.is_empty() || input.messages.len() > 2048 || input.tools.as_ref().is_some_and(|t| t.len() > 256) {
        return Err(AppError::BadRequest("messages/tools exceed the request limits".into()));
    }
    let max_tokens = input.max_tokens.unwrap_or(4096);
    if max_tokens == 0 || max_tokens > 32768 { return Err(AppError::BadRequest("max_tokens must be 1 through 32768".into())); }
    if input.max_amount_mist.as_deref().is_some_and(|value| {
        value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) || value.parse::<u64>().is_err()
    }) { return Err(AppError::BadRequest("max_amount_mist must be an exact decimal u64 string".into())); }
    let mut tool_names = std::collections::HashSet::new();
    for tool in input.tools.as_deref().unwrap_or(&[]) {
        let function = tool.get("function").and_then(Value::as_object).ok_or_else(|| AppError::BadRequest("tool function is required".into()))?;
        let name = function.get("name").and_then(Value::as_str).ok_or_else(|| AppError::BadRequest("tool name is required".into()))?;
        if tool.get("type").and_then(Value::as_str) != Some("function") || name.is_empty() || name.len()>64 || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b==b'_' || b==b'-') || !tool_names.insert(name) || !function.get("parameters").is_some_and(Value::is_object) {
            return Err(AppError::BadRequest("invalid or duplicate tool definition".into()));
        }
    }
    let mut pending = std::collections::HashSet::new();
    for message in &input.messages {
        if !["system", "user", "assistant", "tool"].contains(&message.role.as_str()) {
            return Err(AppError::BadRequest("unsupported chat message role".into()));
        }
        if message.role != "tool" && message.tool_call_id.is_some() { return Err(AppError::BadRequest("tool_call_id is only valid on tool results".into())); }
        if message.role == "tool" {
            let id = message.tool_call_id.as_deref().ok_or_else(|| AppError::BadRequest("tool message needs tool_call_id".into()))?;
            if !pending.remove(id) { return Err(AppError::BadRequest("tool result has no pending call".into())); }
        } else if !pending.is_empty() {
            return Err(AppError::BadRequest("resolve all pending tool calls before continuing the conversation".into()));
        }
        if let Some(calls) = &message.tool_calls {
            if message.role != "assistant" { return Err(AppError::BadRequest("only assistants may call tools".into())); }
            for call in calls {
                if call.kind != "function" || call.id.is_empty() || call.function.name.is_empty() || serde_json::from_str::<Value>(&call.function.arguments).map_or(true, |value| !value.is_object()) || !pending.insert(call.id.as_str()) {
                    return Err(AppError::BadRequest("invalid or duplicate tool call".into()));
                }
            }
        }
    }
    if !pending.is_empty() { return Err(AppError::BadRequest("conversation ends with unresolved tool calls".into())); }
    let messages = serde_json::to_value(&input.messages).map_err(|_| AppError::BadRequest("invalid messages".into()))?;
    let tools = input.tools.map(Value::Array);
    if serde_json::to_vec(&messages).map_or(true, |v| v.len() > 512 * 1024) || tools.as_ref().is_some_and(|v| v.to_string().len() > 256 * 1024) {
        return Err(AppError::BadRequest("structured inference request is too large".into()));
    }
    let options = crate::ai_spend::StructuredInferenceOptions { messages: &messages, tools: tools.as_ref(), tool_choice: input.tool_choice.as_ref(), max_amount_mist: input.max_amount_mist.as_deref() };
    Ok(Json(crate::ai_spend::run_gateway_structured_inference(
        &state, &auth, input.model_id.trim(), max_tokens, &input.idempotency_key, &options,
    ).await?))
}
