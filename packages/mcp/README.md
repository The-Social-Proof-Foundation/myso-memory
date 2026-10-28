# Memory MCP

Secure stdio and hosted Streamable HTTP MCP server for `@socialproof/memory` and MySocial agent actions.

The MCP process resolves a local signer, keeps private key material inside the
process, and sends only public keys, signatures, and bounded session credentials
to upstream services. Raw `key`, `ownerCoSignKey`, `x-delegate-key`, and
`x-owner-delegate-key` transport is intentionally unsupported.

## Install and run

```bash
pnpm --filter @socialproof/memory-mcp build
pnpm --filter @socialproof/memory-mcp exec memory-mcp
```

The package binary and runtime version are both sourced from `package.json`.
`node packages/mcp/dist/index.js` remains supported for existing local setups.

### Localnet organization prerequisites

After every `myso start --force-regenesis`, bootstrap MySocial and create one
approved platform before starting the memory relayer:

```bash
./scripts/bootstrap.sh
./scripts/proof-of-creativity-runnable.sh --create-platform
```

For a relayer running against local GraphQL/fullnode, set
`SOCIAL_CHAIN_AUTO_DISCOVERY=true`, `SOCIAL_CHAIN_GRAPHQL_URL=http://127.0.0.1:9125/graphql`,
and `LOCAL_SPONSOR_ENABLED=true`. Discovery fills missing singleton IDs, verifies
their type and shared ownership against the fullnode, and replaces stale localnet
IDs after regenesis. Local sponsorship uses `SERVER_MYSO_PRIVATE_KEYS` only as gas
owners; the agent or owner wallet must still sign the transaction.

## Credentials

The default configuration path is `~/.memory/credentials.json`. Override it with
`MEMORY_MCP_CREDENTIALS_FILE`.

Recommended macOS Keychain configuration:

```json
{
  "accountId": "<memory-account-object-id>",
  "serverUrl": "http://127.0.0.1:8000",
  "platformId": "<platform-object-id>",
  "socialEnabled": false,
  "signer": {
    "type": "keychain",
    "service": "network.mysocial.memory-mcp",
    "account": "my-agent"
  }
}
```

`socialEnabled` defaults to `false`. When enabled, Tier 1A reactions and Tier 1B
publishing actions are available only when authenticated capabilities, approval
policy, and platform scope allow them. Network and shared-object IDs are discovered
from authenticated agent context; callers do not need to copy raw object IDs:

```json
{
  "accountId": "<memory-account-object-id>",
  "serverUrl": "http://127.0.0.1:8000",
  "socialEnabled": true,
  "messagingRelayerUrl": "https://messaging-relayer.mysocial.network",
  "signer": {
    "type": "keychain",
    "service": "network.mysocial.memory-mcp",
    "account": "my-agent"
  }
}
```

`messagingRelayerUrl` enables caller-bound encrypted room history, reactions, and
read/delivery receipt tools. The MCP adapter obtains network, package, platform,
account, agent, and capability state from the signed agent context on each call,
then checks the relevant live room permission on chain. The relayer remains a
metadata transport; reactions and receipts are not chain evidence. The URL must
use HTTPS, except for loopback development.

The local CLI wires this adapter when the URL is configured and the Memory client
provides `getAgentContext()`. Hosted deployments can set
`HostedMcpOptions.messagingRelayerUrl`; after the per-principal dependencies are
created, the hosted server configures the room adapter on that principal's
`SponsoredSocialGateway`, using its signer and freshly signed context. A custom
`SocialGateway` must provide `enableRoomMessaging()` or already expose room
history. The hosted server rejects an HTTP relayer URL except for loopback.

`mysoNetwork`, `mysoRpcUrl`, and `socialChain` remain optional deployment pins.
When supplied, they must exactly match authenticated context or execution fails closed.

Store a 32-byte Ed25519 key encoded as hex:

```bash
security add-generic-password \
  -U \
  -s network.mysocial.memory-mcp \
  -a my-agent \
  -w '<agent-private-key-hex>'
```

