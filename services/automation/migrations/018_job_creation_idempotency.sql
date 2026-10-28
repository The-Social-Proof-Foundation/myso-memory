-- Deduplicate retries of a caller's automation creation request. The key is
-- scoped to organization, account, owner and target agent; the hash binds the
-- exact settings accepted by the automation engine.
CREATE TABLE IF NOT EXISTS automation_job_creation_keys (
    organization_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    owner_address TEXT NOT NULL,
    target_agent_object_id TEXT NOT NULL,
    request_key UUID NOT NULL,
    request_hash BYTEA NOT NULL CHECK (octet_length(request_hash) = 32),
    job_id UUID UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (organization_id, account_id, owner_address, target_agent_object_id, request_key),
    CONSTRAINT automation_job_creation_job_fk
        FOREIGN KEY (job_id) REFERENCES automation_jobs(id) ON DELETE SET NULL
        DEFERRABLE INITIALLY DEFERRED
);
