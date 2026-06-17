---
title: "Versioning and Compatibility"
---

The Memory relayer exposes a versioned API contract for SDKs, MCP clients, and self-hosted deployments.

## Relayer API Version

| Constant | Value |
| --- | --- |
| `RELAYER_API_VERSION` | `1.0.0` |
| `MIN_TYPESCRIPT_SDK_VERSION` | `0.6.0` |
| `MIN_MCP_PACKAGE_VERSION` | `0.1.0` |

## Runtime Metadata

Modern relayers expose compatibility metadata at `GET /version`:

```json
{
  "relayerVersion": "0.1.0",
  "apiVersion": "1.0.0",
  "minSupportedSdk": {
    "typescript": "0.6.0",
    "mcp": "0.1.0"
  },
  "featureFlags": {
    "remember.asyncJobs": true,
    "remember.bulk": true,
    "recall.compositeRanker": true,
    "runtime.versionEndpoint": true
  },
  "deprecations": [
    {
      "surface": "request.namespace-as-primary",
      "deprecatedSince": "1.0.0",
      "removalApiVersion": "2.0.0",
      "guidance": "Use agent_object_id from sub-agent auth; optional sub_label replaces namespace."
    }
  ]
}
```

## SDK Compatibility

TypeScript SDK `@socialproof/memory` sends `x-sdk-compatibility` on signed requests. Relayers reject unsupported baselines with **HTTP 426 Upgrade Required**.

Run `node scripts/check-compatibility-contract.mjs` in CI to keep server constants aligned with the SDK baseline.

## Async Remember (breaking in SDK 0.6.0)

`POST /api/remember` returns **202 Accepted** with `{ job_id, status }`. Poll `GET /api/remember/:job_id` or use SDK helpers:

- `rememberAndWait(text, subLabel?)`
- `waitForRememberJob(jobId, opts?)`
- `rememberBulk(texts)` + `waitForRememberBulk(jobIds)`

## Composite Ranker

Optional `scoring_weights` on `POST /api/recall` and `POST /api/ask`:

```json
{
  "semantic": 1.0,
  "recency": 0.3,
  "recency_half_life_days": 7.0,
  "importance": 0.2
}
```

Default (`semantic=1.0`, others `0`) preserves legacy cosine ordering.
