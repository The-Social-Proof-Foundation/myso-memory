-- Agent-primary scoping: vector entries belong to a specific SubAgent object.

ALTER TABLE vector_entries
    ADD COLUMN IF NOT EXISTS agent_object_id TEXT;

ALTER TABLE vector_entries
    ADD COLUMN IF NOT EXISTS sub_label TEXT;

ALTER TABLE vector_entries
    ADD COLUMN IF NOT EXISTS tombstoned BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_vector_entries_owner_agent
    ON vector_entries (owner, agent_object_id)
    WHERE tombstoned = FALSE;

CREATE INDEX IF NOT EXISTS idx_vector_entries_agent
    ON vector_entries (agent_object_id)
    WHERE tombstoned = FALSE;

-- Backfill agent_object_id from namespace when it looks like an object id (0x...).
UPDATE vector_entries
SET agent_object_id = namespace
WHERE agent_object_id IS NULL
  AND namespace LIKE '0x%'
  AND length(namespace) >= 10;

UPDATE vector_entries
SET agent_object_id = 'legacy-unscoped'
WHERE agent_object_id IS NULL;
