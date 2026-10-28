ALTER TABLE chain_action_approvals
    ADD COLUMN IF NOT EXISTS parameters JSONB;

-- Older rows retained only a parameter hash, so they cannot be safely shown
-- for owner review. Revoke those outstanding intents before requiring payloads.
UPDATE chain_action_approvals
SET status = 'revoked', updated_at = NOW()
WHERE status IN ('pending', 'approved');

UPDATE chain_action_approvals SET parameters = '{}'::jsonb WHERE parameters IS NULL;
ALTER TABLE chain_action_approvals ALTER COLUMN parameters SET DEFAULT '{}'::jsonb;
ALTER TABLE chain_action_approvals ALTER COLUMN parameters SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_chain_action_approvals_agent_pending
    ON chain_action_approvals (account_id, agent_object_id, created_at DESC)
    WHERE status = 'pending';
