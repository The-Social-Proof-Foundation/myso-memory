ALTER TABLE work_turns DROP CONSTRAINT IF EXISTS work_turns_status_check;
ALTER TABLE work_turns
    ADD CONSTRAINT work_turns_status_check
    CHECK (status IN ('running', 'yielded', 'finished', 'failed', 'reconciling'));
