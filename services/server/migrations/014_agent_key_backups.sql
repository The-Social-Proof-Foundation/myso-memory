-- Only public credentials and client ciphertext; no server decryption material.
CREATE TABLE IF NOT EXISTS recovery_passkeys (
    chain TEXT NOT NULL, account_id TEXT NOT NULL, credential_id TEXT NOT NULL,
    credential JSONB NOT NULL, prf_input TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT FALSE, approved_existing BOOLEAN NOT NULL DEFAULT FALSE,
    revoked BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (chain, account_id, credential_id)
);
CREATE TABLE IF NOT EXISTS recovery_roots (
    chain TEXT NOT NULL, account_id TEXT NOT NULL, root_id TEXT NOT NULL,
    PRIMARY KEY (chain, account_id), UNIQUE(chain, account_id, root_id)
);
CREATE TABLE IF NOT EXISTS recovery_root_wraps (
    chain TEXT NOT NULL, account_id TEXT NOT NULL, credential_id TEXT NOT NULL,
    envelope JSONB NOT NULL, revision BIGINT NOT NULL CHECK(revision > 0),
    PRIMARY KEY(chain, account_id, credential_id),
    FOREIGN KEY(chain, account_id, credential_id) REFERENCES recovery_passkeys(chain, account_id, credential_id)
);
CREATE TABLE IF NOT EXISTS agent_key_drafts (
    chain TEXT NOT NULL, account_id TEXT NOT NULL, key_id TEXT NOT NULL,
    envelope JSONB NOT NULL, revision BIGINT NOT NULL CHECK(revision > 0),
    PRIMARY KEY(chain, account_id, key_id)
);
CREATE TABLE IF NOT EXISTS agent_key_envelopes (
    chain TEXT NOT NULL, account_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    key_id TEXT NOT NULL, envelope JSONB NOT NULL, revision BIGINT NOT NULL CHECK(revision > 0),
    PRIMARY KEY(chain, account_id, agent_id), UNIQUE(chain, account_id, key_id)
);

-- Public workflow metadata; independent of encrypted-key revisions.
ALTER TABLE agent_key_drafts ADD COLUMN IF NOT EXISTS registration_intent JSONB;
ALTER TABLE agent_key_envelopes ADD COLUMN IF NOT EXISTS registration_intent JSONB;
ALTER TABLE agent_key_envelopes ADD COLUMN IF NOT EXISTS setup_state JSONB NOT NULL
    DEFAULT '{"vault":"pending","budget":"pending"}'::jsonb;

-- Enrollment proof must remain active until an additional credential is activated.
ALTER TABLE recovery_passkeys ADD COLUMN IF NOT EXISTS approved_by TEXT;
