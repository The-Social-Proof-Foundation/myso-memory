/**
 * memory — Core Types
 *
 * Ed25519 sub-agent key based SDK that communicates with
 * the Memory Rust server (TEE).
 */

// ============================================================
// Config
// ============================================================

export interface MemoryConfig {
    /** Ed25519 private key (hex string or Uint8Array). Sub-agent key registered on-chain. */
    key: string | Uint8Array;
    /** MemoryAccount object ID on MySo */
    accountId: string;
    /** Server URL (default: http://localhost:8000) */
    serverUrl?: string;
    /**
     * @deprecated Agent isolation is implicit via the authenticated sub-agent.
     * Use `subLabel` for optional tags within the agent vault.
     */
    namespace?: string;
    /** Optional tag within the authenticated agent's vault (maps to server `sub_label`). */
    subLabel?: string;
    /** Platform object ID — sent as `x-platform-id` when the sub-agent has `platform_scope`. */
    platformId?: string;
    /**
     * Owner Ed25519 private key for social delete co-sign and on-chain delete tx sender.
     * Signs the same canonical message as the sub-agent (`x-owner-public-key` / `x-owner-signature`).
     * Not used for memory writes or social creates in v1.
     */
    ownerCoSignKey?: string | Uint8Array;
}

// ============================================================
// API Types
// ============================================================

/** Result from remember() — async job accepted (HTTP 202) */
export interface RememberAcceptedResponse {
    job_id: string;
    status: string;
}

/** Result from waitForRememberJob() / rememberAndWait() */
export interface RememberJobResult {
    job_id: string;
    status: string;
    blob_id?: string;
    error?: string;
    agent_object_id?: string;
}

/** Options for remember job polling */
export interface RememberJobPollOptions {
    /** Poll interval in ms (default: 1500) */
    intervalMs?: number;
    /** Timeout in ms (default: 120000) */
    timeoutMs?: number;
}

/** Bulk remember accepted response */
export interface RememberBulkAcceptedResponse {
    job_ids: string[];
    status: string;
}

/** Bulk status item */
export interface RememberBulkStatusItem {
    job_id: string;
    status: string;
    blob_id?: string;
    error?: string;
}

/** Result from remember() — legacy sync shape (use rememberAndWait for final blob) */
export interface RememberResult {
    id: string;
    blob_id: string;
    owner: string;
    agent_object_id: string;
    sub_label?: string;
    /** @deprecated Use `agent_object_id` + optional `sub_label`. */
    namespace: string;
}

/** Write visibility for remember/analyze paths */
export type MemoryVisibility = "private" | "org" | "account";

/** Read scope for recall/ask paths */
export type RecallScope = "all" | "private" | "org" | "account";

/** Options for remember() / rememberBulk() / analyze() */
export interface RememberOptions {
    subLabel?: string;
    visibility?: MemoryVisibility;
}

/** A single recalled memory */
export interface RecallMemory {
    blob_id: string;
    text: string;
    distance: number;
    score?: number;
    /** 0 private, 1 org, 2 account */
    visibility?: number;
    source_agent_id?: string;
}

/** Result from recall() */
export interface RecallResult {
    results: RecallMemory[];
    total: number;
    dropped_count?: number;
    degraded_scope?: boolean;
}

/** Result from embed() */
export interface EmbedResult {
    vector: number[];
}

/** A single extracted fact */
export interface AnalyzedFact {
    text: string;
    id: string;
    blob_id: string;
}

/** Result from analyze() */
export interface AnalyzeResult {
    facts: AnalyzedFact[];
    total: number;
    owner: string;
}

/** Runtime compatibility metadata from GET /version */
export interface RelayerVersionMetadata {
    relayerVersion: string;
    apiVersion: string;
    minSupportedSdk: {
        typescript: string;
        mcp?: string;
    };
    featureFlags?: Record<string, boolean>;
}

export interface ScoringWeights {
    semantic?: number;
    recency?: number;
    recency_half_life_days?: number;
    importance?: number;
}

export interface RecallOptions {
    limit?: number;
    subLabel?: string;
    scope?: RecallScope;
    scoringWeights?: ScoringWeights;
}

/** Server health response */
export interface HealthResult {
    status: string;
    version: string;
}

// ============================================================
// Manual Flow Types — Lightweight (user provides pre-computed data)
// ============================================================

/** Options for rememberManual() on Memory class */
export interface RememberManualOptions {
    /** File Storage blob ID (user already uploaded encrypted data) */
    blobId: string;
    /** Embedding vector (user already generated) */
    vector: number[];
    /** Namespace (default: config namespace or "default") */
    namespace?: string;
    /** Optional sub-label within agent vault */
    subLabel?: string;
    visibility?: MemoryVisibility;
}
export interface RememberManualResult {
    id: string;
    blob_id: string;
    owner: string;
    namespace: string;
}

