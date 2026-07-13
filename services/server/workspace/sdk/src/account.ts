/**
 * memory — Sub-Agent Management
 *
 * On-chain sub-agent operations against `social_contracts::memory`.
 * Sub-agents sign as their `derived_address` (= Ed25519PublicKey.toMySoAddress()).
 *
 * @example
 * ```typescript
 * import {
 *   generateSubAgentKey,
 *   registerSubAgent,
 *   CAP_MEMORY_READ,
 *   CAP_MEMORY_WRITE,
 * } from "@socialproof/memory/account"
 *
 * const agent = await generateSubAgentKey()
 *
 * await registerSubAgent({
 *   packageId: "0x...",
 *   memoryConfigId: "0x...",
 *   accountId: "0x...",
 *   organizationId: "0x...",
 *   publicKey: agent.publicKey,
 *   label: "My Laptop",
 *   walletSigner,
 * })
 *
 * const memory = Memory.create({ key: agent.privateKey, accountId: "0x..." })
 * ```
 */

import type {
    WalletSigner,
    EnsureMemoryAccountOpts,
    EnsureMemoryAccountResult,
    CreateAgenticOrganizationOpts,
    CreateAgenticOrganizationResult,
    UpdateAgenticOrganizationLabelOpts,
    UpdateAgenticOrganizationCategoryOpts,
    DeactivateAgenticOrganizationOpts,
    RegisterSubAgentOpts,
    RegisterSubAgentResult,
    RegisterSubAgentDelegatedOpts,
    DeactivateSubAgentOpts,
    RevokeSubAgentOpts,
    UpdateSubAgentOpts,
    UpdateSubAgentLabelOpts,
    EnsureAgentMemoryVaultOpts,
    EnsureAgentMemoryVaultResult,
    ApproveKeyPolicyOpts,
    ApproveOrgKeyPolicyOpts,
    EnsureOrgMemoryGroupOpts,
    GrantOrgMemoryPermissionOpts,
    RevokeOrgMemoryPermissionOpts,
    DefineCustomOrgRoleOpts,
    AssignOrgRoleOpts,
    RevokeOrgRoleOpts,
    ApproveAgentSpendOpts,
    RevokeAgentSpendApprovalOpts,
    ApproveAgentSpendAsApproverOpts,
    SetChildAgentBudgetOpts,
    ApproveChildAgentSpendOpts,
    ApproveAgentSpendFromWorkflowOpts,
    GrantOrgMemoryPermissionFromWorkflowOpts,
} from "./types.js";
import {
    buildApproveAgentSpendOptsFromWorkflow,
    buildGrantOrgMemoryPermissionOptsFromWorkflow,
    parseWorkflowApprovalPayload,
    parseWorkflowMemoryAccessPayload,
} from "./types.js";
import { bytesToHex, hexToBytes } from "./utils.js";
import {
    CAP_MEMORY_READ,
    CAP_MEMORY_WRITE,
    CLASS_DELEGATED_AI,
    REGISTER_SCOPE_BOTH,
} from "./contract.js";

export {
    CAP_MEMORY_READ,
    CAP_MEMORY_WRITE,
    CAP_MYDATA_READ,
    CAP_POST_PUBLISH,
    CAP_COMMENT,
    CAP_REACT,
    CAP_AI_SPEND,
    CAP_BUDGET_MANAGE,
    CAP_SOCIAL_GRAPH,
    ORG_PERM_MEMORY_READ,
    ORG_PERM_MEMORY_WRITE,
    ORG_PERM_AGENT_MANAGER,
    ORG_PERM_BUDGET_MANAGER,
    ORG_PERM_SPEND_APPROVER,
    ORG_PERM_DASHBOARD_VIEWER,
    ORG_PERM_AUDITOR,
    ORG_PERM_ALL,
    ROLE_MASK_OWNER,
    ROLE_MASK_ADMIN,
    ROLE_MASK_AGENT_MANAGER,
    ROLE_MASK_FINANCE_APPROVER,
    ROLE_MASK_MEMORY_ADMINISTRATOR,
    ROLE_MASK_AUDITOR,
    BUILTIN_ORG_ROLE_OWNER,
    BUILTIN_ORG_ROLE_ADMIN,
    BUILTIN_ORG_ROLE_AGENT_MANAGER,
    BUILTIN_ORG_ROLE_FINANCE_APPROVER,
    BUILTIN_ORG_ROLE_MEMORY_ADMINISTRATOR,
    BUILTIN_ORG_ROLE_AUDITOR,
    AI_CREDIT_APPROVAL_REQUIRED_CODE,
    CLASS_HUMAN,
    CLASS_DELEGATED_AI,
    CLASS_ORGANIZATION,
    REGISTER_SCOPE_CHILD,
    REGISTER_SCOPE_PEER,
    REGISTER_SCOPE_BOTH,
    REGISTER_RELATION_CHILD,
    REGISTER_RELATION_PEER,
    MAX_ORGANIZATIONS_PER_USER,
    ORG_TYPE_COMPANY,
    ORG_TYPE_STARTUP,
    ORG_TYPE_INVESTMENT_FUND,
    ORG_TYPE_NONPROFIT,
    ORG_TYPE_RESEARCH,
    ORG_TYPE_GOVERNMENT,
    ORG_TYPE_MEDIA,
    ORG_TYPE_STEWARDSHIP,
    ORG_TYPE_BRAND,
    ORG_TYPE_COMMUNITY,
    ORG_TYPE_SPORTS,
    ORG_TYPE_EDUCATION,
    ORG_TYPE_HEALTHCARE,
    ORG_TYPE_OTHER,
    ORG_TYPE_COUNT,
    OrganizationType,
} from "./contract.js";

