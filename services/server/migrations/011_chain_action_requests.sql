CREATE TABLE IF NOT EXISTS chain_action_requests (
    idempotency_scope TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    agent_object_id TEXT NOT NULL,
    registry_action TEXT NOT NULL,
    registry_version TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    parameter_hash TEXT NOT NULL,
    transaction_kind_hash TEXT NOT NULL,
    package_id TEXT NOT NULL,
    package_version TEXT NOT NULL,
    sender TEXT NOT NULL,
    sponsored_bytes TEXT,
    digest TEXT UNIQUE,
    signature_hash TEXT,
    status TEXT NOT NULL,
    simulation_response JSONB,
    execution_response JSONB,
    failure_reason TEXT,
    prepared_at_ms BIGINT NOT NULL,
    expires_at_ms BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chain_action_status_check CHECK (
        status IN ('preparing', 'sponsored', 'submitting', 'executed', 'failed')
    ),
    CONSTRAINT chain_action_idempotency_unique UNIQUE (
        account_id,
        agent_object_id,
        registry_action,
        idempotency_key
    )
);

ALTER TABLE chain_action_requests
    ADD COLUMN IF NOT EXISTS simulation_response JSONB;

CREATE INDEX IF NOT EXISTS idx_chain_action_digest
    ON chain_action_requests (digest)
    WHERE digest IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_chain_action_expiry
    ON chain_action_requests (expires_at_ms)
    WHERE status IN ('preparing', 'sponsored', 'submitting');
