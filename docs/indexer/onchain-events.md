---
title: "Onchain Events"
---

The indexer listens to MySo events emitted by the Memory contract and uses them to update local backend state.

## Events

The Memory contract emits the following events:

| Event | Emitted when | Fields |
|-------|-------------|--------|
| `MemoryAccountMigrated` | A new account is created | `account_id`, `owner` |
| `MemoryDelegateKeyAdded` | A delegate key is added | `account_id`, `public_key`, `derived_address`, `label` |
| `MemoryDelegateKeyRemoved` | A delegate key is removed | `account_id`, `public_key` |
| `MemoryAccountDeactivated` | An account is frozen | `account_id`, `owner` |
| `MemoryAccountReactivated` | A frozen account is unfrozen | `account_id`, `owner` |

## Current Coverage

The indexer currently targets the `MemoryAccountMigrated` event flow as its primary sync path. Delegate key events and account activation events are part of the broader design and may be indexed in future iterations.
