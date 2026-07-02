-- Org-shared memory visibility.
--
-- visibility: 0 = private (writing agent only), 1 = org (OrgMemoryReader holders on the
-- org's share group), 2 = account (any active CAP_MEMORY_READ agent on the account).
-- organization_id is required only when visibility = 1. Existing rows stay private.

ALTER TABLE vector_entries
    ADD COLUMN IF NOT EXISTS visibility SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE vector_entries
    ADD COLUMN IF NOT EXISTS organization_id TEXT;

CREATE INDEX IF NOT EXISTS idx_vector_entries_org_visible
    ON vector_entries (owner, organization_id)
    WHERE visibility = 1 AND tombstoned = FALSE;

CREATE INDEX IF NOT EXISTS idx_vector_entries_account_visible
    ON vector_entries (owner)
    WHERE visibility = 2 AND tombstoned = FALSE;

ALTER TABLE remember_jobs
    ADD COLUMN IF NOT EXISTS visibility SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE remember_jobs
    ADD COLUMN IF NOT EXISTS organization_id TEXT;
