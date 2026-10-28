import { createHash } from "node:crypto";
import { McpRuntimeError } from "./errors.js";

const fail = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The chain action reader returned malformed or incorrectly scoped data.");

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
    const row = value as Record<string, unknown>;
    if (Object.keys(row).length !== keys.length || keys.some((key) => !(key in row))) throw fail();
    return row;
}
function string(value: unknown, max: number): string {
    if (typeof value !== "string" || value.length < 1 || value.length > max) throw fail();
    return value;
}
function normalizeAddress(value: unknown): string {
    if (typeof value !== "string" || !/^(0x)?[0-9a-f]{1,64}$/i.test(value)) throw fail();
    return value.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}
function integer(value: unknown, min = 0): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) throw fail();
    return value;
}
function boundedJson(value: unknown, depth = 0, budget = { nodes: 0 }): void {
    budget.nodes += 1;
    if (budget.nodes > 5_000 || depth > 16) throw fail();
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "string") {
        if (value.length > 8_192) throw fail();
        return;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value) || !Number.isSafeInteger(value)) throw fail();
        return;
    }
    if (Array.isArray(value)) {
        if (value.length > 1_000) throw fail();
        for (const item of value) boundedJson(item, depth + 1, budget);
        return;
    }
    if (!value || typeof value !== "object") throw fail();
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 512) throw fail();
    for (const [key, child] of entries) {
        if (!key || key.length > 256) throw fail();
        boundedJson(child, depth + 1, budget);
    }
}
function canonicalJson(value: unknown): string {
    if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
        const encoded = JSON.stringify(value);
        if (encoded === undefined) throw fail();
        return encoded;
    }
    if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
    if (!value || typeof value !== "object") throw fail();
    const row = value as Record<string, unknown>;
    const keys = Object.keys(row);
    if (keys.some((key) => !/^[\x00-\x7f]*$/.test(key))) throw fail();
    keys.sort();
    return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonicalJson(row[key])).join(",") + "}";
}

export function sanitizeActionApprovals(
    value: unknown,
    args: Record<string, unknown>,
    principal: { accountId: string; agentObjectId: string; ownerAddress: string },
): unknown {
    const response = object(value, ["items"]);
    const limit = args.limit ?? 50;
    if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw fail();
    if (!Array.isArray(response.items) || response.items.length > (limit as number)) throw fail();
    const seen = new Set<string>();
    for (const raw of response.items) {
        const row = object(raw, ["approvalId", "registryAction", "registryVersion", "idempotencyKey", "parameterHash", "parameters", "requiredCapability", "riskTier", "ownerAddress", "approvalIntent", "status", "expiresAtMs"]);
        const approvalId = string(row.approvalId, 36);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(approvalId) || seen.has(approvalId)) throw fail();
        seen.add(approvalId);
        const action = string(row.registryAction, 128);
        if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+\.v1$/.test(action)) throw fail();
        const version = string(row.registryVersion, 32);
        if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) throw fail();
        const idempotencyKey = string(row.idempotencyKey, 128);
        if (!/^[A-Za-z0-9._:/-]{8,128}$/.test(idempotencyKey)) throw fail();
        const parameterHash = string(row.parameterHash, 71);
        if (!/^sha256:[0-9a-f]{64}$/.test(parameterHash)) throw fail();
        if (!row.parameters || typeof row.parameters !== "object" || Array.isArray(row.parameters)) throw fail();
        boundedJson(row.parameters);
        const computedHash = "sha256:" + createHash("sha256").update(canonicalJson(row.parameters), "utf8").digest("hex");
        if (computedHash !== parameterHash) throw fail();
        const capability = integer(row.requiredCapability);
        if (!["0", "1A", "1B", "2", "3"].includes(String(row.riskTier)) || row.status !== "pending") throw fail();
        const ownerAddress = normalizeAddress(row.ownerAddress);
        if (ownerAddress !== normalizeAddress(principal.ownerAddress)) throw fail();
        const expiresAtMs = integer(row.expiresAtMs, 1);
        const intent = string(row.approvalIntent, 4_096).split("|");
        if (intent.length !== 14 || intent[0] !== "mysocial-action-approval-v1"
            || intent[1] !== approvalId
            || normalizeAddress(intent[2]) !== normalizeAddress(principal.accountId)
            || normalizeAddress(intent[3]) !== normalizeAddress(principal.agentObjectId)
            || intent[4] !== version || intent[5] !== action || intent[6] !== idempotencyKey
            || intent[7] !== parameterHash || intent[8] !== String(capability)
            || intent[9] !== row.riskTier || intent[10] !== "unscoped" && !/^(0x)?[0-9a-f]{1,64}$/i.test(intent[10])
            || intent[11] !== String(expiresAtMs) || normalizeAddress(intent[12]) !== ownerAddress
            || intent[13] !== "unscoped" && !/^(0x)?[0-9a-f]{1,64}$/i.test(intent[13])) throw fail();
        const organizationId = (row.parameters as Record<string, unknown> | null)?.organizationId;
        if (organizationId !== undefined && (typeof organizationId !== "string" || intent[13] === "unscoped" || normalizeAddress(organizationId) !== normalizeAddress(intent[13]))) throw fail();
    }
    return response;
}

