---
title: "Changelog"
description: "Release history for the Memory OpenClaw plugin."
---

Track what's new, changed, and fixed in `@socialproof/oc-memory`.

For the latest version, see the [npm package page](https://www.npmjs.com/package/@socialproof/oc-memory).

## 0.0.2

### Internal

- Update `@socialproof/memory` dependency to `^0.0.2`

## 0.0.1

### Initial Release

- NemoClaw/OpenClaw memory plugin powered by Memory
- Automatic memory recall via `before_prompt_build` hook
- Automatic fact capture via `agent_end` hook
- Session summary on `before_reset` hook
- CLI commands: `openclaw memory stats`, `openclaw memory search`
- LLM tools: `memory_search`, `memory_store`
