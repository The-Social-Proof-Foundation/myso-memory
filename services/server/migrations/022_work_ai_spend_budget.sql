-- Work-run model reservations are fenced by the plan's aggregate AI allocation.
-- These are financial metadata only; prompts and results remain MYDATA ciphertext.
ALTER TABLE work_operations
    ADD COLUMN IF NOT EXISTS max_amount_mist NUMERIC(20,0),
    ADD COLUMN IF NOT EXISTS amount_mist NUMERIC(20,0);
