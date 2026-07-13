CREATE TABLE IF NOT EXISTS chain_action_approvals (
    approval_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    agent_object_id TEXT NOT NULL,
    registry_action TEXT NOT NULL,
    registry_version TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    parameter_hash TEXT NOT NULL,
    required_capability BIGINT NOT NULL CHECK (required_capability >= 0),
    risk_tier TEXT NOT NULL CHECK (risk_tier IN ('0', '1A', '1B', '2', '3')),
    owner_address TEXT NOT NULL,
    approval_intent TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    owner_public_key TEXT,
    owner_signature TEXT,
    approved_at_ms BIGINT,
    expires_at_ms BIGINT NOT NULL CHECK (expires_at_ms > 0),
    consumed_action_scope TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chain_action_approval_status CHECK (
        status IN ('pending', 'approved', 'consumed', 'revoked')
    ),
    CONSTRAINT chain_action_approval_identity UNIQUE (
        account_id, agent_object_id, registry_action, idempotency_key
    )
);

ALTER TABLE chain_action_requests
    ADD COLUMN IF NOT EXISTS approval_id TEXT REFERENCES chain_action_approvals(approval_id);

CREATE INDEX IF NOT EXISTS idx_chain_action_approvals_expiry
    ON chain_action_approvals (expires_at_ms)
    WHERE status IN ('pending', 'approved');
