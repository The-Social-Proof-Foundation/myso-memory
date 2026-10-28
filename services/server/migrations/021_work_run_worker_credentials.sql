-- Opaque, revocable bearer credentials for one unattended work run. Only the
-- SHA-256 digest is persisted; the raw token is returned once at issuance.
CREATE TABLE IF NOT EXISTS work_run_worker_credentials (
    id UUID PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES work_runs(id) ON DELETE CASCADE,
    scope_key TEXT NOT NULL,
    owner_address TEXT NOT NULL,
    account_id TEXT NOT NULL,
    parent_agent_id TEXT NOT NULL,
    delegate_ref TEXT NOT NULL,
    worker_agent_id TEXT NOT NULL,
    token_hash BYTEA NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS work_run_worker_credentials_live
    ON work_run_worker_credentials(run_id, expires_at DESC)
    WHERE revoked_at IS NULL;
