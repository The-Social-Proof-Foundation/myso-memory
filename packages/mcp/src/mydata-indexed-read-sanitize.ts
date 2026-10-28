import { McpRuntimeError } from "./errors.js";

const fail = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The indexed MyData reader returned malformed or inconsistent public metadata.");
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
function text(value: unknown, max: number): void { if (typeof value !== "string" || value.length < 1 || value.length > max) throw fail(); }
function nullableText(value: unknown, max: number): void { if (value !== null) text(value, max); }
function count(value: unknown): void { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw fail(); }
function nullableCount(value: unknown): void { if (value !== null) count(value); }

export function sanitizeMyDataIndexedAccess(value: unknown, args: Record<string, unknown>): unknown {
    const row = obj(value, ["mydata_id", "user_address", "has_access"]);
    if (!sameAddress(row.mydata_id, args.id) || !sameAddress(row.user_address, args.address) || typeof row.has_access !== "boolean") throw fail();
    return row;
}

export function sanitizeMyDataIndexedListing(value: unknown, args: Record<string, unknown>): unknown {
    const row = obj(value, ["mydata_id", "owner", "media_type", "tags", "platform_id", "timestamp_start", "timestamp_end", "created_at", "last_updated", "one_time_price", "subscription_price", "subscription_duration_days", "geographic_region", "data_quality", "sample_size", "collection_method", "is_updating", "update_frequency"]);
    if (!sameAddress(row.mydata_id, args.id)) throw fail();
    address(row.owner); text(row.media_type, 1024);
    if (!Array.isArray(row.tags) || row.tags.length > 20 || row.tags.some((tag) => typeof tag !== "string" || tag.length > 80)) throw fail();
    if (row.platform_id !== null) address(row.platform_id);
    for (const key of ["timestamp_start", "created_at", "last_updated", "subscription_duration_days"] as const) count(row[key]);
    for (const key of ["timestamp_end", "one_time_price", "subscription_price", "sample_size"] as const) nullableCount(row[key]);
    for (const key of ["geographic_region", "data_quality", "collection_method", "update_frequency"] as const) nullableText(row[key], 256);
    if (typeof row.is_updating !== "boolean") throw fail();
    return row;
}

export function sanitizeMyDataIndexedStats(value: unknown, args: Record<string, unknown>): unknown {
    const row = obj(value, ["mydata_id", "owner", "media_type", "total_revenue", "purchase_count", "subscription_count", "access_count", "one_time_price", "subscription_price", "created_at", "last_updated"]);
    if (!sameAddress(row.mydata_id, args.id)) throw fail();
    address(row.owner); text(row.media_type, 1024);
    for (const key of ["total_revenue", "purchase_count", "subscription_count", "access_count", "created_at", "last_updated"] as const) count(row[key]);
    for (const key of ["one_time_price", "subscription_price"] as const) nullableCount(row[key]);
    return row;
}
