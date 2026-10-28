import { McpRuntimeError } from "./errors.js";

type Row = Record<string, unknown>;
const fail = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The promotion reader returned malformed or uncorrelated indexer data.");
const i64Min = -(1n << 63n);
const i64Max = (1n << 63n) - 1n;

function exact(value: unknown, keys: readonly string[]): Row {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
    const row = value as Row;
    if (Object.keys(row).length !== keys.length || keys.some((key) => !(key in row))) throw fail();
    return row;
}
function int(value: unknown, allowNegative = false): void {
    let parsed: bigint;
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) throw fail();
        parsed = BigInt(value);
    } else if (typeof value === "string" && (allowNegative ? /^(0|-?[1-9][0-9]*)$/ : /^(0|[1-9][0-9]*)$/).test(value)) {
        try { parsed = BigInt(value); } catch { throw fail(); }
    } else throw fail();
    if (parsed < i64Min || parsed > i64Max || (!allowNegative && parsed < 0n)) throw fail();
}
function str(value: unknown, max = 256): void { if (typeof value !== "string" || value.length < 1 || value.length > max) throw fail(); }
function nullableInt(value: unknown): void { if (value !== null) int(value); }
function nullableBool(value: unknown): void { if (value !== null && typeof value !== "boolean") throw fail(); }
function address(value: unknown): void { if (typeof value !== "string" || !/^(0x)?[0-9a-f]{1,64}$/i.test(value)) throw fail(); }
function pagination(value: unknown, args: Record<string, unknown>): void {
    const row = exact(value, ["total", "limit", "offset", "page", "total_pages"]);
    for (const field of ["total", "limit", "offset", "page", "total_pages"]) int(row[field]);
    const requestedLimit = typeof args.limit === "number" ? Math.max(1, Math.min(100, Math.trunc(args.limit))) : 20;
    const requestedOffset = typeof args.offset === "number"
        ? Math.max(0, Math.min(100_000, Math.trunc(args.offset)))
        : typeof args.page === "number"
            ? (Math.max(1, Math.min(Math.floor(100_000 / requestedLimit) + 1, Math.trunc(args.page))) - 1) * requestedLimit
            : 0;
    const total = BigInt(String(row.total));
    const expectedTotalPages = total === 0n ? 0n : (total + BigInt(requestedLimit) - 1n) / BigInt(requestedLimit);
    if (Number(row.limit) !== requestedLimit || BigInt(String(row.offset)) !== BigInt(requestedOffset)
        || BigInt(String(row.page)) !== BigInt(Math.floor(requestedOffset / requestedLimit) + 1)
        || BigInt(String(row.total_pages)) !== expectedTotalPages) throw fail();
}
function reconciliation(value: unknown): void {
    const row = exact(value, ["total_budget", "total_spent", "total_withdrawn", "remaining_budget", "accounted_for", "unaccounted", "ledger_remaining_budget", "budget_events", "status_events", "balanced"]);
    for (const field of ["total_budget", "total_spent", "total_withdrawn", "remaining_budget", "accounted_for", "budget_events", "status_events"]) int(row[field]);
    int(row.unaccounted, true);
    nullableInt(row.ledger_remaining_budget);
    if (typeof row.balanced !== "boolean") throw fail();
}
const summaryFields = ["promotion_id", "post_id", "owner", "profile_id", "payment_per_view", "total_budget", "remaining_budget", "active", "created_at", "views", "unique_viewers", "total_spent", "total_withdrawn", "platform_fee_total", "ecosystem_fee_total", "recipient_total", "first_view_at", "last_view_at"] as const;
function summary(value: unknown): Row {
    const row = exact(value, summaryFields);
    str(row.promotion_id, 128); address(row.post_id); address(row.owner); str(row.profile_id, 256);
    for (const field of ["payment_per_view", "total_budget", "remaining_budget", "created_at", "views", "unique_viewers", "total_spent", "total_withdrawn", "platform_fee_total", "ecosystem_fee_total", "recipient_total"]) int(row[field]);
    if (typeof row.active !== "boolean") throw fail();
    nullableInt(row.first_view_at); nullableInt(row.last_view_at);
    return row;
}
function analyticsWindow(value: unknown, args: Record<string, unknown>): void {
    const row = exact(value, ["start_ms", "end_ms", "bucket", "days"]);
    int(row.start_ms); int(row.end_ms); int(row.days); str(row.bucket, 16);
    const start = BigInt(String(row.start_ms));
    const end = BigInt(String(row.end_ms));
    if (end <= start || (typeof args.from === "number" && start !== BigInt(args.from)) || (typeof args.to === "number" && end !== BigInt(args.to))) throw fail();
    if (typeof args.bucket === "string" && row.bucket !== args.bucket.toLowerCase()) throw fail();
}
function budgetEvent(value: unknown, expectedId: string): void {
    const row = exact(value, ["promotion_id", "post_id", "event_type", "amount", "remaining_budget", "timestamp", "transaction_id"]);
    if (row.promotion_id !== expectedId) throw fail();
    address(row.post_id); str(row.event_type, 64); int(row.amount); int(row.remaining_budget); int(row.timestamp); str(row.transaction_id, 128);
}
function statusEvent(value: unknown, expectedId: string): void {
    const row = exact(value, ["promotion_id", "post_id", "event_type", "triggered_by", "new_status", "amount", "timestamp", "transaction_id"]);
    if (row.promotion_id !== expectedId) throw fail();
    address(row.post_id); str(row.event_type, 64); address(row.triggered_by); nullableBool(row.new_status); nullableInt(row.amount); int(row.timestamp); str(row.transaction_id, 128);
}
function analyticsRow(value: unknown, kind: "series" | "hourly"): void {
    const row = exact(value, kind === "series" ? ["day", "views", "unique_viewers", "spent"] : ["hour", "views", "unique_viewers", "spent"]);
    if (kind === "series") {
        str(row.day, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(row.day as string)) throw fail();
        const parsed = new Date(`${row.day}T00:00:00Z`);
        if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== row.day) throw fail();
    } else if (!Number.isInteger(row.hour) || (row.hour as number) < 0 || (row.hour as number) > 23) throw fail();
    for (const field of ["views", "unique_viewers", "spent"]) int(row[field]);
}
function rowArray(value: unknown, args: Record<string, unknown>, defaultLimit: number, maxLimit: number, check: (row: unknown) => void): void {
    const limit = typeof args.limit === "number" ? Math.max(1, Math.min(maxLimit, Math.trunc(args.limit))) : defaultLimit;
    if (!Array.isArray(value) || value.length > limit) throw fail();
    value.forEach(check);
}
function requireUniqueAndOrdered(value: unknown, identity: string, compare: (left: Row, right: Row) => number): void {
    if (!Array.isArray(value)) throw fail();
    const rows = value as Row[];
    const seen = new Set<string>();
    for (const row of rows) {
        const key = row?.[identity];
        if (typeof key !== "string" || seen.has(key)) throw fail();
        seen.add(key);
    }
    for (let index = 1; index < rows.length; index += 1) if (compare(rows[index - 1]!, rows[index]!) > 0) throw fail();
}
function requireOrdered(value: unknown, compare: (left: Row, right: Row) => number): void {
    if (!Array.isArray(value)) throw fail();
    const rows = value as Row[];
    for (let index = 1; index < rows.length; index += 1) if (compare(rows[index - 1]!, rows[index]!) > 0) throw fail();
}
function compareDescInt(left: unknown, right: unknown): number {
    const a = BigInt(String(left));
    const b = BigInt(String(right));
    return a === b ? 0 : a > b ? -1 : 1;
}
function compareAscText(left: unknown, right: unknown): number {
    const a = String(left);
    const b = String(right);
    return a < b ? -1 : a > b ? 1 : 0;
}
function requireAscendingUnique(value: unknown, key: string): void {
    if (!Array.isArray(value)) throw fail();
    let previous: string | number | undefined;
    const seen = new Set<string | number>();
    for (const raw of value) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw fail();
        const item = (raw as Row)[key];
        if (!(typeof item === "string" || typeof item === "number") || seen.has(item)) throw fail();
        if (previous !== undefined && item <= previous) throw fail();
        seen.add(item);
        previous = item;
    }
}

