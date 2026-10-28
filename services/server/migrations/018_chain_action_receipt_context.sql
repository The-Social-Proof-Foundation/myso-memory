-- Public on-chain context for exact-input typed subscription receipts only.
-- This is not a generic action-body/transcript archive.
ALTER TABLE chain_action_requests ADD COLUMN IF NOT EXISTS receipt_context JSONB;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chain_action_receipt_context_shape' AND conrelid = 'chain_action_requests'::regclass) THEN
        ALTER TABLE chain_action_requests ADD CONSTRAINT chain_action_receipt_context_shape
            CHECK (receipt_context IS NULL OR (jsonb_typeof(receipt_context) = 'object' AND pg_column_size(receipt_context) <= 4096));
    END IF;
END $$;
