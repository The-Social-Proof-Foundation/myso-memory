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

/// Window key when a cron or interval trigger should fire. `None` means not due.
/// A job with no prior run attempt is due. Cron returns the oldest missed UTC slot,
/// allowing the persisted inbox to replay downtime oldest-first. Interval triggers
/// coalesce downtime to the current due bucket. Event triggers are ignored here.
pub fn due_window(
    set: &TriggerSet,
    last_attempt: Option<chrono::DateTime<chrono::Utc>>,
    now: chrono::DateTime<chrono::Utc>,
) -> Option<String> {
    set.triggers.iter().find_map(|trigger| match trigger.kind {
        TriggerKind::Cron => cron_window(
            trigger.cron_expr.as_deref()?,
            trigger.timezone.as_deref().unwrap_or("UTC"),
            last_attempt,
            now,
        ),
        TriggerKind::Interval => {
            interval_window(trigger.interval_ms.unwrap_or(0), last_attempt, now)
        }
        TriggerKind::Conditional | TriggerKind::Event => None,
    })
}

/// Return the oldest due slot after the scheduler's persisted slot cursor.
/// The cursor is the exact stable window key stored on the prior run, not its
/// execution start time: delayed work therefore cannot skip missed slots.
pub fn due_window_from_cursor(
    set: &TriggerSet,
    last_window: Option<&str>,
    last_attempt: Option<chrono::DateTime<chrono::Utc>>,
    now: chrono::DateTime<chrono::Utc>,
) -> Option<String> {
    set.triggers.iter().find_map(|trigger| match trigger.kind {
        TriggerKind::Cron => {
            let expr = trigger.cron_expr.as_deref()?;
            let timezone = trigger.timezone.as_deref().unwrap_or("UTC");
            let cursor = match last_window {
                None => return Some("initial".into()),
                Some("initial") => last_attempt?,
                Some(value) => chrono::DateTime::from_timestamp(value.parse::<i64>().ok()?, 0)?,
            };
            cron_window(expr, timezone, Some(cursor), now)
        }
        TriggerKind::Interval => {
            // The owner selected oldest-first replay for missed cron slots.
            // Interval triggers retain their planned coalescing behavior.
            interval_window(trigger.interval_ms.unwrap_or(0), last_attempt, now)
        }
        TriggerKind::Conditional | TriggerKind::Event => None,
    })
}

fn cron_window(
    expr: &str,
    timezone: &str,
    last_attempt: Option<chrono::DateTime<chrono::Utc>>,
    now: chrono::DateTime<chrono::Utc>,
) -> Option<String> {
    let schedule = parse_cron(expr)?;
    let timezone: chrono_tz::Tz = timezone.parse().ok()?;
    let Some(last) = last_attempt else {
        return Some("initial".into());
    };
    let last_local = last.with_timezone(&timezone);
    let next = schedule.after(&last_local).next()?;
    if next.with_timezone(&chrono::Utc) <= now {
        Some(next.timestamp().to_string())
    } else {
        None
    }
}

fn interval_window(
    interval_ms: i64,
    last_attempt: Option<chrono::DateTime<chrono::Utc>>,
    now: chrono::DateTime<chrono::Utc>,
) -> Option<String> {
    if interval_ms <= 0 {
        return None;
    }
    let Some(last) = last_attempt else {
        return Some("0".into());
    };
    let elapsed = now.signed_duration_since(last).num_milliseconds();
    if elapsed >= interval_ms {
        Some((now.timestamp_millis() / interval_ms).to_string())
    } else {
        None
    }
}

/// Accepts 5-field (min hour dom month dow), 6-field, or the crate's 7-field form.
fn parse_cron(expr: &str) -> Option<cron::Schedule> {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    let normalized = match fields.len() {
        5 => format!("0 {} *", expr.trim()),
        6 => format!("{} *", expr.trim()),
        7 => expr.trim().to_string(),
        _ => return None,
    };
    normalized.parse().ok()
}

