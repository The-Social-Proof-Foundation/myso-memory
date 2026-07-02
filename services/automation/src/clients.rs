//! Outbound clients — automation engine never performs authorization; delegates to Phase 1 services.

use crate::Config;

#[derive(Clone)]
pub struct OracleClient {
    http: reqwest::Client,
    base_url: String,
}

#[derive(Debug, serde::Deserialize)]
pub struct PreflightResponse {
    pub allowed: bool,
    pub reason: Option<String>,
    #[serde(default)]
    pub approval_required: bool,
    pub estimated_mist: Option<u64>,
}

impl OracleClient {
    pub fn new(config: &Config) -> Self {
        Self {
            http: reqwest::Client::new(),
            base_url: config.oracle_url.trim_end_matches('/').to_string(),
        }
    }

    pub async fn preflight(
        &self,
        owner: &str,
        agent_object_id: &str,
        estimated_tokens_in: u64,
        estimated_tokens_out: u64,
    ) -> Result<PreflightResponse, String> {
        let body = serde_json::json!({
            "owner": owner,
            "agent_object_id": agent_object_id,
            "estimated_tokens_in": estimated_tokens_in,
            "estimated_tokens_out": estimated_tokens_out,
        });
        let resp = self
            .http
            .post(format!("{}/v1/ai-credit/preflight", self.base_url))
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        resp.json().await.map_err(|e| e.to_string())
    }
}

#[derive(Clone)]
pub struct WorkflowClient {
    http: reqwest::Client,
    base_url: String,
    secret: String,
}

impl WorkflowClient {
    pub fn new(config: &Config) -> Option<Self> {
        Some(Self {
            http: reqwest::Client::new(),
            base_url: config
                .workflow_relayer_url
                .as_ref()?
                .trim_end_matches('/')
                .to_string(),
            secret: config.workflow_sync_secret.clone()?,
        })
    }

    pub async fn ingest_alert(
        &self,
        recipient: &str,
        idempotency_key: &str,
        title: &str,
        body: &str,
        organization_id: Option<&str>,
    ) -> Result<(), String> {
        let payload = serde_json::json!({
            "idempotency_key": idempotency_key,
            "recipient_address": recipient,
            "item_type": "alert",
            "title": title,
            "body": body,
            "payload": {},
            "organization_id": organization_id,
            "source_service": "automation_engine",
        });
        self.http
            .post(format!("{}/internal/workflow/items", self.base_url))
            .header("x-internal-sync-secret", &self.secret)
            .json(&payload)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn ingest_scheduled_job_failure(
        &self,
        recipient: &str,
        idempotency_key: &str,
        payload: serde_json::Value,
        organization_id: Option<&str>,
    ) -> Result<(), String> {
        let body = serde_json::json!({
            "idempotency_key": idempotency_key,
            "recipient_address": recipient,
            "item_type": "scheduled_job_failure",
            "title": "Automation job failed",
            "body": payload.get("error").and_then(|v| v.as_str()).unwrap_or("Job failed"),
            "payload": payload,
            "organization_id": organization_id,
            "source_service": "automation_engine",
        });
        self.http
            .post(format!("{}/internal/workflow/items", self.base_url))
            .header("x-internal-sync-secret", &self.secret)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[derive(Clone)]
pub struct AuditClient {
    http: reqwest::Client,
    social_url: String,
    secret: String,
}

impl AuditClient {
    pub fn new(config: &Config) -> Option<Self> {
        Some(Self {
            http: reqwest::Client::new(),
            social_url: config.social_server_url.trim_end_matches('/').to_string(),
            secret: config.audit_sync_secret.clone()?,
        })
    }

    pub async fn push_entry(
        &self,
        action: &str,
        actor_address: &str,
        organization_id: Option<&str>,
        target_id: &str,
        metadata: serde_json::Value,
    ) -> Result<(), String> {
        let entry = serde_json::json!({
            "time": chrono::Utc::now().to_rfc3339(),
            "source": crate::AUDIT_SOURCE_SCHEDULER,
            "actor_address": actor_address,
            "actor_type": "agent",
            "action": action,
            "target_type": "automation_job",
            "target_id": target_id,
            "organization_id": organization_id,
            "metadata": metadata,
        });
        self.http
            .post(format!("{}/internal/audit/logs", self.social_url))
            .header("x-audit-sync-secret", &self.secret)
            .json(&serde_json::json!({ "entries": [entry] }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
