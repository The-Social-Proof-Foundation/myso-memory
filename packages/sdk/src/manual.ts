/**
 * memory — Manual Client (Full Client-Side)
 *
 * User-side flow where the SDK handles everything locally:
 * - MYDATA encrypt/decrypt via @socialproof/mydata (user's own MySo wallet)
 * - File Storage upload/download via @socialproof/file-storage
 * - Embedding via OpenAI-compatible API (user's own key)
 * - Vector registration via Memory server (Ed25519 signed)
 *
 * @example
 * ```typescript
 * import { MemoryManual } from "@socialproof/memory"
 *
 * const memory = MemoryManual.create({
 *     key: process.env.MEMORY_DELEGATE_KEY!,      // Ed25519 delegate key
 *     mysoPrivateKey: process.env.MYSO_PRIVATE_KEY!, // mysoprivkey1... for MYDATA + File Storage
 *     embeddingApiKey: process.env.OPENAI_API_KEY!,
 *     packageId: "0x...",
 *     accountId: "0x...",
 * })
 *
 * // Remember — all client-side: embed → MYDATA encrypt → File Storage upload → register
 * await memory.rememberManual("I'm allergic to peanuts")
 *
 * // Recall — all client-side: embed → search → download → MYDATA decrypt
 * const result = await memory.recallManual("food allergies")
 * ```
 */

import type {
    MemoryManualConfig,
    WalletSigner,
    RememberManualResult,
    RecallManualResult,
    RecallManualMemory,
    RestoreResult,
} from "./types.js";
import { sha256hex, hexToBytes, bytesToHex, normalizeServerUrl, sanitizeServerError } from "./utils.js";

// ============================================================
// Constants
// ============================================================

// Default MYDATA key server object IDs per network
// Users can override via MYDATA_KEY_SERVERS in their environment
const DEFAULT_KEY_SERVERS: Record<string, string[]> = {
    mainnet: [
        "0x145540d931f182fef76467dd8074c9839aea126852d90d18e1556fcbbd1208b6", // Overclock (Open)
        "0xe0eb52eba9261b96e895bbb4deca10dcd64fbc626a1133017adcd5131353fd10", // Studio Mirai (Open)
    ],
    testnet: [
        "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75",
        "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8",
    ],
};

const MYSO_CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";

// ============================================================
// MemoryManual Client
// ============================================================

export class MemoryManual {
    private delegatePrivateKey: Uint8Array;
    private delegatePublicKey: Uint8Array | null = null;
    private serverUrl: string;
    private config: MemoryManualConfig;
    private walletSigner: WalletSigner | null;
    private namespace: string;

    // Lazily initialized heavy clients (typed as any to avoid peer dep compile errors)
    private _mysoClient: any = null;
    private _mydataClient: any = null;
    private _FileStorageClient: any = null;
    private _keypair: any = null;

    private constructor(config: MemoryManualConfig) {
        if (!config.mysoPrivateKey && !config.walletSigner) {
            throw new Error("MemoryManual: provide either mysoPrivateKey or walletSigner");
        }
        if (config.mysoPrivateKey && config.walletSigner) {
            throw new Error("MemoryManual: provide mysoPrivateKey OR walletSigner, not both");
        }
        this.delegatePrivateKey = typeof config.key === "string" ? hexToBytes(config.key) : config.key;
        // LOW-22: default to HTTPS; warn (do not throw) on plaintext HTTP
        // against non-localhost hosts.
        this.serverUrl = normalizeServerUrl(config.serverUrl ?? "https://memory.mysocial.network/");
        this.walletSigner = config.walletSigner ?? null;
        this.config = config;
        this.namespace = config.namespace ?? "default";
    }

    /**
     * Create a new MemoryManual client.
     *
     * Requires peer dependencies: @socialproof/myso, @socialproof/mydata, @socialproof/file-storage
     *
     * @param config.key - Ed25519 delegate private key (hex) for server auth
     * @param config.mysoPrivateKey - MySo private key (bech32) for MYDATA + File Storage (OR walletSigner)
     * @param config.walletSigner - Connected wallet signer from dapp-kit (OR mysoPrivateKey)
     * @param config.embeddingApiKey - OpenAI/OpenRouter API key for embeddings
     * @param config.packageId - Memory contract package ID
     * @param config.accountId - MemoryAccount object ID (for MYDATA approve_key_policy)
     */
    static create(config: MemoryManualConfig): MemoryManual {
        return new MemoryManual(config);
    }

