---
title: "Ownership and Permissions"
---

## Owner

The owner is the MySo wallet address that created the `MemoryAccount`. The owner has full control:

- Add and remove delegate keys
- Deactivate (freeze) and reactivate the account
- Decrypt any memory encrypted under their address via MYDATA

Each MySo address can only create **one** MemoryAccount (enforced by the `MemoryRegistry`).

## Delegate

A delegate key authenticates API calls through the relayer. Delegates can:

- Store memories (`remember`, `analyze`)
- Recall memories (`recall`)
- Restore namespaces (`restore`)
- Decrypt MYDATA-encrypted content (via `approve_key_policy`)

Delegates **cannot**:

- Add or remove other delegate keys
- Deactivate or reactivate the account
- Transfer ownership

## MYDATA Access Control

The contract's `approve_key_policy` function is the MYDATA policy that controls who can decrypt memories. Access is granted if the caller is:

1. **The data owner** — the key ID ends with the BCS-encoded owner address and the caller is the account owner
2. **A registered delegate** — the caller's MySo address is in the account's `delegate_keys` list

The account must also be **active** (not frozen). If the account is deactivated, all MYDATA access is denied.

## Permission Boundary

These are separate layers that work together:

| Layer | Controls | Enforced by |
|-------|----------|-------------|
| **Owner** | Account control — keys, activation, ownership | MySo smart contract |
| **Delegate** | Application access — read/write memory | MySo smart contract + relayer verification |
| **Relayer** | Backend execution — encryption, storage, search | Server-side auth middleware |

The relayer verifies every request against the onchain contract before executing any operation. Even if the relayer is compromised, it cannot forge delegate permissions or change ownership — those are cryptographically enforced onchain.
