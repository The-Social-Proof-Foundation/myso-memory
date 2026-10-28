use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkRunActionConfig {
    pub run_id: Uuid,
    pub turn: WorkRunTurnConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkRunTurnConfig {
    pub model_id: String,
    pub max_model_turns: u32,
    pub max_output_tokens: u32,
    #[serde(default)]
    pub allow_room_history: bool,
    #[serde(default)]
    pub allow_private_graph: bool,
    #[serde(default)]
    pub allow_private_task_artifacts: bool,
    #[serde(default)]
    pub allow_private_content_sharing: bool,
}

pub fn parse_config(value: &serde_json::Value) -> Result<WorkRunActionConfig, String> {
    let config: WorkRunActionConfig = serde_json::from_value(value.clone())
        .map_err(|_| "work_run config must bind a run and bounded turn options".to_string())?;
    validate_config(&config)?;
    Ok(config)
}

pub fn validate_config(config: &WorkRunActionConfig) -> Result<(), String> {
    if config.turn.model_id.trim().is_empty() || config.turn.model_id.len() > 200 {
        return Err("work_run model_id must contain 1 to 200 characters".into());
    }
    if !(1..=100).contains(&config.turn.max_model_turns) {
        return Err("work_run max_model_turns must be between 1 and 100".into());
    }
    if !(1..=32768).contains(&config.turn.max_output_tokens) {
        return Err("work_run max_output_tokens must be between 1 and 32768".into());
    }
    if config.turn.allow_private_content_sharing
        && !config.turn.allow_room_history
        && !config.turn.allow_private_graph
        && !config.turn.allow_private_task_artifacts
    {
        return Err(
            "private-content sharing consent requires an approved private content source".into(),
        );
    }
    Ok(())
}