    /**
     * Securely wipe the delegate private and public keys from memory.
     * Prevents key extraction from V8 heap dumps.
     */
    destroy(): void {
        if (this.delegatePrivateKey) {
            this.delegatePrivateKey.fill(0);
        }
        if (this.delegatePublicKey) {
            this.delegatePublicKey.fill(0);
        }
    }

    /** Whether this client uses a connected wallet signer (vs raw keypair) */
    get isWalletMode(): boolean {
        return this.walletSigner !== null;
    }

    // ============================================================
    // Lazy Client Initialization
    // All @mysten/* imports are dynamic to avoid requiring peer deps at
    // compile time. Users who only use the server-mode Memory class
    // don't need these packages installed.
    // ============================================================

    private async getMySoClient() {
        if (!this._mysoClient) {
            // Prefer externally-provided client (e.g. from dapp-kit's useMySoClient())
            if (this.config.mysoClient) {
                this._mysoClient = this.config.mysoClient;
            } else {
                // Fallback: create client via dynamic import
                // @ts-ignore — optional peer dependency
                const mod = await import("@socialproof/myso/client");
                const MySoClient = (mod as any).MySoClient;
                if (typeof MySoClient !== "function") {
                    throw new Error(
                        "MySoClient not found in @socialproof/myso/client. " +
                        "For @socialproof/myso v2.6.0+, pass mysoClient in config " +
                        "(e.g. from dapp-kit's useMySoClient())"
                    );
                }
                const network = this.config.mysoNetwork ?? "mainnet";
                const urls: Record<string, string> = {
                    testnet: "https://fullnode.testnet.mysosocial.network:443",
                    mainnet: "https://fullnode.mainnet.mysosocial.network:443",
                };
                this._mysoClient = new MySoClient({
                    url: urls[network] ?? urls.mainnet,
                });
            }
        }
        return this._mysoClient;
    }

    private async getKeypair() {
        if (this.walletSigner) {
            throw new Error("getKeypair() not available in wallet signer mode");
        }
        if (!this._keypair) {
            const { decodeMySoPrivateKey } = await import("@socialproof/myso/cryptography");
            const { Ed25519Keypair } = await import("@socialproof/myso/keypairs/ed25519");
            const { secretKey } = decodeMySoPrivateKey(this.config.mysoPrivateKey!);
            this._keypair = Ed25519Keypair.fromSecretKey(secretKey);
        }
        return this._keypair;
    }

    /** Get the owner address — from wallet signer or derived from keypair */
    private async getOwnerAddress(): Promise<string> {
        if (this.walletSigner) {
            return this.walletSigner.address;
        }
        const keypair = await this.getKeypair();
        return keypair.getPublicKey().toMySoAddress();
    }

    /** Sign and execute a transaction — via wallet popup or programmatic keypair */
    private async signAndExecuteTransaction(transaction: any): Promise<{ digest: string }> {
        if (this.walletSigner) {
            return this.walletSigner.signAndExecuteTransaction({ transaction });
        }
        const keypair = await this.getKeypair();
        const mysoClient = await this.getMySoClient();
        return mysoClient.signAndExecuteTransaction({
            signer: keypair,
            transaction,
        });
    }

    private async getMyDataClient() {
        if (!this._mydataClient) {
            // @ts-ignore — optional peer dependency
            const { MyDataClient } = await import("@socialproof/mydata");
            const mysoClient = await this.getMySoClient();
            const network = this.config.mysoNetwork ?? "mainnet";
            const keyServers = this.config.mydataKeyServers ?? DEFAULT_KEY_SERVERS[network] ?? [];
            if (keyServers.length === 0) {
                throw new Error(
                    `MemoryManual: no MYDATA key servers configured for network "${network}". ` +
                    "Please provide mydataKeyServers in config or set MYDATA_KEY_SERVERS env var."
                );
            }
            this._mydataClient = new MyDataClient({
                mysoClient,
                serverConfigs: keyServers.map((id) => ({
                    objectId: id,
                    weight: 1,
                })),
                verifyKeyServers: true,
            });
        }
        return this._mydataClient;
    }

