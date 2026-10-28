//! `registered_action` jobs: run one on-chain action from the relayer's registered-action
//! catalog (`task.accept.v1`, `task.settle.v1`, ...) when an event fires.
//!
//! The engine never builds or signs a transaction. It decides *whether* to act (staleness and
//! the job's policy, both evaluated against the triggering event's payload), fills the action's
//! params from that payload, and asks the bridge to prepare, sign and submit the action as the
//! job's delegate. The delegate's on-chain capability, spend cap and `allowed_action_ids` are the
//! hard limits; a policy here only decides when the job should bother.

use serde::{Deserialize, Deserializer};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::memory_bridge::{BridgeError, MemoryBridgeClient};
use crate::{AutomationJob, PlatformEvent};

/// Upper bound on the serialized params sent to the bridge, whether templated or returned by a
/// webhook.
pub const MAX_PARAMS_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisteredActionConfig {
    pub action_id: String,
    /// Object whose string values may contain `{{event.payload.field}}` templates.
    #[serde(default)]
    pub params: Value,
    #[serde(default)]
    pub policy: ActionPolicy,
    /// Overrides the job's `target_agent_key_ref` for this action.
    #[serde(default)]
    pub key_ref: Option<String>,
}

/// Conditions a triggering event must satisfy before the job acts. Every field is optional; a
/// field that is set but absent from the event payload fails closed. `max_amount_mist` is parsed
/// only for compatibility with saved legacy jobs and is deliberately ignored: MYSO spending
/// limits are enforced by live on-chain policy, never by an automation event predicate.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ActionPolicy {
    #[serde(default, deserialize_with = "opt_u128")]
    pub min_amount_mist: Option<u128>,
    #[serde(default, deserialize_with = "opt_u128")]
    #[deprecated(note = "MYSO spend ceilings are enforced by live on-chain policy")]
    pub max_amount_mist: Option<u128>,
    #[serde(default, deserialize_with = "opt_u128")]
    pub min_delivery_window_ms: Option<u128>,
    #[serde(default, deserialize_with = "opt_u128")]
    pub max_open_tasks: Option<u128>,
    #[serde(default, deserialize_with = "opt_u128")]
    pub min_buyer_score_milli: Option<u128>,
    #[serde(default, deserialize_with = "opt_u128")]
    pub min_buyer_credibility_bps: Option<u128>,
    #[serde(default, deserialize_with = "opt_u128")]
    pub min_seller_score_milli: Option<u128>,
    #[serde(default, deserialize_with = "opt_u128")]
    pub min_seller_credibility_bps: Option<u128>,
    #[serde(default)]
    pub allowed_buyer_principals: Option<Vec<String>>,
    #[serde(default)]
    pub scope_digest_allowlist: Option<Vec<String>>,
}

fn parse_u128(value: &Value) -> Option<u128> {
    match value {
        Value::Number(n) => n.as_u64().map(u128::from),
        Value::String(s) => {
            let s = s.trim();
            if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
                None
            } else {
                s.parse().ok()
            }
        }
        _ => None,
    }
}