/** Options for recallManual() on Memory class */
export interface RecallManualOptions {
    /** Pre-computed query embedding vector */
    vector: number[];
    /** Max number of results (default: 10) */
    limit?: number;
    /** Namespace (default: config namespace or "default") */
    namespace?: string;
    /** Optional sub-label within agent vault */
    subLabel?: string;
    /** Read scope (default all visible tiers the agent may access). */
    scope?: RecallScope;
}
export interface RecallManualHit {
    blob_id: string;
    distance: number;
    visibility?: number;
    source_agent_object_id?: string;
}

/** Result from restore() */
export interface RestoreResult {
    restored: number;
    skipped: number;
    total: number;
    namespace: string;
    owner: string;
}

// ============================================================
// Full Client-Side Manual Flow — MemoryManual class
// ============================================================

/** Config for MemoryManual (full client-side: MYDATA + File Storage + embedding) */
export interface MemoryManualConfig {
    /** Ed25519 sub-agent private key (hex or Uint8Array) for server auth */
    key: string | Uint8Array;
    /** Server URL (default: http://localhost:8000) */
    serverUrl?: string;
    /**
     * MySo private key (bech32 mysoprivkey1...) for MYDATA + File Storage signing.
     * Provide EITHER this OR `walletSigner` — not both.
     */
    mysoPrivateKey?: string;
    /**
     * Connected wallet signer (e.g. from dapp-kit).
     * Use this when the user's wallet is already connected in the browser.
     * Provide EITHER this OR `mysoPrivateKey` — not both.
     */
    walletSigner?: WalletSigner;
    /**
     * Pre-configured MySo client instance (e.g. from dapp-kit's useMySoClient()).
     * If omitted, the SDK will try to create one internally.
     * Recommended for browser environments where @socialproof/myso v2.x removed MySoClient.
     */
    mysoClient?: any;
    /** OpenAI/OpenRouter API key for embeddings (required for client-side embedding) */
    embeddingApiKey: string;
    /** OpenAI-compatible API base URL (default: https://api.openai.com/v1) */
    embeddingApiBase?: string;
    /** Embedding model name (default: text-embedding-3-small) */
    embeddingModel?: string;
    /** Memory contract package ID on MySo */
    packageId: string;
    /** MemoryAccount object ID (for MYDATA approve_key_policy) */
    accountId: string;
    /** MySo network (default: mainnet) */
    mysoNetwork?: "testnet" | "mainnet";
    /**
     * Custom MYDATA key server object IDs (overrides built-in defaults per network).
     * Array of on-chain object IDs, e.g. ["0x..."].
     * If omitted, uses built-in defaults for the selected mysoNetwork.
     */
    mydataKeyServers?: string[];
    /**
     * MYDATA threshold — number of key server shares required for encrypt/decrypt.
     * Must be ≤ number of entries in mydataKeyServers.
     * Default: 2 (matches sidecar MYDATA_THRESHOLD default).
     */
    mydataThreshold?: number;
    /** File Storage storage epochs (default: 50) */
    fileStorageEpochs?: number;
    /** File Storage aggregator URL for direct blob downloads (default: mainnet aggregator) */
    fileStorageAggregatorUrl?: string;
    /** File Storage publisher URL for direct blob uploads (default: mainnet publisher) */
    fileStoragePublisherUrl?: string;
    /** Default namespace for memory isolation (default: "default") */
    namespace?: string;
}

/**
 * Wallet signer interface — pass a connected wallet adapter.
 * Compatible with @socialproof/dapp-kit's useSignAndExecuteTransaction.
 */
export interface WalletSigner {
    /** Wallet address (MySo address, 0x...) */
    address: string;
    /** Sign and execute a transaction, returns the digest */
    signAndExecuteTransaction: (input: {
        transaction: any;
    }) => Promise<{ digest: string }>;
    /** Sign a personal message (for MYDATA SessionKey) */
    signPersonalMessage: (input: {
        message: Uint8Array;
    }) => Promise<{ signature: string }>;
}

/** A recalled memory with decrypted text (from MemoryManual.recallManual) */
export interface RecallManualMemory {
    blob_id: string;
    text: string;
    distance: number;
}

/** Result from recallManual() — full client-side variant with decrypted text */
export interface RecallManualResult {
    results: (RecallManualHit | RecallManualMemory)[];
    total: number;
}

