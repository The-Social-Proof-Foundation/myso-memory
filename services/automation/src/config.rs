use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub database_url: Option<String>,
    pub internal_sync_secret: String,
    pub oracle_url: String,
    /// `AI_CREDIT_ORACLE_API_SECRET`, the same variable the memory relayer uses.
    pub oracle_api_secret: Option<String>,
    pub workflow_relayer_url: Option<String>,
    pub workflow_sync_secret: Option<String>,
    pub social_server_url: String,
    pub audit_sync_secret: Option<String>,
    /// Automation memory bridge origin.
    ///
    /// This engine deliberately holds no agent keys and cannot sign memory
    /// relayer requests, so every memory operation goes through the bridge
    /// (`services/automation-sidecar`), which resolves a key ref and signs with
    /// `@socialproof/memory`. Replaces the old `memory_relayer_url` field, which
    /// was parsed and then never read by any client.
    pub memory_bridge_url: String,
    /// Shared secret for the bridge. Defaults to [`Self::internal_sync_secret`]
    /// so one value covers the whole stack.
    pub memory_bridge_secret: String,
    pub tick_interval_secs: u64,
    pub enabled: bool,
    /// True when no secret was configured and the dev placeholder is in use.
    pub secret_is_placeholder: bool,
}

/// The value used when no shared secret is configured, and the value shipped in
/// `.env.example`. Public by construction, so never acceptable in a deployment.
pub const DEV_SECRET: &str = "dev-automation-secret";

/// Lookup used by [`Config::from_lookup`]. `None` means "unset"; a blank value
/// is treated as unset so an empty env var cannot silently disable auth.
type Lookup<'a> = &'a dyn Fn(&str) -> Option<String>;

fn non_blank(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.trim().is_empty())
}

/// Shared secret used on the `x-internal-sync-secret` header.
///
/// The stack historically used two names for this one value: the memory and
/// messaging relayers read `INTERNAL_SYNC_SECRET`, while this engine read
/// `AUTOMATION_INTERNAL_SYNC_SECRET`. Two names with two different defaults on
/// the same header is a guaranteed 401 in a real deployment, so
/// `INTERNAL_SYNC_SECRET` is preferred and the old name still works.
fn resolve_internal_sync_secret(lookup: Lookup<'_>) -> Option<String> {
    ["INTERNAL_SYNC_SECRET", "AUTOMATION_INTERNAL_SYNC_SECRET"]
        .iter()
        .find_map(|key| non_blank(lookup(key)))
}

fn parse_bool(value: Option<String>, default: bool) -> bool {
    match non_blank(value) {
        Some(v) => v == "1" || v.eq_ignore_ascii_case("true"),
        None => default,
    }
}

impl Config {
    pub fn from_env() -> Self {
        Self::from_lookup(&|key| env::var(key).ok())
    }

    /// Build a config from an arbitrary lookup.
    ///
    /// Kept separate from [`Self::from_env`] so the resolution rules are
    /// testable without mutating process-wide environment variables, which
    /// would race across `cargo test`'s parallel threads.
    pub fn from_lookup(lookup: Lookup<'_>) -> Self {
        let configured_secret = resolve_internal_sync_secret(lookup);
        let secret_is_placeholder = configured_secret
            .as_deref()
            .map_or(true, |s| s == DEV_SECRET);
        let internal_sync_secret = configured_secret.unwrap_or_else(|| DEV_SECRET.into());

        let memory_bridge_secret = non_blank(lookup("AUTOMATION_MEMORY_BRIDGE_SECRET"))
            .unwrap_or_else(|| internal_sync_secret.clone());

        Self {
            port: non_blank(lookup("PORT"))
                .and_then(|p| p.parse().ok())
                .unwrap_or(8010),
            database_url: non_blank(lookup("DATABASE_URL")),
            internal_sync_secret,
            oracle_url: non_blank(lookup("AI_CREDIT_ORACLE_URL"))
                .unwrap_or_else(|| "http://127.0.0.1:8095".into()),
            oracle_api_secret: non_blank(lookup("AI_CREDIT_ORACLE_API_SECRET")),
            workflow_relayer_url: non_blank(lookup("WORKFLOW_RELAYER_URL")),
            workflow_sync_secret: non_blank(lookup("WORKFLOW_SYNC_SECRET")),
            social_server_url: non_blank(lookup("SOCIAL_SERVER_URL"))
                .unwrap_or_else(|| "http://127.0.0.1:9126".into()),
            audit_sync_secret: non_blank(lookup("AUDIT_SYNC_SECRET")),
            memory_bridge_url: non_blank(lookup("AUTOMATION_MEMORY_BRIDGE_URL"))
                .unwrap_or_else(|| "http://127.0.0.1:8011".into()),
            memory_bridge_secret,
            tick_interval_secs: non_blank(lookup("AUTOMATION_TICK_INTERVAL_SECS"))
                .and_then(|v| v.parse().ok())
                .unwrap_or(60),
            enabled: parse_bool(lookup("AUTOMATION_ENABLED"), true),
            secret_is_placeholder,
        }
    }