For local development only, a file-backed signer is available:

```json
{
  "accountId": "<memory-account-object-id>",
  "serverUrl": "http://127.0.0.1:8000",
  "socialEnabled": false,
  "signer": {
    "type": "development-file",
    "path": "~/.memory/dev-agent.key"
  }
}
```

The key file must be a regular, non-symlink file with mode `0600` or stricter,
and the process must set `MEMORY_MCP_ALLOW_INSECURE_DEV_FILE=1`.

Hosted or wallet-backed runtimes should import `InjectedAgentSigner` and
`createMemoryMcpServer` instead of writing a key to disk. The current Memory SDK
still needs a local secret-backed client; callers using a non-exportable signer
must inject their own `MemoryClient` adapter.

## Tools and result contract

Memory tools:

- `memory_remember`
- `memory_recall`
- `memory_health`

Secure social tools currently exposed when enabled:

- `social_react_post`
- `social_react_comment`
- `social_create_post`
- `social_create_comment`
- `social_create_repost`
- `social_remove_post_reaction`, `social_remove_comment_reaction`
- `social_edit_post`, `social_edit_comment`, `social_remove_repost`
- `social_follow_profile`, `social_unfollow_profile`
- `social_block_profile`, `social_unblock_profile`
- `messaging_send_message`
- `messaging_create_group`, `messaging_list_inbox`, `messaging_wait_for_message`
- `organization_get_control`
- `organization_create`, `organization_update_metadata`, `organization_update_category`
- `organization_ensure_memory_group`, `organization_define_role`
- `organization_assign_role`, `organization_revoke_role`, `organization_create_invitation`
- `organization_accept_invitation`, `organization_decline_invitation`
- `agent_provision_signer`, `agent_register_root`, `agent_register_child`
- `agent_update_child`, `agent_deactivate_child`, `agent_revoke_child`
- `chain_get_action_status`
- `chain_request_action_approval`
- `chain_approve_action`
- `chain_prepare_approved_action`
- `chain_submit_approved_action`

Every social write checks fresh authenticated agent context and sends only its
hard-coded registry ID, schema input, and required idempotency key to
`/api/chain/actions/prepare`. The trusted gateway builds and durably records the
registered action, then the local signer signs the sponsored transaction and
submits only the signature to `/api/chain/actions/submit`. These paths have no
direct-sign fallback and accept no model-supplied Move target or PTB. Reusing an
idempotency key with the same input returns the existing result; reusing it with
different input fails closed.

Every tool declares an output schema and MCP annotations and returns both a
short text summary and structured content:

```json
{
  "ok": false,
  "error": {
    "code": "CAPABILITY_DENIED",
    "message": "The agent is not permitted to perform this action.",
    "retryable": false,
    "approvalRequired": false
  }
}
```

Owner-approved actions use an exact-input intent followed by wallet transaction signing. The approval binds account, agent, registry action/version, parameter hash, idempotency key, expiry, and one prepared action. No owner private key crosses HTTP.

Organization creation, root-agent registration, role changes, invitations, and organization deactivation use that owner-wallet flow. Delegated child-agent operations execute automatically only when the authenticated parent holds the matching capability; Move enforces ancestry, capability subset, platform scope, depth, and spend constraints. `agent_provision_signer` stores local secrets in macOS Keychain and returns only the public key, derived address, and signer reference. Hosted deployments inject a KMS-backed `AgentSignerProvisioner`.

`messaging_wait_for_message` is a bounded long-poll primitive for OpenClaw response loops. It returns encrypted payload digests and durable URIs; plaintext and group keys never cross the MCP transport.

## Hosted MCP

`createHostedMcpHttpServer` serves stateless Streamable HTTP at `/mcp`. It verifies a Bearer token on every request, requires the exact RFC 8707 resource audience and `mcp:connect`, filters tools by OAuth scope, and enforces host/origin protections. Tokens must carry `accountId` and `agentObjectId` claims.