export function sanitizeActionReceipt(
    value: unknown,
    args: Record<string, unknown>,
    principal: { accountId: string; agentObjectId: string },
): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
    const row = value as Record<string, unknown>;
    if (Object.keys(row).length > 128) throw fail();
    const digest = string(args.id, 44);
    if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(digest) || row.digest !== digest) throw fail();
    const action = string(row.registryAction, 128);
    if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+\.v1$/.test(action)) throw fail();
    if (row.accountId !== undefined && normalizeAddress(row.accountId) !== normalizeAddress(principal.accountId)) throw fail();
    if (row.agentId !== undefined && normalizeAddress(row.agentId) !== normalizeAddress(principal.agentObjectId)) throw fail();
    if (row.status !== undefined) string(row.status, 80);
    if (row.evidenceSource !== undefined) string(row.evidenceSource, 160);
    if (row.transactionDigest !== undefined && row.transactionDigest !== digest) throw fail();
    if (row.checkpoint !== undefined && row.checkpoint !== null) {
        if (typeof row.checkpoint === "string") {
            if (!/^(0|[1-9][0-9]*)$/.test(row.checkpoint) || row.checkpoint.length > 40) throw fail();
        } else integer(row.checkpoint);
    }
    if (row.events !== undefined && (!Array.isArray(row.events) || row.events.length > 1_000)) throw fail();
    boundedJson(row);
    return row;
}

export function sanitizeActionByIdempotencyKey(
    value: unknown,
    args: Record<string, unknown>,
    principal: { accountId: string; agentObjectId: string },
): unknown {
    const row = object(value, ["idempotencyKey", "registryAction", "registryVersion", "accountId", "agentId", "status", "digest", "parameterHash", "expiresAtMs", "evidenceSource"]);
    const key = string(args.idempotency_key, 128);
    if (!/^[A-Za-z0-9._:/-]{8,128}$/.test(key) || row.idempotencyKey !== key) throw fail();
    const action = string(row.registryAction, 128);
    if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+\.v1$/.test(action)) throw fail();
    if (!/^\d+\.\d+\.\d+$/.test(string(row.registryVersion, 32))) throw fail();
    if (normalizeAddress(row.accountId) !== normalizeAddress(principal.accountId)
        || normalizeAddress(row.agentId) !== normalizeAddress(principal.agentObjectId)) throw fail();
    if (!["preparing", "sponsored", "submitting", "executed", "failed"].includes(String(row.status))) throw fail();
    if (row.digest !== null && (typeof row.digest !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(row.digest))) throw fail();
    if (!/^sha256:[0-9a-f]{64}$/.test(string(row.parameterHash, 71))) throw fail();
    integer(row.expiresAtMs, 1);
    if (row.evidenceSource !== "authenticated_chain_action_journal") throw fail();
    return row;
}
