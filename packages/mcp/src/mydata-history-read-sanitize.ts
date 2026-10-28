import { McpRuntimeError } from "./errors.js";

const fail = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The MyData history reader returned malformed or uncorrelated indexed data.");
type Row = Record<string, unknown>;
function object(value: unknown, keys: readonly string[]): Row {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
    const row = value as Row;
    if (Object.keys(row).length !== keys.length || keys.some((key) => !(key in row))) throw fail();
    return row;
}
function address(value: unknown): string {
    if (typeof value !== "string" || !/^(0x)?[0-9a-f]{1,64}$/i.test(value)) throw fail();
    return value.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}
function sameAddress(left: unknown, right: unknown): boolean { return address(left) === address(right); }
function int64(value: unknown): bigint {
    if (typeof value === "number") { if (!Number.isSafeInteger(value)) throw fail(); value = String(value); }
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw fail();
    const parsed = BigInt(value);
    if (parsed > (1n << 63n) - 1n) throw fail();
    return parsed;
}
function text(value: unknown, max = 512): string { if (typeof value !== "string" || !value.length || value.length > max) throw fail(); return value; }
function timestamp(value: unknown): void { if (!Number.isFinite(Date.parse(text(value, 64)))) throw fail(); }
function requestedId(args: Record<string, unknown>): string { return address(args.id); }
function rows(value: unknown, args: Record<string, unknown>): Row[] {
    const limit = typeof args.limit === "number" ? args.limit : 20;
    if (!Array.isArray(value) || value.length > limit) throw fail();
    return value.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw fail();
        return item as Row;
    });
}
function common(row: Row, id: string): void {
    if (int64(row.id) < 1n || !sameAddress(row.mydata_id, id)) throw fail();
    const time = Date.parse(text(row.time, 64));
    if (!Number.isFinite(time)) throw fail();
    text(row.transaction_id, 128);
}
function revoked(row: Row): void {
    if (typeof row.revoked !== "boolean") throw fail();
    if (row.revoked_at !== null) int64(row.revoked_at);
    if (row.revoked_by !== null) address(row.revoked_by);
    if (!row.revoked && (row.revoked_at !== null || row.revoked_by !== null)) throw fail();
}
function orderedHistory(items: Row[], value: (row: Row) => bigint, kind: "row_id_desc" | "buyer_purchase_order"): void {
    let previousTime: bigint | undefined;
    let previousMyDataId: string | undefined;
    let previousId: bigint | undefined;
    const seenIds = new Set<string>();
    for (const item of items) {
        const currentTime = value(item);
        const currentId = int64(item.id);
        const currentIdKey = currentId.toString();
        const currentMyDataId = kind === "buyer_purchase_order" ? address(item.mydata_id) : undefined;
        if (seenIds.has(currentIdKey) || previousTime !== undefined && (currentTime > previousTime
            || currentTime === previousTime && (kind === "buyer_purchase_order"
                ? currentMyDataId! < previousMyDataId! || currentMyDataId === previousMyDataId && currentId <= previousId!
                : currentId >= previousId!))) throw fail();
        seenIds.add(currentIdKey);
        previousTime = currentTime;
        previousMyDataId = currentMyDataId;
        previousId = currentId;
    }
}
function purchase(row: Row, id: string): bigint {
    const keys = ["id", "mydata_id", "buyer", "price", "platform_fee", "ecosystem_fee", "creator_amount", "platform_address", "purchase_type", "purchase_time", "time", "transaction_id", "revoked", "revoked_at", "revoked_by"];
    object(row, keys);
    address(row.buyer);
    const price = int64(row.price), platform = int64(row.platform_fee), ecosystem = int64(row.ecosystem_fee), creator = int64(row.creator_amount);
    if (platform + ecosystem + creator !== price) throw fail();
    if (row.platform_address !== null) address(row.platform_address);
    text(row.purchase_type, 64);
    const purchaseTime = int64(row.purchase_time);
    common(row, id); revoked(row);
    return purchaseTime;
}
function subscription(row: Row, id: string): bigint {
    object(row, ["id", "mydata_id", "subscriber", "subscription_start", "subscription_end", "price", "time", "transaction_id", "revoked", "revoked_at", "revoked_by"]);
    address(row.subscriber);
    const start = int64(row.subscription_start); int64(row.subscription_end); int64(row.price);
    common(row, id); revoked(row);
    return start;
}
function revenue(row: Row, id: string): bigint {
    object(row, ["id", "mydata_id", "from_address", "to_address", "amount", "platform_fee", "ecosystem_fee", "creator_amount", "platform_address", "revenue_type", "revenue_time", "time", "transaction_id"]);
    address(row.from_address);
    if (row.to_address !== "") address(row.to_address);
    const amount = int64(row.amount), platform = int64(row.platform_fee), ecosystem = int64(row.ecosystem_fee), creator = int64(row.creator_amount);
    if (platform + ecosystem + creator !== amount) throw fail();
    if (row.platform_address !== null) address(row.platform_address);
    text(row.revenue_type, 64);
    const revenueTime = int64(row.revenue_time);
    common(row, id);
    return revenueTime;
}
function accessLog(row: Row, id: string): bigint {
    object(row, ["id", "mydata_id", "user_address", "access_type", "access_time", "time", "transaction_id"]);
    address(row.user_address); text(row.access_type, 64);
    const accessTime = int64(row.access_time);
    common(row, id);
    return accessTime;
}