// ============================================================
// Sub-Agent Management Types
// ============================================================

/** Base options for on-chain memory transactions */
interface MemoryTxOpts {
    /** Memory contract package ID on MySo */
    packageId: string;
    mysoPrivateKey?: string;
    walletSigner?: WalletSigner;
    mysoClient?: any;
    mysoNetwork?: "testnet" | "mainnet";
}

/** Options for ensureMemoryAccount() */
export interface EnsureMemoryAccountOpts extends MemoryTxOpts {
    /** MemoryRegistry shared object ID */
    registryId: string;
    /** Profile object ID to link */
    profileId: string;
}

/** Result from ensureMemoryAccount() */
export interface EnsureMemoryAccountResult {
    digest: string;
    /** MemoryAccount object ID when created in this transaction */
    accountId: string;
}

/** Shared sub-agent registration fields */
interface SubAgentRegistrationFields {
    accountId: string;
    publicKey: Uint8Array | string;
    label: string;
    identityClass?: number;
    roleTags?: number;
    capabilities?: number;
    delegatableCaps?: number;
    registerScope?: number;
    /**
     * @deprecated Relayer does not enforce in v1; on-chain field reserved for v2.
     * Use `0` for autonomous agents. Non-zero values may still block on-chain social txs.
     */
    approvalRequiredCaps?: number;
    /**
     * @deprecated Relayer does not enforce in v1; on-chain field reserved for v2 spend policy.
     */
    maxActionSpend?: number | null;
    platformScope?: string | null;
    expiresAt?: number | null;
}

/** Options for createAgenticOrganization() */
export interface CreateAgenticOrganizationOpts extends MemoryTxOpts {
    accountId: string;
    label: string;
    orgType: number;
}

/** Result from createAgenticOrganization() */
export interface CreateAgenticOrganizationResult {
    digest: string;
    organizationId: string;
}

/** Options for updateAgenticOrganizationLabel() */
export interface UpdateAgenticOrganizationLabelOpts extends MemoryTxOpts {
    accountId: string;
    organizationId: string;
    label: string;
}

/** Options for updateAgenticOrganizationCategory() */
export interface UpdateAgenticOrganizationCategoryOpts extends MemoryTxOpts {
    accountId: string;
    organizationId: string;
    orgType: number;
}

/** Options for deactivateAgenticOrganization() */
export interface DeactivateAgenticOrganizationOpts extends MemoryTxOpts {
    accountId: string;
    organizationId: string;
}

/** Options for registerSubAgent() */
export interface RegisterSubAgentOpts extends MemoryTxOpts, SubAgentRegistrationFields {
    organizationId: string;
}

/** Options for registerSubAgentDelegated() */
export interface RegisterSubAgentDelegatedOpts extends MemoryTxOpts, SubAgentRegistrationFields {
    parentAgentObjectId: string;
    registerRelation: number;
}

/** Result from registerSubAgent() / registerSubAgentDelegated() */
export interface RegisterSubAgentResult {
    digest: string;
    publicKey: string;
    derivedAddress: string;
    agentObjectId: string;
}

/** Options for deactivateSubAgent() */
export interface DeactivateSubAgentOpts extends MemoryTxOpts {
    accountId: string;
    agentObjectId: string;
}

/** Options for revokeSubAgent() */
export interface RevokeSubAgentOpts extends MemoryTxOpts {
    accountId: string;
    agentObjectId: string;
}

/** Options for updateSubAgent() */
export interface UpdateSubAgentOpts extends MemoryTxOpts, SubAgentRegistrationFields {
    agentObjectId: string;
}

/** Options for updateSubAgentLabel() */
export interface UpdateSubAgentLabelOpts extends MemoryTxOpts {
    accountId: string;
    agentObjectId: string;
    label: string;
}

/** Options for ensureAgentMemoryVault() */
export interface EnsureAgentMemoryVaultOpts extends MemoryTxOpts {
    accountId: string;
    agentObjectId: string;
}

/** Result from ensureAgentMemoryVault() */
export interface EnsureAgentMemoryVaultResult {
    digest: string;
    vaultId: string;
}

/** Options for approveKeyPolicy / approveKeyWritePolicy PTB builders */
export interface ApproveKeyPolicyOpts extends MemoryTxOpts {
    accountId: string;
    /** MYDATA encryption id (hex string) */
    id: string;
}

/**
 * Options for approveOrgKeyPolicy: MYDATA key release gated by `OrgMemoryReader`
 * on the organization's memory share group. Used by org-visible blob decrypt
 * when the caller is not the account owner.
 */