/// Reject trigger configurations that the scheduler would silently ignore or never fire.
pub fn validate_trigger_set(set: &TriggerSet) -> Result<(), String> {
    if set.triggers.is_empty() || set.triggers.len() > 32 {
        return Err("trigger set must contain 1 to 32 triggers".into());
    }
    if set.evaluation_window_ms < 0 {
        return Err("evaluation_window_ms cannot be negative".into());
    }
    if set.match_mode == crate::MatchMode::All
        && set
            .triggers
            .iter()
            .any(|trigger| trigger.kind != TriggerKind::Event)
    {
        return Err("ALL matching currently supports event triggers only; cron and interval triggers cannot participate in an ALL set".into());
    }
    for (index, trigger) in set.triggers.iter().enumerate() {
        if trigger.debounce_window_ms < 0 || trigger.cooldown_ms < 0 {
            return Err(format!(
                "trigger {index} debounce and cooldown cannot be negative"
            ));
        }
        if trigger.max_executions_per_window == Some(0) {
            return Err(format!(
                "trigger {index} max_executions_per_window must be positive"
            ));
        }
        if trigger.max_executions_per_window.is_some() && trigger.debounce_window_ms == 0 {
            return Err(format!("trigger {index} max_executions_per_window requires a positive debounce_window_ms, which defines its window"));
        }
        match trigger.kind {
            TriggerKind::Event => {
                if trigger.timezone.is_some() {
                    return Err(format!("event trigger {index} cannot set a timezone"));
                }
                if trigger.event_family.trim().is_empty() || trigger.event_type.trim().is_empty() {
                    return Err(format!(
                        "event trigger {index} needs an event family and type"
                    ));
                }
            }
            TriggerKind::Interval => {
                if trigger.timezone.is_some() {
                    return Err(format!("interval trigger {index} cannot set a timezone"));
                }
                if !trigger.interval_ms.is_some_and(|value| value > 0) {
                    return Err(format!(
                        "interval trigger {index} needs a positive interval_ms"
                    ));
                }
            }
            TriggerKind::Cron => {
                if trigger
                    .timezone
                    .as_deref()
                    .unwrap_or("UTC")
                    .parse::<chrono_tz::Tz>()
                    .is_err()
                {
                    return Err(format!("cron trigger {index} needs a valid IANA timezone"));
                }
                if !trigger
                    .cron_expr
                    .as_deref()
                    .is_some_and(|expr| parse_cron(expr).is_some())
                {
                    return Err(format!("cron trigger {index} has an invalid cron_expr"));
                }
            }
            TriggerKind::Conditional => {
                return Err(format!(
                    "conditional trigger {index} is not supported by the scheduler"
                ));
            }
        }
    }
    Ok(())
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
            target_job_id: None,
        }
    }

    fn event_trigger() -> EventTrigger {
        EventTrigger {
            kind: TriggerKind::Event,
            cron_expr: None,
            timezone: None,
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
            timezone: None,
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

    fn time_trigger(
        kind: TriggerKind,
        cron_expr: Option<&str>,
        interval_ms: Option<i64>,
    ) -> EventTrigger {
        EventTrigger {
            kind,
            cron_expr: cron_expr.map(str::to_string),
            timezone: None,
            interval_ms,
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
        }
    }

    #[test]
    fn interval_is_due_until_a_success_is_inside_the_window() {
        let set = TriggerSet {
            match_mode: MatchMode::Any,
            evaluation_window_ms: 0,
            triggers: vec![time_trigger(TriggerKind::Interval, None, Some(60_000))],
        };
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-03T09:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        assert_eq!(due_window(&set, None, now).as_deref(), Some("0"));
        let recent = now - chrono::Duration::seconds(30);
        assert_eq!(due_window(&set, Some(recent), now), None);
        let stale = now - chrono::Duration::seconds(90);
        assert!(due_window(&set, Some(stale), now).is_some());
    }

    #[test]
    fn cron_is_due_after_its_scheduled_time() {
        let set = TriggerSet {
            match_mode: MatchMode::Any,
            evaluation_window_ms: 0,
            triggers: vec![time_trigger(TriggerKind::Cron, Some("0 9 * * *"), None)],
        };
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-03T09:00:01Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        assert_eq!(due_window(&set, None, now).as_deref(), Some("initial"));
        let before = now - chrono::Duration::hours(2);
        assert!(due_window(&set, Some(before), now).is_some());
        assert_eq!(due_window(&set, Some(now), now), None);
    }

    #[test]
    fn cron_uses_configured_iana_timezone_and_returns_utc_slot_identity() {
        let mut trigger = time_trigger(TriggerKind::Cron, Some("0 9 * * *"), None);
        trigger.timezone = Some("America/Chicago".into());
        let set = TriggerSet {
            match_mode: MatchMode::Any,
            evaluation_window_ms: 0,
            triggers: vec![trigger],
        };
        let last = chrono::DateTime::parse_from_rfc3339("2026-10-03T13:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-03T14:00:01Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        assert_eq!(
            due_window(&set, Some(last), now).as_deref(),
            Some("1791036000")
        );
    }

    #[test]
    fn scheduler_replays_missed_cron_slots_oldest_first_from_slot_cursor() {
        let set = TriggerSet {
            match_mode: MatchMode::Any,
            evaluation_window_ms: 0,
            triggers: vec![time_trigger(TriggerKind::Cron, Some("0 * * * *"), None)],
        };
        let last_slot = chrono::DateTime::parse_from_rfc3339("2026-10-03T09:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-03T12:30:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        assert_eq!(
            due_window_from_cursor(&set, Some("1791018000"), Some(last_slot), now).as_deref(),
            Some("1791021600"),
        );
    }

    #[test]
    fn scheduler_coalesces_missed_interval_slots_to_current_bucket() {
        let set = TriggerSet {
            match_mode: MatchMode::Any,
            evaluation_window_ms: 0,
            triggers: vec![time_trigger(TriggerKind::Interval, None, Some(60_000))],
        };
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-03T09:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let last_attempt = now - chrono::Duration::minutes(5);
        assert_eq!(
            due_window_from_cursor(&set, Some("older-slot"), Some(last_attempt), now),
            Some(now.timestamp_millis().div_euclid(60_000).to_string()),
        );
    }
}
