-- Async remember job tracking (202 Accepted + poll).

CREATE TABLE IF NOT EXISTS remember_jobs (
    id              TEXT PRIMARY KEY,
    owner           TEXT NOT NULL,
    agent_object_id TEXT NOT NULL,
    sub_label       TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'running', 'done', 'failed')),
    blob_id         TEXT,
    error_msg       TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_remember_jobs_owner ON remember_jobs (owner);
CREATE INDEX IF NOT EXISTS idx_remember_jobs_agent ON remember_jobs (agent_object_id);
CREATE INDEX IF NOT EXISTS idx_remember_jobs_status ON remember_jobs (status);
