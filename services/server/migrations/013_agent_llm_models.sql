CREATE TABLE IF NOT EXISTS agent_llm_models (
    agent_object_id TEXT PRIMARY KEY,
    model_id TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
