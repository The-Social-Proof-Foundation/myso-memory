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
    /// List jobs for a caller, newest first.
    ///
    /// Scoping is mandatory rather than optional: a job row carries an
    /// organization, an account, and an agent key ref, so an unscoped listing
    /// would hand every caller the tenant inventory.
    async fn list_jobs(&self, filter: JobFilter) -> Result<Vec<AutomationJob>, StoreError>;
    /// Recent runs for one job, newest first.
    async fn list_runs(&self, job_id: Uuid, limit: i64) -> Result<Vec<RunSummary>, StoreError>;
    async fn record_run_start(
        &self,
        job_id: Uuid,
        trigger_set_snapshot: serde_json::Value,
        matched_triggers: serde_json::Value,
        trigger_event_id: Option<String>,
    ) -> Result<Uuid, StoreError>;
    /// Finish a run. `attempts` is how many action attempts were made, so a run
    /// that needed three tries is distinguishable from one that succeeded first
    /// time.
    async fn record_run_finish(
        &self,
        run_id: Uuid,
        status: &str,
        cost_mist: Option<u64>,
        error: Option<String>,
        attempts: u32,
    ) -> Result<(), StoreError>;
    async fn latest_success_at(
        &self,
        job_id: Uuid,
    ) -> Result<Option<chrono::DateTime<chrono::Utc>>, StoreError>;
    /// When the job last *started* a run, whatever its outcome.
    ///
    /// The scheduler measures "is this job due" from here rather than from the
    /// last success. Measuring from success meant a failing or skipped job
    /// (insufficient credit, a bad key ref) was due again on every tick — a
    /// run, an alert and an oracle call every minute, forever.
    async fn latest_run_started_at(
        &self,
        job_id: Uuid,
    ) -> Result<Option<chrono::DateTime<chrono::Utc>>, StoreError>;
    async fn ingest_event_dedup(&self, event: &PlatformEvent) -> Result<bool, StoreError>;

    /// Insert or replace a sealed delegate key for `(account_id, delegate_ref)`.
    async fn put_delegate(&self, record: DelegateRecord) -> Result<(), StoreError>;
    /// Metadata for an account's delegates. Never includes the sealed key.
    async fn list_delegates(&self, account_id: &str) -> Result<Vec<DelegateSummary>, StoreError>;
    /// The sealed key itself, for the bridge.
    async fn get_delegate(
        &self,
        account_id: &str,
        delegate_ref: &str,
    ) -> Result<Option<DelegateRecord>, StoreError>;
    /// Returns whether a row was removed.
    async fn delete_delegate(&self, account_id: &str, delegate_ref: &str)
        -> Result<bool, StoreError>;
}

/// A sealed delegate key. Deliberately not `Debug`: the `sealed` field is
/// ciphertext, but nothing should be one `{:?}` away from printing it.
#[derive(Clone)]
pub struct DelegateRecord {
    pub account_id: String,
    pub delegate_ref: String,
    /// The on-chain `SubAgent` object this key signs as.
    pub agent_object_id: String,
    /// Which bridge seal key the envelope was sealed to, so keys can rotate.
    pub seal_key_id: String,
    pub sealed: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

/// The listable face of a delegate: everything except the sealed key.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DelegateSummary {
    pub delegate_ref: String,
    pub agent_object_id: String,
    pub seal_key_id: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

impl From<&DelegateRecord> for DelegateSummary {
    fn from(r: &DelegateRecord) -> Self {
        Self {
            delegate_ref: r.delegate_ref.clone(),
            agent_object_id: r.agent_object_id.clone(),
            seal_key_id: r.seal_key_id.clone(),
            created_at: r.created_at,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("{0}")]
    Message(String),
}

/// Mandatory scope for a job listing.
///
/// At least one of `organization_id` / `account_id` must be set; an unscoped
/// listing is rejected by [`JobFilter::validate`] rather than silently
/// returning every tenant's jobs.
#[derive(Debug, Clone, Default)]
pub struct JobFilter {
    pub organization_id: Option<String>,
    pub account_id: Option<String>,
    /// Row cap. Clamped to `1..=200`.
    pub limit: i64,
}

/// Default and maximum page sizes for a job listing.
pub const DEFAULT_LIST_LIMIT: i64 = 50;
pub const MAX_LIST_LIMIT: i64 = 200;

impl JobFilter {
    pub fn new(organization_id: Option<String>, account_id: Option<String>, limit: Option<i64>) -> Self {
        Self {
            organization_id: organization_id.filter(|v| !v.trim().is_empty()),
            account_id: account_id.filter(|v| !v.trim().is_empty()),
            limit: limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, MAX_LIST_LIMIT),
        }
    }

