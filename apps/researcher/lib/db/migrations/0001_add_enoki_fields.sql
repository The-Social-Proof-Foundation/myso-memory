-- Add Enoki zkLogin fields to User table
-- mysoAddress: stable Enoki wallet address (same every Google login)
-- delegatePrivateKey: stored to recreate session without new key gen
-- accountId: Memory account object ID on MySo
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mysoAddress" varchar(128) UNIQUE;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "delegatePrivateKey" varchar(128);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "accountId" varchar(128);
