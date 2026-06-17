# Memory Contract Overview

The Memory smart contract lives in `social_contracts::memory` (package `myso-social`). Each human owner has a **MemoryAccount** linked from their **Profile**. Agents access memory through **SubAgents** — shared on-chain objects keyed by `derived_address`.

## Core objects

| Object | Role |
|--------|------|
| **MemoryRegistry** | Global registry of MemoryAccounts (creation + lookup) |
| **MemoryAccount** | One per profile owner; holds an auth mirror of registered sub-agents |
| **SubAgent** | Shared object per agent; stores public key, capabilities, hierarchy, expiry, `active` |

## Signers

Sub-agents sign transactions and MYDATA SessionKeys as their **`derived_address`**:

```
derived_address = Blake2b-256(0x00 || ed25519_public_key_32_bytes)
```

This matches `Ed25519PublicKey.toMySoAddress()` in the MySo SDK.

## Capabilities

Memory access is gated by capability bits on each SubAgent:

| Bit | Constant | Meaning |
|-----|----------|---------|
| 1 | `CAP_MEMORY_READ` | Recall, search, decrypt |
| 2 | `CAP_MEMORY_WRITE` | Remember, analyze, restore |

The relayer checks the required capability for each route after resolving the sub-agent via the social API and on-chain verification.

## MYDATA

`approve_key_policy(id, account, clock, ctx)` authorizes MYDATA key release for the owner or an active sub-agent with `CAP_MEMORY_READ`. The **Clock** shared object (`0x6`) is required so expiry checks are deterministic.

## Account creation

MemoryAccounts are created through the profile flow (`memory::create_account_for_profile`), not a standalone `::account::` module. Legacy profiles can backfill via `profile::ensure_memory_account`.

## Events

| Event | When |
|-------|------|
| `MemoryAccountCreated` | New account linked to a profile |
| `SubAgentRegistered` | Sub-agent registered |
| `SubAgentUpdated` | Label or metadata updated |
| `SubAgentDeactivated` | Sub-agent deactivated (reversible) |
| `SubAgentRevoked` | Sub-agent permanently removed |
| `SubAgentsClearedOnTransfer` | All agents revoked on profile transfer |

See [Sub-Agent Registration](/contract/delegate-key-management) for SDK setup and [Social Indexer](/indexer/purpose) for how account/sub-agent state is indexed.
