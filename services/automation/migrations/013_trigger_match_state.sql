-- Keep ALL-trigger progress durable across workers and process restarts.
-- The event table is an idempotency ledger; the state table is cleared when a
-- complete ALL set fires or when an owner changes the paused job configuration.
CREATE TABLE IF NOT EXISTS automation_trigger_match_events (
    job_id UUID NOT NULL REFERENCES automation_jobs(id) ON DELETE CASCADE,
    event_key TEXT NOT NULL,
    fired BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (job_id, event_key)
);
ALTER TABLE automation_trigger_match_events
    ADD COLUMN IF NOT EXISTS fired BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS automation_trigger_match_state (
    job_id UUID NOT NULL REFERENCES automation_jobs(id) ON DELETE CASCADE,
    trigger_index INTEGER NOT NULL CHECK (trigger_index >= 0),
    matched_at_ms BIGINT NOT NULL,
    PRIMARY KEY (job_id, trigger_index)
);