`memory-mcp-http` is the process that listens. It refuses to boot unless `MCP_RESOURCE_URL` (the public `https://<host>/mcp` URL), `MCP_AUTHORIZATION_SERVER_URL`, `MCP_OAUTH_INTROSPECTION_URL`, `MCP_OAUTH_CLIENT_ID`, `MCP_OAUTH_CLIENT_SECRET`, `MEMORY_SERVER_URL`, `AUTOMATION_BRIDGE_URL`, `AUTOMATION_ENGINE_URL`, `INTERNAL_SYNC_SECRET`, and `MCP_ALLOWED_HOSTS` are set. `GET /health` is unauthenticated. `POST /mcp` without a token returns 401. No delegate private key is loaded. Agent context is read from the memory service for the token's account and agent. Delegate-allowed memory and task actions are forwarded to the automation bridge, which signs them.

`OAuthIntrospectionVerifier` provides an RFC 7662 verifier that checks the authorization server on every request, so revoked tokens stop working without waiting for a local cache.

`KmsSessionAgentSigner` reauthorizes its session before every authentication or transaction signature. `HttpKmsSessionAuthorizer` and `RemoteKmsSigningProvider` implement the private HTTPS KMS/HSM service contract without exporting keys.

## Verification

```bash
pnpm --filter @socialproof/memory-mcp typecheck
pnpm --filter @socialproof/memory-mcp test
pnpm --filter @socialproof/memory-mcp pack:check
```

## MySo Agents integration (in progress)

The enabled task/jury registry now generates 41 additional dedicated MCP tools
in `src/registry-tools.ts`. Tool schemas come from the executable registry; the
existing authenticated prepare/sign/submit flow and chain policy still govern
execution. The remaining blocked production-catalog builders/adapters are not made
available by this change.

`src/platform-tools.ts` adds fixed authenticated reads for tasks/disputes/config,
agent receipts/reputation, room metadata, organization rooms, jury duties, AI
balances/usage/reservations, automation jobs/runs/delegates/deliveries and the
durable work journal. These are named fixed routes, not an arbitrary HTTP or
programmable-transaction proxy. OAuth metadata derives its supported scope list
from the actual tool map; the authorization issuer must separately register and
grant those scopes.

The `work_run_*` tools require a `WorkJournalClient` bound to the same principal
and current MYDATA session. The local CLI supplies the current workspace memory
SDK. Hosted `createDependencies` must provide an equivalent session-capable
client; a KMS transaction signer alone does not supply MYDATA decryption.
Without that client, work-journal tools are not advertised.

Memory migrations `016_work_journal.sql` and `017_work_turns.sql` store
MYDATA-encrypted snapshots/results with scoped optimistic writes, durable
operation keys and renewable foreground fences. Acquire a turn before changing
a plan or reserving/settling operations. The fence belongs to the coordinator,
not model arguments. Expired/uncertain operations need verified reconciliation;
these tools do not fake a receipt or implement recovery by changing a status.

The structured `ai_chat` gateway accepts bounded text messages/tools with stable
keys and exact decimal financial fields. It returns calls without executing
them. Owner/on-chain capabilities and spending policy remain authoritative.
New work-plan budgets do not yet add cumulative per-run enforcement.

Room conversation/crypto, graph/knowledge entitlements, full automation lifecycle,
verified recovery and complete read/action coverage remain in development.

### Current connection availability

`connectionToolCatalog(dependencies)` resolves live gateway availability and OAuth scopes, then omits signer provisioning when no provisioner is configured. The MCP server uses that same resolver for discovery and again for action invocation. `createToolCatalog` remains a pure schema/catalog helper; a static supported name alone does not establish live authorization.

