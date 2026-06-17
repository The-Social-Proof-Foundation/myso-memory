---
title: "Environment Variables"
---

Use this page when you run your own relayer.
For setup steps and deployment context, see [Self-Hosting](/relayer/self-hosting).

## Required

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. `pgvector` must already exist |
| `MEMORY_PACKAGE_ID` | MySo package ID. See [Contract Overview](/contract/overview) |
| `MEMORY_REGISTRY_ID` | Onchain registry object ID. See [Contract Overview](/contract/overview) |
| `MYDATA_KEY_SERVERS` | Comma-separated MYDATA key server object IDs used by the sidecar for encrypt and decrypt |

## Usually Required

These are not all enforced at boot, but most real deployments need them.

| Variable | Notes |
| --- | --- |
| `SERVER_MYSO_PRIVATE_KEY` | Primary server key for backend decrypt and File Storage actions |
| `OPENAI_API_KEY` | Server-side key used to call the embedding and fact-extraction provider |

## Optional

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `8000` | Relayer port |
| `SIDECAR_URL` | `http://localhost:9000` | Sidecar HTTP endpoint |
| `OPENAI_API_BASE` | `https://api.openai.com/v1` | OpenAI-compatible base URL |
| `MYSO_NETWORK` | `mainnet` | Picks the fallback RPC URL and network-driven service defaults |
| `MYSO_RPC_URL` | network default | Override the MySo fullnode URL |
| `FILE_STORAGE_PUBLISHER_URL` | File Storage mainnet publisher | Override upload endpoint |
| `SOCIAL_SERVER_URL` | `http://127.0.0.1:9126` | Social API base URL for sub-agent lookup |
| `FILE_STORAGE_AGGREGATOR_URL` | File Storage mainnet aggregator | Override download endpoint |
| `SERVER_MYSO_PRIVATE_KEYS` | none | Comma-separated upload key pool. Takes priority over `SERVER_MYSO_PRIVATE_KEY` for uploads |
| `MEMORY_ACCOUNT_ID` | none | Optional default MemoryAccount ID in server config |
| `FILE_STORAGE_PACKAGE_ID` | network default | Override the File Storage on-chain package used by the sidecar |
| `FILE_STORAGE_UPLOAD_RELAY_URL` | network default | Override the File Storage upload relay used by the sidecar |
| `ENOKI_API_KEY` | none | Optional Enoki key for sponsored sidecar transactions |
| `ENOKI_NETWORK` | `mainnet` | Network used for Enoki-sponsored flows |

## Notes

- If both `SERVER_MYSO_PRIVATE_KEYS` and `SERVER_MYSO_PRIVATE_KEY` are set, the key pool takes priority for uploads.
- `OPENAI_API_KEY` and `OPENAI_API_BASE` control the embedding and fact-extraction provider used by `remember`, `recall`, `analyze`, `ask`, and restore re-indexing.
- Without `OPENAI_API_KEY`, the server can fall back to mock embeddings. That is useful for local testing, not for normal production behavior.
- `MYSO_NETWORK` drives the default RPC URL, File Storage endpoints, File Storage package ID, and upload relay selection.
- The sidecar `POST /file-storage/upload` route defaults File Storage storage epochs by network: `50` on `testnet` (about 50 days) and `2` on `mainnet` (about 4 weeks), unless the request explicitly passes `epochs`.
- `MEMORY_PACKAGE_ID` and `MEMORY_REGISTRY_ID` are server env vars. Do not replace them with `VITE_*` app env vars.
- For network-specific `MEMORY_PACKAGE_ID` and `MEMORY_REGISTRY_ID` values, see [Contract Overview](/contract/overview).
