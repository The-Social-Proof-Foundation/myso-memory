//! Job and run persistence. Postgres when DATABASE_URL is set; in-memory fallback for dev/tests.

use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::{
    AutomationJob, JobAction, JobActionKind, PlatformEvent, TriggerSet,
};

#[async_trait]
pub trait AutomationStore: Send + Sync {
    async fn create_job(&self, job: AutomationJob) -> Result<AutomationJob, StoreError>;
    async fn get_job(&self, id: Uuid) -> Result<Option<AutomationJob>, StoreError>;
    async fn list_enabled_jobs(&self) -> Result<Vec<AutomationJob>, StoreError>;
    async fn record_run_start(
        &self,
        job_id: Uuid,
        trigger_set_snapshot: serde_json::Value,
        matched_triggers: serde_json::Value,
        trigger_event_id: Option<String>,
    ) -> Result<Uuid, StoreError>;
    async fn record_run_finish(
        &self,
        run_id: Uuid,
        status: &str,
        cost_mist: Option<u64>,
        error: Option<String>,
    ) -> Result<(), StoreError>;
    async fn ingest_event_dedup(&self, event: &PlatformEvent) -> Result<bool, StoreError>;
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("{0}")]
    Message(String),
}

pub fn memory_store() -> Arc<dyn AutomationStore> {
    Arc::new(InMemoryStore::default())
}

#[derive(Default)]
struct InMemoryStore {
    jobs: RwLock<HashMap<Uuid, AutomationJob>>,
    runs: RwLock<HashMap<Uuid, RunRow>>,
    dedup: RwLock<std::collections::HashSet<String>>,
}

struct RunRow {
    status: String,
}

#[async_trait]
impl AutomationStore for InMemoryStore {
    async fn create_job(&self, job: AutomationJob) -> Result<AutomationJob, StoreError> {
        self.jobs.write().await.insert(job.id, job.clone());
        Ok(job)
    }

    async fn get_job(&self, id: Uuid) -> Result<Option<AutomationJob>, StoreError> {
        Ok(self.jobs.read().await.get(&id).cloned())
    }

    async fn list_enabled_jobs(&self) -> Result<Vec<AutomationJob>, StoreError> {
        Ok(self
            .jobs
            .read()
            .await
            .values()
            .filter(|j| j.enabled)
            .cloned()
            .collect())
    }

    async fn record_run_start(
        &self,
        job_id: Uuid,
        _trigger_set_snapshot: serde_json::Value,
        _matched_triggers: serde_json::Value,
        _trigger_event_id: Option<String>,
    ) -> Result<Uuid, StoreError> {
        let run_id = Uuid::new_v4();
        self.runs.write().await.insert(
            run_id,
            RunRow {
                status: "running".into(),
            },
        );
        Ok(run_id)
    }

    async fn record_run_finish(
        &self,
        run_id: Uuid,
        status: &str,
        _cost_mist: Option<u64>,
        _error: Option<String>,
    ) -> Result<(), StoreError> {
        if let Some(row) = self.runs.write().await.get_mut(&run_id) {
            row.status = status.to_string();
        }
        Ok(())
    }

    async fn ingest_event_dedup(&self, event: &PlatformEvent) -> Result<bool, StoreError> {
        Ok(self.dedup.write().await.insert(event.deduplication_key.clone()))
    }
}

pub async fn postgres_store(database_url: &str) -> Result<Arc<dyn AutomationStore>, StoreError> {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(database_url)
        .await
        .map_err(|e| StoreError::Message(e.to_string()))?;
    let sql = include_str!("../migrations/001_automation.sql");
    for stmt in sql.split(';').filter(|s| !s.trim().is_empty()) {
        sqlx::query(stmt.trim())
            .execute(&pool)
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
    }
    Ok(Arc::new(PgStore { pool }))
}

struct PgStore {
    pool: sqlx::PgPool,
}