const MYSO_CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";

// ============================================================
// Internal helpers
// ============================================================

interface TxContext {
    mysoClient: any;
    signer: any;
    address: string;
    Transaction: any;
}

async function buildTxContext(opts: {
    mysoPrivateKey?: string;
    walletSigner?: WalletSigner;
    mysoClient?: any;
    mysoNetwork?: "testnet" | "mainnet";
}): Promise<TxContext> {
    if (!opts.mysoPrivateKey && !opts.walletSigner) {
        throw new Error("Provide either mysoPrivateKey or walletSigner");
    }
    if (opts.mysoPrivateKey && opts.walletSigner) {
        throw new Error("Provide mysoPrivateKey OR walletSigner, not both");
    }

    const { Transaction } = await import("@socialproof/myso/transactions");

    let mysoClient: any;
    if (opts.mysoClient) {
        mysoClient = opts.mysoClient;
    } else {
        const mod = await import("@socialproof/myso/client");
        const MySoClient = (mod as any).MySoClient;
        if (typeof MySoClient !== "function") {
            throw new Error(
                "MySoClient not found. For @socialproof/myso v2.6.0+, pass mysoClient in opts.",
            );
        }
        const network = opts.mysoNetwork ?? "mainnet";
        const urls: Record<string, string> = {
            testnet: "https://fullnode.testnet.mysosocial.network:443",
            mainnet: "https://fullnode.mainnet.mysosocial.network:443",
        };
        mysoClient = new MySoClient({ url: urls[network] ?? urls.mainnet });
    }

    if (opts.walletSigner) {
        return {
            mysoClient,
            signer: opts.walletSigner,
            address: opts.walletSigner.address,
            Transaction,
        };
    }

    const { decodeMySoPrivateKey } = await import("@socialproof/myso/cryptography");
    const { Ed25519Keypair } = await import("@socialproof/myso/keypairs/ed25519");
    const { secretKey } = decodeMySoPrivateKey(opts.mysoPrivateKey!);
    const keypair = Ed25519Keypair.fromSecretKey(secretKey);

    return {
        mysoClient,
        signer: keypair,
        address: keypair.getPublicKey().toMySoAddress(),
        Transaction,
    };
}

async function signAndExecute(
    ctx: TxContext,
    tx: any,
): Promise<{ digest: string; effects: any }> {
    if (
        "signAndExecuteTransaction" in ctx.signer &&
        typeof ctx.signer.signAndExecuteTransaction === "function" &&
        "address" in ctx.signer
    ) {
        const result = await ctx.signer.signAndExecuteTransaction({ transaction: tx });
        const txResult = await ctx.mysoClient.waitForTransaction({
            digest: result.digest,
            options: { showEffects: true, showObjectChanges: true },
        });
        return { digest: result.digest, effects: txResult };
    }

    const result = await ctx.mysoClient.signAndExecuteTransaction({
        signer: ctx.signer,
        transaction: tx,
    });
    const txResult = await ctx.mysoClient.waitForTransaction({
        digest: result.digest,
        options: { showEffects: true, showObjectChanges: true },
    });
    return { digest: result.digest, effects: txResult };
}

function normalizePublicKey(publicKey: Uint8Array | string): Uint8Array {
    const pkBytes =
        typeof publicKey === "string" ? hexToBytes(publicKey) : publicKey;
    if (pkBytes.length !== 32) {
        throw new Error(`Invalid Ed25519 public key length: ${pkBytes.length} (expected 32)`);
    }
    return pkBytes;
}

export async function deriveMySoAddressFromPublicKey(
    publicKey: Uint8Array | string,
): Promise<string> {
    const pkBytes = normalizePublicKey(publicKey);
    const { blake2b } = await import("@noble/hashes/blake2.js");
    const input = new Uint8Array(33);
    input[0] = 0x00;
    input.set(pkBytes, 1);
    const addressBytes = blake2b(input, { dkLen: 32 });
    return "0x" + bytesToHex(addressBytes);
}

function extractSubAgentObjectId(effects: any): string {
    const objectChanges = effects?.objectChanges ?? [];
    for (const change of objectChanges) {
        if (
            change.type === "created" &&
            change.objectType?.includes("::memory::SubAgent")
        ) {
            return change.objectId;
        }
    }
    return "";
}

function extractAgenticOrganizationObjectId(effects: any): string {
    const objectChanges = effects?.objectChanges ?? [];
    for (const change of objectChanges) {
        if (
            change.type === "created" &&
            change.objectType?.includes("::memory::AgenticOrganization")
        ) {
            return change.objectId;
        }
    }
    return "";
}

