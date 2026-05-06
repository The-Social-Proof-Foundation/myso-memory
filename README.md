# Memory

Privacy-first AI memory layer for storing encrypted memories on File Storage and
retrieving them with semantic search.

> Memory is currently in beta and actively evolving. While fully usable today, we continue to refine the developer experience and operational guidance. We welcome feedback from early builders as we continue to improve the product.

## For AI Agents

- **Single-file guide**: Read [`SKILL.md`](SKILL.md) for a complete integration reference (install, configure, API surface, troubleshooting)
- **LLM-friendly docs**: [`llms.txt`](https://docs.mysocial.network/llms.txt) — structured overview following the [llmstxt.org](https://llmstxt.org) standard
- **Full context**: [`llms-full.txt`](https://docs.mysocial.network/llms-full.txt) — expanded version with inlined page content

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

## Documentation

- Full docs at [docs.mysocial.network](https://docs.mysocial.network)
- Docs source of truth: `docs/`
- Docs site entry points:
  - [What is Memory?](docs/getting-started/what-is-memory.md)
  - [Quick Start](docs/getting-started/quick-start.md)
  - [SDK Quick Start](docs/sdk/quick-start.md)
  - [Relayer Overview](docs/relayer/overview.md)
  - [SDK API Reference](docs/sdk/api-reference.md)

## Contributing

We want to be explicit about this while Memory is in beta: feedback, bug reports, docs fixes,
examples, and implementation contributions are all welcome.

If you spot rough edges or missing guidance, please open an issue or send a PR.

## Run the Repo Locally

From the repository root:

```bash
pnpm install
```

> **Important**: Build the SDK first — apps depend on its compiled output.

```bash
pnpm build:sdk
```

Then start the surface you need:

```bash
pnpm dev:app
pnpm dev:noter
pnpm dev:chatbot
pnpm dev:researcher
```

For the full step-by-step setup guide, see:

- [Run the Repo Locally](docs/contributing/run-repo-locally.md)

## Exports

| Entry | Description |
|---|---|
| `@socialproof/memory` | Default client (`Memory`). The relayer handles embedding, encryption, File Storage upload/download, retrieval, and restore. |
| `@socialproof/memory/manual` | Manual client flow (`MemoryManual`). You handle embedding calls and local MYDATA operations. The relayer still handles upload relay, registration, search, and restore. |
| `@socialproof/memory/ai` | Vercel AI SDK integration - wraps `Memory` as middleware for use with `streamText`, `generateText`, etc. |

## OpenClaw / NemoClaw Plugin

[`@socialproof/oc-memory`](packages/openclaw-memory) — a memory plugin for [OpenClaw](https://openclaw.ai) agents. It gives OpenClaw persistent, encrypted memory via Memory with automatic recall and capture hooks.

```bash
openclaw plugins install @socialproof/oc-memory
```

- [Plugin Quick Start](docs/openclaw/quick-start.md)
- [How It Works](docs/openclaw/how-it-works.md)
- [Reference](docs/openclaw/reference.md)

## How It Works

1. **Scope** - Each memory operation runs inside an `owner + namespace` boundary
2. **Store** - The relayer embeds, encrypts, uploads to File Storage, and stores vector metadata in PostgreSQL
3. **Recall** - The relayer searches by owner plus namespace, resolves matching blobs, and returns plaintext results
4. **Restore** - The relayer can incrementally rebuild missing indexed entries for one namespace

## License

Apache 2.0 — see [LICENSE](LICENSE)
