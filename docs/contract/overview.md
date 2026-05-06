---
title: "Smart Contract Overview"
---

The smart contract (`social_contracts::memory`) defines the onchain account model for Memory. It is a Move module deployed on MySo.

## Network IDs

These are the onchain IDs for the current public Memory deployments:

### Staging (Testnet)

```env
MYSO_NETWORK=testnet
MEMORY_PACKAGE_ID=0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6
MEMORY_REGISTRY_ID=0xe80f2feec1c139616a86c9f71210152e2a7ca552b20841f2e192f99f75864437
```

### Production (Mainnet)

```env
MYSO_NETWORK=mainnet
MEMORY_PACKAGE_ID=0xcee7a6fd8de52ce645c38332bde23d4a30fd9426bc4681409733dd50958a24c6
MEMORY_REGISTRY_ID=0x0da982cefa26864ae834a8a0504b904233d49e20fcc17c373c8bed99c75a7edd
```

For relayer setup and environment variable usage, see [Self-Hosting](/relayer/self-hosting) and [Environment Variables](/reference/environment-variables).

## What It Manages

- **Ownership** — who owns a Memory account
- **Delegate keys** — which Ed25519 keys are authorized to act through the relayer
- **MYDATA access control** — who can decrypt encrypted memories via `approve_key_policy`
- **Account lifecycle** — activation and deactivation (freeze/unfreeze)

The contract does not store memory content — it only manages identity, permissions, and access control.

## Key Objects

### `MemoryRegistry`

A shared object created at module publish time. It tracks all MemoryAccount objects and prevents duplicate account creation (one account per MySo address).

### `MemoryAccount`

A shared object representing a single user's account. It stores:

| Field | Type | Description |
|-------|------|-------------|
| `owner` | `address` | The MySo wallet address that owns this account |
| `delegate_keys` | `vector<MemoryDelegateKey>` | List of authorized Ed25519 delegate keys |
| `created_at` | `u64` | Timestamp when the account was created (epoch ms) |
| `active` | `bool` | Whether the account is active (false = frozen) |

### `MemoryDelegateKey`

A struct stored inside `MemoryAccount.delegate_keys`:

| Field | Type | Description |
|-------|------|-------------|
| `public_key` | `vector<u8>` | Ed25519 public key (32 bytes) |
| `derived_address` | `address` | MySo address derived from this Ed25519 key |
| `label` | `String` | Human-readable label (e.g., "MacBook Pro") |
| `created_at` | `u64` | Timestamp when the key was added (epoch ms) |

## Limits

- **Maximum delegate keys per account**: 20

## Error Codes

| Code | Name | Description |
|------|------|-------------|
| 0 | `EDelegateKeyAlreadyExists` | Key already registered in this account |
| 1 | `EDelegateKeyNotFound` | Key not found when trying to remove |
| 2 | `ETooManyDelegateKeys` | Account has reached the 20-key limit |
| 3 | `EAccountAlreadyExists` | Address already has an account |
| 4 | `ENotOwner` | Caller is not the account owner |
| 5 | `EInvalidPublicKeyLength` | Public key is not exactly 32 bytes |
| 6 | `EMemoryAccountDeactivated` | Account is frozen — operation denied |
| 100 | `ENoAccess` | MYDATA access denied — caller is neither owner nor delegate |

## Entry Functions

| Function | Description |
|----------|-------------|
| `create_account(registry, clock)` | Create a new MemoryAccount (one per address) |
| `add_delegate_key(account, public_key, derived_address, label, clock)` | Add a delegate key (owner only) |
| `remove_delegate_key(account, public_key)` | Remove a delegate key (owner only) |
| `deactivate_account(account)` | Freeze the account — MYDATA access denied, keys locked (owner only) |
| `reactivate_account(account)` | Unfreeze the account (owner only) |
| `approve_key_policy(id, account)` | MYDATA policy — authorizes owner or delegate key holder to decrypt |

## View Functions

| Function | Description |
|----------|-------------|
| `is_delegate(account, public_key)` | Check if a public key is an authorized delegate |
| `is_delegate_address(account, addr)` | Check if a MySo address is an authorized delegate |
| `owner(account)` | Get the owner address |
| `delegate_count(account)` | Get the number of delegate keys |
| `has_account(registry, addr)` | Check if an address already has an account |
| `is_active(account)` | Check if the account is active |

## Events

| Event | Emitted when |
|-------|-------------|
| `MemoryAccountMigrated` | A new account is created |
| `MemoryDelegateKeyAdded` | A delegate key is added to an account |
| `MemoryDelegateKeyRemoved` | A delegate key is removed from an account |
| `MemoryAccountDeactivated` | An account is frozen |
| `MemoryAccountReactivated` | A frozen account is unfrozen |
