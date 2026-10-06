# Passkey-backed agent keys

This implementation keeps zkLogin as the on-chain human identity and uses a separate WebAuthn PRF passkey to unlock encrypted agent-key backups. No backend receives the PRF output, recovery root, or agent signing seed. `SIDECAR_AUTH_TOKEN` authenticates private verification calls only.

The server owns authorization and ciphertext persistence. The browser owns passkey ceremonies, secret derivation, decryption, and signing. The frontend and device must be trusted; ciphertext storage cannot protect against malicious frontend delivery.

## Local configuration

The feature is off by default. Enable only after completing your verification:

Memory server:

```dotenv
ENABLE_AGENT_KEY_BACKUPS=true
PASSKEY_RP_ID=localhost
PASSKEY_ALLOWED_ORIGINS=http://localhost:5173
KEY_BACKUP_SERVICE_ORIGIN=http://localhost:8000
ALLOWED_ORIGINS=http://localhost:5173
ALLOW_LEGACY_DELEGATE_KEY_FORWARDING=false
ALLOW_LEGACY_SOCIAL_KEY_FORWARDING=false
```

Chat app:

```dotenv
VITE_AGENT_KEY_BACKUPS_ENABLED=true
VITE_MEMORY_SERVER_URL=http://localhost:8000
```

Keep the normal database, Redis, chain, social-index, MYDATA, inference, and sidecar settings. The key-backup feature does not configure those services. The chain identifier comes from the fullnode, not a network label. Use `localhost` consistently for browser testing; `127.0.0.1` is a different WebAuthn origin.

In production, use an immutable RP ID, exact HTTPS allowed origins, and an exact backup-service origin. Wildcards, nonlocal HTTP origins, and private-key forwarding are rejected. Test and production roots are chain/account/credential bound and are not interchangeable.

The chat app's dependency points to the local Memory SDK at `file:../../myso-memory/packages/sdk`, version 0.0.6. Vite, TypeScript, and Vitest resolve its entry points directly to the working SDK source through `chat-app/local-memory-sdk.ts` and matching TypeScript paths. The local SDK is excluded from dependency prebundling, so source changes do not require an SDK rebuild or package reinstall to appear in Chat App. Restart Vite after changing the resolver configuration. Other SDK consumers still use built `dist` files; no package has been published.

## Cryptographic contract

- Algorithms: AES-256-GCM with fresh 12-byte nonces and a 16-byte tag; HKDF-SHA256 derives 32-byte keys.
- Secret inputs: a 32-byte WebAuthn PRF output for root wrapping, or the random 32-byte recovery root for agent encryption.
- Each envelope has a fresh public 32-byte HKDF salt.
- HKDF info is the complete fixed-order BCS AAD; its first field is the purpose domain.
- Domains: `mysocial:agent-root-wrap:v1`, `mysocial:agent-key-envelope:v1`, and `mysocial:agent-draft-envelope:v1`.
- Transport uses canonical unpadded base64url; addresses/object IDs are lowercase 32-byte hex with `0x` prefix. Revisions are positive u32 values.
- Ciphertext contains the GCM tag at the end. A 32-byte seed/root produces 48 ciphertext bytes.
- Drafts use the zero agent object ID until finalization. Finalization performs fresh encryption under the final SubAgent binding.
- Registration intent is public but its BCS digest is authenticated in agent AAD. It is saved atomically with the draft and verified before any retry or budget setup transaction. A null intent has the zero digest.
- Signing scheme is explicitly `Ed25519` and authenticated in agent AAD. Signing seeds are random Ed25519 seeds. OAuth claims, salt-service values, zkLogin ephemeral keys, tokens, and service secrets are never derivation inputs.

`packages/sdk/test/agent-key-envelope-vectors.json` publishes fixed BCS/HKDF reference data using a public RFC8032 key. Its ciphertext is an AAD-only placeholder; it is not a decryptable test envelope. All vector values are public test material.

