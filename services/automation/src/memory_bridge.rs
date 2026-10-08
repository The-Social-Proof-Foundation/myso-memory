//! Client for the automation memory bridge (`services/automation-sidecar`).
//!
//! This engine holds no agent keys: `MemoryRelayerCall` reaches the memory
//! relayer only through the bridge, which resolves the job's
//! `target_agent_key_ref` and signs with `@socialproof/memory`. Keeping the
//! signing contract in one implementation is what stops the chat-app and a
//! scheduled job from drifting apart.

use serde::{Deserialize, Serialize};

use crate::Config;

/// Which memory operation a job performs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum MemoryOperation {
    /// Search the agent's memory for `query`.
    #[default]
    Recall,
    /// Store `text` as the agent.
    Remember,
    /// Recall first, then store a digest built from `remember_prefix` plus the
    /// recalled texts. The primitive behind "collect what the agent knows and
    /// write it down".
    RecallThenRemember,
}

/// `action.config` shape for `JobActionKind::MemoryRelayerCall`.
///
/// Everything is optional because a job may rely entirely on its
/// `target_agent_key_ref` and `memory_scope` fields.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct MemoryActionConfig {
    #[serde(default)]
    pub operation: MemoryOperation,
    /// Overrides the job's `target_agent_key_ref` for this action.
    #[serde(default)]
    pub key_ref: Option<String>,
    /// Recall query. Required for `recall` and `recall_then_remember`.
    #[serde(default)]
    pub query: Option<String>,
    /// Text to store. Required for `remember`.
    #[serde(default)]
    pub text: Option<String>,
    /// Max recalled results. Defaults to 10.
    #[serde(default)]
    pub limit: Option<u32>,
    /// Overrides the bridge's default namespace for this action.
    #[serde(default)]
    pub namespace: Option<String>,
    /// Prefix for the digest written by `recall_then_remember`.
    #[serde(default)]
    pub remember_prefix: Option<String>,
    /// For `remember`, block until the relayer reports `done`. Defaults to true.
    #[serde(default)]
    pub wait: Option<bool>,
}

/// Parse an action config, mapping a malformed blob onto a readable error
/// instead of a panic or a silent default.
pub fn parse_action_config(value: &serde_json::Value) -> Result<MemoryActionConfig, String> {
    serde_json::from_value(value.clone())
        .map_err(|e| format!("invalid memory_relayer_call config: {e}"))
}

/// Validate that a config carries the fields its operation needs.
pub fn validate_action_config(config: &MemoryActionConfig) -> Result<(), String> {
    match config.operation {
        MemoryOperation::Recall | MemoryOperation::RecallThenRemember => {
            match config.query.as_deref().map(str::trim) {
                Some(q) if !q.is_empty() => Ok(()),
                _ => Err(format!(
                    "{:?} requires a non-empty `query`",
                    config.operation
                )),
            }
        }
        MemoryOperation::Remember => match config.text.as_deref().map(str::trim) {
            Some(t) if !t.is_empty() => Ok(()),
            _ => Err("remember requires a non-empty `text`".into()),
        },
    }
}

#[derive(Debug, Serialize)]
struct RecallRequest<'a> {
    key_ref: &'a str,
    /// The job's account. The bridge refuses a ref that is not registered
    /// under it, which is what stops one tenant naming another's agent.
    account_id: &'a str,
    query: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    namespace: Option<&'a str>,
}

