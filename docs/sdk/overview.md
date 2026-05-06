---
title: "Overview"
---

Memory exposes three SDK surfaces.

## `@socialproof/memory`

Use this first.

- relayer-backed
- best path for most teams
- main methods: `remember`, `recall`, `analyze`, `restore`, `health`

```ts
import { Memory } from "@socialproof/memory";
```

## `@socialproof/memory/manual`

Use this when the client must handle embeddings and local MYDATA operations.

- relayer still handles upload relay, registration, search, and restore

```ts
import { MemoryManual } from "@socialproof/memory/manual";
```

## `@socialproof/memory/ai`

Use this when you already use the AI SDK.

```ts
import { withMemory } from "@socialproof/memory/ai";
```

## Namespace

Both clients support a default namespace. If you omit it, it falls back to `"default"`.

## Recommended Path

1. Start with `Memory`
2. Set a namespace explicitly
3. Validate `remember`, `recall`, `analyze`, and `restore`
4. Move to `MemoryManual` only if you need client-managed embeddings and local MYDATA work