function extractMemoryAccountIdFromProfile(effects: any): string {
    const objectChanges = effects?.objectChanges ?? [];
    for (const change of objectChanges) {
        if (change.type === "mutated" && change.objectType?.includes("::profile::Profile")) {
            // Profile mutation does not expose fields in objectChanges; caller may need RPC follow-up.
            break;
        }
    }
    for (const change of objectChanges) {
        if (
            change.type === "created" &&
            change.objectType?.includes("::memory::MemoryAccount")
        ) {
            return change.objectId;
        }
    }
    return "";
}

// ============================================================
// ensureMemoryAccount
// ============================================================

/**
 * Link a MemoryAccount to a profile that was created before Memory integration.
 * Calls `{packageId}::profile::ensure_memory_account`.
 */
export async function ensureMemoryAccount(
    opts: EnsureMemoryAccountOpts,
): Promise<EnsureMemoryAccountResult> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;

    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::profile::ensure_memory_account`,
        arguments: [
            tx.object(opts.registryId),
            tx.object(opts.profileId),
            tx.object(MYSO_CLOCK),
        ],
    });

    const { digest, effects } = await signAndExecute(ctx, tx);
    const accountId = extractMemoryAccountIdFromProfile(effects);

    return { digest, accountId };
}

// ============================================================
// Agentic organization lifecycle
// ============================================================

export async function createAgenticOrganization(
    opts: CreateAgenticOrganizationOpts,
): Promise<CreateAgenticOrganizationResult> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;

    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::memory::create_agentic_organization`,
        arguments: [
            tx.object(opts.memoryConfigId),
            tx.object(opts.accountId),
            tx.pure("u8", opts.orgType),
            tx.pure("option<string>", opts.label || null),
            tx.pure("option<string>", opts.description ?? null),
            tx.object(MYSO_CLOCK),
        ],
    });

    const { digest, effects } = await signAndExecute(ctx, tx);
    return {
        digest,
        organizationId: extractAgenticOrganizationObjectId(effects),
    };
}

export async function updateAgenticOrganizationLabel(
    opts: UpdateAgenticOrganizationLabelOpts,
): Promise<{ digest: string }> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;

    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::memory::update_agentic_organization_metadata`,
        arguments: [
            tx.object(opts.memoryConfigId),
            tx.object(opts.accountId),
            tx.object(opts.organizationId),
            tx.pure("option<string>", opts.label || null),
            tx.pure("option<string>", null),
        ],
    });

    const { digest } = await signAndExecute(ctx, tx);
    return { digest };
}

export async function updateAgenticOrganizationCategory(
    opts: UpdateAgenticOrganizationCategoryOpts,
): Promise<{ digest: string }> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;

    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::memory::update_agentic_organization_category`,
        arguments: [
            tx.object(opts.memoryConfigId),
            tx.object(opts.accountId),
            tx.object(opts.organizationId),
            tx.pure("u8", opts.orgType),
            tx.object(MYSO_CLOCK),
        ],
    });

    const { digest } = await signAndExecute(ctx, tx);
    return { digest };
}

export async function deactivateAgenticOrganization(
    opts: DeactivateAgenticOrganizationOpts,
): Promise<{ digest: string }> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;

    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::memory::deactivate_agentic_organization`,
        arguments: [
            tx.object(opts.accountId),
            tx.object(opts.organizationId),
            tx.object(MYSO_CLOCK),
        ],
    });

    const { digest } = await signAndExecute(ctx, tx);
    return { digest };
}

// ============================================================
// registerSubAgent
// ============================================================

/**
 * Register a root-level sub-agent on a MemoryAccount (human owner only).
 * Default: delegated AI with memory read + write caps.
 *
 * `approvalRequiredCaps` and `maxActionSpend` are accepted for Move ABI compatibility
 * but are not enforced by the relayer in v1 — prefer defaults (`0` / `null`).
 */
export async function registerSubAgent(
    opts: RegisterSubAgentOpts,
): Promise<RegisterSubAgentResult> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;

    const pkBytes = normalizePublicKey(opts.publicKey);
    const derivedAddress = await deriveMySoAddressFromPublicKey(pkBytes);

    const identityClass = opts.identityClass ?? CLASS_DELEGATED_AI;
    const roleTags = opts.roleTags ?? 0;
    const capabilities =
        opts.capabilities ?? (CAP_MEMORY_READ | CAP_MEMORY_WRITE);
    const delegatableCaps = opts.delegatableCaps ?? 0;
    const registerScope = opts.registerScope ?? REGISTER_SCOPE_BOTH;
    const approvalRequiredCaps = opts.approvalRequiredCaps ?? 0;

    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::memory::register_sub_agent`,
        arguments: [
            tx.object(opts.memoryConfigId),
            tx.object(opts.accountId),
            tx.object(opts.organizationId),
            tx.pure("vector<u8>", Array.from(pkBytes)),
            tx.pure("address", derivedAddress),
            tx.pure("string", opts.label),
            tx.pure("u8", identityClass),
            tx.pure("u64", roleTags),
            tx.pure("u64", capabilities),
            tx.pure("u64", delegatableCaps),
            tx.pure("u8", registerScope),
            tx.pure("u64", approvalRequiredCaps),
            tx.pure("option<u64>", opts.maxActionSpend ?? null),
            tx.pure("option<address>", opts.platformScope ?? null),
            tx.pure("option<u64>", opts.expiresAt ?? null),
            tx.object(MYSO_CLOCK),
        ],
    });

    const { digest, effects } = await signAndExecute(ctx, tx);
    const agentObjectId = extractSubAgentObjectId(effects);

    return {
        digest,
        publicKey: bytesToHex(pkBytes),
        derivedAddress,
        agentObjectId,
    };
}