fn opt_u128<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<u128>, D::Error> {
    match Option::<Value>::deserialize(deserializer)? {
        None | Some(Value::Null) => Ok(None),
        Some(value) => parse_u128(&value).map(Some).ok_or_else(|| {
            serde::de::Error::custom("expected an unsigned integer or a decimal string")
        }),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyVerdict {
    Proceed,
    Skip(String),
}

impl ActionPolicy {
    pub fn is_empty(&self) -> bool {
        self.min_amount_mist.is_none()
            && self.min_delivery_window_ms.is_none()
            && self.max_open_tasks.is_none()
            && self.min_buyer_score_milli.is_none()
            && self.min_buyer_credibility_bps.is_none()
            && self.min_seller_score_milli.is_none()
            && self.min_seller_credibility_bps.is_none()
            && self.allowed_buyer_principals.is_none()
            && self.scope_digest_allowlist.is_none()
    }

    /// Internal consistency, checked when a job is created.
    pub fn validate(&self) -> Result<(), String> {
        for (name, list) in [
            ("allowed_buyer_principals", &self.allowed_buyer_principals),
            ("scope_digest_allowlist", &self.scope_digest_allowlist),
        ] {
            if let Some(list) = list {
                if list.is_empty() {
                    return Err(format!("policy.{name} must not be empty when set"));
                }
                if list.len() > 256 {
                    return Err(format!("policy.{name} is limited to 256 entries"));
                }
            }
        }
        Ok(())
    }
}

fn normalize_hex(value: &str) -> String {
    value.trim().trim_start_matches("0x").to_ascii_lowercase()
}

/// Decide whether the event's payload satisfies the policy.
pub fn evaluate_policy(policy: &ActionPolicy, payload: &Value) -> PolicyVerdict {
    let number = |field: &str| payload.get(field).and_then(parse_u128);

    let lower_bounds: [(&str, Option<u128>); 6] = [
        ("amount_mist", policy.min_amount_mist),
        ("delivery_window_ms", policy.min_delivery_window_ms),
        ("buyer_score_milli", policy.min_buyer_score_milli),
        ("buyer_credibility_bps", policy.min_buyer_credibility_bps),
        ("seller_score_milli", policy.min_seller_score_milli),
        ("seller_credibility_bps", policy.min_seller_credibility_bps),
    ];
    for (field, bound) in lower_bounds {
        let Some(bound) = bound else { continue };
        match number(field) {
            None => return PolicyVerdict::Skip(format!("event payload has no `{field}`")),
            Some(actual) if actual < bound => {
                return PolicyVerdict::Skip(format!(
                    "{field} {actual} is below the minimum {bound}"
                ))
            }
            Some(_) => {}
        }
    }

    let upper_bounds: [(&str, &str, Option<u128>); 1] = [
        ("seller_open_tasks", "max_open_tasks", policy.max_open_tasks),
    ];
    for (field, name, bound) in upper_bounds {
        let Some(bound) = bound else { continue };
        match number(field) {
            None => return PolicyVerdict::Skip(format!("event payload has no `{field}`")),
            Some(actual) if actual > bound => {
                return PolicyVerdict::Skip(format!(
                    "{field} {actual} exceeds the {name} limit {bound}"
                ))
            }
            Some(_) => {}
        }
    }

    if let Some(allowed) = &policy.allowed_buyer_principals {
        match payload.get("buyer_principal").and_then(Value::as_str) {
            None => return PolicyVerdict::Skip("event payload has no `buyer_principal`".into()),
            Some(buyer) => {
                let buyer = normalize_hex(buyer);
                if !allowed.iter().any(|a| normalize_hex(a) == buyer) {
                    return PolicyVerdict::Skip(format!("buyer 0x{buyer} is not on the allowlist"));
                }
            }
        }
    }
    if let Some(allowed) = &policy.scope_digest_allowlist {
        match payload.get("scope_digest").and_then(Value::as_str) {
            None => return PolicyVerdict::Skip("event payload has no `scope_digest`".into()),
            Some(digest) => {
                let digest = normalize_hex(digest);
                if !allowed.iter().any(|a| normalize_hex(a) == digest) {
                    return PolicyVerdict::Skip("scope digest is not on the allowlist".into());
                }
            }
        }
    }
    PolicyVerdict::Proceed
}

/// Events name the deadline of the step they ask for in `expires_at_ms`. Acting after it can only
/// abort on chain, so the run is skipped instead.
pub fn stale_reason(payload: &Value, now_ms: i64) -> Option<String> {
    let expires = payload.get("expires_at_ms").and_then(parse_u128)?;
    (now_ms >= 0 && (now_ms as u128) > expires)
        .then(|| format!("event is stale: its deadline {expires} has passed"))
}

/// `[a-z_]+.[a-z_]+.v<digits>`, at most 64 bytes.
pub fn valid_action_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 64 {
        return false;
    }
    let parts: Vec<&str> = id.split('.').collect();
    let [namespace, name, version] = parts.as_slice() else {
        return false;
    };
    let word = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_lowercase() || b == b'_');
    word(namespace)
        && word(name)
        && version.len() > 1
        && version.starts_with('v')
        && version[1..].bytes().all(|b| b.is_ascii_digit())
}

