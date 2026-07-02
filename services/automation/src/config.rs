use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub database_url: Option<String>,
    pub internal_sync_secret: String,
    pub oracle_url: String,
    pub workflow_relayer_url: Option<String>,
    pub workflow_sync_secret: Option<String>,
    pub social_server_url: String,
    pub audit_sync_secret: Option<String>,
    pub memory_relayer_url: String,
    pub tick_interval_secs: u64,
    pub enabled: bool,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            port: env::var("PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(8010),
            database_url: env::var("DATABASE_URL").ok(),
            internal_sync_secret: env::var("AUTOMATION_INTERNAL_SYNC_SECRET")
                .unwrap_or_else(|_| "dev-automation-secret".into()),
            oracle_url: env::var("AI_CREDIT_ORACLE_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:8095".into()),
            workflow_relayer_url: env::var("WORKFLOW_RELAYER_URL").ok(),
            workflow_sync_secret: env::var("WORKFLOW_SYNC_SECRET").ok(),
            social_server_url: env::var("SOCIAL_SERVER_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:9126".into()),
            audit_sync_secret: env::var("AUDIT_SYNC_SECRET").ok(),
            memory_relayer_url: env::var("MEMORY_SERVER_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:8000".into()),
            tick_interval_secs: env::var("AUTOMATION_TICK_INTERVAL_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(60),
            enabled: env::var("AUTOMATION_ENABLED")
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(true),
        }
    }
}
