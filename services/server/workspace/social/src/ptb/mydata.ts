import type { PublishMyDataGraphParams, PurchaseMyDataAccessParams, PurchasePostAccessParams } from "../types.js";
import type { BuildTxContext } from "./post.js";
import { MYSO_CLOCK, optAddress, resolvePlatformObjectId } from "./helpers.js";
import { deriveOrgMemoryGroupId } from "./organization.js";

const U64_MAX = (1n << 64n) - 1n;
function objectId(value: string, label: string): void {
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(value)) throw new TypeError(`${label} must be a MySo object/address ID`);
}
function u64(value: string, label: string): string {
    if (!/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > U64_MAX) throw new TypeError(`${label} must be an unsigned u64 decimal string`);
    return value;
}
function bytes(value: string, label: string, maximum: number): number[] {
    if (!/^(?:[0-9a-f]{2})+$/.test(value) || value.length > maximum * 2) throw new TypeError(`${label} must contain bounded lowercase hex bytes`);
    return Array.from({ length: value.length / 2 }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}
export function validatePublishMyDataGraph(params: PublishMyDataGraphParams): void {
    if (params.mediaType !== "application/vnd.mysocial.graph-manifest+json;version=1") throw new TypeError("mediaType must identify a MySocial GraphManifest v1");
    if (!Array.isArray(params.tags) || params.tags.length < 1 || params.tags.length > 10 || params.tags.some((tag) => typeof tag !== "string" || new TextEncoder().encode(tag).byteLength > 64)) throw new TypeError("GraphManifest listing tags must contain 1-10 strings of at most 64 UTF-8 bytes");
    u64(params.timestampStart, "timestampStart");
    const encrypted = bytes(params.encryptedDataHex, "encryptedDataHex", 262_144);
    if (encrypted.length < 1) throw new TypeError("encryptedDataHex must not be empty");
    const encryptionId = bytes(params.encryptionIdHex, "encryptionIdHex", 1024);
    if (encryptionId.length < 1) throw new TypeError("encryptionIdHex must not be empty");
    if (![2, 3].includes(params.accessKind)) throw new TypeError("accessKind must be 2 (one-time) or 3 (recurring)");
    if (BigInt(u64(params.priceMist, "priceMist")) === 0n) throw new TypeError("priceMist must be positive");
    const duration = BigInt(u64(params.durationDays, "durationDays"));
    if ((params.accessKind === 2 && duration !== 0n) || (params.accessKind === 3 && duration === 0n)) throw new TypeError("durationDays must be zero for one-time or positive for recurring access");
    if (params.platformObjectId !== undefined) objectId(params.platformObjectId, "platformObjectId");
}

/** Creates a seller-owned P2P MyData listing through the existing MyData Move entry points. */
export function buildPublishMyDataGraphTx(ctx: BuildTxContext, params: PublishMyDataGraphParams): any {
    validatePublishMyDataGraph(params);
    if (!ctx.chain.mydataConfigId) throw new TypeError("mydataConfigId is required to publish a GraphManifest listing");
    const tx = new ctx.Transaction();
    const common = [
        tx.object(ctx.chain.mydataConfigId), tx.object(ctx.chain.mydataRegistryId),
        tx.pure("string", params.mediaType), tx.pure("vector<string>", params.tags),
        optAddress(tx, params.platformObjectId), tx.pure("u64", params.timestampStart),
        tx.pure("option<u64>", null), tx.pure("vector<u8>", bytes(params.encryptedDataHex, "encryptedDataHex", 262_144)),
        tx.pure("vector<u8>", bytes(params.encryptionIdHex, "encryptionIdHex", 1024)),
        tx.pure("u64", params.priceMist),
    ];
    const metadata = [tx.pure("option<string>", null), tx.pure("option<string>", null), tx.pure("option<u64>", null),
        tx.pure("option<string>", null), tx.pure("bool", false), tx.pure("option<string>", null)];
    if (params.accessKind === 2) {
        tx.moveCall({ target: `${ctx.chain.packageId}::mydata::create_and_share_marketplace_one_time_mydata`,
            arguments: [...common, ...metadata, tx.object(ctx.chain.clockId ?? MYSO_CLOCK)] });
    } else {
        tx.moveCall({ target: `${ctx.chain.packageId}::mydata::create_and_share_marketplace_recurring_mydata`,
            arguments: [...common, tx.pure("u64", params.durationDays), ...metadata, tx.object(ctx.chain.clockId ?? MYSO_CLOCK)] });
    }
    return tx;
}

export function validatePurchaseMyDataAccess(params: PurchaseMyDataAccessParams): void {
    for (const key of ["mydataId", "paymentCoinId", "expectedSeller"] as const) objectId(params[key], key);
    if (params.platformObjectId !== undefined) objectId(params.platformObjectId, "platformObjectId");
    if (params.expectedListingPlatformId !== undefined) objectId(params.expectedListingPlatformId, "expectedListingPlatformId");
    if (params.organizationAudienceId !== undefined) objectId(params.organizationAudienceId, "organizationAudienceId");
    if (params.audienceKind !== "agent" && params.audienceKind !== "organization") throw new TypeError("audienceKind must be agent or organization");
    if ((params.audienceKind === "organization") !== (params.organizationAudienceId !== undefined)) throw new TypeError("organizationAudienceId must be provided exactly when audienceKind is organization");
    if (![2, 3].includes(params.accessKind)) throw new TypeError("accessKind must be 2 (one-time) or 3 (recurring)");
    if (BigInt(u64(params.priceMist, "priceMist")) === 0n) throw new TypeError("priceMist must be positive");
    const duration = BigInt(u64(params.durationDays, "durationDays"));
    if ((params.accessKind === 2 && duration !== 0n) || (params.accessKind === 3 && duration === 0n)) throw new TypeError("durationDays must be zero for one-time or positive for recurring access");
    bytes(params.encryptionIdHex, "encryptionIdHex", 1024);
    if (bytes(params.encryptedDataDigestHex, "encryptedDataDigestHex", 32).length !== 32) throw new TypeError("encryptedDataDigestHex must be a sha256 digest");
    const graphValues=[params.graphId,params.graphVersion,params.manifestHashHex,params.publicationSignatureHex];
    if(graphValues.some(value=>value!==undefined)){
        if(graphValues.some(value=>value===undefined))throw new TypeError("Graph purchase snapshots require graphId, graphVersion, manifestHashHex and publicationSignatureHex together");
        if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(params.graphId!))throw new TypeError("Invalid immutable graph ID");
        if(BigInt(u64(params.graphVersion!,"graphVersion"))===0n)throw new TypeError("Graph version must be positive");
        bytes(params.manifestHashHex!,"manifestHashHex",32);bytes(params.publicationSignatureHex!,"publicationSignatureHex",64);
    }
}