    pub fn validate(&self) -> Result<(), StoreError> {
        if self.organization_id.is_none() && self.account_id.is_none() {
            return Err(StoreError::Message(
                "listing jobs requires organization_id or account_id".into(),
            ));
        }
        Ok(())
    }

    fn matches(&self, job: &AutomationJob) -> bool {
        if let Some(ref org) = self.organization_id {
            if &job.organization_id != org {
                return false;
            }
        }
        if let Some(ref account) = self.account_id {
            if &job.account_id != account {
                return false;
            }
        }
        true
    }
}

/// A run row as surfaced to callers. Carries no trigger-set snapshot, which can
/// be large and is not useful to a client.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RunSummary {
    pub id: Uuid,
    pub job_id: Uuid,
    pub status: String,
    pub attempt: i32,
    pub cost_mist: Option<u64>,
    pub error: Option<String>,
    pub started_at: chrono::DateTime<chrono::Utc>,
    pub finished_at: Option<chrono::DateTime<chrono::Utc>>,
}

pub fn memory_store() -> Arc<dyn AutomationStore> {
    Arc::new(InMemoryStore::default())
}

#[derive(Default)]
struct InMemoryStore {
    jobs: RwLock<HashMap<Uuid, AutomationJob>>,
    runs: RwLock<HashMap<Uuid, RunRow>>,
    dedup: RwLock<std::collections::HashSet<String>>,
    delegates: RwLock<HashMap<(String, String), DelegateRecord>>,
}

struct RunRow {
    id: Uuid,
    job_id: Uuid,
    status: String,
    started_at: chrono::DateTime<chrono::Utc>,
    finished_at: Option<chrono::DateTime<chrono::Utc>>,
    attempts: u32,
    cost_mist: Option<u64>,
    error: Option<String>,
}

impl RunRow {
    fn summarize(&self) -> RunSummary {
        RunSummary {
            id: self.id,
            job_id: self.job_id,
            status: self.status.clone(),
            attempt: self.attempts as i32,
            cost_mist: self.cost_mist,
            error: self.error.clone(),
            started_at: self.started_at,
            finished_at: self.finished_at,
        }
    }
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

    async fn list_jobs(&self, filter: JobFilter) -> Result<Vec<AutomationJob>, StoreError> {
        filter.validate()?;
        let mut jobs: Vec<AutomationJob> = self
            .jobs
            .read()
            .await
            .values()
            .filter(|j| filter.matches(j))
            .cloned()
            .collect();
        // Deterministic order so a paginated client sees a stable page.
        jobs.sort_by(|a, b| a.id.cmp(&b.id));
        jobs.truncate(filter.limit.max(0) as usize);
        Ok(jobs)
    }

