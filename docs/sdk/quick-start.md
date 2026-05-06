---
title: "Quick Start"
description: "Install the Memory SDK and store your first memory in under a minute."
---

The Memory SDK gives your app persistent, encrypted memory — store, recall, and analyze context across sessions. It exposes three entry points:

| Entry point | Import | When to use |
| --- | --- | --- |
| `Memory` | `@socialproof/memory` | **Recommended default** for most integrations — relayer handles embeddings, MYDATA, and storage |
| `MemoryManual` | `@socialproof/memory/manual` | You need client-managed embeddings and local MYDATA operations |
| `withMemory` | `@socialproof/memory/ai` | You already use the Vercel AI SDK and want memory as middleware |

## Installation

<CodeGroup>

```bash npm
npm install @socialproof/memory
```

```bash pnpm
pnpm add @socialproof/memory
```

```bash yarn
yarn add @socialproof/memory
```

</CodeGroup>

For `MemoryManual`, you also need the optional peer dependencies:

<CodeGroup>

```bash npm
npm install @socialproof/myso @socialproof/mydata @socialproof/file-storage
```

```bash pnpm
pnpm add @socialproof/myso @socialproof/mydata @socialproof/file-storage
```

```bash yarn
yarn add @socialproof/myso @socialproof/mydata @socialproof/file-storage
```

</CodeGroup>

For `withMemory`, you also need:

<CodeGroup>

```bash npm
npm install ai zod
```

```bash pnpm
pnpm add ai zod
```

```bash yarn
yarn add ai zod
```

</CodeGroup>

## Configuration

Before wiring the SDK into your app:

- These hosted endpoints are provided by File Storage Foundation.
- Generate a Memory account ID and delegate private key for your client using the hosted endpoint:
  - Production (mainnet): `https://mysocial.network` or `https://memory.wal.app`
  - Staging (testnet): `https://testnet.mysocial.network`
- Choose a relayer:
  - Use the hosted relayer at `https://memory.mysocial.network` (mainnet) or `https://relayer.testnet.mysocial.network` (testnet)
  - Or deploy your own relayer with access to a wallet funded with WAL and MYSO

`Memory.create` takes a config object with the following fields:

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `key` | `string` | Yes | Ed25519 private key in hex |
| `accountId` | `string` | Yes | MemoryAccount object ID on MySo |
| `serverUrl` | `string` | No | Relayer URL — use `https://memory.mysocial.network` (mainnet) or `https://relayer.testnet.mysocial.network` (testnet) for the [managed relayer](/relayer/public-relayer) |
| `namespace` | `string` | No | Default namespace — falls back to `"default"` |

## First Memory

```ts
import { Memory } from "@socialproof/memory";

const memory = Memory.create({
  key: "<your-ed25519-private-key>",
  accountId: "<your-memory-account-id>",
  serverUrl: "https://your-relayer-url.com",
  namespace: "demo",
});

await memory.health();
await memory.remember("I live in Hanoi and prefer dark mode.");

const result = await memory.recall("What do we know about this user?");
console.log(result.results);
```

## Next Steps

- [Usage](/sdk/usage) — all three clients in detail, namespace rules, and restore
- [API Reference](/sdk/api-reference) — full method signatures and config fields
