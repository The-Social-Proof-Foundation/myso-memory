import { McpRuntimeError } from "./errors.js";

const fail = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The MyData catalog reader returned malformed or uncorrelated data.");
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
function canonicalAddress(value: unknown): string {
    return address(value).toLowerCase().replace(/^0x/, "").padStart(64, "0");
}
function sameAddress(left: unknown, right: unknown): boolean { return address(left) === address(right); }
function integer(value: unknown, allowNegative = false): bigint {
    if (typeof value === "number") { if (!Number.isSafeInteger(value)) throw fail(); value = String(value); }
    if (typeof value !== "string" || !(allowNegative ? /^(0|-?[1-9][0-9]*)$/ : /^(0|[1-9][0-9]*)$/).test(value)) throw fail();
    const parsed = BigInt(value);
    if (parsed > (1n << 63n) - 1n || parsed < (allowNegative ? -(1n << 63n) : 0n)) throw fail();
    return parsed;
}
function text(value: unknown, max = 512, empty = false): string {
    if (typeof value !== "string" || value.length > max || (!empty && !value.length)) throw fail();
    return value;
}
function timestamp(value: unknown): void { if (!Number.isFinite(Date.parse(text(value, 64)))) throw fail(); }
function commonEvent(row: Row): void { text(row.event_id, 256); text(row.transaction_id, 128); timestamp(row.time); }
function optionalText(value: unknown, max: number): void { if (value !== null) text(value, max, true); }

function listing(value: unknown, creator?: unknown): Row {
    const row = object(value, ["mydata_id", "owner", "media_type", "tags", "platform_id", "timestamp_start", "timestamp_end", "created_at", "last_updated", "one_time_price", "subscription_price", "subscription_duration_days", "geographic_region", "data_quality", "sample_size", "collection_method", "is_updating", "update_frequency"]);
    address(row.mydata_id); address(row.owner);
    if (creator !== undefined && !sameAddress(row.owner, creator)) throw fail();
    text(row.media_type, 128);
    if (!Array.isArray(row.tags) || row.tags.length > 128 || row.tags.some((tag) => typeof tag !== "string" || tag.length > 128)) throw fail();
    if (row.platform_id !== null) address(row.platform_id);
    integer(row.timestamp_start, true);
    if (row.timestamp_end !== null) integer(row.timestamp_end, true);
    integer(row.created_at, true); integer(row.last_updated, true);
    if (row.one_time_price !== null) integer(row.one_time_price);
    if (row.subscription_price !== null) integer(row.subscription_price);
    integer(row.subscription_duration_days);
    optionalText(row.geographic_region, 128); optionalText(row.data_quality, 64);
    if (row.sample_size !== null) integer(row.sample_size);
    optionalText(row.collection_method, 256);
    if (typeof row.is_updating !== "boolean") throw fail();
    optionalText(row.update_frequency, 64);
    return row;
}
function boundedRows(value: unknown, args: Record<string, unknown>, fallback: number): unknown[] {
    const limit = typeof args.limit === "number" ? args.limit : fallback;
    if (!Array.isArray(value) || value.length > limit) throw fail();
    return value;
}
function ensureUnique(rows: readonly Row[], field: string): void {
    const seen = new Set<string>();
    for (const row of rows) {
        const id = canonicalAddress(row[field]);
        if (seen.has(id)) throw fail();
        seen.add(id);
    }
}
function requireOrder(rows: readonly Row[], compare: (left: Row, right: Row) => number): void {
    for (let index = 1; index < rows.length; index += 1) {
        if (compare(rows[index - 1]!, rows[index]!) > 0) throw fail();
    }
}
function descendingInteger(left: unknown, right: unknown, nullsFirst = false): number {
    if (left === null || right === null) {
        if (left === right) return 0;
        return left === null ? (nullsFirst ? -1 : 1) : (nullsFirst ? 1 : -1);
    }
    const a = integer(left, true);
    const b = integer(right, true);
    return a === b ? 0 : a > b ? -1 : 1;
}
function ascendingId(left: Row, right: Row, field = "mydata_id"): number {
    const a = canonicalAddress(left[field]);
    const b = canonicalAddress(right[field]);
    return a < b ? -1 : a > b ? 1 : 0;
}
function pool(value: unknown): Row {
    const row = object(value, ["pool_id", "name", "platform_address", "created_at_ms", "event_id", "transaction_id", "time"]);
    address(row.pool_id); text(row.name, 256);
    if (row.platform_address !== null) address(row.platform_address);
    integer(row.created_at_ms); commonEvent(row);
    return row;
}
function subPool(value: unknown, broadPool?: unknown): Row {
    const row = object(value, ["sub_pool_id", "broad_pool_id", "name", "created_at_ms", "event_id", "transaction_id", "time"]);
    address(row.sub_pool_id); address(row.broad_pool_id);
    if (broadPool !== undefined && !sameAddress(row.broad_pool_id, broadPool)) throw fail();
    text(row.name, 256); integer(row.created_at_ms); commonEvent(row);
    return row;
}
function listingSubPool(value: unknown, subPoolId: unknown): Row {
    const row = object(value, ["listing_id", "sub_pool_id", "assigned_at_ms", "event_id", "transaction_id", "time"]);
    address(row.listing_id); address(row.sub_pool_id);
    if (!sameAddress(row.sub_pool_id, subPoolId)) throw fail();
    integer(row.assigned_at_ms); commonEvent(row);
    return row;
}

