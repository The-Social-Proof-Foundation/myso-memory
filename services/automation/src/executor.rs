//! Per-run lifecycle: evaluate TriggerSet → oracle preflight → execute or skip → audit/history.

use std::sync::Arc;

use crate::clients::{AuditClient, OracleClient, WorkflowClient};
use crate::store::AutomationStore;
use crate::trigger_eval::{event_matches_trigger, trigger_set_should_fire};
use crate::{
    AutomationJob, PlatformEvent, AUDIT_ACTION_JOB_RUN, AUDIT_ACTION_JOB_SKIP,
    AUDIT_ACTION_TRIGGER_FIRED, RUN_STATUS_FAILED, RUN_STATUS_SKIPPED, RUN_STATUS_SUCCEEDED,
};

pub struct RunContext {
    pub store: Arc<dyn AutomationStore>,
    pub oracle: OracleClient,
    pub workflow: Option<WorkflowClient>,
    pub audit: Option<AuditClient>,
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
            if let Some(ref org) = event.organization_id {
                if org != &job.organization_id {
                    continue;
                }
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
            self.run_job(job, Some(event)).await?;
        }
        Ok(())
    }

    pub async fn run_job(
        &self,
        job: &AutomationJob,
        event: Option<&PlatformEvent>,
    ) -> Result<(), String> {
        let matched: Vec<usize> = job
            .trigger_set
            .triggers
            .iter()
            .enumerate()
            .filter_map(|(i, t)| {
                event
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

        let preflight = self
            .oracle
            .preflight(
                &job.account_id,
                &job.target_agent_object_id,
                1000,
                500,
            )
            .await?;

        if preflight.approval_required || !preflight.allowed {
            self.store
                .record_run_finish(
                    run_id,
                    RUN_STATUS_SKIPPED,
                    preflight.estimated_mist,
                    preflight.reason.clone(),
                )
                .await
                .map_err(|e| e.to_string())?;
            if let Some(wf) = &self.workflow {
                let key = format!("automation:skip:{}:{}", job.id, run_id);
                let _ = wf
                    .ingest_alert(
                        &job.account_id,
                        &key,
                        "Automation run skipped",
                        preflight
                            .reason
                            .as_deref()
                            .unwrap_or("approval_required or insufficient credits"),
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
                        serde_json::json!({ "run_id": run_id, "reason": preflight.reason }),
                    )
                    .await;
            }
            return Ok(());
        }

        let exec_result = execute_action(job).await;
        match exec_result {
            Ok(cost) => {
                self.store
                    .record_run_finish(run_id, RUN_STATUS_SUCCEEDED, Some(cost), None)
                    .await
                    .map_err(|e| e.to_string())?;
                if let Some(audit) = &self.audit {
                    let _ = audit
                        .push_entry(
                            AUDIT_ACTION_JOB_RUN,
                            &job.target_agent_object_id,
                            Some(&job.organization_id),
                            &job.id.to_string(),
                            serde_json::json!({ "run_id": run_id, "cost_mist": cost }),
                        )
                        .await;
                }
            }
            Err(err) => {
                self.store
                    .record_run_finish(run_id, RUN_STATUS_FAILED, None, Some(err.clone()))
                    .await
                    .map_err(|e| e.to_string())?;
                if let Some(wf) = &self.workflow {
                    let key = format!("automation:fail:{}:{}", job.id, run_id);
                    let _ = wf
                        .ingest_scheduled_job_failure(
                            &job.account_id,
                            &key,
                            serde_json::json!({
                                "job_id": job.id,
                                "run_id": run_id,
                                "error": err,
                            }),
                            Some(&job.organization_id),
                        )
                        .await;
                }
            }
        }
        Ok(())
    }
}

async fn execute_action(job: &AutomationJob) -> Result<u64, String> {
    match job.action.kind {
        crate::JobActionKind::MemoryRelayerCall => {
            tracing::info!(
                job_id = %job.id,
                agent = %job.target_agent_object_id,
                "delegating memory relayer action (auth enforced by relayer)"
            );
            Ok(job.max_mist_per_run.min(1))
        }
        crate::JobActionKind::SocialAction | crate::JobActionKind::Webhook => {
            tracing::info!(job_id = %job.id, "action stub — wire signed client in deployment");
            Ok(0)
        }
    }
}