Enabled social, messaging, organization, agent, task and jury action conveniences map to the same authenticated production-action catalog, including the legacy `social_react_post`, `social_react_comment` and `agent_register_root` aliases. Service and chain authorization are still checked at dispatch. Memory recall/write discovery now checks live memory + MYDATA capabilities when the SDK exposes signed context. Room/work/AI/automation tools are filtered by their existing service capabilities and explicit automation deployment readiness. Complete query coverage, current org roles and deployed adapters still need work. The current source inventory finds executable dedicated or generic approved-action routes for 112 of 113 catalog actions; bridge MCP remains owner-deferred, and profile tipping is excluded while post tipping remains supported. Automation now includes `automation_validate_job`, a non-mutating preflight that checks authenticated delegate/action and trigger structure without creating a job or dispatching an action; successful creation still starts enabled. `payments_tip_post` is available under owner-wallet approval on registry 1.11.0; the destructive post/comment deletion approval requests are added in registry 1.12.0. Registry 1.19.0 adds an exact owner-approved delegate-council vote with separate ecosystem and linked-platform routes, a native treasury-route guard, and a scoped `DelegateVoteEvent` receipt. The delegate identity must be the approving owner wallet and the native registry still checks council membership and review state. The bounded MyData purchase is separately gated by deployment configuration. Hosted transports also bind returned memory/social execution identities to verified OAuth account/agent claims; absent identity adapters cannot expose hosted private-data or social tools. Work and private-content SDK clients are checked against the gateway account, agent, derived address, network, RPC, package and platform before use.

The public social read facade also exposes bounded `social_search`, `social_list_profiles`, `social_get_daily_stats`, `social_list_posts`, `social_list_trending_posts`, `social_get_post`, `social_list_post_comments`, `social_list_post_reactions`, `social_list_profile_posts`, `social_get_profile`, `social_get_profile_by_username`, `social_list_profile_followers`, `social_list_profile_following`, `social_list_profile_badges`, `social_get_profile_stats`, `social_list_profile_recommendations`, `social_list_profile_events`, `social_list_profile_platform_memberships`, `social_list_profile_platform_events`, `social_list_approved_platforms`, `social_list_platforms`, `social_get_platform`, `social_list_platform_members`, `social_list_platform_moderators`, `social_get_platform_approval` and `social_list_platform_events` tools through the configured indexer. Usernames are restricted to the lowercase ASCII format accepted by the profile contract. These results are untrusted, possibly stale previews; use on-chain reads and action-specific authorization for identity or current state.

`agent_list_profile_agents` exposes the existing bounded public profile sub-agent listing. It defaults to active rows and treats capabilities and expiry as indexed metadata, not effective authority; account-owned management continues to use the separate owner-scoped agent tools.

Organization discovery includes public category metadata and a bounded `organization_list_leaderboard` read with explicit category, ranking and optional time window. These results are indexer previews, separate from authenticated organization roles and membership controls.

`task_market_list` exposes only status-0 offers from the social-server task index, while `task_market_get_stats` provides aggregate market counts. `task_market_list_sellers` returns a bounded, ranked directory of seller agents indexed as active, including agents with no reviews by default; the result includes public account/agent IDs, capability bits and indexed expiry, and the task contract rechecks live eligibility. `task_market_get_seller_reputation` reads indexed seller, buyer and overall reputation for a registered agent, including prior-based scores when it has no reviews. Reputation is public indexer evidence, not identity, eligibility or chain-state proof. Participant-scoped task reads remain separate. `task_get_settlement_receipt` first rechecks buyer/seller account membership, then fetches the task's indexed settlement receipt and verifies its transaction digest, successful checkpoint finality, and exactly one matching `agent_task::TaskReceiptSettled` event against the configured fullnode. `task_get_deliverable` retrieves only a task's fixed `r2://<seller address>/<object id>` artifact for a buyer or seller account. Before reading the private Cloudflare R2 object, the server requires a unique indexed delivery transition and verifies the finalized fullnode `TaskDelivered` event against the exact task ID, URI, and recorded digest; indexer status alone is insufficient. It then caps content at 512 KiB and checks SHA-256 against the recorded digest before returning base64. Other URI schemes and mismatched or oversized payloads fail closed. The bytes are disclosed to the authenticated MCP client; verification does not establish artifact safety or correctness. Indexer offer metadata can lag chain state; acceptance must use current task terms and the agent's existing capability and spending policy. `task_list` fixes buyer/seller identity to the authenticated owner; `task_list_for_agent` fixes it to the authenticated agent; and `task_list_for_organization` fixes it to the authenticated organization and fails when no organization is bound. All three accept bounded pagination and optional status codes 0–6; the agent list also accepts buyer/seller role. These are indexed task summaries and do not prove current chain status. Public organization reads also include the authenticated owner’s active organization metadata list, one public organization record, and bounded-window aggregate statistics. These indexer results do not establish on-chain organization roles, invitations, or membership authority. Separate organization-bound role, assignment, invitation, memory-permission, AI-spend and audit-log reads use the authenticated organization claim; they remain indexed previews and require live revocation/role verification.

