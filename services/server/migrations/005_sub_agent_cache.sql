-- Greenfield sub-agent cache: replace delegate_key_cache and drop local account indexer tables.

CREATE TABLE IF NOT EXISTS sub_agent_cache (
    public_key TEXT PRIMARY KEY,
    derived_address TEXT NOT NULL,
    account_id TEXT NOT NULL,
    agent_object_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    capabilities BIGINT NOT NULL DEFAULT 0,
    cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
);

CREATE INDEX IF NOT EXISTS idx_sub_agent_cache_derived ON sub_agent_cache (derived_address);

DROP TABLE IF EXISTS delegate_key_cache;
DROP TABLE IF EXISTS accounts;
DROP TABLE IF EXISTS indexer_state;
