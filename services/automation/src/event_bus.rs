//! In-process event bus (v1). Ingestion adapters publish here; engine consumes.
//! Future: replace channel backend with Kafka/Redpanda/NATS without changing envelope types.

use tokio::sync::broadcast;

use crate::PlatformEvent;

const BUS_CAPACITY: usize = 4096;

#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<PlatformEvent>,
}

impl EventBus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(BUS_CAPACITY);
        Self { tx }
    }

    pub fn publish(&self, event: PlatformEvent) {
        let _ = self.tx.send(event);
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
        };
        bus.publish(event.clone());
        let got = rx.recv().await.unwrap();
        assert_eq!(got, event);
    }
}