// ============================================================
// registerSubAgentDelegated
// ============================================================

export async function registerSubAgentDelegated(
    opts: RegisterSubAgentDelegatedOpts,
): Promise<RegisterSubAgentResult> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;

    const pkBytes = normalizePublicKey(opts.publicKey);
    const derivedAddress = await deriveMySoAddressFromPublicKey(pkBytes);

    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::memory::register_sub_agent_delegated`,
        arguments: [
            tx.object(opts.memoryConfigId),
            tx.object(opts.accountId),
            tx.object(opts.parentAgentObjectId),
            tx.pure("vector<u8>", Array.from(pkBytes)),
            tx.pure("address", derivedAddress),
            tx.pure("string", opts.label),
            tx.pure("u8", opts.identityClass ?? CLASS_DELEGATED_AI),
            tx.pure("u64", opts.roleTags ?? 0),
            tx.pure("u64", opts.capabilities ?? (CAP_MEMORY_READ | CAP_MEMORY_WRITE)),
            tx.pure("u64", opts.delegatableCaps ?? 0),
            tx.pure("u8", opts.registerScope ?? REGISTER_SCOPE_BOTH),
            tx.pure("u64", opts.approvalRequiredCaps ?? 0),
            tx.pure("option<u64>", opts.maxActionSpend ?? null),
            tx.pure("option<address>", opts.platformScope ?? null),
            tx.pure("option<u64>", opts.expiresAt ?? null),
            tx.pure("u8", opts.registerRelation),
            tx.object(MYSO_CLOCK),
        ],
    });

    const { digest, effects } = await signAndExecute(ctx, tx);
    return {
        digest,
        publicKey: bytesToHex(pkBytes),
        derivedAddress,
        agentObjectId: extractSubAgentObjectId(effects),
    };
}

// ============================================================
// deactivateSubAgent / revokeSubAgent
// ============================================================

export async function deactivateSubAgent(
    opts: DeactivateSubAgentOpts,
): Promise<{ digest: string }> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;

    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::memory::deactivate_sub_agent`,
        arguments: [
            tx.object(opts.accountId),
            tx.object(opts.agentObjectId),
            tx.object(MYSO_CLOCK),
        ],
    });

    const { digest } = await signAndExecute(ctx, tx);
    return { digest };
}

export async function revokeSubAgent(
    opts: RevokeSubAgentOpts,
): Promise<{ digest: string }> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;

    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::memory::revoke_sub_agent`,
        arguments: [
            tx.object(opts.accountId),
            tx.object(opts.agentObjectId),
            tx.object(MYSO_CLOCK),
        ],
    });

    const { digest } = await signAndExecute(ctx, tx);
    return { digest };
}

// ============================================================
// generateSubAgentKey
// ============================================================

/**
 * Generate a new Ed25519 sub-agent keypair.
 * The private key signs relayer requests; the derived address is the on-chain SubAgent signer.
 */
export async function generateSubAgentKey(): Promise<{
    privateKey: string;
    publicKey: Uint8Array;
    derivedAddress: string;
}> {
    const ed = await import("@noble/ed25519");
    const privateKeyBytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(privateKeyBytes);
    const publicKey = await ed.getPublicKeyAsync(privateKeyBytes);
    const derivedAddress = await deriveMySoAddressFromPublicKey(publicKey);

    return {
        privateKey: bytesToHex(privateKeyBytes),
        publicKey,
        derivedAddress,
    };
}

// ============================================================
// updateSubAgent / updateSubAgentLabel
// ============================================================

export async function updateSubAgent(
    opts: UpdateSubAgentOpts,
): Promise<{ digest: string }> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;

    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::memory::update_sub_agent`,
        arguments: [
            tx.object(opts.accountId),
            tx.object(opts.agentObjectId),
            tx.pure("u8", opts.identityClass ?? CLASS_DELEGATED_AI),
            tx.pure("u64", opts.roleTags ?? 0),
            tx.pure("u64", opts.capabilities ?? (CAP_MEMORY_READ | CAP_MEMORY_WRITE)),
            tx.pure("u64", opts.delegatableCaps ?? 0),
            tx.pure("u8", opts.registerScope ?? REGISTER_SCOPE_BOTH),
            tx.pure("u64", opts.approvalRequiredCaps ?? 0),
            tx.pure("option<u64>", opts.maxActionSpend ?? null),
            tx.pure("option<address>", opts.platformScope ?? null),
            tx.pure("option<u64>", opts.expiresAt ?? null),
            tx.object(MYSO_CLOCK),
        ],
    });

    const { digest } = await signAndExecute(ctx, tx);
    return { digest };
}

