-- Encrypted automation delegate keys.
--
-- Each row holds ONE capability-scoped, expiring, revocable sub-agent key that
-- the account owner registered on-chain for unattended memory work. The key is
-- encrypted (X25519 + AES-256-GCM) to the memory bridge's MyData public key before it
-- ever reaches this service, so this table holds ciphertext that only the bridge can
-- open. The engine never sees, decrypts or logs a key. A database dump alone
-- yields nothing usable.
--
-- Rows are not authority: the bridge re-checks the on-chain sub-agent (active,
-- unexpired, memory-only capabilities, spend cap) before every signature, so
-- deleting a row is hygiene and revoking on-chain is the actual kill switch.
--
-- This table replaces an earlier, never-populated `automation_delegates` table that used
-- different column names. The drop is a no-op once it is gone.
DROP TABLE IF EXISTS automation_delegates;

CREATE TABLE IF NOT EXISTS automation_delegate_keys (
    account_id      TEXT        NOT NULL,
    delegate_ref    TEXT        NOT NULL,
    agent_object_id TEXT        NOT NULL,
    mydata_key_id   TEXT        NOT NULL,
    encrypted_key   TEXT        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, delegate_ref)
);
