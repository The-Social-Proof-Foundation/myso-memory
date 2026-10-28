import { McpRuntimeError } from "./errors.js";

const fail = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The indexed MyData analytics reader returned malformed or inconsistent data.");
type Row = Record<string, unknown>;
function object(value: unknown, keys: readonly string[]): Row {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
    const row = value as Row;
    if (Object.keys(row).length !== keys.length || keys.some((key) => !(key in row))) throw fail();
    return row;
}
function int64(value: unknown): bigint {
    if (typeof value === "number") { if (!Number.isSafeInteger(value)) throw fail(); value = String(value); }
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw fail();
    const parsed = BigInt(value); if (parsed > (1n << 63n) - 1n) throw fail(); return parsed;
}
function address(value: unknown): void { if (typeof value !== "string" || !/^(0x)?[0-9a-f]{1,64}$/i.test(value)) throw fail(); }
function text(value: unknown, max: number): string { if (typeof value !== "string" || !value.length || value.length > max) throw fail(); return value; }
function timestamp(value: unknown): void { if (!Number.isFinite(Date.parse(text(value, 64)))) throw fail(); }
function day(value: unknown): string {
    const raw = text(value, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || new Date(`${raw}T00:00:00Z`).toISOString().slice(0, 10) !== raw) throw fail();
    return raw;
}

export function sanitizeMyDataAnalyticsRead(name: string, value: unknown): unknown {
    if (name === "mydata_get_indexed_configuration") {
        const keys = ["updated_by", "marketplace_enabled", "max_tags", "max_subscription_days", "max_free_access_grants", "max_encryption_id_bytes", "max_encrypted_data_bytes", "max_tag_bytes", "max_metadata_bytes", "max_payment_reference_bytes", "max_pool_assignments", "max_merkle_proof_depth", "max_paid_access_entries", "default_claim_window_ms", "p2p_platform_fee_bps", "p2p_ecosystem_fee_bps", "mydata_marketplace_platform_fee_bps", "mydata_marketplace_ecosystem_fee_bps", "non_platform_platform_to_creator_bps", "non_platform_platform_to_treasury_bps", "version", "updated_at", "time", "transaction_id"];
        const row = object(value, keys); address(row.updated_by);
        if (typeof row.marketplace_enabled !== "boolean") throw fail();
        for (const key of keys.slice(2, 20)) int64(row[key]);
        for (const key of ["p2p_platform_fee_bps", "p2p_ecosystem_fee_bps", "mydata_marketplace_platform_fee_bps", "mydata_marketplace_ecosystem_fee_bps", "non_platform_platform_to_creator_bps", "non_platform_platform_to_treasury_bps"]) if (int64(row[key]) > 10_000n) throw fail();
        int64(row.version);
        int64(row.updated_at); timestamp(row.time); text(row.transaction_id, 128);
        return row;
    }
    if (name === "mydata_get_indexed_revenue_timeline") {
        if (!Array.isArray(value) || value.length > 30) throw fail();
        let lastDay = "9999-12-31";
        for (const item of value) {
            const row = object(item, ["day", "daily_revenue", "daily_transactions"]); const current = day(row.day);
            if (current > lastDay) throw fail(); lastDay = current;
            int64(row.daily_revenue); int64(row.daily_transactions);
        }
        return value;
    }
    if (name === "mydata_get_indexed_access_analytics") {
        if (!Array.isArray(value) || value.length > 100) throw fail();
        let previousDay = "9999-12-31"; let previousType = ""; const seen = new Set<string>();
        const allowed = new Set(["one_time", "subscription", "grant", "preview", "pricing_update", "content_update", "revoked"]);
        for (const item of value) {
            const row = object(item, ["day", "access_type", "unique_users", "total_accesses"]); const currentDay = day(row.day); const type = text(row.access_type, 80);
            if (!allowed.has(type) || currentDay > previousDay || (currentDay === previousDay && type < previousType)) throw fail();
            const key = `${currentDay}\0${type}`; if (seen.has(key)) throw fail(); seen.add(key);
            previousDay = currentDay; previousType = type;
            const users = int64(row.unique_users), accesses = int64(row.total_accesses);
            if (users > accesses) throw fail();
        }
        return value;
    }
    throw fail();
}
