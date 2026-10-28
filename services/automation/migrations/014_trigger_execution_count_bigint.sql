-- The public trigger schema accepts u32 caps. Store the full range without
-- narrowing values to PostgreSQL's signed 32-bit integer limit.
ALTER TABLE automation_trigger_state
    ALTER COLUMN execution_count_window TYPE BIGINT
    USING execution_count_window::BIGINT;
