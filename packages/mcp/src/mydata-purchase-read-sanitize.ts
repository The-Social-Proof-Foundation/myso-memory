import { McpRuntimeError } from "./errors.js";

const fail = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The MyData purchase reader returned malformed or inconsistent chain evidence.");
function obj(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
    const row = value as Record<string, unknown>;
    if (Object.keys(row).length !== keys.length || keys.some((key) => !(key in row))) throw fail();
    return row;
}
function address(value: unknown): string {
    if (typeof value !== "string" || !/^(0x)?[0-9a-f]{1,64}$/i.test(value)) throw fail();
    return value.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}
function sameAddress(left: unknown, right: unknown): boolean { return address(left) === address(right); }
function decimal(value: unknown): void {
    if (typeof value !== "string" || value.length > 20 || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 18_446_744_073_709_551_615n) throw fail();
}
function txDigest(value: unknown): void { if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(value)) throw fail(); }
function hex32(value: unknown): void { if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw fail(); }
function text(value: unknown, max: number): void { if (typeof value !== "string" || value.length < 1 || value.length > max) throw fail(); }
function safeInteger(value: unknown, min = 0): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) throw fail();
    return value;
}

export function sanitizeMyDataPurchaseQuote(
    value: unknown,
    args: Record<string, unknown>,
    identity: { agentAddress: string },
): unknown {
    const row = obj(value, ["mydataId", "buyerAddress", "objectVersion", "mediaType", "tags", "quotedAtMs", "purchaseParameters", "entitlementAddress", "requiresMarketplaceDiscovery", "deploymentEnabled", "chain"]);
    if (!sameAddress(row.mydataId, args.id) || !sameAddress(row.buyerAddress, identity.agentAddress)
        || !sameAddress(row.entitlementAddress, identity.agentAddress) || row.requiresMarketplaceDiscovery !== false || typeof row.deploymentEnabled !== "boolean") throw fail();
    decimal(row.objectVersion); text(row.mediaType, 1024); safeInteger(row.quotedAtMs);
    if (!Array.isArray(row.tags) || row.tags.length > 10 || row.tags.some((tag) => typeof tag !== "string" || tag.length > 64)) throw fail();
    if (!row.purchaseParameters || typeof row.purchaseParameters !== "object" || Array.isArray(row.purchaseParameters)) throw fail();
    const paramsValue = row.purchaseParameters as Record<string, unknown>;
    const params = obj(paramsValue, ["mydataId", "expectedSeller", "accessKind", "priceMist", "durationDays", "encryptionIdHex", "encryptedDataDigestHex", ...(Object.hasOwn(paramsValue, "expectedListingPlatformId") ? ["expectedListingPlatformId"] : [])]);
    if (!sameAddress(params.mydataId, row.mydataId)) throw fail();
    address(params.expectedSeller);
    safeInteger(params.accessKind, 2);
    if (params.accessKind !== 2 && params.accessKind !== 3) throw fail();
    decimal(params.priceMist); decimal(params.durationDays);
    if (params.priceMist === "0" || params.accessKind === 2 && params.durationDays !== "0" || params.accessKind === 3 && params.durationDays === "0") throw fail();
    const encryptionIdHex = params.encryptionIdHex;
    if (typeof encryptionIdHex !== "string") throw fail();
    text(encryptionIdHex, 2048); if (encryptionIdHex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(encryptionIdHex)) throw fail();
    hex32(params.encryptedDataDigestHex);
    if ("expectedListingPlatformId" in params) address(params.expectedListingPlatformId);
    const chain = obj(row.chain, ["source", "termsPinnedAtExecution"]);
    if (chain.source !== "myso_getObject" || chain.termsPinnedAtExecution !== true) throw fail();
    return row;
}

function sanitizeGraphSnapshot(value: unknown, organizationAudienceId: unknown): void {
    if (value === null) return;
    const graph = obj(value, ["graphId", "graphVersion", "manifestHashHex", "publicationSignatureDigestHex", "organizationId"]);
    text(graph.graphId, 128); safeInteger(graph.graphVersion, 1); hex32(graph.manifestHashHex); hex32(graph.publicationSignatureDigestHex);
    if (graph.organizationId === null ? organizationAudienceId !== null : organizationAudienceId === null || !sameAddress(graph.organizationId, organizationAudienceId)) throw fail();
}

