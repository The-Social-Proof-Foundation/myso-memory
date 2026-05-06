---
title: "Memory"
description: "The recommended default client — relayer handles embeddings, MYDATA, and storage."
---

The recommended default client. The relayer handles embeddings, MYDATA encryption, File Storage upload, and vector indexing.

## How It Works

1. The SDK signs each request with your delegate key
2. The relayer verifies delegate access
3. `remember` encrypts via MYDATA, uploads to File Storage, and indexes the vector embedding
4. `recall` searches by Memory Space and returns decrypted matches

```ts
import { Memory } from "@socialproof/memory";

const memory = Memory.create({
  key: "<your-ed25519-private-key>",
  accountId: "<your-memory-account-id>",
  serverUrl: "https://your-relayer-url.com",
  namespace: "chatbot-prod",
});
```

## Core Methods

```ts
// Store a memory
await memory.remember("User prefers dark mode and works in TypeScript.");

// Recall relevant memories
const result = await memory.recall("What do we know about this user?", 5);

// Extract and store facts from longer text
const analyzed = await memory.analyze(
  "I live in Hanoi, prefer dark mode, and usually work late at night."
);
console.log(analyzed.facts);

// Check relayer health
await memory.health();
```

## Restore

Rebuild missing indexed entries for one namespace. Incremental, namespace-scoped, and meant to
repair PostgreSQL vector state from File Storage-backed memory.

```ts
const result = await memory.restore("chatbot-prod", 50);
```

## Lower-Level Methods

Use these when you already have a vector or encrypted payload:

- `rememberManual({ blobId, vector, namespace? })`
- `recallManual({ vector, limit?, namespace? })`
- `embed(text)`
