# Automation engine — setup tutorial

> ## Testnet first
>
> This system is **ready for Railway integration testing and testnet use.** It is
> **non-custodial**: the memory bridge holds no user agent key. An unattended job signs as a
> *delegate* the owner registered on-chain: memory read/write only, a spend cap, an expiry,
> revocable at any time. The delegate's key is sealed in the owner's browser to the bridge's
> public key and stored only as ciphertext.
>
> What that does and does not guarantee is in [§13](#13-security-limitations). Read it before
> mainnet: the bridge can still act *as the delegate*, inside the limits the owner set.

The automation engine runs **scheduled and event-triggered work for agents**. It is the
third leg of the architecture the chat-app documents:

```
chat-app ──► memory relayer ──► recall / remember / agent replies
     │
     └──────► automation engine ──► memory bridge ──► memory relayer
                 (this service)      (signs with the agent's own key)
```

Two facts shape everything below:

1. **This engine holds no agent keys.** The memory relayer's `/api/*` routes require
   Ed25519 signed requests. This service cannot sign them, so a small bridge service
   (`services/automation-sidecar`) does — using `@socialproof/memory`, the same client the
   chat-app uses. One implementation of the request contract means the chat-app and a
   scheduled job cannot drift apart. (That bridge is also the subject of the ⚠️ above: it is a
   *better* place for keys than this engine, but still a centralized one.)
2. **Nothing reaches this engine unauthenticated.** A job row names an organization, an
   account, and an agent key ref, so every route is gated on a shared secret. The chat-app
   reaches it through the memory relayer, which enforces owner auth and forwards.

### Where the pieces live

| Concern | Location | Status |
|---|---|---|
| Trigger evaluation, job/run orchestration, retries, budgets | `services/automation` (this service) | ✅ tested, frozen pending integration |
| Signing memory calls as a sealed, scoped delegate | `services/automation-sidecar` | ✅ tested; delegates only in production |
| Owner-authenticated `/api/automation/*` proxy | `services/server/src/automation_proxy.rs` | ✅ tested |
| Chat-app automation panel + client | `chat-app/src/**/automation*` | ✅ read-only by design |

**Feature development on these three services is frozen** until the §12 integration test passes
end to end on Railway. Fixes that unblock that test are in scope; new capabilities are not.

---

## 1. Prerequisites

| Requirement | Notes |
|---|---|
| Rust | 1.88+ (the `Dockerfile` pins `rust:1.94.1-bookworm`) |
| Node + pnpm | Node 20+; pnpm 9.12.3 (see `packageManager` at the repo root) |
| Postgres | Optional locally. Without it the engine uses an in-memory store and **jobs and runs are lost on restart.** |
| A memory relayer | `services/server`, on `:8000`. Needs to be running for any memory work. |
| An AI-credit oracle | On `:8095`. Every run preflights here before executing. |
| A registered agent | Its `MemoryAccount` object id plus its 32-byte Ed25519 seed. |

### Port map

| Service | Port | Notes |
|---|---|---|
| Automation engine | `8010` | this service |
| Automation memory bridge | `8011` | `services/automation-sidecar` |
| Memory relayer | `8000` | `services/server` |
| AI-credit oracle | `8095` | external |
| Social server | `9126` | audit + sub-agent lookups |
| Messaging relayer | `3000` / `3003` | optional, for workflow notifications |
| Automation Postgres | `5433` | `docker-compose.yml`; distinct from the relayer's 5432 |

---

## 2. The shared secret — decide this first

Every internal route in this stack uses the header `x-internal-sync-secret`, but the
variable naming has historically been inconsistent:

| Service | Variable it reads |
|---|---|
| Memory relayer | `INTERNAL_SYNC_SECRET` |
| Messaging relayer | `INTERNAL_SYNC_SECRET` |
| Automation engine | **either** — prefers `INTERNAL_SYNC_SECRET`, still accepts `AUTOMATION_INTERNAL_SYNC_SECRET` |
| Automation bridge | **either** — prefers `INTERNAL_SYNC_SECRET` |

**Pick one value and use it everywhere.** Two names with two different defaults on the same
header is a guaranteed 401 in a real deployment, and the error looks identical to a bad key
ref. For local development:

```
INTERNAL_SYNC_SECRET=dev-automation-secret
```

---

## 3. Start the automation database (optional but recommended)

```bash
pnpm db:automation:up      # starts Postgres on 5433
```

Give the engine its **own** database. It applies `migrations/001_automation.sql` on every
boot, and sharing the relayer's schema would mix `automation_jobs` / `automation_runs` into
its memory tables.

Then set in `services/automation/.env`:

```
DATABASE_URL=postgresql://automation:automation@localhost:5433/automation
```

Stop it with `pnpm db:automation:down`.

---

## 4. Configure and start the memory bridge

The bridge is the only component that holds agent keys. It resolves a job's
`target_agent_key_ref` into the three fields a headless memory client needs — key, account
id, server URL — and never returns the key to the caller.

First install workspace dependencies, which is what links `@socialproof/memory` into the
bridge (the SDK must also be built — apps depend on its compiled output):

```bash
pnpm install
pnpm build:sdk
```

Then:

```bash
cd services/automation-sidecar
cp .env.example .env
cp agents.example.json agents.json
```

> **Local development only.** This static key file holds a plaintext seed, which is exactly
> what a deployment must not have: with `NODE_ENV=production` the bridge refuses to start if
> it is present. Use a throwaway agent on a dev network. Deployments use sealed delegates
> instead (§12, §13.1).

Edit `agents.json` — each key is a `target_agent_key_ref` your jobs will reference:

```json
{
  "version": 1,
  "agents": {
    "demo-agent": {
      "key": "<64 hex digits: the agent's 32-byte Ed25519 seed>",
      "accountId": "0x<MemoryAccount object id>",
      "serverUrl": "http://127.0.0.1:8000",
      "namespace": "chat-app"
    }
  }
}
```

`key` must be **64 hex digits** (a leading `0x` is accepted) — the same 32-byte seed shape
the chat-app's `createHeadlessAgentMemoryClient` requires, so a key that works here works
there. `agents.json` is plaintext key material: `chmod 600` it and keep it out of git.

> `namespace` defaults to `chat-app`, which is the namespace the chat-app recalls from. That
> shared namespace is what makes the pairing observable: a job writes a memory, the chat-app
> can recall it. Change it only if you deliberately want the two isolated.

Build it, then start it:

```bash
pnpm build:bridge          # compiles src/ to dist/ — start runs the compiled output
pnpm start:bridge          # from the repo root
# or: pnpm dev:bridge      # tsx watch, no build step
```

`start:bridge` runs `node dist/server.js`, so it needs `build:bridge` first. `dev:bridge` runs
TypeScript directly and does not.

Verify:

```bash
curl -s localhost:8011/health | jq
# { "status": "ok", "service": "automation-memory-bridge", "agents": 1 }
# (a count only: ref names identify tenants' agents and are not listed on the public route)
```

The startup line reports which key source is in use, which is worth checking when a deploy
behaves differently from local:

```
[automation-memory-bridge] listening on http://0.0.0.0:8011 | agents=1 | keys=inline env | namespace=chat-app | memory=http://127.0.0.1:8000
```

`/health` is the only public route. Everything under `/internal/` requires the secret.

---

## 5. Configure and start the engine

```bash
cd services/automation
cp .env.example .env
```

Minimum viable `.env`:

```
PORT=8010
INTERNAL_SYNC_SECRET=dev-automation-secret
AUTOMATION_ENABLED=true
AUTOMATION_MEMORY_BRIDGE_URL=http://127.0.0.1:8011
AI_CREDIT_ORACLE_URL=http://127.0.0.1:8095
AI_CREDIT_ORACLE_API_SECRET=<same value the oracle and memory relayer use>
DATABASE_URL=postgresql://automation:automation@localhost:5433/automation
```

Start it:

```bash
pnpm dev:automation        # from the repo root; runs `cargo run`
```

Verify:

```bash
curl -s localhost:8010/health | jq
# { "status": "ok", "service": "myso-automation" }

# The job API is secret-gated, so this must be a 401:
curl -s -o /dev/null -w '%{http_code}\n' localhost:8010/v1/automation/jobs
# 401
```

### `AUTOMATION_ENABLED=false`

The engine still serves its HTTP API but runs **no** jobs — no tick loop, no event consumer.
Use it to dark-launch the service, or to keep a replica up for inspection while draining
work. The startup log says which mode it is in.

---

## 6. Verify the whole wire at once

Before creating real jobs, prove the wiring:

```bash
pnpm smoke:automation      # from the repo root
```

This boots the real engine and the real bridge plus stub oracle and relayer, then checks:

- both services answer `/health`
- both reject a missing or wrong secret
- the bridge refuses an unknown key ref with a **404** and never leaks key material
- the engine refuses an unauthenticated job read/create and an unscoped listing
- a run over `max_mist_per_run` is **skipped**, not executed, with the budget reason recorded
- an in-budget run reaches the bridge and is recorded **failed** with a reason rather than
  left `running`
- a retry is recorded (`attempt=2`) when `retry_policy.max_attempts=2`

Expected: `15/15 checks passed`.

> The smoke test does **not** complete a real recall. The SDK's `buildMyDataSession()`
> creates an on-chain SessionKey, so a real memory round trip needs localnet, MYDATA key
> servers, and a registered `MemoryAccount`. In a chain-less environment the memory call is
> *expected* to fail; what is asserted is that it fails at the right layer with a recorded
> reason.

---

## 7. Create your first job

Job creation is a trusted-service operation. In production the chat-app goes through the
memory relayer, which stamps ownership from the caller's signature. For local setup, call
the engine directly with the shared secret.

A **recall** job on a 60-second interval:

```bash
curl -s -X POST localhost:8010/v1/automation/jobs \
  -H 'content-type: application/json' \
  -H 'x-internal-sync-secret: dev-automation-secret' \
  -d '{
    "organization_id": "0x<your org>",
    "account_id": "0x<your MemoryAccount id>",
    "owner_address": "0x<the MemoryAccount owner wallet>",
    "name": "nightly preference recall",
    "trigger_set": {
      "match_mode": "any",
      "evaluation_window_ms": 0,
      "triggers": [
        { "kind": "interval", "interval_ms": 60000,
          "event_family": "automation", "event_type": "tick" }
      ]
    },
    "target_agent_object_id": "0x<SubAgent object id>",
    "target_agent_key_ref": "demo-agent",
    "action": {
      "kind": "memory_relayer_call",
      "config": { "operation": "recall", "query": "what does the user prefer", "limit": 5 }
    },
    "memory_scope": "chat-app",
    "max_mist_per_run": 1000,
    "retry_policy": { "max_attempts": 3, "jitter_ms": 1000 }
  }' | jq
```

`target_agent_key_ref` is `delegate:<name>` for a delegate you created in the chat-app, or a key in the bridge's dev-only `agents.json` locally. Watch the run:

```bash
JOB=<id from the response>
curl -s "localhost:8010/v1/automation/jobs/$JOB/runs?limit=5" \
  -H 'x-internal-sync-secret: dev-automation-secret' | jq
```

### Action config reference

`action.config` for `kind: "memory_relayer_call"`:

| Field | Meaning |
|---|---|
| `operation` | `recall` (default), `remember`, or `recall_then_remember` |
| `query` | Required for `recall` and `recall_then_remember` |
| `text` | Required for `remember` |
| `limit` | Max recalled results, 1–100. Defaults to 10 |
| `namespace` | Overrides the bridge default for this action |
| `key_ref` | Overrides the job's `target_agent_key_ref` for this action |
| `remember_prefix` | Prefix for the digest `recall_then_remember` writes |
| `wait` | For `remember`: block until the relayer reports `done`. Defaults to true |

`recall_then_remember` recalls, joins the results, and stores `remember_prefix` + that
digest. If recall returns nothing it stores nothing rather than writing an empty memory that
would pollute later recall.

### Run statuses

| Status | Meaning |
|---|---|
| `running` | In flight. Should always become terminal — a stuck `running` row is a bug. |
| `succeeded` | Action completed. `cost_mist` is the reserved amount from preflight. |
| `skipped` | Preflight refused, or the estimate exceeded `max_mist_per_run`. The reason is in `error`. |
| `failed` | The action failed after all retries. The reason is in `error`. |

### Trigger kinds

- `interval` — `interval_ms`. Due once the interval has elapsed since the last run **started**
  (whatever its outcome); a job that has never run is due immediately. A skipped or failing job
  therefore waits for its next slot instead of re-running every tick; retries within a run are
  governed by `retry_policy`.
- `cron` — `cron_expr`. Accepts 5-field (`min hour dom month dow`), 6-field, or the crate's
  7-field form.
- `event` — `event_family` + `event_type`, optionally narrowed by `organization_id`,
  `account_id`, `agent_object_id`, and a shallow `payload_filter`.
- `conditional` — matched by evaluator only; not scheduled.

`match_mode: "all"` with `evaluation_window_ms` requires every trigger to have matched inside
the window.

---

## 8. Pair with the chat-app

### The relayer side

Set on the **memory relayer** (`services/server/.env`):

```
INTERNAL_SYNC_SECRET=dev-automation-secret
AUTOMATION_ENGINE_URL=http://127.0.0.1:8010
# AUTOMATION_ENGINE_SECRET=        # defaults to INTERNAL_SYNC_SECRET
```

That exposes `/api/automation/*` on the relayer, owner-authenticated. The relayer:

- derives `account_id` and `organization_id` from the **verified signature**, and does not
  accept them from the request body — a caller cannot create a job owned by someone else
- re-checks that a job belongs to the caller before returning it or its run history, so a
  caller-supplied job id cannot read another tenant's runs
- answers `503` when `AUTOMATION_ENGINE_URL` is unset, rather than exposing a bypass

### The chat-app side

No new variable. The chat-app reaches the engine through `VITE_MEMORY_SERVER_URL`, and in dev
the existing `/api/memory` Vite proxy handles it (the proxy strips the prefix, so the signed
preimage matches what the relayer receives).

Open **Agents → Overview → Automation**. You should see the engine status and the jobs for
the selected agent, with a **Runs** button per job.

Signing uses WebCrypto Ed25519 (Chrome 113+, Safari 17+, Firefox 130+) with a PKCS#8 wrapper
around the raw 32-byte seed — verified to produce byte-identical signatures to the
`@noble/ed25519` the Memory SDK signs with, so no extra dependency is needed.

### The payoff

Because both sides use the `chat-app` namespace, a job that writes a memory is recallable in
the chat-app. That is the pairing working end to end.

---

## 9. Troubleshooting

| Symptom | Cause |
|---|---|
| `401` from any internal route | The two secret names disagree. Set `INTERNAL_SYNC_SECRET` to one value across the engine, bridge, and both relayers. |
| `404` + `key_store:unknown_ref` from the bridge | No such delegate under the job's account. Use `delegate:<name>` for a delegate you created in the chat-app (Automation → Automation delegates). The error does not list what exists. |
| `key_store:file_missing` at bridge startup | Local dev only: `AUTOMATION_AGENT_KEYS_FILE` points at a path that does not exist. |
| `invalid_entry … must be a 32-byte Ed25519 seed` | The key is 33 bytes (flag-prefixed) or a 64-byte expanded key. Use the 32-byte seed as 64 hex digits. |
| Jobs vanish after a restart | `DATABASE_URL` is unset, so the engine is using the in-memory store. The startup log warns about this. |
| Run stuck in `running` | Should not happen: an oracle failure is now recorded as `failed`. If you see one, the process was killed mid-run. |
| Run `skipped` with a budget reason | Working as intended — the preflight estimate exceeded `max_mist_per_run`. Raise the cap or set it to `0` to disable the cap. |
| `502 bridge unavailable: … GET /config returned 404` | The bridge reached the SDK but the relayer origin has no `/config`. Check `MEMORY_SERVER_URL` on the **bridge**, not the engine — the engine has no relayer URL on purpose. |
| Chat-app shows "engine not configured" | `AUTOMATION_ENGINE_URL` is unset on the memory relayer. |
| Chat-app shows "engine not reachable" but the engine is up | The relayer cannot reach the engine URL. From the relayer's host, `curl $AUTOMATION_ENGINE_URL/health`. |
| A run retried but you expected one attempt | Correct behaviour for transport failures. `retry_policy.max_attempts` applies to retryable failures only; a 4xx never retries. |

---

## 10. Testing

```bash
pnpm test:automation-stack     # bridge suite + Rust suite
pnpm smoke:automation          # live end-to-end wiring
```

Individually:

```bash
pnpm test:bridge               # bridge: keys, config, HTTP surface, bridge mapping
pnpm test:automation           # engine: trigger eval, store, retry, action config
```

For the chat-app client:

```bash
cd ../myso-messaging-stack/chat-app
npx vitest run src/lib/agents/automation-client.test.ts
npx tsc -b
```

---

## 11. Not implemented yet

Stated plainly so nothing here reads as more finished than it is:

- **`social_action` and `webhook` actions.** Selecting either records the run as `failed`
  with "not implemented". They previously logged and returned success, which reported a
  successful run that had done nothing.
- **A create-job form in the chat-app.** The panel is read-only. Job creation needs a
  trigger builder, a key-ref picker, and a budget field; a half-built form that silently
  produced an inert job would be worse than none.
- **Key custody.** Deployments use sealed delegates (§13.1). `agents.json` is a dev-only
  plaintext store that production refuses to load.
- **Event producers.** `/internal/automation/events` is implemented and the 15-family
  registry in `docs/event_registry.json` defines the vocabulary, but few services publish
  yet. The bridge can publish `memory.created` when `AUTOMATION_EVENTS_URL` is set; wiring
  `message.received` and the social families is future work.
- **`automation_trigger_state`.** The table exists in the migration for per-trigger debounce,
  cooldown, and windowed execution counts. `cooldown_ms` **is** enforced (an event inside the
  cooldown of the job's last run is ignored — set it on any event-triggered job whose action
  writes memory, or a `memory.created` trigger will re-trigger itself). `debounce_window_ms`
  and `max_executions_per_window` are parsed but not yet enforced.

---

## 12. Deploying

> **Status: ready for Railway integration testing, not for production.** See
> §13 — centralized agent-key custody is a security limitation that must be resolved
> before mainnet.

There are **three services** to stand up, plus one variable in the chat-app:

```
chat-app ──► memory relayer ──► automation engine ──► memory bridge ──► memory relayer
              (public)            (private)            (private)          (private)
```

| # | Service | Root Directory | Dockerfile | Database |
|---|---|---|---|---|
| 1 | memory relayer | `services/server` | auto-detected | **pgvector**, plus Redis |
| 2 | automation engine | `services/automation` | auto-detected | plain Postgres |
| 3 | memory bridge | **repo root** | `RAILWAY_DOCKERFILE_PATH` | **none** |

Bring the databases up first, then the three services in that order — each service's URL is
the previous one's configuration. The order matters for *setup*, not for *runtime*: nothing
here crashes because a peer is slow to appear.

- The engine retries its Postgres connection with backoff (`AUTOMATION_DB_CONNECT_TIMEOUT_SECS`,
  default 120s) instead of panicking on the first refusal, so being started beside its database
  is fine.
- The bridge connects to the relayer per request, never at boot, so it has no startup dependency
  on it at all.
- Every service exposes `/health`, so a platform healthcheck gates traffic until the service is
  actually ready rather than merely started.

Until `AUTOMATION_ENGINE_URL` is set on the relayer, `/api/automation/*` answers 503 and the
chat-app reports the engine as not configured — that is the designed fail-safe, not a broken
deploy.

### Use reference variables, not copied credentials

Railway resolves references at deploy time, so a renamed service or a rotated database password
does not turn into a stale hardcoded string in three places. Prefer references throughout:

```
# database + cache
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}

# the shared secret, defined once in Project Settings → Shared Variables
INTERNAL_SYNC_SECRET=${{shared.INTERNAL_SYNC_SECRET}}

# private-network URLs, built from each service's own DNS name
AUTOMATION_ENGINE_URL=http://${{automation-engine.RAILWAY_PRIVATE_DOMAIN}}:8010
AUTOMATION_MEMORY_BRIDGE_URL=http://${{memory-bridge.RAILWAY_PRIVATE_DOMAIN}}:8011
MEMORY_SERVER_URL=http://${{memory-relayer.RAILWAY_PRIVATE_DOMAIN}}:8000
```

`RAILWAY_PRIVATE_DOMAIN` is the service's private DNS name, so these survive a rename and need
no hostname bookkeeping. `shared.` is the shared-variable namespace — define
`INTERNAL_SYNC_SECRET` once there and every service reads the same value, which is the single
most effective way to avoid the two-secret-names 401 in §9.

One caveat: a reference to a service that does not exist yet cannot resolve, so create the
service before referencing it. That is a one-time setup constraint, not a runtime one.

### Service 1 — the memory relayer

This is by far the heaviest service, and everything downstream depends on it being healthy. It
requires a **pgvector** database (embeddings are stored as vectors, so Railway's default
Postgres template has no `vector` extension and migrations will fail), Redis, a MySo fullnode,
MYDATA key servers, and the social indexer.

```
PORT=8000
DATABASE_URL=${{Postgres.DATABASE_URL}}          # must be the pgvector template
REDIS_URL=${{Redis.REDIS_URL}}
INTERNAL_SYNC_SECRET=${{shared.INTERNAL_SYNC_SECRET}}
ALLOWED_ORIGINS=https://<chat-app-domain>        # omit it and the browser is blocked by CORS

MYSO_NETWORK=testnet
MYSO_RPC_URL=<fullnode>
MYDATA_KEY_SERVERS=0x...
MYDATA_THRESHOLD=2
MYDATA_DECRYPT_THRESHOLD=2

MEMORY_PACKAGE_ID=0x...
MEMORY_REGISTRY_ID=0x...
PLATFORM_OBJECT_ID=0x...
FILE_STORAGE_PUBLISHER_URL=...
FILE_STORAGE_AGGREGATOR_URL=...
SERVER_MYSO_PRIVATE_KEYS=...
AI_CREDIT_ORACLE_URL=...
AI_CREDIT_ORACLE_API_SECRET=...
OPENROUTER_API_KEY=...                            # only when AI_CREDIT_ENABLED=true

SIDECAR_PORT=9009
SIDECAR_URL=http://localhost:9009
SIDECAR_AUTH_TOKEN=...

# The hook-up.
AUTOMATION_ENGINE_URL=http://${{automation-engine.RAILWAY_PRIVATE_DOMAIN}}:8010
AUTOMATION_ENGINE_SECRET=${{shared.INTERNAL_SYNC_SECRET}}
```

Healthcheck path **`/health`**.

The social-chain object IDs (`USERNAME_REGISTRY_ID`, `POST_CONFIG_ID`, `PLATFORM_REGISTRY_ID`,
and the rest) do **not** need pinning: `SOCIAL_CHAIN_AUTO_DISCOVERY=true` resolves them by Move
type from GraphQL, which is the same machinery that heals a regenesised localnet. Pinning them
is supported as an override, not a requirement.

### Service 2 — the automation engine

Root Directory `services/automation`, its own plain Postgres (no pgvector needed). This is the
only service that stores jobs and run history, so it is the only one that loses data without a
database.

```
PORT=8010
DATABASE_URL=${{AutomationPostgres.DATABASE_URL}}
INTERNAL_SYNC_SECRET=${{shared.INTERNAL_SYNC_SECRET}}
AUTOMATION_ENABLED=true
AUTOMATION_TICK_INTERVAL_SECS=60

# How long to keep retrying Postgres at boot before failing. Default 120.
AUTOMATION_DB_CONNECT_TIMEOUT_SECS=120

# The hook-up.
AUTOMATION_MEMORY_BRIDGE_URL=http://${{memory-bridge.RAILWAY_PRIVATE_DOMAIN}}:8011

AI_CREDIT_ORACLE_URL=...
AI_CREDIT_ORACLE_API_SECRET=...

# Optional. Without WORKFLOW_RELAYER_URL runs are silent; without
# SOCIAL_SERVER_URL/AUDIT_SYNC_SECRET they are recorded locally only.
WORKFLOW_RELAYER_URL=...
WORKFLOW_SYNC_SECRET=${{shared.INTERNAL_SYNC_SECRET}}
SOCIAL_SERVER_URL=...
AUDIT_SYNC_SECRET=${{shared.INTERNAL_SYNC_SECRET}}
```

Healthcheck path **`/health`**.

Give the engine its **own** database. It applies `migrations/001_automation.sql` on every boot,
and sharing the relayer's schema would mix `automation_jobs` / `automation_runs` into its
memory tables.

### Service 3 — the memory bridge

Build context is the **repo root**, not `services/automation-sidecar`: `@socialproof/memory` is
a workspace dependency and `packages/sdk/dist` is gitignored, so the image installs the
workspace and builds the SDK itself. Railway uses the Root Directory as the build context and
looks for a file literally named `Dockerfile` there, so point at ours explicitly:

```
RAILWAY_DOCKERFILE_PATH=services/automation-sidecar/Dockerfile
PORT=8011
INTERNAL_SYNC_SECRET=${{shared.INTERNAL_SYNC_SECRET}}
AUTOMATION_SEAL_PRIVATE_KEYS=<id>:<key>        # from `pnpm gen:seal-key`; the ONE secret here
AUTOMATION_ENGINE_URL=http://${{automation-engine.RAILWAY_PRIVATE_DOMAIN}}:8010
MEMORY_SERVER_URL=http://${{memory-relayer.RAILWAY_PRIVATE_DOMAIN}}:8000
```

The bridge **refuses to start** in production if `AUTOMATION_AGENT_KEYS_JSON` or
`AUTOMATION_AGENT_KEYS_FILE` is set, or if any of the three variables above is missing. There
is no plaintext-seed mode on a deployment.

Generate the seal key on your own machine:

```bash
pnpm gen:seal-key            # prints two lines
# AUTOMATION_SEAL_PRIVATE_KEYS=k202610:<private>   → bridge service variable (secret)
# VITE_AUTOMATION_SEAL_KEY=k202610:<public>        → chat-app build variable (public)
```

The private line is the only thing that can open the sealed keys in the engine's database.
Keep it in the bridge's variables and nowhere else. To rotate, append a second key
(`old:...,new:...`), point the chat-app at the new public key, and drop the old one once no
stored delegate still names it.

Healthcheck path: **`/health`** — the only unauthenticated route.

**Do not attach a database.** The bridge is stateless: no queue, no cache, no run history. Run
history belongs to the engine.

**Give it no public domain.** The engine reaches it over private networking and nothing else
should. It signs as delegates, so public exposure plus a leaked `INTERNAL_SYNC_SECRET` would let
a stranger spend delegates' limits until they expire. `/health` and `/seal-keys` are the only
unauthenticated routes and reveal nothing secret.

There is deliberately **no `railway.json` here**: Config as Code is [deprecated by
Railway](https://docs.railway.com/config-as-code) and *new services cannot opt into it* — it is
only still read for services that already existed. Set the builder, healthcheck, and restart
policy in the dashboard, or adopt [Infrastructure as
Code](https://docs.railway.com/infrastructure-as-code) via `railway config init` for the whole
project. (The engine's own `railway.json` keeps working because that service predates the
cutoff; note it expires 2026-12-01.)

Locally, the same image:

```bash
pnpm docker:bridge      # docker build -f services/automation-sidecar/Dockerfile .
```

`HOST` is already `0.0.0.0` in the image. The code default is `127.0.0.1`, which is correct
on a laptop and wrong in a container — Railway does not set `HOST`, so overriding it back to
loopback produces a container that starts, logs a healthy line, and then fails its own
healthcheck. The bridge warns loudly at startup if it ever binds loopback.

### The chat-app

One variable, pointing at the relayer's **public** URL:

```
VITE_MEMORY_SERVER_URL=https://<relayer-public-domain>
```

That single value carries memory *and* the automation panel, because the relayer proxies
`/api/automation/*`. Nothing in the browser talks to the bridge or the engine directly, and
there is deliberately no `VITE_AUTOMATION_*` variable — the browser must never hold the
engine's shared secret.

Remember the matching `ALLOWED_ORIGINS` on the relayer, or CORS blocks the browser.

### Three gotchas worth reading twice

**`PORT` decides both where you listen and where the healthcheck looks.** Verified against
Railway's docs rather than assumed: Railway injects `PORT`, your app is expected to listen on
it, *and that same value is what Railway uses when performing health checks*. Setting `PORT`
explicitly as a service variable is supported and is how you pin both. So:

- Set `PORT` explicitly on all three services (8000 / 8010 / 8011). Otherwise the bridge binds
  whatever Railway assigns, and the engine's `AUTOMATION_MEMORY_BRIDGE_URL` points at the wrong
  port — a failure that looks like an outage, not a config error.
- Do **not** set `HOST` on the bridge. The image already sets `0.0.0.0`; the code default of
  `127.0.0.1` would make the healthcheck unreachable.
- Healthcheck path is `/health` on all three. Railway's default healthcheck timeout is 300s,
  adjustable per service via `RAILWAY_HEALTHCHECK_TIMEOUT_SEC`. The engine's Postgres retry
  budget (120s) deliberately sits inside that window, so a slow database surfaces as a retry
  that succeeds rather than a deployment marked failed.

Sources: [Healthchecks](https://docs.railway.com/deployments/healthchecks) and
[Variables](https://docs.railway.com/variables).

**The bridge is useless without a reachable memory relayer.** `MEMORY_SERVER_URL` is resolved
from inside a Railway container, where `127.0.0.1` is that container — not your laptop. If the
only relayer you run is local, the bridge will start, pass its healthcheck, and 502 on every
job. The three coherent shapes:

| | relayer | engine | bridge | Works? |
|---|---|---|---|---|
| **A. All local** | localhost | localhost | localhost | ✅ the `pnpm smoke:automation` path |
| **B. All Railway** | deployed | deployed | deployed, private only | ✅ what this section describes |
| **C. Bridge only** | localhost | localhost | Railway | ❌ cannot reach your laptop |

If you want to keep the relayer local but the bridge hosted, point `MEMORY_SERVER_URL` at a
tunnel to your machine. Workable, but you have then exposed a memory relayer that holds
MYDATA decrypt capability, so weigh that before doing it.

**The bridge is useless without a reachable memory relayer.** `MEMORY_SERVER_URL` is resolved
from inside a Railway container, where `127.0.0.1` is that container — not your laptop. If the
only relayer you run is local, the bridge will start, pass its healthcheck, and 502 on every
job. The three coherent shapes:

| | relayer | engine | bridge | Works? |
|---|---|---|---|---|
| **A. All local** | localhost | localhost | localhost | ✅ the `pnpm smoke:automation` path |
| **B. All Railway** | deployed | deployed | deployed, private only | ✅ what this section describes |
| **C. Bridge only** | localhost | localhost | Railway | ❌ cannot reach your laptop |

If you want to keep the relayer local but the bridge hosted, point `MEMORY_SERVER_URL` at a
tunnel to your machine. Workable, but you have then exposed a memory relayer that holds
MYDATA decrypt capability, so weigh that before doing it.

### Custody on a hosted platform

The dashboard holds **one** secret that matters: `AUTOMATION_SEAL_PRIVATE_KEYS`. Everything
else is ciphertext, public data, or a shared header secret. Someone with dashboard access can
open the delegate keys stored in the database, which is why a delegate is limited to memory,
a spend cap and an expiry, and why the owner can end it on-chain without anyone's help. They
cannot reach the owner's own agents or wallet, because those keys are never sent here.

### Verifying a deployment

The bridge logs which key source it loaded and which relayer it targets, which is the fastest
way to tell a bad deploy from a bad job:

```
[automation-memory-bridge] listening on http://0.0.0.0:8011 | keys=sealed delegates | agents=0 | namespace=chat-app | memory=http://memory-server.railway.internal:8000
```

`keys=sealed delegates` is the only value a deployment should ever show. `static ... (dev)`
means a plaintext key store is loaded, which production refuses to do.

Then check the chain outward, in order. Each step isolates one hop. The bridge and the engine
have **no public domains**, so run these from a shell inside the project's private network —
`railway ssh` into the engine's service, or `railway run` from a linked checkout:

```bash
# 1. bridge alive, holding the agents you expect (refs only, never key material)
curl -s http://<bridge-service>.railway.internal:8011/health

# 2. bridge -> relayer, as a specific agent. This is the hop that proves key
#    resolution AND outbound reachability at once.
curl -s -X POST http://<bridge-service>.railway.internal:8011/internal/memory/probe \
  -H 'x-internal-sync-secret: <shared>' -H 'content-type: application/json' \
  -d '{"key_ref":"demo-agent"}'

# 3. engine -> bridge: read a job's run history and look at the error column
curl -s "http://<engine-service>.railway.internal:8010/v1/automation/jobs/<id>/runs" \
  -H 'x-internal-sync-secret: <shared>'
```

Reading the results:

| Result | Meaning |
|---|---|
| step 2 returns `{"status":"ok",...}` | the whole bridge leg works |
| step 2 `502` naming `/config` or a connection error | the bridge cannot reach `MEMORY_SERVER_URL` |
| step 2 `404` `key_store:unknown_ref` | it reached the relayer; the key ref is wrong. The error lists what is registered |
| step 2 `key_store:no_server_url` | the key entry has no `serverUrl` and `MEMORY_SERVER_URL` is unset |
| `401` anywhere | the two secret names disagree |
| step 3 shows runs stuck at `running` | the engine process died mid-run; it fails runs it cannot finish |

Step 4 — relayer → engine — is best checked from the chat-app's **Agents → Overview →
Automation** panel, which reports the engine status. A raw `curl` against
`/api/automation/health` cannot tell you anything useful: it is an owner-authenticated route,
so an unsigned request returns `401` before the proxy ever runs.

---

## 13. Security limitations

This section is a gate, not a disclaimer. Nothing here is a bug report against the work
already done — it is the list of things that must change before this system is trusted with
real value.

### 13.1 Agent-key custody: delegates (resolved for testnet, read before mainnet)

**The model.** The bridge never holds a user's agent key. For unattended work the owner
registers a *delegate* sub-agent on-chain:

| Property | Enforced by |
|---|---|
| Memory read/write/MYDATA only (`capabilities = 7`), cannot mint children | chain + bridge refuses anything broader |
| A spending limit (`max_action_spend`) | chain + bridge refuses a delegate without one |
| An expiry, 90 days at most from the UI | chain + bridge refuses a delegate without one |
| Revocable at any time (`revoke_sub_agent`) | chain; takes effect on the next request |

The delegate's seed is generated in the owner's browser, sealed there (X25519 + AES-256-GCM,
bound to the account, name and agent) to the bridge's public key, and stored in the engine's
Postgres as ciphertext. The memory relayer, the engine and the database only ever relay or
hold that ciphertext. The bridge opens it in memory at request time, and before **every**
signing request it asks the relayer, as the delegate, for the delegate's chain-verified state
and refuses unless the delegate is active, unexpired, memory-only, capped and registered under
the job's account. Nothing is cached, so a revocation or a deleted row bites immediately.
Decrypted keys are never logged and no API returns one.

**What this guarantees.** MySocial infrastructure cannot sign as the user, or as any agent the
user holds. Compromising the bridge and the database yields delegates, each bounded by the
memory capability, its spend cap and its expiry.

**What it does not.** The bridge *can* act as a delegate within those limits until the owner
revokes it or it expires. That is the same trust as an OAuth token or a session key, and it
is the honest cost of unattended execution. If a delegate's authority is too much, shrink it
(shorter expiry, smaller limit); do not widen the bridge.

**Residual items to close before mainnet:**

- The seal private key is a single Railway secret. A KMS-backed seal key would remove it from
  the dashboard.
- A stored sealed row can be replaced by any authenticated agent of the same account. This
  cannot grant authority (the delegate must still verify on-chain), but it can disable a job.
  Requiring an owner co-sign on `PUT /api/automation/delegates` closes it.
- The spend cap bounds relayer-side spend; it does not bound what a delegate *reads*.
  Recall returns plaintext memory to the job. Scope the delegate's namespace deliberately.

### 13.1a Tenant isolation of key refs

A job names its agent by `target_agent_key_ref` (and an action may override it with
`config.key_ref`). The relayer proxy does not validate that string, so the **bridge** is the
enforcement point: every engine call carries the job's `account_id`, and the bridge refuses a
ref whose registered `accountId` differs, answering exactly as it does for an unknown ref.
Unknown-ref errors no longer list registered refs, and `/health` reports a count only —
both were ways to learn another tenant's ref names. Keep every `accountId` in the key file
accurate; it is now the authorization, not just metadata.

### 13.3 Smaller items already recorded

§11 lists the unimplemented pieces (`social_action`/`webhook` actions, a create-job UI, event
producers, `automation_trigger_state` enforcement). They are scope gaps rather than security
issues, but they are gaps.
