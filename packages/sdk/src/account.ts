/**
 * memory — Account Management
 *
 * On-chain account operations: create account, add/remove delegate keys.
 * Supports both wallet signing (browser) and private key signing (server-side).
 *
 * @example
 * ```typescript
 * import { createAccount, addDelegateKey, generateDelegateKey } from "@socialproof/memory/account"
 *
 * // Generate a delegate keypair
 * const delegate = await generateDelegateKey()
 *
 * // Create account (wallet mode — browser)
 * const account = await createAccount({
 *     packageId: "0x...",
 *     registryId: "0x...",
 *     walletSigner,
 * })
 *
 * // Add the delegate key
 * await addDelegateKey({
 *     packageId: "0x...",
 *     accountId: account.accountId,
 *     publicKey: delegate.publicKey,
 *     label: "My Laptop",
 *     walletSigner,
 * })
 *
 * // Now use the delegate key with the SDK
 * const memory = Memory.create({ key: delegate.privateKey, accountId: account.accountId })
 * ```
 */

import type {
    WalletSigner,
    CreateAccountOpts,
    CreateAccountResult,
    AddDelegateKeyOpts,
    AddDelegateKeyResult,
    RemoveDelegateKeyOpts,
} from "./types.js";
import { bytesToHex, hexToBytes } from "./utils.js";

// ============================================================
// MYSO Clock object (shared, always 0x6)
// ============================================================
const MYSO_CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";

// ============================================================
// Internal: Build MySo client + signer
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

    // Build MySo client
    let mysoClient: any;
    if (opts.mysoClient) {
        mysoClient = opts.mysoClient;
    } else {
        const mod = await import("@socialproof/myso/client");
        const MySoClient = (mod as any).MySoClient;
        if (typeof MySoClient !== "function") {
            throw new Error(
                "MySoClient not found. For @socialproof/myso v2.6.0+, pass mysoClient in opts."
            );
        }
        const network = opts.mysoNetwork ?? "mainnet";
        const urls: Record<string, string> = {
            testnet: "https://fullnode.testnet.mysosocial.network:443",
            mainnet: "https://fullnode.mainnet.mysosocial.network:443",
        };
        mysoClient = new MySoClient({ url: urls[network] ?? urls.mainnet });
    }

    // Build signer
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
    if ("signAndExecuteTransaction" in ctx.signer && typeof ctx.signer.signAndExecuteTransaction === "function" && "address" in ctx.signer) {
        // WalletSigner mode
        const result = await ctx.signer.signAndExecuteTransaction({ transaction: tx });
        // Wait for transaction to be confirmed
        const txResult = await ctx.mysoClient.waitForTransaction({
            digest: result.digest,
            options: { showEffects: true, showObjectChanges: true },
        });
        return { digest: result.digest, effects: txResult };
    }

    // Keypair mode
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

// ============================================================
// createAccount
// ============================================================

/**
 * Create a new MemoryAccount on-chain.
 *
 * Calls `{packageId}::account::create_account(registry, clock)`.
 * Each address can only create ONE account (enforced by the contract).
 *
 * @returns CreateAccountResult with accountId, owner, and tx digest
 */