export interface ApproveOrgKeyPolicyOpts extends MemoryTxOpts {
    accountId: string;
    organizationId: string;
    /** PermissionedGroup<MemorySharePackage> shared object for the org */
    orgMemoryGroupId: string;
    /** MYDATA encryption id (hex string) */
    id: string;
}

/** Shared org transaction fields (extends wallet/package context). */
interface OrgGroupTxBase extends MemoryTxOpts {
    accountId: string;
    organizationId: string;
    /** PermissionedGroup<MemorySharePackage> shared object for the org */
    orgMemoryGroupId: string;
}

export interface EnsureOrgMemoryGroupOpts extends MemoryTxOpts {
    accountId: string;
    organizationId: string;
}

export interface GrantOrgMemoryPermissionOpts extends OrgGroupTxBase {
    memberAddress: string;
    permissionsMask: number;
}

export interface RevokeOrgMemoryPermissionOpts extends OrgGroupTxBase {
    memberAddress: string;
    permissionsMask: number;
}

export interface DefineCustomOrgRoleOpts extends OrgGroupTxBase {
    roleName: string;
    mask: number;
}

export interface AssignOrgRoleOpts extends OrgGroupTxBase {
    memberAddress: string;
    roleName: string;
}

export interface RevokeOrgRoleOpts extends OrgGroupTxBase {
    memberAddress: string;
    roleName: string;
}

export interface AiCreditTxBase extends MemoryTxOpts {
    aiCreditConfigId: string;
    balanceId: string;
}

export interface ApproveAgentSpendOpts extends AiCreditTxBase {
    agentObjectId: string;
    maxAmountMist: number;
    expiresAtMs: number;
}

export interface RevokeAgentSpendApprovalOpts extends AiCreditTxBase {
    agentObjectId: string;
}

export interface ApproveAgentSpendAsApproverOpts extends AiCreditTxBase {
    accountId: string;
    organizationId: string;
    orgMemoryGroupId: string;
    agentObjectId: string;
    maxAmountMist: number;
    expiresAtMs: number;
}

export interface SetChildAgentBudgetOpts extends AiCreditTxBase {
    accountId: string;
    parentAgentObjectId: string;
    childAgentObjectId: string;
    budgetMist?: number | null;
    dailyCapMist?: number | null;
    monthlyCapMist?: number | null;
    requireApprovalAboveMist?: number | null;
}

export interface ApproveChildAgentSpendOpts extends AiCreditTxBase {
    accountId: string;
    parentAgentObjectId: string;
    childAgentObjectId: string;
    maxAmountMist: number;
    expiresAtMs: number;
}

/** Payload on workflow inbox items with `item_type: "approval_request"` (oracle ingest). */
export interface WorkflowApprovalRequestPayload {
    balance_id: string;
    agent_object_id: string;
    requested_amount_mist: number;
    threshold_mist: number;
    organization_id?: string | null;
}

/** Build `approveAgentSpend` opts from a workflow approval item + on-chain config ids. */
export interface ApproveAgentSpendFromWorkflowOpts extends MemoryTxOpts {
    aiCreditConfigId: string;
    payload: WorkflowApprovalRequestPayload | Record<string, unknown>;
    /** Defaults to `requested_amount_mist` from the payload. */
    maxAmountMist?: number;
    /** Defaults to now + 24h (ms). */
    expiresAtMs?: number;
    /**
     * Optional org context for the org-approver path
     * (`ai_credit::approve_agent_spend_as_approver`).
     *
     * When the workflow payload carries an `organization_id`, callers can supply
     * these values (typically fetched from social-server's
     * `/internal/organizations/:id/summary`) to route approval through the
     * approver PTB instead of the owner PTB.
     */
    orgContext?: WorkflowApprovalOrgContext;
}

/**
 * Values required to invoke `ai_credit::approve_agent_spend_as_approver` from
 * a workflow approval item. `accountId` + `orgMemoryGroupId` must be sourced
 * from social-server's org summary — SDK callers must not re-derive them.
 */
export interface WorkflowApprovalOrgContext {
    accountId: string;
    orgMemoryGroupId: string;
}

