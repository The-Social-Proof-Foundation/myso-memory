---
title: "Managed Relayer"
---

A managed relayer is a simpler experience for teams that want to get started without running infrastructure. If a managed relayer endpoint is available for your environment, it gives you the fastest path to integration.

## File Storage Foundation hosted endpoints

| Network | Relayer URL |
|---|---|
| **Production** (mainnet) | `https://memory.mysocial.network` |
| **Staging** (testnet) | `https://relayer.testnet.mysocial.network` |

## Minimal Config

```ts
import { Memory } from "@socialproof/memory";

const memory = Memory.create({
  key: "<your-ed25519-private-key>",
  accountId: "<your-memory-account-id>",
  serverUrl: "https://memory.mysocial.network",
  namespace: "demo",
});
```

## What to Know

- **Shared App ID** - all users of the managed relayer share the same Memory package ID. Your data is isolated by your own `owner + namespace` (Memory Space), but the underlying deployment is shared.
- **Trust assumption** - the relayer sees plaintext during encryption and embedding. By using the managed relayer, you're trusting the File Storage Foundation-hosted instance with that data. See [Trust & Security Model](/fundamentals/architecture/data-flow-security-model) for details.
- **Availability** - the managed relayer is a managed beta service. There are no SLA guarantees.
- **Storage costs** - the server wallet covers File Storage storage fees. Usage limits may apply during beta.

If you need full control over the trust boundary or your own dedicated instance, see [Self-Hosting](/relayer/self-hosting).
