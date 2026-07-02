-- Enterprise automation engine: jobs, trigger sets, runs, event dedup state.

CREATE TABLE IF NOT EXISTS automation_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    name TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    trigger_set JSONB NOT NULL,
    target_agent_object_id TEXT NOT NULL,
    target_agent_key_ref TEXT NOT NULL,
    action JSONB NOT NULL,
    memory_scope TEXT NOT NULL DEFAULT 'private',
    max_mist_per_run BIGINT NOT NULL DEFAULT 0,
    retry_policy JSONB NOT NULL DEFAULT '{"max_attempts":3,"jitter_ms":1000}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_automation_jobs_org_enabled
    ON automation_jobs (organization_id, enabled);

CREATE TABLE IF NOT EXISTS automation_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES automation_jobs(id) ON DELETE CASCADE,
    trigger_set_snapshot JSONB NOT NULL,
    matched_triggers JSONB NOT NULL DEFAULT '[]'::jsonb,
    trigger_event_id TEXT,
    status TEXT NOT NULL,
    cost_mist BIGINT,
    error TEXT,
    attempt INT NOT NULL DEFAULT 1,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_automation_runs_job_started
    ON automation_runs (job_id, started_at DESC);

CREATE TABLE IF NOT EXISTS automation_trigger_state (
    job_id UUID NOT NULL REFERENCES automation_jobs(id) ON DELETE CASCADE,
    trigger_index INT NOT NULL,
    last_fired_at_ms BIGINT,
    last_dedup_key TEXT,
    matched_at_ms BIGINT,
    execution_count_window INT NOT NULL DEFAULT 0,
    window_started_at_ms BIGINT,
    PRIMARY KEY (job_id, trigger_index)
);

CREATE TABLE IF NOT EXISTS automation_ingested_events (
    deduplication_key TEXT PRIMARY KEY,
    event_family TEXT NOT NULL,
    event_type TEXT NOT NULL,
    envelope JSONB NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
