---
title: "Usage"
description: "Detailed usage for all three Memory clients — Memory, MemoryManual, and withMemory."
---

Memory exposes three entry points:

| Entry point | Import | When to use |
| --- | --- | --- |
| `Memory` | `@socialproof/memory` | **Recommended default** — relayer handles embeddings, MYDATA, and storage |
| `MemoryManual` | `@socialproof/memory/manual` | You need client-managed embeddings and local MYDATA operations |
| `withMemory` | `@socialproof/memory/ai` | You already use the Vercel AI SDK and want memory as middleware |

## Namespace Rules

- Set a default namespace in `create(...)` when one app or agent uses one boundary
- Pass `namespace` per call when one client needs multiple boundaries
- If omitted, namespace falls back to client config, then to `"default"`

Good namespace examples: `todo`, `personal`, `password`, `project-x`. Avoid keeping everything in `"default"` after early testing.
