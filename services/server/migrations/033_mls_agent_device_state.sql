-- E2EE (MLS) device state for agents acting through the MCP / automation bridge. One sealed blob
-- per agent device: the agent's MLS keys, group states and its readable message copies. Sealed by
-- the MCP with a key derived from the agent's own signing key, so this table alone can't read it.
-- A short lease gives exactly one writer at a time (MLS state must never fork: encrypting twice
-- from the same state would reuse AES-GCM nonces), and every write names the expected version.
CREATE TABLE IF NOT EXISTS mls_agent_device_state (
    agent_address TEXT NOT NULL,
    device_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    version BIGINT NOT NULL DEFAULT 0,
    blob BYTEA,
    lease_token TEXT,
    lease_until TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (agent_address, device_id)
);
