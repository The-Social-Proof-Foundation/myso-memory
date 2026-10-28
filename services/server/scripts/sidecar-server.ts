/**
 * MYDATA HTTP Sidecar Server
 *
 * Long-lived Express server that wraps MYDATA encrypt/decrypt. Encrypted blobs
 * are stored and restored through Cloudflare R2 in the Rust service.
 * Started once at server boot — eliminates ~1-2s Node.js cold-start per call.
 *
 * Endpoints:
 *   POST /mydata/encrypt   → { data, owner, packageId } → { encryptedData }
 *   POST /mydata/decrypt   → { data, packageId, accountId } (+ session headers) → { decryptedData }
 *   GET  /health         → { status: "ok" }
 */

import express, { Request, Response, NextFunction } from "express";
import { timingSafeEqual, randomUUID } from "crypto";
import { MySoJsonRpcClient, getJsonRpcFullnodeUrl } from "@socialproof/myso/jsonRpc";
import { Ed25519Keypair } from "@socialproof/myso/keypairs/ed25519";
import { decodeMySoPrivateKey } from "@socialproof/myso/cryptography";
import { Transaction } from "@socialproof/myso/transactions";
import { MyDataClient, SessionKey, EncryptedObject } from "@socialproof/mydata";
import { resolveKeyServers } from "./mydata-key-servers.js";
import { checkListingAccess, decryptListing, ListingAccessError } from "./mydata-listing.js";
import { addApproveKeyPolicyCall, describeKeyMismatch, type OrgDecryptContext } from "./mydata-policy.js";

// ============================================================
// Shared clients (initialized once at boot — the whole point!)
// ============================================================
// ============================================================
// Environment-driven network config
// ============================================================

const MYSO_NETWORK_RAW = process.env.MYSO_NETWORK || "mainnet";
// The MySo SDK client accepts mainnet|testnet; map devnet/localnet to testnet.
const CLIENT_NETWORK: "mainnet" | "testnet" =
    MYSO_NETWORK_RAW === "mainnet" ? "mainnet" : "testnet";

const MYSO_RPC_URL =
    process.env.MYSO_RPC_URL ||
    getJsonRpcFullnodeUrl(CLIENT_NETWORK);
const ALLOW_LEGACY_SOCIAL_KEY_FORWARDING =
    /^(1|true)$/i.test(process.env.ALLOW_LEGACY_SOCIAL_KEY_FORWARDING || "");
const ALLOW_LEGACY_DELEGATE_KEY_FORWARDING =
    /^(1|true)$/i.test(process.env.ALLOW_LEGACY_DELEGATE_KEY_FORWARDING || "");

const mysoClient = new MySoJsonRpcClient({
    url: MYSO_RPC_URL,
    network: CLIENT_NETWORK,
});

// MYDATA key server object IDs (comma-separated via env var). Duplicates are
// ignored — @socialproof/mydata throws InvalidClientOptionsError if any repeat.
const MYDATA_KEY_SERVERS = [
    ...new Set(
        (process.env.MYDATA_KEY_SERVERS || "")
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
    ),
];

if (MYDATA_KEY_SERVERS.length === 0) {
    console.error("[sidecar] WARNING: MYDATA_KEY_SERVERS env var is empty — MYDATA encrypt/decrypt will fail");
}

const MYDATA_THRESHOLD = parseInt(process.env.MYDATA_THRESHOLD || "2", 10);

// Optional MySo keys for local gas sponsorship
const SERVER_MYSO_PRIVATE_KEYS = (process.env.SERVER_MYSO_PRIVATE_KEYS || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

if (SERVER_MYSO_PRIVATE_KEYS.length === 0 && process.env.SERVER_MYSO_PRIVATE_KEY) {
    SERVER_MYSO_PRIVATE_KEYS.push(process.env.SERVER_MYSO_PRIVATE_KEY.trim());
}

if (SERVER_MYSO_PRIVATE_KEYS.length === 0) {
    console.warn("[sidecar] no local sponsor keys are configured");
}

/**
 * MYDATA client, built lazily so a stale `MYDATA_KEY_SERVERS` pin (a regenesised localnet)
 * can be re-resolved from GraphQL first. Only a successful build is memoized, so a chain that
 * is still coming up is retried on the next request rather than poisoned for the process.
 */
let mydataClientPromise: Promise<MyDataClient> | null = null;
let activeKeyServerIds: string[] = [];

function getMydataClient(): Promise<MyDataClient> {
    if (mydataClientPromise) return mydataClientPromise;
    const built = (async () => {
        const resolved = await resolveKeyServers(
            {
                configured: MYDATA_KEY_SERVERS,
                network: MYSO_NETWORK_RAW,
                graphqlUrl: process.env.SOCIAL_CHAIN_GRAPHQL_URL,
                packageId: process.env.MYDATA_PACKAGE_ID,
            },
            {
                getObjectType: async (id) => {
                    const res = await mysoClient.getObject({ id, options: { showType: true } } as any);
                    return (res as any)?.data?.type ?? null;
                },
                queryGraphql: async (url, query) => {
                    const res = await fetch(url, {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ query }),
                    });
                    if (!res.ok) throw new Error(`GraphQL ${res.status}`);
                    return ((await res.json()) as { data?: unknown }).data ?? null;
                },
            },
        );
        if (resolved.stale.length > 0) {
            console.warn(
                `[sidecar] MYDATA_KEY_SERVERS pin(s) not found on chain: ${resolved.stale.join(", ")}` +
                    (resolved.source === "discovered"
                        ? ` — using discovered key server(s) ${resolved.ids.join(", ")}; update the env to silence this`
                        : ""),
            );
        }
        activeKeyServerIds = resolved.ids;
        return new MyDataClient({
            mysoClient: mysoClient as any,
            serverConfigs: resolved.ids.map((id) => ({ objectId: id, weight: 1 })),
            verifyKeyServers: true,
        });
    })();
    mydataClientPromise = built;
    built.catch(() => {
        if (mydataClientPromise === built) mydataClientPromise = null;
    });
    return built;
}


