import { McpRuntimeError } from "./errors.js";

type Row = Record<string, unknown>;
const fail = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The profile badge reader returned malformed indexer data.");
function exact(value: unknown): Row {
    const fields = ["badge_id", "badge_name", "badge_description", "badge_media_url", "badge_icon_url", "platform_id", "assigned_by", "assigned_at", "revoked", "revoked_at", "revoked_by", "badge_type"];
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
    const row = value as Row;
    if (Object.keys(row).length !== fields.length || fields.some((field) => !(field in row))) throw fail();
    return row;
}
function text(value: unknown, max: number): void { if (typeof value !== "string" || value.length < 1 || value.length > max) throw fail(); }
function nullableText(value: unknown, max: number): void { if (value !== null) text(value, max); }
function address(value: unknown): void { if (typeof value !== "string" || !/^(0x)?[0-9a-f]{1,64}$/i.test(value)) throw fail(); }
function integer(value: unknown): void {
    if (typeof value === "number") { if (!Number.isSafeInteger(value) || value < 0) throw fail(); return; }
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw fail();
    const parsed = BigInt(value); if (parsed > (1n << 63n) - 1n) throw fail();
}
function validate(value: unknown, requestedId?: unknown): void {
    const row = exact(value);
    text(row.badge_id, 128); text(row.badge_name, 256); nullableText(row.badge_description, 4096);
    nullableText(row.badge_media_url, 2048); nullableText(row.badge_icon_url, 2048);
    address(row.platform_id); address(row.assigned_by); integer(row.assigned_at);
    if (typeof row.revoked !== "boolean") throw fail();
    if (row.revoked_at !== null) integer(row.revoked_at);
    if (row.revoked_by !== null) address(row.revoked_by);
    if (typeof row.badge_type !== "number" || !Number.isInteger(row.badge_type) || row.badge_type < -32768 || row.badge_type > 32767) throw fail();
    if (requestedId !== undefined && row.badge_id !== requestedId) throw fail();
}
export function sanitizeBadgeRead(name: string, value: unknown, args: Record<string, unknown>): unknown {
    if (name === "badge_get") { validate(value, args.id); return value; }
    if (name !== "badge_list") throw fail();
    const limit = typeof args.limit === "number" ? Math.min(100, args.limit) : 20;
    if (!Array.isArray(value) || value.length > limit) throw fail();
    const badgeIds = new Set<string>();
    let previousBadgeId: string | null = null;
    value.forEach((raw) => {
        validate(raw);
        const row = raw as Row;
        const badgeId = row.badge_id as string;
        if (row.revoked !== false || badgeIds.has(badgeId)
            || (previousBadgeId !== null && badgeId < previousBadgeId)) throw fail();
        badgeIds.add(badgeId);
        previousBadgeId = badgeId;
    });
    return value;
}
