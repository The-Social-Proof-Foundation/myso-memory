//! Enterprise automation engine core types.

pub mod clients;
pub mod config;
pub mod event_bus;
pub mod executor;
pub mod handlers;
pub mod store;
pub mod trigger_eval;

pub use config::Config;
pub use event_bus::EventBus;
pub use store::AutomationStore;

/// Normalized platform event envelope (transport-agnostic).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct PlatformEvent {
    pub event_version: u32,
    pub event_family: String,
    pub event_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_object_id: Option<String>,
    #[serde(default)]
    pub payload: serde_json::Value,
    pub occurred_at_ms: i64,
    pub source_event_id: String,
    pub deduplication_key: String,
    pub source_service: String,
}

/// Single trigger within a TriggerSet.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct EventTrigger {
    pub kind: TriggerKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cron_expr: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub condition: Option<serde_json::Value>,
    pub event_family: String,
    pub event_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_object_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload_filter: Option<serde_json::Value>,
    #[serde(default)]
    pub debounce_window_ms: i64,
    #[serde(default)]
    pub cooldown_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_executions_per_window: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deduplication_key: Option<String>,
    #[serde(default)]
    pub replay_behavior: ReplayBehavior,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TriggerKind {
    Cron,
    Interval,
    Conditional,
    Event,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ReplayBehavior {
    #[default]
    Skip,
    AllowOnce,
    AllowAll,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MatchMode {
    Any,
    All,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct TriggerSet {
    pub match_mode: MatchMode,
    #[serde(default)]
    pub evaluation_window_ms: i64,
    pub triggers: Vec<EventTrigger>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum JobActionKind {
    MemoryRelayerCall,
    SocialAction,
    Webhook,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct JobAction {
    pub kind: JobActionKind,
    pub config: serde_json::Value,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AutomationJob {
    pub id: uuid::Uuid,
    pub organization_id: String,
    pub account_id: String,
    pub name: String,
    pub enabled: bool,
    pub trigger_set: TriggerSet,
    pub target_agent_object_id: String,
    pub target_agent_key_ref: String,
    pub action: JobAction,
    pub memory_scope: String,
    pub max_mist_per_run: u64,
    pub retry_policy: RetryPolicy,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub jitter_ms: u64,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            jitter_ms: 1000,
        }
    }
}

pub const RUN_STATUS_RUNNING: &str = "running";
pub const RUN_STATUS_SUCCEEDED: &str = "succeeded";
pub const RUN_STATUS_SKIPPED: &str = "skipped";
pub const RUN_STATUS_FAILED: &str = "failed";

pub const AUDIT_SOURCE_SCHEDULER: &str = "scheduler";
pub const AUDIT_ACTION_JOB_RUN: &str = "automation_job_run";
pub const AUDIT_ACTION_JOB_SKIP: &str = "automation_job_skip";
pub const AUDIT_ACTION_TRIGGER_FIRED: &str = "automation_trigger_fired";
