import { McpRuntimeError } from "./errors.js";

const fail = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The MyData snapshot reader returned malformed or uncorrelated distribution data.");
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
function int64(value: unknown, allowNegative = false): bigint {
    if (typeof value === "number") { if (!Number.isSafeInteger(value)) throw fail(); value = String(value); }
    if (typeof value !== "string" || !(allowNegative ? /^(0|-?[1-9][0-9]*)$/ : /^(0|[1-9][0-9]*)$/).test(value)) throw fail();
    const parsed = BigInt(value);
    if (parsed > (1n << 63n) - 1n || parsed < (allowNegative ? -(1n << 63n) : 0n)) throw fail();
    return parsed;
}
function text(value: unknown, max = 512, empty = false): string { if (typeof value !== "string" || value.length > max || (!empty && !value.length)) throw fail(); return value; }
function timestamp(value: unknown): void { if (!Number.isFinite(Date.parse(text(value, 64)))) throw fail(); }
function snapshotId(value: unknown): string { return address(value); }
function common(row: Row): void { text(row.event_id, 256); text(row.transaction_id, 128); timestamp(row.time); }

function anchor(value: unknown, requested: unknown): Row {
    const row = object(value, ["id", "snapshot_id", "buyer_address", "price_paid", "source_pool_id", "source_sub_pool_id", "platform_address", "initial_escrow", "created_at_ms", "event_id", "transaction_id", "time", "manifest_hash", "payment_reference"]);
    if (int64(row.id) < 1n || !sameAddress(row.snapshot_id, requested)) throw fail();
    address(row.buyer_address); address(row.source_pool_id); address(row.source_sub_pool_id);
    if (row.platform_address !== null) address(row.platform_address);
    int64(row.price_paid); int64(row.initial_escrow); int64(row.created_at_ms); common(row);
    if (row.manifest_hash !== null) text(row.manifest_hash, 256);
    if (row.payment_reference !== null) text(row.payment_reference, 1024, true);
    return row;
}
function distribution(value: unknown, requested: unknown): Row {
    const row = object(value, ["snapshot_id", "total_amount", "contributor_count", "merkle_root", "platform_address", "claim_deadline_ms", "published_at_ms", "event_id", "transaction_id", "time"]);
    if (!sameAddress(row.snapshot_id, requested)) throw fail();
    int64(row.total_amount); int64(row.contributor_count); text(row.merkle_root, 256);
    if (row.platform_address !== null) address(row.platform_address);
    int64(row.claim_deadline_ms); int64(row.published_at_ms); common(row);
    return row;
}
function merkle(value: unknown, requested: unknown): Row {
    const row = object(value, ["snapshot_id", "root_hash", "published_at_ms", "event_id", "transaction_id", "time"]);
    if (!sameAddress(row.snapshot_id, requested)) throw fail();
    text(row.root_hash, 256); int64(row.published_at_ms); common(row);
    return row;
}
function escrow(value: unknown, requested: unknown): Row {
    const row = object(value, ["snapshot_id", "total_funded", "total_claimed", "remaining_amount", "claim_deadline_ms", "reclaimed_at_ms", "status", "updated_at_ms", "transaction_id", "time"]);
    if (!sameAddress(row.snapshot_id, requested)) throw fail();
    const funded = int64(row.total_funded), claimed = int64(row.total_claimed), remaining = int64(row.remaining_amount);
    if (claimed > funded || !["funding", "claiming", "claimed", "reclaimed"].includes(String(row.status))) throw fail();
    if (row.status === "reclaimed" ? remaining !== 0n || row.reclaimed_at_ms === null : remaining !== funded - claimed || row.reclaimed_at_ms !== null) throw fail();
    if (row.status === "claimed" && remaining !== 0n) throw fail();
    if (row.claim_deadline_ms !== null) int64(row.claim_deadline_ms);
    if (row.reclaimed_at_ms !== null) int64(row.reclaimed_at_ms);
    int64(row.updated_at_ms); text(row.transaction_id, 128); timestamp(row.time);
    return row;
}
function claim(value: unknown, requested: unknown): { row: Row; claimedAt: bigint } {
    const row = object(value, ["id", "snapshot_id", "claimant", "amount", "gross_amount", "platform_fee", "ecosystem_fee", "net_amount", "platform_address", "claimed_at_ms", "event_id", "transaction_id", "time"]);
    if (int64(row.id) < 1n || !sameAddress(row.snapshot_id, requested)) throw fail();
    address(row.claimant);
    const amount = int64(row.amount), gross = int64(row.gross_amount), platform = int64(row.platform_fee), ecosystem = int64(row.ecosystem_fee), net = int64(row.net_amount);
    if (amount !== gross || gross < platform + ecosystem || net !== gross - platform - ecosystem) throw fail();
    if (row.platform_address !== null) address(row.platform_address);
    const claimedAt = int64(row.claimed_at_ms); common(row);
    return { row, claimedAt };
}

export function sanitizeMyDataSnapshotRead(name: string, value: unknown, args: Record<string, unknown>): unknown {
    if (name === "mydata_list_distribution_rounds") {
        const limit = typeof args.limit === "number" ? args.limit : 50;
        if (!Array.isArray(value) || value.length > limit) throw fail();
        let lastTime = Number.POSITIVE_INFINITY;
        for (const item of value) {
            const row = distribution(item, (item as Row)?.snapshot_id);
            const current = Date.parse(text(row.time, 64));
            if (current > lastTime) throw fail();
            lastTime = current;
        }
        return value;
    }
    const id = snapshotId(args.id);
    if (name === "mydata_get_snapshot_anchor") return anchor(value, id);
    if (name === "mydata_get_snapshot_distribution") return distribution(value, id);
    if (name === "mydata_get_snapshot_merkle_root") return merkle(value, id);
    if (name === "mydata_get_snapshot_escrow") return escrow(value, id);
    if (name === "mydata_list_snapshot_claims") {
        if (!Array.isArray(value) || value.length > (typeof args.limit === "number" ? args.limit : 50)) throw fail();
        let last = (1n << 63n) - 1n;
        for (const item of value) {
            const checked = claim(item, id);
            if (checked.claimedAt > last) throw fail();
            last = checked.claimedAt;
        }
        return value;
    }
    throw fail();
}
