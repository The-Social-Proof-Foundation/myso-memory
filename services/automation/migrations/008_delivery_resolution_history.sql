-- Keep every explicit owner resolution, including a later retry and outcome.
CREATE TABLE IF NOT EXISTS automation_event_delivery_resolutions (
    id BIGSERIAL PRIMARY KEY,
    delivery_id UUID NOT NULL REFERENCES automation_event_deliveries(id) ON DELETE CASCADE,
    job_id UUID NOT NULL REFERENCES automation_jobs(id) ON DELETE CASCADE,
    actor TEXT NOT NULL,
    resolution TEXT NOT NULL CHECK (resolution IN ('confirmed_succeeded','confirmed_not_executed_retry')),
    note TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS automation_delivery_resolutions_lookup
    ON automation_event_delivery_resolutions(delivery_id, created_at, id);
