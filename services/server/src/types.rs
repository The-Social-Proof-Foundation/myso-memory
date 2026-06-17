use std::sync::atomic::{AtomicUsize, Ordering};
use serde::{Deserialize, Serialize};

use crate::db::VectorDb;
use crate::rate_limit::RateLimitConfig;

// ============================================================
// App State (shared across routes + middleware)
// ============================================================

/// Shared application state passed to all routes and middleware
pub struct AppState {
    pub db: VectorDb,
    pub config: Config,
    pub http_client: reqwest::Client,
    /// Round-robin pool of MySo private keys for parallel File Storage uploads
    pub key_pool: KeyPool,
    /// Redis multiplexed connection for rate limiting
    pub redis: redis::aio::MultiplexedConnection,
    /// In-memory token bucket fallback for when Redis is unavailable
    pub fallback_rate_limit: tokio::sync::Mutex<crate::rate_limit::InMemoryFallback>,
}

// ============================================================
// Key Pool (round-robin selection for parallel uploads)
// ============================================================

/// A thread-safe round-robin pool of MySo private keys.
/// Each call to `next()` returns the next key in the pool,
/// allowing concurrent uploads to use different signer addresses.
pub struct KeyPool {
    keys: Vec<String>,
    counter: AtomicUsize,
}

impl KeyPool {
    pub fn new(keys: Vec<String>) -> Self {
        Self {
            keys,
            counter: AtomicUsize::new(0),
        }
    }

    /// Returns the next key in round-robin order, or `None` if the pool is empty.
    #[allow(dead_code)]
    pub fn next(&self) -> Option<&str> {
        if self.keys.is_empty() {
            return None;
        }
        let idx = self.counter.fetch_add(1, Ordering::Relaxed) % self.keys.len();
        Some(&self.keys[idx])
    }

    /// Returns the pool index for the next key in round-robin order.
    pub fn next_index(&self) -> Option<usize> {
        if self.keys.is_empty() {
            return None;
        }
        Some(self.counter.fetch_add(1, Ordering::Relaxed) % self.keys.len())
    }

    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }
}

// ============================================================
// Config
// ============================================================

#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub database_url: String,
    pub myso_rpc_url: String,
    /// ENG-1697: network name (mainnet/testnet/devnet). Surfaced via
    /// `GET /config` so the SDK can select the matching MySo fullnode
    /// without the user having to configure it.
    pub myso_network: String,
    pub memory_account_id: Option<String>,
    pub openai_api_key: Option<String>,
    pub openai_api_base: String,
    pub file_storage_publisher_url: String,
    pub file_storage_aggregator_url: String,
    /// Primary key (used for MYDATA decrypt / recall). Unchanged.
    pub myso_private_key: Option<String>,
    /// Pool of keys for parallel File Storage uploads (parsed from SERVER_MYSO_PRIVATE_KEYS,
    /// falls back to SERVER_MYSO_PRIVATE_KEY as a single-element list).
    pub myso_private_keys: Vec<String>,
    pub package_id: String,
    /// Social server base URL for sub-agent index lookups
    pub social_server_url: String,
    /// URL of the MYDATA/File Storage TS sidecar HTTP server
    pub sidecar_url: String,
    /// Shared secret for authenticating Rust→sidecar calls (X-Sidecar-Secret header)
    pub sidecar_secret: Option<String>,
    /// Rate limiting configuration
    pub rate_limit: RateLimitConfig,
    /// Sponsor-specific rate limiting and concurrency config
    pub sponsor_rate_limit: SponsorRateLimitConfig,
    /// Allowed CORS origins (comma-separated, e.g. "http://localhost:3000,https://mysocial.network")
    pub allowed_origins: String,
}