export function sanitizeMyDataPurchaseReceipt(
    value: unknown,
    args: Record<string, unknown>,
    expectedIdentity: { accountId: string; agentObjectId: string; ownerAddress: string; agentAddress: string },
): unknown {
    const row = obj(value, ["digest", "status", "checkpoint", "receipts", "evidenceSource", "currentAccess"]);
    txDigest(row.digest);
    if (row.digest !== args.id || !["finalized", "executed", "failed", "unknown"].includes(String(row.status)) || row.evidenceSource !== "configured_fullnode" || row.currentAccess !== "not_checked" || !Array.isArray(row.receipts) || row.receipts.length > 100) throw fail();
    if (row.status === "finalized" && row.receipts.length === 0) throw fail();
    if (row.checkpoint !== null) decimal(row.checkpoint);
    for (const raw of row.receipts) {
        const receipt = obj(raw, ["mydataId", "buyerAddress", "buyerAccountId", "buyerAgentId", "buyerExecution", "organizationAudienceId", "seller", "postId", "accessKind", "priceMist", "durationDays", "encryptedDataDigestHex", "encryptionIdDigestHex", "listingPlatformId", "feePlatformId", "purchasedAtMs", "graphSnapshot"]);
        for (const key of ["mydataId", "buyerAddress", "buyerAccountId", "seller", "feePlatformId"] as const) address(receipt[key]);
        for (const key of ["buyerAgentId", "organizationAudienceId", "postId", "listingPlatformId"] as const) if (receipt[key] !== null) address(receipt[key]);
        if (!sameAddress(receipt.buyerAccountId, expectedIdentity.accountId)) throw fail();
        if (!["owner_approved", "agent_automated"].includes(String(receipt.buyerExecution))) throw fail();
        if (receipt.buyerExecution === "owner_approved" && (receipt.buyerAgentId !== null || !sameAddress(receipt.buyerAddress, expectedIdentity.ownerAddress))
            || receipt.buyerExecution === "agent_automated" && (receipt.buyerAgentId === null || !sameAddress(receipt.buyerAgentId, expectedIdentity.agentObjectId) || !sameAddress(receipt.buyerAddress, expectedIdentity.agentAddress))) throw fail();
        safeInteger(receipt.accessKind, 2);
        if (receipt.accessKind !== 2 && receipt.accessKind !== 3) throw fail();
        decimal(receipt.priceMist); decimal(receipt.durationDays); decimal(receipt.purchasedAtMs);
        if (receipt.priceMist === "0" || receipt.accessKind === 2 && receipt.durationDays !== "0" || receipt.accessKind === 3 && receipt.durationDays === "0") throw fail();
        hex32(receipt.encryptedDataDigestHex); hex32(receipt.encryptionIdDigestHex);
        sanitizeGraphSnapshot(receipt.graphSnapshot, receipt.organizationAudienceId);
    }
    return row;
}

export function sanitizeMyDataListingPage(value: unknown, args: Record<string, unknown>, expectedOwner?: string): unknown {
    const row = obj(value, ["listings", "offset", "scannedCount", "nextOffset"]);
    const limit = args.limit ?? 20;
    const offset = args.offset ?? 0;
    if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 50
        || !Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > 100_000
        || row.offset !== offset || !Number.isSafeInteger(row.scannedCount) || (row.scannedCount as number) < 0 || (row.scannedCount as number) > (limit as number)
        || !Array.isArray(row.listings) || row.listings.length > (row.scannedCount as number)) throw fail();
    const expectedLimit = limit as number;
    const expectedOffset = offset as number;
    const scanned = row.scannedCount as number;
    const expectedNext = scanned === expectedLimit && expectedOffset < 100_000 && expectedOffset + scanned <= 100_000 ? expectedOffset + scanned : null;
    if (row.nextOffset !== expectedNext) throw fail();
    let previousCreatedAt: bigint | undefined;
    let previousId: string | undefined;
    const seenIds = new Set<string>();
    for (const raw of row.listings) {
        const listing = obj(raw, ["mydataId", "owner", "mediaType", "tags", "oneTimePriceMist", "subscriptionPriceMist", "subscriptionDurationDays", "createdAt"]);
        const mydataId = address(listing.mydataId); const listingOwner = address(listing.owner); text(listing.mediaType, 80);
        if (expectedOwner !== undefined && listingOwner !== address(expectedOwner)) throw fail();
        if (!Array.isArray(listing.tags) || listing.tags.length > 20 || listing.tags.some((tag) => typeof tag !== "string" || tag.length > 80)) throw fail();
        for (const key of ["oneTimePriceMist", "subscriptionPriceMist"] as const) if (listing[key] !== null) decimal(listing[key]);
        const hasPaidPrice = [listing.oneTimePriceMist, listing.subscriptionPriceMist].some((price) => typeof price === "string" && BigInt(price) > 0n);
        if (!hasPaidPrice) throw fail();
        decimal(listing.subscriptionDurationDays); decimal(listing.createdAt);
        const maxI64 = 9_223_372_036_854_775_807n;
        const createdAt = BigInt(listing.createdAt as string);
        const oneTimePrice = BigInt(String(listing.oneTimePriceMist ?? "0"));
        const subscriptionPrice = BigInt(String(listing.subscriptionPriceMist ?? "0"));
        const durationDays = BigInt(listing.subscriptionDurationDays as string);
        if (oneTimePrice > maxI64 || subscriptionPrice > maxI64 || createdAt > maxI64 || durationDays > maxI64
            || subscriptionPrice > 0n && durationDays === 0n || seenIds.has(mydataId)
            || previousCreatedAt !== undefined && (createdAt > previousCreatedAt || createdAt === previousCreatedAt && mydataId < previousId!)) throw fail();
        seenIds.add(mydataId);
        previousCreatedAt = createdAt;
        previousId = mydataId;
    }
    return row;
}
