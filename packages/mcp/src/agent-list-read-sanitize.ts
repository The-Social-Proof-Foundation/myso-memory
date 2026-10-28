import { McpRuntimeError } from "./errors.js";

const fail = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The agent directory returned malformed or inconsistent indexed data.");
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
function integer(value: unknown, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw fail();
    return value;
}
function text(value: unknown, max: number): string {
    if (typeof value !== "string" || value.length < 1 || value.length > max) throw fail();
    return value;
}
function nullableAddress(value: unknown): void { if (value !== null) address(value); }
function nullableInteger(value: unknown): void { if (value !== null) integer(value); }
function nullableNonNegativeI64(value: unknown): void { if (value !== null) nonNegativeI64(value); }
function nonNegativeI64(value: unknown): bigint {
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value) || value < 0) throw fail();
        value = String(value);
    }
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw fail();
    const amount = BigInt(value);
    if (amount > 9_223_372_036_854_775_807n) throw fail();
    return amount;
}

function enforceUniqueAndOrdered(rows: readonly Record<string, unknown>[], compare: (left: Record<string, unknown>, right: Record<string, unknown>) => number): void {
    const seen = new Set<string>();
    for (let index = 0; index < rows.length; index += 1) {
        const id = address(rows[index].agent_object_id);
        if (seen.has(id)) throw fail();
        seen.add(id);
        if (index > 0 && compare(rows[index - 1], rows[index]) > 0) throw fail();
    }
}

const rowFields = ["agent_object_id", "derived_address", "account_id", "label", "identity_class", "role_tags", "capabilities", "delegatable_caps", "register_scope", "approval_required_caps", "max_action_spend", "platform_scope", "parent_object_id", "depth", "registered_by", "expires_at_ms", "active", "created_at_ms", "deactivated_at_ms", "revoked_at_ms", "updated_at_ms", "organization_id", "event_id", "transaction_id", "time"] as const;

function sanitizeSubAgent(value: unknown): Record<string, unknown> {
    const row = obj(value, rowFields);
    for (const key of ["agent_object_id", "derived_address", "account_id", "registered_by"] as const) address(row[key]);
    for (const key of ["platform_scope", "parent_object_id", "organization_id"] as const) nullableAddress(row[key]);
    text(row.label, 512); integer(row.identity_class, 0, 32); integer(row.role_tags, 0); integer(row.capabilities, 0);
    integer(row.delegatable_caps, 0); integer(row.register_scope, 0, 32); integer(row.approval_required_caps, 0);
    nullableNonNegativeI64(row.max_action_spend); integer(row.depth, 0, 32); nullableInteger(row.expires_at_ms);
    integer(row.created_at_ms); nullableInteger(row.deactivated_at_ms); nullableInteger(row.revoked_at_ms); integer(row.updated_at_ms);
    if (typeof row.active !== "boolean") throw fail();
    text(row.event_id, 128); text(row.transaction_id, 128);
    const time = text(row.time, 64);
    if (!Number.isFinite(Date.parse(time))) throw fail();
    return row;
}

export function sanitizeAgentChildren(value: unknown, args: Record<string, unknown>, agentObjectId: string): unknown {
    if (!Array.isArray(value) || value.length > 50) throw fail();
    const max = typeof args.limit === "number" ? Math.min(50, args.limit) : 20;
    if (value.length > max) throw fail();
    const activeOnly = args.active_only ?? true;
    const rows: Record<string, unknown>[] = [];
    for (const raw of value) {
        const row = sanitizeSubAgent(raw);
        if (!sameAddress(row.parent_object_id, agentObjectId) || activeOnly && row.active !== true) throw fail();
        rows.push(row);
    }
    enforceUniqueAndOrdered(rows, (left, right) => Number(right.created_at_ms) - Number(left.created_at_ms));
    return value;
}

export function sanitizeProfileAgents(value: unknown, args: Record<string, unknown>): unknown {
    const row = obj(value, ["sub_agents", "total_count"]);
    if (!Array.isArray(row.sub_agents) || row.sub_agents.length > 50) throw fail();
    const max = typeof args.limit === "number" ? Math.min(50, args.limit) : 20;
    if (row.sub_agents.length > max) throw fail();
    const total = integer(row.total_count, 0);
    if (total < row.sub_agents.length) throw fail();
    const activeOnly = args.active_only ?? true;
    const agents: Record<string, unknown>[] = [];
    for (const raw of row.sub_agents) {
        const agent = sanitizeSubAgent(raw);
        if (activeOnly && agent.active !== true) throw fail();
        agents.push(agent);
    }
    enforceUniqueAndOrdered(agents, (left, right) => Number(left.depth) - Number(right.depth) || Number(right.created_at_ms) - Number(left.created_at_ms));
    return row;
}

export function sanitizeAgentReceipts(value: unknown, args: Record<string, unknown>, agentObjectId: string): unknown {
    if (!Array.isArray(value) || value.length > 200) throw fail();
    const max = typeof args.limit === "number" ? Math.min(200, args.limit) : 20;
    if (value.length > max) throw fail();
    const seen = new Set<string>();
    for (const raw of value) {
        const row = obj(raw, ["taskId", "receiptId", "buyerPrincipal", "buyerAgentId", "sellerPrincipal", "sellerAgentId", "organizationId", "roomGroupId", "settlementKind", "amountMist", "platformFeeMist", "ecosystemFeeMist", "netAmountMist", "deliverableDigest", "deliverableUri", "buyerCredibilityBps", "sellerCredibilityBps", "settleDeadlineMs", "reviewDeadlineMs", "settledAtMs", "transactionId"]);
        for (const key of ["taskId", "buyerPrincipal", "sellerPrincipal", "sellerAgentId"] as const) address(row[key]);
        for (const key of ["buyerAgentId", "organizationId", "roomGroupId"] as const) nullableAddress(row[key]);
        if (!sameAddress(row.sellerAgentId, agentObjectId) && (row.buyerAgentId === null || !sameAddress(row.buyerAgentId, agentObjectId))) throw fail();
        if (!sameAddress(row.receiptId, row.taskId)) throw fail();
        integer(row.settlementKind, 0, 32);
        const amount = nonNegativeI64(row.amountMist);
        const platformFee = nonNegativeI64(row.platformFeeMist);
        const ecosystemFee = nonNegativeI64(row.ecosystemFeeMist);
        const netAmount = nonNegativeI64(row.netAmountMist);
        if (platformFee + ecosystemFee > amount || netAmount !== amount - platformFee - ecosystemFee) throw fail();
        integer(row.buyerCredibilityBps, 0, 10_000); integer(row.sellerCredibilityBps, 0, 10_000);
        integer(row.settleDeadlineMs); integer(row.reviewDeadlineMs); integer(row.settledAtMs);
        if (row.deliverableDigest !== null) text(row.deliverableDigest, 256);
        if (row.deliverableUri !== null) text(row.deliverableUri, 2048);
        const receiptId = text(row.receiptId, 128);
        const transactionId = text(row.transactionId, 64);
        if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(transactionId) || seen.has(receiptId)) throw fail();
        seen.add(receiptId);
    }
    return value;
}
