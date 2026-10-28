import { McpRuntimeError } from "./errors.js";

const fail = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The audit-log reader returned malformed or out-of-scope records.");
type Row = Record<string, unknown>;
const fields = ["id", "time", "source", "actor_address", "actor_type", "action", "target_type", "target_id", "organization_id", "account_id", "prev_state", "new_state", "tx_digest", "event_id", "idempotency_key", "metadata"] as const;

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
function int64(value: unknown): bigint {
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) throw fail();
        value = String(value);
    }
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw fail();
    const parsed = BigInt(value);
    if (parsed < 0n || parsed > (1n << 63n) - 1n) throw fail();
    return parsed;
}
function text(value: unknown, max: number): string {
    if (typeof value !== "string" || value.length < 1 || value.length > max) throw fail();
    return value;
}
function optionalText(value: unknown, max: number): void { if (value !== null) text(value, max); }
function jsonValue(value: unknown, depth = 0, budget = { nodes: 0, bytes: 0 }): void {
    budget.nodes += 1;
    if (budget.nodes > 512 || depth > 8) throw fail();
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "number") { if (!Number.isFinite(value)) throw fail(); budget.bytes += String(value).length; }
    else if (typeof value === "string") { budget.bytes += value.length; }
    else if (Array.isArray(value)) {
        if (value.length > 256) throw fail();
        for (const item of value) jsonValue(item, depth + 1, budget);
    } else if (typeof value === "object") {
        const entries = Object.entries(value as Row);
        if (entries.length > 256) throw fail();
        for (const [key, item] of entries) { budget.bytes += key.length; jsonValue(item, depth + 1, budget); }
    } else throw fail();
    if (budget.bytes > 32_768) throw fail();
}

export function sanitizeAccountAuditLogs(value: unknown, expectedOwner: string, args: Record<string, unknown>): unknown {
    if (!Array.isArray(value)) throw fail();
    const limit = typeof args.limit === "number" ? args.limit : 20;
    const offset = args.offset === undefined ? 0 : args.offset;
    if (!Number.isSafeInteger(limit) || value.length > limit || limit < 1 || limit > 100
        || !Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > 100_000) throw fail();
    const owner = address(expectedOwner);
    const filters = ["action", "target_type", "source"] as const;
    const ids = new Set<string>();
    let previousTime = Number.POSITIVE_INFINITY;
    for (const raw of value) {
        const row = object(raw, fields);
        const id = int64(row.id);
        if (id < 1n || ids.has(id.toString()) || address(row.actor_address) !== owner) throw fail();
        ids.add(id.toString());
        const time = Date.parse(text(row.time, 64));
        if (!Number.isFinite(time) || time > previousTime) throw fail();
        previousTime = time;
        for (const key of ["source", "actor_type", "action", "target_type"] as const) text(row[key], 80);
        text(row.target_id, 256);
        for (const key of ["organization_id", "account_id"] as const) if (row[key] !== null) address(row[key]);
        optionalText(row.tx_digest, 128); optionalText(row.event_id, 256); optionalText(row.idempotency_key, 256);
        for (const key of ["prev_state", "new_state", "metadata"] as const) if (row[key] !== null) jsonValue(row[key]);
        for (const key of filters) if (args[key] !== undefined && row[key] !== args[key]) throw fail();
    }
    return value;
}