#[async_trait]
impl AutomationStore for PgStore {
    async fn create_job(&self, job: AutomationJob) -> Result<AutomationJob, StoreError> {
        sqlx::query(
            r#"INSERT INTO automation_jobs
               (id, organization_id, account_id, name, enabled, trigger_set,
                target_agent_object_id, target_agent_key_ref, action, memory_scope,
                max_mist_per_run, retry_policy)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)"#,
        )
        .bind(job.id)
        .bind(&job.organization_id)
        .bind(&job.account_id)
        .bind(&job.name)
        .bind(job.enabled)
        .bind(serde_json::to_value(&job.trigger_set).map_err(|e| StoreError::Message(e.to_string()))?)
        .bind(&job.target_agent_object_id)
        .bind(&job.target_agent_key_ref)
        .bind(serde_json::to_value(&job.action).map_err(|e| StoreError::Message(e.to_string()))?)
        .bind(&job.memory_scope)
        .bind(job.max_mist_per_run as i64)
        .bind(serde_json::to_value(&job.retry_policy).map_err(|e| StoreError::Message(e.to_string()))?)
        .execute(&self.pool)
        .await
        .map_err(|e| StoreError::Message(e.to_string()))?;
        Ok(job)
    }

    async fn get_job(&self, id: Uuid) -> Result<Option<AutomationJob>, StoreError> {
        let row = sqlx::query_as::<_, JobRow>(
            r#"SELECT id, organization_id, account_id, name, enabled, trigger_set,
                      target_agent_object_id, target_agent_key_ref, action, memory_scope,
                      max_mist_per_run, retry_policy
               FROM automation_jobs WHERE id = $1"#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| StoreError::Message(e.to_string()))?;
        Ok(row.map(Into::into))
    }

    async fn list_enabled_jobs(&self) -> Result<Vec<AutomationJob>, StoreError> {
        let rows = sqlx::query_as::<_, JobRow>(
            r#"SELECT id, organization_id, account_id, name, enabled, trigger_set,
                      target_agent_object_id, target_agent_key_ref, action, memory_scope,
                      max_mist_per_run, retry_policy
               FROM automation_jobs WHERE enabled = true"#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| StoreError::Message(e.to_string()))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    async fn record_run_start(
        &self,
        job_id: Uuid,
        trigger_set_snapshot: serde_json::Value,
        matched_triggers: serde_json::Value,
        trigger_event_id: Option<String>,
    ) -> Result<Uuid, StoreError> {
        let run_id = Uuid::new_v4();
        sqlx::query(
            r#"INSERT INTO automation_runs
               (id, job_id, trigger_set_snapshot, matched_triggers, trigger_event_id, status)
               VALUES ($1,$2,$3,$4,$5,'running')"#,
        )
        .bind(run_id)
        .bind(job_id)
        .bind(trigger_set_snapshot)
        .bind(matched_triggers)
        .bind(trigger_event_id)
        .execute(&self.pool)
        .await
        .map_err(|e| StoreError::Message(e.to_string()))?;
        Ok(run_id)
    }

    async fn record_run_finish(
        &self,
        run_id: Uuid,
        status: &str,
        cost_mist: Option<u64>,
        error: Option<String>,
    ) -> Result<(), StoreError> {
        sqlx::query(
            r#"UPDATE automation_runs
               SET status = $2, cost_mist = $3, error = $4, finished_at = NOW()
               WHERE id = $1"#,
        )
        .bind(run_id)
        .bind(status)
        .bind(cost_mist.map(|v| v as i64))
        .bind(error)
        .execute(&self.pool)
        .await
        .map_err(|e| StoreError::Message(e.to_string()))?;
        Ok(())
    }

    async fn ingest_event_dedup(&self, event: &PlatformEvent) -> Result<bool, StoreError> {
        let result = sqlx::query(
            r#"INSERT INTO automation_ingested_events (deduplication_key, event_family, event_type, envelope)
               VALUES ($1,$2,$3,$4)
               ON CONFLICT (deduplication_key) DO NOTHING"#,
        )
        .bind(&event.deduplication_key)
        .bind(&event.event_family)
        .bind(&event.event_type)
        .bind(serde_json::to_value(event).map_err(|e| StoreError::Message(e.to_string()))?)
        .execute(&self.pool)
        .await
        .map_err(|e| StoreError::Message(e.to_string()))?;
        Ok(result.rows_affected() > 0)
    }
}

#[derive(sqlx::FromRow)]
struct JobRow {
    id: Uuid,
    organization_id: String,
    account_id: String,
    name: String,
    enabled: bool,
    trigger_set: serde_json::Value,
    target_agent_object_id: String,
    target_agent_key_ref: String,
    action: serde_json::Value,
    memory_scope: String,
    max_mist_per_run: i64,
    retry_policy: serde_json::Value,
}

impl From<JobRow> for AutomationJob {
    fn from(row: JobRow) -> Self {
        Self {
            id: row.id,
            organization_id: row.organization_id,
            account_id: row.account_id,
            name: row.name,
            enabled: row.enabled,
            trigger_set: serde_json::from_value(row.trigger_set).unwrap_or(TriggerSet {
                match_mode: crate::MatchMode::Any,
                evaluation_window_ms: 0,
                triggers: vec![],
            }),
            target_agent_object_id: row.target_agent_object_id,
            target_agent_key_ref: row.target_agent_key_ref,
            action: serde_json::from_value(row.action).unwrap_or(JobAction {
                kind: JobActionKind::MemoryRelayerCall,
                config: serde_json::json!({}),
            }),
            memory_scope: row.memory_scope,
            max_mist_per_run: row.max_mist_per_run.max(0) as u64,
            retry_policy: serde_json::from_value(row.retry_policy).unwrap_or_default(),
        }
    }
}
