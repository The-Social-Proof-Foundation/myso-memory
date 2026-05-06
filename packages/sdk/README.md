# @socialproof/memory

Privacy-first AI memory SDK for storing encrypted memories on File Storage and retrieving them with semantic search.

> Memory is currently in beta and actively evolving. While fully usable today, we continue to refine the developer experience and operational guidance. We welcome feedback from early builders as we continue to improve the product.

## Documentation

For full documentation, visit [docs.mysocial.network](https://docs.mysocial.network).

## Install

```bash
pnpm add @socialproof/memory
```

Peer dependencies (install as needed):

```bash
pnpm add @socialproof/myso @socialproof/mydata @socialproof/file-storage ai zod
```

## Quick Start

```ts
import { Memory } from "@socialproof/memory";

const memory = Memory.create({
  key: "your-delegate-key-hex",
  accountId: "your-memory-account-id",
  serverUrl: "https://your-relayer-url.com",
  namespace: "demo",
});

await memory.remember("User prefers dark mode and uses TypeScript.");
const memories = await memory.recall("What are the user's preferences?");
await memory.restore("demo");
```

If you are self-hosting the relayer and do not have an account ID yet, see [Self-Hosting](../../docs/relayer/self-hosting.md) for the account creation and delegate key setup flow.

## Exports

| Entry | Description |
|---|---|
| `@socialproof/memory` | Default client (`Memory`). The relayer handles embedding, encryption, File Storage upload/download, retrieval, and restore. |
| `@socialproof/memory/manual` | Manual client flow (`MemoryManual`). You handle embedding calls and local MYDATA operations. The relayer still handles upload relay, registration, search, and restore. |
| `@socialproof/memory/ai` | Vercel AI SDK integration - wraps `Memory` as middleware for use with `streamText`, `generateText`, etc. |

## How It Works

1. **Scope** - Each memory operation runs inside an `owner + namespace` boundary
2. **Store** - The relayer embeds, encrypts, uploads to File Storage, and stores vector metadata in PostgreSQL
3. **Recall** - The relayer searches by owner plus namespace, resolves matching blobs, and returns plaintext results
4. **Restore** - The relayer can incrementally rebuild missing indexed entries for one namespace

## License

Apache 2.0 — see [LICENSE](../../LICENSE)
