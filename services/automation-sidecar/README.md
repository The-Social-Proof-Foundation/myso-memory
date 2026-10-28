# Automation memory bridge

Signs memory relayer calls for the [automation engine](../automation) so scheduled and
event-triggered jobs can recall and remember without a person present.

The bridge is **non-custodial**. It never holds a user's agent key or wallet key. An unattended
job signs as a **delegate**: a sub-agent the account owner registers on-chain with memory-only
capabilities, a spending limit and an expiry, and can revoke at any time.

```
chat-app ──► memory relayer ──► automation engine ──► bridge ──► memory relayer
 (creates      (owner auth)      (schedules jobs,       (opens the    (verifies the
  delegate)                       stores ciphertext)     delegate)     delegate on-chain)
```

## How a delegate works

1. The owner creates a delegate in the chat-app (Agents → Automation → Automation delegates).
   That registers a fresh sub-agent on-chain with capabilities `7` (memory read, memory write,
   MYDATA read), no ability to mint children, a spend cap and an expiry of at most 90 days.
2. The delegate's seed is generated in the browser and encrypted there to this bridge's public key
   (X25519 + AES-256-GCM, bound to the account, name and agent). Only ciphertext leaves the
   browser.
3. The memory relayer and the engine relay and store that ciphertext. The engine's database
   holds nothing usable without this bridge's MyData private key.
4. For each job, the engine sends `key_ref: "delegate:<name>"` and the job's `account_id`. The
   bridge fetches the encrypted row, opens it in memory, and **before every signing request** asks
   the relayer, as the delegate, for its chain-verified state. It refuses unless the delegate is:
   - active and unexpired (the relayer enforces this on-chain on every call),
   - registered under the job's account, as the agent that was stored,
   - limited to memory read/write (anything broader is refused),
   - carrying a spending limit and an expiry.

   Nothing is cached, so a revocation or a deleted row takes effect on the next request.
5. Decrypted keys are never logged and no API returns one.

### What this does and does not guarantee

