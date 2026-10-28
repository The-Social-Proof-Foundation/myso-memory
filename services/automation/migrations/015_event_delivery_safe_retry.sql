-- A safe pre-dispatch failure can be retried with backoff. Uncertain external
-- outcomes remain in reconciliation and are never automatically replayed.
ALTER TABLE automation_event_deliveries
    ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS automation_event_deliveries_available
    ON automation_event_deliveries(status, available_at, created_at);
