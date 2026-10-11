-- Delegate classes.
--
-- `memory` is the original delegate: memory read/write only. `task_worker` additionally holds
-- the on-chain task-trade capability and may run an explicit list of task market actions.
-- `allowed_action_ids` is checked by the bridge before every chain action; the delegate's
-- on-chain capability bits and spend cap remain the authoritative limit.
ALTER TABLE automation_delegate_keys
    ADD COLUMN IF NOT EXISTS delegate_class TEXT NOT NULL DEFAULT 'memory',
    ADD COLUMN IF NOT EXISTS allowed_action_ids JSONB NOT NULL DEFAULT '[]'::jsonb