Secret arrays and references are cleared when the vault locks. JavaScript/keypair-library copies cannot be guaranteed to disappear from the heap. Nothing intentionally persists unlocked secrets in browser storage or React Query.

## API and ownership

Owner challenges bind service origin, chain, owner, account, purpose, nonce, and five-minute expiration. They are consumed atomically with Redis GETDEL. Verified native/zkLogin personal-message signatures establish a 15-minute owner session. zkLogin verification checks the epoch and the expected address through the configured fullnode.

Passkey registration and assertions verify RP, origin, challenge, and required user verification using the Node sidecar's SimpleWebAuthn verifier. Server-side DTO validation rejects client extension outputs. A verified assertion creates an additional account/credential-bound 15-minute vault authorization. Credentials remain inactive until a matching encrypted root wrapping record is saved.

Owner session: `Authorization: Bearer ...`. Vault authorization: `x-vault-token`. Both are transient authorization tokens and cannot decrypt backups. Owner-only credential discovery reveals public PRF inputs and credential IDs. Access to encrypted keys requires an active vault credential. Account ownership is rechecked against the canonical MemoryAccount on every account request.

Routes:

- `POST /api/owner/auth/challenge`, `POST /api/owner/auth/verify`
- `GET /api/accounts/{account}/passkeys`, `DELETE /api/accounts/{account}/passkeys/{credential}`
- `POST /api/accounts/{account}/passkeys/{registration|authentication}/{options|verify}`
- `GET|PUT /api/accounts/{account}/recovery-root`
- `GET /api/accounts/{account}/agent-key-envelopes`
- `GET|PUT|DELETE /api/accounts/{account}/agents/{agent}/key-envelope`
- `GET /api/accounts/{account}/agent-key-drafts`
- `GET|PUT|DELETE /api/accounts/{account}/agent-key-drafts/{key}`
- `POST /api/accounts/{account}/agent-key-drafts/{key}/finalize`
- `GET|PUT /api/accounts/{account}/agent-key-drafts/{key}/intent`
- `GET /api/accounts/{account}/agent-key-setups`
- `GET|PUT /api/accounts/{account}/agents/{agent}/key-setup`

Root/envelope creation uses `If-Match: 0`; replacements/deletions use the previous revision. These checks prevent concurrent stale writes; they do not establish rollback protection against a malicious storage service on a fresh device. Public registration intent is write-once/idempotent. The intent preserves label, exact capability/delegation request, parent, expiry, and optional decimal-string budget settings. Setup state is informational and never confers authority.

Envelope access verifies package/type, owner, account, organization, public key, and derived address against the chain. Agent capabilities, scope, ancestor activity, approval constraints, and expiry come from canonical chain objects for normal Memory authorization; the social index is used for discovery. Organization memory sharing retains its existing 30-second permission cache; it never authorizes backup access.

## Chat app lifecycle

1. Sign in with the existing human identity.
2. Enroll/unlock a PRF-compatible passkey through Agent backups. Enrollment includes a fresh assertion and local encryption/decryption check.
3. Before registration, save an encrypted random-key draft and public registration intent.
4. Register using existing root/delegated Move operations.
5. Confirm the SubAgent object, finalize its bound encrypted envelope, and transfer its setup intent atomically.
6. Ensure its memory vault and optional budget; record completion separately.
7. Retrieve/decrypt by SubAgent object ID for memory, settings, chat creation, child registration, and replies. Never scan deterministic key indexes.

Use **Incomplete setups** to recover registered drafts or finish vault/budget setup. For an unregistered draft, open New Agent and select that saved setup; the original registration intent is reused. A fullnode registry lookup precedes retries so delayed indexing cannot create a second signing identity.

Normal agents default to the Messenger capability set with no delegation. Enabling child creation/delegation is explicit. If a parent lacks the requested child grant, the owner must approve that precise update. Existing approval/spend/platform/identity/role constraints are preserved when updating policy.

Agent key possession does not restrict transactions outside Move entrypoints that enforce these policies. Do not put root wallet assets into agent addresses.

## Recovery and migration