impl Config {
    pub fn from_env() -> Self {
        let network = std::env::var("MYSO_NETWORK")
            .unwrap_or_else(|_| "mainnet".to_string());
        let default_rpc = match network.as_str() {
            "testnet" => "https://fullnode.testnet.mysosocial.network:443",
            "devnet" => "https://fullnode.devnet.mysosocial.network:443",
            _ => "https://fullnode.mainnet.mysosocial.network:443",
        };

        Self {
            port: std::env::var("PORT")
                .unwrap_or_else(|_| "8000".to_string())
                .parse()
                .expect("PORT must be a number"),
            database_url: std::env::var("DATABASE_URL")
                .expect("DATABASE_URL must be set (e.g. postgresql://memory:memory_secret@localhost:5432/memory)"),
            myso_rpc_url: std::env::var("MYSO_RPC_URL")
                .unwrap_or_else(|_| default_rpc.to_string()),
            myso_network: network.clone(),
            memory_account_id: std::env::var("MEMORY_ACCOUNT_ID").ok(),
            openai_api_key: std::env::var("OPENAI_API_KEY")
                .ok()
                .filter(|s| {
                    let t = s.trim();
                    !t.is_empty() && !t.contains("...")
                }),
            openai_api_base: std::env::var("OPENAI_API_BASE")
                .unwrap_or_else(|_| "https://api.openai.com/v1".to_string()),
            file_storage_publisher_url: std::env::var("FILE_STORAGE_PUBLISHER_URL")
                .unwrap_or_else(|_| "https://publisher.file-storage-mainnet.mysocial.network".to_string()),
            file_storage_aggregator_url: std::env::var("FILE_STORAGE_AGGREGATOR_URL")
                .unwrap_or_else(|_| "https://aggregator.file-storage-mainnet.mysocial.network".to_string()),
            myso_private_key: std::env::var("SERVER_MYSO_PRIVATE_KEY").ok(),
            myso_private_keys: {
                // SERVER_MYSO_PRIVATE_KEYS takes priority (comma-separated list).
                // Falls back to SERVER_MYSO_PRIVATE_KEY as a single-element list.
                let multi = std::env::var("SERVER_MYSO_PRIVATE_KEYS").ok().map(|s| {
                    s.split(',')
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(String::from)
                        .collect::<Vec<_>>()
                });
                let single = std::env::var("SERVER_MYSO_PRIVATE_KEY").ok().map(|k| vec![k]);
                multi.or(single).unwrap_or_default()
            },
            package_id: crate::memory_contract::normalize_object_id(
                &std::env::var("MEMORY_PACKAGE_ID")
                    .expect("MEMORY_PACKAGE_ID must be set"),
            ),
            social_server_url: std::env::var("SOCIAL_SERVER_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:9126".to_string()),
            sidecar_url: std::env::var("SIDECAR_URL")
                .unwrap_or_else(|_| "http://localhost:9001".to_string()),
            sidecar_secret: std::env::var("SIDECAR_AUTH_TOKEN").ok(),
            rate_limit: RateLimitConfig::from_env(),
            sponsor_rate_limit: SponsorRateLimitConfig::from_env(),
            allowed_origins: std::env::var("ALLOWED_ORIGINS")
                .unwrap_or_default(),
        }
    }
}

// ============================================================
// Sponsor Rate Limit Config
// ============================================================

#[derive(Debug, Clone)]
pub struct SponsorRateLimitConfig {
    /// Max sponsor requests per minute per IP (default: 10)
    pub per_minute: i64,
    /// Max sponsor requests per hour per IP (default: 30)
    pub per_hour: i64,
}

impl Default for SponsorRateLimitConfig {
    fn default() -> Self {
        Self {
            per_minute: 10,
            per_hour: 30,
        }
    }
}

impl SponsorRateLimitConfig {
    pub fn from_env() -> Self {
        let mut c = Self::default();
        if let Ok(v) = std::env::var("SPONSOR_RATE_LIMIT_PER_MINUTE") {
            if let Ok(n) = v.parse() {
                c.per_minute = n;
            }
        }
        if let Ok(v) = std::env::var("SPONSOR_RATE_LIMIT_PER_HOUR") {
            if let Ok(n) = v.parse() {
                c.per_hour = n;
            }
        }
        c
    }
}

// ============================================================
// API Types
// ============================================================

/// POST /api/remember
/// Phase 2: Server handles everything — encrypt, upload File Storage, embed, store
/// Owner is derived from delegate key via onchain verification (auth middleware)
#[derive(Debug, Deserialize)]
pub struct RememberRequest {
    pub text: String,
    /// Deprecated: use `sub_label`. Optional tag within the authenticated agent vault.
    #[serde(default, alias = "sub_label")]
    pub namespace: String,
}

#[derive(Debug, Serialize)]
pub struct RememberResponse {
    pub id: String,
    pub blob_id: String,
    pub owner: String,
    pub agent_object_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sub_label: Option<String>,
    /// Deprecated alias kept for SDK compatibility.
    pub namespace: String,
}

/// POST /api/recall
/// Phase 2: Server does search → download → decrypt → return plaintext
/// Owner is derived from delegate key via onchain verification (auth middleware)
fn default_limit() -> usize {
    10
}