    async fn list_runs(&self, job_id: Uuid, limit: i64) -> Result<Vec<RunSummary>, StoreError> {
        let runs = self.runs.read().await;
        let mut rows: Vec<RunSummary> = runs
            .values()
            .filter(|row| row.job_id == job_id)
            .map(RunRow::summarize)
            .collect();
        rows.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        rows.truncate(limit.clamp(1, MAX_LIST_LIMIT) as usize);
        Ok(rows)
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
                id: run_id,
                job_id,
                status: "running".into(),
                started_at: chrono::Utc::now(),
                finished_at: None,
                attempts: 1,
                cost_mist: None,
                error: None,
            },
        );
        Ok(run_id)
    }

    async fn record_run_finish(
        &self,
        run_id: Uuid,
        status: &str,
        cost_mist: Option<u64>,
        error: Option<String>,
        attempts: u32,
    ) -> Result<(), StoreError> {
        if let Some(row) = self.runs.write().await.get_mut(&run_id) {
            row.status = status.to_string();
            row.finished_at = Some(chrono::Utc::now());
            row.attempts = attempts;
            row.cost_mist = cost_mist;
            row.error = error;
        }
        Ok(())
    }

    async fn latest_success_at(
        &self,
        job_id: Uuid,
    ) -> Result<Option<chrono::DateTime<chrono::Utc>>, StoreError> {
        let runs = self.runs.read().await;
        Ok(runs
            .values()
            .filter(|row| row.job_id == job_id && row.status == crate::RUN_STATUS_SUCCEEDED)
            .filter_map(|row| row.finished_at)
            .max())
    }

    async fn latest_run_started_at(
        &self,
        job_id: Uuid,
    ) -> Result<Option<chrono::DateTime<chrono::Utc>>, StoreError> {
        let runs = self.runs.read().await;
        Ok(runs
            .values()
            .filter(|row| row.job_id == job_id)
            .map(|row| row.started_at)
            .max())
    }

    async fn ingest_event_dedup(&self, event: &PlatformEvent) -> Result<bool, StoreError> {
        Ok(self.dedup.write().await.insert(event.deduplication_key.clone()))
    }

    async fn put_delegate(&self, record: DelegateRecord) -> Result<(), StoreError> {
        let key = (record.account_id.clone(), record.delegate_ref.clone());
        self.delegates.write().await.insert(key, record);
        Ok(())
    }

    async fn list_delegates(&self, account_id: &str) -> Result<Vec<DelegateSummary>, StoreError> {
        let mut rows: Vec<DelegateSummary> = self
            .delegates
            .read()
            .await
            .values()
            .filter(|r| r.account_id == account_id)
            .map(DelegateSummary::from)
            .collect();
        rows.sort_by(|a, b| a.delegate_ref.cmp(&b.delegate_ref));
        Ok(rows)
    }

    async fn get_delegate(
        &self,
        account_id: &str,
        delegate_ref: &str,
    ) -> Result<Option<DelegateRecord>, StoreError> {
        Ok(self
            .delegates
            .read()
            .await
            .get(&(account_id.to_string(), delegate_ref.to_string()))
            .cloned())
    }

    async fn delete_delegate(
        &self,
        account_id: &str,
        delegate_ref: &str,
    ) -> Result<bool, StoreError> {
        Ok(self
            .delegates
            .write()
            .await
            .remove(&(account_id.to_string(), delegate_ref.to_string()))
            .is_some())
    }
}

/// How long a single connection attempt may take.
///
/// sqlx's default acquire timeout is 30s, which makes a cold-start retry loop
/// spend half its budget on one attempt. Failing faster lets the caller's backoff
/// actually pace the retries, and lets a genuinely unreachable host fail sooner.
const CONNECT_ATTEMPT_TIMEOUT_SECS: u64 = 5;

