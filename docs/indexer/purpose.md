---
title: "Purpose"
---

The indexer keeps the backend in sync with onchain state so the relayer can resolve accounts quickly.

## Why It Exists

Without the indexer, every authenticated request would require the relayer to scan the onchain `MemoryRegistry` to find which `MemoryAccount` holds a given delegate key. This involves fetching the registry object, iterating through its dynamic fields, and checking each account — an expensive chain of RPC calls.

The indexer eliminates this by listening to MySo events and syncing account data into PostgreSQL. The relayer can then resolve delegate key ownership with a single database lookup.

## How It Works

The indexer is a standalone Rust service (`services/indexer`) that:

1. Connects to the same PostgreSQL database as the relayer
2. Polls MySo blockchain events using `mysox_queryEvents`
3. Filters for `MemoryAccountMigrated` events from the Memory package
4. Inserts `account_id → owner` mappings into the `accounts` table
5. Stores its event cursor in `indexer_state` so it can resume after restarts

## Auth Resolution Flow

When the relayer receives a request, it resolves the delegate key's account using this priority:

1. **PostgreSQL cache** (`delegate_key_cache`) — fastest, populated lazily by the relayer itself
2. **Indexed accounts** (`accounts`) — populated by the indexer, enables account discovery without chain scans
3. **Onchain registry scan** — fallback, scans `MemoryRegistry` dynamic fields via RPC
4. **Header hint** (`x-account-id`) — client-provided hint, useful during first-time setup
5. **Config fallback** (`MEMORY_ACCOUNT_ID`) — server-level default

After successful resolution through any strategy, the mapping is cached in `delegate_key_cache` for future requests.

## Configuration

The indexer reads these environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `MEMORY_PACKAGE_ID` | Yes | — | Memory contract package ID to filter events |
| `MYSO_RPC_URL` | No | Mainnet fullnode | MySo RPC endpoint |
| `POLL_INTERVAL_SECS` | No | `5` | Seconds between event poll cycles |

## Running

```bash
cd services/indexer
cargo run
```

The indexer is recommended for production but optional for development — the relayer can fall back to onchain resolution without it.