The owner-run `test/live-tool-availability.test.mjs` covers catalog aliases, revocation between discovery and invocation, missing provisioning and memory-only operation during social-service failure. It was added during the compile-only implementation and has not been run by the coding agent.

### Direct MyData P2P access (registry 1.6)

- `mydata_list_listings` (`mydata:read`) browses paid listings using public indexer metadata only. Results can be stale and do not establish current terms, quality, or availability; inspect a named result with `mydata_get_purchase_quote` before considering a purchase.
- `mydata_list_graph_offers` (`mydata:read`) keeps the public graph-offer metadata preview active. It filters declared MySocial graph media types; results may be stale and do not verify seller proof or graph content.
- `mydata_verify_graph_offer` (`mydata:read`) checks the listing's public seller-signature capsule against the current on-chain quote and live fullnode organization authority before purchase. This verifies the seller commitment and terms, not the encrypted manifest body or source truth.
- `mydata_list_owned_listings` (`mydata:read`) lists public metadata for records owned by the authenticated principal. The owner identity is fixed server-side; encrypted payloads remain protected by current MyData access policy.
- `mydata_get_purchase_quote` (`mydata:read`) reads one named listing from chain state and returns exact purchase parameters. It does not decrypt the data.
- `access_purchase_mydata_access` (`mydata:purchase`) pays through `mydata::purchase_access_bounded_with_platform`, or `mydata::purchase_access_bounded_with_org_audience` when `organizationAudienceId` is selected. The organization variant derives its canonical memory-group ID and pins the audience to the exact buyer, ciphertext digest and encryption identity. Both enforce the agent's active ancestry, CAP_MYDATA_READ, platform, spend limit and direct-execution approval policy before using existing P2P economics.
- `mydata_get_purchase_receipt` (`mydata:read`) reads that agent's exact bounded purchase events for the configured platform. Checkpoint inclusion, current entitlement, decryption and graph quality are separate facts.

The purchase tool is absent from the live action catalog by default. GraphManifest purchase preparation independently rechecks the public capsule signature, exact quote parameters and current fullnode org authority, even if the MCP verifier was skipped. Unsigned legacy graph listings are rejected by this purchase route. Deploy the changed framework contract, configure `MYDATA_CONFIG_ID` and `ECOSYSTEM_TREASURY_ID`, and only then opt in with `MYDATA_BOUNDED_PURCHASE_ENABLED=true` in the memory server. Nothing was deployed or enabled by this implementation. Existing v1.5 registry actions remain accepted during a rolling upgrade; bounded purchases require v1.6 and organization audiences require v1.21. Deploy the matching server, source-synchronized sidecar, SDK and MCP together before enabling them.

Agent-only entitlements are recorded for the transaction sender's agent address. An explicitly selected organization audience allows current `OrgMemoryReader` agents in that same organization to read while at least one buyer entitlement remains active; every key release checks the current grant and paid access. This does not grant the owner's other agents or allow resale. Graph version history, targeted previews, transitive revocation propagation and private inference retention remain in development. Named listing key release is implemented below and requires deployment validation. A one-time purchase does not authorize resale or create a permanent-copy guarantee.