export function sanitizePromotionRead(name: string, value: unknown, args: Record<string, unknown>): unknown {
    const id = typeof args.id === "string" ? args.id : undefined;
    if (name === "promotion_list_campaigns" || name === "promotion_list_top_performing") {
        const limit = typeof args.limit === "number" ? Math.max(1, Math.min(100, Math.trunc(args.limit))) : 20;
        rowArray(value, args, 20, 100, (row) => { const checked = summary(row); if (name === "promotion_list_campaigns") {
            if (typeof args.owner === "string" && checked.owner !== args.owner.toLowerCase().replace(/^0x/, "0x")) {
                const normalize = (addressValue: string) => `0x${addressValue.replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`;
                if (normalize(checked.owner as string) !== normalize(args.owner)) throw fail();
            }
            if (typeof args.profile_id === "string" && checked.profile_id !== args.profile_id) throw fail();
            if (typeof args.post_id === "string") {
                const normalize = (addressValue: string) => `0x${addressValue.replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`;
                if (normalize(checked.post_id as string) !== normalize(args.post_id)) throw fail();
            }
            if (args.status === "active" && checked.active !== true || args.status === "inactive" && checked.active !== false) throw fail();
        }});
        requireUniqueAndOrdered(value, "promotion_id", (left, right) => name === "promotion_list_campaigns"
            ? compareDescInt(left.created_at, right.created_at) || compareAscText(left.promotion_id, right.promotion_id)
            : compareDescInt(left.views, right.views) || compareDescInt(left.created_at, right.created_at) || compareAscText(left.promotion_id, right.promotion_id));
        return value;
    }
    if (name === "promotion_get_rollup") {
        const row = exact(value, ["campaign_count", "active_campaigns", "total_budget", "total_spent", "total_withdrawn", "total_remaining_budget", "total_views", "unique_viewers", "platform_fee_total", "ecosystem_fee_total", "recipient_total", "first_view_at", "last_view_at"]);
        for (const field of ["campaign_count", "active_campaigns", "total_budget", "total_spent", "total_withdrawn", "total_remaining_budget", "total_views", "unique_viewers", "platform_fee_total", "ecosystem_fee_total", "recipient_total"]) int(row[field]);
        nullableInt(row.first_view_at); nullableInt(row.last_view_at); return row;
    }
    if (name === "promotion_get_campaign") {
        const row = exact(value, [...summaryFields, "last_budget_event_at", "last_status_event_at", "reconciliation"]);
        summary(Object.fromEntries(summaryFields.map((field) => [field, row[field]])));
        if (row.promotion_id !== id) throw fail();
        nullableInt(row.last_budget_event_at); nullableInt(row.last_status_event_at); reconciliation(row.reconciliation); return row;
    }
    if (name === "promotion_get_stats") {
        if (!id) throw fail();
        const row = exact(value, ["total_views", "unique_viewers", "total_spent", "remaining_budget"]);
        for (const field of ["total_views", "unique_viewers", "total_spent", "remaining_budget"]) int(row[field]); return row;
    }
    if (name === "promotion_list_budget_events" || name === "promotion_list_status_events") {
        if (!id) throw fail();
        const row = exact(value, name === "promotion_list_budget_events" ? ["promotion_id", "events", "reconciliation", "pagination"] : ["promotion_id", "events", "pagination"]);
        if (row.promotion_id !== id || !Array.isArray(row.events) || row.events.length > 100) throw fail();
        row.events.forEach((event) => name === "promotion_list_budget_events" ? budgetEvent(event, id) : statusEvent(event, id));
        requireOrdered(row.events, (left, right) => compareDescInt(left.timestamp, right.timestamp));
        if (name === "promotion_list_budget_events") reconciliation(row.reconciliation);
        pagination(row.pagination, args); return row;
    }
    if (name === "promotion_list_views") {
        if (!id) throw fail();
        rowArray(value, args, 20, 100, (item) => {
            const row = exact(item, ["post_id", "promotion_id", "viewer", "payment_amount", "platform_fee", "ecosystem_fee", "recipient_amount", "view_duration", "platform_id", "timestamp"]);
            if (row.promotion_id !== id) throw fail(); address(row.post_id); address(row.viewer); address(row.platform_id);
            for (const field of ["payment_amount", "platform_fee", "ecosystem_fee", "recipient_amount", "view_duration", "timestamp"]) int(row[field]);
            const normalize = (value: string) => `0x${value.replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`;
            if (typeof args.platform_id === "string" && normalize(row.platform_id as string) !== normalize(args.platform_id)) throw fail();
            if (typeof args.from === "number" && BigInt(String(row.timestamp)) < BigInt(args.from)) throw fail();
            if (typeof args.to === "number" && BigInt(String(row.timestamp)) >= BigInt(args.to)) throw fail();
        });
        requireOrdered(value, (left, right) => compareDescInt(left.timestamp, right.timestamp));
        return value;
    }
    if (name === "promotion_get_time_series" || name === "promotion_get_spending_trends") {
        rowArray(value, args, 366, 1000, (row) => analyticsRow(row, "series"));
        requireAscendingUnique(value, "day"); return value;
    }
    if (name === "promotion_get_hourly") { rowArray(value, args, 366, 1000, (row) => analyticsRow(row, "hourly")); requireAscendingUnique(value, "hour"); return value; }
    if (name === "promotion_get_platform_breakdown") {
        if (!id) throw fail();
        const row = exact(value, ["promotion_id", "window", "platforms", "pagination"]);
        if (row.promotion_id !== id || !Array.isArray(row.platforms) || row.platforms.length > 100) throw fail();
        analyticsWindow(row.window, args);
        for (const item of row.platforms) {
            const platform = exact(item, ["platform_id", "views", "unique_viewers", "spent", "platform_fees", "ecosystem_fees", "recipient_total", "avg_view_duration", "first_view_at", "last_view_at"]);
            address(platform.platform_id);
            for (const field of ["views", "unique_viewers", "spent", "platform_fees", "ecosystem_fees", "recipient_total"]) int(platform[field]);
            if (typeof platform.avg_view_duration !== "number" || !Number.isFinite(platform.avg_view_duration) || platform.avg_view_duration < 0) throw fail();
            nullableInt(platform.first_view_at); nullableInt(platform.last_view_at);
        }
        requireUniqueAndOrdered(row.platforms, "platform_id", (left, right) => compareDescInt(left.spent, right.spent) || compareAscText(left.platform_id, right.platform_id));
        pagination(row.pagination, args); return row;
    }
    throw fail();
}
