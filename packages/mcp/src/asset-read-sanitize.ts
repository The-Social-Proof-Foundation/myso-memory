import { McpRuntimeError } from "./errors.js";

const fail = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The owner asset reader returned malformed or inconsistent object evidence.");
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
function sameAddress(a: unknown, b: unknown): boolean { return address(a) === address(b); }
function digest(value: unknown): string {
    if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(value)) throw fail();
    return value;
}
function decimal(value: unknown): string {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
    if (typeof value === "string" && value.length <= 20 && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n) return value;
    throw fail();
}
function text(value: unknown, max = 2048): string {
    if (typeof value !== "string" || value.length < 1 || value.length > max) throw fail();
    return value;
}
function moveType(value: unknown): string {
    const result = text(value, 1024);
    if (!result.includes("::") || /[\u0000-\u001f]/.test(result)) throw fail();
    return result;
}
function walk(value: unknown, depth = 0): void {
    if (depth > 8) throw fail();
    if (typeof value === "number") { if (!Number.isSafeInteger(value)) throw fail(); return; }
    if (typeof value === "string") { if (value.length > 16_384) throw fail(); return; }
    if (value === null || typeof value === "boolean") return;
    if (Array.isArray(value)) { if (value.length > 1000) throw fail(); value.forEach((item) => walk(item, depth + 1)); return; }
    if (typeof value === "object") { Object.values(value as Record<string, unknown>).forEach((item) => walk(item, depth + 1)); return; }
    throw fail();
}
function objectSummary(value: unknown): Record<string, unknown> {
    const row = obj(value, ["objectId", "objectType", "version", "coinBalanceBaseUnits"]);
    address(row.objectId); moveType(row.objectType); decimal(row.version);
    if (row.coinBalanceBaseUnits !== null) decimal(row.coinBalanceBaseUnits);
    return row;
}

export function sanitizeOwnedObject(value: unknown, args: Record<string, unknown>, expectedOwner: string): unknown {
    const row = obj(value, ["objectId", "objectType", "version", "coinBalanceBaseUnits", "owner", "evidenceSource"]);
    objectSummary({ objectId: row.objectId, objectType: row.objectType, version: row.version, coinBalanceBaseUnits: row.coinBalanceBaseUnits });
    if (!sameAddress(row.objectId, args.id) || !sameAddress(row.owner, expectedOwner) || row.evidenceSource !== "configured_fullnode") throw fail();
    return row;
}

export function sanitizeOwnedObjects(value: unknown, args: Record<string, unknown>, expectedOwner: string): unknown {
    const row = obj(value, ["items", "owner", "hasNextPage", "nextCursor", "evidenceSource"]);
    if (!Array.isArray(row.items) || row.items.length > 50 || typeof row.hasNextPage !== "boolean" || row.evidenceSource !== "configured_fullnode") throw fail();
    if (!sameAddress(row.owner, expectedOwner)) throw fail();
    if (args.limit !== undefined && (typeof args.limit !== "number" || row.items.length > args.limit)) throw fail();
    const ids = new Set<string>();
    for (const item of row.items) {
        const object = objectSummary(item); const normalized = address(object.objectId);
        if (ids.has(normalized)) throw fail();
        ids.add(normalized);
    }
    if (row.nextCursor !== null) address(row.nextCursor);
    if (row.hasNextPage && (row.items.length === 0 || row.nextCursor === null || !sameAddress(row.nextCursor, (row.items.at(-1) as Record<string, unknown>).objectId)
        || args.cursor !== undefined && sameAddress(row.nextCursor, args.cursor))) throw fail();
    if (!row.hasNextPage && row.nextCursor !== null) throw fail();
    return row;
}

function changeOwner(value: unknown): string | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
    const owner = value as Record<string, unknown>;
    if (Object.keys(owner).length === 1 && typeof owner.AddressOwner === "string") return address(owner.AddressOwner);
    return null;
}
export function sanitizeAssetReceipt(name: string, value: unknown, args: Record<string, unknown>, expectedOwner: string): unknown {
    const row = obj(value, ["digest", "registryAction", "status", "checkpoint", "objectChange", "evidenceSource"]);
    const expectedAction = name === "assets_get_transfer_receipt" ? "assets.transfer_object.v1" : name === "assets_get_burn_receipt" ? "assets.burn_object.v1" : null;
    if (!expectedAction || row.registryAction !== expectedAction || digest(row.digest) !== args.id || !["finalized", "checkpoint_pending", "failed", "unknown"].includes(String(row.status)) || row.evidenceSource !== "configured_fullnode_and_scoped_preparation") throw fail();
    if (row.checkpoint !== null) decimal(row.checkpoint);
    if (row.status === "finalized" && row.objectChange === null) throw fail();
    let sanitizedChange: Record<string, unknown> | null = null;
    if (row.objectChange !== null) {
        const change = row.objectChange;
        walk(change);
        if (!change || typeof change !== "object" || Array.isArray(change)) throw fail();
        const data = change as Record<string, unknown>;
        if (data.type !== (name === "assets_get_transfer_receipt" ? "transferred" : "deleted")) throw fail();
        const objectId = address(data.objectId);
        const objectType = moveType(data.objectType);
        if (name === "assets_get_burn_receipt" && !objectType.startsWith("0x0000000000000000000000000000000000000000000000000000000000000002::coin::Coin<")) throw fail();
        const sender = address(data.sender);
        if (sender !== address(expectedOwner) || digest(data.digest) !== row.digest) throw fail();
        const version = decimal(data.version);
        const base = { type: data.type, objectId, objectType, sender, digest: row.digest, version };
        if (data.type === "transferred") {
            const recipient = changeOwner(data.recipient);
            if (recipient === null) throw fail();
            sanitizedChange = { ...base, recipient: { AddressOwner: recipient } };
        } else {
            sanitizedChange = base;
        }
    }
    return { ...row, objectChange: sanitizedChange };
}
