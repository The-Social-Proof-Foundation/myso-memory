ALTER TABLE automation_jobs
    ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_automation_jobs_org_archived
    ON automation_jobs (organization_id, archived, enabled);