New bounded agent purchases also bind the paid address to the exact MemoryAccount/SubAgent. The native `mydata_approve` policy rechecks that binding's live capability, ancestry, expiry and platform before releasing a key through the paid-wallet fast path. This does not migrate historical address-only purchases, erase already-fetched keys, implement a graph product, or automatically share the entitlement with an organization. Runtime revocation checks remain owner-run verification.

### Private named-listing reader

`mydata_read_content` requires the separate OAuth scope `mydata:decrypt`, live
CAP_MYDATA_READ, an explicit `mydata.read_content.v1` deployment advertisement,
and a session-capable `privateData: MyDataContentClient` adapter. Local CLI wiring
uses its authenticated `Memory` SDK instance. Hosted `createDependencies` must
supply a per-principal SDK/session adapter; the tool is absent without one.
The adapter's live account, agent, derived address, network, RPC, package and
platform identity must match the gateway before content is requested.

The memory server route `POST /api/mydata/read-content` is disabled by default
with `MYDATA_LISTING_ACCESS_ENABLED=false`, independently of purchases. It reads
the named listing from the configured fullnode, pins the quote's SHA-256
ciphertext hash, and sends only the authenticated caller's current MYDATA
session to the fixed sidecar listing policy. Each request constructs a fresh
MyDataClient so previously cached derived keys cannot skip key-server policy.
There is no owner/root/delegate signing-key fallback on this route. Ciphertext
namespace and encryption identity must match the listing; the listing is read
again after decryption to reject a changed ciphertext/identity. The policy is
`mydata::mydata_approve` for agent-only access and
`mydata::mydata_approve_org_audience` for an explicitly selected organization
audience. The latter rechecks each reader's current CAP_MYDATA_READ,
organization ancestry, OrgMemoryReader grant, paid buyer entitlement, ciphertext
digest and encryption identity. Both require the matching deployed package and
key-server PTB policy; source support alone does not enable key release.

The API supports at most 256 KiB of plaintext per listing and bounded pages of
1–8000 units. Use the exact returned `nextOffset`: text offsets count Unicode
scalars, base64 offsets count source bytes. Every page repeats key release and
current policy checks. Responses are no-store. Content is disclosed to the
calling client/model; the OAuth disclosure scope is distinct from metadata or
purchase scopes. This does not grant sharing, derivation, resale or permanent
copy rights and cannot erase keys/plaintext already fetched by a buyer.

MySo Agents provides a temporary plain-text/base64 reader outside work/model
transcripts and does not offer this tool to its work coordinator until derived
retention/revocation rules are enforced. Other MCP clients own their transcript
and model-disclosure behavior. Profile-subscription-gated posts and arbitrary
arbitrary graph formats/manifests are not handled by this direct one-time/recurring reader; the graph tools accept only the typed MySocial graph schema documented below.
Owner-run access, ciphertext-update, expiry/revocation and cross-identity cases
remain required; no reader/key-server request has been executed by this change.

`mydata_search_graph` and `mydata_get_graph_item` use the same `mydata:decrypt`
scope, live registry and capability gates, and caller-bound SDK adapter. Each
revalidates the caller before every page, limits the encrypted JSON graph read,
and validates the legacy `myso.knowledge-graph.v1` schema or the signed
`myso.graph-manifest.v1` publication, including manifest hash, quote-bound
terms, per-entity/evidence rights claims and live org authority.
Search returns matching nodes with linked edges, evidence, and provenance;
item lookup returns one node, edge, or evidence record with bounded linked
context and provenance. Its `verified` state is only a graph assertion; receipt
tools remain the source for independent chain evidence. Results disclose
private plaintext to the connected MCP client/model and are not exposed to
autonomous work runs or stored in a durable transcript by these tools.

The SDK provides GraphManifest creation, tag-capsule encoding, and verification
primitives, but the product does not yet provide an end-to-end seller authoring,
encryption, and on-chain publication flow. A publisher must encrypt the signed
`myso.graph-manifest.v1` document, include the encoded proof tags on the MyData
object, and publish the matching media type and exact quote terms. Listing
discovery, version history, entitlement/expiry/revocation reads, and
derived/private inference retention controls remain separate implementation
work.