export async function updateSubAgentLabel(
    opts: UpdateSubAgentLabelOpts,
): Promise<{ digest: string }> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;

    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::memory::update_sub_agent_label`,
        arguments: [
            tx.object(opts.memoryConfigId),
            tx.object(opts.accountId),
            tx.object(opts.agentObjectId),
            tx.pure("string", opts.label),
            tx.object(MYSO_CLOCK),
        ],
    });

    const { digest } = await signAndExecute(ctx, tx);
    return { digest };
}

// ============================================================
// ensureAgentMemoryVault
// ============================================================

export async function ensureAgentMemoryVault(
    opts: EnsureAgentMemoryVaultOpts,
): Promise<EnsureAgentMemoryVaultResult> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;

    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::memory::ensure_agent_memory_vault`,
        arguments: [
            tx.object(opts.accountId),
            tx.object(opts.agentObjectId),
            tx.object(MYSO_CLOCK),
        ],
    });

    const { digest, effects } = await signAndExecute(ctx, tx);
    let vaultId = "";
    for (const change of effects?.objectChanges ?? []) {
        if (
            change.type === "created" &&
            change.objectType?.includes("::memory::AgentMemoryVault")
        ) {
            vaultId = change.objectId;
            break;
        }
    }
    return { digest, vaultId };
}

// ============================================================
// MYDATA policy PTB builders
// ============================================================

function idHexToBytes(id: string): number[] {
    const hex = id.startsWith("0x") ? id.slice(2) : id;
    return Array.from(
        Uint8Array.from(hex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16))),
    );
}

export async function buildApproveKeyPolicyTxBytes(
    opts: ApproveKeyPolicyOpts,
): Promise<Uint8Array> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;
    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::memory::approve_key_policy`,
        arguments: [
            tx.pure("vector<u8>", idHexToBytes(opts.id)),
            tx.object(opts.accountId),
            tx.object(MYSO_CLOCK),
        ],
    });
    return tx.build({ client: ctx.mysoClient, onlyTransactionKind: true });
}

export async function buildApproveKeyWritePolicyTxBytes(
    opts: ApproveKeyPolicyOpts,
): Promise<Uint8Array> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;
    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::memory::approve_key_write_policy`,
        arguments: [
            tx.pure("vector<u8>", idHexToBytes(opts.id)),
            tx.object(opts.accountId),
            tx.object(MYSO_CLOCK),
        ],
    });
    return tx.build({ client: ctx.mysoClient, onlyTransactionKind: true });
}

export async function approveKeyPolicy(
    opts: ApproveKeyPolicyOpts,
): Promise<{ digest: string; txBytes: Uint8Array }> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;
    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::memory::approve_key_policy`,
        arguments: [
            tx.pure("vector<u8>", idHexToBytes(opts.id)),
            tx.object(opts.accountId),
            tx.object(MYSO_CLOCK),
        ],
    });
    const txBytes = await tx.build({ client: ctx.mysoClient, onlyTransactionKind: true });
    const { digest } = await signAndExecute(ctx, tx);
    return { digest, txBytes: new Uint8Array(txBytes) };
}

export async function approveKeyWritePolicy(
    opts: ApproveKeyPolicyOpts,
): Promise<{ digest: string; txBytes: Uint8Array }> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;
    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::memory::approve_key_write_policy`,
        arguments: [
            tx.pure("vector<u8>", idHexToBytes(opts.id)),
            tx.object(opts.accountId),
            tx.object(MYSO_CLOCK),
        ],
    });
    const txBytes = await tx.build({ client: ctx.mysoClient, onlyTransactionKind: true });
    const { digest } = await signAndExecute(ctx, tx);
    return { digest, txBytes: new Uint8Array(txBytes) };
}

/**
 * Build (only) an `approve_org_key_policy` PTB for MYDATA key release on
 * org-visible blobs. Same shape as {@link buildApproveKeyPolicyTxBytes} but
 * includes the org + memory group refs required by `memory::approve_org_key_policy`.
 *
 * `orgMemoryGroupId` MUST come from social-server's org summary endpoint;
 * clients must never re-derive the group address locally.
 */
export async function buildApproveOrgKeyPolicyTxBytes(
    opts: ApproveOrgKeyPolicyOpts,
): Promise<Uint8Array> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;
    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::memory::approve_org_key_policy`,
        arguments: [
            tx.object(opts.memoryConfigId),
            tx.pure("vector<u8>", idHexToBytes(opts.id)),
            tx.object(opts.accountId),
            tx.object(opts.organizationId),
            tx.object(opts.orgMemoryGroupId),
            tx.object(MYSO_CLOCK),
        ],
    });
    return tx.build({ client: ctx.mysoClient, onlyTransactionKind: true });
}

/**
 * Sign + execute an `approve_org_key_policy` PTB. Direct clients that decrypt
 * org-visible blobs outside the memory relayer sidecar can use this to obtain
 * the transaction digest + built bytes.
 */
export async function approveOrgKeyPolicy(
    opts: ApproveOrgKeyPolicyOpts,
): Promise<{ digest: string; txBytes: Uint8Array }> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;
    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::memory::approve_org_key_policy`,
        arguments: [
            tx.object(opts.memoryConfigId),
            tx.pure("vector<u8>", idHexToBytes(opts.id)),
            tx.object(opts.accountId),
            tx.object(opts.organizationId),
            tx.object(opts.orgMemoryGroupId),
            tx.object(MYSO_CLOCK),
        ],
    });
    const txBytes = await tx.build({ client: ctx.mysoClient, onlyTransactionKind: true });
    const { digest } = await signAndExecute(ctx, tx);
    return { digest, txBytes: new Uint8Array(txBytes) };
}