pub async fn postgres_store(database_url: &str) -> Result<Arc<dyn AutomationStore>, StoreError> {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(std::time::Duration::from_secs(CONNECT_ATTEMPT_TIMEOUT_SECS))
        .connect(database_url)
        .await
        .map_err(|e| StoreError::Message(e.to_string()))?;
    // Every migration is idempotent (IF NOT EXISTS), so all run on every boot.
    for sql in [
        include_str!("../migrations/001_automation.sql"),
        include_str!("../migrations/002_job_owner_address.sql"),
        include_str!("../migrations/003_automation_delegates.sql"),
    ] {
        for stmt in sql.split(';').filter(|s| !s.trim().is_empty()) {
            sqlx::query(stmt.trim())
                .execute(&pool)
                .await
                .map_err(|e| StoreError::Message(e.to_string()))?;
        }
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
               (id, organization_id, account_id, owner_address, name, enabled, trigger_set,
                target_agent_object_id, target_agent_key_ref, action, memory_scope,
                max_mist_per_run, retry_policy)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)"#,
        )
        .bind(job.id)
        .bind(&job.organization_id)
        .bind(&job.account_id)
        .bind(&job.owner_address)
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
            r#"SELECT id, organization_id, account_id, owner_address, name, enabled, trigger_set,
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
            r#"SELECT id, organization_id, account_id, owner_address, name, enabled, trigger_set,
                      target_agent_object_id, target_agent_key_ref, action, memory_scope,
                      max_mist_per_run, retry_policy
               FROM automation_jobs WHERE enabled = true"#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| StoreError::Message(e.to_string()))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    async fn list_jobs(&self, filter: JobFilter) -> Result<Vec<AutomationJob>, StoreError> {
        filter.validate()?;
        // Optional filters as NULL-tolerant predicates, so one query serves
        // every scope combination without string-building SQL.
        let rows = sqlx::query_as::<_, JobRow>(
            r#"SELECT id, organization_id, account_id, owner_address, name, enabled, trigger_set,
                      target_agent_object_id, target_agent_key_ref, action, memory_scope,
                      max_mist_per_run, retry_policy
               FROM automation_jobs
               WHERE ($1::text IS NULL OR organization_id = $1)
                 AND ($2::text IS NULL OR account_id = $2)
               ORDER BY created_at DESC
               LIMIT $3"#,
        )
        .bind(filter.organization_id.as_deref())
        .bind(filter.account_id.as_deref())
        .bind(filter.limit)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| StoreError::Message(e.to_string()))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    async fn list_runs(&self, job_id: Uuid, limit: i64) -> Result<Vec<RunSummary>, StoreError> {
        let rows = sqlx::query_as::<_, PgRunRow>(
            r#"SELECT id, job_id, status, attempt, cost_mist, error, started_at, finished_at
               FROM automation_runs
               WHERE job_id = $1
               ORDER BY started_at DESC
               LIMIT $2"#,
        )
        .bind(job_id)
        .bind(limit.clamp(1, MAX_LIST_LIMIT))
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
        attempts: u32,
    ) -> Result<(), StoreError> {
        sqlx::query(
            r#"UPDATE automation_runs
               SET status = $2, cost_mist = $3, error = $4, attempt = $5, finished_at = NOW()
               WHERE id = $1"#,
        )
        .bind(run_id)
        .bind(status)
        .bind(cost_mist.map(|v| v as i64))
        .bind(error)
        .bind(attempts as i32)
        .execute(&self.pool)
        .await
        .map_err(|e| StoreError::Message(e.to_string()))?;
        Ok(())
    }

    async fn latest_success_at(
        &self,
        job_id: Uuid,
    ) -> Result<Option<chrono::DateTime<chrono::Utc>>, StoreError> {
        sqlx::query_scalar(
            r#"SELECT MAX(finished_at) FROM automation_runs
               WHERE job_id = $1 AND status = 'succeeded'"#,
        )
        .bind(job_id)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| StoreError::Message(e.to_string()))
    }

    async fn latest_run_started_at(
        &self,
        job_id: Uuid,
    ) -> Result<Option<chrono::DateTime<chrono::Utc>>, StoreError> {
        sqlx::query_scalar(r#"SELECT MAX(started_at) FROM automation_runs WHERE job_id = $1"#)
            .bind(job_id)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| StoreError::Message(e.to_string()))
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

    async fn put_delegate(&self, record: DelegateRecord) -> Result<(), StoreError> {
        sqlx::query(
            r#"INSERT INTO automation_delegates
               (account_id, delegate_ref, agent_object_id, seal_key_id, sealed)
               VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (account_id, delegate_ref) DO UPDATE SET
                   agent_object_id = EXCLUDED.agent_object_id,
                   seal_key_id = EXCLUDED.seal_key_id,
                   sealed = EXCLUDED.sealed,
                   created_at = NOW()"#,
        )
        .bind(&record.account_id)
        .bind(&record.delegate_ref)
        .bind(&record.agent_object_id)
        .bind(&record.seal_key_id)
        .bind(&record.sealed)
        .execute(&self.pool)
        .await
        .map_err(|e| StoreError::Message(e.to_string()))?;
        Ok(())
    }

    async fn list_delegates(&self, account_id: &str) -> Result<Vec<DelegateSummary>, StoreError> {
        // The sealed column is deliberately not selected.
        let rows = sqlx::query_as::<_, PgDelegateSummary>(
            r#"SELECT delegate_ref, agent_object_id, seal_key_id, created_at
               FROM automation_delegates WHERE account_id = $1
               ORDER BY delegate_ref"#,
        )
        .bind(account_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| StoreError::Message(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|r| DelegateSummary {
                delegate_ref: r.delegate_ref,
                agent_object_id: r.agent_object_id,
                seal_key_id: r.seal_key_id,
                created_at: r.created_at,
            })
            .collect())
    }

    async fn get_delegate(
        &self,
        account_id: &str,
        delegate_ref: &str,
    ) -> Result<Option<DelegateRecord>, StoreError> {
        let row = sqlx::query_as::<_, PgDelegateRecord>(
            r#"SELECT account_id, delegate_ref, agent_object_id, seal_key_id, sealed, created_at
               FROM automation_delegates WHERE account_id = $1 AND delegate_ref = $2"#,
        )
        .bind(account_id)
        .bind(delegate_ref)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| StoreError::Message(e.to_string()))?;
        Ok(row.map(|r| DelegateRecord {
            account_id: r.account_id,
            delegate_ref: r.delegate_ref,
            agent_object_id: r.agent_object_id,
            seal_key_id: r.seal_key_id,
            sealed: r.sealed,
            created_at: r.created_at,
        }))
    }

    async fn delete_delegate(
        &self,
        account_id: &str,
        delegate_ref: &str,
    ) -> Result<bool, StoreError> {
        let result = sqlx::query(
            r#"DELETE FROM automation_delegates WHERE account_id = $1 AND delegate_ref = $2"#,
        )
        .bind(account_id)
        .bind(delegate_ref)
        .execute(&self.pool)
        .await
        .map_err(|e| StoreError::Message(e.to_string()))?;
        Ok(result.rows_affected() > 0)
    }
}

