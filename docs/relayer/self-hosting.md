---
title: "Self-Hosting"
---

Self-hosting means running your own relayer — either pointing at an existing Memory package ID or deploying an entirely new Memory instance with your own contract, database, and server wallet.

The managed relayer provided by File Storage Foundation is a reference implementation. You can also build your own implementation that fits the same API surface with custom logic. This guide covers how to run the reference implementation as your own self-hosted relayer.

## Personas & When to Self-Host

There are two primary personas who typically self-host the relayer:

1. **Builders & Teams**: Self-hosting for their own agentic needs or internal team usage, keeping the trust boundary, encryption, and embeddings under their control.
2. **Infra Operators / Managed Service Providers (MSPs)**: Hosting the relayer as a reliable platform or service for *other* external development teams and agentic builders.

The most common reasons to self-host include:

- **Control the trust boundary** — keeping plaintext, encryption, and embedding under your own control rather than trusting a third-party.
- **Run your own Memory instance** — deploying your own contract with a separate package ID, MYDATA encryption keys, and hard data isolation.
- **Choose your own embedding provider** — using your own OpenAI-compatible API and credentials.
- **Guarantee availability** — the managed relayer is a beta service with no SLA.

## Data Isolation (Namespaces)

With the current architecture, Memory isolates data strictly by **User (Owner address)** and **Namespace**.
Because the relayer inherently scopes all vector searches and storage operations by `owner + namespace`, multiple agents or applications can safely share the same relayer deployment by using different namespaces or separate sub-agent keys.

## Horizontal Scaling

If you are a Managed Service Provider or need to handle high agentic throughput, you can horizontally scale your hosted relayer natively. To run multiple instances of the relayer behind a load balancer for the *same* account/package ID:

1. Point all relayer instances to the **same PostgreSQL database**.
2. Supply the **same `SERVER_MYSO_PRIVATE_KEYS` pool** to all instances so they can seamlessly execute concurrent File Storage uploads.
3. Configure the **same Redis cluster** (`REDIS_URL`) across all nodes so that the rate limiter sliding window accurately tracks global user quotas across your deployment.

## What Runs

A self-hosted Memory backend has:

| Component | Location | Description |
|-----------|----------|-------------|
| **Rust relayer** | `services/server` | Axum HTTP server — auth, routing, embedding, vector search |
| **TypeScript sidecar** | `services/server/scripts` | MYDATA encrypt/decrypt, File Storage upload, blob query (uses `@socialproof/mydata` and `@socialproof/file-storage`) |
| **PostgreSQL + pgvector** | External | Vector storage, sub-agent auth cache |
| **Social server** (recommended) | myso-core | Sub-agent index — `GET /sub-agents/:derivedAddress` |

The Rust relayer starts the TypeScript sidecar as a child process on boot. They communicate over HTTP (`localhost:9000` by default). If the sidecar fails to start within 15 seconds, the relayer exits.

## Quick Start

If you do not already have PostgreSQL + pgvector running, start it with:

```bash
docker compose -f services/server/docker-compose.yml up -d postgres
```

Then run the relayer:

```bash
cp services/server/.env.example services/server/.env
cd services/server/scripts
npm ci
cd ..
cargo run
```

Then check:

```bash
curl http://localhost:8000/health
```

## Environment Variables

### Required

- `DATABASE_URL`
- `MEMORY_PACKAGE_ID`
- `MEMORY_REGISTRY_ID` — optional for relayer auth (still used by some sidecar flows)
- `SOCIAL_SERVER_URL` — social API for sub-agent lookup (default `http://127.0.0.1:9126`)
- `SERVER_MYSO_PRIVATE_KEY` or `SERVER_MYSO_PRIVATE_KEYS`
- `MYDATA_KEY_SERVERS` — comma-separated list of MYDATA key server object IDs

### Recommended

- `OPENAI_API_KEY` — enables real embeddings (falls back to mock embeddings without it)
- `OPENAI_API_BASE` — point to an OpenAI-compatible provider like OpenRouter

### Rate Limits & Storage (Optional)

By default, the relayer enforces rate limits and storage quotas via Redis to prevent abuse. You can customize these limits:

- `RATE_LIMIT_REQUESTS_PER_MINUTE` — max burst weighted-requests per minute per user (default: 60)
- `RATE_LIMIT_REQUESTS_PER_HOUR` — max sustained weighted-requests per hour per user (default: 500)
- `RATE_LIMIT_DELEGATE_KEY_PER_MINUTE` — max weighted-requests per minute per sub-agent key (default: 30)
- `RATE_LIMIT_STORAGE_BYTES` — max storage per user in bytes (default: 1 GB, `1073741824`)
- `REDIS_URL` — required to track sliding windows for rate limits (default: `redis://localhost:6379`)

### Defaults

- `PORT` defaults to `8000`
- `SIDECAR_URL` defaults to `http://localhost:9000`
- `MYSO_NETWORK` defaults to `mainnet`
- `MYSO_RPC_URL`, File Storage endpoints, and `FILE_STORAGE_PACKAGE_ID` fall back to network defaults based on `MYSO_NETWORK`
- The sidecar File Storage upload route defaults storage `epochs` by network: `50` on `testnet`, `2` on `mainnet` (unless the request passes `epochs`)

### Server Keys

- `SERVER_MYSO_PRIVATE_KEY` is the main server key
- `SERVER_MYSO_PRIVATE_KEYS` is a comma-separated key pool for parallel File Storage uploads
- if both are set, the key pool takes priority for uploads

## Package Contract IDs
### Staging (Testnet)
```env
MYSO_NETWORK=testnet
MEMORY_PACKAGE_ID=0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6
MEMORY_REGISTRY_ID=0xe80f2feec1c139616a86c9f71210152e2a7ca552b20841f2e192f99f75864437

```
### Production (Mainnet)
```env
MYSO_NETWORK=mainnet
MEMORY_PACKAGE_ID=0xcee7a6fd8de52ce645c38332bde23d4a30fd9426bc4681409733dd50958a24c6
MEMORY_REGISTRY_ID=0x0da982cefa26864ae834a8a0504b904233d49e20fcc17c373c8bed99c75a7edd
```

For MYDATA key server object IDs on testnet, see https://mydata-docs.wal.app/Pricing.

Using official key server of SDK is recommended. 

<Note>
`VITE_MEMORY_PACKAGE_ID` and `VITE_MEMORY_REGISTRY_ID` are frontend env vars for the app or playground — not for the relayer.
</Note>

## Database Setup

The relayer requires PostgreSQL with the `pgvector` extension. The relayer runs migrations automatically on boot, creating these tables:

- `vector_entries` — 1536-dimensional embeddings with HNSW index for cosine similarity search
- `sub_agent_cache` — auth optimization (public key → account, agent, capabilities)

See [Database Sync](/indexer/database-sync) for the full schema.

## Operational Notes

- The server starts the sidecar automatically on boot — if sidecar startup fails, the relayer will exit
- DB migrations run automatically on boot (`pgvector` must already be installed as a PostgreSQL extension)
- Connection pool: 10 max connections (relayer)
- `/health` is the basic service check, API routes live under `/api/*`
- Point `SOCIAL_SERVER_URL` at a running social server from myso-core for production auth
- Without `OPENAI_API_KEY`, the server uses deterministic mock embeddings (hash-based) — useful for local testing but not production

## Docker

- `services/server/Dockerfile` for the relayer

## Read Next

- [Relayer API](/relayer/api-reference)