#[derive(Debug, Deserialize)]
pub struct RecallRequest {
    pub query: String,
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default, alias = "sub_label")]
    pub namespace: String,
    #[serde(default)]
    pub scoring_weights: Option<crate::ranker::ScoringWeights>,
}

#[derive(Debug, Serialize)]
pub struct RecallResponse {
    pub results: Vec<RecallResult>,
    pub total: usize,
    /// LOW-7: Count of matches whose blob download / MYDATA decrypt / UTF-8 decode
    /// failed and were silently omitted from `results`. Zero on the happy path.
    #[serde(default, skip_serializing_if = "is_zero_usize")]
    pub dropped_count: usize,
}

fn is_zero_usize(n: &usize) -> bool {
    *n == 0
}

#[derive(Debug, Serialize)]
pub struct RecallResult {
    pub blob_id: String,
    pub text: String,
    pub distance: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub blob_id: String,
    pub distance: f64,
    pub created_at: Option<chrono::DateTime<chrono::Utc>>,
    pub importance: f32,
}

/// POST /api/remember — async job accepted (202)
#[derive(Debug, Serialize)]
pub struct RememberAcceptedResponse {
    pub job_id: String,
    pub status: String,
}

/// GET /api/remember/:job_id
#[derive(Debug, Serialize)]
pub struct RememberJobStatusResponse {
    pub job_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blob_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub agent_object_id: String,
}

/// POST /api/remember/bulk
#[derive(Debug, Deserialize)]
pub struct RememberBulkRequest {
    pub texts: Vec<String>,
    #[serde(default, alias = "sub_label")]
    pub namespace: String,
}

#[derive(Debug, Serialize)]
pub struct RememberBulkAcceptedResponse {
    pub job_ids: Vec<String>,
    pub status: String,
}

/// POST /api/remember/bulk/status
#[derive(Debug, Deserialize)]
pub struct RememberBulkStatusRequest {
    pub job_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct RememberBulkStatusItem {
    pub job_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blob_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RememberBulkStatusResponse {
    pub jobs: Vec<RememberBulkStatusItem>,
}



/// POST /api/analyze
/// Extract facts from conversation text using LLM, then remember each fact
/// Owner is derived from delegate key via onchain verification (auth middleware)
#[derive(Debug, Deserialize)]
pub struct AnalyzeRequest {
    /// Conversation text to analyze for memorable facts
    pub text: String,
    #[serde(default, alias = "sub_label")]
    pub namespace: String,
}

#[derive(Debug, Serialize)]
pub struct AnalyzedFact {
    pub text: String,
    pub id: String,
    pub blob_id: String,
}

#[derive(Debug, Serialize)]
pub struct AnalyzeResponse {
    pub facts: Vec<AnalyzedFact>,
    pub total: usize,
    pub owner: String,
}

/// POST /api/remember/manual
/// Client sends MYDATA-encrypted data (base64) + pre-computed embedding vector.
/// Server uploads to File Storage via sidecar, then stores the vector ↔ blobId mapping.
#[derive(Debug, Deserialize)]
pub struct RememberManualRequest {
    /// Pre-uploaded File Storage blob ID (client did encrypt + upload externally).
    #[serde(default)]
    pub blob_id: Option<String>,
    /// Base64 MYDATA-encrypted bytes — server uploads when `blob_id` is absent.
    #[serde(default)]
    pub encrypted_data: String,
    pub vector: Vec<f32>,
    #[serde(default, alias = "sub_label")]
    pub namespace: String,
}

#[derive(Debug, Serialize)]
pub struct RememberManualResponse {
    pub id: String,
    pub blob_id: String,
    pub owner: String,
    pub agent_object_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sub_label: Option<String>,
    pub namespace: String,
}

/// POST /api/recall/manual
/// User provides pre-computed query vector.
/// Server returns matching blobIds + distances (no download/decrypt).
#[derive(Debug, Deserialize)]
pub struct RecallManualRequest {
    pub vector: Vec<f32>,
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default, alias = "sub_label")]
    pub namespace: String,
}

#[derive(Debug, Serialize)]
pub struct RecallManualResponse {
    pub results: Vec<SearchHit>,
    pub total: usize,
}

