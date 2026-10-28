ALTER TABLE work_runs
    ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS work_runs_cancel_requested
    ON work_runs(scope_key, cancel_requested_at)
    WHERE cancel_requested_at IS NOT NULL;