#[derive(Debug, Serialize)]
struct RememberRequest<'a> {
    key_ref: &'a str,
    account_id: &'a str,
    text: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    wait: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    namespace: Option<&'a str>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RecalledMemory {
    pub text: String,
    #[serde(default)]
    pub distance: f64,
    #[serde(default)]
    pub blob_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RecallResponse {
    #[serde(default)]
    pub results: Vec<RecalledMemory>,
    #[serde(default)]
    pub total: u64,
    /// The relayer caps recall at `limit` and drops the rest with no signal, so
    /// a full page means possible truncation rather than an exact answer.
    #[serde(default)]
    pub truncated: bool,
    #[serde(default)]
    pub degraded_scope: Option<bool>,
    #[serde(default)]
    pub namespace: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RememberResponse {
    pub job_id: String,
    pub status: String,
    #[serde(default)]
    pub blob_id: Option<String>,
    #[serde(default)]
    pub namespace: Option<String>,
}

/// A bridge failure, classified so the caller can decide whether to retry.
#[derive(Debug)]
pub enum BridgeError {
    /// The bridge rejected the request — a bad key ref, an unregistered agent,
    /// insufficient credits. Retrying cannot help.
    Rejected { status: u16, message: String },
    /// The bridge or the relayer was unreachable or failed. Retryable.
    Unavailable { message: String },
    /// Malformed job configuration. Retrying cannot help.
    Invalid { message: String },
}

impl BridgeError {
    /// Mirrors the chat-app's retry rule: never retry a 4xx.
    pub fn retryable(&self) -> bool {
        matches!(self, Self::Unavailable { .. })
    }

    pub fn message(&self) -> &str {
        match self {
            Self::Rejected { message, .. }
            | Self::Unavailable { message }
            | Self::Invalid { message } => message,
        }
    }
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rejected { status, message } => {
                write!(f, "bridge rejected ({status}): {message}")
            }
            Self::Unavailable { message } => write!(f, "bridge unavailable: {message}"),
            Self::Invalid { message } => write!(f, "invalid action config: {message}"),
        }
    }
}

impl std::error::Error for BridgeError {}

#[derive(Clone)]
pub struct MemoryBridgeClient {
    http: reqwest::Client,
    base_url: String,
    secret: String,
}

impl MemoryBridgeClient {
    pub fn new(config: &Config) -> Self {
        Self {
            http: reqwest::Client::new(),
            base_url: config.memory_bridge_url.trim_end_matches('/').to_string(),
            secret: config.memory_bridge_secret.clone(),
        }
    }

    pub async fn recall(
        &self,
        key_ref: &str,
        account_id: &str,
        query: &str,
        limit: Option<u32>,
        namespace: Option<&str>,
    ) -> Result<RecallResponse, BridgeError> {
        self.post(
            "/internal/memory/recall",
            &RecallRequest {
                key_ref,
                account_id,
                query,
                limit,
                namespace,
            },
        )
        .await
    }

    pub async fn remember(
        &self,
        key_ref: &str,
        account_id: &str,
        text: &str,
        wait: Option<bool>,
        namespace: Option<&str>,
    ) -> Result<RememberResponse, BridgeError> {
        self.post(
            "/internal/memory/remember",
            &RememberRequest {
                key_ref,
                account_id,
                text,
                wait,
                namespace,
            },
        )
        .await
    }

    async fn post<B: Serialize, T: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<T, BridgeError> {
        let response = self
            .http
            .post(format!("{}{path}", self.base_url))
            .header("x-internal-sync-secret", &self.secret)
            .json(body)
            .send()
            .await
            .map_err(|e| BridgeError::Unavailable {
                message: format!("cannot reach memory bridge at {}{path}: {e}", self.base_url),
            })?;

        let status = response.status();
        let bytes = response.bytes().await.map_err(|e| BridgeError::Unavailable {
            message: format!("reading bridge response failed: {e}"),
        })?;

        if !status.is_success() {
            let detail = serde_json::from_slice::<serde_json::Value>(&bytes)
                .ok()
                .and_then(|v| {
                    v.get("error")
                        .and_then(|e| e.as_str())
                        .map(|s| s.to_string())
                })
                .unwrap_or_else(|| String::from_utf8_lossy(&bytes).trim().to_string());

            // 4xx is the caller's problem to fix; everything else is an outage.
            return Err(if status.is_client_error() {
                BridgeError::Rejected {
                    status: status.as_u16(),
                    message: detail,
                }
            } else {
                BridgeError::Unavailable {
                    message: format!("bridge returned {status}: {detail}"),
                }
            });
        }

        serde_json::from_slice(&bytes).map_err(|e| BridgeError::Unavailable {
            message: format!("bridge returned unparseable body: {e}"),
        })
    }
}

