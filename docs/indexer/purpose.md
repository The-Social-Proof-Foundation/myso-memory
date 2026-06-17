# Indexer Purpose

The **social indexer** in myso-core owns the memory account index. myso-memory does **not** run a separate memory indexer.

## Problem

Without an index, every authenticated request would require expensive on-chain lookups to resolve which MemoryAccount and SubAgent belong to a given public key.

The social indexer listens to `social_contracts::memory` events and exposes them through PostgreSQL and the social server API.

## What gets indexed

| Data | Owner |
|------|-------|
| `memory_accounts` | Social indexer |
| `sub_agents` (by `derived_address`) | Social indexer |
| Profile ↔ MemoryAccount links | Social indexer |
| Vector entries, auth cache, rate limits | Memory relayer DB only |

## Relayer resolution flow

When the memory relayer receives a signed request:

1. Derive `derived_address` from `x-public-key`
2. Check local `sub_agent_cache` (PostgreSQL)
3. On miss, call social API: `GET {SOCIAL_SERVER_URL}/sub-agents/{derivedAddress}`
4. On-chain verify SubAgent + MemoryAccount (capabilities, active, expiry)
5. Cache result in `sub_agent_cache`

Configure the relayer with `SOCIAL_SERVER_URL` (default `http://127.0.0.1:9126`).

## No local memory indexer

The former `services/indexer/` in this repo has been removed. Do not deploy a duplicate account indexer — use the social stack from myso-core.
