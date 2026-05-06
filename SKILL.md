---
name: memory
version: 0.0.1
description: |
  Privacy-first AI memory SDK for decentralized storage on MySo blockchain with File Storage.

  Use when users say:
  - "add memory to my app"
  - "store encrypted memories"
  - "integrate Memory"
  - "AI agent memory"
  - "persistent memory SDK"
  - "File Storage memory storage"
  - "setup Memory"
  - "recall memories"

keywords:
  - memory
  - memory sdk
  - ai memory
  - encrypted memory
  - file storage storage
  - myso blockchain
  - delegate key
  - semantic search
  - vercel ai sdk
---

# Memory — Privacy-First AI Memory SDK

Memory is a TypeScript SDK for persistent, encrypted AI memory. It stores memories on File Storage (decentralized storage), encrypts them with MYDATA, enforces ownership onchain via MySo smart contracts, and retrieves them with semantic (vector) search. Memories are scoped by `owner + namespace` — each namespace is an isolated memory space.

---

## When to Use

Use Memory when your app or agent needs:

- **Persistent memory** across sessions, devices, or restarts
- **Encrypted storage** — end-to-end encryption, only the owner and authorized delegates can decrypt
- **Semantic recall** — retrieve memories by meaning, not just keywords
- **Decentralized storage** — no single point of failure, stored on File Storage
- **Onchain ownership** — cryptographically enforced access control on MySo
- **Cross-app memory** — share memory between apps via delegate keys

---

## When NOT to Use

- Temporary conversation context that only matters in the current session
- Large file storage (Memory is optimized for text memories)
- Use cases that don't need encryption or decentralization

---

## Installation

```bash
# Install the SDK
pnpm add @socialproof/memory

# Optional: for Vercel AI SDK integration
pnpm add ai zod

# Optional: for manual client (client-side MYDATA encryption)
pnpm add @socialproof/myso @socialproof/mydata @socialproof/file-storage
```

---

## Quick Start

### 1. Get Your Credentials

You need a **delegate key** (Ed25519 private key) and **account ID** (MemoryAccount object ID on MySo).

Generate them at:
- Production: https://mysocial.network or https://memory.wal.app
- Staging: https://testnet.mysocial.network

### 2. Initialize the SDK

```ts
import { Memory } from "@socialproof/memory";

const memory = Memory.create({
  key: "<your-ed25519-private-key-hex>",
  accountId: "<your-memory-account-id>",
  serverUrl: "https://memory.mysocial.network",
  namespace: "my-app",
});
```

### 3. Store and Recall Memories

```ts
// Store a memory
await memory.remember("User prefers dark mode and works in TypeScript.");

// Recall by meaning
const result = await memory.recall("What are the user's preferences?");
console.log(result.results);

// Extract and store facts from text
await memory.analyze("I live in Hanoi and prefer dark mode.");

// Check relayer health
await memory.health();
```

---

## SDK Entry Points

| Entry Point | Import | Description |
|---|---|---|
| `Memory` | `@socialproof/memory` | **Default.** Relayer handles embedding, MYDATA encryption, File Storage upload, vector search |
| `MemoryManual` | `@socialproof/memory/manual` | Manual flow — client handles embedding and MYDATA encryption |
| `withMemory` | `@socialproof/memory/ai` | Vercel AI SDK middleware — auto recall + save around AI conversations |
| Account utils | `@socialproof/memory/account` | Account creation, delegate key management |

---

## API Surface

### Memory Methods

| Method | Description | Returns |
|---|---|---|
| `remember(text, namespace?)` | Store one memory (relayer embeds, encrypts, uploads) | `{ id, blob_id, owner, namespace }` |
| `recall(query, limit?, namespace?)` | Semantic search for memories | `{ results: [{ blob_id, text, distance }], total }` |
| `analyze(text, namespace?)` | Extract facts via LLM, store each as a memory | `{ facts: [{ text, id, blob_id }], total, owner }` |
| `restore(namespace, limit?)` | Rebuild missing index entries from File Storage | `{ restored, skipped, total, namespace, owner }` |
| `health()` | Check relayer health | `{ status, version }` |
| `getPublicKeyHex()` | Get hex-encoded public key | `string` |

### Lower-Level Methods

| Method | Description |
|---|---|
| `rememberManual({ blobId, vector, namespace? })` | Register pre-uploaded blob with pre-computed vector |
| `recallManual({ vector, limit?, namespace? })` | Search with pre-computed vector (returns blob IDs only) |
| `embed(text)` | Generate embedding vector (no storage) |

---

## Configuration

### MemoryConfig

| Field | Type | Required | Default | Description |
|---|---|---|---|---|d
| `key` | `string` | Yes | — | Ed25519 delegate private key in hex |
| `accountId` | `string` | Yes | — | MemoryAccount object ID on MySo |
| `serverUrl` | `string` | No | `http://localhost:8000` | Relayer URL |
| `namespace` | `string` | No | `"default"` | Default namespace for memory isolation |

### Managed Relayer Endpoints

| Network | Relayer URL |
|---|---|
| **Production** (mainnet) | `https://memory.mysocial.network` |
| **Staging** (testnet) | `https://relayer.testnet.mysocial.network` |

---

## Vercel AI SDK Integration

```ts
import { openai } from "@ai-sdk/openai";
import { streamText } from "ai";
import { withMemory } from "@socialproof/memory/ai";

const model = withMemory(openai("gpt-4o"), {
  key: "<your-delegate-key>",
  accountId: "<your-account-id>",
  serverUrl: "https://memory.mysocial.network",
  namespace: "chat",
  maxMemories: 5,
  autoSave: true,
  minRelevance: 0.3,
});

const result = streamText({
  model,
  messages: [{ role: "user", content: "What do you remember about me?" }],
});
```

The middleware automatically:
- Recalls relevant memories before generation
- Extracts and saves facts from conversations after generation

---

## OpenClaw / NemoClaw Plugin

For OpenClaw agent integration, use the `@socialproof/oc-memory` plugin.

### Install

```bash
openclaw plugins install @socialproof/oc-memory
```

### Configure

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "slots": { "memory": "oc-memory" },
    "entries": {
      "oc-memory": {
        "enabled": true,
        "config": {
          "privateKey": "${MEMORY_PRIVATE_KEY}",
          "accountId": "0x...",
          "serverUrl": "https://memory.mysocial.network"
        }
      }
    }
  }
}
```

Lifecycle hooks run automatically:
- `before_prompt_build` — injects relevant memories as context
- `before_reset` — saves session summary
- `agent_end` — captures last response

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `health()` returns error | Check relayer URL is correct and reachable |
| `recall()` returns empty | Verify namespace matches what was used in `remember()` |
| `401 Unauthorized` | Verify delegate key is correct and registered on the account |
| SDK import errors | Run `pnpm add @socialproof/memory` — check Node.js ≥ 18 |
| Manual client errors | Install peer deps: `@socialproof/myso @socialproof/mydata @socialproof/file-storage` |

---

## Links

- **Docs**: https://docs.mysocial.network
- **SDK on npm**: https://www.npmjs.com/package/@socialproof/memory
- **GitHub**: https://github.com/CommandOSSLabs/Memory
- **Dashboard**: https://mysocial.network
- **llms.txt**: https://docs.mysocial.network/llms.txt