const MYSO_CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";

const ENOKI_API_BASE_URL = "https://api.enoki.mystenlabs.com/v1";
const enokiApiKey = process.env.ENOKI_API_KEY;
const enokiNetwork = (process.env.ENOKI_NETWORK || process.env.MYSO_NETWORK || "mainnet") as
    | "mainnet"
    | "testnet"
    | "devnet";
const ENOKI_FALLBACK_TO_DIRECT_SIGN = (() => {
    const raw = (process.env.ENOKI_FALLBACK_TO_DIRECT_SIGN || "true").trim().toLowerCase();
    return raw !== "0" && raw !== "false" && raw !== "no";
})();
const LOCAL_SPONSOR_ENABLED =
    MYSO_NETWORK_RAW === "localnet" &&
    /^(1|true)$/i.test(process.env.LOCAL_SPONSOR_ENABLED || "");
const LOCAL_SPONSOR_GAS_BUDGET = process.env.LOCAL_SPONSOR_GAS_BUDGET || "100000000";
const LOCAL_SPONSOR_TTL_MS = 5 * 60 * 1000;

type EnokiDataWrapper<T> = { data: T };
type EnokiSponsorResponse = { bytes: string; digest: string; gasBudgetMist?: string };
type EnokiExecuteResponse = { digest: string };
type LocalSponsoredTransaction = {
    bytes: string;
    sponsorSignature: string;
    expiresAtMs: number;
};
const localSponsoredTransactions = new Map<string, LocalSponsoredTransaction>();
let localSponsorKeyIndex = 0;
async function callEnoki<T>(path: string, payload: unknown): Promise<T> {
    if (!enokiApiKey) {
        throw new Error("ENOKI_API_KEY is not configured");
    }

    const resp = await fetch(`${ENOKI_API_BASE_URL}${path}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${enokiApiKey}`,
        },
        body: JSON.stringify(payload),
    });

    const text = await resp.text();
    if (!resp.ok) {
        throw new Error(`Enoki API error (${resp.status}): ${text}`);
    }

    const parsed = JSON.parse(text) as EnokiDataWrapper<T>;
    return parsed.data;
}

function pruneLocalSponsoredTransactions(now = Date.now()): void {
    for (const [digest, pending] of localSponsoredTransactions) {
        if (pending.expiresAtMs <= now) localSponsoredTransactions.delete(digest);
    }
}

async function createLocalSponsoredTransaction(
    transactionBlockKindBytes: string,
    sender: string,
    gasBudgetMist?: string,
): Promise<EnokiSponsorResponse> {
    if (!LOCAL_SPONSOR_ENABLED || SERVER_MYSO_PRIVATE_KEYS.length === 0) {
        throw new Error("Local sponsorship is not configured");
    }
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(sender)) {
        throw new Error("sender must be a MySo address");
    }
    const kindBytes = Buffer.from(transactionBlockKindBytes, "base64");
    if (kindBytes.length < 10 || kindBytes.length > 128 * 1024) {
        throw new Error("transactionBlockKindBytes is outside the allowed size");
    }
    pruneLocalSponsoredTransactions();
    if (localSponsoredTransactions.size >= 1_000) {
        throw new Error("Local sponsorship queue is full");
    }

    const keyIndex = localSponsorKeyIndex++ % SERVER_MYSO_PRIVATE_KEYS.length;
    const sponsor = keypairFromPool(keyIndex);
    const tx = Transaction.fromKind(new Uint8Array(kindBytes));
    tx.setSenderIfNotSet(sender);
    if (tx.getData().sender?.toLowerCase() !== sender.toLowerCase()) {
        throw new Error("transaction sender does not match the sponsorship request");
    }
    tx.setGasOwner(sponsor.toMySoAddress());
    if (gasBudgetMist !== undefined) tx.setGasBudget(BigInt(gasBudgetMist));
    else tx.setGasBudgetIfNotSet(LOCAL_SPONSOR_GAS_BUDGET);
    const bytes = await tx.build({ client: mysoClient as any });
    const digest = await tx.getDigest({ client: mysoClient as any });
    const sponsorSignature = (await sponsor.signTransaction(bytes)).signature;
    const encodedBytes = Buffer.from(bytes).toString("base64");
    localSponsoredTransactions.set(digest, {
        bytes: encodedBytes,
        sponsorSignature,
        expiresAtMs: Date.now() + LOCAL_SPONSOR_TTL_MS,
    });
    return { bytes: encodedBytes, digest, gasBudgetMist: tx.getData().gasData.budget?.toString() };
}