/// Outcome of running a memory action, recorded on the run row.
#[derive(Debug, Clone)]
pub struct MemoryActionOutcome {
    pub summary: serde_json::Value,
    pub recalled: usize,
    pub stored_text: Option<String>,
}

/// Build the digest `recall_then_remember` writes.
pub fn build_digest(prefix: Option<&str>, recalled: &[RecalledMemory]) -> String {
    let body = recalled
        .iter()
        .map(|m| m.text.trim())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    match prefix {
        Some(p) if !p.trim().is_empty() => format!("{}\n{body}", p.trim()),
        _ => body,
    }
}

/// Run a `MemoryRelayerCall` action end to end.
pub async fn execute_memory_action(
    client: &MemoryBridgeClient,
    job_key_ref: &str,
    account_id: &str,
    memory_scope_namespace: Option<&str>,
    config_value: &serde_json::Value,
) -> Result<MemoryActionOutcome, BridgeError> {
    let config = parse_action_config(config_value).map_err(|message| BridgeError::Invalid { message })?;
    validate_action_config(&config).map_err(|message| BridgeError::Invalid { message })?;

    // The action may point at a different agent than the job's default target.
    let key_ref = config.key_ref.as_deref().unwrap_or(job_key_ref);
    // An explicit action namespace wins; otherwise fall back to the job's
    // memory_scope so the chat-app and the job read the same scope.
    let namespace = config
        .namespace
        .as_deref()
        .or(memory_scope_namespace);

    match config.operation {
        MemoryOperation::Recall => {
            let query = config.query.as_deref().unwrap_or_default();
            let response = client.recall(key_ref, account_id, query, config.limit, namespace).await?;
            Ok(outcome_from_recall(response, None))
        }
        MemoryOperation::Remember => {
            let text = config.text.as_deref().unwrap_or_default();
            let response = client
                .remember(key_ref, account_id, text, config.wait, namespace)
                .await?;
            Ok(MemoryActionOutcome {
                summary: serde_json::json!({
                    "operation": "remember",
                    "job_id": response.job_id,
                    "status": response.status,
                    "blob_id": response.blob_id,
                    "namespace": response.namespace,
                    "chars": text.chars().count(),
                }),
                recalled: 0,
                stored_text: Some(text.to_string()),
            })
        }
        MemoryOperation::RecallThenRemember => {
            let query = config.query.as_deref().unwrap_or_default();
            let response = client.recall(key_ref, account_id, query, config.limit, namespace).await?;
            let digest = build_digest(config.remember_prefix.as_deref(), &response.results);
            if digest.trim().is_empty() {
                // Nothing recalled: writing an empty digest would pollute later
                // recall, so report a clean no-op instead.
                return Ok(MemoryActionOutcome {
                    summary: serde_json::json!({
                        "operation": "recall_then_remember",
                        "recalled": 0,
                        "stored": false,
                        "note": "recall returned nothing; nothing to store",
                    }),
                    recalled: 0,
                    stored_text: None,
                });
            }
            let stored = client
                .remember(key_ref, account_id, &digest, config.wait, namespace)
                .await?;
            Ok(outcome_from_recall(response, Some((stored, digest))))
        }
    }
}

