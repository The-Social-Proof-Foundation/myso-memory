---
title: "Configuration"
---

Use this page to pick the right config shape quickly.

## `MemoryConfig`

Used by:

- `Memory.create(config)`
- `withMemory(model, options)`

| Field | Required | Notes |
| --- | --- | --- |
| `key` | yes | Delegate private key in hex |
| `accountId` | yes | MemoryAccount object ID on MySo |
| `serverUrl` | no | Relayer URL. Default: `http://localhost:8000` |
| `namespace` | no | Default memory boundary. Default: `"default"` |

## `MemoryManualConfig`

Used by:

- `MemoryManual.create(config)`

Core fields:

| Field | Required | Notes |
| --- | --- | --- |
| `key` | yes | Delegate private key in hex |
| `serverUrl` | no | Relayer URL |
| `embeddingApiKey` | yes | OpenAI/OpenRouter-compatible embedding key |
| `embeddingApiBase` | no | Default: `https://api.openai.com/v1` |
| `embeddingModel` | no | Default: `text-embedding-3-small` |
| `packageId` | yes | Memory package ID on MySo |
| `accountId` | yes | `MemoryAccount` object ID |
| `namespace` | no | Default namespace |

MySo signer fields:

| Field | Required | Notes |
| --- | --- | --- |
| `mysoPrivateKey` | one of two | Use for local signing |
| `walletSigner` | one of two | Use a connected browser wallet instead |
| `mysoClient` | no | Optional pre-configured MySo client |

File Storage and network fields:

| Field | Required | Notes |
| --- | --- | --- |
| `mysoNetwork` | no | `testnet` or `mainnet`. Default: `mainnet` |
| `mydataKeyServers` | no | Override built-in MYDATA key server object IDs for the selected network |
| `fileStorageEpochs` | no | Default: `50` |
| `fileStorageAggregatorUrl` | no | File Storage download endpoint. Defaults follow `mysoNetwork` |
| `fileStoragePublisherUrl` | no | File Storage upload endpoint. Defaults follow `mysoNetwork` |

## `WithMemoryOptions`

`withMemory(model, options)` accepts all `MemoryConfig` fields plus:

| Field | Required | Notes |
| --- | --- | --- |
| `maxMemories` | no | Default: `5` |
| `autoSave` | no | Default: `true` |
| `minRelevance` | no | Default: `0.3` |
| `debug` | no | Default: `false` |

## Rules That Matter

- `namespace` defaults to `"default"` when omitted.
- `Memory` is the default relayer-handled path.
- `MemoryManual` is the manual client path, but it still uses the relayer for registration, search, and restore.
- `withMemory` builds on top of `Memory`, so it uses the same relayer-backed config shape.
- `MemoryManual` now defaults to `mainnet` network settings unless you pass `mysoNetwork: "testnet"`.
- `mydataKeyServers` lets the client override the built-in MYDATA key server list for the selected network.