#[derive(sqlx::FromRow)]
struct PgDelegateSummary {
    delegate_ref: String,
    agent_object_id: String,
    seal_key_id: String,
    created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(sqlx::FromRow)]
struct PgDelegateRecord {
    account_id: String,
    delegate_ref: String,
    agent_object_id: String,
    seal_key_id: String,
    sealed: String,
    created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(sqlx::FromRow)]
struct JobRow {
    id: Uuid,
    organization_id: String,
    account_id: String,
    owner_address: String,
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
            owner_address: row.owner_address,
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

#[derive(sqlx::FromRow)]
struct PgRunRow {
    id: Uuid,
    job_id: Uuid,
    status: String,
    attempt: i32,
    cost_mist: Option<i64>,
    error: Option<String>,
    started_at: chrono::DateTime<chrono::Utc>,
    finished_at: Option<chrono::DateTime<chrono::Utc>>,
}

impl From<PgRunRow> for RunSummary {
    fn from(row: PgRunRow) -> Self {
        Self {
            id: row.id,
            job_id: row.job_id,
            status: row.status,
            attempt: row.attempt,
            // Negative cost is not meaningful; treat it as absent rather than
            // wrapping into a huge u64.
            cost_mist: row.cost_mist.and_then(|v| u64::try_from(v).ok()),
            error: row.error,
            started_at: row.started_at,
            finished_at: row.finished_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        JobAction, JobActionKind, MatchMode, RetryPolicy, TriggerSet, RUN_STATUS_SKIPPED,
        RUN_STATUS_SUCCEEDED,
    };

    fn job(org: &str, account: &str) -> AutomationJob {
        AutomationJob {
            id: Uuid::new_v4(),
            organization_id: org.into(),
            account_id: account.into(),
            owner_address: "0xowner".into(),
            name: "test job".into(),
            enabled: true,
            trigger_set: TriggerSet {
                match_mode: MatchMode::Any,
                evaluation_window_ms: 0,
                triggers: vec![],
            },
            target_agent_object_id: "0xagent".into(),
            target_agent_key_ref: "demo-agent".into(),
            action: JobAction {
                kind: JobActionKind::MemoryRelayerCall,
                config: serde_json::json!({ "query": "preferences" }),
            },
            memory_scope: "chat-app".into(),
            max_mist_per_run: 0,
            retry_policy: RetryPolicy::default(),
        }
    }

    #[test]
    fn filter_requires_a_scope() {
        let err = JobFilter::new(None, None, None).validate().unwrap_err();
        assert!(err.to_string().contains("organization_id or account_id"));
    }

    #[test]
    fn filter_treats_blank_scope_as_absent() {
        assert!(JobFilter::new(Some("  ".into()), None, None).validate().is_err());
        assert!(JobFilter::new(None, Some("".into()), None).validate().is_err());
        assert!(JobFilter::new(Some("0xorg".into()), None, None).validate().is_ok());
    }

    #[test]
    fn filter_clamps_the_limit() {
        assert_eq!(JobFilter::new(Some("o".into()), None, None).limit, DEFAULT_LIST_LIMIT);
        assert_eq!(JobFilter::new(Some("o".into()), None, Some(0)).limit, 1);
        assert_eq!(JobFilter::new(Some("o".into()), None, Some(-5)).limit, 1);
        assert_eq!(
            JobFilter::new(Some("o".into()), None, Some(10_000)).limit,
            MAX_LIST_LIMIT
        );
    }

    #[test]
    fn filter_matches_on_org_and_account() {
        let j = job("0xorg-a", "0xacct-a");
        assert!(JobFilter::new(Some("0xorg-a".into()), None, None).matches(&j));
        assert!(!JobFilter::new(Some("0xorg-b".into()), None, None).matches(&j));
        assert!(JobFilter::new(None, Some("0xacct-a".into()), None).matches(&j));
        assert!(!JobFilter::new(None, Some("0xacct-b".into()), None).matches(&j));
        // Both must hold when both are given.
        assert!(JobFilter::new(Some("0xorg-a".into()), Some("0xacct-a".into()), None).matches(&j));
        assert!(!JobFilter::new(Some("0xorg-a".into()), Some("0xacct-b".into()), None).matches(&j));
    }

    #[tokio::test]
    async fn in_memory_listing_is_scoped_and_rejects_an_empty_scope() {
        let store = memory_store();
        store.create_job(job("0xorg-a", "0xacct-a")).await.unwrap();
        store.create_job(job("0xorg-b", "0xacct-b")).await.unwrap();

        let a = store
            .list_jobs(JobFilter::new(Some("0xorg-a".into()), None, None))
            .await
            .unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].organization_id, "0xorg-a");