function signedGasBudgetMist(bytesBase64: string): string {
    const bytes = Buffer.from(bytesBase64, "base64");
    if (bytes.length < 10 || bytes.length > 128 * 1024) throw new Error("sponsored transaction bytes are outside the allowed size");
    const tx = Transaction.from(new Uint8Array(bytes));
    const budget = tx.getData().gasData.budget;
    if (budget === undefined || budget === null || (typeof budget === "number" && !Number.isSafeInteger(budget))) throw new Error("sponsor returned a transaction without a precisely represented signed gas budget");
    if (BigInt(budget) <= 0n) throw new Error("sponsor returned a transaction without a valid signed gas budget");
    return BigInt(budget).toString();
}

async function executeLocalSponsoredTransaction(
    digest: string,
    senderSignature: string,
): Promise<EnokiExecuteResponse> {
    pruneLocalSponsoredTransactions();
    const pending = localSponsoredTransactions.get(digest);
    if (!pending) throw new Error("Unknown or expired local sponsored transaction");
    // Delete before awaiting RPC so two concurrent submissions cannot replay the same gas coin.
    localSponsoredTransactions.delete(digest);
    const executed = await mysoClient.executeTransactionBlock({
        transactionBlock: pending.bytes,
        signature: [senderSignature, pending.sponsorSignature],
        options: { showEffects: true },
    });
    if (executed.digest !== digest) {
        throw new Error("Fullnode returned an unexpected transaction digest");
    }
    return { digest: executed.digest };
}

// ============================================================
// Express app
// ============================================================

const app = express();
// HIGH-13: Use a conservative global default; MYDATA decrypt-batch has a
// route-specific JSON size limit.
// Global floor: 256 KiB is enough for every metadata-only JSON body
// (mydata/encrypt, mydata/decrypt, sponsor, sponsor/execute).
// On-chain listing ciphertext may be 256 KiB before base64 encoding.
app.use("/mydata/decrypt-listing", express.json({ limit: "512kb" }));
app.use("/mydata/check-listing-access", express.json({ limit: "512kb" }));
app.use(express.json({ limit: "256kb" }));

// CORS — sidecar is called only by the co-located Rust server, never by browsers.
// Remove all CORS headers so no cross-origin access is granted.
app.use((_req: Request, res: Response, next: NextFunction) => {
    res.removeHeader("Access-Control-Allow-Origin");
    res.removeHeader("Access-Control-Allow-Methods");
    res.removeHeader("Access-Control-Allow-Headers");
    if (_req.method === "OPTIONS") {
        return res.sendStatus(204);
    }
    next();
});

// Health check — placed before auth middleware so it is always reachable.
app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
});

// Shared-secret authentication — protects all routes registered after this point.
// Set SIDECAR_AUTH_TOKEN in the environment; callers must send it as Authorization: Bearer <token>.
// Sidecar refuses to start if SIDECAR_AUTH_TOKEN is not set.
const SIDECAR_AUTH_TOKEN = process.env.SIDECAR_AUTH_TOKEN;
if (!SIDECAR_AUTH_TOKEN) {
    console.error("[sidecar] FATAL: SIDECAR_AUTH_TOKEN not set. Refusing to start without auth.");
    process.exit(1);
}

app.use((req: Request, res: Response, next: NextFunction) => {
    const token = req.headers.authorization?.replace("Bearer ", "");
    const secretBuf = Buffer.from(SIDECAR_AUTH_TOKEN!);
    const providedBuf = Buffer.from(typeof token === "string" ? token : "");
    // timingSafeEqual prevents timing side-channel attacks on the token comparison.
    // Buffers must be same length — if lengths differ it's already a mismatch.
    const valid = providedBuf.length === secretBuf.length &&
        timingSafeEqual(providedBuf, secretBuf);
    if (!valid) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    next();
});

