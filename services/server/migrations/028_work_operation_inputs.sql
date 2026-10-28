ALTER TABLE work_operations
    ADD COLUMN IF NOT EXISTS input_payload BYTEA;

COMMENT ON COLUMN work_operations.input_payload IS
    'MYDATA-encrypted canonical tool arguments used to bind receipt recovery to the exact saved operation input.';