/** Exact-price, exact-ciphertext purchase. Entitlement belongs to the transaction
 * sender's address, as in the existing MyData P2P contract. No plaintext is sent. */
export function buildPurchaseMyDataAccessTx(ctx: BuildTxContext, params: PurchaseMyDataAccessParams): any {
    validatePurchaseMyDataAccess(params);
    if (!ctx.chain.mydataConfigId || !ctx.chain.ecosystemTreasuryId) throw new TypeError("mydataConfigId and ecosystemTreasuryId are required for bounded MyData purchases");
    const tx = new ctx.Transaction();
    const orgAudience = params.organizationAudienceId !== undefined;
    const organizationMemoryGroupId = orgAudience ? deriveOrgMemoryGroupId(ctx.chain.packageId, params.organizationAudienceId!) : undefined;
    const graphPurchase=params.graphId!==undefined;
    tx.moveCall({
        target: `${ctx.chain.packageId}::mydata::${graphPurchase?"purchase_graph_access_bounded_":"purchase_access_bounded_"}${orgAudience?"with_org_audience":"with_platform"}`,
        arguments: [
            tx.object(ctx.chain.mydataConfigId), tx.object(ctx.chain.blockListRegistryId),
            tx.object(ctx.chain.memoryConfigId), tx.object(params.mydataId),
            tx.object(ctx.chain.ecosystemTreasuryId), tx.object(resolvePlatformObjectId(ctx.chain, params.platformObjectId)),
            tx.object(params.paymentCoinId), tx.object(ctx.memoryAccountId),
            ...(orgAudience ? [tx.object(params.organizationAudienceId!), tx.object(organizationMemoryGroupId!)] : []),
            tx.pure("address", params.expectedSeller), tx.pure("u8", params.accessKind),
            tx.pure("u64", params.priceMist), tx.pure("u64", params.durationDays),
            tx.pure("vector<u8>", bytes(params.encryptionIdHex, "encryptionIdHex", 1024)),
            tx.pure("vector<u8>", bytes(params.encryptedDataDigestHex, "encryptedDataDigestHex", 32)),
            optAddress(tx, params.expectedListingPlatformId),
            ...(graphPurchase?[tx.pure("string",params.graphId!),tx.pure("u64",params.graphVersion!),tx.pure("vector<u8>",bytes(params.manifestHashHex!,"manifestHashHex",32)),tx.pure("vector<u8>",bytes(params.publicationSignatureHex!,"publicationSignatureHex",64))]:[]),
            tx.object(ctx.chain.clockId ?? MYSO_CLOCK),
        ],
    });
    return tx;
}

export function validatePurchasePostAccess(params: PurchasePostAccessParams): void {
    if(params.graphId!==undefined||params.graphVersion!==undefined||params.manifestHashHex!==undefined||params.publicationSignatureHex!==undefined)throw new TypeError("Post-bound purchases cannot include graph publication metadata");
    objectId(params.postId, "postId");
    validatePurchaseMyDataAccess({ ...params, accessKind: 2, durationDays: "0", audienceKind: "agent" });
}

/** The Move entry rechecks that this exact MyData record remains linked to the post. */
export function buildPurchasePostAccessTx(ctx: BuildTxContext, params: PurchasePostAccessParams): any {
    validatePurchasePostAccess(params);
    if (!ctx.chain.mydataConfigId || !ctx.chain.ecosystemTreasuryId) throw new TypeError("mydataConfigId and ecosystemTreasuryId are required for bounded MyData purchases");
    const tx = new ctx.Transaction();
    tx.moveCall({
        target: `${ctx.chain.packageId}::post::purchase_post_access_bounded_with_platform`,
        arguments: [
            tx.object(params.postId), tx.object(ctx.chain.mydataConfigId), tx.object(ctx.chain.blockListRegistryId),
            tx.object(ctx.chain.memoryConfigId), tx.object(params.mydataId), tx.object(ctx.chain.ecosystemTreasuryId),
            tx.object(resolvePlatformObjectId(ctx.chain, params.platformObjectId)), tx.object(params.paymentCoinId),
            tx.object(ctx.memoryAccountId), tx.pure("address", params.expectedSeller), tx.pure("u64", params.priceMist),
            tx.pure("vector<u8>", bytes(params.encryptionIdHex, "encryptionIdHex", 1024)),
            tx.pure("vector<u8>", bytes(params.encryptedDataDigestHex, "encryptedDataDigestHex", 32)),
            optAddress(tx, params.expectedListingPlatformId), tx.object(ctx.chain.clockId ?? MYSO_CLOCK),
        ],
    });
    return tx;
}