export function parseWorkflowApprovalPayload(
    payload: unknown,
): WorkflowApprovalRequestPayload {
    if (!payload || typeof payload !== "object") {
        throw new Error("workflow approval payload must be an object");
    }
    const p = payload as Record<string, unknown>;
    const balanceId = p.balance_id;
    const agentObjectId = p.agent_object_id;
    const requested = p.requested_amount_mist;
    const threshold = p.threshold_mist;
    if (typeof balanceId !== "string" || balanceId.length === 0) {
        throw new Error("workflow approval payload missing balance_id");
    }
    if (typeof agentObjectId !== "string" || agentObjectId.length === 0) {
        throw new Error("workflow approval payload missing agent_object_id");
    }
    if (typeof requested !== "number" || !Number.isFinite(requested)) {
        throw new Error("workflow approval payload missing requested_amount_mist");
    }
    if (typeof threshold !== "number" || !Number.isFinite(threshold)) {
        throw new Error("workflow approval payload missing threshold_mist");
    }
    return {
        balance_id: balanceId,
        agent_object_id: agentObjectId,
        requested_amount_mist: requested,
        threshold_mist: threshold,
        organization_id:
            typeof p.organization_id === "string" ? p.organization_id : null,
    };
}

export function buildApproveAgentSpendOptsFromWorkflow(
    opts: ApproveAgentSpendFromWorkflowOpts,
): ApproveAgentSpendOpts {
    const payload = parseWorkflowApprovalPayload(opts.payload);
    const expiresAtMs =
        opts.expiresAtMs ?? Date.now() + 24 * 60 * 60 * 1000;
    const maxAmountMist = opts.maxAmountMist ?? payload.requested_amount_mist;
    return {
        packageId: opts.packageId,
        mysoPrivateKey: opts.mysoPrivateKey,
        walletSigner: opts.walletSigner,
        mysoClient: opts.mysoClient,
        mysoNetwork: opts.mysoNetwork,
        aiCreditConfigId: opts.aiCreditConfigId,
        balanceId: payload.balance_id,
        agentObjectId: payload.agent_object_id,
        maxAmountMist,
        expiresAtMs,
    };
}

/** Payload on workflow inbox items with `item_type: "memory_access_request"`. */
export interface WorkflowMemoryAccessRequestPayload {
    organization_id: string;
    account_id: string;
    org_memory_group_id: string;
    member_address: string;
    permissions_mask: number;
    agent_object_id?: string | null;
}

/** Build `grantOrgMemoryPermission` opts from a workflow memory access item. */
export interface GrantOrgMemoryPermissionFromWorkflowOpts extends MemoryTxOpts {
    payload: WorkflowMemoryAccessRequestPayload | Record<string, unknown>;
    /** Defaults to `permissions_mask` from the payload. */
    permissionsMask?: number;
}

export function parseWorkflowMemoryAccessPayload(
    payload: unknown,
): WorkflowMemoryAccessRequestPayload {
    if (!payload || typeof payload !== "object") {
        throw new Error("workflow memory access payload must be an object");
    }
    const p = payload as Record<string, unknown>;
    const organizationId = p.organization_id;
    const accountId = p.account_id;
    const orgMemoryGroupId = p.org_memory_group_id;
    const memberAddress = p.member_address;
    const permissionsMask = p.permissions_mask;
    if (typeof organizationId !== "string" || organizationId.length === 0) {
        throw new Error("workflow memory access payload missing organization_id");
    }
    if (typeof accountId !== "string" || accountId.length === 0) {
        throw new Error("workflow memory access payload missing account_id");
    }
    if (typeof orgMemoryGroupId !== "string" || orgMemoryGroupId.length === 0) {
        throw new Error("workflow memory access payload missing org_memory_group_id");
    }
    if (typeof memberAddress !== "string" || memberAddress.length === 0) {
        throw new Error("workflow memory access payload missing member_address");
    }
    if (typeof permissionsMask !== "number" || !Number.isFinite(permissionsMask)) {
        throw new Error("workflow memory access payload missing permissions_mask");
    }
    return {
        organization_id: organizationId,
        account_id: accountId,
        org_memory_group_id: orgMemoryGroupId,
        member_address: memberAddress,
        permissions_mask: permissionsMask,
        agent_object_id:
            typeof p.agent_object_id === "string" ? p.agent_object_id : null,
    };
}

export function buildGrantOrgMemoryPermissionOptsFromWorkflow(
    opts: GrantOrgMemoryPermissionFromWorkflowOpts,
): GrantOrgMemoryPermissionOpts {
    const payload = parseWorkflowMemoryAccessPayload(opts.payload);
    return {
        packageId: opts.packageId,
        mysoPrivateKey: opts.mysoPrivateKey,
        walletSigner: opts.walletSigner,
        mysoClient: opts.mysoClient,
        mysoNetwork: opts.mysoNetwork,
        accountId: payload.account_id,
        organizationId: payload.organization_id,
        orgMemoryGroupId: payload.org_memory_group_id,
        memberAddress: payload.member_address,
        permissionsMask: opts.permissionsMask ?? payload.permissions_mask,
    };
}