export function sanitizeMyDataMarketCatalogRead(name: string, value: unknown, args: Record<string, unknown>): unknown {
    if (["mydata_read_indexed_catalog", "mydata_list_popular_indexed", "mydata_list_creator_listings"].includes(name)) {
        const rows = boundedRows(value, args, 20);
        const creator = name === "mydata_list_creator_listings" ? args.address : name === "mydata_read_indexed_catalog" ? args.creator : undefined;
        if (creator !== undefined) address(creator);
        const checked = rows.map((row) => listing(row, creator));
        if (name === "mydata_list_popular_indexed") {
            ensureUnique(checked, "mydata_id");
        } else if (name === "mydata_list_creator_listings") {
            ensureUnique(checked, "mydata_id");
            requireOrder(checked, (left, right) => descendingInteger(left.created_at, right.created_at) || ascendingId(left, right));
        } else {
            ensureUnique(checked, "mydata_id");
            const sortBy = args.sort_by;
            if (sortBy === "price") {
                requireOrder(checked, (left, right) => {
                    const leftPrice = left.one_time_price ?? left.subscription_price;
                    const rightPrice = right.one_time_price ?? right.subscription_price;
                    return descendingInteger(leftPrice, rightPrice, true) || ascendingId(left, right);
                });
            } else if (sortBy === "updated") {
                requireOrder(checked, (left, right) => descendingInteger(left.last_updated, right.last_updated) || ascendingId(left, right));
            } else {
                requireOrder(checked, (left, right) => descendingInteger(left.created_at, right.created_at) || ascendingId(left, right));
            }
        }
        if (name === "mydata_read_indexed_catalog" && args.platform_id !== undefined) {
            const platform = address(args.platform_id);
            if (checked.some((row) => row.platform_id === null || !sameAddress(row.platform_id, platform))) throw fail();
        }
        if (name === "mydata_read_indexed_catalog" && args.media_type !== undefined && checked.some((row) => row.media_type !== args.media_type)) throw fail();
        return checked;
    }
    if (name === "mydata_list_broad_pools") {
        const rows = boundedRows(value, args, 50).map(pool);
        ensureUnique(rows, "pool_id");
        requireOrder(rows, (left, right) => descendingInteger(left.created_at_ms, right.created_at_ms) || ascendingId(left, right, "pool_id"));
        return rows;
    }
    if (name === "mydata_list_broad_pool_sub_pools") {
        const id = address(args.id);
        const rows = boundedRows(value, args, 50).map((row) => subPool(row, id));
        ensureUnique(rows, "sub_pool_id");
        requireOrder(rows, (left, right) => descendingInteger(left.created_at_ms, right.created_at_ms) || ascendingId(left, right, "sub_pool_id"));
        return rows;
    }
    if (name === "mydata_list_listing_sub_pools") {
        address(args.id);
        const rows = boundedRows(value, args, 50).map((row) => subPool(row));
        ensureUnique(rows, "sub_pool_id");
        return rows;
    }
    if (name === "mydata_list_sub_pool_listings") {
        const id = address(args.id);
        const rows = boundedRows(value, args, 50).map((row) => listingSubPool(row, id));
        ensureUnique(rows, "listing_id");
        requireOrder(rows, (left, right) => descendingInteger(left.assigned_at_ms, right.assigned_at_ms) || ascendingId(left, right, "listing_id"));
        return rows;
    }
    throw fail();
}