// Public verification only; no browser PRF outputs.
app.post('/key-backup/:operation', async (req, res) => {
    try {
        const {keyBackupOperation} = await import('./key-backup.js');
        res.json(await keyBackupOperation(String(req.params.operation), req.body));
    } catch { res.status(400).json({code: 'verification_rejected'}); }
});

// ============================================================
// POST /mydata/encrypt
// ============================================================
app.post("/mydata/encrypt", async (req, res) => {
    try {
        const { data, owner, packageId } = req.body;
        if (!data || !owner || !packageId) {
            return res.status(400).json({ error: "Missing required fields: data, owner, packageId" });
        }

        const plaintext = Buffer.from(data, "base64");
        const result = await (await getMydataClient()).encrypt({
            threshold: MYDATA_THRESHOLD,
            packageId,
            id: owner,
            data: new Uint8Array(plaintext),
        });

        const encryptedBase64 = Buffer.from(result.encryptedObject).toString("base64");
        res.json({ encryptedData: encryptedBase64 });
    } catch (err: any) {
        const traceId = randomUUID();
        console.error(`[mydata/encrypt] [${traceId}] error:`, err);
        res.status(500).json({ error: "Internal server error", traceId });
    }
});

/**
 * ENG-1697: Resolve a MYDATA SessionKey from the request headers.
 *
 * Preferred path: `x-mydata-session` contains a base64-encoded
 * `ExportedSessionKey` (built by the SDK on the client). We import it and
 * skip touching any private-key material.
 *
 * Legacy path: `x-delegate-key` contains the raw delegate private key
 * (hex or mysoprivkey bech32). We reconstruct the keypair and build the
 * SessionKey here — same behavior as before the migration. This path
 * will be removed at EOL once all SDK clients emit `x-mydata-session`.
 *
 * Returns `null` when neither header is present so the caller can emit a
 * 400 with a clear error message.
 */
async function resolveSessionKey(
    req: express.Request,
    packageId: string,
): Promise<SessionKey | null> {
    const sessionHeader = req.headers["x-mydata-session"] as string | undefined;
    if (sessionHeader) {
        const exportedJson = Buffer.from(sessionHeader, "base64").toString("utf8");
        const exported = JSON.parse(exportedJson);
        return SessionKey.import(exported, mysoClient as any);
    }

    const privateKey = req.headers["x-delegate-key"] as string | undefined;
    if (!privateKey) return null;
    if (!ALLOW_LEGACY_DELEGATE_KEY_FORWARDING) {
        throw new Error("Legacy x-delegate-key transport is disabled");
    }

    let keypair: Ed25519Keypair;
    if (privateKey.startsWith("mysoprivkey")) {
        const { secretKey } = decodeMySoPrivateKey(privateKey);
        keypair = Ed25519Keypair.fromSecretKey(secretKey);
    } else {
        // LOW-12: Validate hex format before parsing to prevent injection
        if (!/^[0-9a-fA-F]+$/.test(privateKey) || privateKey.length !== 64) {
            throw new Error("privateKey must be 64-char hex string or mysoprivkey bech32");
        }
        const keyBytes = Uint8Array.from(
            privateKey.match(/.{1,2}/g)!.map((b: string) => parseInt(b, 16)),
        );
        keypair = Ed25519Keypair.fromSecretKey(keyBytes);
    }
    return await SessionKey.create({
        address: keypair.getPublicKey().toMySoAddress(),
        packageId,
        ttlMin: 5,
        signer: keypair,
        mysoClient: mysoClient as any,
    });
}

// ============================================================
// Org-scoped key policy routing (FX3 / enterprise v1)
// ============================================================

const MYSO_ADDRESS_RE = /^0x[0-9a-fA-F]{1,64}$/;

function normalizeMySoAddress(addr: string): string {
    return addr.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
}

/**
 * Decide whether a decrypt request targets an org-identity blob.
 *
 * Org-visible blobs encrypt under the organization object id (`mydataOwner ===
 * organizationId`); key release is gated on-chain by `approve_org_key_policy`
 * (OrgMemoryReader on the org's share group). Owner-identity blobs — private,
 * account, and legacy pre-org rows — keep the existing `approve_key_policy` path.
 *
 * The caller (memory relayer) fetches `organizationId` / `orgMemoryGroupId` from
 * social-server's org summary endpoint; the sidecar never derives them locally.
 */
function resolveOrgDecryptContext(body: {
    mydataOwner?: string;
    organizationId?: string;
    orgMemoryGroupId?: string;
}): OrgDecryptContext | null {
    const { mydataOwner, organizationId, orgMemoryGroupId } = body;
    if (!mydataOwner || !organizationId || !orgMemoryGroupId) return null;
    if (!MYSO_ADDRESS_RE.test(organizationId) || !MYSO_ADDRESS_RE.test(orgMemoryGroupId)) {
        throw new Error("Invalid organizationId or orgMemoryGroupId format");
    }
    if (normalizeMySoAddress(mydataOwner) !== normalizeMySoAddress(organizationId)) {
        return null;
    }
    return { organizationId, orgMemoryGroupId };
}

