//! In-process event bus (v1). Ingestion adapters publish here; engine consumes.
//! Future: replace channel backend with Kafka/Redpanda/NATS without changing envelope types.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tokio::sync::broadcast;

use crate::PlatformEvent;

/// How many events the bus holds for a slow consumer before it starts dropping the oldest. The
/// jury sends bursts (a crank per keeper per case, a poll per open duty), so the default leaves
/// room for them; `AUTOMATION_EVENT_BUS_CAPACITY` overrides it.
pub const DEFAULT_BUS_CAPACITY: usize = 16_384;

/// What the bus has done since it started, for the health check. An event that is dropped here was
/// already acknowledged to its sender, so a non-zero `lagged` is the number to alert on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct BusStats {
    pub capacity: usize,
    pub published: u64,
    pub consumed: u64,
    /// Events a consumer never saw because it fell more than `capacity` behind.
    pub lagged: u64,
    /// Published and neither consumed nor dropped yet.
    pub queued: u64,
}

#[derive(Default)]
struct Counters {
    published: AtomicU64,
    consumed: AtomicU64,
    lagged: AtomicU64,
}

#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<PlatformEvent>,
    capacity: usize,
    counters: Arc<Counters>,
}

impl EventBus {
    pub fn new() -> Self {
        Self::with_capacity(DEFAULT_BUS_CAPACITY)
    }

    pub fn with_capacity(capacity: usize) -> Self {
        let capacity = capacity.max(1);
        let (tx, _) = broadcast::channel(capacity);
        Self {
            tx,
            capacity,
            counters: Arc::new(Counters::default()),
        }
    }

    pub fn publish(&self, event: PlatformEvent) {
        self.counters.published.fetch_add(1, Ordering::Relaxed);
        let _ = self.tx.send(event);
    }

    /// The consumer took one event off the bus.
    pub fn record_consumed(&self) {
        self.counters.consumed.fetch_add(1, Ordering::Relaxed);
    }

    /// The consumer fell behind and `n` events were dropped before it could read them.
    pub fn record_lagged(&self, n: u64) {
        self.counters.lagged.fetch_add(n, Ordering::Relaxed);
    }

    pub fn stats(&self) -> BusStats {
        let published = self.counters.published.load(Ordering::Relaxed);
        let consumed = self.counters.consumed.load(Ordering::Relaxed);
        let lagged = self.counters.lagged.load(Ordering::Relaxed);
        BusStats {
            capacity: self.capacity,
            published,
            consumed,
            lagged,
            queued: published.saturating_sub(consumed).saturating_sub(lagged),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<PlatformEvent> {
        self.tx.subscribe()
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn publish_subscribe_round_trip() {
        let bus = EventBus::new();
        let mut rx = bus.subscribe();
        let event = PlatformEvent {
            event_version: 1,
            event_family: "workflow".into(),
            event_type: "item.created".into(),
            organization_id: None,
            account_id: None,
            agent_object_id: None,
            payload: serde_json::json!({}),
            occurred_at_ms: 1,
            source_event_id: "e1".into(),
            deduplication_key: "d1".into(),
            source_service: "workflow_relayer".into(),
            target_job_id: None,
        };
        bus.publish(event.clone());
        let got = rx.recv().await.unwrap();
        assert_eq!(got, event);
    }

    #[test]
    fn the_stats_count_what_is_waiting_and_what_was_lost() {
        let bus = EventBus::with_capacity(8);
        assert_eq!(bus.stats().capacity, 8);
        let event = |id: &str| PlatformEvent {
            event_version: 1,
            event_family: "jury".into(),
            event_type: "select_due".into(),
            organization_id: None,
            account_id: Some("0xk".into()),
            agent_object_id: None,
            payload: serde_json::json!({}),
            occurred_at_ms: 1,
            source_event_id: id.into(),
            deduplication_key: id.into(),
            source_service: "social_server".into(),
            target_job_id: None,
        };
        for id in ["a", "b", "c", "d"] {
            bus.publish(event(id));
        }
        assert_eq!(bus.stats().queued, 4);
        bus.record_consumed();
        bus.record_lagged(2);
        let stats = bus.stats();
        assert_eq!(
            (stats.published, stats.consumed, stats.lagged, stats.queued),
            (4, 1, 2, 1)
        );
        // A capacity of zero would make the channel panic, so it is raised to one.
        assert_eq!(EventBus::with_capacity(0).stats().capacity, 1);
    }
}
