ALTER TABLE work_runs DROP CONSTRAINT IF EXISTS work_runs_status_check;
ALTER TABLE work_runs
    ADD CONSTRAINT work_runs_status_check
    CHECK (status IN ('planned', 'running', 'yielded', 'waiting_for_input', 'waiting_for_approval', 'reconciling', 'delivered', 'settled', 'disputed', 'refunded', 'cancelled', 'failed'));