        assert!(store
            .list_jobs(JobFilter::new(None, None, None))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn in_memory_listing_honours_the_limit() {
        let store = memory_store();
        for _ in 0..5 {
            store.create_job(job("0xorg-a", "0xacct-a")).await.unwrap();
        }
        let page = store
            .list_jobs(JobFilter::new(Some("0xorg-a".into()), None, Some(2)))
            .await
            .unwrap();
        assert_eq!(page.len(), 2);
    }

    #[tokio::test]
    async fn run_history_records_status_attempts_and_cost() {
        let store = memory_store();
        let j = job("0xorg-a", "0xacct-a");
        let job_id = store.create_job(j).await.unwrap().id;

        let run_id = store
            .record_run_start(job_id, serde_json::json!({}), serde_json::json!([0]), None)
            .await
            .unwrap();

        // A run in flight reads back as running with no finish time.
        let running = store.list_runs(job_id, 10).await.unwrap();
        assert_eq!(running.len(), 1);
        assert_eq!(running[0].status, "running");
        assert!(running[0].finished_at.is_none());

        store
            .record_run_finish(run_id, RUN_STATUS_SUCCEEDED, Some(42), None, 3)
            .await
            .unwrap();

        let finished = store.list_runs(job_id, 10).await.unwrap();
        assert_eq!(finished[0].status, RUN_STATUS_SUCCEEDED);
        assert_eq!(finished[0].attempt, 3);
        assert_eq!(finished[0].cost_mist, Some(42));
        assert!(finished[0].finished_at.is_some());
    }

    #[tokio::test]
    async fn run_history_is_scoped_to_one_job() {
        let store = memory_store();
        let first = store.create_job(job("0xorg-a", "0xacct-a")).await.unwrap().id;
        let second = store.create_job(job("0xorg-a", "0xacct-a")).await.unwrap().id;

        store
            .record_run_start(first, serde_json::json!({}), serde_json::json!([]), None)
            .await
            .unwrap();
        store
            .record_run_start(second, serde_json::json!({}), serde_json::json!([]), None)
            .await
            .unwrap();

        assert_eq!(store.list_runs(first, 10).await.unwrap().len(), 1);
        assert_eq!(store.list_runs(second, 10).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_skipped_run_records_its_reason() {
        let store = memory_store();
        let job_id = store.create_job(job("0xorg-a", "0xacct-a")).await.unwrap().id;
        let run_id = store
            .record_run_start(job_id, serde_json::json!({}), serde_json::json!([]), None)
            .await
            .unwrap();

        store
            .record_run_finish(
                run_id,
                RUN_STATUS_SKIPPED,
                Some(100),
                Some("estimated 100 mist exceeds max_mist_per_run of 50".into()),
                1,
            )
            .await
            .unwrap();

        let runs = store.list_runs(job_id, 10).await.unwrap();
        assert_eq!(runs[0].status, RUN_STATUS_SKIPPED);
        assert!(runs[0].error.as_deref().unwrap().contains("max_mist_per_run"));
    }

    #[tokio::test]
    async fn a_skipped_run_counts_as_an_attempt_but_not_a_success() {
        // The scheduler measures "due" from the last attempt. Measuring from the
        // last success made a skipped or failing job due on every tick.
        let store = memory_store();
        let job_id = store.create_job(job("0xorg-a", "0xacct-a")).await.unwrap().id;
        assert!(store.latest_run_started_at(job_id).await.unwrap().is_none());

        let run_id = store
            .record_run_start(job_id, serde_json::json!({}), serde_json::json!([]), None)
            .await
            .unwrap();
        store
            .record_run_finish(run_id, RUN_STATUS_SKIPPED, None, Some("no credit".into()), 1)
            .await
            .unwrap();

        assert!(store.latest_success_at(job_id).await.unwrap().is_none());
        assert!(store.latest_run_started_at(job_id).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn latest_run_started_at_is_scoped_to_one_job() {
        let store = memory_store();
        let first = store.create_job(job("0xorg-a", "0xacct-a")).await.unwrap().id;
        let second = store.create_job(job("0xorg-a", "0xacct-a")).await.unwrap().id;
        store
            .record_run_start(first, serde_json::json!({}), serde_json::json!([]), None)
            .await
            .unwrap();
        assert!(store.latest_run_started_at(first).await.unwrap().is_some());
        assert!(store.latest_run_started_at(second).await.unwrap().is_none());
    }

    fn delegate(account: &str, name: &str) -> DelegateRecord {
        DelegateRecord {
            account_id: account.into(),
            delegate_ref: name.into(),
            agent_object_id: "0xagent".into(),
            seal_key_id: "k1".into(),
            sealed: "ciphertext".into(),
            created_at: chrono::Utc::now(),
        }
    }

    #[tokio::test]
    async fn delegates_are_scoped_to_their_account() {
        let store = memory_store();
        store.put_delegate(delegate("0xacct-a", "mine")).await.unwrap();
        store.put_delegate(delegate("0xacct-b", "theirs")).await.unwrap();

        let a = store.list_delegates("0xacct-a").await.unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].delegate_ref, "mine");

        // Another account cannot read, or guess its way to, this sealed key.
        assert!(store.get_delegate("0xacct-b", "mine").await.unwrap().is_none());
        assert!(store.get_delegate("0xacct-a", "mine").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn the_delegate_listing_never_carries_the_sealed_key() {
        let store = memory_store();
        store.put_delegate(delegate("0xacct-a", "mine")).await.unwrap();
        let listing = store.list_delegates("0xacct-a").await.unwrap();
        let json = serde_json::to_string(&listing).unwrap();
        assert!(!json.contains("ciphertext"), "{json}");
        assert!(!json.contains("sealed"), "{json}");
    }

    #[tokio::test]
    async fn putting_a_delegate_again_replaces_it() {
        let store = memory_store();
        store.put_delegate(delegate("0xacct-a", "mine")).await.unwrap();
        let mut rotated = delegate("0xacct-a", "mine");
        rotated.sealed = "rotated".into();
        store.put_delegate(rotated).await.unwrap();
        let got = store.get_delegate("0xacct-a", "mine").await.unwrap().unwrap();
        assert_eq!(got.sealed, "rotated");
        assert_eq!(store.list_delegates("0xacct-a").await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn deleting_a_delegate_reports_whether_it_existed() {
        let store = memory_store();
        store.put_delegate(delegate("0xacct-a", "mine")).await.unwrap();
        assert!(store.delete_delegate("0xacct-a", "mine").await.unwrap());
        assert!(!store.delete_delegate("0xacct-a", "mine").await.unwrap());
        assert!(!store.delete_delegate("0xacct-b", "mine").await.unwrap());
    }

    #[test]
    fn negative_cost_from_postgres_reads_as_absent() {
        let row = PgRunRow {
            id: Uuid::new_v4(),
            job_id: Uuid::new_v4(),
            status: "succeeded".into(),
            attempt: 1,
            cost_mist: Some(-1),
            error: None,
            started_at: chrono::Utc::now(),
            finished_at: None,
        };
        assert_eq!(RunSummary::from(row).cost_mist, None);
    }
}
