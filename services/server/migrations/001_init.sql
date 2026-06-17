-- memory Server — PostgreSQL Schema
-- Requires: pgvector extension

CREATE EXTENSION IF NOT EXISTS vector;

-- Vector entries for similarity search
CREATE TABLE IF NOT EXISTS vector_entries (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    blob_id TEXT NOT NULL,
    embedding vector (1536) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vector_entries_owner ON vector_entries (owner);

CREATE INDEX IF NOT EXISTS idx_vector_entries_blob_id ON vector_entries (blob_id);

-- HNSW index for fast cosine similarity search
CREATE INDEX IF NOT EXISTS idx_vector_entries_embedding ON vector_entries USING hnsw (embedding vector_cosine_ops);

-- Sub-agent auth cache (populated by relayer after social API + on-chain verify)
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