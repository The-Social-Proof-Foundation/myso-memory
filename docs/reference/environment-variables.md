---
title: "Environment Variables"
---

Use this page when you run your own relayer.
For setup steps and deployment context, see [Self-Hosting](/relayer/self-hosting).

## Required

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. `pgvector` must already exist |
| `MEMORY_PACKAGE_ID` | MySo package ID. See [Contract Overview](/contract/overview) |
| `MEMORY_REGISTRY_ID` | Onchain registry object ID. See [Contract Overview](/contract/overview) |
| `SOCIAL_MEMORY_REGISTRY_ID` | Optional deployed `social_contracts::memory::MemoryRegistry` object ID exposed to MySo Agents owner-wallet migration; this is separate from the relayer's `MEMORY_REGISTRY_ID`. |
| `MYDATA_KEY_SERVERS` | Comma-separated MYDATA key server object IDs used by the sidecar for encrypt and decrypt |
| `MEMORY_CONFIG_ID` | Shared `memory::MemoryConfig` object required by MYDATA key-policy approval; auto-discovered on localnet |

## Usually Required

These are not all enforced at boot, but most real deployments need them.

| Variable | Notes |
| --- | --- |
| `SERVER_MYSO_PRIVATE_KEY` | Primary server key used for backend MYDATA decrypt |
| `OPENAI_API_KEY` | Server-side key used to call the embedding and fact-extraction provider |

## Optional

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `8000` | Relayer port |
| `SIDECAR_URL` | `http://localhost:9000` | Sidecar HTTP endpoint |
| `OPENAI_API_BASE` | `https://api.openai.com/v1` | OpenAI-compatible base URL |
| `OPENROUTER_API_BASE` | `https://openrouter.ai/api/v1` | Public model discovery; local chat endpoint when `OPENROUTER_API_KEY` is set |
| `OPENROUTER_API_KEY` | unset | Routes local `/api/ask` chat to OpenRouter; embeddings retain the OpenAI configuration. Production AI-credit enforcement still uses the billing gateway |
| `MYSO_NETWORK` | `mainnet` | Picks the fallback RPC URL and network-driven service defaults |
| `MYSO_RPC_URL` | network default | Override the MySo fullnode URL |
| `SOCIAL_CHAIN_AUTO_DISCOVERY` | `true` on localnet | Discover missing IDs and replace fullnode-proven stale localnet IDs after regenesis; remote explicit pins are never replaced |
| `SOCIAL_CHAIN_GRAPHQL_URL` | local GraphQL on localnet | GraphQL endpoint for startup discovery; non-local HTTP endpoints are rejected |
| `SOCIAL_SERVER_URL` | `http://127.0.0.1:9126` | Social API base URL for sub-agent lookup |
| `INTERNAL_SYNC_SECRET` | none | Optional shared secret for this deployment's private social-server dashboard snapshot (`/api/organizations/:id/control`). Not used for memory authorization: org membership and `OrgMemoryReader`/`OrgMemoryWriter` grants are verified directly on chain through `MYSO_RPC_URL` |
| `USERNAME_REGISTRY_ID` | none | Username registry used by registered social actions |
| `SOCIAL_MEMORY_REGISTRY_ID` | none | Optional `social_contracts::memory::MemoryRegistry` object used by MySo Agents owner-wallet migration; distinct from the relayer's `MEMORY_REGISTRY_ID` |
| `PLATFORM_REGISTRY_ID` | none | Platform registry used by registered social actions |
| `PLATFORM_OBJECT_ID` | none | Platform object and default agent action scope |
| `BLOCK_LIST_REGISTRY_ID` | none | Block-list registry used by registered social actions |
| `POST_CONFIG_ID` | none | Post configuration object used by registered social actions |
| `MEMORY_CONFIG_ID` | none | Memory configuration object required by social actor resolution |
| `MYDATA_REGISTRY_ID` | none | MYDATA registry used by post access policy |
| `SOCIAL_GRAPH_ID` | none | Required for follow, unfollow, block, and unblock actions |
| `MESSAGING_PACKAGE_ID` | none | Messaging package used by encrypted-message digest actions |
| `MESSAGING_VERSION_ID` | none | Messaging version shared object |
| `MESSAGING_CONFIG_ID` | none | Messaging configuration shared object |
| `MESSAGING_NAMESPACE_ID` | none | Required for agent-created messaging groups |
| `MESSAGING_GROUP_MANAGER_ID` | none | Messaging group-manager shared object |
| `MESSAGING_GROUP_LEAVER_ID` | none | Messaging group-leaver shared object |
| `LOCAL_SPONSOR_ENABLED` | `false` | Localnet-only gas sponsorship using `SERVER_MYSO_PRIVATE_KEYS`; agent/owner signatures remain required |
| `LOCAL_SPONSOR_GAS_BUDGET` | `100000000` | Gas budget used by the localnet sponsor |
| `AI_CREDIT_ENABLED` | `false` | Route production LLM inference through exact-MIST reservation and capture |
| `AI_CREDIT_ORACLE_URL` | `http://127.0.0.1:8095` | Private AI inference gateway URL |
| `AI_CREDIT_ORACLE_API_SECRET` | none | Required shared secret whenever `AI_CREDIT_ENABLED=true` |
| `DEFAULT_LLM_MODEL` | `openai/gpt-4o-mini` | Default bounded inference model sent to the AI gateway |
| `ALLOW_LEGACY_SOCIAL_KEY_FORWARDING` | `false` | Emergency local-only compatibility switch; never enable in production |
| `ALLOW_LEGACY_DELEGATE_KEY_FORWARDING` | `false` | Emergency local-only MYDATA key transport switch; use SessionKey instead |
| `ALLOW_PUBLIC_GENERIC_SPONSOR` | `false` | Compatibility-only arbitrary TransactionKind sponsorship; keep disabled for agent deployments |
| `R2_BUCKET`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | none | Required for private memory and task-artifact writes, reads, and restore through Cloudflare R2. The key needs object read/write/list access to the configured private bucket. |
| `MEMORY_BLOB_BACKEND` | `r2` | Cloudflare R2 is the only supported memory blob backend. Any other configured backend is rejected. |
| `SERVER_MYSO_PRIVATE_KEYS` | none | Optional localnet sponsor key pool; not used for R2 storage |
| `MEMORY_ACCOUNT_ID` | none | Optional default MemoryAccount ID in server config |
| `ENOKI_API_KEY` | none | Optional Enoki key for sponsored sidecar transactions |
| `ENOKI_NETWORK` | `mainnet` | Network used for Enoki-sponsored flows |
| `ENABLE_AGENT_KEY_BACKUPS` | `false` | Enable client-side encrypted agent-key backups and their routes. Must be exactly `true` to enable |
| `AGENT_KEY_CUSTODY_TIERS` | `passkey-prf-v1,zklogin-root-v1,recovery-code-v1` | Custody methods the server accepts for root wraps. `AGENT_KEY_CUSTODY_TIERS=passkey-prf-v1` reproduces the passkey-only posture |
| `AGENT_KEY_REQUIRE_TIER` | none | Optional minimum custody tier; a weaker unlock is refused with `custody_tier_required` |
| `AGENT_KEY_UNLOCK_PER_MINUTE` | `10` | Per-account custody attempts per minute, enforced in Redis (`custody_rate_limited`). The counter increments once per challenge and once more per custody-purpose verify, so 10 is roughly three or four unlocks per minute |
| `PASSKEY_RP_ID` | none | WebAuthn RP ID; required only when the `passkey-prf-v1` tier is enabled |
| `PASSKEY_ALLOWED_ORIGINS` | none | Exact HTTPS origins for passkey ceremonies; required only when the `passkey-prf-v1` tier is enabled |
| `KEY_BACKUP_SERVICE_ORIGIN` | none | Exact origin bound into owner challenges; required when backups are enabled |
| `SIDECAR_AUTH_TOKEN` | none | Shared secret authenticating private verification calls to the sidecar |

