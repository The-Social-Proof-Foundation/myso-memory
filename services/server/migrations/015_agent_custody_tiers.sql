-- Custody tiers: one recovery root per account, one independently encrypted wrap per
-- (method, subject). Additive and idempotent; existing passkey wraps keep their row key.

-- Existing rows are passkey wraps: subject was the credential id.
ALTER TABLE recovery_root_wraps ADD COLUMN IF NOT EXISTS method TEXT NOT NULL DEFAULT 'passkey-prf-v1';
ALTER TABLE recovery_root_wraps ADD COLUMN IF NOT EXISTS subject TEXT;
UPDATE recovery_root_wraps SET subject = credential_id WHERE subject IS NULL;
ALTER TABLE recovery_root_wraps ALTER COLUMN subject SET NOT NULL;

-- Non-passkey subjects have no recovery_passkeys row, so the legacy FK must go.
ALTER TABLE recovery_root_wraps DROP CONSTRAINT IF EXISTS recovery_root_wraps_chain_account_id_credential_id_fkey;

-- Replace the primary key with (chain, account_id, method, subject). The new primary key keeps
-- the default constraint name, so re-running only touches a key that is not already the target
-- shape (which keeps this migration a no-op on every later startup).
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint c
        WHERE c.conrelid = 'recovery_root_wraps'::regclass AND c.contype = 'p'
          AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text) FROM unnest(c.conkey) AS k(attnum)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
              <> ARRAY['account_id','chain','method','subject']::text[]
    ) THEN
        ALTER TABLE recovery_root_wraps DROP CONSTRAINT recovery_root_wraps_pkey;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'recovery_root_wraps'::regclass AND contype = 'p') THEN
        ALTER TABLE recovery_root_wraps ADD CONSTRAINT recovery_root_wraps_pkey PRIMARY KEY (chain, account_id, method, subject);
    END IF;
END $$;

-- The legacy credential column stays populated for passkey wraps but no longer applies to other
-- methods, so it cannot remain required (only legal once it left the primary key).
ALTER TABLE recovery_root_wraps ALTER COLUMN credential_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS recovery_root_wraps_chain_account_id_method_idx ON recovery_root_wraps(chain, account_id, method);

-- Per-account custody policy; an absent row means "operator default" (all enabled tiers allowed).
CREATE TABLE IF NOT EXISTS custody_policies (
    chain TEXT NOT NULL, account_id TEXT NOT NULL,
    allowed_methods JSONB NOT NULL, active_method TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (chain, account_id)
);
