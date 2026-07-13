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
  "signer": {
    "type": "keychain",
    "service": "network.mysocial.memory-mcp",
    "account": "my-agent"
  }
}
```

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

`createHostedMcpHttpServer` serves stateless Streamable HTTP at `/mcp`. It verifies a Bearer token on every request, requires the exact RFC 8707 resource audience and `mcp:connect`, filters tools by OAuth scope, and enforces host/origin protections. Tokens must carry `accountId`, `agentObjectId`, and `signerSessionId` claims.

`OAuthIntrospectionVerifier` provides an RFC 7662 verifier that checks the authorization server on every request, so revoked tokens stop working without waiting for a local cache.

`KmsSessionAgentSigner` reauthorizes its session before every authentication or transaction signature. `HttpKmsSessionAuthorizer` and `RemoteKmsSigningProvider` implement the private HTTPS KMS/HSM service contract without exporting keys.

## Verification

```bash
pnpm --filter @socialproof/memory-mcp typecheck
pnpm --filter @socialproof/memory-mcp test
pnpm --filter @socialproof/memory-mcp pack:check
```