    /** MED-10: MYDATA threshold — must match sidecar MYDATA_THRESHOLD (default 2). */
    private get mydataThreshold(): number {
        return this.config.mydataThreshold ?? 2;
    }

    private async getFileStorageClient() {
        if (!this._FileStorageClient) {
            // @ts-ignore — optional peer dependency
            const { FileStorageClient } = await import("@socialproof/file-storage");
            const mysoClient = await this.getMySoClient();
            const network = this.config.mysoNetwork ?? "mainnet";
            const uploadRelayHost = network === "testnet"
                ? "https://upload-relay.testnet.mysocial.network"
                : "https://upload-relay.mainnet.mysocial.network";
            this._FileStorageClient = new FileStorageClient({
                network: network as any,
                mysoClient,
                uploadRelay: {
                    host: uploadRelayHost,
                    sendTip: { max: 10_000_000 },
                },
            });
        }
        return this._FileStorageClient;
    }

    // ============================================================
    // Core Manual API
    // ============================================================

    /**
     * Remember (hybrid flow):
     * 1. Embed text (OpenAI/OpenRouter)
     * 2. MYDATA encrypt locally (no wallet signature needed)
     * 3. Send {encrypted_data, vector} to server — server handles File Storage upload relay
     */
    async rememberManual(text: string, namespace?: string): Promise<RememberManualResult> {
        if (!text) throw new Error("Text cannot be empty");

        const ns = namespace ?? this.namespace;

        // Step 1 & 2: Embed + MYDATA encrypt concurrently
        // LOW-24: Scope MYDATA encryption id by namespace so a delegate key
        // authorized for one namespace cannot unwrap ciphertext for another.
        const [vector, encrypted] = await Promise.all([
            this.embed(text),
            this.mydataEncrypt(new TextEncoder().encode(text), ns),
        ]);

        // Step 3: Send encrypted bytes (base64) + vector to server.
        // Server will upload to File Storage via upload-relay and return the blob_id.
        const encryptedBase64 = btoa(String.fromCharCode(...encrypted));
        return this.signedRequest<RememberManualResult>("POST", "/api/remember/manual", {
            encrypted_data: encryptedBase64,
            vector,
            namespace: ns,
        });
    }

