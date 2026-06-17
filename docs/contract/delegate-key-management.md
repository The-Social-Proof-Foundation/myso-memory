# Sub-Agent Registration

Sub-agents replace the legacy delegate-key model. Each sub-agent is an on-chain object with explicit capabilities, registered against a profile-linked **MemoryAccount**.

## Why sub-agents?

- **Capability-gated access** — read vs write is enforced on-chain and by the relayer
- **Social index** — the social server resolves `derived_address → account + agent` without chain scans
- **MYDATA signing** — SessionKeys must use the sub-agent's `derived_address` as signer address

## Quick start

### 1. Generate a sub-agent keypair

```typescript
import { generateSubAgentKey, registerSubAgent } from "@socialproof/memory/account";

const agent = await generateSubAgentKey();
// agent.privateKey — store securely
// agent.publicKey — 32-byte Ed25519 public key
// agent.derivedAddress — on-chain signer address (0x...)
```

### 2. Register on-chain (owner wallet)

Only the MemoryAccount owner can register root-level sub-agents:

```typescript
await registerSubAgent({
  packageId: "0x...",
  accountId: "0x...", // MemoryAccount object ID
  publicKey: agent.publicKey,
  label: "Production Server",
  walletSigner,
});
```

Defaults: `CLASS_DELEGATED_AI`, `CAP_MEMORY_READ | CAP_MEMORY_WRITE`, `REGISTER_SCOPE_BOTH`.

### 3. Use with the SDK

```typescript
import { Memory } from "@socialproof/memory";

const memory = Memory.create({
  key: agent.privateKey,
  accountId: "0x...",
});
```

### 4. Deactivate or revoke

```typescript
import { deactivateSubAgent, revokeSubAgent } from "@socialproof/memory/account";

await deactivateSubAgent({ packageId, accountId, agentObjectId, walletSigner });
await revokeSubAgent({ packageId, accountId, agentObjectId, walletSigner });
```

## Capability constants

| Export | Value | Use |
|--------|-------|-----|
| `CAP_MEMORY_READ` | 1 | Recall / decrypt |
| `CAP_MEMORY_WRITE` | 2 | Remember / analyze / restore |

## Limits

- Sub-agent public keys must be valid 32-byte Ed25519 keys
- Labels are bounded by the contract (`MAX_LABEL_LENGTH`)
- Expired or deactivated sub-agents cannot authenticate

## Profile backfill

If a profile predates Memory integration:

```typescript
import { ensureMemoryAccount } from "@socialproof/memory/account";

await ensureMemoryAccount({
  packageId: "0x...",
  registryId: "0x...",
  profileId: "0x...",
  walletSigner,
});
```

## Relayer auth

The relayer resolves sub-agents in this order:

1. PostgreSQL `sub_agent_cache` (TTL + on-chain re-verify)
2. Social API `GET /sub-agents/{derivedAddress}`
3. On-chain SubAgent + MemoryAccount verification (capabilities, active, expiry)

Set `SOCIAL_SERVER_URL` (default `http://127.0.0.1:9126`) on the memory server.

## v1 policy defaults

At registration, prefer:

- `approvalRequiredCaps: 0` — relayer does not enforce this field in v1, but on-chain social Move still aborts if social caps require approval
- `maxActionSpend: null` — relayer does not enforce spend caps in v1

See [sub-agent-v1.md](./sub-agent-v1.md) for the full v1 contract.
