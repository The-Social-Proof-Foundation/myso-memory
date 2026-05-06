---
title: "API Reference"
---

See also:

- [Configuration](/reference/configuration)
- [Relayer API](/relayer/api-reference)

## `Memory.create(config)`

```ts
Memory.create(config: MemoryConfig): Memory
```

Config:

| Property | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `key` | `string` | Yes | — | Ed25519 delegate private key in hex |
| `accountId` | `string` | Yes | — | MemoryAccount object ID on MySo |
| `serverUrl` | `string` | No | `http://localhost:8000` | Relayer URL |
| `namespace` | `string` | No | `"default"` | Default namespace for memory isolation |

For the full config surface, see [Configuration](/reference/configuration).

## `Memory` Methods

### `remember(text, namespace?): Promise<RememberResult>`

Store one memory through the relayer. The relayer handles embedding, MYDATA encryption, File Storage upload, and vector indexing.

**Returns:**

```ts
{
  id: string;        // UUID for this entry
  blob_id: string;   // File Storage blob ID
  owner: string;     // Owner MySo address
  namespace: string; // Namespace used
}
```

### `recall(query, limit?, namespace?): Promise<RecallResult>`

Search for memories matching a natural language query, scoped to `owner + namespace`.

- `limit` defaults to `10`

**Returns:**

```ts
{
  results: Array<{
    blob_id: string;   // File Storage blob ID
    text: string;      // Decrypted plaintext
    distance: number;  // Cosine distance (lower = more similar)
  }>;
  total: number;
}
```

### `analyze(text, namespace?): Promise<AnalyzeResult>`

Extract memorable facts from text using an LLM, then store each fact as a separate memory.

**Returns:**

```ts
{
  facts: Array<{
    text: string;     // Extracted fact
    id: string;       // UUID
    blob_id: string;  // File Storage blob ID
  }>;
  total: number;
  owner: string;
}
```

### `restore(namespace, limit?): Promise<RestoreResult>`

Rebuild missing indexed entries for one namespace from File Storage. Incremental — only re-indexes blobs that aren't already in the local database.

- `limit` defaults to `50`

**Returns:**

```ts
{
  restored: number;   // Entries newly indexed
  skipped: number;    // Entries already in DB
  total: number;      // Total blobs found on-chain
  namespace: string;
  owner: string;
}
```

### `health(): Promise<HealthResult>`

Check relayer health. Does not require authentication.

**Returns:** `{ status: string, version: string }`

### `getPublicKeyHex(): Promise<string>`

Return the hex-encoded public key for the current delegate key.

### Lower-level methods

These exist on the `Memory` class for advanced use cases:

| Method | Description |
|--------|-------------|
| `rememberManual({ blobId, vector, namespace? })` | Register a pre-uploaded blob ID with a pre-computed vector |
| `recallManual({ vector, limit?, namespace? })` | Search with a pre-computed query vector (returns blob IDs, no decryption) |
| `embed(text)` | Generate an embedding vector for text (no storage) |

## `MemoryManual`

```ts
import { MemoryManual } from "@socialproof/memory/manual";
```

See [MemoryManual usage](/sdk/usage/memory-manual) for the full setup and flow details.

### `rememberManual(text, namespace?): Promise<RememberManualResult>`

Embed locally, MYDATA encrypt locally, send encrypted payload + vector to relayer for File Storage upload and vector registration.

### `recallManual(query, limit?, namespace?): Promise<RecallManualResult>`

Embed locally, search via relayer, download from File Storage, MYDATA decrypt locally. Returns decrypted text results.

### `restore(namespace, limit?): Promise<RestoreResult>`

Same as `Memory.restore()` — delegates to the relayer.

### `isWalletMode: boolean`

Whether this client uses a connected wallet signer (vs. raw keypair).

### Config notes

- `mysoNetwork` defaults to `mainnet`
- `mydataKeyServers` lets the client override the built-in MYDATA key server object IDs
- All `@mysten/*` peer dependencies are loaded dynamically — only needed if you use `MemoryManual`

## `withMemory`

```ts
import { withMemory } from "@socialproof/memory/ai";
```

Wraps a Vercel AI SDK model with automatic memory recall and save.

**Before generation:**
- Reads the last user message
- Runs `recall()` against Memory
- Filters by minimum relevance (`minRelevance`, default `0.3`)
- Injects matching memories into the prompt as a system message

**After generation:**
- Optionally runs `analyze()` on the user message (fire-and-forget)
- Saves extracted facts asynchronously

**Options** (extends `MemoryConfig`):

| Option | Default | Description |
|--------|---------|-------------|
| `maxMemories` | `5` | Max memories to inject per request |
| `autoSave` | `true` | Auto-save new facts from conversation |
| `minRelevance` | `0.3` | Minimum similarity score (0–1) to include a memory |
| `debug` | `false` | Enable debug logging |

See [Configuration](/reference/configuration) for all options.

## Account Management

```ts
import {
  createAccount,
  addDelegateKey,
  removeDelegateKey,
  generateDelegateKey,
} from "@socialproof/memory/account";
```

| Function | Description |
|----------|-------------|
| `generateDelegateKey()` | Generate a new Ed25519 keypair (returns `privateKey`, `publicKey`, `mysoAddress`) |
| `createAccount(opts)` | Create a new MemoryAccount on-chain (one per MySo address) |
| `addDelegateKey(opts)` | Add a delegate key to an account (owner only) |
| `removeDelegateKey(opts)` | Remove a delegate key from an account (owner only) |

## Utility Functions

```ts
import { delegateKeyToMySoAddress, delegateKeyToPublicKey } from "@socialproof/memory";
```

| Function | Description |
|----------|-------------|
| `delegateKeyToMySoAddress(privateKeyHex)` | Derive the MySo address from a delegate private key |
| `delegateKeyToPublicKey(privateKeyHex)` | Get the 32-byte public key from a delegate private key |
