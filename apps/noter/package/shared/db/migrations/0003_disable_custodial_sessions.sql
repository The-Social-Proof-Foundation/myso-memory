-- Public compatibility field only; no private-key column is added or read.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "delegateAccountId" text;
-- Invalidate sessions minted by the retired address-only Enoki login.
-- Retain historical ciphertext/plaintext columns for a separately authorized retirement;
-- application schema no longer selects or writes delegatePrivateKey.
UPDATE "wallet_sessions" SET "expiresAt" = NOW() WHERE "walletType" = 'enoki';