    /**
     * Recall (manual/full client-side):
     * 1. Embed query (OpenAI)
     * 2. Search server for matching vectors
     * 3. Download blobs from File Storage
     * 4. MYDATA decrypt each blob
     */
    async recallManual(query: string, limit: number = 10, namespace?: string): Promise<RecallManualResult> {
        if (!query) throw new Error("Query cannot be empty");

        const ns = namespace ?? this.namespace;

        // Step 1: Embed query
        const vector = await this.embed(query);

        // Step 2: Search server
        const searchResult = await this.signedRequest<{ results: { blob_id: string; distance: number }[]; total: number }>(
            "POST",
            "/api/recall/manual",
            { vector, limit, namespace: ns },
        );

        if (searchResult.results.length === 0) {
            return { results: [], total: 0 };
        }

        // Step 3: Download all encrypted blobs from File Storage concurrently
        const downloadTasks = searchResult.results.map(async (hit) => {
            try {
                const data = await this.fileStorageDownload(hit.blob_id);
                return { blob_id: hit.blob_id, data, distance: hit.distance };
            } catch (err) {
                console.error(`[MemoryManual] File Storage download failed for ${hit.blob_id}:`, err);
                return null;
            }
        });
        const downloadedBlobs = (await Promise.all(downloadTasks)).filter(
            (d): d is { blob_id: string; data: Uint8Array; distance: number } => d !== null,
        );

        if (downloadedBlobs.length === 0) {
            return { results: [], total: 0 };
        }

        // Step 4: Create ONE MYDATA SessionKey (one wallet popup), then decrypt all blobs
        let mydataClient: any;
        let mysoClient: any;
        let SessionKey: any;
        let EncryptedObject: any;
        let Transaction: any;
        let sessionKey: any;
        try {
            mydataClient = await this.getMyDataClient();
            mysoClient = await this.getMySoClient();
            // @ts-ignore — optional peer dependency
            ({ SessionKey, EncryptedObject } = await import("@socialproof/mydata"));
            ({ Transaction } = await import("@socialproof/myso/transactions"));
        } catch (err) {
            console.error('[MemoryManual] Failed to initialize MYDATA/MYSO clients:', err);
            return { results: [], total: 0 };
        }

        const callerAddress = await this.getOwnerAddress();

        // Create signer (wallet adapter or keypair)
        const signer = await this.createSigner(callerAddress);

        // Create session key ONCE (triggers one wallet popup)
        // HIGH-7 / LOW-13: Reduced from 30 to 5 minutes to limit the exposure
        // window if a session token is compromised.
        try {
            sessionKey = await SessionKey.create({
                address: callerAddress,
                packageId: this.config.packageId,
                ttlMin: 5,
                signer,
                mysoClient,
            });
        } catch (err) {
            console.error('[MemoryManual] SessionKey.create failed:', err);
            return { results: [], total: 0 };
        }

        // Decrypt each blob sequentially using the shared session key
        const results: RecallManualMemory[] = [];
        for (const blob of downloadedBlobs) {
            try {
                const parsed = EncryptedObject.parse(blob.data);
                const fullId = parsed.id;

                // Build approve_key_policy PTB
                const idBytes = Array.from(
                    Uint8Array.from(fullId.match(/.{1,2}/g)!.map((b: string) => parseInt(b, 16))),
                );
                const tx = new Transaction();
                tx.moveCall({
                    target: `${this.config.packageId}::memory::approve_key_policy`,
                    arguments: [
                        tx.pure("vector<u8>", idBytes),
                        tx.object(this.config.accountId),
                        tx.object(MYSO_CLOCK),
                    ],
                });
                const txBytes = await tx.build({ client: mysoClient, onlyTransactionKind: true });

                // Fetch decryption keys using shared session key
                await mydataClient.fetchKeys({
                    ids: [fullId],
                    txBytes,
                    sessionKey,
                    threshold: this.mydataThreshold,
                });

                // Decrypt locally
                const plaintext = await mydataClient.decrypt({
                    data: blob.data,
                    sessionKey,
                    txBytes,
                });
                const text = new TextDecoder().decode(plaintext);
                results.push({ blob_id: blob.blob_id, text, distance: blob.distance });
            } catch (err) {
                console.error(`[MemoryManual] MYDATA decrypt failed for ${blob.blob_id}:`, err);
            }
        }

        return { results, total: results.length };
    }

    // ============================================================
    // Internal: Signer Factory
    // ============================================================

    /** Create a signer adapter — either from wallet or keypair */
    private async createSigner(callerAddress: string): Promise<any> {
        if (this.walletSigner) {
            const ws = this.walletSigner;
            return {
                toMySoAddress: () => callerAddress,
                getPublicKey: () => ({ toMySoAddress: () => callerAddress }),
                sign: async (data: Uint8Array) => {
                    const result = await ws.signPersonalMessage({ message: data });
                    return { signature: result.signature };
                },
                signPersonalMessage: async (data: Uint8Array) => {
                    const result = await ws.signPersonalMessage({ message: data });
                    return { signature: result.signature };
                },
            };
        }
        return this.getKeypair();
    }

    // ============================================================
    // Internal: Embedding
    // ============================================================

