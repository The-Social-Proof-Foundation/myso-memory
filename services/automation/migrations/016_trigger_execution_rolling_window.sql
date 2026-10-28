CREATE TABLE IF NOT EXISTS automation_trigger_fires (
    job_id UUID NOT NULL REFERENCES automation_jobs(id) ON DELETE CASCADE,
    trigger_index INT NOT NULL,
    fired_at_ms BIGINT NOT NULL,
    event_key TEXT NOT NULL,
    PRIMARY KEY (job_id, trigger_index, event_key)
);

CREATE INDEX IF NOT EXISTS automation_trigger_fires_rolling_window
    ON automation_trigger_fires (job_id, trigger_index, fired_at_ms);

ALTER TABLE automation_event_deliveries
    ADD COLUMN IF NOT EXISTS debounce_coalescible BOOLEAN NOT NULL DEFAULT false;