Add a backup passkey while an existing passkey still works. Each credential gets an independent encrypted wrapping of the same root. Removing a credential must be authorized with another active credential. It does not delete that passkey from the user's password manager and cannot invalidate previously downloaded ciphertext.

Supported cross-device recovery requires the same credential and stable PRF output for the same public input. iCloud Keychain availability does not itself prove PRF interoperability. There is no OAuth/password/server-secret fallback. Losing all usable credentials means existing backups are inaccessible; wallet ownership alone cannot recreate the root.

Existing locally generated, never-shared keys can be imported explicitly in agent details. Service-derived or server-exposed keys require replacement. Create a replacement root in another organization, verify it, then revoke the old agent. Existing chats, private memories, descendants, permissions, and approvals are not silently migrated.

The legacy Memory app's account/delegate-key setup is gated. Noter rejects private-key/address-only Enoki login, no longer selects/writes/returns `users.delegatePrivateKey`, and cannot sign user Memory requests on the server. The Noter migration expires old Enoki sessions. Historical database columns/backups are deliberately retained for separately scheduled retirement; enabling this feature does not erase that historical exposure.

Migration 014 is additive and registered in the Rust startup migration list. Migration 012 is also registered to repair action-approval initialization. Never roll back by dropping encrypted recovery records.

The production build adds a vault CSP without external scripts or eval. Configure additional exact MYDATA key-server/websocket origins with `VITE_PASSKEY_CONNECT_ORIGINS`. Deploy equivalent HTTP headers, including `frame-ancestors 'none'`; meta policies cannot supply that directive.

## Commands for the developer to run

These commands are documentation, not automatically executed by this feature:

```sh
# myso-memory
pnpm --filter @socialproof/memory build
pnpm --filter @socialproof/memory test
cargo test --manifest-path services/server/Cargo.toml

# chat-app (Vite and TypeScript consume the local SDK source directly)
corepack pnpm install --force
corepack pnpm build
corepack pnpm test
corepack pnpm exec playwright install chromium
corepack pnpm test:browser
```

The ignored Rust integration test requires dedicated pgvector PostgreSQL and Redis instances:

```sh
TEST_KEY_BACKUP_DATABASE_URL=postgresql://USER:PASSWORD@localhost:PORT/agent_key_backup_test \
TEST_KEY_BACKUP_REDIS_URL=redis://localhost:REDIS_PORT \
DATABASE_URL=postgresql://USER:PASSWORD@localhost:PORT/agent_key_backup_test \
MEMORY_PACKAGE_ID=0x1 PASSKEY_RP_ID=localhost \
PASSKEY_ALLOWED_ORIGINS=http://localhost:5173 \
KEY_BACKUP_SERVICE_ORIGIN=http://localhost:8000 \
cargo test --manifest-path services/server/Cargo.toml key_backup_integration -- --ignored
```

Use a fresh test database per run. The test checks migrations, challenge replay, activation, scope denial, revision conflicts, secret-field rejection, and draft finalization against real PostgreSQL/Redis with fixture chain/verification responses.

The browser harness uses actual Chromium WebAuthn PRF ceremonies and the actual sidecar verifier with fixture storage/chain responses. It does not establish real iCloud interoperability or exercise live Move/messaging/inference services.

Before release, run a localnet walkthrough with the real services: create root/child, ask memory, post agent reply, refresh/logout/recover, reduce permissions, and revoke between prepare/submit. Separately verify cross-device recovery with real iCloud passkeys and the supported browser/provider matrix. The final code edits have not been built or tested following the user's request to perform code edits only.

Scoped HTTP requests also sign `mysocial-request-platform-v1|{platformId}|{canonicalRequest}` in `x-platform-signature`. The server rejects an unsigned or altered platform header; Memory, sub-agent, and MCP clients have been updated together. This authenticates the agent's requested context, not membership in a trusted external platform. Move action bodies and on-chain platform checks remain authoritative. Older clients that transmit `x-platform-id` must upgrade before using the updated server.
