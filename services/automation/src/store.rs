//! Job and run persistence. Postgres when DATABASE_URL is set; in-memory fallback for dev/tests.

use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

use crate::{AutomationJob, JobAction, JobActionKind, MatchMode, PlatformEvent, TriggerSet};

/// Select the trailing-edge debounce used by one matching event. ANY sets debounce
/// only when every matching trigger is configured for it; an immediate matching
/// trigger keeps the set immediate. ALL sets use the longest configured interval.
fn trigger_debounce_for_event(trigger_set: &TriggerSet, event: &PlatformEvent) -> Option<i64> {
    let matching: Vec<_> = trigger_set
        .triggers
        .iter()
        .filter(|trigger| crate::trigger_eval::event_matches_trigger(event, trigger))
        .collect();
    if matching.is_empty() {
        return None;
    }
    if trigger_set.match_mode == MatchMode::Any
        && matching
            .iter()
            .any(|trigger| trigger.debounce_window_ms == 0)
    {
        return None;
    }
    let configured = if trigger_set.match_mode == MatchMode::All {
        trigger_set
            .triggers
            .iter()
            .map(|trigger| trigger.debounce_window_ms)
            .max()
    } else {
        matching
            .iter()
            .map(|trigger| trigger.debounce_window_ms)
            .max()
    }?;
    if configured <= 0 {
        return None;
    }
    Some(configured)
}