// ============================================================
// Org memory sharing + roles
// ============================================================

export async function ensureOrgMemoryGroup(
    opts: EnsureOrgMemoryGroupOpts,
): Promise<{ digest: string }> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;
    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::memory::ensure_org_memory_group`,
        arguments: [
            tx.object(opts.accountId),
            tx.object(opts.organizationId),
            tx.object(MYSO_CLOCK),
        ],
    });
    const { digest } = await signAndExecute(ctx, tx);
    return { digest };
}

export async function buildEnsureOrgMemoryGroupTxBytes(
    opts: EnsureOrgMemoryGroupOpts,
): Promise<Uint8Array> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;
    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::memory::ensure_org_memory_group`,
        arguments: [
            tx.object(opts.accountId),
            tx.object(opts.organizationId),
            tx.object(MYSO_CLOCK),
        ],
    });
    return tx.build({ client: ctx.mysoClient, onlyTransactionKind: true });
}

export async function buildGrantOrgMemoryPermissionTxBytes(
    opts: GrantOrgMemoryPermissionOpts,
): Promise<Uint8Array> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;
    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::memory::grant_org_memory_permission`,
        arguments: [
            tx.object(opts.accountId),
            tx.object(opts.organizationId),
            tx.object(opts.orgMemoryGroupId),
            tx.pure("address", opts.memberAddress),
            tx.pure("u64", opts.permissionsMask),
            tx.object(MYSO_CLOCK),
        ],
    });
    return tx.build({ client: ctx.mysoClient, onlyTransactionKind: true });
}

export async function grantOrgMemoryPermission(
    opts: GrantOrgMemoryPermissionOpts,
): Promise<{ digest: string }> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;
    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::memory::grant_org_memory_permission`,
        arguments: [
            tx.object(opts.accountId),
            tx.object(opts.organizationId),
            tx.object(opts.orgMemoryGroupId),
            tx.pure("address", opts.memberAddress),
            tx.pure("u64", opts.permissionsMask),
            tx.object(MYSO_CLOCK),
        ],
    });
    const { digest } = await signAndExecute(ctx, tx);
    return { digest };
}

export async function revokeOrgMemoryPermission(
    opts: RevokeOrgMemoryPermissionOpts,
): Promise<{ digest: string }> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;
    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::memory::revoke_org_memory_permission`,
        arguments: [
            tx.object(opts.accountId),
            tx.object(opts.organizationId),
            tx.object(opts.orgMemoryGroupId),
            tx.pure("address", opts.memberAddress),
            tx.pure("u64", opts.permissionsMask),
            tx.object(MYSO_CLOCK),
        ],
    });
    const { digest } = await signAndExecute(ctx, tx);
    return { digest };
}

export async function buildRevokeOrgMemoryPermissionTxBytes(
    opts: RevokeOrgMemoryPermissionOpts,
): Promise<Uint8Array> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;
    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::memory::revoke_org_memory_permission`,
        arguments: [
            tx.object(opts.accountId),
            tx.object(opts.organizationId),
            tx.object(opts.orgMemoryGroupId),
            tx.pure("address", opts.memberAddress),
            tx.pure("u64", opts.permissionsMask),
            tx.object(MYSO_CLOCK),
        ],
    });
    return tx.build({ client: ctx.mysoClient, onlyTransactionKind: true });
}

export async function defineCustomOrgRole(
    opts: DefineCustomOrgRoleOpts,
): Promise<{ digest: string }> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;
    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::memory::define_custom_org_role`,
        arguments: [
            tx.object(opts.memoryConfigId),
            tx.object(opts.accountId),
            tx.object(opts.organizationId),
            tx.object(opts.orgMemoryGroupId),
            tx.pure("string", opts.roleName),
            tx.pure("u64", opts.mask),
            tx.object(MYSO_CLOCK),
        ],
    });
    const { digest } = await signAndExecute(ctx, tx);
    return { digest };
}

export async function buildDefineCustomOrgRoleTxBytes(
    opts: DefineCustomOrgRoleOpts,
): Promise<Uint8Array> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;
    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::memory::define_custom_org_role`,
        arguments: [
            tx.object(opts.memoryConfigId),
            tx.object(opts.accountId),
            tx.object(opts.organizationId),
            tx.object(opts.orgMemoryGroupId),
            tx.pure("string", opts.roleName),
            tx.pure("u64", opts.mask),
            tx.object(MYSO_CLOCK),
        ],
    });
    return tx.build({ client: ctx.mysoClient, onlyTransactionKind: true });
}

