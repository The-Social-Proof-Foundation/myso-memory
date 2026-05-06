-- Indexer and server run CREATE TABLE in schema public on startup.
-- If you see SQLSTATE 42501 "permission denied for schema public", run this as a
-- superuser or database owner (replace `memory` if your DATABASE_URL user differs).
--
-- This file runs automatically when Postgres starts with an empty data directory
-- (see services/server/docker-compose.yml). For existing volumes, run once manually:
--   psql "postgresql://postgres:...@localhost:5432/memory" -f services/server/postgres-init/00-grant-public.sql

GRANT USAGE, CREATE ON SCHEMA public TO memory;
ALTER DEFAULT PRIVILEGES FOR ROLE memory IN SCHEMA public GRANT ALL ON TABLES TO memory;
ALTER DEFAULT PRIVILEGES FOR ROLE memory IN SCHEMA public GRANT ALL ON SEQUENCES TO memory;