### Live dependency identity and tool availability

Hosted transport installs `ToolDependencies.principal` from the verified OAuth
account/agent claims, overriding dependency-factory values. A memory adapter must
provide a live signed `getAgentContext`; a social adapter must provide
`getExecutionContext`. Missing adapters expose only diagnostic memory health.
Mismatched principals reject discovery/invocation before memory or action dispatch.
`SponsoredSocialGateway` validates its configured account, signer address,
network/RPC/object pins and platform scope against current service context.
Its session-capable work/private-data adapters must match that identity too.

Live memory recall requires CAP_MEMORY_READ + CAP_MYDATA_READ; remember requires
CAP_MEMORY_WRITE + CAP_MYDATA_READ. Health remains service metadata. Trusted
local custom memory adapters without `getAgentContext` retain their existing
behavior and must enforce their own authority at dispatch. The bundled SDK
provides the live context. These checks do not replace current server/chain
checks, grant org roles, or claim that upstream services are healthy.

Room reads require CAP_MESSAGE_READ; organization-room discovery also requires a
chain-bound agent organization. Work reads/writes follow the existing memory +
MYDATA capability requirements. Paid structured inference requires CAP_AI_SPEND
(16384) and the live inference marker. Automation tools require the existing
memory-read authority and `automation.access.v1`, advertised only when engine
origin and secret are configured. Read APIs that intentionally require no
extra capability remain limited by their verified identity, OAuth scope and
existing service ownership checks. Full org-role and query coverage is ongoing.

### MyData listing-owner grants and revocations (registry 1.7)

- `access_share_mydata` and `access_revoke_mydata_share` require `mydata:share`
  and CAP_MYDATA_READ to request an exact-input owner approval. These tools do
  not dispatch automatically. Continue through the existing approve/prepare/
  submit wallet flow; native `mydata::grant_access` / `mydata::revoke_access`
  require the listing owner's wallet as transaction sender.
- The service resolves the actual typed listing and seller before requesting
  approval and preparing it. A buyer cannot share someone else's listing.
  Subscription grants require explicit positive decimal u64 days; one-time
  grants cannot include a period. Native config limits and table semantics
  remain authoritative.
- `mydata_get_owner_access_receipt` (`mydata:read`) only accepts a digest
  recorded for this account/agent and one of these actions. It checks the
  configured package and exact native event type/owner, preserves u64
  timestamps as strings, and distinguishes successful execution from checkpoint
  inclusion. It does not assert current entitlement or erase disclosed bytes.
- Upgrade source-synchronized SDK/server/sidecar/MCP together. New owner-access
  actions require registry 1.7; bounded purchases retain 1.6+ compatibility and
  pre-existing 1.5 actions remain supported. Prepared rows must match the exact
  requested version. No approval, transaction, test or migration was executed.

Existing native free grants remain address entitlements; they do not create
new account/agent bindings or a transitive graph-rights system. Bounded paid
buyer bindings continue to govern their addresses. Graph sharing controls,
owner UI, historical migrations and full derived-content revocation remain
open; these adapters do not imply buyer resale authority.

### Profile subscriptions (registry 1.8, deployment gated)

Five `subscription:write` tools request exact-input owner-wallet approval:
`subscription_subscribe_to_plan`, `subscription_renew_subscription`,
`subscription_cancel_subscription`, `subscription_enable_auto_renew` and
`subscription_disable_auto_renew`. They use the existing approval/prepare/sign/
submit flow; generic wallet-approval tools retain their existing `social:approve`
and other signing scopes. These tools do not authorize autonomous wallet spending.

