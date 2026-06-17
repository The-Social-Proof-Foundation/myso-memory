# On-Chain Events

The social indexer (myso-core `myso-indexer-alt-social`, memory handler) processes events from `social_contracts::memory`.

## Sub-agent lifecycle

| Event | Meaning | Key fields |
|-------|---------|------------|
| `SubAgentRegistered` | New sub-agent | `account_id`, `agent_object_id`, `derived_address`, `capabilities` |
| `SubAgentUpdated` | Metadata change | `account_id`, `agent_object_id` |
| `SubAgentDeactivated` | Agent deactivated | `account_id`, `derived_address` |
| `SubAgentRevoked` | Agent removed | `account_id`, `derived_address` |
| `SubAgentsClearedOnTransfer` | Bulk revoke on profile transfer | `account_id`, `revoked_count` |

## Account lifecycle

| Event | Meaning |
|-------|---------|
| `MemoryAccountCreated` | Account linked to profile |
| Account active/deactive events | Account-level enable/disable |

## Social API

The social server exposes indexed sub-agents for relayer auth:

```
GET /sub-agents/:derivedAddress
→ { agent_object_id, derived_address, account_id, capabilities, active }
```

The memory relayer uses this endpoint before on-chain verification.

## Cache invalidation

The relayer's `sub_agent_cache` should be evicted when agents are deactivated, revoked, or accounts transfer. Today this uses TTL + on-chain re-verify; webhook or poll-based invalidation is planned for hardening.