// ============================================================
// Named MyData listing path: session-only, fixed policy, no request-shared key cache.
app.post("/mydata/decrypt-listing", async (req, res) => {
    let plaintext: Uint8Array | undefined;
    try {
        plaintext = await decryptListing(req.body, req.headers["x-mydata-session"], {
            packageId: process.env.MEMORY_PACKAGE_ID || "", memoryConfigId: process.env.MEMORY_CONFIG_ID || "",
            blockListId: process.env.BLOCK_LIST_REGISTRY_ID || "", mysoClient: mysoClient as any,
            createClient: async () => {
                await getMydataClient(); // Public discovery only; never use its derived-key cache here.
                const keyServerIds = [...activeKeyServerIds];
                return { keyServerIds, client: new MyDataClient({ mysoClient: mysoClient as any,
                    serverConfigs: keyServerIds.map(objectId => ({ objectId, weight: 1 })), verifyKeyServers: true }) };
            },
        });
        res.setHeader("Cache-Control", "no-store");
        return res.json({ decryptedData: Buffer.from(plaintext).toString("base64") });
    } catch (error) {
        // Do not log SDK exceptions: they can carry session/ciphertext/provider details.
        return res.status(error instanceof ListingAccessError ? error.status : 403)
            .json({ error: error instanceof ListingAccessError ? error.message : "Listing access or decryption could not be authorized" });
    } finally { plaintext?.fill(0); }
});

// Check current key-server policy without constructing or returning plaintext.
app.post("/mydata/check-listing-access", async (req, res) => {
    try {
        await checkListingAccess(req.body, req.headers["x-mydata-session"], {
            packageId: process.env.MEMORY_PACKAGE_ID || "", memoryConfigId: process.env.MEMORY_CONFIG_ID || "",
            blockListId: process.env.BLOCK_LIST_REGISTRY_ID || "", mysoClient: mysoClient as any,
            createClient: async () => {
                await getMydataClient(); // Public discovery only; never use its derived-key cache here.
                const keyServerIds = [...activeKeyServerIds];
                return { keyServerIds, client: new MyDataClient({ mysoClient: mysoClient as any,
                    serverConfigs: keyServerIds.map(objectId => ({ objectId, weight: 1 })), verifyKeyServers: true }) };
            },
        });
        res.setHeader("Cache-Control", "no-store");
        return res.json({ authorized: true, source: "current_key_server_policy" });
    } catch (error) {
        // Never log SDK exceptions: they can contain session/ciphertext/provider data.
        return res.status(error instanceof ListingAccessError ? error.status : 503)
            .json({ error: error instanceof ListingAccessError ? error.message : "Current MyData access could not be authorized" });
    }
});

// POST /mydata/decrypt
// ============================================================
app.post("/mydata/decrypt", async (req, res) => {
    try {
        const { data, packageId, accountId, platformId, platformScope } = req.body;
        if (!data || !packageId || !accountId) {
            return res.status(400).json({ error: "Missing required fields: data, packageId, accountId" });
        }

        let orgCtx: OrgDecryptContext | null;
        try {
            orgCtx = resolveOrgDecryptContext(req.body);
        } catch (err: any) {
            return res.status(400).json({ error: err.message });
        }

        // Defense-in-depth: when caller declares platform_scope, require matching platformId.
        if (platformScope) {
            const actionPlatform = platformId ?? req.headers["x-platform-id"];
            const normalize = (a: string) => a.replace(/^0x/i, "").toLowerCase();
            if (!actionPlatform || normalize(String(platformScope)) !== normalize(String(actionPlatform))) {
                return res.status(403).json({ error: "platform scope mismatch" });
            }
        }

        // ENG-1697: resolve credential (x-mydata-session preferred; legacy
        // x-delegate-key supported during the deprecation window).
        const sessionKey = await resolveSessionKey(req, packageId);
        if (!sessionKey) {
            return res.status(400).json({
                error: ALLOW_LEGACY_DELEGATE_KEY_FORWARDING
                    ? "Missing credential: provide x-mydata-session or the enabled legacy x-delegate-key header"
                    : "Missing credential: provide x-mydata-session",
            });
        }

        // Parse encrypted object to get key ID
        const encryptedData = new Uint8Array(Buffer.from(data, "base64"));
        const parsed = EncryptedObject.parse(encryptedData);
        const fullId = parsed.id;

        const client = await getMydataClient();
        const mismatch = describeKeyMismatch(parsed, sessionKey.getPackageId(), activeKeyServerIds);
        if (mismatch) {
            console.warn(`[mydata/decrypt] key mismatch: ${mismatch}`);
            return res.status(409).json({ error: `key mismatch: ${mismatch}` });
        }

        // Convert hex ID to byte array for PTB
        const idBytes = Array.from(
            Uint8Array.from(fullId.match(/.{1,2}/g)!.map((b: string) => parseInt(b, 16)))
        );

        // Build the key-policy approval PTB: org-identity blobs route through
        // approve_org_key_policy (OrgMemoryReader gate); everything else keeps
        // the owner-suffix approve_key_policy path.
        const tx = new Transaction();
        addApproveKeyPolicyCall(tx, packageId, process.env.MEMORY_CONFIG_ID || "", idBytes, accountId, orgCtx);
        let txBytes: Uint8Array;
        try {
            txBytes = await tx.build({ client: mysoClient as any, onlyTransactionKind: true });
        } catch (err: any) {
            console.warn(`[mydata/decrypt] key policy inputs unresolved: ${err.message}`);
            return res.status(409).json({ error: `key policy inputs unresolved: ${err.message}` });
        }

        // Fetch keys from key servers
        await client.fetchKeys({
            ids: [fullId],
            txBytes,
            sessionKey,
            threshold: MYDATA_THRESHOLD,
        });

        // Decrypt locally
        const decrypted = await client.decrypt({
            data: encryptedData,
            sessionKey,
            txBytes,
        });

        const decryptedBase64 = Buffer.from(decrypted).toString("base64");
        res.json({ decryptedData: decryptedBase64 });
    } catch (err: any) {
        const traceId = randomUUID();
        console.error(`[mydata/decrypt] [${traceId}] error:`, err);
        res.status(500).json({ error: "Internal server error", traceId });
    }
});