/// POST /api/ask
/// Recall memories + LLM chat — full AI-with-memory demo
#[derive(Debug, Deserialize)]
pub struct AskRequest {
    /// User's question
    pub question: String,
    /// Max memories to inject (default: 5)
    pub limit: Option<usize>,
    #[serde(default, alias = "sub_label")]
    pub namespace: String,
    #[serde(default)]
    pub scoring_weights: Option<crate::ranker::ScoringWeights>,
}

#[derive(Debug, Serialize)]
pub struct AskResponse {
    pub answer: String,
    pub memories_used: usize,
    pub memories: Vec<RecallResult>,
}

/// POST /api/restore
/// Restore a namespace: download blobs from File Storage, decrypt, re-embed, re-index
fn default_restore_limit() -> usize {
    50
}

#[derive(Debug, Deserialize)]
pub struct RestoreRequest {
    #[serde(default, alias = "sub_label")]
    pub namespace: String,
    /// Max blobs to restore (default: 50)
    #[serde(default = "default_restore_limit")]
    pub limit: usize,
}

#[derive(Debug, Serialize)]
pub struct RestoreResponse {
    pub restored: usize,
    pub skipped: usize,
    pub total: usize,
    pub agent_object_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sub_label: Option<String>,
    pub namespace: String,
    pub owner: String,
}

/// Health check
#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub social_server: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sidecar: Option<String>,
}

/// GET /config response (ENG-1697).
///
/// Public deployment parameters the SDK needs to build a MYDATA SessionKey
/// client-side. All fields are non-secret (on-chain / public RPC URL).
#[derive(Debug, Serialize)]
pub struct ConfigResponse {
    #[serde(rename = "packageId")]
    pub package_id: String,
    pub network: String,
    #[serde(rename = "mysoRpcUrl")]
    pub myso_rpc_url: String,
}

// ============================================================
// Sponsor Types
// ============================================================

/// POST /sponsor — validated request body forwarded to sidecar
#[derive(Debug, Deserialize)]
pub struct SponsorRequest {
    pub sender: String,
    #[serde(rename = "transactionBlockKindBytes")]
    pub transaction_block_kind_bytes: String,
}

/// POST /sponsor/execute — validated request body forwarded to sidecar.
/// `sender` is optional — when present it is validated and counted against
/// the per-sender rate limit bucket (same axis as POST /sponsor).
#[derive(Debug, Deserialize)]
pub struct SponsorExecuteRequest {
    pub digest: String,
    pub signature: String,
    /// MySo address of the transaction sender (0x + 64 hex). Optional but
    /// recommended — enables per-sender rate limiting on this endpoint too.
    pub sender: Option<String>,
}

// ============================================================
// Auth Types
// ============================================================

/// Authenticated sub-agent context attached to protected requests.
#[derive(Clone)]
pub struct AuthInfo {
    #[allow(dead_code)]
    pub public_key: String,
    /// Principal owner from the on-chain MemoryAccount.
    pub owner: String,
    /// MemoryAccount object ID.
    pub account_id: String,
    /// SubAgent shared object ID.
    pub agent_object_id: String,
    /// Sub-agent derived MySo address (signer).
    pub derived_address: String,
    /// Capability bitmap from on-chain SubAgent.
    pub capabilities: u64,
    pub approval_required_caps: u64,
    pub max_action_spend: Option<u64>,
    pub platform_scope: Option<String>,
    /// `x-platform-id` header from the client request (when present).
    pub platform_id: Option<String>,
    pub label: String,
    /// Sub-agent private key (hex) for MYDATA decrypt — legacy path.
    pub sub_agent_key: Option<String>,
    /// Exported MYDATA SessionKey (base64 JSON).
    pub mydata_session: Option<String>,
    /// True when owner co-signed this request (approval-gated writes).
    pub owner_co_signed: bool,
}

/// Parse optional sub_label from deprecated namespace field.
pub fn parse_sub_label(namespace: &str) -> Option<String> {
    let trimmed = namespace.trim();
    if trimmed.is_empty() || trimmed == "default" {
        None
    } else {
        Some(trimmed.to_string())
    }
}