export function sanitizeMyDataHistoryRead(
    name: string,
    value: unknown,
    args: Record<string, unknown>,
    purchaseIdentity?: { ownerAddress: string; agentAddress: string },
): unknown {
    if (name === "mydata_list_my_purchases") {
        const outer = object(value, ["ownerAddress", "agentAddress", "ownerPurchases", "agentPurchases", "limit", "offset", "hasMore", "nextOffset", "notice"]);
        const owner = address(outer.ownerAddress), agent = address(outer.agentAddress);
        if (!purchaseIdentity || !sameAddress(owner, purchaseIdentity.ownerAddress) || !sameAddress(agent, purchaseIdentity.agentAddress)) throw fail();
        const limit = int64(outer.limit), offset = int64(outer.offset);
        if (limit < 1n || limit > 100n || offset > 100_000n || typeof outer.hasMore !== "boolean") throw fail();
        const ownerRows = rows(outer.ownerPurchases, { limit: Number(limit) });
        const agentRows = rows(outer.agentPurchases, { limit: Number(limit) });
        for (const row of ownerRows) if (!sameAddress(row.buyer, owner)) throw fail();
        for (const row of agentRows) if (!sameAddress(row.buyer, agent)) throw fail();
        orderedHistory(ownerRows, (row) => purchase(row, String(row.mydata_id)), "buyer_purchase_order");
        orderedHistory(agentRows, (row) => purchase(row, String(row.mydata_id)), "buyer_purchase_order");
        const nextOffset = outer.hasMore ? offset + limit : null;
        if (outer.nextOffset === null ? nextOffset !== null : int64(outer.nextOffset) !== nextOffset) throw fail();
        const expectedHasMore = (ownerRows.length === Number(limit) || agentRows.length === Number(limit)) && offset < 100_000n;
        if (outer.hasMore !== expectedHasMore) throw fail();
        text(outer.notice, 512);
        return value;
    }
    const id = requestedId(args);
    if (name === "mydata_list_indexed_purchases") {
        const checked = rows(value, args);
        orderedHistory(checked, (row) => purchase(row, id), "row_id_desc");
        return value;
    }
    if (name === "mydata_list_indexed_subscriptions") {
        const checked = rows(value, args);
        orderedHistory(checked, (row) => subscription(row, id), "row_id_desc");
        return value;
    }
    if (name === "mydata_list_indexed_revenue") {
        const checked = rows(value, args);
        orderedHistory(checked, (row) => revenue(row, id), "row_id_desc");
        return value;
    }
    if (name === "mydata_list_indexed_access_logs") {
        const checked = rows(value, args);
        orderedHistory(checked, (row) => accessLog(row, id), "row_id_desc");
        return value;
    }
    throw fail();
}