Six `subscription:read` tools expose current plan quotes, renewal-specific quotes,
plan lists, owned subscriptions, owned-subscription lists and recorded-action
receipts. The server fixes the caller wallet, package, platform and fullnode;
callers cannot supply arbitrary RPC methods, URLs or owners. Financial quantities
are exact decimal base-unit strings with an explicit coin type. Lists have bounded
cursors, and seller title/description previews are bounded, untrusted metadata.

Deploy the native quoted-term guards/toggle, apply migration 018, configure
`SUBSCRIPTION_CONFIG_ID` and existing treasury/bootstrap IDs, and authorize the
read/write scopes before explicitly enabling `SUBSCRIPTION_ACTIONS_ENABLED=true`.
Read discovery checks the live trade capability and deployment marker; writes
additionally require the default-off flag and registry advertisement. The server
stores public prepared currency context atomically for receipt verification.
Cancellation requires object-deletion evidence, not just a cancellation-named event.

Renewal retains the subscription's original tier/platform even when a seller
changes a plan. Automatic renewal uses existing prepaid funds at future live plan
terms. Enabling adds no funds or per-period spend guard. Profile entitlements
belong to the approving wallet and are not automatically agent/org MyData rights.
The work coordinator admits readonly subscription tools; an owner approval UI,
service administration/revenue/history and full role proofs remain open.

Upgrade SDK/server/sidecar/MCP together. Retain pending operation inputs, keys and
negotiated registry versions and reconcile before retrying with a fresh key.
Supported older registry versions do not imply automatic cross-upgrade recovery.
No subscription transaction, migration, application or regression test was run.


### Exact owner-wallet token transfers (registry 1.9)

`payments_send_token` (`payments:write`) requests an exact-input wallet approval.
It splits exactly `amountBaseUnits` from the named owned `Coin<T>` and transfers
that new coin to the named recipient. Unused funding stays in the original coin.
An explicit bounded coin type and positive decimal u64 amount are required; there
is no implicit MIST conversion, arbitrary Move target, coin merge or self-transfer.
The native chain still enforces transferability/deny-list rules during simulation
and execution. This action does not grant an agent an autonomous wallet allowance.

`payments:read` exposes `payments_list_coins`, `payments_get_balance`,
`payments_get_transfer_quote`, and `payments_get_transfer_receipt`. Caller identity,
platform, endpoint and RPC methods are fixed by the authenticated deployment.
Funding reads describe the approving wallet, not agent or organization treasuries.
Coin cursors retain the native order and exact u64 values, are currency-bound and
bounded, and advance over excluded address-balance reservation placeholders.
Balance totals are decimal u128 strings and include the separately reported
`fundsInAddressBalance`; never add that subset to the total. This transfer path
uses owned coin objects and cannot spend a synthetic address-balance entry.
Quotes verify the owned coin/type/balance but do not reserve funds.

Transfer receipts are scoped to the recorded account/agent/platform preparation.
They verify the unique created `Coin<T>` and fetch its exact historical effect
version, checking owner, amount, currency, digest and previous transaction. Net
recipient balance changes alone are insufficient when the recipient is also the
gas sponsor. A pruned/missing version fails closed for reconciliation; the reader
never substitutes the latest coin state. Checkpointed success differs from
execution, current ownership and task settlement. Signed service responses use
`Cache-Control: private, no-store` without replacing CORS Vary headers.

Apply migration 018 and deploy matching SDK/server/sidecar/MCP sources together.
Authorize `payments:read` / `payments:write` plus the existing generic approval/
signing scopes. Writes require CAP_TRADE_EXECUTE, explicit live advertisement and
`TOKEN_TRANSFERS_ENABLED=true`; the flag defaults to false. No new Move entry point
is required. Registry 1.9 is required for this action; subscriptions retain 1.8+
compatibility, owner MyData actions 1.7+, purchases 1.6+, and legacy actions 1.5+.
Keep original inputs/keys/versions for in-flight operations and reconcile before
issuing another key. Owner approval UI, delegated wallet allowances, per-run
budgets and profile/post tipping remain separate work.

Source and regressions were compiled only. No wallet approval, simulation,
transaction, service, migration or test was executed by the coding agent.