impl std::fmt::Debug for AuthInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthInfo")
            .field("public_key", &self.public_key)
            .field("owner", &self.owner)
            .field("account_id", &self.account_id)
            .field("agent_object_id", &self.agent_object_id)
            .field("derived_address", &self.derived_address)
            .field("capabilities", &self.capabilities)
            .field(
                "sub_agent_key",
                &self.sub_agent_key.as_ref().map(|_| "<redacted>"),
            )
            .field(
                "mydata_session",
                &self.mydata_session.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

// ============================================================
// Error
// ============================================================

#[derive(Debug)]
pub enum AppError {
    BadRequest(String),
    #[allow(dead_code)]
    Unauthorized(String),
    Internal(String),
    /// File Storage blob not found (expired or deleted) — triggers cleanup
    BlobNotFound(String),
    /// Rate limit exceeded (HTTP 429)
    #[allow(dead_code)]
    RateLimited(String),
    /// Storage quota exceeded (HTTP 402)
    QuotaExceeded(String),
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppError::BadRequest(msg) => write!(f, "Bad Request: {}", msg),
            AppError::Unauthorized(msg) => write!(f, "Unauthorized: {}", msg),
            AppError::Internal(msg) => write!(f, "Internal Error: {}", msg),
            AppError::BlobNotFound(msg) => write!(f, "Blob Not Found: {}", msg),
            AppError::RateLimited(msg) => write!(f, "Rate Limited: {}", msg),
            AppError::QuotaExceeded(msg) => write!(f, "Quota Exceeded: {}", msg),
        }
    }
}

impl axum::response::IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let (status, message) = match &self {
            AppError::BadRequest(msg) => (axum::http::StatusCode::BAD_REQUEST, msg.clone()),
            AppError::Unauthorized(msg) => (axum::http::StatusCode::UNAUTHORIZED, msg.clone()),
            AppError::Internal(msg) => {
                // SEC: Never leak internal error details to the client.
                // Log the full message server-side with a trace ID so
                // operators can correlate, then return a generic message.
                let trace_id = uuid::Uuid::new_v4().to_string();
                tracing::error!(
                    trace_id = %trace_id,
                    "Internal server error: {}",
                    msg,
                );
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Internal server error (traceId: {})", trace_id),
                )
            }
            AppError::BlobNotFound(msg) => (axum::http::StatusCode::NOT_FOUND, msg.clone()),
            AppError::RateLimited(msg) => (axum::http::StatusCode::TOO_MANY_REQUESTS, msg.clone()),
            AppError::QuotaExceeded(msg) => (axum::http::StatusCode::PAYMENT_REQUIRED, msg.clone()),
        };

        let body = serde_json::json!({ "error": message });
        (status, axum::Json(body)).into_response()
    }
}

// ============================================================
// Sidecar Types (shared by mydata.rs + file-storage.rs)
// ============================================================

/// Error response from the TS sidecar HTTP server
#[derive(Debug, Deserialize)]
pub struct SidecarError {
    pub error: String,
}