MySocial infrastructure cannot sign as the user or as any agent the user holds. Compromising the
bridge and its database yields delegates, each bounded by memory-only access, its spend cap and
its expiry. The bridge **can** act as a delegate within those limits until the owner revokes it
or it expires, the same trust as an OAuth token or session key. To limit that, shorten the expiry
or lower the limit. See [§13 of the engine README](../automation/README.md#13-security-limitations).

## Routes

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Liveness. Reports a count only, never ref names. |
| `GET /mydata-keys` | none | Public MyData keys (ids and public halves) for browsers to encrypt to. |
| `POST /internal/memory/recall` | `x-internal-sync-secret` | Semantic recall as a delegate. |
| `POST /internal/memory/remember` | `x-internal-sync-secret` | Store a memory as a delegate. |
| `POST /internal/memory/probe` | `x-internal-sync-secret` | Check the relayer for a delegate. |
| `POST /internal/chain/act` | `x-internal-sync-secret` | Run one task market action as a `task_worker` delegate. |

Every `/internal/*` body carries `key_ref` and `account_id`. A ref only resolves for the account
it belongs to, and a mismatch is indistinguishable from an unknown ref.

### Chain actions (`/internal/chain/act`)

Body: `{ key_ref, account_id, action_id, params, idempotency_key }`. Response: `{ status, action_id, digest }`.

Four gates stand between a request and a signature:

1. `action_id` must be one of the 14 `task.*.v1` actions. Nothing else can be signed, whatever the engine sends.
2. `key_ref` must be `delegate:<name>`, and that delegate must be a `task_worker` that was registered for
   that exact action (its `allowed_action_ids`). Static development keys never act on chain.
3. The chain, through the relayer, must confirm the delegate is active, unexpired, spend-capped, expires within
   90 days, holds the task market capability and holds nothing beyond memory and the task market.
4. The relayer re-checks capability, approval-required caps and its action catalog while preparing the transaction.

Nothing is cached: the key is opened, verified and used per request, so revoking or expiring the delegate takes
effect on the next call. The signing key never appears in a response or a log.

`task.create.v1` escrows funds from a coin the delegate owns, and an event cannot name one. When a job leaves
`paymentCoinId` out, the bridge lists the delegate's own MYSO coins (`mysox_getCoins`) and uses the smallest single coin
that covers `amountMist`, or answers 422 `insufficient_funds`. Fund the delegate's address (its derived address, shown by
the relayer's `/api/agent/context`) before turning on a buying job; the on-chain spend cap still bounds each escrow.

Failures are classified for the engine: **409** the task moved on (the engine records a skipped run), **403** the
delegate may not do this (including an owner who requires approval for task actions, which an unattended worker
cannot give), **422** the action was invalid, **502** retry. `idempotency_key` is passed through, so a retry or a
re-delivered event returns the original result instead of acting twice.

## Configuration

Production (`NODE_ENV=production`, which the Dockerfile sets) requires:

| Variable | Notes |
|---|---|
| `INTERNAL_SYNC_SECRET` | Shared with the engine and relayer. The public placeholder is refused. |
| `AUTOMATION_MYDATA_PRIVATE_KEYS` | `id:base64url`, comma-separated to rotate. **The one secret that matters.** |
| `AUTOMATION_ENGINE_URL` | Where encrypted delegates are stored. Falls back to `AUTOMATION_EVENTS_URL`. |
| `MEMORY_SERVER_URL` | Memory relayer origin used for delegates. |
| `AUTOMATION_WORK_MCP_URL` | Hosted MySo Agents MCP `/mcp` endpoint used by the run-scoped worker proxy. Required in production; must be HTTPS. |
| `AUTOMATION_WORK_DISPATCH_URL` | MySo Agents app origin for secret-protected work-run turn dispatch. HTTPS required outside loopback. |
| `AUTOMATION_WORK_DISPATCH_SECRET` | High-entropy secret shared with `MYSO_AGENTS_WORKER_DISPATCH_SECRET` in the app deployment. |
| `MCP_MESSAGING_RELAYER_URL` | Optional HTTPS messaging relayer; enables unattended room-history reads only with per-run owner consent and the worker's live room-reader permission. |
| `HOST` / `PORT` | `0.0.0.0` in a container (the Dockerfile sets it), `8011` by default. |

In production the bridge **refuses to start** if `AUTOMATION_AGENT_KEYS_JSON` or
`AUTOMATION_AGENT_KEYS_FILE` is set. There is no plaintext-key mode on a deployment.

Optional: `AUTOMATION_DEFAULT_NAMESPACE` (default `chat-app`), `AUTOMATION_REQUEST_TIMEOUT_MS`,
`AUTOMATION_MAX_BODY_BYTES`, `AUTOMATION_EVENTS_URL` and `AUTOMATION_EVENTS_SECRET` (publish
`memory.created` back to the engine). See [`.env.example`](.env.example).

### Generate the MyData key

Run this on your own machine, never in a CI log:

```bash
pnpm gen:mydata-key        # from the myso-memory root
```

```
AUTOMATION_MYDATA_PRIVATE_KEYS=<id>:<key>   → this service's variables (secret)
VITE_AUTOMATION_MYDATA_KEY=<id>:<key>       → the chat-app build (public)
```

To rotate, list both keys (`old:...,new:...`), point the chat-app at the new public key, and
drop the old private key once no stored delegate names it.

## Local development

A static key file is available **outside production only**. It holds a plaintext seed, so use a
throwaway agent on a dev network.

```bash
cp .env.example .env
cp agents.example.json agents.json      # gitignored
pnpm install && pnpm build:sdk          # from the myso-memory root
pnpm dev:bridge
```

Static entries are keyed by `target_agent_key_ref` and must carry the `accountId` they belong to;
that field is the authorization.

## Commands

Run from the `myso-memory` root:

```bash
pnpm test:bridge        # unit and HTTP tests
pnpm typecheck:bridge
pnpm build:bridge
pnpm docker:bridge      # docker build -f services/automation-sidecar/Dockerfile .
pnpm smoke:automation   # engine + bridge end to end against a stub relayer
```

## Deploying on Railway

- Build context must include sibling `myso-memory` and `myso-messaging-stack` checkouts, as required by the hosted MCP package's linked messaging SDK. Set `RAILWAY_DOCKERFILE_PATH=myso-memory/services/automation-sidecar/Dockerfile` for that combined context.
- Healthcheck path: `/health`.
- **No public domain and no database.** The engine reaches it over private networking.

## Layout

| File | Role |
|---|---|
| `src/server.ts` | HTTP surface, secret check, startup wiring |
| `src/bridge.ts` | Recall, remember, probe; client cache; ref resolution |
| `src/delegates.ts` | Fetches and opens encrypted delegates from the engine |
| `src/verify.ts` | Per-request on-chain delegate check |
| `src/encrypt.ts` | Encrypted-envelope crypto and the MyData key ring |
| `src/keys.ts` | Dev-only static key store |
| `src/config.ts` | Environment and the production custody rules |
| `src/gen-mydata-key.ts` | MyData keypair generator |

The browser half of the encrypting format lives in the chat-app
(`src/lib/agents/automation-delegate.ts`) and is tested against this implementation.