    /// Why this configuration must not start, if it must not.
    ///
    /// The placeholder secret is fine for a laptop running the in-memory store.
    /// Once `DATABASE_URL` is set the engine is holding persistent tenant data,
    /// so a placeholder secret there is a deployment mistake rather than a dev
    /// convenience — and the sidecar already refuses to start without a secret.
    pub fn insecure_secret_problem(&self) -> Option<String> {
        if self.secret_is_placeholder && self.database_url.is_some() {
            Some(
                "DATABASE_URL is set but INTERNAL_SYNC_SECRET is missing or still the \
                 public placeholder. Set INTERNAL_SYNC_SECRET to a long random value shared \
                 with the memory bridge and the memory relayer."
                    .into(),
            )
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn lookup_from(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> + 'static {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        move |key: &str| map.get(key).cloned()
    }

    #[test]
    fn internal_sync_secret_prefers_the_shared_name() {
        let lookup = lookup_from(&[
            ("INTERNAL_SYNC_SECRET", "shared"),
            ("AUTOMATION_INTERNAL_SYNC_SECRET", "legacy"),
        ]);
        assert_eq!(
            resolve_internal_sync_secret(&lookup).as_deref(),
            Some("shared")
        );
    }

    #[test]
    fn internal_sync_secret_falls_back_to_the_legacy_name() {
        let lookup = lookup_from(&[("AUTOMATION_INTERNAL_SYNC_SECRET", "legacy")]);
        assert_eq!(
            resolve_internal_sync_secret(&lookup).as_deref(),
            Some("legacy")
        );
    }

    #[test]
    fn internal_sync_secret_ignores_blank_and_defaults_are_last_resort() {
        let lookup = lookup_from(&[
            ("INTERNAL_SYNC_SECRET", "   "),
            ("AUTOMATION_INTERNAL_SYNC_SECRET", "legacy"),
        ]);
        assert_eq!(
            resolve_internal_sync_secret(&lookup).as_deref(),
            Some("legacy")
        );

        let empty = lookup_from(&[]);
        assert_eq!(resolve_internal_sync_secret(&empty), None);
        assert_eq!(
            Config::from_lookup(&empty).internal_sync_secret,
            "dev-automation-secret"
        );
    }

    #[test]
    fn the_placeholder_secret_is_flagged_whether_unset_or_copied_from_the_example() {
        assert!(Config::from_lookup(&lookup_from(&[])).secret_is_placeholder);
        let copied = lookup_from(&[("INTERNAL_SYNC_SECRET", DEV_SECRET)]);
        assert!(Config::from_lookup(&copied).secret_is_placeholder);
        let real = lookup_from(&[("INTERNAL_SYNC_SECRET", "a-long-random-value")]);
        assert!(!Config::from_lookup(&real).secret_is_placeholder);
    }

    #[test]
    fn a_persistent_deployment_refuses_the_placeholder_secret() {
        let with_db = lookup_from(&[("DATABASE_URL", "postgresql://db/automation")]);
        assert!(Config::from_lookup(&with_db).insecure_secret_problem().is_some());

        let copied = lookup_from(&[
            ("DATABASE_URL", "postgresql://db/automation"),
            ("INTERNAL_SYNC_SECRET", DEV_SECRET),
        ]);
        assert!(Config::from_lookup(&copied).insecure_secret_problem().is_some());

        let real = lookup_from(&[
            ("DATABASE_URL", "postgresql://db/automation"),
            ("INTERNAL_SYNC_SECRET", "a-long-random-value"),
        ]);
        assert!(Config::from_lookup(&real).insecure_secret_problem().is_none());
    }

    #[test]
    fn the_placeholder_secret_is_allowed_for_the_in_memory_dev_store() {
        // No DATABASE_URL: a laptop run with nothing persistent to protect.
        assert!(Config::from_lookup(&lookup_from(&[]))
            .insecure_secret_problem()
            .is_none());
    }

    #[test]
    fn bridge_secret_defaults_to_the_internal_secret() {
        let lookup = lookup_from(&[("INTERNAL_SYNC_SECRET", "shared")]);
        let config = Config::from_lookup(&lookup);
        assert_eq!(config.memory_bridge_secret, "shared");
        assert_eq!(config.memory_bridge_url, "http://127.0.0.1:8011");
    }

    #[test]
    fn bridge_secret_and_url_can_be_overridden() {
        let lookup = lookup_from(&[
            ("INTERNAL_SYNC_SECRET", "shared"),
            ("AUTOMATION_MEMORY_BRIDGE_SECRET", "bridge-only"),
            ("AUTOMATION_MEMORY_BRIDGE_URL", "http://bridge.internal:9999"),
        ]);
        let config = Config::from_lookup(&lookup);
        assert_eq!(config.memory_bridge_secret, "bridge-only");
        assert_eq!(config.memory_bridge_url, "http://bridge.internal:9999");
    }

    #[test]
    fn blank_bridge_secret_falls_back_rather_than_disabling_auth() {
        let lookup = lookup_from(&[
            ("INTERNAL_SYNC_SECRET", "shared"),
            ("AUTOMATION_MEMORY_BRIDGE_SECRET", ""),
        ]);
        assert_eq!(Config::from_lookup(&lookup).memory_bridge_secret, "shared");
    }

    #[test]
    fn datastore_is_required_to_leave_in_memory_mode() {
        assert!(Config::from_lookup(&lookup_from(&[])).database_url.is_none());
        let lookup = lookup_from(&[("DATABASE_URL", "postgresql://localhost/automation")]);
        assert_eq!(
            Config::from_lookup(&lookup).database_url.as_deref(),
            Some("postgresql://localhost/automation")
        );
    }

    #[test]
    fn enabled_defaults_true_and_parses_common_forms() {
        assert!(Config::from_lookup(&lookup_from(&[])).enabled);
        for value in ["true", "TRUE", "1"] {
            let lookup = lookup_from(&[("AUTOMATION_ENABLED", value)]);
            assert!(Config::from_lookup(&lookup).enabled, "{value} should enable");
        }
        for value in ["false", "FALSE", "0", "no"] {
            let lookup = lookup_from(&[("AUTOMATION_ENABLED", value)]);
            assert!(!Config::from_lookup(&lookup).enabled, "{value} should disable");
        }
    }

    #[test]
    fn ports_and_intervals_fall_back_on_garbage() {
        let bad = lookup_from(&[
            ("PORT", "not-a-port"),
            ("AUTOMATION_TICK_INTERVAL_SECS", "nope"),
        ]);
        let config = Config::from_lookup(&bad);
        assert_eq!(config.port, 8010);
        assert_eq!(config.tick_interval_secs, 60);
    }

    #[test]
    fn oracle_api_secret_is_optional_and_blank_is_unset() {
        let empty = |_: &str| None;
        assert_eq!(Config::from_lookup(&empty).oracle_api_secret, None);
        let blank = |k: &str| (k == "AI_CREDIT_ORACLE_API_SECRET").then(|| "  ".to_string());
        assert_eq!(Config::from_lookup(&blank).oracle_api_secret, None);
        let set = |k: &str| (k == "AI_CREDIT_ORACLE_API_SECRET").then(|| "s3".to_string());
        assert_eq!(Config::from_lookup(&set).oracle_api_secret.as_deref(), Some("s3"));
    }
}