// ============================================================
// POST /mydata/decrypt-batch
// Decrypt multiple MYDATA-encrypted blobs with a single SessionKey.
// Avoids "Not enough shares" errors when decrypting many blobs at once.
// ============================================================
// HIGH-13: batch body can be large (up to 25 × ~320 KiB max-item = ~8 MB)
// Apply a per-route json() that overrides the 256 KiB global for this endpoint only.
app.post("/mydata/decrypt-batch", express.json({ limit: "8mb" }), async (req, res) => {
    try {
        const { items, packageId, accountId } = req.body;
        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: "Missing required field: items (array of base64 encrypted data)" });
        }
        // HIGH-13 / MED-13: Cap items. 25 × max-item body = ~8 MB (matches the
        // per-route body limit above). Tightened from 50 to 25 so worst-case
        // in-memory allocation stays bounded even at the new limit.
        if (items.length > 25) {
            return res.status(400).json({ error: "items array exceeds maximum of 25 elements" });
        }
        if (!packageId || !accountId) {
            return res.status(400).json({ error: "Missing required fields: packageId, accountId" });
        }

        // Org context applies to the whole batch — callers must not mix org-identity
        // and owner-identity blobs in one request (the PTB aborts as a unit).
        let orgCtx: OrgDecryptContext | null;
        try {
            orgCtx = resolveOrgDecryptContext(req.body);
        } catch (err: any) {
            return res.status(400).json({ error: err.message });
        }

        // ENG-1697: resolve credential (x-mydata-session preferred; legacy
        // x-delegate-key supported during the deprecation window).
        const sessionKey = await resolveSessionKey(req, packageId);
        if (!sessionKey) {
            return res.status(400).json({
                error: ALLOW_LEGACY_DELEGATE_KEY_FORWARDING
                    ? "Missing credential: provide x-mydata-session or the enabled legacy x-delegate-key header"
                    : "Missing credential: provide x-mydata-session",
            });
        }

        // Parse all encrypted objects and collect unique MYDATA IDs
        const parsedItems: { index: number; encryptedData: Uint8Array; fullId: string }[] = [];
        const errors: { index: number; error: string }[] = [];

        for (let i = 0; i < items.length; i++) {
            try {
                const encryptedData = new Uint8Array(Buffer.from(items[i], "base64"));
                const parsed = EncryptedObject.parse(encryptedData);
                parsedItems.push({ index: i, encryptedData, fullId: parsed.id });
            } catch (err: any) {
                errors.push({ index: i, error: `parse failed: ${err.message}` });
            }
        }

        if (parsedItems.length === 0) {
            return res.json({ results: [], errors });
        }

        // Collect all unique IDs
        const allIds = [...new Set(parsedItems.map(p => p.fullId))];

        // Build ONE PTB with the key-policy approval for ALL IDs
        const tx = new Transaction();
        for (const id of allIds) {
            const idBytes = Array.from(
                Uint8Array.from(id.match(/.{1,2}/g)!.map((b: string) => parseInt(b, 16)))
            );
            addApproveKeyPolicyCall(tx, packageId, process.env.MEMORY_CONFIG_ID || "", idBytes, accountId, orgCtx);
        }
        const txBytes = await tx.build({ client: mysoClient as any, onlyTransactionKind: true });

        // ONE fetchKeys call for ALL IDs
        await (await getMydataClient()).fetchKeys({
            ids: allIds,
            txBytes,
            sessionKey,
            threshold: MYDATA_THRESHOLD,
        });

        // Decrypt each blob using the shared sessionKey
        const results: { index: number; decryptedData: string }[] = [];

        for (const item of parsedItems) {
            try {
                const decrypted = await (await getMydataClient()).decrypt({
                    data: item.encryptedData,
                    sessionKey,
                    txBytes,
                });
                results.push({
                    index: item.index,
                    decryptedData: Buffer.from(decrypted).toString("base64"),
                });
            } catch (err: any) {
                errors.push({ index: item.index, error: `decrypt failed: ${err.message}` });
            }
        }

        console.log(`[mydata/decrypt-batch] ${results.length}/${items.length} decrypted ok, ${errors.length} errors`);
        res.json({ results, errors });
    } catch (err: any) {
        const traceId = randomUUID();
        console.error(`[mydata/decrypt-batch] [${traceId}] error:`, err);
        res.status(500).json({ error: "Internal server error", traceId });
    }
});

