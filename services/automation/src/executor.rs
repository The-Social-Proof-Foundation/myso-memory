//! Per-run lifecycle: evaluate TriggerSet → oracle preflight → budget cap →
//! execute (with retry) → audit/history.
//!
//! A run is recorded in `automation_runs` before any work happens, so a job that
//! panics or is killed mid-flight still leaves a `running` row rather than no
//! trace at all.

use std::sync::Arc;
use std::time::Duration;

use crate::clients::{AuditClient, OracleClient, WorkflowClient};
use crate::memory_bridge::{execute_memory_action, BridgeError, MemoryBridgeClient};
use crate::registered_action::{self, ChainActionResult, PolicyVerdict};
use crate::store::AutomationStore;
use crate::trigger_eval::{due_window, event_matches_trigger, trigger_set_should_fire};
use crate::webhook::{self, Directive, WebhookClient};
use crate::{
    AutomationJob, PlatformEvent, AUDIT_ACTION_JOB_RUN, AUDIT_ACTION_JOB_SKIP,
    AUDIT_ACTION_TRIGGER_FIRED, RUN_STATUS_FAILED, RUN_STATUS_SKIPPED, RUN_STATUS_SUCCEEDED,
};

/// Retry backoff base. Attempt 1 waits ~100ms, attempt 2 ~200ms, and so on.
const BACKOFF_BASE_MS: u64 = 100;
/// Ceiling on a single backoff sleep, so a large `max_attempts` cannot stall a
/// tick loop for minutes.
const BACKOFF_CAP_MS: u64 = 30_000;

pub struct RunContext {
    pub store: Arc<dyn AutomationStore>,
    pub oracle: OracleClient,
    pub memory: MemoryBridgeClient,
    pub webhook: WebhookClient,
    pub workflow: Option<WorkflowClient>,
    pub audit: Option<AuditClient>,
}

/// What a completed action did, for the run row and the audit trail.
#[derive(Debug, Clone)]
struct ActionOutcome {
    /// Reserved spend, taken from the oracle preflight estimate.
    cost_mist: u64,
    summary: serde_json::Value,
    attempts: u32,
    /// Set when the action was deliberately not performed (policy, stale event, chain state moved
    /// on). Recorded as a skipped run rather than a success or a failure.
    skipped: Option<String>,
}

impl ActionOutcome {
    fn skipped(reason: String, attempts: u32) -> Self {
        Self {
            cost_mist: 0,
            summary: serde_json::json!({ "skipped": reason }),
            attempts,
            skipped: Some(reason),
        }
    }

    fn chain(result: ChainActionResult, attempts: u32, extra: serde_json::Value) -> Self {
        match result {
            ChainActionResult::Skipped(reason) => Self::skipped(reason, attempts),
            ChainActionResult::Executed(mut summary) => {
                if let (Some(target), Some(extra)) = (summary.as_object_mut(), extra.as_object()) {
                    target.extend(extra.clone());
                }
                Self {
                    cost_mist: 0,
                    summary,
                    attempts,
                    skipped: None,
                }
            }
        }
    }
}

/// Only memory work is priced by the AI-credit oracle. Chain actions are bounded on chain by the
/// delegate's spend cap, so they skip the preflight and the per-run credit budget.
fn consumes_ai_credit(job: &AutomationJob) -> bool {
    matches!(job.action.kind, crate::JobActionKind::MemoryRelayerCall)
}

impl RunContext {
    pub async fn evaluate_event_for_jobs(
        &self,
        event: &PlatformEvent,
        jobs: &[AutomationJob],
    ) -> Result<(), String> {
        for job in jobs {
            if !job.enabled {
                continue;
            }
            if !event_in_scope(event, job) {
                continue;
            }
            let mut newly_matched = Vec::new();
            for (idx, trigger) in job.trigger_set.triggers.iter().enumerate() {
                if event_matches_trigger(event, trigger) {
                    newly_matched.push(idx);
                }
            }
            if !trigger_set_should_fire(
                &job.trigger_set,
                &newly_matched,
                &[],
                event.occurred_at_ms,
                None,
            ) {
                continue;
            }
            // `cooldown_ms` was parsed and stored but never read. Without it, a
            // job triggered by `memory.created` that itself writes a memory
            // re-triggers itself on every run and spends credit in a loop.
            let cooldown_ms = cooldown_ms_for(job, &newly_matched);
            if cooldown_ms > 0 {
                if let Some(last) = self
                    .store
                    .latest_run_started_at(job.id)
                    .await
                    .map_err(|e| e.to_string())?
                {
                    let since_ms = (chrono::Utc::now() - last).num_milliseconds();
                    if since_ms < cooldown_ms {
                        tracing::info!(
                            job_id = %job.id,
                            cooldown_ms,
                            since_ms,
                            "event ignored: job is inside its cooldown"
                        );
                        continue;
                    }
                }
            }
            // One job's store failure must not starve the jobs after it.
            if let Err(e) = self.run_job(job, Some(event)).await {
                tracing::warn!(job_id = %job.id, "run failed to record: {e}");
            }
        }
        Ok(())
    }