export async function assignOrgRole(
    opts: AssignOrgRoleOpts,
): Promise<{ digest: string }> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;
    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::memory::assign_org_role`,
        arguments: [
            tx.object(opts.accountId),
            tx.object(opts.organizationId),
            tx.object(opts.orgMemoryGroupId),
            tx.pure("address", opts.memberAddress),
            tx.pure("string", opts.roleName),
            tx.object(MYSO_CLOCK),
        ],
    });
    const { digest } = await signAndExecute(ctx, tx);
    return { digest };
}

export async function buildAssignOrgRoleTxBytes(
    opts: AssignOrgRoleOpts,
): Promise<Uint8Array> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;
    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::memory::assign_org_role`,
        arguments: [
            tx.object(opts.accountId),
            tx.object(opts.organizationId),
            tx.object(opts.orgMemoryGroupId),
            tx.pure("address", opts.memberAddress),
            tx.pure("string", opts.roleName),
            tx.object(MYSO_CLOCK),
        ],
    });
    return tx.build({ client: ctx.mysoClient, onlyTransactionKind: true });
}

export async function revokeOrgRole(
    opts: RevokeOrgRoleOpts,
): Promise<{ digest: string }> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;
    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::memory::revoke_org_role`,
        arguments: [
            tx.object(opts.accountId),
            tx.object(opts.organizationId),
            tx.object(opts.orgMemoryGroupId),
            tx.pure("address", opts.memberAddress),
            tx.pure("string", opts.roleName),
            tx.object(MYSO_CLOCK),
        ],
    });
    const { digest } = await signAndExecute(ctx, tx);
    return { digest };
}

export async function buildRevokeOrgRoleTxBytes(
    opts: RevokeOrgRoleOpts,
): Promise<Uint8Array> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;
    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::memory::revoke_org_role`,
        arguments: [
            tx.object(opts.accountId),
            tx.object(opts.organizationId),
            tx.object(opts.orgMemoryGroupId),
            tx.pure("address", opts.memberAddress),
            tx.pure("string", opts.roleName),
            tx.object(MYSO_CLOCK),
        ],
    });
    return tx.build({ client: ctx.mysoClient, onlyTransactionKind: true });
}

// ============================================================
// AI credit approvals + delegated budgets
// ============================================================

export async function buildApproveAgentSpendTxBytes(
    opts: ApproveAgentSpendOpts,
): Promise<Uint8Array> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;
    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::ai_credit::approve_agent_spend`,
        arguments: [
            tx.object(opts.aiCreditConfigId),
            tx.object(opts.balanceId),
            tx.pure("id", opts.agentObjectId),
            tx.pure("u64", opts.maxAmountMist),
            tx.pure("u64", opts.expiresAtMs),
            tx.object(MYSO_CLOCK),
        ],
    });
    return tx.build({ client: ctx.mysoClient, onlyTransactionKind: true });
}

export async function approveAgentSpend(
    opts: ApproveAgentSpendOpts,
): Promise<{ digest: string; txBytes: Uint8Array }> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;
    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::ai_credit::approve_agent_spend`,
        arguments: [
            tx.object(opts.aiCreditConfigId),
            tx.object(opts.balanceId),
            tx.pure("id", opts.agentObjectId),
            tx.pure("u64", opts.maxAmountMist),
            tx.pure("u64", opts.expiresAtMs),
            tx.object(MYSO_CLOCK),
        ],
    });
    const txBytes = await tx.build({ client: ctx.mysoClient, onlyTransactionKind: true });
    const { digest } = await signAndExecute(ctx, tx);
    return { digest, txBytes: new Uint8Array(txBytes) };
}

export async function buildRevokeAgentSpendApprovalTxBytes(
    opts: RevokeAgentSpendApprovalOpts,
): Promise<Uint8Array> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;
    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::ai_credit::revoke_agent_spend_approval`,
        arguments: [
            tx.object(opts.aiCreditConfigId),
            tx.object(opts.balanceId),
            tx.pure("id", opts.agentObjectId),
            tx.object(MYSO_CLOCK),
        ],
    });
    return tx.build({ client: ctx.mysoClient, onlyTransactionKind: true });
}

export async function revokeAgentSpendApproval(
    opts: RevokeAgentSpendApprovalOpts,
): Promise<{ digest: string }> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;
    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::ai_credit::revoke_agent_spend_approval`,
        arguments: [
            tx.object(opts.aiCreditConfigId),
            tx.object(opts.balanceId),
            tx.pure("id", opts.agentObjectId),
            tx.object(MYSO_CLOCK),
        ],
    });
    const { digest } = await signAndExecute(ctx, tx);
    return { digest };
}

