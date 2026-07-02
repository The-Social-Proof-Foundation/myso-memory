//! Generic EventTrigger matching — no per-event hardcoded handlers.

use crate::{EventTrigger, MatchMode, PlatformEvent, ReplayBehavior, TriggerKind, TriggerSet};

/// Returns true when a platform event matches an event-kind trigger filter.
pub fn event_matches_trigger(event: &PlatformEvent, trigger: &EventTrigger) -> bool {
    if trigger.kind != TriggerKind::Event {
        return false;
    }
    if trigger.event_family != event.event_family || trigger.event_type != event.event_type {
        return false;
    }
    if let Some(ref org) = trigger.organization_id {
        if event.organization_id.as_deref() != Some(org.as_str()) {
            return false;
        }
    }
    if let Some(ref acct) = trigger.account_id {
        if event.account_id.as_deref() != Some(acct.as_str()) {
            return false;
        }
    }
    if let Some(ref agent) = trigger.agent_object_id {
        if event.agent_object_id.as_deref() != Some(agent.as_str()) {
            return false;
        }
    }
    if let Some(ref filter) = trigger.payload_filter {
        if !payload_filter_matches(&event.payload, filter) {
            return false;
        }
    }
    true
}

/// Shallow JSON filter: every key in filter must equal payload[key] (or be nested object).
pub fn payload_filter_matches(payload: &serde_json::Value, filter: &serde_json::Value) -> bool {
    match (payload, filter) {
        (serde_json::Value::Object(p), serde_json::Value::Object(f)) => f.iter().all(|(k, fv)| {
            p.get(k)
                .map(|pv| payload_filter_matches(pv, fv))
                .unwrap_or(false)
        }),
        (a, b) => a == b,
    }
}

/// Evaluate whether a TriggerSet should fire given matched trigger indices and prior state.
pub fn trigger_set_should_fire(
    set: &TriggerSet,
    newly_matched: &[usize],
    prior_matched: &[usize],
    now_ms: i64,
    prior_matched_at_ms: Option<i64>,
) -> bool {
    if newly_matched.is_empty() && prior_matched.is_empty() {
        return false;
    }
    match set.match_mode {
        MatchMode::Any => !newly_matched.is_empty(),
        MatchMode::All => {
            let mut all = prior_matched.to_vec();
            for idx in newly_matched {
                if !all.contains(idx) {
                    all.push(*idx);
                }
            }
            if all.len() < set.triggers.len() {
                return false;
            }
            if set.evaluation_window_ms > 0 {
                if let Some(start) = prior_matched_at_ms {
                    return now_ms.saturating_sub(start) <= set.evaluation_window_ms;
                }
            }
            true
        }
    }
}

pub fn replay_allows(
    behavior: ReplayBehavior,
    dedup_key: &str,
    seen_keys: &std::collections::HashSet<String>,
) -> bool {
    match behavior {
        ReplayBehavior::Skip => !seen_keys.contains(dedup_key),
        ReplayBehavior::AllowOnce => !seen_keys.contains(dedup_key),
        ReplayBehavior::AllowAll => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ReplayBehavior, TriggerKind};

    fn sample_event() -> PlatformEvent {
        PlatformEvent {
            event_version: 1,
            event_family: "post".into(),
            event_type: "created".into(),
            organization_id: Some("0xorg".into()),
            account_id: Some("0xacct".into()),
            agent_object_id: None,
            payload: serde_json::json!({"reactions": 150}),
            occurred_at_ms: 1000,
            source_event_id: "tx1".into(),
            deduplication_key: "post:tx1".into(),
            source_service: "indexer".into(),
        }
    }

    fn event_trigger() -> EventTrigger {
        EventTrigger {
            kind: TriggerKind::Event,
            cron_expr: None,
            interval_ms: None,
            condition: None,
            event_family: "post".into(),
            event_type: "created".into(),
            organization_id: Some("0xorg".into()),
            account_id: None,
            agent_object_id: None,
            payload_filter: Some(serde_json::json!({"reactions": 150})),
            debounce_window_ms: 0,
            cooldown_ms: 0,
            max_executions_per_window: None,
            deduplication_key: None,
            replay_behavior: ReplayBehavior::Skip,
        }
    }

    #[test]
    fn event_trigger_matches_with_payload_filter() {
        assert!(event_matches_trigger(&sample_event(), &event_trigger()));
    }

    #[test]
    fn trigger_set_any_fires_on_single_match() {
        let set = TriggerSet {
            match_mode: MatchMode::Any,
            evaluation_window_ms: 0,
            triggers: vec![event_trigger()],
        };
        assert!(trigger_set_should_fire(&set, &[0], &[], 1000, None));
    }

    #[test]
    fn trigger_set_all_requires_all_triggers() {
        let cron = EventTrigger {
            kind: TriggerKind::Cron,
            cron_expr: Some("0 9 * * *".into()),
            interval_ms: None,
            condition: None,
            event_family: "automation".into(),
            event_type: "tick".into(),
            organization_id: None,
            account_id: None,
            agent_object_id: None,
            payload_filter: None,
            debounce_window_ms: 0,
            cooldown_ms: 0,
            max_executions_per_window: None,
            deduplication_key: None,
            replay_behavior: ReplayBehavior::Skip,
        };
        let set = TriggerSet {
            match_mode: MatchMode::All,
            evaluation_window_ms: 86_400_000,
            triggers: vec![cron, event_trigger()],
        };
        assert!(!trigger_set_should_fire(&set, &[1], &[], 1000, None));
        assert!(trigger_set_should_fire(&set, &[], &[0, 1], 1000, Some(500)));
    }
}
