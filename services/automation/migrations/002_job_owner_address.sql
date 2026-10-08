-- The AI credit oracle bills by the MemoryAccount owner's wallet address, which
-- is not the MemoryAccount object id stored in `account_id`.
ALTER TABLE automation_jobs ADD COLUMN IF NOT EXISTS owner_address TEXT NOT NULL DEFAULT '';