function keypairFromPool(keyIndex: number): Ed25519Keypair {
    const privateKey = SERVER_MYSO_PRIVATE_KEYS[keyIndex];
    if (!privateKey) {
        throw new Error(`Invalid keyIndex: ${keyIndex}`);
    }
    const { secretKey } = decodeMySoPrivateKey(privateKey);
    return Ed25519Keypair.fromSecretKey(secretKey);
}

// ============================================================
// POST /memory/ensure-vault — lazy-create AgentMemoryVault on-chain
// ============================================================
app.post("/memory/ensure-vault", async (req, res) => {
    try {
        const { accountId, agentObjectId, packageId, keyIndex = 0 } = req.body;
        if (!accountId || !agentObjectId || !packageId) {
            return res.status(400).json({
                error: "Missing required fields: accountId, agentObjectId, packageId",
            });
        }

        const keypair = keypairFromPool(Number(keyIndex) || 0);
        const tx = new Transaction();
        tx.moveCall({
            target: `${packageId}::memory::ensure_agent_memory_vault`,
            arguments: [
                tx.object(accountId),
                tx.object(agentObjectId),
                tx.object(MYSO_CLOCK),
            ],
        });

        const result = await mysoClient.signAndExecuteTransaction({
            signer: keypair,
            transaction: tx,
            options: { showEffects: true, showObjectChanges: true },
        });

        let vaultId: string | undefined;
        const changes = result.objectChanges ?? [];
        for (const change of changes) {
            if (
                change.type === "created" &&
                change.objectType?.includes("::memory::AgentMemoryVault")
            ) {
                vaultId = change.objectId;
                break;
            }
        }

        console.log(
            `[memory/ensure-vault] agent=${agentObjectId} vault=${vaultId ?? "existing"} digest=${result.digest}`,
        );
        res.json({ vaultId: vaultId ?? null, digest: result.digest });
    } catch (err: any) {
        console.error(`[memory/ensure-vault] error: ${err.message || err}`);
        res.status(500).json({ error: err.message || String(err) });
    }
});

// ============================================================
// Social actions — PTB build + execute for sub-agent feed interactions
// ============================================================
app.post("/social/build", async (req, res) => {
    if (!ALLOW_LEGACY_SOCIAL_KEY_FORWARDING) {
        return res.status(410).json({ error: "Legacy social build route is disabled" });
    }
    try {
        const { buildSocialTransaction } = await import("./social-execute.js");
        const bytes = await buildSocialTransaction(req.body);
        res.json({
            transactionBlockKindBytes: Buffer.from(bytes).toString("base64"),
        });
    } catch (err: any) {
        console.error(`[social/build] error: ${err.message || err}`);
        res.status(500).json({ error: err.message || String(err) });
    }
});

app.post("/social/prepare-registered", async (req, res) => {
    try {
        const { prepareRegisteredSocialAction } = await import("./social-execute.js");
        const prepared = await prepareRegisteredSocialAction(req.body);
        res.json(prepared);
    } catch (err: any) {
        console.error(`[social/prepare-registered] error: ${err.message || err}`);
        res.status(400).json({ error: err.message || String(err) });
    }
});

app.post("/social/verify-owner-approval", async (req, res) => {
    try {
        const { verifyOwnerApproval } = await import("./social-execute.js");
        res.json(await verifyOwnerApproval(String(req.body?.message ?? ""), String(req.body?.signature ?? "")));
    } catch (err: any) {
        console.error(`[social/verify-owner-approval] error: ${err.message || err}`);
        res.status(400).json({ error: "Invalid owner wallet approval" });
    }
});

