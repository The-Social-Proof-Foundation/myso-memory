-- Append-only metadata history for automation delegate ciphertext lifecycle.
-- This never records seeds, ciphertext, signatures, or encryption secrets.
CREATE TABLE IF NOT EXISTS automation_delegate_key_events (
    id BIGSERIAL PRIMARY KEY,
    account_id TEXT NOT NULL,
    delegate_ref TEXT NOT NULL,
    agent_object_id TEXT NOT NULL,
    mydata_key_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('created', 'replaced', 'deleted')),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS automation_delegate_key_events_scope
    ON automation_delegate_key_events(account_id, agent_object_id, id);
