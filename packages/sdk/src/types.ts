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
    /** Default namespace for memory isolation (default: "default") */
    namespace?: string;
}

// ============================================================
// API Types
// ============================================================

/** Result from remember() */
export interface RememberResult {
    id: string;
    blob_id: string;
    owner: string;
    namespace: string;
}

/** A single recalled memory */
export interface RecallMemory {
    blob_id: string;
    text: string;
    distance: number;
}

/** Result from recall() */
export interface RecallResult {
    results: RecallMemory[];
    total: number;
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
}

/** Result from rememberManual() */
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
}

/** A single search hit — raw blobId + distance (no decrypted text) */
export interface RecallManualHit {
    blob_id: string;
    distance: number;
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
    approvalRequiredCaps?: number;
    maxActionSpend?: number | null;
    platformScope?: string | null;
    expiresAt?: number | null;
}

/** Options for registerSubAgent() */
export interface RegisterSubAgentOpts extends MemoryTxOpts, SubAgentRegistrationFields {}

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
