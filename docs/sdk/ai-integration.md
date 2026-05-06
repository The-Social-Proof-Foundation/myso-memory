---
title: "@ai-sdk Integration"
---

Memory includes an AI SDK integration for applications that already use model middleware.

## `withMemory`

```ts
import { generateText } from "ai";
import { withMemory } from "@socialproof/memory/ai";
import { openai } from "@ai-sdk/openai";

const model = withMemory(openai("gpt-4o"), {
  key: process.env.MEMORY_PRIVATE_KEY!,
  accountId: process.env.MEMORY_ACCOUNT_ID!,
  serverUrl: process.env.MEMORY_SERVER_URL,
  namespace: "chatbot-prod",
  maxMemories: 5,
  autoSave: true,
});

const result = await generateText({
  model,
  messages: [{ role: "user", content: "What do you know about me?" }],
});
```

## What It Does

Before generation:

- reads the last user message
- runs `recall()` against Memory
- filters by relevance
- injects memory context into the prompt

After generation:

- optionally runs `analyze()` on the user message
- saves extracted facts asynchronously

## Why Namespace Matters Here

Set a namespace explicitly for each product surface that uses the middleware. Otherwise recalled
and auto-saved memories fall back to `"default"`.

## When To Use Direct SDK Calls Instead

Use direct SDK methods when your app needs precise control over:

- when memory is stored
- which text is analyzed
- how recall results are displayed or filtered