app.post("/social/execute", async (req, res) => {
    if (!ALLOW_LEGACY_SOCIAL_KEY_FORWARDING) {
        return res.status(410).json({ error: "Legacy social key-forwarding route is disabled" });
    }
    try {
        const { executeSocialAction } = await import("./social-execute.js");
        const result = await executeSocialAction(req.body);
        res.json(result);
    } catch (err: any) {
        console.error(`[social/execute] error: ${err.message || err}`);
        res.status(500).json({ error: err.message || String(err) });
    }
});

// ============================================================
// POST /sponsor — Create Enoki-sponsored transaction for frontend
// Frontend sends TransactionKind bytes + sender → returns sponsored { bytes, digest }
// ============================================================
app.post("/sponsor", async (req, res) => {
    try {
        const { transactionBlockKindBytes, sender, gasBudgetMist } = req.body;
        if (!transactionBlockKindBytes || !sender) {
            return res.status(400).json({ error: "Missing required fields: transactionBlockKindBytes, sender" });
        }
        if (gasBudgetMist !== undefined && (typeof gasBudgetMist !== "string" || !/^[1-9][0-9]{0,19}$/.test(gasBudgetMist) || BigInt(gasBudgetMist) > 18_446_744_073_709_551_615n)) {
            return res.status(400).json({ error: "gasBudgetMist must be a positive canonical u64 MIST amount" });
        }
        if (!LOCAL_SPONSOR_ENABLED && !enokiApiKey) {
            return res.status(503).json({ error: "Transaction sponsorship is not configured" });
        }
        // LOW-18: Redact full sender address (PII / deanonymisation) — log only
        // a short prefix for correlation. Never log the full digest here either.
        const senderPrefix = typeof sender === "string" ? sender.slice(0, 10) : "unknown";
        console.log(`[sponsor] creating sponsored tx for sender=${senderPrefix}...`);
        const sponsored = LOCAL_SPONSOR_ENABLED
            ? await createLocalSponsoredTransaction(transactionBlockKindBytes, sender, gasBudgetMist)
            : await callEnoki<EnokiSponsorResponse>("/transaction-blocks/sponsor", {
                network: enokiNetwork,
                transactionBlockKindBytes,
                sender,
            });

        const signedBudget = signedGasBudgetMist(sponsored.bytes);
        if (gasBudgetMist !== undefined && BigInt(signedBudget) > BigInt(gasBudgetMist)) {
            return res.status(422).json({ error: "sponsor assigned a signed gas budget above the authorized work-run ceiling" });
        }
        sponsored.gasBudgetMist = signedBudget;

        console.log(`[sponsor] sponsored tx created (digest_len=${sponsored.digest.length})`);
        res.json(sponsored); // { bytes, digest }
    } catch (err: any) {
        console.error(`[sponsor] error: ${err.message || err}`);
        res.status(500).json({ error: err.message || String(err) });
    }
});

// ============================================================
// POST /sponsor/execute — Execute signed sponsored transaction
// Frontend sends { digest, signature } after user wallet signs → returns { digest }
// ============================================================
app.post("/sponsor/execute", async (req, res) => {
    try {
        const { digest, signature } = req.body;
        if (!digest || !signature) {
            return res.status(400).json({ error: "Missing required fields: digest, signature" });
        }
        if (!LOCAL_SPONSOR_ENABLED && !enokiApiKey) {
            return res.status(503).json({ error: "Transaction sponsorship is not configured" });
        }
        // LOW-15: Percent-encode digest before path interpolation. The digest is
        // attacker-controlled when the sidecar is reached directly (no auth,
        // S1 in audit) or via the Rust proxy which validates base58 but the
        // sidecar must not rely on that. encodeURIComponent neutralises any
        // path traversal (`..`), query injection (`?`), or fragment (`#`)
        // payloads in the digest segment.
        const executed = LOCAL_SPONSOR_ENABLED
            ? await executeLocalSponsoredTransaction(digest, signature)
            : await callEnoki<EnokiExecuteResponse>(
                `/transaction-blocks/sponsor/${encodeURIComponent(digest)}`,
                { digest, signature }
            );

        // LOW-18: Redact digest from console logs — it's a high-cardinality
        // value that ties log lines to individual user transactions. Log only
        // a length indicator for diagnostics.
        console.log(`[sponsor/execute] executed sponsored tx (digest_len=${digest.length})`);
        res.json(executed); // { digest }
    } catch (err: any) {
        console.error(`[sponsor/execute] error: ${err.message || err}`);
        res.status(500).json({ error: err.message || String(err) });
    }
});

// ============================================================
// Start server
// ============================================================

const PORT = parseInt(process.env.SIDECAR_PORT || "9009", 10);
const HOST = process.env.SIDECAR_HOST || "127.0.0.1";
app.listen(PORT, HOST, () => {
    console.log(JSON.stringify({
        event: "sidecar_ready",
        host: HOST,
        sponsorMode: LOCAL_SPONSOR_ENABLED ? "local-key-pool" : enokiApiKey ? "enoki" : "disabled",
        port: PORT,
        pid: process.pid,
    }));
});
