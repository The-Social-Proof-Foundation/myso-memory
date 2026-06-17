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
 *   accountId: "0x...",
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
    RegisterSubAgentOpts,
    RegisterSubAgentResult,
    RegisterSubAgentDelegatedOpts,
    DeactivateSubAgentOpts,
    RevokeSubAgentOpts,
} from "./types.js";
import { bytesToHex, hexToBytes } from "./utils.js";

// ============================================================
// Capability + identity constants (mirror memory.move)
// ============================================================

export const CAP_MEMORY_READ = 1;
export const CAP_MEMORY_WRITE = 2;

export const CLASS_DELEGATED_AI = 1;

export const REGISTER_SCOPE_CHILD = 1;
export const REGISTER_SCOPE_PEER = 2;
export const REGISTER_SCOPE_BOTH = 3;

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
// registerSubAgent
// ============================================================

/**
 * Register a root-level sub-agent on a MemoryAccount (human owner only).
 * Default: delegated AI with memory read + write caps.
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
            tx.object(opts.accountId),
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
