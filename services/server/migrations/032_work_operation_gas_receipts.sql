-- Store observed finalized transaction gas for journal audit and recovery.
-- This column does not authorize or cap spending; on-chain permissions do.
ALTER TABLE work_operations
    ADD COLUMN IF NOT EXISTS gas_cost_mist NUMERIC(20, 0);

COMMENT ON COLUMN work_operations.gas_cost_mist IS
    'Observed finalized sender gas charge from the configured fullnode receipt, in MIST. Audit metadata only; it is not a spending limit.';