## Notes

- Encrypted memory and task artifacts are written to and read from the private Cloudflare R2 bucket. The restore route enumerates R2 objects carrying authenticated owner/agent metadata and rebuilds the PostgreSQL vector index from their ciphertext. Legacy File Storage blob IDs are not readable by this R2-only service.
- `OPENAI_API_KEY` and `OPENAI_API_BASE` control the embedding and fact-extraction provider used by `remember`, `recall`, `analyze`, `ask`, and restore re-indexing.
- Without `OPENAI_API_KEY`, the server can fall back to mock embeddings. That is useful for local testing, not for normal production behavior.
- `MYSO_NETWORK` drives the default RPC and MYDATA network selection.
- `MEMORY_PACKAGE_ID` and `MEMORY_REGISTRY_ID` are server env vars. Do not replace them with `VITE_*` app env vars.
- Social tools are discoverable only when every social-chain object ID is configured. The authenticated context remains authoritative; client-side pins must match it.
- With `AI_CREDIT_ENABLED=true`, startup fails unless `AI_CREDIT_ORACLE_API_SECRET` is non-empty. The oracle must independently enable inference and require the same secret.
- OpenAI-compatible `/v1/{chat/completions,responses,models}` for OpenClaw / Hermes is served by the **AI credit oracle** (`AI_CREDIT_ORACLE_URL`), not this Memory relayer. See [AI Credit Provider](/openclaw/ai-credit-provider).
- Raw `x-delegate-key` and `x-owner-delegate-key` headers are rejected unless an explicit local-only legacy switch is enabled.
- Public `/sponsor` and `/sponsor/execute` are absent by default. Agents use authenticated registry-only `/api/chain/actions/prepare` and `/api/chain/actions/submit` instead.
- For network-specific `MEMORY_PACKAGE_ID` and `MEMORY_REGISTRY_ID` values, see [Contract Overview](/contract/overview).
