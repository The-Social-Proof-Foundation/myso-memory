---
title: "Versioning and Compatibility"
---

The Memory relayer exposes a versioned API contract for SDKs, MCP clients, and self-hosted deployments.

## Relayer API Version

| Constant | Value |
| --- | --- |
| `RELAYER_API_VERSION` | `1.1.1` |
| `MIN_TYPESCRIPT_SDK_VERSION` | `0.6.0` |
| `MIN_MCP_PACKAGE_VERSION` | `0.1.0` |

## Runtime Metadata

Modern relayers expose compatibility metadata at `GET /version`:

```json
{
  "relayerVersion": "0.1.0",
  "apiVersion": "1.1.1",
  "minSupportedSdk": {
    "typescript": "0.6.0",
    "mcp": "0.1.0"
  },
  "featureFlags": {
    "remember.asyncJobs": true,
    "remember.bulk": true,
    "recall.compositeRanker": true,
    "runtime.versionEndpoint": true,
    "social.subAgentActions": true,
    "subAgent.v1PolicyHardening": true
  },
  "deprecations": [
    {
      "surface": "request.namespace-as-primary",
      "deprecatedSince": "1.0.0",
      "removalApiVersion": "2.0.0",
      "guidance": "Use agent_object_id from sub-agent auth; optional sub_label replaces namespace."
    },
    {
      "surface": "subAgent.approvalRequiredCaps",
      "deprecatedSince": "1.1.1",
      "removalApiVersion": "2.0.0",
      "guidance": "Relayer does not enforce approval_required_caps in v1; use 0 for autonomous agents."
    },
    {
      "surface": "subAgent.maxActionSpend",
      "deprecatedSince": "1.1.1",
      "removalApiVersion": "2.0.0",
      "guidance": "Relayer does not enforce max_action_spend in v1; reserved for v2 spend policy."
    },
    {
      "surface": "social.ownerCoSignForCreates",
      "deprecatedSince": "1.1.1",
      "removalApiVersion": "2.0.0",
      "guidance": "Owner HTTP co-sign applies to social delete routes only, not creates."
    }
  ]
}
```

## SDK Compatibility

The TypeScript SDK reports `MEMORY_TYPESCRIPT_COMPATIBILITY_VERSION` (`0.6.0`) on each request via `x-sdk-compatibility`. Relayers may reject older SDKs with HTTP 426.

Major API version must match: SDK supports relayer API `1.x` only.

## Sub-agent v1 hardening (1.1.1)

API `1.1.1` documents honest v1 sub-agent behavior:

- Relayer policy no longer enforces `approval_required_caps` or `max_action_spend`
- Owner HTTP co-sign is delete-only for social actions
- See [sub-agent-v1.md](../contract/sub-agent-v1.md) for the canonical contract

## CI contract check

`scripts/check-compatibility-contract.mjs` verifies Rust constants, SDK baseline, and this document stay aligned.