    pub async fn run_job(
        &self,
        job: &AutomationJob,
        event: Option<&PlatformEvent>,
    ) -> Result<(), String> {
        // The tick loop passes its synthetic tick as `event`, but a tick never
        // matches an Event trigger, so treating it as a real event recorded every
        // scheduled run with an empty `matched_triggers`.
        let real_event = event.filter(|e| !is_tick(e));
        let matched: Vec<usize> = job
            .trigger_set
            .triggers
            .iter()
            .enumerate()
            .filter_map(|(i, t)| {
                real_event
                    .map(|e| event_matches_trigger(e, t))
                    .unwrap_or(
                        t.kind == crate::TriggerKind::Cron || t.kind == crate::TriggerKind::Interval,
                    )
                    .then_some(i)
            })
            .collect();

        let snapshot = serde_json::to_value(&job.trigger_set).map_err(|e| e.to_string())?;
        let matched_json = serde_json::to_value(&matched).map_err(|e| e.to_string())?;
        let run_id = self
            .store
            .record_run_start(
                job.id,
                snapshot,
                matched_json,
                event.map(|e| e.source_event_id.clone()),
            )
            .await
            .map_err(|e| e.to_string())?;

        if let Some(audit) = &self.audit {
            let _ = audit
                .push_entry(
                    AUDIT_ACTION_TRIGGER_FIRED,
                    &job.target_agent_object_id,
                    Some(&job.organization_id),
                    &job.id.to_string(),
                    serde_json::json!({ "run_id": run_id }),
                )
                .await;
        }

        let mut reserved_cost = 0;
        if consumes_ai_credit(job) {
            let preflight_result = if job.owner_address.trim().is_empty() {
                Err("job has no owner_address, so the AI credit oracle cannot resolve \
                     whose balance to charge; recreate the job"
                    .to_string())
            } else {
                self.oracle
                    .preflight(&job.owner_address, &job.target_agent_object_id, 1000, 0)
                    .await
            };
            let preflight = match preflight_result {
                Ok(preflight) => preflight,
                Err(err) => {
                    // An unreachable oracle used to return early via `?`, leaving the
                    // run row stuck in `running` forever with no explanation. Fail it
                    // explicitly instead: a stuck row is indistinguishable from a job
                    // that is still executing.
                    let message = format!("oracle preflight failed: {err}");
                    self.store
                        .record_run_finish(run_id, RUN_STATUS_FAILED, None, Some(message.clone()), 1)
                        .await
                        .map_err(|e| e.to_string())?;
                    if let Some(audit) = &self.audit {
                        let _ = audit
                            .push_entry(
                                AUDIT_ACTION_JOB_RUN,
                                &job.target_agent_object_id,
                                Some(&job.organization_id),
                                &job.id.to_string(),
                                serde_json::json!({ "run_id": run_id, "error": message }),
                            )
                            .await;
                    }
                    return Ok(());
                }
            };

            if preflight.approval_required || !preflight.allowed {
                return self
                    .skip_run(
                        job,
                        run_id,
                        preflight.estimated_mist,
                        preflight
                            .reason
                            .clone()
                            .unwrap_or_else(|| "approval_required or insufficient credits".into()),
                    )
                    .await;
            }

            // Per-run budget cap. `max_mist_per_run` was previously stored and never
            // read, which meant a job documented a spending limit it did not honour.
            if job.max_mist_per_run > 0 {
                if let Some(estimated) = preflight.estimated_mist {
                    if estimated > job.max_mist_per_run {
                        return self
                            .skip_run(
                                job,
                                run_id,
                                Some(estimated),
                                format!(
                                    "estimated {estimated} mist exceeds the job's max_mist_per_run of {}",
                                    job.max_mist_per_run
                                ),
                            )
                            .await;
                    }
                }
            }

            reserved_cost = preflight.estimated_mist.unwrap_or(0);
        }

        let now = chrono::Utc::now();
        let last_success = self
            .store
            .latest_success_at(job.id)
            .await
            .map_err(|e| e.to_string())?;
        let window = due_window(&job.trigger_set, last_success, now)
            .or_else(|| event.map(|item| format!("event:{}", item.source_event_id)));
        let max_attempts = job.retry_policy.max_attempts.max(1);
        let mut attempts: u32 = 0;
        let outcome = loop {
            attempts += 1;
            match self
                .execute_action(job, real_event, window.as_deref(), reserved_cost, attempts)
                .await
            {
                Ok(outcome) => break Ok(outcome),
                Err(err) if err.retryable() && attempts < max_attempts => {
                    let delay = backoff_delay(attempts, job.retry_policy.jitter_ms);
                    tracing::warn!(
                        job_id = %job.id,
                        run_id = %run_id,
                        attempt = attempts,
                        max_attempts,
                        delay_ms = delay.as_millis() as u64,
                        "action failed, retrying: {}",
                        err.message()
                    );
                    tokio::time::sleep(delay).await;
                }
                Err(err) => break Err(err),
            }
        };

        match outcome {
            Ok(outcome) if outcome.skipped.is_some() => {
                let reason = outcome.skipped.unwrap_or_default();
                // Policy and staleness skips are the job working as configured, so they are
                // recorded but not pushed to the owner's inbox: a busy auto-accept job would
                // otherwise alert on every offer it declined to take.
                return self.record_skip(job, run_id, None, reason, false).await;
            }
            Ok(outcome) => {
                self.store
                    .record_run_finish(
                        run_id,
                        RUN_STATUS_SUCCEEDED,
                        Some(outcome.cost_mist),
                        None,
                        outcome.attempts,
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                if let Some(audit) = &self.audit {
                    let _ = audit
                        .push_entry(
                            AUDIT_ACTION_JOB_RUN,
                            &job.target_agent_object_id,
                            Some(&job.organization_id),
                            &job.id.to_string(),
                            serde_json::json!({
                                "run_id": run_id,
                                "cost_mist": outcome.cost_mist,
                                "attempts": outcome.attempts,
                                "result": outcome.summary,
                            }),
                        )
                        .await;
                }
            }
            Err(err) => {
                let message = err.to_string();
                self.store
                    .record_run_finish(
                        run_id,
                        RUN_STATUS_FAILED,
                        None,
                        Some(message.clone()),
                        attempts,
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                if let Some(wf) = &self.workflow {
                    let key = format!("automation:fail:{}:{}", job.id, run_id);
                    let _ = wf
                        .ingest_scheduled_job_failure(
                            recipient_for(job),
                            &key,
                            serde_json::json!({
                                "job_id": job.id,
                                "run_id": run_id,
                                "attempts": attempts,
                                "error": message,
                            }),
                            Some(&job.organization_id),
                        )
                        .await;
                }
            }
        }
        Ok(())
    }

    /// Record a run that was deliberately not executed, and tell the operator.
    async fn skip_run(
        &self,
        job: &AutomationJob,
        run_id: uuid::Uuid,
        cost_mist: Option<u64>,
        reason: String,
    ) -> Result<(), String> {
        self.record_skip(job, run_id, cost_mist, reason, true).await
    }

    async fn record_skip(
        &self,
        job: &AutomationJob,
        run_id: uuid::Uuid,
        cost_mist: Option<u64>,
        reason: String,
        notify: bool,
    ) -> Result<(), String> {
        self.store
            .record_run_finish(run_id, RUN_STATUS_SKIPPED, cost_mist, Some(reason.clone()), 1)
            .await
            .map_err(|e| e.to_string())?;

        if let Some(wf) = self.workflow.as_ref().filter(|_| notify) {
            let key = format!("automation:skip:{}:{}", job.id, run_id);
            let _ = wf
                .ingest_alert(
                    recipient_for(job),
                    &key,
                    "Automation run skipped",
                    &reason,
                    Some(&job.organization_id),
                )
                .await;
        }
        if let Some(audit) = &self.audit {
            let _ = audit
                .push_entry(
                    AUDIT_ACTION_JOB_SKIP,
                    &job.target_agent_object_id,
                    Some(&job.organization_id),
                    &job.id.to_string(),
                    serde_json::json!({ "run_id": run_id, "reason": reason }),
                )
                .await;
        }
        Ok(())
    }

    /// Perform one attempt of the job's action.
    async fn execute_action(
        &self,
        job: &AutomationJob,
        event: Option<&PlatformEvent>,
        due_window: Option<&str>,
        reserved_cost: u64,
        attempts: u32,
    ) -> Result<ActionOutcome, BridgeError> {
        match job.action.kind {
            crate::JobActionKind::MemoryRelayerCall => {
                let outcome = execute_memory_action(
                    &self.memory,
                    &job.target_agent_key_ref,
                    &job.account_id,
                    Some(&job.memory_scope),
                    &job.action.config,
                )
                .await?;

                tracing::info!(
                    job_id = %job.id,
                    agent = %job.target_agent_object_id,
                    key_ref = %job.target_agent_key_ref,
                    recalled = outcome.recalled,
                    "memory action completed"
                );

                // Notify the workflow inbox that a scheduled job ran. This is a
                // notification, not the action: a failure here does not fail the
                // run, and unsetting WORKFLOW_RELAYER_URL disables it.
                if let (Some(workflow), Some(window)) = (self.workflow.as_ref(), due_window) {
                    if let Err(e) = workflow.ingest_due_task(job, window).await {
                        tracing::warn!(
                            job_id = %job.id,
                            "workflow notification failed (run still succeeded): {e}"
                        );
                    }
                }

                Ok(ActionOutcome {
                    cost_mist: reserved_cost,
                    summary: outcome.summary,
                    attempts,
                    skipped: None,
                })
            }
            crate::JobActionKind::RegisteredAction => {
                let result = registered_action::execute(
                    &self.memory,
                    job,
                    event,
                    due_window,
                    chrono::Utc::now().timestamp_millis(),
                )
                .await?;
                Ok(ActionOutcome::chain(result, attempts, serde_json::json!({})))
            }
            crate::JobActionKind::Webhook => self.execute_webhook(job, event, attempts).await,
        }
    }

    /// Ask the endpoint what to do about the event, then run its directive through the bridge.
    async fn execute_webhook(
        &self,
        job: &AutomationJob,
        event: Option<&PlatformEvent>,
        attempts: u32,
    ) -> Result<ActionOutcome, BridgeError> {
        let invalid = |message: String| BridgeError::Invalid { message };
        let config = webhook::parse_config(&job.action.config).map_err(invalid)?;
        webhook::validate_config(&config, self.webhook.allow_private()).map_err(invalid)?;
        let Some(event) = event else {
            return Err(invalid("a webhook job must be triggered by an event".into()));
        };

        let now_ms = chrono::Utc::now().timestamp_millis();
        if let Some(reason) = registered_action::stale_reason(&event.payload, now_ms) {
            return Ok(ActionOutcome::skipped(reason, attempts));
        }
        if let PolicyVerdict::Skip(reason) = registered_action::evaluate_policy(&config.policy, &event.payload) {
            return Ok(ActionOutcome::skipped(reason, attempts));
        }

        // One delivery id per (job, event): the endpoint can deduplicate on it, and it seeds the
        // action's idempotency key below.
        let delivery_id = registered_action::idempotency_key(job.id, Some(event), None, "webhook");
        match self.webhook.call(&config, job, event, &delivery_id).await? {
            Directive::Noop(reason) => Ok(ActionOutcome::skipped(
                reason.unwrap_or_else(|| "the webhook chose not to act".into()),
                attempts,
            )),
            Directive::Act { action_id, params } => {
                let key = registered_action::idempotency_key(job.id, Some(event), None, &action_id);
                let result = registered_action::submit(
                    &self.memory,
                    job,
                    config.key_ref.as_deref(),
                    &action_id,
                    &params,
                    &key,
                )
                .await?;
                Ok(ActionOutcome::chain(
                    result,
                    attempts,
                    serde_json::json!({ "webhook_action_id": action_id }),
                ))
            }
        }
    }
}

fn is_tick(event: &PlatformEvent) -> bool {
    event.event_family == "automation" && event.event_type == "tick"
}

/// Whether an event may trigger this job at all, before trigger matching.
///
/// An event carrying an organization is scoped by organization. One carrying
/// only an account (the memory bridge's `memory.created` has no organization) is
/// scoped by account, so a tenant's memory writes cannot fire another tenant's
/// jobs. Only a fully unscoped event is delivered to every job.
pub(crate) fn event_in_scope(event: &PlatformEvent, job: &AutomationJob) -> bool {
    match (&event.organization_id, &event.account_id) {
        (Some(org), _) => org == &job.organization_id,
        (None, Some(account)) => account.trim().eq_ignore_ascii_case(job.account_id.trim()),
        (None, None) => true,
    }
}

/// Longest `cooldown_ms` among the triggers that matched.
pub(crate) fn cooldown_ms_for(job: &AutomationJob, matched: &[usize]) -> i64 {
    matched
        .iter()
        .filter_map(|i| job.trigger_set.triggers.get(*i))
        .map(|t| t.cooldown_ms)
        .max()
        .unwrap_or(0)
}

/// Inbox recipient for run notifications: the owner's wallet address, which is
/// what the workflow inbox is keyed by. Falls back to the account id for legacy
/// rows that predate `owner_address`.
fn recipient_for(job: &AutomationJob) -> &str {
    if job.owner_address.trim().is_empty() {
        &job.account_id
    } else {
        &job.owner_address
    }
}

/// Exponential backoff with jitter, bounded by [`BACKOFF_CAP_MS`].
///
/// Jitter is derived from a UUID rather than a `rand` dependency, so the
/// jittered result is still unpredictable across processes without adding a
/// crate for one call site.
fn backoff_delay(attempt: u32, jitter_ms: u64) -> Duration {
    // Shift is bounded to 20 so the multiply cannot overflow before the cap.
    let shift = attempt.saturating_sub(1).min(20);
    let base = BACKOFF_BASE_MS
        .saturating_mul(1u64 << shift)
        .min(BACKOFF_CAP_MS);
    let jitter = if jitter_ms == 0 {
        0
    } else {
        let bytes = uuid::Uuid::new_v4().into_bytes();
        let mut le = [0u8; 8];
        le.copy_from_slice(&bytes[..8]);
        u64::from_le_bytes(le) % (jitter_ms + 1)
    };
    Duration::from_millis(base.saturating_add(jitter))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_grows_then_caps() {
        let first = backoff_delay(1, 0);
        assert_eq!(first, Duration::from_millis(BACKOFF_BASE_MS));
        assert_eq!(backoff_delay(2, 0), Duration::from_millis(BACKOFF_BASE_MS * 2));
        assert_eq!(backoff_delay(3, 0), Duration::from_millis(BACKOFF_BASE_MS * 4));
        // Large attempts saturate at the cap rather than overflowing.
        assert_eq!(backoff_delay(40, 0), Duration::from_millis(BACKOFF_CAP_MS));
    }

    #[test]
    fn backoff_never_exceeds_base_plus_jitter() {
        for attempt in 1..8 {
            let delay = backoff_delay(attempt, 250);
            let base = (BACKOFF_BASE_MS * 2u64.pow(attempt - 1)).min(BACKOFF_CAP_MS);
            assert!(
                delay.as_millis() as u64 <= base + 250,
                "attempt {attempt} produced {delay:?}"
            );
            assert!(delay.as_millis() as u64 >= base);
        }
    }

    fn job_with(account: &str, org: &str, cooldowns: &[i64]) -> AutomationJob {
        let mut trigger = crate::handlers::sample_event_trigger();
        let triggers = cooldowns
            .iter()
            .map(|c| {
                trigger.cooldown_ms = *c;
                trigger.clone()
            })
            .collect();
        AutomationJob {
            id: uuid::Uuid::new_v4(),
            organization_id: org.into(),
            account_id: account.into(),
            owner_address: "0xowner".into(),
            name: "j".into(),
            enabled: true,
            trigger_set: crate::TriggerSet {
                match_mode: crate::MatchMode::Any,
                evaluation_window_ms: 0,
                triggers,
            },
            target_agent_object_id: "0xagent".into(),
            target_agent_key_ref: "ref".into(),
            action: crate::JobAction {
                kind: crate::JobActionKind::MemoryRelayerCall,
                config: serde_json::json!({}),
            },
            memory_scope: "chat-app".into(),
            max_mist_per_run: 0,
            retry_policy: crate::RetryPolicy::default(),
        }
    }

    fn event_for(org: Option<&str>, account: Option<&str>) -> PlatformEvent {
        PlatformEvent {
            event_version: 1,
            event_family: "memory".into(),
            event_type: "created".into(),
            organization_id: org.map(str::to_string),
            account_id: account.map(str::to_string),
            agent_object_id: None,
            payload: serde_json::json!({}),
            occurred_at_ms: 1,
            source_event_id: "e".into(),
            deduplication_key: "d".into(),
            source_service: "test".into(),
        }
    }

    #[test]
    fn an_account_scoped_event_only_reaches_that_accounts_jobs() {
        let mine = job_with("0xAAA", "org-1", &[0]);
        let theirs = job_with("0xbbb", "org-1", &[0]);
        let event = event_for(None, Some("0xaaa"));
        assert!(event_in_scope(&event, &mine));
        // Same organization, different account: must not fire.
        assert!(!event_in_scope(&event, &theirs));
    }

    #[test]
    fn an_org_scoped_event_is_scoped_by_org() {
        let job = job_with("0xaaa", "org-1", &[0]);
        assert!(event_in_scope(&event_for(Some("org-1"), Some("0xzzz")), &job));
        assert!(!event_in_scope(&event_for(Some("org-2"), Some("0xaaa")), &job));
    }

    #[test]
    fn a_fully_unscoped_event_reaches_every_job() {
        let job = job_with("0xaaa", "org-1", &[0]);
        assert!(event_in_scope(&event_for(None, None), &job));
    }

    #[test]
    fn cooldown_is_the_longest_among_matched_triggers() {
        let job = job_with("0xaaa", "org-1", &[0, 5_000, 60_000]);
        assert_eq!(cooldown_ms_for(&job, &[0]), 0);
        assert_eq!(cooldown_ms_for(&job, &[0, 1]), 5_000);
        assert_eq!(cooldown_ms_for(&job, &[1, 2]), 60_000);
        assert_eq!(cooldown_ms_for(&job, &[]), 0);
        // An out-of-range index is ignored rather than panicking.
        assert_eq!(cooldown_ms_for(&job, &[9]), 0);
    }

    #[test]
    fn the_synthetic_tick_is_recognised() {
        let mut tick = event_for(None, None);
        tick.event_family = "automation".into();
        tick.event_type = "tick".into();
        assert!(is_tick(&tick));
        assert!(!is_tick(&event_for(None, None)));
    }

    #[test]
    fn only_memory_actions_are_priced_by_the_credit_oracle() {
        let mut job = job_with("0xaaa", "org-1", &[0]);
        assert!(consumes_ai_credit(&job));
        job.action.kind = crate::JobActionKind::RegisteredAction;
        assert!(!consumes_ai_credit(&job));
        job.action.kind = crate::JobActionKind::Webhook;
        assert!(!consumes_ai_credit(&job));
    }

    #[test]
    fn a_skipped_chain_result_becomes_a_skipped_outcome_not_a_success() {
        let skipped = ActionOutcome::chain(ChainActionResult::Skipped("already settled".into()), 2, serde_json::json!({}));
        assert_eq!(skipped.skipped.as_deref(), Some("already settled"));
        assert_eq!(skipped.attempts, 2);
        assert_eq!(skipped.cost_mist, 0);

        let done = ActionOutcome::chain(
            ChainActionResult::Executed(serde_json::json!({ "digest": "abc" })),
            1,
            serde_json::json!({ "webhook_action_id": "task.deliver.v1" }),
        );
        assert!(done.skipped.is_none());
        assert_eq!(done.summary["digest"], "abc");
        assert_eq!(done.summary["webhook_action_id"], "task.deliver.v1");
    }

    #[test]
    fn backoff_is_deterministic_without_jitter() {
        assert_eq!(backoff_delay(4, 0), backoff_delay(4, 0));
    }

    #[test]
    fn jitter_actually_varies() {
        let samples: std::collections::HashSet<u128> =
            (0..32).map(|_| backoff_delay(1, 1000).as_millis()).collect();
        // With 1000ms of jitter, 32 draws collapsing to one value is
        // astronomically unlikely unless the jitter is broken.
        assert!(samples.len() > 1, "jitter produced no variation: {samples:?}");
    }
}