// ============================================================
// Unit Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_auth() -> AuthInfo {
        AuthInfo {
            public_key: "aabbccdd".to_string(),
            owner: "0xowner".to_string(),
            account_id: "0xaccount".to_string(),
            agent_object_id: "0xagent".to_string(),
            derived_address: "0xderived".to_string(),
            capabilities: 3,
            approval_required_caps: 0,
            max_action_spend: None,
            platform_scope: None,
            platform_id: None,
            label: "test".to_string(),
            sub_agent_key: None,
            mydata_session: None,
            owner_co_signed: false,
        }
    }

    #[test]
    fn auth_info_debug_redacts_sub_agent_key() {
        let mut auth = sample_auth();
        auth.sub_agent_key = Some("supersecretprivatekeyinhex1234567890abcdef".to_string());

        let debug_str = format!("{:?}", auth);

        assert!(debug_str.contains("<redacted>"), "got: {}", debug_str);
        assert!(!debug_str.contains("supersecretprivatekeyinhex"), "got: {}", debug_str);
        assert!(debug_str.contains("aabbccdd"));
        assert!(debug_str.contains("0xowner"));
        assert!(debug_str.contains("0xaccount"));
    }

    #[test]
    fn auth_info_debug_shows_none_when_no_sub_agent_key() {
        let auth = sample_auth();
        let debug_str = format!("{:?}", auth);
        assert!(debug_str.contains("None"), "expected None in debug: {}", debug_str);
        assert!(!debug_str.contains("<redacted>"));
    }

    #[test]
    fn auth_info_debug_redacts_mydata_session() {
        let mut auth = sample_auth();
        auth.mydata_session = Some(
            "eyJhZGRyZXNzIjoiMHhhYmMiLCJwYWNrYWdlSWQiOiIweGRlZiJ9".to_string(),
        );

        let debug_str = format!("{:?}", auth);
        assert!(debug_str.contains("<redacted>"));
        assert!(!debug_str.contains("eyJhZGRyZXNzIjo"));
    }

    // ── AppError: status code mapping ───────────────────────────────────

    #[test]
    fn app_error_bad_request_status() {
        let err = AppError::BadRequest("test".into());
        let resp = axum::response::IntoResponse::into_response(err);
        assert_eq!(resp.status(), axum::http::StatusCode::BAD_REQUEST);
    }

    #[test]
    fn app_error_unauthorized_status() {
        let err = AppError::Unauthorized("test".into());
        let resp = axum::response::IntoResponse::into_response(err);
        assert_eq!(resp.status(), axum::http::StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn app_error_internal_status() {
        let err = AppError::Internal("secret db connection string".into());
        let resp = axum::response::IntoResponse::into_response(err);
        assert_eq!(resp.status(), axum::http::StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn app_error_internal_redacts_message() {
        let err = AppError::Internal("secret db connection string".into());
        let resp = axum::response::IntoResponse::into_response(err);
        let body_bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let body_str = String::from_utf8(body_bytes.to_vec()).unwrap();
        // Must NOT contain the internal message
        assert!(
            !body_str.contains("secret db connection string"),
            "internal error details leaked to client: {}",
            body_str,
        );
        // Must contain a traceId for correlation
        assert!(
            body_str.contains("traceId"),
            "response should contain traceId: {}",
            body_str,
        );
    }

    #[test]
    fn app_error_blob_not_found_status() {
        let err = AppError::BlobNotFound("test".into());
        let resp = axum::response::IntoResponse::into_response(err);
        assert_eq!(resp.status(), axum::http::StatusCode::NOT_FOUND);
    }

    #[test]
    fn app_error_rate_limited_status() {
        let err = AppError::RateLimited("test".into());
        let resp = axum::response::IntoResponse::into_response(err);
        assert_eq!(resp.status(), axum::http::StatusCode::TOO_MANY_REQUESTS);
    }

    #[test]
    fn app_error_quota_exceeded_status() {
        let err = AppError::QuotaExceeded("test".into());
        let resp = axum::response::IntoResponse::into_response(err);
        assert_eq!(resp.status(), axum::http::StatusCode::PAYMENT_REQUIRED);
    }

    // ── KeyPool: round-robin selection ───────────────────────────────────

    #[test]
    fn key_pool_round_robin() {
        let pool = KeyPool::new(vec![
            "key_a".into(),
            "key_b".into(),
            "key_c".into(),
        ]);

        assert_eq!(pool.next(), Some("key_a"));
        assert_eq!(pool.next(), Some("key_b"));
        assert_eq!(pool.next(), Some("key_c"));
        assert_eq!(pool.next(), Some("key_a")); // wraps around
    }

    #[test]
    fn key_pool_empty_returns_none() {
        let pool = KeyPool::new(vec![]);
        assert_eq!(pool.next(), None);
        assert_eq!(pool.next_index(), None);
        assert!(pool.is_empty());
    }

    #[test]
    fn key_pool_single_key() {
        let pool = KeyPool::new(vec!["only_key".into()]);
        assert_eq!(pool.next(), Some("only_key"));
        assert_eq!(pool.next(), Some("only_key"));
        assert!(!pool.is_empty());
    }

    #[test]
    fn key_pool_next_index_wraps() {
        let pool = KeyPool::new(vec!["a".into(), "b".into()]);
        assert_eq!(pool.next_index(), Some(0));
        assert_eq!(pool.next_index(), Some(1));
        assert_eq!(pool.next_index(), Some(0));
    }

    // ── SponsorRateLimitConfig defaults ─────────────────────────────────

    #[test]
    fn sponsor_rate_limit_default_values() {
        let config = SponsorRateLimitConfig::default();
        assert_eq!(config.per_minute, 10);
        assert_eq!(config.per_hour, 30);
    }

    // ── AppError Display implementations ────────────────────────────────

    #[test]
    fn app_error_display_all_variants() {
        assert!(AppError::BadRequest("x".into()).to_string().contains("Bad Request"));
        assert!(AppError::Unauthorized("x".into()).to_string().contains("Unauthorized"));
        assert!(AppError::Internal("x".into()).to_string().contains("Internal"));
        assert!(AppError::BlobNotFound("x".into()).to_string().contains("Blob Not Found"));
        assert!(AppError::RateLimited("x".into()).to_string().contains("Rate Limited"));
        assert!(AppError::QuotaExceeded("x".into()).to_string().contains("Quota Exceeded"));
    }
}