#[async_trait]
pub trait AutomationStore: Send + Sync {
    /// Acquire the singleton scheduler tick lease. The caller supplies a fresh
    /// fencing token for this tick; a live lease held by another token wins.
    async fn acquire_scheduler_lease(
        &self,
        token: Uuid,
        lease_secs: u64,
    ) -> Result<bool, StoreError>;
    /// Renew only the currently live lease owned by `token`.
    async fn renew_scheduler_lease(&self, token: Uuid, lease_secs: u64)
        -> Result<bool, StoreError>;
    async fn release_scheduler_lease(&self, token: Uuid) -> Result<(), StoreError>;
    async fn create_job(&self, job: AutomationJob) -> Result<AutomationJob, StoreError>;
    /// Create once per organization/account/owner/agent request key. Replays
    /// return the original job; reusing a key with changed input is rejected.
    async fn create_job_idempotent(
        &self,
        job: AutomationJob,
        request_key: Uuid,
        request_hash: &[u8],
    ) -> Result<(AutomationJob, bool), StoreError>;
    /// Permanently remove an idle job and its cascaded history. Refuses jobs
    /// with an active run or an event delivery whose external result may be unknown.
    async fn delete_job(&self, id: Uuid, expected_version: u64) -> Result<bool, StoreError>;
    async fn get_job(&self, id: Uuid) -> Result<Option<AutomationJob>, StoreError>;
    async fn rename_job(
        &self,
        id: Uuid,
        expected_version: u64,
        name: &str,
    ) -> Result<Option<AutomationJob>, StoreError>;
    /// Replace triggers/action policy only while paused and with no active or uncertain work.
    async fn update_job_configuration(
        &self,
        id: Uuid,
        expected_version: u64,
        trigger_set: TriggerSet,
        action: JobAction,
    ) -> Result<Option<AutomationJob>, StoreError>;
    async fn set_job_archived(
        &self,
        id: Uuid,
        expected_version: u64,
        archived: bool,
    ) -> Result<Option<AutomationJob>, StoreError>;
    async fn set_job_enabled(
        &self,
        id: Uuid,
        expected_version: u64,
        enabled: bool,
    ) -> Result<Option<AutomationJob>, StoreError>;
    /// Disable the job and cancel all deliveries that have not been claimed. A marker makes
    /// deliveries claimed concurrently return to cancelled if they were not dispatched.
    async fn cancel_job_queued_deliveries(
        &self,
        id: Uuid,
        expected_version: u64,
        actor: &str,
        note: &str,
    ) -> Result<Option<JobCancellationResult>, StoreError>;
    async fn list_enabled_jobs(&self) -> Result<Vec<AutomationJob>, StoreError>;
    /// List jobs for a caller, newest first.
    ///
    /// Scoping is mandatory rather than optional: a job row carries an
    /// organization, an account, and an agent key ref, so an unscoped listing
    /// would hand every caller the tenant inventory.
    async fn list_jobs(&self, filter: JobFilter) -> Result<Vec<AutomationJob>, StoreError>;
    /// Recent runs for one job, newest first.
    async fn list_runs(&self, job_id: Uuid, limit: i64) -> Result<Vec<RunSummary>, StoreError>;
    async fn list_runs_page(
        &self,
        job_id: Uuid,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<RunSummary>, StoreError> {
        let limit = limit.clamp(1, MAX_LIST_LIMIT);
        let offset = offset.clamp(0, MAX_LIST_OFFSET);
        Ok(self
            .list_runs(job_id, limit.saturating_add(offset))
            .await?
            .into_iter()
            .skip(offset as usize)
            .take(limit as usize)
            .collect())
    }
    /// Close a stale run that has no event-delivery row. This never replays work.
    async fn resolve_orphan_run(
        &self,
        job_id: Uuid,
        run_id: Uuid,
        resolution: &str,
        actor: &str,
        note: &str,
    ) -> Result<Option<RunSummary>, StoreError>;
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
    /// Last stable cron/interval slot and the time its attempt started; manual and event runs do not move this cursor.
    async fn latest_scheduled_run_cursor(
        &self,
        job_id: Uuid,
    ) -> Result<Option<(String, chrono::DateTime<chrono::Utc>)>, StoreError>;
    /// Whether this event key already started a work-run action, so a safe recovery delivery
    /// does not consume a second cooldown or trigger-cap slot.
    async fn has_run_for_event(&self, job_id: Uuid, event_key: &str) -> Result<bool, StoreError>;
    async fn ingest_event_dedup(&self, event: &PlatformEvent) -> Result<bool, StoreError>;
    /// Enqueue a scheduler event only while this caller still owns the live cron lease.
    async fn ingest_scheduled_event(
        &self,
        event: &PlatformEvent,
        token: Uuid,
    ) -> Result<bool, StoreError>;
    /// Persist matched trigger indices and atomically report whether an ALL set is complete.
    async fn record_all_trigger_matches(
        &self,
        job_id: Uuid,
        event_key: &str,
        matched: &[usize],
        trigger_count: usize,
        window_ms: i64,
        now_ms: i64,
    ) -> Result<bool, StoreError>;
    /// Atomically enforce per-trigger debounce and execution caps for one event dispatch.
    async fn authorize_trigger_fires(
        &self,
        job_id: Uuid,
        event_key: &str,
        policies: &[(usize, i64, Option<u32>)],
        now_ms: i64,
    ) -> Result<bool, StoreError>;
    async fn list_event_deliveries(
        &self,
        job_id: Uuid,
        limit: i64,
    ) -> Result<Vec<EventDeliverySummary>, StoreError>;
    async fn list_event_deliveries_page(
        &self,
        job_id: Uuid,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<EventDeliverySummary>, StoreError> {
        let limit = limit.clamp(1, MAX_LIST_LIMIT);
        let offset = offset.clamp(0, MAX_LIST_OFFSET);
        Ok(self
            .list_event_deliveries(job_id, limit.saturating_add(offset))
            .await?
            .into_iter()
            .skip(offset as usize)
            .take(limit as usize)
            .collect())
    }
    async fn claim_event_delivery(&self) -> Result<Option<EventDeliveryClaim>, StoreError>;
    async fn begin_event_delivery_dispatch(
        &self,
        id: Uuid,
        token: Uuid,
    ) -> Result<bool, StoreError>;
    /// Return a claimed delivery to pending when its job was paused before dispatch.
    async fn defer_event_delivery(&self, id: Uuid, token: Uuid) -> Result<bool, StoreError>;
    /// Requeue a delivery only when the caller proves no action was dispatched, or when the
    /// action is a journaled WorkRun whose stable dispatch identity makes replay safe. Retries
    /// are delayed and bounded; exhausted deliveries enter reconciliation.
    async fn retry_event_delivery(
        &self,
        id: Uuid,
        token: Uuid,
        error: &str,
    ) -> Result<bool, StoreError>;
    async fn renew_event_delivery(&self, id: Uuid, token: Uuid) -> Result<bool, StoreError>;
    async fn finish_event_delivery(
        &self,
        id: Uuid,
        token: Uuid,
        error: Option<String>,
    ) -> Result<bool, StoreError>;
    /// Resolve an uncertain delivery only after an authenticated operator has
    /// established whether the external side effect completed or never ran.
    async fn resolve_event_delivery(
        &self,
        id: Uuid,
        job_id: Uuid,
        resolution: &str,
        actor: &str,
        note: &str,
    ) -> Result<Option<EventDeliverySummary>, StoreError>;
    /// Cancel only a delivery that is still pending. A claimed/running delivery cannot be cancelled.
    async fn cancel_event_delivery(
        &self,
        id: Uuid,
        job_id: Uuid,
        actor: &str,
        note: &str,
    ) -> Result<Option<EventDeliverySummary>, StoreError>;

    /// Insert or replace a encrypted delegate key for `(account_id, delegate_ref)`.
    async fn put_delegate(&self, record: DelegateRecord) -> Result<(), StoreError>;
    /// Append-only metadata history for ciphertext-key changes. Never returns encrypted bytes.
    async fn list_delegate_key_events(
        &self,
        account_id: &str,
        agent_object_id: Option<&str>,
        after: Option<i64>,
        limit: i64,
    ) -> Result<DelegateKeyEventPage, StoreError>;
    /// Bounded, stable delegate metadata page. Never includes the encrypted key.
    async fn list_delegates(
        &self,
        account_id: &str,
        agent_object_id: Option<&str>,
        after: Option<&str>,
        limit: i64,
    ) -> Result<DelegatePage, StoreError>;
    /// Exact metadata lookup for internal identity fences. Never includes the encrypted key.
    async fn get_delegate_summary(
        &self,
        account_id: &str,
        delegate_ref: &str,
    ) -> Result<Option<DelegateSummary>, StoreError>;
    /// The encrypted key itself, for the bridge.
    async fn get_delegate(
        &self,
        account_id: &str,
        delegate_ref: &str,
    ) -> Result<Option<DelegateRecord>, StoreError>;
    /// Atomic identity-fenced deletion for a bounded agent caller.
    async fn delete_delegate_if_agent(
        &self,
        account_id: &str,
        delegate_ref: &str,
        expected_agent: Option<&str>,
    ) -> Result<bool, StoreError>;
    /// Returns whether a row was removed.
    async fn delete_delegate(
        &self,
        account_id: &str,
        delegate_ref: &str,
    ) -> Result<bool, StoreError>;
}

#[derive(Clone, serde::Serialize, sqlx::FromRow)]
pub struct EventDeliverySummary {
    pub id: Uuid,
    pub job_id: Uuid,
    pub event_key: String,
    pub status: String,
    pub attempts: i32,
    pub lease_until: Option<chrono::DateTime<chrono::Utc>>,
    pub error: Option<String>,
    pub resolved_by: Option<String>,
    pub resolution: Option<String>,
    pub resolution_note: Option<String>,
    pub resolution_history: serde_json::Value,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobCancellationResult {
    pub job_id: Uuid,
    pub version: u64,
    pub cancelled_pending: u32,
    pub in_flight: u32,
    pub enabled: bool,
}

#[derive(Clone, serde::Serialize)]
struct DeliveryResolution {
    actor: String,
    resolution: String,
    note: String,
    created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Clone)]
pub struct EventDeliveryClaim {
    pub id: Uuid,
    pub token: Uuid,
    pub job_id: Uuid,
    pub event: PlatformEvent,
}
struct MemoryDelivery {
    claim: EventDeliveryClaim,
    status: String,
    lease_until: Option<chrono::DateTime<chrono::Utc>>,
    attempts: i32,
    available_at: chrono::DateTime<chrono::Utc>,
    debounce_coalescible: bool,
    error: Option<String>,
    resolved_by: Option<String>,
    resolution: Option<String>,
    resolution_note: Option<String>,
    resolution_history: Vec<DeliveryResolution>,
    dispatch_started: bool,
    cancel_request: Option<PendingJobCancellation>,
}

#[derive(Clone)]
struct PendingJobCancellation {
    actor: String,
    note: String,
}

/// A encrypted delegate key. Deliberately not `Debug`: the `encrypted` field is
/// ciphertext, but nothing should be one `{:?}` away from printing it.
#[derive(Clone)]
pub struct DelegateRecord {
    pub account_id: String,
    pub delegate_ref: String,
    /// The on-chain `SubAgent` object this key signs as.
    pub agent_object_id: String,
    /// Which bridge MyData key the envelope was encrypted to, so keys can rotate.
    pub mydata_key_id: String,
    pub encrypted_key: String,
    /// `memory` (read/write memory only) or `task_worker` (memory plus the task market).
    pub delegate_class: String,
    /// Registered actions this delegate may run. Empty for `memory`; task actions only for
    /// `task_worker`. The on-chain capability bits remain the real limit.
    pub allowed_action_ids: Vec<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

/// The listable face of a delegate: everything except the encrypted key.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DelegateSummary {
    pub delegate_ref: String,
    pub agent_object_id: String,
    pub mydata_key_id: String,
    pub delegate_class: String,
    pub allowed_action_ids: Vec<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DelegatePage {
    pub data: Vec<DelegateSummary>,
    pub has_next_page: bool,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DelegateKeyEvent {
    pub id: String,
    pub delegate_ref: String,
    pub agent_object_id: String,
    pub mydata_key_id: String,
    pub event_type: String,
    pub recorded_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DelegateKeyEventPage {
    pub data: Vec<DelegateKeyEvent>,
    pub has_next_page: bool,
    pub next_cursor: Option<String>,
}

pub const DEFAULT_DELEGATE_LIST_LIMIT: i64 = 50;
pub const MAX_DELEGATE_LIST_LIMIT: i64 = 200;

impl From<&DelegateRecord> for DelegateSummary {
    fn from(r: &DelegateRecord) -> Self {
        Self {
            delegate_ref: r.delegate_ref.clone(),
            agent_object_id: r.agent_object_id.clone(),
            mydata_key_id: r.mydata_key_id.clone(),
            delegate_class: r.delegate_class.clone(),
            allowed_action_ids: r.allowed_action_ids.clone(),
            created_at: r.created_at,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("{0}")]
    Message(String),
    #[error("job not found")]
    NotFound,
    #[error("job has active or uncertain work; reconcile it before deleting")]
    Conflict,
    #[error("automation creation idempotency key conflicts with different input")]
    IdempotencyConflict,
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
    pub target_agent_object_id: Option<String>,
    /// Row cap. Clamped to `1..=200`.
    pub limit: i64,
    /// Bounded page offset, clamped to `0..=100000`.
    pub offset: i64,
}

/// Default and maximum page sizes for a job listing.
pub const DEFAULT_LIST_LIMIT: i64 = 50;
pub const MAX_LIST_LIMIT: i64 = 200;
pub const MAX_LIST_OFFSET: i64 = 100_000;
const MAX_SAFE_DELIVERY_ATTEMPTS: i32 = 5;

impl JobFilter {
    pub fn new(
        organization_id: Option<String>,
        account_id: Option<String>,
        limit: Option<i64>,
    ) -> Self {
        Self {
            organization_id: organization_id.filter(|v| !v.trim().is_empty()),
            account_id: account_id.filter(|v| !v.trim().is_empty()),
            target_agent_object_id: None,
            limit: limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, MAX_LIST_LIMIT),
            offset: 0,
        }
    }

    pub fn with_agent(mut self, agent: Option<String>) -> Self {
        self.target_agent_object_id = agent.filter(|value| !value.trim().is_empty());
        self
    }

    pub fn with_offset(mut self, offset: Option<i64>) -> Self {
        self.offset = offset.unwrap_or(0).clamp(0, MAX_LIST_OFFSET);
        self
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
        if let Some(agent) = &self.target_agent_object_id {
            let normalize = |id: &str| {
                format!(
                    "{:0>64}",
                    id.trim()
                        .trim_start_matches("0x")
                        .trim_start_matches("0X")
                        .to_ascii_lowercase()
                )
            };
            if normalize(agent) != normalize(&job.target_agent_object_id) {
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
    scheduler_lease: Mutex<Option<(Uuid, std::time::Instant)>>,
    jobs: RwLock<HashMap<Uuid, AutomationJob>>,
    job_creations: Mutex<HashMap<(String, String, String, String, Uuid), (Vec<u8>, Option<Uuid>)>>,
    runs: RwLock<HashMap<Uuid, RunRow>>,
    dedup: RwLock<std::collections::HashSet<String>>,
    deliveries: RwLock<Vec<MemoryDelivery>>,
    delegates: RwLock<HashMap<(String, String), DelegateRecord>>,
    delegate_key_events: RwLock<Vec<(String, DelegateKeyEvent)>>,
    all_trigger_events: RwLock<HashMap<(Uuid, String), bool>>,
    all_trigger_state: RwLock<HashMap<Uuid, HashMap<usize, i64>>>,
    trigger_fire_state: RwLock<HashMap<(Uuid, usize), TriggerFireState>>,
    trigger_fire_history: RwLock<HashMap<(Uuid, usize), Vec<(i64, String)>>>,
}

#[derive(Clone, Copy, Default)]
struct TriggerFireState {
    last_fired_at_ms: Option<i64>,
}

struct RunRow {
    id: Uuid,
    job_id: Uuid,
    trigger_event_id: Option<String>,
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
    async fn acquire_scheduler_lease(
        &self,
        token: Uuid,
        lease_secs: u64,
    ) -> Result<bool, StoreError> {
        let mut lease = self.scheduler_lease.lock().await;
        let now = std::time::Instant::now();
        if lease.as_ref().is_some_and(|(_, until)| *until > now) {
            return Ok(false);
        }
        *lease = Some((
            token,
            now + std::time::Duration::from_secs(lease_secs.max(1)),
        ));
        Ok(true)
    }

    async fn renew_scheduler_lease(
        &self,
        token: Uuid,
        lease_secs: u64,
    ) -> Result<bool, StoreError> {
        let mut lease = self.scheduler_lease.lock().await;
        let now = std::time::Instant::now();
        match lease.as_mut() {
            Some((owner, until)) if *owner == token && *until > now => {
                *until = now + std::time::Duration::from_secs(lease_secs.max(1));
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    async fn release_scheduler_lease(&self, token: Uuid) -> Result<(), StoreError> {
        let mut lease = self.scheduler_lease.lock().await;
        if lease.as_ref().is_some_and(|(owner, _)| *owner == token) {
            *lease = None;
        }
        Ok(())
    }

    async fn create_job(&self, job: AutomationJob) -> Result<AutomationJob, StoreError> {
        self.jobs.write().await.insert(job.id, job.clone());
        Ok(job)
    }

    async fn create_job_idempotent(
        &self,
        job: AutomationJob,
        request_key: Uuid,
        request_hash: &[u8],
    ) -> Result<(AutomationJob, bool), StoreError> {
        if request_hash.len() != 32 {
            return Err(StoreError::Message(
                "automation creation fingerprint must be SHA-256".into(),
            ));
        }
        let mut jobs = self.jobs.write().await;
        let mut requests = self.job_creations.lock().await;
        let scope = (
            job.organization_id.clone(),
            job.account_id.clone(),
            job.owner_address.clone(),
            job.target_agent_object_id.clone(),
            request_key,
        );
        if let Some((saved_hash, job_id)) = requests.get(&scope) {
            if saved_hash.as_slice() != request_hash {
                return Err(StoreError::IdempotencyConflict);
            }
            let saved = jobs
                .get(&job_id.ok_or(StoreError::NotFound)?)
                .cloned()
                .ok_or(StoreError::NotFound)?;
            return Ok((saved, false));
        }
        jobs.insert(job.id, job.clone());
        requests.insert(scope, (request_hash.to_vec(), Some(job.id)));
        Ok((job, true))
    }

    async fn delete_job(&self, id: Uuid, expected_version: u64) -> Result<bool, StoreError> {
        // Keep this lock order consistent with run creation and event fanout:
        // jobs before runs/deliveries. That closes the gap between checking for
        // in-flight work and removing the job.
        let mut jobs = self.jobs.write().await;
        if !jobs.contains_key(&id) {
            return Ok(false);
        }
        if jobs
            .get(&id)
            .is_some_and(|job| job.version != expected_version)
        {
            return Err(StoreError::Conflict);
        }
        let runs = self.runs.read().await;
        if runs
            .values()
            .any(|run| run.job_id == id && (run.status == "running" || run.finished_at.is_none()))
        {
            return Err(StoreError::Conflict);
        }
        drop(runs);
        let mut deliveries = self.deliveries.write().await;
        if deliveries.iter().any(|delivery| {
            delivery.claim.job_id == id
                && matches!(
                    delivery.status.as_str(),
                    "pending" | "running" | "reconciling"
                )
        }) {
            return Err(StoreError::Conflict);
        }
        deliveries.retain(|delivery| delivery.claim.job_id != id);
        self.runs.write().await.retain(|_, run| run.job_id != id);
        jobs.remove(&id);
        for (_, job_id) in self.job_creations.lock().await.values_mut() {
            if *job_id == Some(id) {
                *job_id = None;
            }
        }
        Ok(true)
    }

    async fn get_job(&self, id: Uuid) -> Result<Option<AutomationJob>, StoreError> {
        Ok(self.jobs.read().await.get(&id).cloned())
    }

    async fn rename_job(
        &self,
        id: Uuid,
        expected_version: u64,
        name: &str,
    ) -> Result<Option<AutomationJob>, StoreError> {
        let mut jobs = self.jobs.write().await;
        let Some(job) = jobs.get_mut(&id) else {
            return Ok(None);
        };
        if job.version != expected_version {
            return Err(StoreError::Conflict);
        }
        job.name = name.to_string();
        job.version = job.version.saturating_add(1);
        Ok(Some(job.clone()))
    }

    async fn update_job_configuration(
        &self,
        id: Uuid,
        expected_version: u64,
        trigger_set: TriggerSet,
        action: JobAction,
    ) -> Result<Option<AutomationJob>, StoreError> {
        let mut jobs = self.jobs.write().await;
        let Some(job) = jobs.get_mut(&id) else {
            return Ok(None);
        };
        if job.version != expected_version {
            return Err(StoreError::Conflict);
        }
        if job.enabled {
            return Err(StoreError::Conflict);
        }
        let runs = self.runs.read().await;
        if runs
            .values()
            .any(|run| run.job_id == id && (run.status == "running" || run.finished_at.is_none()))
        {
            return Err(StoreError::Conflict);
        }
        drop(runs);
        let deliveries = self.deliveries.read().await;
        if deliveries.iter().any(|delivery| {
            delivery.claim.job_id == id
                && matches!(
                    delivery.status.as_str(),
                    "pending" | "running" | "reconciling"
                )
        }) {
            return Err(StoreError::Conflict);
        }
        drop(deliveries);
        job.trigger_set = trigger_set;
        job.action = action;
        job.version = job.version.saturating_add(1);
        self.all_trigger_state.write().await.remove(&id);
        self.trigger_fire_state
            .write()
            .await
            .retain(|(job_id, _), _| *job_id != id);
        Ok(Some(job.clone()))
    }

    async fn set_job_archived(
        &self,
        id: Uuid,
        expected_version: u64,
        archived: bool,
    ) -> Result<Option<AutomationJob>, StoreError> {
        let mut jobs = self.jobs.write().await;
        let Some(job) = jobs.get_mut(&id) else {
            return Ok(None);
        };
        if job.version != expected_version {
            return Err(StoreError::Conflict);
        }
        job.archived = archived;
        if archived {
            job.enabled = false;
        }
        job.version = job.version.saturating_add(1);
        Ok(Some(job.clone()))
    }

    async fn set_job_enabled(
        &self,
        id: Uuid,
        expected_version: u64,
        enabled: bool,
    ) -> Result<Option<AutomationJob>, StoreError> {
        let mut jobs = self.jobs.write().await;
        let Some(job) = jobs.get_mut(&id) else {
            return Ok(None);
        };
        if job.version != expected_version {
            return Err(StoreError::Conflict);
        }
        if job.archived && enabled {
            return Err(StoreError::Conflict);
        }
        job.enabled = enabled;
        job.version = job.version.saturating_add(1);
        Ok(Some(job.clone()))
    }

    async fn cancel_job_queued_deliveries(
        &self,
        id: Uuid,
        expected_version: u64,
        actor: &str,
        note: &str,
    ) -> Result<Option<JobCancellationResult>, StoreError> {
        let mut jobs = self.jobs.write().await;
        let Some(job) = jobs.get_mut(&id) else {
            return Ok(None);
        };
        if job.version != expected_version {
            return Err(StoreError::Conflict);
        }
        job.enabled = false;
        job.version = job.version.saturating_add(1);
        let version = job.version;
        let mut deliveries = self.deliveries.write().await;
        let now = chrono::Utc::now();
        let mut cancelled_pending = 0u32;
        let mut in_flight = 0u32;
        for row in deliveries.iter_mut().filter(|row| row.claim.job_id == id) {
            if row.status == "pending" {
                row.status = "cancelled".into();
                row.lease_until = None;
                row.error = Some("Cancelled before worker dispatch".into());
                row.resolved_by = Some(actor.to_owned());
                row.resolution = Some("cancelled_before_dispatch".into());
                row.resolution_note = Some(note.to_owned());
                row.resolution_history.push(DeliveryResolution {
                    actor: actor.to_owned(),
                    resolution: "cancelled_before_dispatch".into(),
                    note: note.to_owned(),
                    created_at: now,
                });
                cancelled_pending = cancelled_pending.saturating_add(1);
            } else if matches!(row.status.as_str(), "running" | "reconciling") {
                if row.status == "running" && !row.dispatch_started {
                    row.cancel_request = Some(PendingJobCancellation {
                        actor: actor.to_owned(),
                        note: note.to_owned(),
                    });
                }
                in_flight = in_flight.saturating_add(1);
            }
        }
        Ok(Some(JobCancellationResult {
            job_id: id,
            version,
            cancelled_pending,
            in_flight,
            enabled: false,
        }))
    }

    async fn list_enabled_jobs(&self) -> Result<Vec<AutomationJob>, StoreError> {
        Ok(self
            .jobs
            .read()
            .await
            .values()
            .filter(|j| j.enabled && !j.archived)
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
        Ok(jobs
            .into_iter()
            .skip(filter.offset as usize)
            .take(filter.limit.max(0) as usize)
            .collect())
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

    async fn list_runs_page(
        &self,
        job_id: Uuid,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<RunSummary>, StoreError> {
        let mut rows: Vec<RunSummary> = self
            .runs
            .read()
            .await
            .values()
            .filter(|row| row.job_id == job_id)
            .map(RunRow::summarize)
            .collect();
        rows.sort_by(|a, b| {
            b.started_at
                .cmp(&a.started_at)
                .then_with(|| b.id.cmp(&a.id))
        });
        Ok(rows
            .into_iter()
            .skip(offset.clamp(0, MAX_LIST_OFFSET) as usize)
            .take(limit.clamp(1, MAX_LIST_LIMIT) as usize)
            .collect())
    }

    async fn resolve_orphan_run(
        &self,
        job_id: Uuid,
        run_id: Uuid,
        resolution: &str,
        actor: &str,
        note: &str,
    ) -> Result<Option<RunSummary>, StoreError> {
        let cutoff = chrono::Utc::now() - chrono::Duration::minutes(30);
        let mut runs = self.runs.write().await;
        let deliveries = self.deliveries.read().await;
        let Some(run) = runs.get_mut(&run_id).filter(|row| {
            row.job_id == job_id
                && matches!(row.status.as_str(), crate::RUN_STATUS_RUNNING | crate::RUN_STATUS_RECONCILING)
                && row.started_at <= cutoff
                && !deliveries.iter().any(|delivery| {
                    delivery.claim.job_id == job_id
                        && row.trigger_event_id.as_deref().is_some_and(|event_id| {
                            event_id == delivery.claim.event.deduplication_key
                                || event_id == delivery.claim.event.source_event_id
                        })
                })
        }) else {
            return Ok(None);
        };
        run.status = if resolution == "confirmed_succeeded" {
            crate::RUN_STATUS_SUCCEEDED
        } else {
            crate::RUN_STATUS_ABANDONED
        }
        .into();
        run.finished_at = Some(chrono::Utc::now());
        run.error = Some(format!("Owner reconciliation ({resolution}) by {}: {}", actor.trim(), note.trim()));
        Ok(Some(run.summarize()))
    }

    async fn record_run_start(
        &self,
        job_id: Uuid,
        _trigger_set_snapshot: serde_json::Value,
        _matched_triggers: serde_json::Value,
        trigger_event_id: Option<String>,
    ) -> Result<Uuid, StoreError> {
        let jobs = self.jobs.read().await;
        let Some(job) = jobs.get(&job_id) else {
            return Err(StoreError::NotFound);
        };
        let recoverable_work_run =
            job.action.kind == crate::JobActionKind::WorkRun && trigger_event_id.is_some();
        let run_id = Uuid::new_v4();
        let mut runs = self.runs.write().await;
        if recoverable_work_run {
            for previous in runs.values_mut().filter(|row| {
                row.job_id == job_id
                    && matches!(
                        row.status.as_str(),
                        crate::RUN_STATUS_RUNNING | crate::RUN_STATUS_RECONCILING
                    )
                    && row.trigger_event_id == trigger_event_id
            }) {
                previous.status = crate::RUN_STATUS_FAILED.into();
                previous.error = Some(
                    "A prior automation worker stopped; resuming from the encrypted work journal"
                        .into(),
                );
                previous.finished_at = Some(chrono::Utc::now());
            }
        }
        runs.insert(
            run_id,
            RunRow {
                id: run_id,
                job_id,
                trigger_event_id,
                status: "running".into(),
                started_at: chrono::Utc::now(),
                finished_at: None,
                attempts: 1,
                cost_mist: None,
                error: None,
            },
        );
        drop(jobs);
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

    async fn latest_scheduled_run_cursor(
        &self,
        job_id: Uuid,
    ) -> Result<Option<(String, chrono::DateTime<chrono::Utc>)>, StoreError> {
        let prefix = format!("automation:schedule:{job_id}:");
        let runs = self.runs.read().await;
        let run_cursor = runs
            .values()
            .filter(|row| {
                row.job_id == job_id
                    && row
                        .trigger_event_id
                        .as_deref()
                        .is_some_and(|key| key.starts_with(&prefix))
            })
            .max_by_key(|row| row.started_at)
            .and_then(|row| {
                row.trigger_event_id
                    .as_deref()
                    .and_then(|key| key.strip_prefix(&prefix))
                    .map(|window| (window.to_string(), row.started_at))
            });
        let deliveries = self.deliveries.read().await;
        let cancelled_cursor = deliveries
            .iter()
            .filter(|row| {
                row.claim.job_id == job_id
                    && row.status == "cancelled"
                    && row.resolution.as_deref() == Some("cancelled_before_dispatch")
                    && row.claim.event.source_service == "automation_scheduler"
                    && row.claim.event.deduplication_key.starts_with(&prefix)
            })
            .filter_map(|row| {
                let window = row.claim.event.deduplication_key.strip_prefix(&prefix)?;
                let resolved_at = row.resolution_history.last()?.created_at;
                Some((window.to_string(), resolved_at))
            })
            .max_by_key(|(_, timestamp)| *timestamp);
        Ok(run_cursor
            .into_iter()
            .chain(cancelled_cursor)
            .max_by_key(|(_, timestamp)| *timestamp))
    }

    async fn has_run_for_event(&self, job_id: Uuid, event_key: &str) -> Result<bool, StoreError> {
        Ok(self
            .runs
            .read()
            .await
            .values()
            .any(|row| row.job_id == job_id && row.trigger_event_id.as_deref() == Some(event_key)))
    }

    async fn ingest_event_dedup(&self, event: &PlatformEvent) -> Result<bool, StoreError> {
        // Hold dedup through fanout so a duplicate cannot be acknowledged before enqueue.
        let mut dedup = self.dedup.write().await;
        if dedup.contains(&event.deduplication_key) {
            return Ok(false);
        }
        let jobs = self.jobs.read().await;
        if event.target_job_id.is_some_and(|id| {
            !jobs
                .get(&id)
                .is_some_and(|job| job.enabled && !job.archived)
        }) {
            return Err(StoreError::Conflict);
        }
        let mut deliveries = self.deliveries.write().await;
        for job in jobs.values().filter(|job| {
            job.enabled
                && crate::executor::event_in_scope(event, job)
                && event
                    .target_job_id
                    .map(|target| target == job.id)
                    .unwrap_or(true)
        }) {
            let debounce_ms = trigger_debounce_for_event(&job.trigger_set, event);
            if let Some(debounce_ms) = debounce_ms {
                let available_at = chrono::Utc::now() + chrono::Duration::milliseconds(debounce_ms);
                if let Some(existing_index) = deliveries.iter().rposition(|delivery| {
                    delivery.claim.job_id == job.id
                        && delivery.status == "pending"
                        && delivery.debounce_coalescible
                }) {
                    {
                        let existing = &mut deliveries[existing_index];
                        existing.claim.event = event.clone();
                        existing.available_at = available_at;
                        existing.error = None;
                    }
                    if job.trigger_set.match_mode == MatchMode::All {
                        self.all_trigger_events
                            .write()
                            .await
                            .insert((job.id, event.deduplication_key.clone()), true);
                    }
                    continue;
                }
                if job.trigger_set.match_mode == MatchMode::All {
                    let matched: Vec<usize> = job
                        .trigger_set
                        .triggers
                        .iter()
                        .enumerate()
                        .filter_map(|(index, trigger)| {
                            crate::trigger_eval::event_matches_trigger(event, trigger)
                                .then_some(index)
                        })
                        .collect();
                    let identity = (job.id, event.deduplication_key.clone());
                    let mut events = self.all_trigger_events.write().await;
                    if events.contains_key(&identity) {
                        continue;
                    }
                    events.insert(identity.clone(), false);
                    let mut state = self.all_trigger_state.write().await;
                    let matches = state.entry(job.id).or_default();
                    for index in matched {
                        matches
                            .entry(index)
                            .and_modify(|at| *at = (*at).max(event.occurred_at_ms))
                            .or_insert(event.occurred_at_ms);
                    }
                    if job.trigger_set.evaluation_window_ms > 0 {
                        let cutoff = event
                            .occurred_at_ms
                            .saturating_sub(job.trigger_set.evaluation_window_ms);
                        matches.retain(|_, at| *at >= cutoff && *at <= event.occurred_at_ms);
                    }
                    let complete = matches.len() >= job.trigger_set.triggers.len();
                    if complete {
                        state.remove(&job.id);
                        events.insert(identity, true);
                    } else {
                        continue;
                    }
                }
                deliveries.push(MemoryDelivery {
                    claim: EventDeliveryClaim {
                        id: Uuid::new_v4(),
                        token: Uuid::new_v4(),
                        job_id: job.id,
                        event: event.clone(),
                    },
                    status: "pending".into(),
                    lease_until: None,
                    attempts: 0,
                    available_at,
                    debounce_coalescible: true,
                    error: None,
                    resolved_by: None,
                    resolution: None,
                    resolution_note: None,
                    resolution_history: Vec::new(),
                    dispatch_started: false,
                    cancel_request: None,
                });
                continue;
            }
            deliveries.push(MemoryDelivery {
                claim: EventDeliveryClaim {
                    id: Uuid::new_v4(),
                    token: Uuid::new_v4(),
                    job_id: job.id,
                    event: event.clone(),
                },
                status: "pending".into(),
                lease_until: None,
                attempts: 0,
                available_at: chrono::Utc::now(),
                debounce_coalescible: false,
                error: None,
                resolved_by: None,
                resolution: None,
                resolution_note: None,
                resolution_history: Vec::new(),
                dispatch_started: false,
                cancel_request: None,
            });
        }
        dedup.insert(event.deduplication_key.clone());
        Ok(true)
    }

    async fn ingest_scheduled_event(
        &self,
        event: &PlatformEvent,
        token: Uuid,
    ) -> Result<bool, StoreError> {
        let lease = self.scheduler_lease.lock().await;
        if !lease
            .as_ref()
            .is_some_and(|(owner, until)| *owner == token && *until > std::time::Instant::now())
        {
            return Err(StoreError::Conflict);
        }
        // Keep the lease guard through the atomic in-memory fanout.
        self.ingest_event_dedup(event).await
    }

    async fn record_all_trigger_matches(
        &self,
        job_id: Uuid,
        event_key: &str,
        matched: &[usize],
        trigger_count: usize,
        window_ms: i64,
        now_ms: i64,
    ) -> Result<bool, StoreError> {
        let mut events = self.all_trigger_events.write().await;
        let event_identity = (job_id, event_key.to_owned());
        if let Some(fired) = events.get(&event_identity) {
            return Ok(*fired);
        }
        events.insert(event_identity.clone(), false);
        let mut state = self.all_trigger_state.write().await;
        let matches = state.entry(job_id).or_default();
        for index in matched {
            matches
                .entry(*index)
                .and_modify(|at| *at = (*at).max(now_ms))
                .or_insert(now_ms);
        }
        if window_ms > 0 {
            let cutoff = now_ms.saturating_sub(window_ms);
            matches.retain(|_, at| *at >= cutoff && *at <= now_ms);
        }
        let complete = matches.len() >= trigger_count;
        if complete {
            state.remove(&job_id);
            events.insert(event_identity, true);
        }
        Ok(complete)
    }

    async fn authorize_trigger_fires(
        &self,
        job_id: Uuid,
        _event_key: &str,
        policies: &[(usize, i64, Option<u32>)],
        now_ms: i64,
    ) -> Result<bool, StoreError> {
        let mut history = self.trigger_fire_history.write().await;
        let mut next = Vec::with_capacity(policies.len());
        for (index, debounce_ms, maximum) in policies {
            let recent = if maximum.is_some() {
                let fires = history.get(&(job_id, *index)).cloned().unwrap_or_default();
                let cutoff = now_ms.saturating_sub(*debounce_ms);
                let recent: Vec<_> = fires
                    .into_iter()
                    .filter(|(fired_at, _)| *fired_at >= cutoff && *fired_at <= now_ms)
                    .collect();
                if maximum.is_some_and(|limit| recent.len() >= limit as usize) {
                    return Ok(false);
                }
                Some(recent)
            } else {
                None
            };
            next.push((*index, *debounce_ms, recent));
        }
        for (index, debounce_ms, mut recent) in next {
            if debounce_ms > 0 && recent.is_some() {
                let recent = recent.as_mut().expect("a cap has a rolling fire history");
                recent.push((now_ms, _event_key.to_owned()));
                history.insert((job_id, index), recent.clone());
            }
        }
        let mut rows = self.trigger_fire_state.write().await;
        for (index, _, _) in policies {
            let mut state = rows.get(&(job_id, *index)).copied().unwrap_or_default();
            state.last_fired_at_ms = Some(now_ms);
            rows.insert((job_id, *index), state);
        }
        Ok(true)
    }

    async fn list_event_deliveries(
        &self,
        job_id: Uuid,
        limit: i64,
    ) -> Result<Vec<EventDeliverySummary>, StoreError> {
        let rows = self.deliveries.read().await;
        Ok(rows
            .iter()
            .rev()
            .filter(|row| row.claim.job_id == job_id)
            .take(limit.clamp(1, MAX_LIST_LIMIT) as usize)
            .map(|row| EventDeliverySummary {
                id: row.claim.id,
                job_id,
                event_key: row.claim.event.deduplication_key.clone(),
                status: row.status.clone(),
                attempts: row.attempts,
                lease_until: row.lease_until,
                error: row.error.clone(),
                resolved_by: row.resolved_by.clone(),
                resolution: row.resolution.clone(),
                resolution_note: row.resolution_note.clone(),
                resolution_history: serde_json::to_value(&row.resolution_history)
                    .unwrap_or_else(|_| serde_json::json!([])),
            })
            .collect())
    }
    async fn list_event_deliveries_page(
        &self,
        job_id: Uuid,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<EventDeliverySummary>, StoreError> {
        let rows = self.deliveries.read().await;
        Ok(rows
            .iter()
            .rev()
            .filter(|row| row.claim.job_id == job_id)
            .skip(offset.clamp(0, MAX_LIST_OFFSET) as usize)
            .take(limit.clamp(1, MAX_LIST_LIMIT) as usize)
            .map(|row| EventDeliverySummary {
                id: row.claim.id,
                job_id,
                event_key: row.claim.event.deduplication_key.clone(),
                status: row.status.clone(),
                attempts: row.attempts,
                lease_until: row.lease_until,
                error: row.error.clone(),
                resolved_by: row.resolved_by.clone(),
                resolution: row.resolution.clone(),
                resolution_note: row.resolution_note.clone(),
                resolution_history: serde_json::to_value(&row.resolution_history)
                    .unwrap_or_else(|_| serde_json::json!([])),
            })
            .collect())
    }
    async fn resolve_event_delivery(
        &self,
        id: Uuid,
        job_id: Uuid,
        resolution: &str,
        actor: &str,
        note: &str,
    ) -> Result<Option<EventDeliverySummary>, StoreError> {
        let mut runs = self.runs.write().await;
        let mut rows = self.deliveries.write().await;
        let Some(row) = rows.iter_mut().find(|row| {
            row.claim.id == id && row.claim.job_id == job_id && row.status == "reconciling"
        }) else {
            return Ok(None);
        };
        row.status = if resolution == "confirmed_succeeded" {
            "done"
        } else {
            "pending"
        }
        .into();
        row.lease_until = None;
        row.error = None;
        row.resolved_by = Some(actor.to_owned());
        row.resolution = Some(resolution.to_owned());
        row.resolution_note = Some(note.to_owned());
        row.resolution_history.push(DeliveryResolution {
            actor: actor.to_owned(),
            resolution: resolution.to_owned(),
            note: note.to_owned(),
            created_at: chrono::Utc::now(),
        });
        let event_key = row.claim.event.deduplication_key.clone();
        let source_event_id = row.claim.event.source_event_id.clone();
        let now = chrono::Utc::now();
        for run in runs.values_mut().filter(|run| {
            run.job_id == job_id
                && run.trigger_event_id.as_deref().is_some_and(|run_event_id| {
                    run_event_id == event_key || run_event_id == source_event_id
                })
                && run.status == crate::RUN_STATUS_RECONCILING
        }) {
            run.status = if resolution == "confirmed_succeeded" {
                crate::RUN_STATUS_SUCCEEDED
            } else {
                crate::RUN_STATUS_FAILED
            }
            .into();
            run.finished_at = Some(now);
            run.error = (resolution != "confirmed_succeeded").then(|| {
                "Owner confirmed no external action executed; delivery queued for retry".into()
            });
        }
        Ok(Some(EventDeliverySummary {
            id,
            job_id: row.claim.job_id,
            event_key: row.claim.event.deduplication_key.clone(),
            status: row.status.clone(),
            attempts: row.attempts,
            lease_until: None,
            error: None,
            resolved_by: row.resolved_by.clone(),
            resolution: row.resolution.clone(),
            resolution_note: row.resolution_note.clone(),
            resolution_history: serde_json::to_value(&row.resolution_history)
                .unwrap_or_else(|_| serde_json::json!([])),
        }))
    }
    async fn cancel_event_delivery(
        &self,
        id: Uuid,
        job_id: Uuid,
        actor: &str,
        note: &str,
    ) -> Result<Option<EventDeliverySummary>, StoreError> {
        let mut rows = self.deliveries.write().await;
        let Some(row) = rows
            .iter_mut()
            .find(|row| row.claim.id == id && row.claim.job_id == job_id)
        else {
            return Ok(None);
        };
        if row.status == "cancelled"
            && row.resolution.as_deref() == Some("cancelled_before_dispatch")
        {
            return Ok(Some(EventDeliverySummary {
                id,
                job_id,
                event_key: row.claim.event.deduplication_key.clone(),
                status: row.status.clone(),
                attempts: row.attempts,
                lease_until: None,
                error: row.error.clone(),
                resolved_by: row.resolved_by.clone(),
                resolution: row.resolution.clone(),
                resolution_note: row.resolution_note.clone(),
                resolution_history: serde_json::to_value(&row.resolution_history)
                    .unwrap_or_else(|_| serde_json::json!([])),
            }));
        }
        if row.status != "pending" {
            return Ok(None);
        }
        row.status = "cancelled".into();
        row.lease_until = None;
        row.error = Some("Cancelled before worker dispatch".into());
        row.resolved_by = Some(actor.to_owned());
        row.resolution = Some("cancelled_before_dispatch".into());
        row.resolution_note = Some(note.to_owned());
        row.resolution_history.push(DeliveryResolution {
            actor: actor.to_owned(),
            resolution: "cancelled_before_dispatch".into(),
            note: note.to_owned(),
            created_at: chrono::Utc::now(),
        });
        Ok(Some(EventDeliverySummary {
            id,
            job_id: row.claim.job_id,
            event_key: row.claim.event.deduplication_key.clone(),
            status: row.status.clone(),
            attempts: row.attempts,
            lease_until: None,
            error: row.error.clone(),
            resolved_by: row.resolved_by.clone(),
            resolution: row.resolution.clone(),
            resolution_note: row.resolution_note.clone(),
            resolution_history: serde_json::to_value(&row.resolution_history)
                .unwrap_or_else(|_| serde_json::json!([])),
        }))
    }
    async fn claim_event_delivery(&self) -> Result<Option<EventDeliveryClaim>, StoreError> {
        let now = chrono::Utc::now();
        let (enabled_jobs, work_run_jobs): (
            std::collections::HashSet<Uuid>,
            std::collections::HashSet<Uuid>,
        ) = {
            let jobs = self.jobs.read().await;
            (
                jobs.values()
                    .filter(|job| job.enabled && !job.archived)
                    .map(|job| job.id)
                    .collect(),
                jobs.values()
                    .filter(|job| job.action.kind == crate::JobActionKind::WorkRun)
                    .map(|job| job.id)
                    .collect(),
            )
        };
        // Keep run/delivery locks in the same order while expiring a lease so a
        // run row cannot remain "running" after its durable delivery reconciles.
        let mut runs = self.runs.write().await;
        let mut rows = self.deliveries.write().await;
        for row in rows.iter_mut() {
            if row.status == "running" && row.lease_until.is_some_and(|until| until < now) {
                let message = if work_run_jobs.contains(&row.claim.job_id)
                    && row.attempts < MAX_SAFE_DELIVERY_ATTEMPTS
                {
                    row.status = "pending".into();
                    row.lease_until = None;
                    row.dispatch_started = false;
                    row.available_at = now + chrono::Duration::seconds(5);
                    let message = "Work-run worker lease expired; retrying through the encrypted work journal";
                    row.error = Some(message.into());
                    message
                } else {
                    row.status = "reconciling".into();
                    row.lease_until = None;
                    let message = "Worker lease expired; reconcile external outcome";
                    row.error = Some(message.into());
                    message
                };
                for run in runs.values_mut().filter(|run| {
                    run.job_id == row.claim.job_id
                        && run.trigger_event_id.as_deref().is_some_and(|event_id| {
                            event_id == row.claim.event.deduplication_key
                                || event_id == row.claim.event.source_event_id
                        })
                        && run.status == crate::RUN_STATUS_RUNNING
                }) {
                    run.status = crate::RUN_STATUS_RECONCILING.into();
                    run.finished_at = Some(now);
                    run.error = Some(message.into());
                }
            }
        }
        if let Some(index) = rows.iter().position(|row| {
            row.status == "pending"
                && row.available_at <= now
                && enabled_jobs.contains(&row.claim.job_id)
                && !rows.iter().any(|active| {
                    active.claim.job_id == row.claim.job_id
                        && active.claim.id != row.claim.id
                        && (matches!(active.status.as_str(), "running" | "reconciling")
                            || (active.status == "pending" && active.attempts > 0))
                })
        }) {
            let row = &mut rows[index];
            row.status = "running".into();
            row.claim.token = Uuid::new_v4();
            row.attempts += 1;
            row.resolved_by = None;
            row.resolution = None;
            row.resolution_note = None;
            row.dispatch_started = false;
            row.cancel_request = None;
            row.lease_until = Some(now + chrono::Duration::minutes(5));
            return Ok(Some(row.claim.clone()));
        }
        Ok(None)
    }
    async fn begin_event_delivery_dispatch(
        &self,
        id: Uuid,
        token: Uuid,
    ) -> Result<bool, StoreError> {
        let jobs = self.jobs.read().await;
        let mut rows = self.deliveries.write().await;
        if let Some(row) = rows.iter_mut().find(|row| {
            row.claim.id == id
                && row.claim.token == token
                && row.status == "running"
                && row
                    .lease_until
                    .is_some_and(|until| until > chrono::Utc::now())
        }) {
            if row.cancel_request.is_some()
                || !jobs
                    .get(&row.claim.job_id)
                    .is_some_and(|job| job.enabled && !job.archived)
            {
                return Ok(false);
            }
            row.dispatch_started = true;
            return Ok(true);
        }
        Ok(false)
    }
    async fn defer_event_delivery(&self, id: Uuid, token: Uuid) -> Result<bool, StoreError> {
        let mut rows = self.deliveries.write().await;
        if let Some(row) = rows.iter_mut().find(|row| {
            row.claim.id == id
                && row.claim.token == token
                && row.status == "running"
                && row
                    .lease_until
                    .is_some_and(|until| until > chrono::Utc::now())
        }) {
            let cancellation = row.cancel_request.clone();
            row.status = if cancellation.is_some() {
                "cancelled"
            } else {
                "pending"
            }
            .into();
            row.lease_until = None;
            row.error = Some(
                if cancellation.is_some() {
                    "Cancelled before worker dispatch"
                } else {
                    "Job paused before delivery dispatch"
                }
                .into(),
            );
            if let Some(cancellation) = cancellation {
                row.resolved_by = Some(cancellation.actor.clone());
                row.resolution = Some("cancelled_before_dispatch".into());
                row.resolution_note = Some(cancellation.note.clone());
                row.resolution_history.push(DeliveryResolution {
                    actor: cancellation.actor.clone(),
                    resolution: "cancelled_before_dispatch".into(),
                    note: cancellation.note.clone(),
                    created_at: chrono::Utc::now(),
                });
            }
            return Ok(true);
        }
        Ok(false)
    }
    async fn retry_event_delivery(
        &self,
        id: Uuid,
        token: Uuid,
        error: &str,
    ) -> Result<bool, StoreError> {
        let jobs = self.jobs.read().await;
        let mut rows = self.deliveries.write().await;
        let Some(row) = rows.iter_mut().find(|row| {
            row.claim.id == id
                && row.claim.token == token
                && row.status == "running"
                && row.cancel_request.is_none()
                && row
                    .lease_until
                    .is_some_and(|until| until > chrono::Utc::now())
        }) else {
            return Ok(false);
        };
        if row.dispatch_started
            && !jobs
                .get(&row.claim.job_id)
                .is_some_and(|job| job.action.kind == crate::JobActionKind::WorkRun)
        {
            return Ok(false);
        }
        row.lease_until = None;
        row.dispatch_started = false;
        row.error = Some(error.chars().take(2048).collect());
        if row.attempts >= MAX_SAFE_DELIVERY_ATTEMPTS {
            row.status = "reconciling".into();
        } else {
            row.status = "pending".into();
            let delay = 1_i64
                .checked_shl(row.attempts.clamp(1, 6) as u32)
                .unwrap_or(60)
                .min(60);
            row.available_at = chrono::Utc::now() + chrono::Duration::seconds(delay);
        }
        Ok(true)
    }
    async fn renew_event_delivery(&self, id: Uuid, token: Uuid) -> Result<bool, StoreError> {
        let mut rows = self.deliveries.write().await;
        if let Some(row) = rows.iter_mut().find(|row| {
            row.claim.id == id
                && row.claim.token == token
                && row.status == "running"
                && row
                    .lease_until
                    .is_some_and(|until| until > chrono::Utc::now())
        }) {
            row.lease_until = Some(chrono::Utc::now() + chrono::Duration::minutes(5));
            return Ok(true);
        }
        Ok(false)
    }
    async fn finish_event_delivery(
        &self,
        id: Uuid,
        token: Uuid,
        error: Option<String>,
    ) -> Result<bool, StoreError> {
        let mut runs = self.runs.write().await;
        let mut rows = self.deliveries.write().await;
        if let Some(row) = rows.iter_mut().find(|row| {
            row.claim.id == id
                && row.claim.token == token
                && row.status == "running"
                && row
                    .lease_until
                    .is_some_and(|until| until > chrono::Utc::now())
        }) {
            row.status = if error.is_some() {
                "reconciling"
            } else {
                "done"
            }
            .into();
            row.error = error;
            row.lease_until = None;
            if let Some(message) = row.error.as_deref() {
                let job_id = row.claim.job_id;
                let event_key = row.claim.event.deduplication_key.clone();
                for run in runs.values_mut().filter(|run| {
                    run.job_id == job_id
                        && run.trigger_event_id.as_deref().is_some_and(|run_event_id| {
                            run_event_id == event_key
                                || run_event_id == row.claim.event.source_event_id
                        })
                        && run.status == crate::RUN_STATUS_RUNNING
                }) {
                    run.status = crate::RUN_STATUS_RECONCILING.into();
                    run.finished_at = Some(chrono::Utc::now());
                    run.error = Some(message.to_string());
                }
            }
            return Ok(true);
        }
        Ok(false)
    }

    async fn put_delegate(&self, record: DelegateRecord) -> Result<(), StoreError> {
        let key = (record.account_id.clone(), record.delegate_ref.clone());
        let mut delegates = self.delegates.write().await;
        if delegates.get(&key).is_some_and(|prior| {
            normalized_agent_id(&prior.agent_object_id)
                != normalized_agent_id(&record.agent_object_id)
        }) {
            return Err(StoreError::Message(
                "delegate reference is already bound to another agent".into(),
            ));
        }
        let event_type = if delegates.contains_key(&key) {
            "replaced"
        } else {
            "created"
        };
        let account_id = record.account_id.clone();
        let event = DelegateKeyEvent {
            id: String::new(),
            delegate_ref: record.delegate_ref.clone(),
            agent_object_id: record.agent_object_id.clone(),
            mydata_key_id: record.mydata_key_id.clone(),
            event_type: event_type.into(),
            recorded_at: chrono::Utc::now(),
        };
        delegates.insert(key, record);
        drop(delegates);
        let mut events = self.delegate_key_events.write().await;
        let id = events
            .last()
            .and_then(|(_, event)| event.id.parse::<u64>().ok())
            .unwrap_or(0)
            .saturating_add(1)
            .to_string();
        events.push((account_id, DelegateKeyEvent { id, ..event }));
        Ok(())
    }

    async fn list_delegate_key_events(
        &self,
        account_id: &str,
        agent_object_id: Option<&str>,
        after: Option<i64>,
        limit: i64,
    ) -> Result<DelegateKeyEventPage, StoreError> {
        let events = self.delegate_key_events.read().await;
        let mut rows: Vec<DelegateKeyEvent> = events
            .iter()
            .filter(|(account, event)| {
                account == account_id
                    && after.map_or(true, |cursor| {
                        event.id.parse::<i64>().is_ok_and(|id| id > cursor)
                    })
                    && agent_object_id.map_or(true, |agent| {
                        normalized_agent_id(&event.agent_object_id) == normalized_agent_id(agent)
                    })
            })
            .map(|(_, event)| event.clone())
            .collect();
        let limit = limit.clamp(1, MAX_DELEGATE_LIST_LIMIT) as usize;
        let has_next_page = rows.len() > limit;
        rows.truncate(limit);
        let next_cursor = has_next_page
            .then(|| rows.last().map(|event| event.id.clone()))
            .flatten();
        Ok(DelegateKeyEventPage {
            data: rows,
            has_next_page,
            next_cursor,
        })
    }

    async fn list_delegates(
        &self,
        account_id: &str,
        agent_object_id: Option<&str>,
        after: Option<&str>,
        limit: i64,
    ) -> Result<DelegatePage, StoreError> {
        let mut rows: Vec<DelegateSummary> = self
            .delegates
            .read()
            .await
            .values()
            .filter(|r| {
                r.account_id == account_id
                    && after.map_or(true, |cursor| r.delegate_ref.as_str() > cursor)
                    && agent_object_id.map_or(true, |agent| {
                        normalized_agent_id(&r.agent_object_id) == normalized_agent_id(agent)
                    })
            })
            .map(DelegateSummary::from)
            .collect();
        rows.sort_by(|a, b| a.delegate_ref.cmp(&b.delegate_ref));
        let limit = limit.clamp(1, MAX_DELEGATE_LIST_LIMIT) as usize;
        let has_next_page = rows.len() > limit;
        rows.truncate(limit);
        let next_cursor = has_next_page
            .then(|| rows.last().map(|row| row.delegate_ref.clone()))
            .flatten();
        Ok(DelegatePage {
            data: rows,
            has_next_page,
            next_cursor,
        })
    }

    async fn get_delegate_summary(
        &self,
        account_id: &str,
        delegate_ref: &str,
    ) -> Result<Option<DelegateSummary>, StoreError> {
        Ok(self
            .delegates
            .read()
            .await
            .get(&(account_id.to_string(), delegate_ref.to_string()))
            .map(DelegateSummary::from))
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
        self.delete_delegate_if_agent(account_id, delegate_ref, None)
            .await
    }
    async fn delete_delegate_if_agent(
        &self,
        account_id: &str,
        delegate_ref: &str,
        expected_agent: Option<&str>,
    ) -> Result<bool, StoreError> {
        let key = (account_id.to_string(), delegate_ref.to_string());
        let mut delegates = self.delegates.write().await;
        if expected_agent.is_some_and(|agent| {
            delegates.get(&key).is_none_or(|prior| {
                normalized_agent_id(&prior.agent_object_id) != normalized_agent_id(agent)
            })
        }) {
            return Ok(false);
        }
        let Some(record) = delegates.remove(&key) else {
            return Ok(false);
        };
        drop(delegates);
        let mut events = self.delegate_key_events.write().await;
        let id = events
            .last()
            .and_then(|(_, event)| event.id.parse::<u64>().ok())
            .unwrap_or(0)
            .saturating_add(1)
            .to_string();
        events.push((
            record.account_id,
            DelegateKeyEvent {
                id,
                delegate_ref: record.delegate_ref,
                agent_object_id: record.agent_object_id,
                mydata_key_id: record.mydata_key_id,
                event_type: "deleted".into(),
                recorded_at: chrono::Utc::now(),
            },
        ));
        Ok(true)
    }
}

fn normalized_agent_id(id: &str) -> String {
    format!(
        "{:0>64}",
        id.trim()
            .trim_start_matches("0x")
            .trim_start_matches("0X")
            .to_ascii_lowercase()
    )
}

/// How long a single connection attempt may take.
///
/// sqlx's default acquire timeout is 30s, which makes a cold-start retry loop
/// spend half its budget on one attempt. Failing faster lets the caller's backoff
/// actually pace the retries, and lets a genuinely unreachable host fail sooner.
const CONNECT_ATTEMPT_TIMEOUT_SECS: u64 = 5;

fn sql_statements(sql: &str) -> Vec<String> {
    let mut cleaned = String::new();
    for line in sql.lines() {
        if line.trim_start().starts_with("--") {
            continue;
        }
        cleaned.push_str(line);
        cleaned.push('\n');
    }
    cleaned
        .split(';')
        .map(|statement| statement.trim().to_string())
        .filter(|statement| !statement.is_empty())
        .collect()
}

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
        include_str!("../migrations/003_automation_delegate_keys.sql"),
        include_str!("../migrations/004_delegate_class.sql"),
        include_str!("../migrations/005_event_deliveries.sql"),
        include_str!("../migrations/006_job_archive.sql"),
        include_str!("../migrations/007_delivery_reconciliation.sql"),
        include_str!("../migrations/008_delivery_resolution_history.sql"),
        include_str!("../migrations/009_delegate_key_event_history.sql"),
        include_str!("../migrations/010_delivery_cancellation.sql"),
        include_str!("../migrations/011_job_versions.sql"),
        include_str!("../migrations/012_job_cancellation.sql"),
        include_str!("../migrations/013_trigger_match_state.sql"),
        include_str!("../migrations/014_trigger_execution_count_bigint.sql"),
        include_str!("../migrations/015_event_delivery_safe_retry.sql"),
        include_str!("../migrations/016_trigger_execution_rolling_window.sql"),
        include_str!("../migrations/017_scheduler_tick_lease.sql"),
        include_str!("../migrations/018_job_creation_idempotency.sql"),
    ] {
        for stmt in sql_statements(sql) {
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
    async fn acquire_scheduler_lease(
        &self,
        token: Uuid,
        lease_secs: u64,
    ) -> Result<bool, StoreError> {
        let claimed = sqlx::query_scalar::<_, Uuid>(
            "INSERT INTO automation_scheduler_leases(lease_name,lease_token,lease_until) VALUES('cron',$1,NOW()+($2::bigint*INTERVAL '1 second')) ON CONFLICT(lease_name) DO UPDATE SET lease_token=EXCLUDED.lease_token,lease_until=EXCLUDED.lease_until,updated_at=NOW() WHERE automation_scheduler_leases.lease_until<=NOW() RETURNING lease_token"
        ).bind(token).bind(lease_secs.clamp(1, 3600) as i64).fetch_optional(&self.pool).await.map_err(|e|StoreError::Message(e.to_string()))?;
        Ok(claimed == Some(token))
    }

    async fn renew_scheduler_lease(
        &self,
        token: Uuid,
        lease_secs: u64,
    ) -> Result<bool, StoreError> {
        let renewed = sqlx::query_scalar::<_, Uuid>(
            "UPDATE automation_scheduler_leases SET lease_until=NOW()+($2::bigint*INTERVAL '1 second'),updated_at=NOW() WHERE lease_name='cron' AND lease_token=$1 AND lease_until>NOW() RETURNING lease_token"
        ).bind(token).bind(lease_secs.clamp(1, 3600) as i64).fetch_optional(&self.pool).await.map_err(|e|StoreError::Message(e.to_string()))?;
        Ok(renewed == Some(token))
    }

    async fn release_scheduler_lease(&self, token: Uuid) -> Result<(), StoreError> {
        sqlx::query(
            "DELETE FROM automation_scheduler_leases WHERE lease_name='cron' AND lease_token=$1",
        )
        .bind(token)
        .execute(&self.pool)
        .await
        .map_err(|e| StoreError::Message(e.to_string()))?;
        Ok(())
    }

    async fn create_job(&self, job: AutomationJob) -> Result<AutomationJob, StoreError> {
        sqlx::query(
            r#"INSERT INTO automation_jobs
               (id, organization_id, account_id, owner_address, name, enabled, trigger_set,
                target_agent_object_id, target_agent_key_ref, action, memory_scope,
                max_mist_per_run, retry_policy, archived, version)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)"#,
        )
        .bind(job.id)
        .bind(&job.organization_id)
        .bind(&job.account_id)
        .bind(&job.owner_address)
        .bind(&job.name)
        .bind(job.enabled)
        .bind(
            serde_json::to_value(&job.trigger_set)
                .map_err(|e| StoreError::Message(e.to_string()))?,
        )
        .bind(&job.target_agent_object_id)
        .bind(&job.target_agent_key_ref)
        .bind(serde_json::to_value(&job.action).map_err(|e| StoreError::Message(e.to_string()))?)
        .bind(&job.memory_scope)
        .bind(job.max_mist_per_run as i64)
        .bind(
            serde_json::to_value(&job.retry_policy)
                .map_err(|e| StoreError::Message(e.to_string()))?,
        )
        .bind(job.archived)
        .bind(job.version.max(1) as i64)
        .execute(&self.pool)
        .await
        .map_err(|e| StoreError::Message(e.to_string()))?;
        Ok(job)
    }

    async fn create_job_idempotent(
        &self,
        job: AutomationJob,
        request_key: Uuid,
        request_hash: &[u8],
    ) -> Result<(AutomationJob, bool), StoreError> {
        if request_hash.len() != 32 {
            return Err(StoreError::Message(
                "automation creation fingerprint must be SHA-256".into(),
            ));
        }
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|error| StoreError::Message(error.to_string()))?;
        let inserted=sqlx::query_scalar::<_,Uuid>("INSERT INTO automation_job_creation_keys (organization_id,account_id,owner_address,target_agent_object_id,request_key,request_hash,job_id) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (organization_id,account_id,owner_address,target_agent_object_id,request_key) DO NOTHING RETURNING job_id")
            .bind(&job.organization_id).bind(&job.account_id).bind(&job.owner_address).bind(&job.target_agent_object_id).bind(request_key).bind(request_hash).bind(job.id)
            .fetch_optional(&mut *tx).await.map_err(|error|StoreError::Message(error.to_string()))?;
        if inserted.is_some() {
            sqlx::query(r#"INSERT INTO automation_jobs
                (id,organization_id,account_id,owner_address,name,enabled,trigger_set,target_agent_object_id,target_agent_key_ref,action,memory_scope,max_mist_per_run,retry_policy,archived,version)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)"#)
                .bind(job.id).bind(&job.organization_id).bind(&job.account_id).bind(&job.owner_address).bind(&job.name).bind(job.enabled)
                .bind(serde_json::to_value(&job.trigger_set).map_err(|error|StoreError::Message(error.to_string()))?)
                .bind(&job.target_agent_object_id).bind(&job.target_agent_key_ref)
                .bind(serde_json::to_value(&job.action).map_err(|error|StoreError::Message(error.to_string()))?)
                .bind(&job.memory_scope).bind(job.max_mist_per_run as i64)
                .bind(serde_json::to_value(&job.retry_policy).map_err(|error|StoreError::Message(error.to_string()))?)
                .bind(job.archived).bind(job.version.max(1) as i64)
                .execute(&mut *tx).await.map_err(|error|StoreError::Message(error.to_string()))?;
            tx.commit()
                .await
                .map_err(|error| StoreError::Message(error.to_string()))?;
            return Ok((job, true));
        }
        let existing=sqlx::query("SELECT request_hash,job_id FROM automation_job_creation_keys WHERE organization_id=$1 AND account_id=$2 AND owner_address=$3 AND target_agent_object_id=$4 AND request_key=$5 FOR UPDATE")
            .bind(&job.organization_id).bind(&job.account_id).bind(&job.owner_address).bind(&job.target_agent_object_id).bind(request_key)
            .fetch_optional(&mut *tx).await.map_err(|error|StoreError::Message(error.to_string()))?.ok_or(StoreError::NotFound)?;
        let saved_hash: Vec<u8> = sqlx::Row::get(&existing, "request_hash");
        let job_id: Option<Uuid> = sqlx::Row::get(&existing, "job_id");
        if saved_hash.as_slice() != request_hash {
            return Err(StoreError::IdempotencyConflict);
        }
        let row=sqlx::query_as::<_,JobRow>(r#"SELECT id,version,organization_id,account_id,owner_address,name,enabled,archived,trigger_set,target_agent_object_id,target_agent_key_ref,action,memory_scope,max_mist_per_run,retry_policy FROM automation_jobs WHERE id=$1"#)
            .bind(job_id.ok_or(StoreError::NotFound)?).fetch_optional(&mut *tx).await.map_err(|error|StoreError::Message(error.to_string()))?.ok_or(StoreError::NotFound)?;
        tx.commit()
            .await
            .map_err(|error| StoreError::Message(error.to_string()))?;
        Ok((row.into(), false))
    }

    async fn delete_job(&self, id: Uuid, expected_version: u64) -> Result<bool, StoreError> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        let exists = sqlx::query_scalar::<_, i64>(
            "SELECT version FROM automation_jobs WHERE id=$1 FOR UPDATE",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| StoreError::Message(e.to_string()))?;
        if exists.is_none() {
            tx.rollback()
                .await
                .map_err(|e| StoreError::Message(e.to_string()))?;
            return Ok(false);
        }
        if exists.is_some_and(|version| version < 0 || version as u64 != expected_version) {
            tx.rollback()
                .await
                .map_err(|e| StoreError::Message(e.to_string()))?;
            return Err(StoreError::Conflict);
        }
        let active_run: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM automation_runs WHERE job_id=$1 AND (status='running' OR finished_at IS NULL))",
        ).bind(id).fetch_one(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
        let active_delivery: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM automation_event_deliveries WHERE job_id=$1 AND status IN ('pending','running','reconciling'))",
        ).bind(id).fetch_one(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
        if active_run || active_delivery {
            tx.rollback()
                .await
                .map_err(|e| StoreError::Message(e.to_string()))?;
            return Err(StoreError::Conflict);
        }
        sqlx::query("DELETE FROM automation_jobs WHERE id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        tx.commit()
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        Ok(true)
    }

    async fn get_job(&self, id: Uuid) -> Result<Option<AutomationJob>, StoreError> {
        let row = sqlx::query_as::<_, JobRow>(
            r#"SELECT id, organization_id, account_id, owner_address, name, enabled, trigger_set,
                      target_agent_object_id, target_agent_key_ref, action, memory_scope,
                      max_mist_per_run, retry_policy, archived, version
               FROM automation_jobs WHERE id = $1"#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| StoreError::Message(e.to_string()))?;
        Ok(row.map(Into::into))
    }

    async fn rename_job(
        &self,
        id: Uuid,
        expected_version: u64,
        name: &str,
    ) -> Result<Option<AutomationJob>, StoreError> {
        let row = sqlx::query_as::<_, JobRow>(
            r#"UPDATE automation_jobs SET name = $3, version=version+1, updated_at = NOW()
               WHERE id = $1 AND version=$2
               RETURNING id, organization_id, account_id, owner_address, name, enabled, trigger_set,
                         target_agent_object_id, target_agent_key_ref, action, memory_scope,
                         max_mist_per_run, retry_policy, archived, version"#,
        )
        .bind(id)
        .bind(expected_version as i64)
        .bind(name)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| StoreError::Message(e.to_string()))?;
        if row.is_none()
            && sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM automation_jobs WHERE id=$1)",
            )
            .bind(id)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?
        {
            return Err(StoreError::Conflict);
        }
        Ok(row.map(Into::into))
    }

    async fn update_job_configuration(
        &self,
        id: Uuid,
        expected_version: u64,
        trigger_set: TriggerSet,
        action: JobAction,
    ) -> Result<Option<AutomationJob>, StoreError> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        let current = sqlx::query_as::<_, (bool, i64)>(
            "SELECT enabled, version FROM automation_jobs WHERE id=$1 FOR UPDATE",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| StoreError::Message(e.to_string()))?;
        let Some((enabled, version)) = current else {
            tx.rollback()
                .await
                .map_err(|e| StoreError::Message(e.to_string()))?;
            return Ok(None);
        };
        let active_run: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM automation_runs WHERE job_id=$1 AND (status='running' OR finished_at IS NULL))",
        ).bind(id).fetch_one(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
        let active_delivery: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM automation_event_deliveries WHERE job_id=$1 AND status IN ('pending','running','reconciling'))",
        ).bind(id).fetch_one(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
        if version < 0
            || version as u64 != expected_version
            || enabled
            || active_run
            || active_delivery
        {
            tx.rollback()
                .await
                .map_err(|e| StoreError::Message(e.to_string()))?;
            return Err(StoreError::Conflict);
        }
        let row = sqlx::query_as::<_, JobRow>(
            r#"UPDATE automation_jobs SET trigger_set=$3, action=$4, version=version+1, updated_at=NOW()
               WHERE id=$1 AND version=$2 AND enabled=false
               RETURNING id, organization_id, account_id, owner_address, name, enabled, trigger_set,
                         target_agent_object_id, target_agent_key_ref, action, memory_scope,
                         max_mist_per_run, retry_policy, archived, version"#,
        ).bind(id).bind(expected_version as i64)
            .bind(serde_json::to_value(&trigger_set).map_err(|e| StoreError::Message(e.to_string()))?)
            .bind(serde_json::to_value(&action).map_err(|e| StoreError::Message(e.to_string()))?)
            .fetch_optional(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
        sqlx::query("DELETE FROM automation_trigger_match_state WHERE job_id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        sqlx::query("DELETE FROM automation_trigger_state WHERE job_id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        tx.commit()
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        Ok(row.map(Into::into))
    }

    async fn set_job_archived(
        &self,
        id: Uuid,
        expected_version: u64,
        archived: bool,
    ) -> Result<Option<AutomationJob>, StoreError> {
        let row = sqlx::query_as::<_, JobRow>(
            r#"UPDATE automation_jobs SET archived = $3, enabled = CASE WHEN $3 THEN false ELSE enabled END, version=version+1, updated_at = NOW()
               WHERE id = $1 AND version=$2
               RETURNING id, organization_id, account_id, owner_address, name, enabled, trigger_set,
                         target_agent_object_id, target_agent_key_ref, action, memory_scope,
                         max_mist_per_run, retry_policy, archived, version"#,
        )
        .bind(id).bind(expected_version as i64).bind(archived).fetch_optional(&self.pool).await
        .map_err(|e| StoreError::Message(e.to_string()))?;
        if row.is_none()
            && sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM automation_jobs WHERE id=$1)",
            )
            .bind(id)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?
        {
            return Err(StoreError::Conflict);
        }
        Ok(row.map(Into::into))
    }

    async fn set_job_enabled(
        &self,
        id: Uuid,
        expected_version: u64,
        enabled: bool,
    ) -> Result<Option<AutomationJob>, StoreError> {
        let row = sqlx::query_as::<_, JobRow>(
            r#"UPDATE automation_jobs SET enabled = $3, version=version+1, updated_at = NOW()
               WHERE id = $1 AND version=$2 AND (NOT archived OR NOT $3)
               RETURNING id, organization_id, account_id, owner_address, name, enabled, trigger_set,
                         target_agent_object_id, target_agent_key_ref, action, memory_scope,
                         max_mist_per_run, retry_policy, archived, version"#,
        )
        .bind(id)
        .bind(expected_version as i64)
        .bind(enabled)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| StoreError::Message(e.to_string()))?;
        if row.is_none()
            && sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM automation_jobs WHERE id=$1)",
            )
            .bind(id)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?
        {
            return Err(StoreError::Conflict);
        }
        Ok(row.map(Into::into))
    }

    async fn cancel_job_queued_deliveries(
        &self,
        id: Uuid,
        expected_version: u64,
        actor: &str,
        note: &str,
    ) -> Result<Option<JobCancellationResult>, StoreError> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        let version = sqlx::query_scalar::<_, i64>(
            "UPDATE automation_jobs SET enabled=false,version=version+1,updated_at=NOW() WHERE id=$1 AND version=$2 RETURNING version"
        ).bind(id).bind(expected_version as i64).fetch_optional(&mut *tx).await.map_err(|e|StoreError::Message(e.to_string()))?;
        let Some(version) = version else {
            let exists = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM automation_jobs WHERE id=$1)",
            )
            .bind(id)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
            tx.rollback()
                .await
                .map_err(|e| StoreError::Message(e.to_string()))?;
            if exists {
                return Err(StoreError::Conflict);
            }
            return Ok(None);
        };
        let cancelled_ids = sqlx::query_scalar::<_, Uuid>(
            r#"WITH cancelled AS (
                   UPDATE automation_event_deliveries
                   SET status='cancelled',lease_token=NULL,lease_until=NULL,error='Cancelled before worker dispatch',resolved_by=$2,resolution='cancelled_before_dispatch',resolution_note=$3,updated_at=NOW()
                   WHERE job_id=$1 AND status='pending' RETURNING id,job_id
               )
               INSERT INTO automation_event_delivery_resolutions (delivery_id,job_id,actor,resolution,note)
               SELECT id,job_id,$2,'cancelled_before_dispatch',$3 FROM cancelled
               RETURNING delivery_id"#
        ).bind(id).bind(actor).bind(note).fetch_all(&mut *tx).await.map_err(|e|StoreError::Message(e.to_string()))?;
        sqlx::query("UPDATE automation_event_deliveries SET cancel_requested=true,cancel_actor=$2,cancel_note=$3,updated_at=NOW() WHERE job_id=$1 AND status='running' AND dispatch_started=false")
            .bind(id).bind(actor).bind(note).execute(&mut *tx).await.map_err(|e|StoreError::Message(e.to_string()))?;
        let in_flight: i64 = sqlx::query_scalar("SELECT count(*) FROM automation_event_deliveries WHERE job_id=$1 AND status IN ('running','reconciling')")
            .bind(id).fetch_one(&mut *tx).await.map_err(|e|StoreError::Message(e.to_string()))?;
        tx.commit()
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        Ok(Some(JobCancellationResult {
            job_id: id,
            version: version.max(1) as u64,
            cancelled_pending: cancelled_ids.len().min(u32::MAX as usize) as u32,
            in_flight: in_flight.max(0).min(u32::MAX as i64) as u32,
            enabled: false,
        }))
    }

    async fn list_enabled_jobs(&self) -> Result<Vec<AutomationJob>, StoreError> {
        let rows = sqlx::query_as::<_, JobRow>(
            r#"SELECT id, organization_id, account_id, owner_address, name, enabled, trigger_set,
                      target_agent_object_id, target_agent_key_ref, action, memory_scope,
                      max_mist_per_run, retry_policy, archived, version
               FROM automation_jobs WHERE enabled = true AND archived = false"#,
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
                      max_mist_per_run, retry_policy, archived, version
               FROM automation_jobs
               WHERE ($1::text IS NULL OR organization_id = $1)
                 AND ($2::text IS NULL OR account_id = $2)
                 AND ($3::text IS NULL OR lpad(lower(regexp_replace(btrim(target_agent_object_id),'^0[xX]','','g')),64,'0')=lpad(lower(regexp_replace(btrim($3),'^0[xX]','','g')),64,'0'))
               ORDER BY id ASC
               LIMIT $4 OFFSET $5"#,
        )
        .bind(filter.organization_id.as_deref())
        .bind(filter.account_id.as_deref())
        .bind(filter.target_agent_object_id.as_deref())
        .bind(filter.limit)
        .bind(filter.offset)
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

    async fn list_runs_page(
        &self,
        job_id: Uuid,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<RunSummary>, StoreError> {
        let rows=sqlx::query_as::<_,PgRunRow>(r#"SELECT id,job_id,status,attempt,cost_mist,error,started_at,finished_at FROM automation_runs WHERE job_id=$1 ORDER BY started_at DESC,id DESC LIMIT $2 OFFSET $3"#)
            .bind(job_id).bind(limit.clamp(1,MAX_LIST_LIMIT)).bind(offset.clamp(0,MAX_LIST_OFFSET)).fetch_all(&self.pool).await.map_err(|e|StoreError::Message(e.to_string()))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    async fn resolve_orphan_run(
        &self,
        job_id: Uuid,
        run_id: Uuid,
        resolution: &str,
        actor: &str,
        note: &str,
    ) -> Result<Option<RunSummary>, StoreError> {
        let status = if resolution == "confirmed_succeeded" {
            crate::RUN_STATUS_SUCCEEDED
        } else {
            crate::RUN_STATUS_ABANDONED
        };
        let message = format!("Owner reconciliation ({resolution}) by {}: {}", actor.trim(), note.trim());
        let row = sqlx::query_as::<_, PgRunRow>(
            r#"UPDATE automation_runs r
               SET status=$1,error=$2,finished_at=NOW()
               WHERE r.id=$3 AND r.job_id=$4
                 AND r.status IN ('running','reconciling')
                 AND r.started_at <= NOW()-INTERVAL '30 minutes'
                 AND NOT EXISTS (
                   SELECT 1 FROM automation_event_deliveries d
                   LEFT JOIN automation_ingested_events e ON e.deduplication_key=d.event_key
                   WHERE d.job_id=r.job_id AND r.trigger_event_id IS NOT NULL
                     AND (d.event_key=r.trigger_event_id OR e.envelope->>'source_event_id'=r.trigger_event_id)
                 )
               RETURNING r.id,r.job_id,r.status,r.attempt,r.cost_mist,r.error,r.started_at,r.finished_at"#,
        )
        .bind(status)
        .bind(message)
        .bind(run_id)
        .bind(job_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| StoreError::Message(e.to_string()))?;
        Ok(row.map(Into::into))
    }

    async fn record_run_start(
        &self,
        job_id: Uuid,
        trigger_set_snapshot: serde_json::Value,
        matched_triggers: serde_json::Value,
        trigger_event_id: Option<String>,
    ) -> Result<Uuid, StoreError> {
        let run_id = Uuid::new_v4();
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        if trigger_event_id.is_some() {
            sqlx::query("UPDATE automation_runs SET status='failed',error='A prior automation worker stopped; resuming from the encrypted work journal',finished_at=NOW() WHERE job_id=$1 AND trigger_event_id=$2 AND status IN ('running','reconciling') AND EXISTS(SELECT 1 FROM automation_jobs WHERE id=$1 AND action->>'kind'='work_run')")
                .bind(job_id).bind(&trigger_event_id).execute(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
        }
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
        .execute(&mut *tx)
        .await
        .map_err(|e| StoreError::Message(e.to_string()))?;
        tx.commit()
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

    async fn latest_scheduled_run_cursor(
        &self,
        job_id: Uuid,
    ) -> Result<Option<(String, chrono::DateTime<chrono::Utc>)>, StoreError> {
        let prefix = format!("automation:schedule:{job_id}:%");
        sqlx::query_as::<_, (String, chrono::DateTime<chrono::Utc>)>(
            r#"SELECT event_key,cursor_at FROM (
                   SELECT trigger_event_id AS event_key,started_at AS cursor_at
                   FROM automation_runs
                   WHERE job_id=$1 AND trigger_event_id LIKE $2
                   UNION ALL
                   SELECT d.event_key,COALESCE(MAX(r.created_at),d.created_at) AS cursor_at
                   FROM automation_event_deliveries d
                   JOIN automation_ingested_events e ON e.deduplication_key=d.event_key
                   LEFT JOIN automation_event_delivery_resolutions r
                     ON r.delivery_id=d.id AND r.resolution='cancelled_before_dispatch'
                   WHERE d.job_id=$1 AND d.event_key LIKE $2 AND d.status='cancelled'
                     AND d.resolution='cancelled_before_dispatch'
                     AND e.envelope->>'source_service'='automation_scheduler'
                   GROUP BY d.event_key,d.created_at
               ) cursors
               ORDER BY cursor_at DESC
               LIMIT 1"#,
        )
        .bind(job_id)
        .bind(prefix)
        .fetch_optional(&self.pool)
        .await
        .map(|row| {
            row.and_then(|(event_key, started_at)| {
                event_key
                    .strip_prefix(&format!("automation:schedule:{job_id}:"))
                    .map(|window| (window.to_string(), started_at))
            })
        })
        .map_err(|e| StoreError::Message(e.to_string()))
    }

    async fn has_run_for_event(&self, job_id: Uuid, event_key: &str) -> Result<bool, StoreError> {
        sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM automation_runs WHERE job_id=$1 AND trigger_event_id=$2)",
        )
        .bind(job_id)
        .bind(event_key)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| StoreError::Message(e.to_string()))
    }

    async fn ingest_event_dedup(&self, event: &PlatformEvent) -> Result<bool, StoreError> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        if let Some(target) = event.target_job_id {
            let enabled = sqlx::query_scalar::<_, bool>(
                "SELECT enabled AND NOT archived FROM automation_jobs WHERE id=$1 FOR SHARE",
            )
            .bind(target)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
            if enabled != Some(true) {
                tx.rollback()
                    .await
                    .map_err(|e| StoreError::Message(e.to_string()))?;
                return Err(StoreError::Conflict);
            }
        }
        let result = sqlx::query(
            r#"INSERT INTO automation_ingested_events (deduplication_key, event_family, event_type, envelope)
               VALUES ($1,$2,$3,$4) ON CONFLICT (deduplication_key) DO NOTHING"#,
        ).bind(&event.deduplication_key).bind(&event.event_family).bind(&event.event_type)
         .bind(serde_json::to_value(event).map_err(|e| StoreError::Message(e.to_string()))?)
         .execute(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
        let fresh = result.rows_affected() > 0;
        if fresh {
            let jobs: Vec<(Uuid, serde_json::Value)> = sqlx::query_as("SELECT id,trigger_set FROM automation_jobs WHERE enabled=true AND ($3::uuid IS NULL OR id=$3) AND (($1::text IS NOT NULL AND organization_id=$1) OR ($1::text IS NULL AND $2::text IS NOT NULL AND lower(btrim(account_id))=lower(btrim($2))) OR ($1::text IS NULL AND $2::text IS NULL))")
                .bind(event.organization_id.as_deref()).bind(event.account_id.as_deref())
                .bind(event.target_job_id)
                .fetch_all(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
            for (job_id, trigger_json) in jobs {
                let trigger_set: TriggerSet =
                    serde_json::from_value(trigger_json).map_err(|e| {
                        StoreError::Message(format!("invalid trigger set for job {job_id}: {e}"))
                    })?;
                let debounce_ms = trigger_debounce_for_event(&trigger_set, event);
                if let Some(debounce_ms) = debounce_ms {
                    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
                        .bind(job_id.to_string())
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| StoreError::Message(e.to_string()))?;
                    let existing: Option<Uuid> = sqlx::query_scalar("SELECT id FROM automation_event_deliveries WHERE job_id=$1 AND status='pending' AND debounce_coalescible=true ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE")
                        .bind(job_id).fetch_optional(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
                    if let Some(id) = existing {
                        sqlx::query("UPDATE automation_event_deliveries SET event_key=$2,available_at=NOW()+($3::bigint * INTERVAL '1 millisecond'),updated_at=NOW(),error=NULL WHERE id=$1 AND status='pending'")
                            .bind(id).bind(&event.deduplication_key).bind(debounce_ms)
                            .execute(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
                        if trigger_set.match_mode == MatchMode::All {
                            sqlx::query("INSERT INTO automation_trigger_match_events(job_id,event_key,fired) VALUES($1,$2,true) ON CONFLICT(job_id,event_key) DO UPDATE SET fired=true")
                                .bind(job_id).bind(&event.deduplication_key).execute(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
                        }
                    } else {
                        if trigger_set.match_mode == MatchMode::All {
                            let matched: Vec<usize> = trigger_set
                                .triggers
                                .iter()
                                .enumerate()
                                .filter_map(|(index, trigger)| {
                                    crate::trigger_eval::event_matches_trigger(event, trigger)
                                        .then_some(index)
                                })
                                .collect();
                            sqlx::query("INSERT INTO automation_trigger_match_events(job_id,event_key,fired) VALUES($1,$2,false) ON CONFLICT DO NOTHING")
                                .bind(job_id).bind(&event.deduplication_key).execute(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
                            for index in matched {
                                sqlx::query("INSERT INTO automation_trigger_match_state(job_id,trigger_index,matched_at_ms) VALUES($1,$2,$3) ON CONFLICT(job_id,trigger_index) DO UPDATE SET matched_at_ms=GREATEST(automation_trigger_match_state.matched_at_ms,EXCLUDED.matched_at_ms)")
                                    .bind(job_id).bind(index as i32).bind(event.occurred_at_ms).execute(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
                            }
                            if trigger_set.evaluation_window_ms > 0 {
                                sqlx::query("DELETE FROM automation_trigger_match_state WHERE job_id=$1 AND matched_at_ms < $2")
                                    .bind(job_id).bind(event.occurred_at_ms.saturating_sub(trigger_set.evaluation_window_ms))
                                    .execute(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
                            }
                            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM automation_trigger_match_state WHERE job_id=$1 AND trigger_index < $2 AND matched_at_ms <= $3 AND ($4 <= 0 OR matched_at_ms >= $5)")
                                .bind(job_id).bind(trigger_set.triggers.len() as i32).bind(event.occurred_at_ms)
                                .bind(trigger_set.evaluation_window_ms).bind(event.occurred_at_ms.saturating_sub(trigger_set.evaluation_window_ms))
                                .fetch_one(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
                            if count < trigger_set.triggers.len() as i64 {
                                continue;
                            }
                            sqlx::query("UPDATE automation_trigger_match_events SET fired=true WHERE job_id=$1 AND event_key=$2")
                                .bind(job_id).bind(&event.deduplication_key).execute(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
                            sqlx::query(
                                "DELETE FROM automation_trigger_match_state WHERE job_id=$1",
                            )
                            .bind(job_id)
                            .execute(&mut *tx)
                            .await
                            .map_err(|e| StoreError::Message(e.to_string()))?;
                        }
                        sqlx::query("INSERT INTO automation_event_deliveries (id,event_key,job_id,available_at,debounce_coalescible) VALUES ($1,$2,$3,NOW()+($4::bigint * INTERVAL '1 millisecond'),true) ON CONFLICT (event_key,job_id) DO NOTHING")
                            .bind(Uuid::new_v4()).bind(&event.deduplication_key).bind(job_id).bind(debounce_ms)
                            .execute(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
                    }
                } else {
                    sqlx::query("INSERT INTO automation_event_deliveries (id, event_key, job_id) VALUES ($1,$2,$3) ON CONFLICT (event_key,job_id) DO NOTHING")
                        .bind(Uuid::new_v4()).bind(&event.deduplication_key).bind(job_id)
                        .execute(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
                }
            }
        }
        tx.commit()
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        Ok(fresh)
    }

    async fn ingest_scheduled_event(
        &self,
        event: &PlatformEvent,
        token: Uuid,
    ) -> Result<bool, StoreError> {
        // Hold a shared row lock while fanout commits. Lease takeover updates this row, so a
        // stale scheduler cannot enqueue a slot after a successor has acquired the lease.
        let mut guard = self
            .pool
            .begin()
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        let owns_live_lease: Option<Uuid> = sqlx::query_scalar(
            "SELECT lease_token FROM automation_scheduler_leases WHERE lease_name='cron' AND lease_token=$1 AND lease_until>NOW() FOR SHARE",
        )
        .bind(token)
        .fetch_optional(&mut *guard)
        .await
        .map_err(|e| StoreError::Message(e.to_string()))?;
        if owns_live_lease != Some(token) {
            guard
                .rollback()
                .await
                .map_err(|e| StoreError::Message(e.to_string()))?;
            return Err(StoreError::Conflict);
        }
        let result = self.ingest_event_dedup(event).await;
        match result {
            Ok(fresh) => {
                guard
                    .commit()
                    .await
                    .map_err(|e| StoreError::Message(e.to_string()))?;
                Ok(fresh)
            }
            Err(error) => {
                guard
                    .rollback()
                    .await
                    .map_err(|e| StoreError::Message(e.to_string()))?;
                Err(error)
            }
        }
    }
    async fn record_all_trigger_matches(
        &self,
        job_id: Uuid,
        event_key: &str,
        matched: &[usize],
        trigger_count: usize,
        window_ms: i64,
        now_ms: i64,
    ) -> Result<bool, StoreError> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(job_id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        let inserted = sqlx::query("INSERT INTO automation_trigger_match_events (job_id,event_key,fired) VALUES ($1,$2,false) ON CONFLICT DO NOTHING")
            .bind(job_id).bind(event_key).execute(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?.rows_affected() == 1;
        if !inserted {
            let fired: bool = sqlx::query_scalar("SELECT fired FROM automation_trigger_match_events WHERE job_id=$1 AND event_key=$2")
                .bind(job_id).bind(event_key).fetch_one(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
            tx.commit()
                .await
                .map_err(|e| StoreError::Message(e.to_string()))?;
            return Ok(fired);
        }
        for index in matched {
            sqlx::query("INSERT INTO automation_trigger_match_state (job_id,trigger_index,matched_at_ms) VALUES ($1,$2,$3) ON CONFLICT (job_id,trigger_index) DO UPDATE SET matched_at_ms=GREATEST(automation_trigger_match_state.matched_at_ms,EXCLUDED.matched_at_ms)")
                .bind(job_id).bind(*index as i32).bind(now_ms).execute(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
        }
        if window_ms > 0 {
            sqlx::query(
                "DELETE FROM automation_trigger_match_state WHERE job_id=$1 AND matched_at_ms < $2",
            )
            .bind(job_id)
            .bind(now_ms.saturating_sub(window_ms))
            .execute(&mut *tx)
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        }
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM automation_trigger_match_state WHERE job_id=$1 AND trigger_index < $2 AND matched_at_ms <= $4 AND ($3 <= 0 OR matched_at_ms >= $5)")
            .bind(job_id).bind(trigger_count as i32).bind(window_ms).bind(now_ms).bind(now_ms.saturating_sub(window_ms)).fetch_one(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
        let complete = count >= trigger_count as i64;
        if complete {
            sqlx::query("UPDATE automation_trigger_match_events SET fired=true WHERE job_id=$1 AND event_key=$2")
                .bind(job_id).bind(event_key).execute(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
            sqlx::query("DELETE FROM automation_trigger_match_state WHERE job_id=$1")
                .bind(job_id)
                .execute(&mut *tx)
                .await
                .map_err(|e| StoreError::Message(e.to_string()))?;
        }
        tx.commit()
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        Ok(complete)
    }
    async fn authorize_trigger_fires(
        &self,
        job_id: Uuid,
        event_key: &str,
        policies: &[(usize, i64, Option<u32>)],
        now_ms: i64,
    ) -> Result<bool, StoreError> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(job_id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        let mut next = Vec::with_capacity(policies.len());
        for (index, debounce_ms, maximum) in policies {
            sqlx::query("INSERT INTO automation_trigger_state (job_id,trigger_index) VALUES ($1,$2) ON CONFLICT DO NOTHING")
                .bind(job_id).bind(*index as i32).execute(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
            let row: (Option<i64>, i64, Option<i64>) = sqlx::query_as("SELECT last_fired_at_ms,execution_count_window,window_started_at_ms FROM automation_trigger_state WHERE job_id=$1 AND trigger_index=$2 FOR UPDATE")
                .bind(job_id).bind(*index as i32).fetch_one(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
            let _ = row;
            if let Some(maximum) = maximum {
                let cutoff = now_ms.saturating_sub(*debounce_ms);
                sqlx::query("DELETE FROM automation_trigger_fires WHERE job_id=$1 AND trigger_index=$2 AND fired_at_ms < $3")
                    .bind(job_id).bind(*index as i32).bind(cutoff).execute(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
                let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM automation_trigger_fires WHERE job_id=$1 AND trigger_index=$2 AND fired_at_ms >= $3 AND fired_at_ms <= $4")
                    .bind(job_id).bind(*index as i32).bind(cutoff).bind(now_ms).fetch_one(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
                if count >= i64::from(*maximum) {
                    tx.commit()
                        .await
                        .map_err(|e| StoreError::Message(e.to_string()))?;
                    return Ok(false);
                }
            }
            next.push((*index, *debounce_ms, maximum.is_some()));
        }
        for (index, debounce_ms, has_cap) in next {
            if debounce_ms > 0 && has_cap {
                sqlx::query("INSERT INTO automation_trigger_fires(job_id,trigger_index,fired_at_ms,event_key) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING")
                    .bind(job_id).bind(index as i32).bind(now_ms).bind(event_key).execute(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
            }
            sqlx::query("UPDATE automation_trigger_state SET last_fired_at_ms=$3,last_dedup_key=$4 WHERE job_id=$1 AND trigger_index=$2")
                .bind(job_id).bind(index as i32).bind(now_ms).bind(event_key)
                .execute(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
        }
        tx.commit()
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        Ok(true)
    }
    async fn list_event_deliveries(
        &self,
        job_id: Uuid,
        limit: i64,
    ) -> Result<Vec<EventDeliverySummary>, StoreError> {
        sqlx::query_as::<_, EventDeliverySummary>(r#"SELECT d.id,d.job_id,d.event_key,d.status,d.attempts,d.lease_until,d.error,d.resolved_by,d.resolution,d.resolution_note,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('actor',r.actor,'resolution',r.resolution,'note',r.note,'createdAt',r.created_at) ORDER BY r.created_at ASC)
                      FROM automation_event_delivery_resolutions r WHERE r.delivery_id=d.id),'[]'::jsonb) AS resolution_history
            FROM automation_event_deliveries d WHERE d.job_id=$1 ORDER BY d.created_at DESC,d.id DESC LIMIT $2"#)
            .bind(job_id).bind(limit.clamp(1, MAX_LIST_LIMIT)).fetch_all(&self.pool).await.map_err(|e| StoreError::Message(e.to_string()))
    }
    async fn list_event_deliveries_page(
        &self,
        job_id: Uuid,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<EventDeliverySummary>, StoreError> {
        sqlx::query_as::<_,EventDeliverySummary>(r#"SELECT d.id,d.job_id,d.event_key,d.status,d.attempts,d.lease_until,d.error,d.resolved_by,d.resolution,d.resolution_note,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('actor',r.actor,'resolution',r.resolution,'note',r.note,'createdAt',r.created_at) ORDER BY r.created_at ASC) FROM automation_event_delivery_resolutions r WHERE r.delivery_id=d.id),'[]'::jsonb) AS resolution_history
            FROM automation_event_deliveries d WHERE d.job_id=$1 ORDER BY d.created_at DESC,d.id DESC LIMIT $2 OFFSET $3"#)
            .bind(job_id).bind(limit.clamp(1,MAX_LIST_LIMIT)).bind(offset.clamp(0,MAX_LIST_OFFSET)).fetch_all(&self.pool).await.map_err(|e|StoreError::Message(e.to_string()))
    }
    async fn resolve_event_delivery(
        &self,
        id: Uuid,
        job_id: Uuid,
        resolution: &str,
        actor: &str,
        note: &str,
    ) -> Result<Option<EventDeliverySummary>, StoreError> {
        let status = if resolution == "confirmed_succeeded" {
            "done"
        } else {
            "pending"
        };
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        let updated = sqlx::query_scalar::<_, String>(
            "UPDATE automation_event_deliveries SET status=$3,lease_token=NULL,lease_until=NULL,error=NULL,resolved_by=$4,resolution=$5,resolution_note=$6,updated_at=NOW() WHERE id=$1 AND job_id=$2 AND status='reconciling' RETURNING event_key"
        ).bind(id).bind(job_id).bind(status).bind(actor).bind(resolution).bind(note).fetch_optional(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
        if let Some(event_key) = updated.as_deref() {
            let (run_status, run_error) = if resolution == "confirmed_succeeded" {
                (crate::RUN_STATUS_SUCCEEDED, None)
            } else {
                (
                    crate::RUN_STATUS_FAILED,
                    Some("Owner confirmed no external action executed; delivery queued for retry"),
                )
            };
            sqlx::query("UPDATE automation_runs r SET status=$3,error=$4,finished_at=NOW() FROM automation_ingested_events e WHERE e.deduplication_key=$2 AND r.job_id=$1 AND r.trigger_event_id IN ($2,e.envelope->>'source_event_id') AND r.status='reconciling'")
                .bind(job_id).bind(event_key).bind(run_status).bind(run_error)
                .execute(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
            sqlx::query("INSERT INTO automation_event_delivery_resolutions (delivery_id,job_id,actor,resolution,note) VALUES ($1,$2,$3,$4,$5)")
                .bind(id).bind(job_id).bind(actor).bind(resolution).bind(note).execute(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
        }
        let row = if updated.is_some() {
            sqlx::query_as::<_, EventDeliverySummary>(r#"SELECT d.id,d.job_id,d.event_key,d.status,d.attempts,d.lease_until,d.error,d.resolved_by,d.resolution,d.resolution_note,
                COALESCE((SELECT jsonb_agg(jsonb_build_object('actor',r.actor,'resolution',r.resolution,'note',r.note,'createdAt',r.created_at) ORDER BY r.created_at ASC)
                          FROM automation_event_delivery_resolutions r WHERE r.delivery_id=d.id),'[]'::jsonb) AS resolution_history
                FROM automation_event_deliveries d WHERE d.id=$1 AND d.job_id=$2"#)
                .bind(id).bind(job_id).fetch_optional(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?
        } else {
            None
        };
        tx.commit()
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        Ok(row)
    }
    async fn cancel_event_delivery(
        &self,
        id: Uuid,
        job_id: Uuid,
        actor: &str,
        note: &str,
    ) -> Result<Option<EventDeliverySummary>, StoreError> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        let updated = sqlx::query_scalar::<_, Uuid>(
            "UPDATE automation_event_deliveries SET status='cancelled',lease_token=NULL,lease_until=NULL,error='Cancelled before worker dispatch',resolved_by=$3,resolution='cancelled_before_dispatch',resolution_note=$4,updated_at=NOW() WHERE id=$1 AND job_id=$2 AND status='pending' RETURNING id"
        ).bind(id).bind(job_id).bind(actor).bind(note).fetch_optional(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
        if updated.is_some() {
            sqlx::query("INSERT INTO automation_event_delivery_resolutions (delivery_id,job_id,actor,resolution,note) VALUES ($1,$2,$3,'cancelled_before_dispatch',$4)")
                .bind(id).bind(job_id).bind(actor).bind(note).execute(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
        }
        let row = if updated.is_some() {
            sqlx::query_as::<_, EventDeliverySummary>(r#"SELECT d.id,d.job_id,d.event_key,d.status,d.attempts,d.lease_until,d.error,d.resolved_by,d.resolution,d.resolution_note,
                COALESCE((SELECT jsonb_agg(jsonb_build_object('actor',r.actor,'resolution',r.resolution,'note',r.note,'createdAt',r.created_at) ORDER BY r.created_at ASC)
                          FROM automation_event_delivery_resolutions r WHERE r.delivery_id=d.id),'[]'::jsonb) AS resolution_history
                FROM automation_event_deliveries d WHERE d.id=$1 AND d.job_id=$2"#)
                .bind(id).bind(job_id).fetch_optional(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?
        } else {
            sqlx::query_as::<_, EventDeliverySummary>(r#"SELECT d.id,d.job_id,d.event_key,d.status,d.attempts,d.lease_until,d.error,d.resolved_by,d.resolution,d.resolution_note,
                COALESCE((SELECT jsonb_agg(jsonb_build_object('actor',r.actor,'resolution',r.resolution,'note',r.note,'createdAt',r.created_at) ORDER BY r.created_at ASC)
                          FROM automation_event_delivery_resolutions r WHERE r.delivery_id=d.id),'[]'::jsonb) AS resolution_history
                FROM automation_event_deliveries d WHERE d.id=$1 AND d.job_id=$2 AND d.status='cancelled' AND d.resolution='cancelled_before_dispatch'"#)
                .bind(id).bind(job_id).fetch_optional(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?
        };
        tx.commit()
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        Ok(row)
    }
    async fn claim_event_delivery(&self) -> Result<Option<EventDeliveryClaim>, StoreError> {
        // Most expired deliveries have an unknown external outcome. Work-run actions are
        // replayable through their own encrypted journal, which holds unresolved operations.
        sqlx::query(
            r#"WITH expired AS (
                   UPDATE automation_event_deliveries d
                   SET status=CASE WHEN j.action->>'kind'='work_run' AND d.attempts < $1 THEN 'pending' ELSE 'reconciling' END,
                       lease_token=NULL,lease_until=NULL,
                       dispatch_started=CASE WHEN j.action->>'kind'='work_run' AND d.attempts < $1 THEN false ELSE d.dispatch_started END,
                       available_at=CASE WHEN j.action->>'kind'='work_run' AND d.attempts < $1 THEN NOW()+INTERVAL '5 seconds' ELSE d.available_at END,
                       error=CASE WHEN j.action->>'kind'='work_run' AND d.attempts < $1 THEN 'Work-run worker lease expired; retrying through the encrypted work journal' ELSE 'Worker lease expired; reconcile external outcome' END,
                       updated_at=NOW()
                   FROM automation_jobs j,automation_ingested_events e
                   WHERE d.job_id=j.id AND e.deduplication_key=d.event_key
                     AND d.status='running' AND d.lease_until < NOW()
                   RETURNING d.job_id,d.event_key,d.error,e.envelope->>'source_event_id' AS source_event_id
               )
               UPDATE automation_runs r
               SET status='reconciling',finished_at=NOW(),error=expired.error
               FROM expired
               WHERE r.job_id=expired.job_id
                 AND r.trigger_event_id IN (expired.event_key,expired.source_event_id)
                 AND r.status='running'"#,
        )
            .bind(MAX_SAFE_DELIVERY_ATTEMPTS).execute(&self.pool).await.map_err(|e| StoreError::Message(e.to_string()))?;
        let token = Uuid::new_v4();
        let row: Option<(Uuid, Uuid, serde_json::Value)> = sqlx::query_as(
            r#"WITH candidate AS (
                SELECT d.id FROM automation_event_deliveries d
                JOIN automation_jobs j ON j.id=d.job_id AND j.enabled=true AND j.archived=false
                WHERE d.status='pending' AND d.available_at<=NOW()
                  AND NOT EXISTS (
                    SELECT 1 FROM automation_event_deliveries active
                    WHERE active.job_id=d.job_id AND active.id<>d.id
                      AND (active.status IN ('running','reconciling') OR (active.status='pending' AND active.attempts>0))
                  )
                -- Lock the parent job row as well as its queue row. Multiple
                -- workers therefore cannot claim two deliveries for one job
                -- from the same pre-update snapshot.
                ORDER BY d.available_at, d.created_at, d.id FOR UPDATE OF j,d SKIP LOCKED LIMIT 1
            ) UPDATE automation_event_deliveries AS d
              SET status='running', lease_token=$1, lease_until=NOW()+INTERVAL '5 minutes', attempts=attempts+1, resolved_by=NULL, resolution=NULL, resolution_note=NULL, dispatch_started=false, cancel_requested=false, cancel_actor=NULL, cancel_note=NULL, updated_at=NOW()
              FROM candidate c, automation_ingested_events e
              WHERE d.id=c.id AND d.event_key=e.deduplication_key
              RETURNING d.id,d.job_id,e.envelope"#,
        ).bind(token).fetch_optional(&self.pool).await.map_err(|e| StoreError::Message(e.to_string()))?;
        row.map(|(id, job_id, envelope)| {
            Ok(EventDeliveryClaim {
                id,
                token,
                job_id,
                event: serde_json::from_value(envelope)
                    .map_err(|e| StoreError::Message(e.to_string()))?,
            })
        })
        .transpose()
    }
    async fn begin_event_delivery_dispatch(
        &self,
        id: Uuid,
        token: Uuid,
    ) -> Result<bool, StoreError> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        let enabled = sqlx::query_scalar::<_, bool>("SELECT enabled AND NOT archived FROM automation_jobs j JOIN automation_event_deliveries d ON d.job_id=j.id WHERE d.id=$1 FOR SHARE OF j")
            .bind(id).fetch_optional(&mut *tx).await.map_err(|e|StoreError::Message(e.to_string()))?;
        if enabled != Some(true) {
            tx.rollback()
                .await
                .map_err(|e| StoreError::Message(e.to_string()))?;
            return Ok(false);
        }
        let result = sqlx::query("UPDATE automation_event_deliveries SET dispatch_started=true,updated_at=NOW() WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>NOW() AND cancel_requested=false AND dispatch_started=false")
            .bind(id).bind(token).execute(&mut *tx).await.map_err(|e|StoreError::Message(e.to_string()))?;
        tx.commit()
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        Ok(result.rows_affected() == 1)
    }
    async fn defer_event_delivery(&self, id: Uuid, token: Uuid) -> Result<bool, StoreError> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        let row = sqlx::query_as::<_, (String, Option<String>, Option<String>)>(
            r#"UPDATE automation_event_deliveries d
               SET status=CASE WHEN d.cancel_requested THEN 'cancelled' ELSE 'pending' END,
                   lease_token=NULL,lease_until=NULL,
                   error=CASE WHEN d.cancel_requested THEN 'Cancelled before worker dispatch' ELSE 'Job paused before delivery dispatch' END,
                   resolved_by=CASE WHEN d.cancel_requested THEN d.cancel_actor ELSE d.resolved_by END,
                   resolution=CASE WHEN d.cancel_requested THEN 'cancelled_before_dispatch' ELSE d.resolution END,
                   resolution_note=CASE WHEN d.cancel_requested THEN d.cancel_note ELSE d.resolution_note END,
                   updated_at=NOW()
               WHERE d.id=$1 AND d.lease_token=$2 AND d.status='running' AND d.lease_until>NOW()
               RETURNING d.status,d.resolved_by,d.resolution_note"#
        ).bind(id).bind(token).fetch_optional(&mut *tx).await.map_err(|e|StoreError::Message(e.to_string()))?;
        if let Some((status, actor, note)) = row {
            if status == "cancelled" {
                sqlx::query("INSERT INTO automation_event_delivery_resolutions (delivery_id,job_id,actor,resolution,note) SELECT id,job_id,$2,'cancelled_before_dispatch',$3 FROM automation_event_deliveries WHERE id=$1")
                    .bind(id).bind(actor.unwrap_or_else(||"unknown".into())).bind(note.unwrap_or_else(||"Job-level cancellation before worker dispatch".into()))
                    .execute(&mut *tx).await.map_err(|e|StoreError::Message(e.to_string()))?;
            }
            tx.commit()
                .await
                .map_err(|e| StoreError::Message(e.to_string()))?;
            Ok(true)
        } else {
            tx.rollback()
                .await
                .map_err(|e| StoreError::Message(e.to_string()))?;
            Ok(false)
        }
    }
    async fn retry_event_delivery(
        &self,
        id: Uuid,
        token: Uuid,
        error: &str,
    ) -> Result<bool, StoreError> {
        let result = sqlx::query("UPDATE automation_event_deliveries d SET status=CASE WHEN attempts >= $4 THEN 'reconciling' ELSE 'pending' END,lease_token=NULL,lease_until=NULL,dispatch_started=false,error=$3,available_at=CASE WHEN attempts < $4 THEN NOW()+(LEAST(POWER(2,GREATEST(attempts,1)),60)::double precision*INTERVAL '1 second') ELSE available_at END,updated_at=NOW() WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>NOW() AND cancel_requested=false AND (dispatch_started=false OR EXISTS(SELECT 1 FROM automation_jobs j WHERE j.id=d.job_id AND j.action->>'kind'='work_run'))")
            .bind(id).bind(token).bind(error.chars().take(2048).collect::<String>()).bind(MAX_SAFE_DELIVERY_ATTEMPTS)
            .execute(&self.pool).await.map_err(|e|StoreError::Message(e.to_string()))?;
        Ok(result.rows_affected() == 1)
    }
    async fn renew_event_delivery(&self, id: Uuid, token: Uuid) -> Result<bool, StoreError> {
        let result = sqlx::query("UPDATE automation_event_deliveries SET lease_until=NOW()+INTERVAL '5 minutes',updated_at=NOW() WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>NOW()")
            .bind(id).bind(token).execute(&self.pool).await.map_err(|e| StoreError::Message(e.to_string()))?;
        Ok(result.rows_affected() == 1)
    }
    async fn finish_event_delivery(
        &self,
        id: Uuid,
        token: Uuid,
        error: Option<String>,
    ) -> Result<bool, StoreError> {
        let status = if error.is_some() {
            "reconciling"
        } else {
            "done"
        };
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        let event_key = sqlx::query_scalar::<_, String>(
            "UPDATE automation_event_deliveries SET status=$3,error=$4,lease_until=NULL,updated_at=NOW() WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>NOW() RETURNING event_key",
        )
        .bind(id).bind(token).bind(status).bind(error.as_deref())
        .fetch_optional(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
        if let (Some(event_key), Some(message)) = (event_key.as_deref(), error.as_deref()) {
            sqlx::query("UPDATE automation_runs r SET status='reconciling',error=$3,finished_at=NOW() FROM automation_ingested_events e WHERE e.deduplication_key=$2 AND r.job_id=(SELECT job_id FROM automation_event_deliveries WHERE id=$1) AND r.trigger_event_id IN ($2,e.envelope->>'source_event_id') AND r.status='running'")
                .bind(id).bind(event_key).bind(message)
                .execute(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
        }
        tx.commit()
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        Ok(event_key.is_some())
    }

    async fn put_delegate(&self, record: DelegateRecord) -> Result<(), StoreError> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))")
            .bind(&record.account_id)
            .bind(&record.delegate_ref)
            .execute(&mut *tx)
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        let existed: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM automation_delegate_keys WHERE account_id=$1 AND delegate_ref=$2)")
            .bind(&record.account_id).bind(&record.delegate_ref).fetch_one(&mut *tx).await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        let result = sqlx::query(
            r#"INSERT INTO automation_delegate_keys
               (account_id, delegate_ref, agent_object_id, mydata_key_id, encrypted_key,
                delegate_class, allowed_action_ids)
               VALUES ($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT (account_id, delegate_ref) DO UPDATE SET
                   agent_object_id = EXCLUDED.agent_object_id,
                   mydata_key_id = EXCLUDED.mydata_key_id,
                   encrypted_key = EXCLUDED.encrypted_key,
                   delegate_class = EXCLUDED.delegate_class,
                   allowed_action_ids = EXCLUDED.allowed_action_ids,
                   created_at = NOW()
               WHERE lpad(lower(regexp_replace(btrim(automation_delegate_keys.agent_object_id),'^0[xX]','','g')),64,'0')=lpad(lower(regexp_replace(btrim(EXCLUDED.agent_object_id),'^0[xX]','','g')),64,'0')"#,
        )
        .bind(&record.account_id)
        .bind(&record.delegate_ref)
        .bind(&record.agent_object_id)
        .bind(&record.mydata_key_id)
        .bind(&record.encrypted_key)
        .bind(&record.delegate_class)
        .bind(sqlx::types::Json(&record.allowed_action_ids))
        .execute(&mut *tx)
        .await
        .map_err(|e| StoreError::Message(e.to_string()))?;
        if result.rows_affected() != 1 {
            return Err(StoreError::Message(
                "delegate reference is already bound to another agent".into(),
            ));
        }
        let event_type = if existed { "replaced" } else { "created" };
        sqlx::query("INSERT INTO automation_delegate_key_events (account_id, delegate_ref, agent_object_id, mydata_key_id, event_type) VALUES ($1,$2,$3,$4,$5)")
            .bind(&record.account_id).bind(&record.delegate_ref).bind(&record.agent_object_id).bind(&record.mydata_key_id).bind(event_type)
            .execute(&mut *tx).await.map_err(|e| StoreError::Message(e.to_string()))?;
        tx.commit()
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        Ok(())
    }

    async fn list_delegate_key_events(
        &self,
        account_id: &str,
        agent_object_id: Option<&str>,
        after: Option<i64>,
        limit: i64,
    ) -> Result<DelegateKeyEventPage, StoreError> {
        let rows = sqlx::query_as::<_, PgDelegateKeyEvent>(
            "SELECT id, delegate_ref, agent_object_id, mydata_key_id, event_type, recorded_at FROM automation_delegate_key_events WHERE account_id=$1 AND ($2::bigint IS NULL OR id>$2) AND ($3::text IS NULL OR lpad(lower(regexp_replace(btrim(agent_object_id),'^0[xX]','','g')),64,'0')=lpad(lower(regexp_replace(btrim($3),'^0[xX]','','g')),64,'0')) ORDER BY id LIMIT $4"
        ).bind(account_id).bind(after).bind(agent_object_id).bind(limit.clamp(1, MAX_DELEGATE_LIST_LIMIT)+1)
            .fetch_all(&self.pool).await.map_err(|e| StoreError::Message(e.to_string()))?;
        let mut data: Vec<DelegateKeyEvent> = rows.into_iter().map(Into::into).collect();
        let limit = limit.clamp(1, MAX_DELEGATE_LIST_LIMIT) as usize;
        let has_next_page = data.len() > limit;
        data.truncate(limit);
        let next_cursor = has_next_page
            .then(|| data.last().map(|event| event.id.clone()))
            .flatten();
        Ok(DelegateKeyEventPage {
            data,
            has_next_page,
            next_cursor,
        })
    }

    async fn list_delegates(
        &self,
        account_id: &str,
        agent_object_id: Option<&str>,
        after: Option<&str>,
        limit: i64,
    ) -> Result<DelegatePage, StoreError> {
        // The encrypted column is deliberately not selected.
        let rows = sqlx::query_as::<_, PgDelegateSummary>(
            r#"SELECT delegate_ref, agent_object_id, mydata_key_id, delegate_class,
                      allowed_action_ids, created_at
               FROM automation_delegate_keys WHERE account_id = $1
                 AND ($2::text IS NULL OR delegate_ref > $2)
                 AND ($3::text IS NULL OR lpad(lower(regexp_replace(btrim(agent_object_id),'^0[xX]','','g')),64,'0') = lpad(lower(regexp_replace(btrim($3),'^0[xX]','','g')),64,'0'))
               ORDER BY delegate_ref LIMIT $4"#,
        )
        .bind(account_id)
        .bind(after)
        .bind(agent_object_id)
        .bind(limit.clamp(1, MAX_DELEGATE_LIST_LIMIT) + 1)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| StoreError::Message(e.to_string()))?;
        let mut data: Vec<DelegateSummary> = rows
            .into_iter()
            .map(|r| DelegateSummary {
                delegate_ref: r.delegate_ref,
                agent_object_id: r.agent_object_id,
                mydata_key_id: r.mydata_key_id,
                delegate_class: r.delegate_class,
                allowed_action_ids: r.allowed_action_ids.0,
                created_at: r.created_at,
            })
            .collect();
        let limit = limit.clamp(1, MAX_DELEGATE_LIST_LIMIT) as usize;
        let has_next_page = data.len() > limit;
        data.truncate(limit);
        let next_cursor = has_next_page
            .then(|| data.last().map(|row| row.delegate_ref.clone()))
            .flatten();
        Ok(DelegatePage {
            data,
            has_next_page,
            next_cursor,
        })
    }

    async fn get_delegate_summary(
        &self,
        account_id: &str,
        delegate_ref: &str,
    ) -> Result<Option<DelegateSummary>, StoreError> {
        let row = sqlx::query_as::<_, PgDelegateSummary>(
            r#"SELECT delegate_ref, agent_object_id, mydata_key_id, delegate_class,
                      allowed_action_ids, created_at
               FROM automation_delegate_keys WHERE account_id = $1 AND delegate_ref = $2"#,
        )
        .bind(account_id)
        .bind(delegate_ref)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| StoreError::Message(e.to_string()))?;
        Ok(row.map(|r| DelegateSummary {
            delegate_ref: r.delegate_ref,
            agent_object_id: r.agent_object_id,
            mydata_key_id: r.mydata_key_id,
            delegate_class: r.delegate_class,
            allowed_action_ids: r.allowed_action_ids.0,
            created_at: r.created_at,
        }))
    }

    async fn get_delegate(
        &self,
        account_id: &str,
        delegate_ref: &str,
    ) -> Result<Option<DelegateRecord>, StoreError> {
        let row = sqlx::query_as::<_, PgDelegateRecord>(
            r#"SELECT account_id, delegate_ref, agent_object_id, mydata_key_id, encrypted_key,
                      delegate_class, allowed_action_ids, created_at
               FROM automation_delegate_keys WHERE account_id = $1 AND delegate_ref = $2"#,
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
            mydata_key_id: r.mydata_key_id,
            encrypted_key: r.encrypted_key,
            delegate_class: r.delegate_class,
            allowed_action_ids: r.allowed_action_ids.0,
            created_at: r.created_at,
        }))
    }

    async fn delete_delegate(
        &self,
        account_id: &str,
        delegate_ref: &str,
    ) -> Result<bool, StoreError> {
        self.delete_delegate_if_agent(account_id, delegate_ref, None)
            .await
    }
    async fn delete_delegate_if_agent(
        &self,
        account_id: &str,
        delegate_ref: &str,
        expected_agent: Option<&str>,
    ) -> Result<bool, StoreError> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        let row=sqlx::query_as::<_,PgDelegateKeyEventContext>("DELETE FROM automation_delegate_keys WHERE account_id=$1 AND delegate_ref=$2 AND ($3::text IS NULL OR lpad(lower(regexp_replace(btrim(agent_object_id),'^0[xX]','','g')),64,'0')=lpad(lower(regexp_replace(btrim($3),'^0[xX]','','g')),64,'0')) RETURNING agent_object_id,mydata_key_id")
            .bind(account_id).bind(delegate_ref).bind(expected_agent).fetch_optional(&mut *tx).await.map_err(|e|StoreError::Message(e.to_string()))?;
        let Some(row) = row else {
            tx.rollback()
                .await
                .map_err(|e| StoreError::Message(e.to_string()))?;
            return Ok(false);
        };
        sqlx::query("INSERT INTO automation_delegate_key_events (account_id,delegate_ref,agent_object_id,mydata_key_id,event_type) VALUES ($1,$2,$3,$4,'deleted')")
            .bind(account_id).bind(delegate_ref).bind(row.agent_object_id).bind(row.mydata_key_id).execute(&mut *tx).await.map_err(|e|StoreError::Message(e.to_string()))?;
        tx.commit()
            .await
            .map_err(|e| StoreError::Message(e.to_string()))?;
        Ok(true)
    }
}

#[derive(sqlx::FromRow)]
struct PgDelegateSummary {
    delegate_ref: String,
    agent_object_id: String,
    mydata_key_id: String,
    delegate_class: String,
    allowed_action_ids: sqlx::types::Json<Vec<String>>,
    created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(sqlx::FromRow)]
struct PgDelegateKeyEvent {
    id: i64,
    delegate_ref: String,
    agent_object_id: String,
    mydata_key_id: String,
    event_type: String,
    recorded_at: chrono::DateTime<chrono::Utc>,
}
impl From<PgDelegateKeyEvent> for DelegateKeyEvent {
    fn from(r: PgDelegateKeyEvent) -> Self {
        Self {
            id: r.id.to_string(),
            delegate_ref: r.delegate_ref,
            agent_object_id: r.agent_object_id,
            mydata_key_id: r.mydata_key_id,
            event_type: r.event_type,
            recorded_at: r.recorded_at,
        }
    }
}
#[derive(sqlx::FromRow)]
struct PgDelegateKeyEventContext {
    agent_object_id: String,
    mydata_key_id: String,
}

#[derive(sqlx::FromRow)]
struct PgDelegateRecord {
    account_id: String,
    delegate_ref: String,
    agent_object_id: String,
    mydata_key_id: String,
    encrypted_key: String,
    delegate_class: String,
    allowed_action_ids: sqlx::types::Json<Vec<String>>,
    created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(sqlx::FromRow)]
struct JobRow {
    id: Uuid,
    version: i64,
    organization_id: String,
    account_id: String,
    owner_address: String,
    name: String,
    enabled: bool,
    archived: bool,
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
            version: row.version.max(1) as u64,
            organization_id: row.organization_id,
            account_id: row.account_id,
            owner_address: row.owner_address,
            name: row.name,
            enabled: row.enabled,
            archived: row.archived,
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
        JobAction, JobActionKind, MatchMode, PlatformEvent, RetryPolicy, TriggerSet,
        RUN_STATUS_SKIPPED, RUN_STATUS_SUCCEEDED,
    };

    fn job(org: &str, account: &str) -> AutomationJob {
        AutomationJob {
            id: Uuid::new_v4(),
            version: 1,
            organization_id: org.into(),
            account_id: account.into(),
            owner_address: "0xowner".into(),
            name: "test job".into(),
            enabled: true,
            archived: false,
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
        assert!(JobFilter::new(Some("  ".into()), None, None)
            .validate()
            .is_err());
        assert!(JobFilter::new(None, Some("".into()), None)
            .validate()
            .is_err());
        assert!(JobFilter::new(Some("0xorg".into()), None, None)
            .validate()
            .is_ok());
    }

    #[test]
    fn filter_clamps_the_limit() {
        assert_eq!(
            JobFilter::new(Some("o".into()), None, None).limit,
            DEFAULT_LIST_LIMIT
        );
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
    async fn paused_job_keeps_event_delivery_pending_until_resumed() {
        let store = memory_store();
        let saved = store.create_job(job("0xorg-a", "0xacct-a")).await.unwrap();
        let event = PlatformEvent {
            event_version: 1,
            event_family: "social".into(),
            event_type: "social.post_created".into(),
            organization_id: Some("0xorg-a".into()),
            account_id: Some("0xacct-a".into()),
            agent_object_id: Some("0xagent".into()),
            payload: serde_json::json!({}),
            occurred_at_ms: 1,
            source_event_id: "event-1".into(),
            deduplication_key: "dedup-1".into(),
            source_service: "test".into(),
            target_job_id: None,
        };
        assert!(store.ingest_event_dedup(&event).await.unwrap());
        let in_flight = store.claim_event_delivery().await.unwrap().unwrap();
        let paused = store
            .set_job_enabled(saved.id, saved.version, false)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(paused.version, saved.version + 1);
        assert!(store
            .defer_event_delivery(in_flight.id, in_flight.token)
            .await
            .unwrap());
        assert!(store.claim_event_delivery().await.unwrap().is_none());
        let pending = store.list_event_deliveries(saved.id, 10).await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].status, "pending");
        assert!(matches!(
            store.set_job_enabled(saved.id, saved.version, true).await,
            Err(StoreError::Conflict)
        ));
        assert!(store
            .set_job_enabled(saved.id, paused.version, true)
            .await
            .unwrap()
            .is_some());
        let claim = store.claim_event_delivery().await.unwrap().unwrap();
        assert_eq!(claim.job_id, saved.id);
    }

    #[tokio::test]
    async fn a_job_has_one_active_delivery_and_uncertain_work_blocks_its_backlog() {
        let store = memory_store();
        let saved = store
            .create_job(job("0xorg-serial", "0xacct-serial"))
            .await
            .unwrap();
        for key in ["serial-one", "serial-two"] {
            let event = PlatformEvent {
                event_version: 1,
                event_family: "social".into(),
                event_type: "social.post_created".into(),
                organization_id: Some("0xorg-serial".into()),
                account_id: Some("0xacct-serial".into()),
                agent_object_id: Some("0xagent".into()),
                payload: serde_json::json!({}),
                occurred_at_ms: 1,
                source_event_id: key.into(),
                deduplication_key: key.into(),
                source_service: "test".into(),
                target_job_id: None,
            };
            assert!(store.ingest_event_dedup(&event).await.unwrap());
        }

        let active = store.claim_event_delivery().await.unwrap().unwrap();
        assert_eq!(active.job_id, saved.id);
        assert!(store.claim_event_delivery().await.unwrap().is_none());

        assert!(store
            .finish_event_delivery(active.id, active.token, Some("unknown outcome".into()))
            .await
            .unwrap());
        assert!(store.claim_event_delivery().await.unwrap().is_none());
        assert!(store
            .resolve_event_delivery(
                active.id,
                saved.id,
                "confirmed_succeeded",
                "owner",
                "receipt checked"
            )
            .await
            .unwrap()
            .is_some());

        let next = store.claim_event_delivery().await.unwrap().unwrap();
        assert_eq!(next.job_id, saved.id);
        assert_ne!(next.id, active.id);
    }

    #[tokio::test]
    async fn stale_job_mutations_are_rejected_by_revision() {
        let store = memory_store();
        let created = store
            .create_job(job("0xorg-version", "0xacct-version"))
            .await
            .unwrap();
        let renamed = store
            .rename_job(created.id, created.version, "renamed")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(renamed.version, created.version + 1);
        assert!(matches!(
            store
                .rename_job(created.id, created.version, "stale overwrite")
                .await,
            Err(StoreError::Conflict)
        ));
        let paused = store
            .set_job_enabled(created.id, renamed.version, false)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(paused.version, renamed.version + 1);
        assert!(matches!(
            store
                .set_job_archived(created.id, renamed.version, true)
                .await,
            Err(StoreError::Conflict)
        ));
        assert!(
            store
                .set_job_archived(created.id, paused.version, true)
                .await
                .unwrap()
                .unwrap()
                .archived
        );
    }

    #[tokio::test]
    async fn job_cancellation_clears_pending_and_fences_claimed_pre_dispatch_work() {
        let store = memory_store();
        let created = store
            .create_job(job("0xorg-cancel", "0xacct-cancel"))
            .await
            .unwrap();
        for key in ["cancel-one", "cancel-two"] {
            let event = PlatformEvent {
                event_version: 1,
                event_family: "social".into(),
                event_type: "social.post_created".into(),
                organization_id: Some("0xorg-cancel".into()),
                account_id: Some("0xacct-cancel".into()),
                agent_object_id: Some("0xagent".into()),
                payload: serde_json::json!({}),
                occurred_at_ms: 1,
                source_event_id: key.into(),
                deduplication_key: key.into(),
                source_service: "test".into(),
                target_job_id: None,
            };
            assert!(store.ingest_event_dedup(&event).await.unwrap());
        }
        let claimed = store.claim_event_delivery().await.unwrap().unwrap();
        let result = store
            .cancel_job_queued_deliveries(
                created.id,
                created.version,
                "0xacct-cancel",
                "owner stopped queued work",
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.cancelled_pending, 1);
        assert_eq!(result.in_flight, 1);
        assert!(!result.enabled);
        assert!(!store
            .begin_event_delivery_dispatch(claimed.id, claimed.token)
            .await
            .unwrap());
        assert!(store
            .defer_event_delivery(claimed.id, claimed.token)
            .await
            .unwrap());
        let deliveries = store.list_event_deliveries(created.id, 10).await.unwrap();
        assert_eq!(deliveries.len(), 2);
        assert!(deliveries
            .iter()
            .all(|delivery| delivery.status == "cancelled"));
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
        let first = store
            .create_job(job("0xorg-a", "0xacct-a"))
            .await
            .unwrap()
            .id;
        let second = store
            .create_job(job("0xorg-a", "0xacct-a"))
            .await
            .unwrap()
            .id;

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
    async fn a_skipped_run_records_its_authorization_reason() {
        let store = memory_store();
        let job_id = store
            .create_job(job("0xorg-a", "0xacct-a"))
            .await
            .unwrap()
            .id;
        let run_id = store
            .record_run_start(job_id, serde_json::json!({}), serde_json::json!([]), None)
            .await
            .unwrap();

        store
            .record_run_finish(
                run_id,
                RUN_STATUS_SKIPPED,
                Some(100),
                Some("live AI-credit authorization preflight denied the action".into()),
                1,
            )
            .await
            .unwrap();

        let runs = store.list_runs(job_id, 10).await.unwrap();
        assert_eq!(runs[0].status, RUN_STATUS_SKIPPED);
        assert!(runs[0]
            .error
            .as_deref()
            .unwrap()
            .contains("authorization preflight"));
    }

    #[tokio::test]
    async fn a_skipped_run_counts_as_an_attempt_but_not_a_success() {
        // The scheduler measures "due" from the last attempt. Measuring from the
        // last success made a skipped or failing job due on every tick.
        let store = memory_store();
        let job_id = store
            .create_job(job("0xorg-a", "0xacct-a"))
            .await
            .unwrap()
            .id;
        assert!(store.latest_run_started_at(job_id).await.unwrap().is_none());

        let run_id = store
            .record_run_start(job_id, serde_json::json!({}), serde_json::json!([]), None)
            .await
            .unwrap();
        store
            .record_run_finish(
                run_id,
                RUN_STATUS_SKIPPED,
                None,
                Some("no credit".into()),
                1,
            )
            .await
            .unwrap();

        assert!(store.latest_success_at(job_id).await.unwrap().is_none());
        assert!(store.latest_run_started_at(job_id).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn latest_run_started_at_is_scoped_to_one_job() {
        let store = memory_store();
        let first = store
            .create_job(job("0xorg-a", "0xacct-a"))
            .await
            .unwrap()
            .id;
        let second = store
            .create_job(job("0xorg-a", "0xacct-a"))
            .await
            .unwrap()
            .id;
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
            mydata_key_id: "k1".into(),
            encrypted_key: "ciphertext".into(),
            delegate_class: "memory".into(),
            allowed_action_ids: Vec::new(),
            created_at: chrono::Utc::now(),
        }
    }

    #[tokio::test]
    async fn a_delegates_class_and_action_allowlist_round_trip() {
        let store = memory_store();
        let mut worker = delegate("0xacct-a", "worker");
        worker.delegate_class = "task_worker".into();
        worker.allowed_action_ids = vec!["task.accept.v1".into(), "task.deliver.v1".into()];
        store.put_delegate(worker).await.unwrap();

        let got = store
            .get_delegate("0xacct-a", "worker")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(got.delegate_class, "task_worker");
        assert_eq!(
            got.allowed_action_ids,
            ["task.accept.v1", "task.deliver.v1"]
        );
        let listed = store
            .list_delegates("0xacct-a", None, None, 50)
            .await
            .unwrap();
        assert_eq!(listed.data[0].delegate_class, "task_worker");
        assert_eq!(listed.data[0].allowed_action_ids.len(), 2);
    }

    #[tokio::test]
    async fn delegates_are_scoped_to_their_account() {
        let store = memory_store();
        store
            .put_delegate(delegate("0xacct-a", "mine"))
            .await
            .unwrap();
        store
            .put_delegate(delegate("0xacct-b", "theirs"))
            .await
            .unwrap();

        let a = store
            .list_delegates("0xacct-a", None, None, 50)
            .await
            .unwrap();
        assert_eq!(a.data.len(), 1);
        assert_eq!(a.data[0].delegate_ref, "mine");

        // Another account cannot read, or guess its way to, this encrypted key.
        assert!(store
            .get_delegate("0xacct-b", "mine")
            .await
            .unwrap()
            .is_none());
        assert!(store
            .get_delegate("0xacct-a", "mine")
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn the_delegate_listing_never_carries_the_encrypted_key() {
        let store = memory_store();
        store
            .put_delegate(delegate("0xacct-a", "mine"))
            .await
            .unwrap();
        let listing = store
            .list_delegates("0xacct-a", None, None, 50)
            .await
            .unwrap();
        let json = serde_json::to_string(&listing).unwrap();
        assert!(!json.contains("ciphertext"), "{json}");
        assert!(!json.contains("encrypted_key"), "{json}");
    }

    #[tokio::test]
    async fn delegate_pages_are_stable_bounded_and_agent_scoped() {
        let store = memory_store();
        for (name, agent) in [("alpha", "0x1"), ("bravo", "0x2"), ("charlie", "0x1")] {
            let mut record = delegate("0xacct-a", name);
            record.agent_object_id = agent.into();
            store.put_delegate(record).await.unwrap();
        }

        let first = store
            .list_delegates("0xacct-a", None, None, 2)
            .await
            .unwrap();
        assert_eq!(
            first
                .data
                .iter()
                .map(|row| row.delegate_ref.as_str())
                .collect::<Vec<_>>(),
            ["alpha", "bravo"]
        );
        assert!(first.has_next_page);
        assert_eq!(first.next_cursor.as_deref(), Some("bravo"));

        let second = store
            .list_delegates("0xacct-a", None, first.next_cursor.as_deref(), 2)
            .await
            .unwrap();
        assert_eq!(
            second
                .data
                .iter()
                .map(|row| row.delegate_ref.as_str())
                .collect::<Vec<_>>(),
            ["charlie"]
        );
        assert!(!second.has_next_page);
        assert_eq!(second.next_cursor, None);

        let scoped = store
            .list_delegates("0xacct-a", Some("0x01"), None, 10)
            .await
            .unwrap();
        assert_eq!(
            scoped
                .data
                .iter()
                .map(|row| row.delegate_ref.as_str())
                .collect::<Vec<_>>(),
            ["alpha", "charlie"]
        );
    }

    #[tokio::test]
    async fn putting_a_delegate_again_replaces_it() {
        let store = memory_store();
        store
            .put_delegate(delegate("0xacct-a", "mine"))
            .await
            .unwrap();
        let mut rotated = delegate("0xacct-a", "mine");
        rotated.encrypted_key = "rotated".into();
        store.put_delegate(rotated).await.unwrap();
        let got = store
            .get_delegate("0xacct-a", "mine")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(got.encrypted_key, "rotated");
        assert_eq!(
            store
                .list_delegates("0xacct-a", None, None, 50)
                .await
                .unwrap()
                .data
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn deleting_a_delegate_reports_whether_it_existed() {
        let store = memory_store();
        store
            .put_delegate(delegate("0xacct-a", "mine"))
            .await
            .unwrap();
        assert!(store.delete_delegate("0xacct-a", "mine").await.unwrap());
        assert!(!store.delete_delegate("0xacct-a", "mine").await.unwrap());
        assert!(!store.delete_delegate("0xacct-b", "mine").await.unwrap());
    }

    #[tokio::test]
    async fn delegate_key_history_is_scoped_append_only_metadata() {
        let store = memory_store();
        store
            .put_delegate(delegate("0xacct-a", "mine"))
            .await
            .unwrap();
        let mut replacement = delegate("0xacct-a", "mine");
        replacement.mydata_key_id = "k2".into();
        store.put_delegate(replacement).await.unwrap();
        assert!(store.delete_delegate("0xacct-a", "mine").await.unwrap());
        store
            .put_delegate(delegate("0xacct-b", "other"))
            .await
            .unwrap();

        let page = store
            .list_delegate_key_events("0xacct-a", None, None, 2)
            .await
            .unwrap();
        assert_eq!(
            page.data
                .iter()
                .map(|row| row.event_type.as_str())
                .collect::<Vec<_>>(),
            ["created", "replaced"]
        );
        assert!(page.has_next_page);
        assert_eq!(page.data[1].mydata_key_id, "k2");
        let next = store
            .list_delegate_key_events(
                "0xacct-a",
                None,
                Some(page.next_cursor.unwrap().parse().unwrap()),
                2,
            )
            .await
            .unwrap();
        assert_eq!(
            next.data
                .iter()
                .map(|row| row.event_type.as_str())
                .collect::<Vec<_>>(),
            ["deleted"]
        );
        assert!(!next.has_next_page);
        assert!(store
            .list_delegate_key_events("0xacct-c", None, None, 10)
            .await
            .unwrap()
            .data
            .is_empty());
        let json = serde_json::to_string(&next).unwrap();
        assert!(!json.contains("ciphertext"));
        assert!(!json.contains("encrypted_key"));
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