    private async embed(text: string): Promise<number[]> {
        if (!this.config.embeddingApiKey) {
            throw new Error(
                "MemoryManual: embeddingApiKey is required. " +
                "Provide your OpenAI or OpenRouter API key in config."
            );
        }

        const apiBase = (this.config.embeddingApiBase ?? "https://api.openai.com/v1").replace(/\/$/, "");
        const isOpenRouter = apiBase.includes("openrouter.ai");
        const defaultModel = isOpenRouter ? "openai/text-embedding-3-small" : "text-embedding-3-small";
        const model = this.config.embeddingModel ?? defaultModel;

        const resp = await fetch(`${apiBase}/embeddings`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${this.config.embeddingApiKey}`,
            },
            body: JSON.stringify({ model, input: text }),
        });

        if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(`Embedding API error (${resp.status}): ${errText}`);
        }

        const data = await resp.json() as { data: { embedding: number[] }[] };
        if (!data.data?.[0]?.embedding) {
            throw new Error("Embedding API returned no data");
        }
        return data.data[0].embedding;
    }

    // ============================================================
    // Internal: MYDATA Encrypt
    // ============================================================

    /**
     * MYDATA-encrypt a payload.
     *
     * LOW-24 (namespace scoping): The `id` passed to MYDATA is the on-chain
     * policy identifier used by `approve_key_policy` to gate decryption. We scope
     * encryption keys by namespace so a delegate authorized to decrypt
     * namespace "A" cannot unwrap ciphertext for namespace "B".
     *
     * ENG-1725 fix: The on-chain `approve_key_policy` does
     * `has_suffix(id, bcs::to_bytes(account.owner))` for the owner-caller
     * branch. The id MUST therefore end with the caller's 32 raw address
     * bytes (in hex form on the MYDATA side, raw on the Move side). The
     * previous LOW-24 layout — `hex(accountId) || hex(namespace)` — used
     * the MemoryAccount object id (not the owner address) and put the
     * namespace as the suffix, so `has_suffix` always failed and owners
     * could no longer recall their own manually-remembered data. (Delegate
     * decrypt still worked because the delegate branch skips the suffix
     * check.)
     *
     * Layout:
     *   id = hex(utf8(namespace)) || hex(callerAddress[2:])
     *
     * - namespace is the prefix → still distinct keys per namespace, so the
     *   LOW-24 isolation property is preserved (different ns → different
     *   MYDATA key).
     * - caller address (32 bytes) is the suffix → `has_suffix` passes for
     *   owner mode; delegate mode still passes via the delegate-list check
     *   in `approve_key_policy` regardless of suffix.
     *
     * NOTE: Ciphertext written between the original LOW-24 fix and this fix
     * (id = accountHex + nsHex) is unrecoverable by the owner caller. There
     * is no production data in that window per the team; if recovery is
     * needed, decrypt via a delegate key (delegate branch ignores suffix).
     */
    private async mydataEncrypt(plaintext: Uint8Array, namespace: string): Promise<Uint8Array> {
        const mydataClient = await this.getMyDataClient();

        // Build a namespace-scoped MYDATA id whose final 32 bytes are the
        // caller's address bytes, so the on-chain `approve_key_policy` owner-branch
        // `has_suffix(id, bcs::to_bytes(owner))` check passes. Hex-encoded
        // throughout so the id is a stable ASCII hex string.
        const callerAddress = await this.getOwnerAddress();
        const callerHex = callerAddress.startsWith("0x")
            ? callerAddress.slice(2)
            : callerAddress;
        const nsHex = bytesToHex(new TextEncoder().encode(namespace));
        const scopedId = `${nsHex}${callerHex}`;

        const result = await mydataClient.encrypt({
            threshold: this.mydataThreshold,
            packageId: this.config.packageId,
            id: scopedId,
            data: plaintext,
        });

        return new Uint8Array(result.encryptedObject);
    }

    // ============================================================
    // Internal: File Storage Upload/Download
    // ============================================================

    private async fileStorageUpload(data: Uint8Array): Promise<string> {
        // Direct HTTP PUT to File Storage publisher (works in both browser and Node.js,
        // unlike @socialproof/file-storage SDK which uses WASM and requires Node.js)
        const network = this.config.mysoNetwork ?? "mainnet";
        const defaultPublisher = network === "testnet"
            ? "https://publisher.file-storage-testnet.mysocial.network"
            : "https://publisher.file-storage-mainnet.mysocial.network";
        const publisherUrl = this.config.fileStoragePublisherUrl ?? defaultPublisher;
        const epochs = this.config.fileStorageEpochs ?? 50;

        const resp = await fetch(`${publisherUrl}/v1/blobs?epochs=${epochs}&deletable=true`, {
            method: "PUT",
            headers: { "Content-Type": "application/octet-stream" },
            body: data as unknown as BodyInit,
        });

        if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(`File Storage upload failed (${resp.status}): ${errText}`);
        }

        const result = await resp.json() as any;
        // Response can be { newlyCreated: { blobObject: { blobId } } }
        // or { alreadyCertified: { blobId } }
        const blobId = result.newlyCreated?.blobObject?.blobId
            ?? result.alreadyCertified?.blobId;

        if (!blobId) {
            throw new Error(`File Storage upload: unexpected response: ${JSON.stringify(result)}`);
        }
        return blobId;
    }

    private async fileStorageDownload(blobId: string): Promise<Uint8Array> {
        // Direct HTTP fetch to File Storage aggregator (works in both browser and Node.js,
        // unlike @socialproof/file-storage SDK which requires Node.js APIs)
        const network = this.config.mysoNetwork ?? "mainnet";
        const defaultAggregator = network === "testnet"
            ? "https://aggregator.file-storage-testnet.mysocial.network"
            : "https://aggregator.file-storage-mainnet.mysocial.network";
        const aggregatorUrl = this.config.fileStorageAggregatorUrl ?? defaultAggregator;
        const resp = await fetch(`${aggregatorUrl}/v1/blobs/${blobId}`);
        if (!resp.ok) {
            throw new Error(`File Storage download failed (${resp.status}): ${await resp.text()}`);
        }
        const buffer = await resp.arrayBuffer();
        return new Uint8Array(buffer);
    }

    // ============================================================
    // Internal: Signed HTTP Requests (same pattern as Memory class)
    // ============================================================

    private async getDelegatePublicKey(): Promise<Uint8Array> {
        if (!this.delegatePublicKey) {
            const ed = await import("@noble/ed25519");
            this.delegatePublicKey = await ed.getPublicKeyAsync(this.delegatePrivateKey);
        }
        return this.delegatePublicKey;
    }

    /**
     * Make a signed request to the server.
     *
     * Signature format (LOW-1 + MED-1 + LOW-23):
     *   "{timestamp}.{method}.{path_and_query}.{body_sha256}.{nonce}.{account_id}"
     *
     * Headers sent: x-public-key, x-signature, x-timestamp, x-nonce, x-account-id.
     */
    private async signedRequest<T>(
        method: string,
        path: string,
        body: object,
    ): Promise<T> {
        const ed = await import("@noble/ed25519");

        const timestamp = Math.floor(Date.now() / 1000).toString();
        const bodyStr = JSON.stringify(body);
        const bodySha256 = await sha256hex(bodyStr);

        // MED-1: per-request nonce for replay protection.
        const nonce = crypto.randomUUID();

        // LOW-23: include x-account-id in the canonical signed message so an
        // intermediary cannot rebind a signed request to a different account.
        const message = `${timestamp}.${method}.${path}.${bodySha256}.${nonce}.${this.config.accountId}`;
        const msgBytes = new TextEncoder().encode(message);

        const signature = await ed.signAsync(msgBytes, this.delegatePrivateKey);
        const publicKey = await this.getDelegatePublicKey();

        const url = `${this.serverUrl}${path}`;
        const res = await fetch(url, {
            method,
            headers: {
                "Content-Type": "application/json",
                "x-public-key": bytesToHex(publicKey),
                "x-signature": bytesToHex(signature),
                "x-timestamp": timestamp,
                "x-nonce": nonce,
                "x-account-id": this.config.accountId,
            },
            body: bodyStr,
        });

        if (!res.ok) {
            // LOW-26: sanitize server error bodies before re-throwing.
            const raw = await res.text();
            const { message: sanitized, serverCode } = sanitizeServerError(res.status, raw);
            const err = new Error(sanitized) as Error & {
                status?: number;
                serverCode?: string;
                cause?: string;
            };
            err.status = res.status;
            if (serverCode) err.serverCode = serverCode;
            err.cause = raw;
            throw err;
        }

        return res.json() as Promise<T>;
    }

    // ============================================================
    // Restore
    // ============================================================

    /**
     * Restore a namespace — server downloads all blobs from File Storage,
     * decrypts with delegate key, re-embeds, and re-indexes.
     *
     * @param namespace - Namespace to restore
     * @returns RestoreResult with count of restored entries
     */
    async restore(namespace: string, limit: number = 50): Promise<RestoreResult> {
        return this.signedRequest<RestoreResult>("POST", "/api/restore", {
            namespace,
            limit,
        });
    }
}
