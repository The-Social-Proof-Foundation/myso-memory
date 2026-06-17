# Database Sync

The memory relayer and the social indexer use **separate concerns** in PostgreSQL.

## Social database (myso-core)

Owned by the social indexer — **not** this repo:

- `memory_accounts` — profile-linked accounts
- `sub_agents` — indexed by `derived_address`
- Profile ↔ account links

## Memory relayer database (this repo)

Migrations run automatically on server boot. The relayer stores **only relayer state**:

### `vector_entries`

Embedding index: owner, namespace, blob_id, vector, optional agent scoping.

### `sub_agent_cache`

Auth optimization — maps public key → account, agent object, capabilities, owner. Replaces the legacy `delegate_key_cache`. TTL-based; re-verified on-chain on use.

### Rate limits / quotas

Redis-backed request limits and per-owner storage quotas.

## Removed tables

The following are **no longer** in the memory server schema:

- `accounts` — account index lives in social DB
- `indexer_state` — no local memory indexer
- `delegate_key_cache` — replaced by `sub_agent_cache`

Migration `005_sub_agent_cache.sql` creates the new cache and drops legacy tables.

## Environment

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Memory relayer PostgreSQL |
| `SOCIAL_SERVER_URL` | Sub-agent lookup API (default `http://127.0.0.1:9126`) |