fn lookup_path<'a>(root: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = root;
    for segment in path.split('.') {
        current = match current {
            Value::Object(map) => map.get(segment)?,
            Value::Array(items) => items.get(segment.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(current)
}

fn event_context(event: &PlatformEvent) -> Value {
    json!({
        "event": {
            "family": event.event_family,
            "type": event.event_type,
            "account_id": event.account_id,
            "organization_id": event.organization_id,
            "agent_object_id": event.agent_object_id,
            "occurred_at_ms": event.occurred_at_ms,
            "payload": event.payload,
        }
    })
}

fn render_string(template: &str, context: &Value) -> Result<Value, String> {
    let trimmed = template.trim();
    if let Some(path) = trimmed
        .strip_prefix("{{")
        .and_then(|rest| rest.strip_suffix("}}"))
        .filter(|path| !path.contains("{{"))
    {
        let path = path.trim();
        return lookup_path(context, path)
            .filter(|value| !value.is_null())
            .cloned()
            .ok_or_else(|| format!("template `{path}` does not resolve to a value"));
    }

    let mut out = String::new();
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let end = after
            .find("}}")
            .ok_or("unterminated `{{` in a params template")?;
        let path = after[..end].trim();
        match lookup_path(context, path) {
            Some(Value::String(s)) => out.push_str(s),
            Some(Value::Number(n)) => out.push_str(&n.to_string()),
            Some(Value::Bool(b)) => out.push_str(&b.to_string()),
            _ => return Err(format!("template `{path}` does not resolve to a scalar")),
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    Ok(Value::String(out))
}

/// A param whose whole value is a template that resolves to an explicit JSON `null` (for example a
/// task's `buyer_agent_id` when a person, not an agent, was the buyer). Such a param is left out of
/// the action's params rather than failing the run: the key is present in the event, it just has
/// no value, and the action's own schema decides whether it is required.
fn resolves_to_null(template: &str, context: &Value) -> bool {
    let trimmed = template.trim();
    trimmed
        .strip_prefix("{{")
        .and_then(|rest| rest.strip_suffix("}}"))
        .filter(|path| !path.contains("{{"))
        .and_then(|path| lookup_path(context, path.trim()))
        .is_some_and(Value::is_null)
}

fn render_value(value: &Value, context: &Value) -> Result<Value, String> {
    match value {
        Value::String(s) if s.contains("{{") => render_string(s, context),
        Value::Array(items) => items
            .iter()
            .map(|item| render_value(item, context))
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, item) in map {
                if matches!(item, Value::String(s) if s.contains("{{") && resolves_to_null(s, context))
                {
                    continue;
                }
                out.insert(key.clone(), render_value(item, context)?);
            }
            Ok(Value::Object(out))
        }
        other => Ok(other.clone()),
    }
}

/// Fill `{{event.payload.x}}` templates in `params` from the triggering event.
pub fn resolve_params(params: &Value, event: Option<&PlatformEvent>) -> Result<Value, String> {
    let params = if params.is_null() {
        json!({})
    } else {
        params.clone()
    };
    if !params.is_object() {
        return Err("params must be an object".into());
    }
    let context = match event {
        Some(event) => event_context(event),
        None => json!({}),
    };
    let rendered = render_value(&params, &context)?;
    let size = serde_json::to_vec(&rendered)
        .map_err(|e| e.to_string())?
        .len();
    if size > MAX_PARAMS_BYTES {
        return Err(format!(
            "params are {size} bytes; the limit is {MAX_PARAMS_BYTES}"
        ));
    }
    Ok(rendered)
}

/// Stable across retries and re-deliveries of the same event, distinct per job and action, so the
/// relayer's idempotency scope absorbs duplicates instead of submitting twice.
pub fn idempotency_key(
    job_id: uuid::Uuid,
    event: Option<&PlatformEvent>,
    window: Option<&str>,
    action_id: &str,
) -> String {
    let source = event
        .map(|e| e.deduplication_key.as_str())
        .or(window)
        .unwrap_or("");
    let digest = Sha256::digest(format!("{source}|{action_id}").as_bytes());
    format!("auto:{job_id}:{}", &hex::encode(digest)[..32])
}

pub fn parse_config(value: &Value) -> Result<RegisteredActionConfig, String> {
    serde_json::from_value(value.clone())
        .map_err(|e| format!("invalid registered_action config: {e}"))
}

/// Structural checks done when a job is created, so a typo fails then rather than at run time.
pub fn validate_config(config: &RegisteredActionConfig) -> Result<(), String> {
    if !valid_action_id(&config.action_id) {
        return Err(format!("`{}` is not a valid action id", config.action_id));
    }
    if !(config.params.is_null() || config.params.is_object()) {
        return Err("params must be an object".into());
    }
    if let Some(key_ref) = &config.key_ref {
        if key_ref.trim().is_empty() {
            return Err("key_ref must not be blank".into());
        }
    }
    config.policy.validate()
}

/// What running a chain action did.
#[derive(Debug, Clone)]
pub enum ChainActionResult {
    Executed(Value),
    /// Nothing was submitted, deliberately. Recorded as a skipped run, not a failure.
    Skipped(String),
}

/// Prepare, sign and submit one registered action through the bridge.
pub async fn submit(
    bridge: &MemoryBridgeClient,
    job: &AutomationJob,
    key_ref: Option<&str>,
    action_id: &str,
    params: &Value,
    idempotency_key: &str,
) -> Result<ChainActionResult, BridgeError> {
    let key_ref = key_ref.unwrap_or(&job.target_agent_key_ref);
    match bridge
        .chain_act(key_ref, &job.account_id, action_id, params, idempotency_key)
        .await
    {
        Ok(summary) => Ok(ChainActionResult::Executed(summary)),
        // 409: the chain moved on (already settled, deadline passed, another keeper won the race).
        // Retrying cannot help and it is not the owner's mistake, so it is a skip, not a failure.
        Err(BridgeError::Rejected {
            status: 409,
            message,
        }) => Ok(ChainActionResult::Skipped(format!(
            "chain state no longer allows {action_id}: {message}"
        ))),
        Err(other) => Err(other),
    }
}

/// Run a `registered_action` job for one event (or one scheduled window).
pub async fn execute(
    bridge: &MemoryBridgeClient,
    job: &AutomationJob,
    event: Option<&PlatformEvent>,
    window: Option<&str>,
    now_ms: i64,
) -> Result<ChainActionResult, BridgeError> {
    let config =
        parse_config(&job.action.config).map_err(|message| BridgeError::Invalid { message })?;
    validate_config(&config).map_err(|message| BridgeError::Invalid { message })?;

    if let Some(event) = event {
        if let Some(reason) = stale_reason(&event.payload, now_ms) {
            return Ok(ChainActionResult::Skipped(reason));
        }
        if let PolicyVerdict::Skip(reason) = evaluate_policy(&config.policy, &event.payload) {
            return Ok(ChainActionResult::Skipped(reason));
        }
    } else if !config.policy.is_empty() {
        return Err(BridgeError::Invalid {
            message: "a policy needs a triggering event; scheduled runs have none".into(),
        });
    }

    let params = resolve_params(&config.params, event)
        .map_err(|message| BridgeError::Invalid { message })?;
    let key = idempotency_key(job.id, event, window, &config.action_id);
    submit(
        bridge,
        job,
        config.key_ref.as_deref(),
        &config.action_id,
        &params,
        &key,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(payload: Value) -> PlatformEvent {
        PlatformEvent {
            event_version: 1,
            event_family: "task".into(),
            event_type: "offered".into(),
            organization_id: None,
            account_id: Some("0xseller".into()),
            agent_object_id: Some("0xagent".into()),
            payload,
            occurred_at_ms: 1_000,
            source_event_id: "e1".into(),
            deduplication_key: "task:0xt:offered".into(),
            source_service: "social".into(),
            target_job_id: None,
        }
    }

    fn offer_payload() -> Value {
        json!({
            "task_id": "0xtask",
            "amount_mist": "5000000000",
            "delivery_window_ms": "86400000",
            "buyer_principal": "0xAbC",
            "buyer_score_milli": 3800,
            "buyer_credibility_bps": 4000,
            "seller_open_tasks": 1,
            "scope_digest": "AB".repeat(32),
            "terms_digest": "cd".repeat(32),
            "expires_at_ms": 9_000_000_000_000u64,
        })
    }

    fn policy(value: Value) -> ActionPolicy {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn an_empty_policy_always_proceeds() {
        assert!(ActionPolicy::default().is_empty());
        assert_eq!(
            evaluate_policy(&ActionPolicy::default(), &json!({})),
            PolicyVerdict::Proceed
        );
    }

    #[test]
    fn amount_floor_is_a_workflow_condition_but_legacy_ceiling_is_ignored() {
        let p = policy(
            json!({ "min_amount_mist": "1000000000", "max_amount_mist": 10_000_000_000u64 }),
        );
        assert_eq!(
            evaluate_policy(&p, &offer_payload()),
            PolicyVerdict::Proceed
        );

        let low = policy(json!({ "min_amount_mist": "6000000000" }));
        assert!(
            matches!(evaluate_policy(&low, &offer_payload()), PolicyVerdict::Skip(r) if r.contains("below"))
        );
        let high = policy(json!({ "max_amount_mist": "4000000000" }));
        assert_eq!(evaluate_policy(&high, &offer_payload()), PolicyVerdict::Proceed);
        assert!(high.is_empty());
    }

    #[test]
    fn each_field_passes_and_fails_independently() {
        let payload = offer_payload();
        let cases = [
            (
                json!({ "min_delivery_window_ms": 86_400_000 }),
                json!({ "min_delivery_window_ms": 86_400_001u64 }),
            ),
            (
                json!({ "max_open_tasks": 1 }),
                json!({ "max_open_tasks": 0 }),
            ),
            (
                json!({ "min_buyer_score_milli": 3800 }),
                json!({ "min_buyer_score_milli": 3801 }),
            ),
            (
                json!({ "min_buyer_credibility_bps": 4000 }),
                json!({ "min_buyer_credibility_bps": 4001 }),
            ),
        ];
        for (ok, bad) in cases {
            assert_eq!(
                evaluate_policy(&policy(ok.clone()), &payload),
                PolicyVerdict::Proceed,
                "{ok}"
            );
            assert!(
                matches!(
                    evaluate_policy(&policy(bad.clone()), &payload),
                    PolicyVerdict::Skip(_)
                ),
                "{bad}"
            );
        }
    }

    #[test]
    fn principal_and_scope_allowlists_normalize_hex() {
        let payload = offer_payload();
        let ok = policy(json!({
            "allowed_buyer_principals": ["0xabc"],
            "scope_digest_allowlist": ["ab".repeat(32)],
        }));
        assert_eq!(evaluate_policy(&ok, &payload), PolicyVerdict::Proceed);

        let other_buyer = policy(json!({ "allowed_buyer_principals": ["0xdef"] }));
        assert!(
            matches!(evaluate_policy(&other_buyer, &payload), PolicyVerdict::Skip(r) if r.contains("allowlist"))
        );
        let other_scope = policy(json!({ "scope_digest_allowlist": ["00".repeat(32)] }));
        assert!(matches!(
            evaluate_policy(&other_scope, &payload),
            PolicyVerdict::Skip(_)
        ));
    }

    #[test]
    fn a_set_field_missing_from_the_payload_fails_closed() {
        let p = policy(json!({ "min_buyer_score_milli": 3000 }));
        assert!(
            matches!(evaluate_policy(&p, &json!({})), PolicyVerdict::Skip(r) if r.contains("no `buyer_score_milli`"))
        );
        let p = policy(json!({ "allowed_buyer_principals": ["0x1"] }));
        assert!(matches!(
            evaluate_policy(&p, &json!({})),
            PolicyVerdict::Skip(_)
        ));
    }

    #[test]
    fn invalid_policies_are_rejected_when_parsed_or_validated() {
        assert!(
            serde_json::from_value::<ActionPolicy>(json!({ "min_amount_mist": "ten" })).is_err()
        );
        assert!(serde_json::from_value::<ActionPolicy>(json!({ "mystery": 1 })).is_err());
        assert!(serde_json::from_value::<ActionPolicy>(json!({ "max_amount_mist": "ten" })).is_err());
        assert!(policy(json!({ "min_amount_mist": 5, "max_amount_mist": 1 })).validate().is_ok());
        assert!(policy(json!({ "allowed_buyer_principals": [] }))
            .validate()
            .is_err());
    }

    #[test]
    fn stale_events_are_detected_by_their_deadline() {
        assert!(stale_reason(&json!({ "expires_at_ms": 100 }), 99).is_none());
        assert!(stale_reason(&json!({ "expires_at_ms": 100 }), 100).is_none());
        assert!(stale_reason(&json!({ "expires_at_ms": "100" }), 101).is_some());
        assert!(stale_reason(&json!({}), 1_000_000).is_none());
    }

    #[test]
    fn action_ids_are_namespaced_and_versioned() {
        for ok in [
            "task.accept.v1",
            "task.cancel_offer.v1",
            "social.create_post.v12",
        ] {
            assert!(valid_action_id(ok), "{ok}");
        }
        for bad in [
            "",
            "task.accept",
            "task.accept.v",
            "Task.accept.v1",
            "task..v1",
            "a.b.c.v1",
            "0x2::coin::transfer",
            "task.accept.v1 ",
        ] {
            assert!(!valid_action_id(bad), "{bad}");
        }
        assert!(!valid_action_id(&format!("task.{}.v1", "a".repeat(80))));
    }

    #[test]
    fn whole_value_templates_keep_their_json_type() {
        let params = json!({
            "taskId": "{{event.payload.task_id}}",
            "stars": 5,
            "nested": { "agent": "{{ event.agent_object_id }}" },
            "list": ["{{event.payload.buyer_score_milli}}"],
        });
        let out = resolve_params(&params, Some(&event(offer_payload()))).unwrap();
        assert_eq!(out["taskId"], "0xtask");
        assert_eq!(out["stars"], 5);
        assert_eq!(out["nested"]["agent"], "0xagent");
        assert_eq!(out["list"][0], 3800);
    }

    #[test]
    fn embedded_templates_interpolate_scalars_only() {
        let out = resolve_params(
            &json!({ "uri": "wal://{{event.payload.task_id}}/{{event.payload.buyer_score_milli}}" }),
            Some(&event(offer_payload())),
        )
        .unwrap();
        assert_eq!(out["uri"], "wal://0xtask/3800");
        assert!(resolve_params(
            &json!({ "x": "a {{event.payload}} b" }),
            Some(&event(offer_payload()))
        )
        .is_err());
    }

    #[test]
    fn unresolved_or_malformed_templates_are_errors_not_blanks() {
        let e = event(offer_payload());
        assert!(resolve_params(&json!({ "x": "{{event.payload.nope}}" }), Some(&e)).is_err());
        assert!(resolve_params(&json!({ "x": "{{event.payload.task_id" }), Some(&e)).is_err());
        assert!(resolve_params(&json!({ "x": "{{event.payload.task_id}}" }), None).is_err());
        assert!(resolve_params(&json!([1]), Some(&e)).is_err());
        assert_eq!(resolve_params(&Value::Null, None).unwrap(), json!({}));
    }

    #[test]
    fn a_param_that_resolves_to_null_is_omitted_not_an_error() {
        let mut payload = offer_payload();
        payload["buyer_agent_id"] = Value::Null;
        let e = event(payload);
        let out = resolve_params(
            &json!({
                "taskId": "{{event.payload.task_id}}",
                "buyerAgentId": "{{event.payload.buyer_agent_id}}",
                "kept": 1,
            }),
            Some(&e),
        )
        .unwrap();
        assert_eq!(out, json!({ "taskId": "0xtask", "kept": 1 }));
        // A key the event never had is still a mistake in the job, not an absent optional.
        assert!(resolve_params(&json!({ "x": "{{event.payload.nope}}" }), Some(&e)).is_err());
        // Only a whole-value template is optional; a null inside an array or a string is an error.
        assert!(resolve_params(
            &json!({ "x": ["{{event.payload.buyer_agent_id}}"] }),
            Some(&e)
        )
        .is_err());
        assert!(resolve_params(
            &json!({ "x": "a {{event.payload.buyer_agent_id}}" }),
            Some(&e)
        )
        .is_err());
    }

    #[test]
    fn oversized_params_are_rejected() {
        let big = json!({ "blob": "x".repeat(MAX_PARAMS_BYTES + 1) });
        assert!(resolve_params(&big, None).is_err());
    }

    #[test]
    fn idempotency_keys_are_stable_distinct_and_relayer_valid() {
        let job = uuid::Uuid::new_v4();
        let e = event(offer_payload());
        let a = idempotency_key(job, Some(&e), None, "task.accept.v1");
        assert_eq!(a, idempotency_key(job, Some(&e), None, "task.accept.v1"));
        assert_ne!(a, idempotency_key(job, Some(&e), None, "task.decline.v1"));
        assert_ne!(
            a,
            idempotency_key(uuid::Uuid::new_v4(), Some(&e), None, "task.accept.v1")
        );
        let mut other = e.clone();
        other.deduplication_key = "task:0xt:accepted".into();
        assert_ne!(
            a,
            idempotency_key(job, Some(&other), None, "task.accept.v1")
        );
        // The relayer accepts 8..=128 characters of [A-Za-z0-9-_:./].
        assert!((8..=128).contains(&a.len()));
        assert!(a
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_:./".contains(&b)));
        // Scheduled runs key on the due window.
        assert_ne!(
            idempotency_key(job, None, Some("100"), "task.release.v1"),
            idempotency_key(job, None, Some("200"), "task.release.v1")
        );
    }

    #[test]
    fn config_validation_catches_typos_at_creation() {
        let ok = parse_config(&json!({ "action_id": "task.accept.v1", "params": {} })).unwrap();
        assert!(validate_config(&ok).is_ok());
        assert!(parse_config(&json!({ "action_id": "task.accept.v1", "polcy": {} })).is_err());
        let bad_id = parse_config(&json!({ "action_id": "0x2::coin::transfer" })).unwrap();
        assert!(validate_config(&bad_id).is_err());
        let blank_key =
            parse_config(&json!({ "action_id": "task.accept.v1", "key_ref": " " })).unwrap();
        assert!(validate_config(&blank_key).is_err());
    }
}