export async function createAccount(
    opts: CreateAccountOpts,
): Promise<CreateAccountResult> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;

    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::account::create_account`,
        arguments: [
            tx.object(opts.registryId),
            tx.object(MYSO_CLOCK),
        ],
    });

    const { digest, effects } = await signAndExecute(ctx, tx);

    // Extract the created MemoryAccount object ID from object changes
    let accountId = "";
    const objectChanges = effects?.objectChanges ?? [];
    for (const change of objectChanges) {
        if (
            change.type === "created" &&
            change.objectType?.includes("::account::MemoryAccount")
        ) {
            accountId = change.objectId;
            break;
        }
    }

    if (!accountId) {
        // Fallback: try to find from effects
        const created = effects?.effects?.created ?? [];
        for (const obj of created) {
            if (obj.owner?.Shared !== undefined) {
                accountId = obj.reference?.objectId ?? "";
                break;
            }
        }
    }

    return {
        accountId,
        owner: ctx.address,
        digest,
    };
}

// ============================================================
// addDelegateKey
// ============================================================

/**
 * Add a delegate key to a MemoryAccount.
 *
 * Calls `{packageId}::account::add_delegate_key(account, public_key, derived_address, label, clock)`.
 * Only the account owner can add delegate keys.
 *
 * @param opts.publicKey - Ed25519 public key (32 bytes Uint8Array or hex string)
 * @param opts.label - Human-readable label (e.g. "MacBook Pro", "Production Server")
 * @returns AddDelegateKeyResult with digest, publicKey hex, and derived mysoAddress
 */
export async function addDelegateKey(
    opts: AddDelegateKeyOpts,
): Promise<AddDelegateKeyResult> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;

    // Normalize public key to Uint8Array
    const pkBytes: Uint8Array =
        typeof opts.publicKey === "string"
            ? hexToBytes(opts.publicKey)
            : opts.publicKey;

    if (pkBytes.length !== 32) {
        throw new Error(`Invalid Ed25519 public key length: ${pkBytes.length} (expected 32)`);
    }

    // Derive MySo address from the public key
    const { blake2b } = await import("@noble/hashes/blake2.js");
    const input = new Uint8Array(33);
    input[0] = 0x00; // Ed25519 scheme flag
    input.set(pkBytes, 1);
    const addressBytes = blake2b(input, { dkLen: 32 });
    const mysoAddress = "0x" + bytesToHex(addressBytes);

    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::account::add_delegate_key`,
        arguments: [
            tx.object(opts.accountId),
            tx.pure("vector<u8>", Array.from(pkBytes)),
            tx.pure("address", mysoAddress),
            tx.pure("string", opts.label),
            tx.object(MYSO_CLOCK),
        ],
    });

    const { digest } = await signAndExecute(ctx, tx);

    return {
        digest,
        publicKey: bytesToHex(pkBytes),
        mysoAddress,
    };
}

// ============================================================
// removeDelegateKey
// ============================================================

/**
 * Remove a delegate key from a MemoryAccount.
 *
 * Calls `{packageId}::account::remove_delegate_key(account, public_key)`.
 * Only the account owner can remove delegate keys.
 *
 * @param opts.publicKey - Ed25519 public key to remove (32 bytes Uint8Array or hex string)
 */
export async function removeDelegateKey(
    opts: RemoveDelegateKeyOpts,
): Promise<{ digest: string }> {
    const ctx = await buildTxContext(opts);
    const { Transaction } = ctx;

    const pkBytes: Uint8Array =
        typeof opts.publicKey === "string"
            ? hexToBytes(opts.publicKey)
            : opts.publicKey;

    if (pkBytes.length !== 32) {
        throw new Error(`Invalid Ed25519 public key length: ${pkBytes.length} (expected 32)`);
    }

    const tx = new Transaction();
    tx.moveCall({
        target: `${opts.packageId}::account::remove_delegate_key`,
        arguments: [
            tx.object(opts.accountId),
            tx.pure("vector<u8>", Array.from(pkBytes)),
        ],
    });

    const { digest } = await signAndExecute(ctx, tx);
    return { digest };
}

// ============================================================
// generateDelegateKey
// ============================================================

/**
 * Generate a new Ed25519 delegate keypair.
 *
 * Returns the private key (hex), public key (bytes), and derived MySo address.
 * The private key can be used with `Memory.create({ key })`.
 *
 * @example
 * ```typescript
 * const delegate = await generateDelegateKey()
 * console.log(delegate.privateKey)  // hex string — store securely!
 * console.log(delegate.mysoAddress)  // 0x... — use in addDelegateKey
 *
 * // Use with SDK
 * const memory = Memory.create({ key: delegate.privateKey, accountId: "0x..." })
 * ```
 */
export async function generateDelegateKey(): Promise<{
    privateKey: string;
    publicKey: Uint8Array;
    mysoAddress: string;
}> {
    const ed = await import("@noble/ed25519");
    const { blake2b } = await import("@noble/hashes/blake2.js");

    // Generate random 32-byte private key
    const privateKeyBytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(privateKeyBytes);
    const publicKey = await ed.getPublicKeyAsync(privateKeyBytes);

    // Derive MySo address
    const input = new Uint8Array(33);
    input[0] = 0x00; // Ed25519 scheme flag
    input.set(publicKey, 1);
    const addressBytes = blake2b(input, { dkLen: 32 });
    const mysoAddress = "0x" + bytesToHex(addressBytes);

    return {
        privateKey: bytesToHex(privateKeyBytes),
        publicKey,
        mysoAddress,
    };
}
