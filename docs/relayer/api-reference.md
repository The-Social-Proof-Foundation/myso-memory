---
title: "API Reference"
---

The Rust relayer exposes these routes. Routes are defined in `services/server/src/main.rs`.

See also:

- [Environment Variables](/reference/environment-variables)
- [Configuration](/reference/configuration)

## Authentication

All `/api/*` routes require signed headers. The SDK handles this automatically.

### Required Headers

| Header | Description |
|--------|-------------|
| `x-public-key` | Hex-encoded Ed25519 public key (32 bytes) |
| `x-signature` | Hex-encoded Ed25519 signature (64 bytes) |
| `x-timestamp` | Unix timestamp in seconds (5-minute validity window) |

### Optional Headers

| Header | Description |
|--------|-------------|
| `x-account-id` | MemoryAccount object ID hint — speeds up account resolution when not cached |
| `x-mydata-session` | Preferred MYDATA SessionKey export (base64 JSON) |
| `x-platform-id` | Platform scope for registered social actions |

Raw `x-delegate-key` and `x-owner-delegate-key` headers are rejected by default. Their emergency compatibility switches are local-development only.

### Signature Format

The signed message is: `{timestamp}.{method}.{path}.{body_sha256}.{nonce}.{account_id}`

The relayer verifies the Ed25519 signature, derives `derived_address` from the public key, resolves the sub-agent via `SOCIAL_SERVER_URL` + `sub_agent_cache`, and on-chain verifies capabilities.

## Public Routes

### `GET /health`

Service health check. No authentication required.

**Response:**

```json
{
  "status": "ok",
  "version": "0.1.0"
}
```

### `POST /sponsor`

Compatibility-only arbitrary TransactionKind sponsorship. This route is absent unless `ALLOW_PUBLIC_GENERIC_SPONSOR=true`; keep it disabled for agent deployments.

### `POST /sponsor/execute`

Compatibility-only arbitrary sponsored transaction submission. This route is absent unless `ALLOW_PUBLIC_GENERIC_SPONSOR=true`.

## Protected Routes

### `POST /api/chain/actions/prepare`

Validate an exact registry action, capability, approval policy, platform scope, and idempotency key. The trusted gateway builds the transaction from the shared action registry, pins registry/package/parameter/byte hashes in PostgreSQL, sponsors it, and returns bytes for local signing. Arbitrary Move targets and PTBs are not accepted.

Approval-gated calls include `approvalId`. The approval must match the exact parameter hash and is atomically bound to the prepared action. Tier 3 and approval-gated actions use the current account owner as transaction sender.

### `POST /api/chain/approvals/request`

Authenticated agent endpoint that creates an idempotent, expiring owner approval intent bound to account, agent, registry action/version, parameters, capability, and platform.

### `POST /api/chain/approvals/{approvalId}/approve`

Accepts a serialized MySo wallet personal-message signature. The trusted sidecar verifies the intent signature, and the server rechecks the current on-chain account owner before recording approval.

### `POST /api/chain/actions/submit`

Submit a local signature for the matching prepared digest. Replays with the same identity are idempotent; conflicting metadata or a package-version change fails closed.

### `GET /api/chain/actions/{digest}`

Read finality directly from chain RPC. Indexed enrichment is separately labeled and optional.

### `POST /api/remember`

Store text as an encrypted memory. The relayer handles embedding, MYDATA encryption, File Storage upload, and vector indexing.

**Request:**

```json
{
  "text": "User prefers dark mode",
  "namespace": "demo"
}
```

`namespace` defaults to `"default"` if omitted.

**Response:**

```json
{
  "id": "uuid",
  "blob_id": "file-storage-blob-id",
  "owner": "0x...",
  "namespace": "demo"
}
```

### `POST /api/recall`

Search for memories matching a natural language query. Returns decrypted plaintext results.

**Request:**

```json
{
  "query": "What do we know about this user?",
  "limit": 10,
  "namespace": "demo"
}
```

`limit` defaults to `10`. `namespace` defaults to `"default"`.

**Response:**

```json
{
  "results": [
    {
      "blob_id": "file-storage-blob-id",
      "text": "User prefers dark mode",
      "distance": 0.15
    }
  ],
  "total": 1
}
```

### `POST /api/remember/manual`

Register a client-encrypted payload. The client sends MYDATA-encrypted data (base64) and a precomputed embedding vector. The relayer uploads the encrypted bytes to File Storage and stores the vector mapping.

**Request:**

```json
{
  "encrypted_data": "base64-encoded-mydata-encrypted-bytes",
  "vector": [0.01, -0.02, ...],
  "namespace": "demo"
}
```

**Response:**

```json
{
  "id": "uuid",
  "blob_id": "file-storage-blob-id",
  "owner": "0x...",
  "namespace": "demo"
}
```

### `POST /api/recall/manual`

Search with a precomputed query vector. Returns blob IDs and distances only — the client handles downloading and decrypting.

**Request:**

```json
{
  "vector": [0.01, -0.02, ...],
  "limit": 10,
  "namespace": "demo"
}
```

**Response:**

```json
{
  "results": [
    {
      "blob_id": "file-storage-blob-id",
      "distance": 0.15
    }
  ],
  "total": 1
}
```

### `POST /api/analyze`

Extract facts from text using an LLM, then store each fact as a separate memory (embed, encrypt, upload, index).

**Request:**

```json
{
  "text": "I live in Hanoi and prefer dark mode.",
  "namespace": "demo"
}
```

**Response:**

```json
{
  "facts": [
    {
      "text": "User lives in Hanoi",
      "id": "uuid",
      "blob_id": "file-storage-blob-id"
    },
    {
      "text": "User prefers dark mode",
      "id": "uuid",
      "blob_id": "file-storage-blob-id"
    }
  ],
  "total": 2,
  "owner": "0x..."
}
```

### `POST /api/ask`

Recall memories, inject them into an LLM prompt, and return an AI-generated answer with the context used.

**Request:**

```json
{
  "question": "What do you know about my preferences?",
  "limit": 5,
  "namespace": "demo"
}
```

`limit` defaults to `5`. `namespace` defaults to `"default"`.

**Response:**

```json
{
  "answer": "Based on your memories, you prefer dark mode and live in Hanoi.",
  "memories_used": 2,
  "memories": [
    {
      "blob_id": "file-storage-blob-id",
      "text": "User prefers dark mode",
      "distance": 0.12
    }
  ]
}
```

### `POST /api/restore`

Rebuild missing vector entries for one namespace. Queries onchain blobs by owner and namespace, downloads from File Storage, decrypts, re-embeds, and re-indexes only the entries missing from the local database.

**Request:**

```json
{
  "namespace": "demo",
  "limit": 50
}
```

`limit` defaults to `50`.

**Response:**

```json
{
  "restored": 3,
  "skipped": 7,
  "total": 10,
  "namespace": "demo",
  "owner": "0x..."
}
```
