-- Persistent fanout is committed before an ingested event is acknowledged.
CREATE TABLE IF NOT EXISTS automation_event_deliveries (
    id UUID PRIMARY KEY,
    event_key TEXT NOT NULL REFERENCES automation_ingested_events(deduplication_key),
    job_id UUID NOT NULL REFERENCES automation_jobs(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    lease_token UUID,
    lease_until TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (event_key, job_id)
);
CREATE INDEX IF NOT EXISTS automation_event_deliveries_pending
    ON automation_event_deliveries(status, created_at);