export async function buildApproveAgentSpendAsApproverTxBytes(
    opts: ApproveAgentSpendAsApproverOpts,
): Promise<Uint8Array> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;
    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::ai_credit::approve_agent_spend_as_approver`,
        arguments: [
            tx.object(opts.aiCreditConfigId),
            tx.object(opts.balanceId),
            tx.object(opts.accountId),
            tx.object(opts.organizationId),
            tx.object(opts.orgMemoryGroupId),
            tx.object(opts.agentObjectId),
            tx.pure("u64", opts.maxAmountMist),
            tx.pure("u64", opts.expiresAtMs),
            tx.object(MYSO_CLOCK),
        ],
    });
    return tx.build({ client: ctx.mysoClient, onlyTransactionKind: true });
}

export async function approveAgentSpendAsApprover(
    opts: ApproveAgentSpendAsApproverOpts,
): Promise<{ digest: string }> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;
    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::ai_credit::approve_agent_spend_as_approver`,
        arguments: [
            tx.object(opts.aiCreditConfigId),
            tx.object(opts.balanceId),
            tx.object(opts.accountId),
            tx.object(opts.organizationId),
            tx.object(opts.orgMemoryGroupId),
            tx.object(opts.agentObjectId),
            tx.pure("u64", opts.maxAmountMist),
            tx.pure("u64", opts.expiresAtMs),
            tx.object(MYSO_CLOCK),
        ],
    });
    const { digest } = await signAndExecute(ctx, tx);
    return { digest };
}

export async function setChildAgentBudget(
    opts: SetChildAgentBudgetOpts,
): Promise<{ digest: string }> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;
    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::ai_credit::set_child_agent_budget`,
        arguments: [
            tx.object(opts.aiCreditConfigId),
            tx.object(opts.balanceId),
            tx.object(opts.accountId),
            tx.object(opts.parentAgentObjectId),
            tx.object(opts.childAgentObjectId),
            tx.pure("option<u64>", opts.budgetMist ?? null),
            tx.pure("option<u64>", opts.dailyCapMist ?? null),
            tx.pure("option<u64>", opts.monthlyCapMist ?? null),
            tx.pure("option<u64>", opts.requireApprovalAboveMist ?? null),
            tx.object(MYSO_CLOCK),
        ],
    });
    const { digest } = await signAndExecute(ctx, tx);
    return { digest };
}

export async function approveChildAgentSpend(
    opts: ApproveChildAgentSpendOpts,
): Promise<{ digest: string }> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;
    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::ai_credit::approve_child_agent_spend`,
        arguments: [
            tx.object(opts.aiCreditConfigId),
            tx.object(opts.balanceId),
            tx.object(opts.accountId),
            tx.object(opts.parentAgentObjectId),
            tx.object(opts.childAgentObjectId),
            tx.pure("u64", opts.maxAmountMist),
            tx.pure("u64", opts.expiresAtMs),
            tx.object(MYSO_CLOCK),
        ],
    });
    const { digest } = await signAndExecute(ctx, tx);
    return { digest };
}

/**
 * Sign + execute a workflow approval item.
 *
 * When the workflow payload carries an `organization_id` AND the caller
 * supplies `orgContext` (obtained from social-server's org summary endpoint),
 * this routes through `ai_credit::approve_agent_spend_as_approver` so the
 * caller may be an `OrgSpendApprover` role holder rather than the account
 * owner. Otherwise the owner PTB (`ai_credit::approve_agent_spend`) runs.
 */
export async function approveAgentSpendFromWorkflowItem(
    opts: ApproveAgentSpendFromWorkflowOpts,
): Promise<{ digest: string; txBytes?: Uint8Array }> {
    const payload = parseWorkflowApprovalPayload(opts.payload);
    if (payload.organization_id && opts.orgContext) {
        const approverOpts: ApproveAgentSpendAsApproverOpts = {
            packageId: opts.packageId,
            mysoPrivateKey: opts.mysoPrivateKey,
            walletSigner: opts.walletSigner,
            mysoClient: opts.mysoClient,
            mysoNetwork: opts.mysoNetwork,
            aiCreditConfigId: opts.aiCreditConfigId,
            balanceId: payload.balance_id,
            accountId: opts.orgContext.accountId,
            organizationId: payload.organization_id,
            orgMemoryGroupId: opts.orgContext.orgMemoryGroupId,
            agentObjectId: payload.agent_object_id,
            maxAmountMist: opts.maxAmountMist ?? payload.requested_amount_mist,
            expiresAtMs: opts.expiresAtMs ?? Date.now() + 24 * 60 * 60 * 1000,
        };
        return approveAgentSpendAsApprover(approverOpts);
    }
    return approveAgentSpend(buildApproveAgentSpendOptsFromWorkflow(opts));
}

/** Org admin PTB built from a workflow inbox `memory_access_request` payload. */
export async function grantOrgMemoryPermissionFromWorkflowItem(
    opts: GrantOrgMemoryPermissionFromWorkflowOpts,
): Promise<{ digest: string }> {
    return grantOrgMemoryPermission(buildGrantOrgMemoryPermissionOptsFromWorkflow(opts));
}

export {
    parseWorkflowApprovalPayload,
    buildApproveAgentSpendOptsFromWorkflow,
    parseWorkflowMemoryAccessPayload,
    buildGrantOrgMemoryPermissionOptsFromWorkflow,
};
