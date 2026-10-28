-- Idempotency journal for task-artifact uploads to the operator's private R2 bucket.
-- Pending rows survive process failure so a retry reconciles the deterministic R2 object key.
CREATE TABLE IF NOT EXISTS task_deliverable_uploads (
    account_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    storage_namespace TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'uploaded')),
    uri TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, agent_id, task_id, idempotency_key),
    CHECK ((status = 'pending' AND uri IS NULL) OR (status = 'uploaded' AND uri IS NOT NULL))
);