fn outcome_from_recall(
    response: RecallResponse,
    stored: Option<(RememberResponse, String)>,
) -> MemoryActionOutcome {
    let recalled = response.results.len();
    MemoryActionOutcome {
        summary: serde_json::json!({
            "operation": if stored.is_some() { "recall_then_remember" } else { "recall" },
            "recalled": recalled,
            "total": response.total,
            "truncated": response.truncated,
            "degraded_scope": response.degraded_scope,
            "namespace": response.namespace,
            "top_distance": response.results.first().map(|m| m.distance),
            "stored": stored.as_ref().map(|(r, digest)| serde_json::json!({
                "job_id": r.job_id,
                "status": r.status,
                "blob_id": r.blob_id,
                "chars": digest.chars().count(),
            })),
        }),
        recalled,
        stored_text: stored.map(|(_, digest)| digest),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recalled(texts: &[&str]) -> Vec<RecalledMemory> {
        texts
            .iter()
            .map(|t| RecalledMemory {
                text: (*t).to_string(),
                distance: 0.1,
                blob_id: "b".into(),
            })
            .collect()
    }

    #[test]
    fn operation_defaults_to_recall() {
        let config = parse_action_config(&serde_json::json!({})).unwrap();
        assert_eq!(config.operation, MemoryOperation::Recall);
    }

    #[test]
    fn operation_parses_all_variants() {
        for (raw, expected) in [
            ("recall", MemoryOperation::Recall),
            ("remember", MemoryOperation::Remember),
            ("recall_then_remember", MemoryOperation::RecallThenRemember),
        ] {
            let config = parse_action_config(&serde_json::json!({ "operation": raw })).unwrap();
            assert_eq!(config.operation, expected, "for {raw}");
        }
    }

    #[test]
    fn unknown_operation_is_a_readable_error() {
        let err = parse_action_config(&serde_json::json!({ "operation": "explode" })).unwrap_err();
        assert!(err.contains("invalid memory_relayer_call config"), "{err}");
    }

    #[test]
    fn recall_requires_a_query() {
        let config = parse_action_config(&serde_json::json!({})).unwrap();
        let err = validate_action_config(&config).unwrap_err();
        assert!(err.contains("query"), "{err}");

        let blank = parse_action_config(&serde_json::json!({ "query": "   " })).unwrap();
        assert!(validate_action_config(&blank).is_err());
    }

    #[test]
    fn remember_requires_text() {
        let config =
            parse_action_config(&serde_json::json!({ "operation": "remember" })).unwrap();
        let err = validate_action_config(&config).unwrap_err();
        assert!(err.contains("text"), "{err}");
    }

    #[test]
    fn recall_then_remember_requires_a_query_but_not_text() {
        let config = parse_action_config(&serde_json::json!({
            "operation": "recall_then_remember",
            "query": "preferences",
        }))
        .unwrap();
        assert!(validate_action_config(&config).is_ok());
    }

    #[test]
    fn digest_joins_recalled_texts() {
        let digest = build_digest(None, &recalled(&["a", "b"]));
        assert_eq!(digest, "a\nb");
    }

    #[test]
    fn digest_applies_a_prefix() {
        let digest = build_digest(Some("known facts:"), &recalled(&["a"]));
        assert_eq!(digest, "known facts:\na");
    }

    #[test]
    fn digest_skips_blank_texts_and_ignores_a_blank_prefix() {
        let digest = build_digest(Some("  "), &recalled(&["a", "  ", "b"]));
        assert_eq!(digest, "a\nb");
    }

    #[test]
    fn digest_of_nothing_is_empty() {
        assert!(build_digest(Some("prefix"), &[]).trim() == "prefix");
        assert!(build_digest(None, &recalled(&["", " "])).trim().is_empty());
    }

    #[test]
    fn only_unavailable_errors_are_retryable() {
        assert!(!BridgeError::Rejected {
            status: 404,
            message: "unknown agent key ref".into()
        }
        .retryable());
        assert!(!BridgeError::Invalid {
            message: "bad config".into()
        }
        .retryable());
        assert!(BridgeError::Unavailable {
            message: "connection refused".into()
        }
        .retryable());
    }

    #[test]
    fn outcome_from_recall_reports_truncation() {
        let outcome = outcome_from_recall(
            RecallResponse {
                results: recalled(&["a", "b"]),
                total: 9,
                truncated: true,
                degraded_scope: Some(false),
                namespace: Some("chat-app".into()),
            },
            None,
        );
        assert_eq!(outcome.recalled, 2);
        assert_eq!(outcome.summary["truncated"], true);
        assert_eq!(outcome.summary["total"], 9);
    }
}
