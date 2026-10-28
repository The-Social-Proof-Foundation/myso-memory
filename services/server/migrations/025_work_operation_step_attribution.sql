ALTER TABLE work_operations
    ADD COLUMN IF NOT EXISTS step_id TEXT;

CREATE INDEX IF NOT EXISTS work_operations_ai_step_usage
    ON work_operations(run_id, step_id, status)
    WHERE tool_name = 'ai_chat' AND step_id IS NOT NULL;
