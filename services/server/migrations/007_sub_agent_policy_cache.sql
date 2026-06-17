-- Expanded sub-agent policy cache (still re-verified on-chain each request).

ALTER TABLE sub_agent_cache
    ADD COLUMN IF NOT EXISTS approval_required_caps BIGINT NOT NULL DEFAULT 0;

ALTER TABLE sub_agent_cache
    ADD COLUMN IF NOT EXISTS max_action_spend BIGINT;

ALTER TABLE sub_agent_cache
    ADD COLUMN IF NOT EXISTS platform_scope TEXT;

ALTER TABLE sub_agent_cache
    ADD COLUMN IF NOT EXISTS parent_object_id TEXT;

ALTER TABLE sub_agent_cache
    ADD COLUMN IF NOT EXISTS expires_at_ms BIGINT;

ALTER TABLE sub_agent_cache
    ADD COLUMN IF NOT EXISTS label TEXT NOT NULL DEFAULT '';

ALTER TABLE sub_agent_cache
    ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;

-- Per-agent on-chain memory vault tracking.

CREATE TABLE IF NOT EXISTS agent_vaults (
    agent_object_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    vault_id TEXT,
    ensured_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_vaults_account ON agent_vaults (account_id);
