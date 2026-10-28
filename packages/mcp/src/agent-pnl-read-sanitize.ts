import { McpRuntimeError } from "./errors.js";

const fail = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The agent P&L reader returned malformed or inconsistent indexed data.");
type Row = Record<string, unknown>;

function object(value: unknown, keys: readonly string[]): Row {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
    const row = value as Row;
    if (Object.keys(row).length !== keys.length || keys.some((key) => !(key in row))) throw fail();
    return row;
}
function id(value: unknown): string {
    if (typeof value !== "string" || !/^(0x)?[0-9a-f]{1,64}$/i.test(value)) throw fail();
    return value.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}
function sameId(left: unknown, right: string): boolean { return id(left) === id(right); }
function integer(value: unknown, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw fail();
    return value;
}
function int64(value: unknown): bigint {
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) throw fail();
        value = String(value);
    }
    if (typeof value !== "string" || !/^(0|-?[1-9][0-9]*)$/.test(value)) throw fail();
    const parsed = BigInt(value);
    if (parsed < -(1n << 63n) || parsed > (1n << 63n) - 1n) throw fail();
    return parsed;
}
function sum(values: bigint[]): bigint {
    const min = -(1n << 63n); const max = (1n << 63n) - 1n;
    const total = values.reduce((a, b) => a + b, 0n);
    return total < min ? min : total > max ? max : total;
}
function sameAmount(value: unknown, expected: bigint): void { if (int64(value) !== expected) throw fail(); }
function nullableNumber(value: unknown): void {
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) throw fail();
}
function text(value: unknown, max = 512): void { if (typeof value !== "string" || value.length > max) throw fail(); }
function timestamp(value: unknown): void { text(value, 64); if (!Number.isFinite(Date.parse(value as string))) throw fail(); }

const windows = ["days7", "days30", "days180", "days365", "all"];
const profileBuckets = ["spt_creator_fees_myso", "tips_myso", "subscriptions_myso", "mydata_myso", "posts_monetization_myso", "messaging_myso", "username_marketplace_myso", "other_inbound_myso"] as const;

function profileWindow(value: unknown): Row {
    const row = object(value, ["window", "swap_net_myso", "reservation_net_myso", ...profileBuckets, "gross_inbound_myso", "net_cash_flow_myso"]);
    if (!windows.includes(String(row.window))) throw fail();
    const inbound = profileBuckets.map((key) => int64(row[key]));
    const gross = sum(inbound);
    sameAmount(row.gross_inbound_myso, gross);
    sameAmount(row.net_cash_flow_myso, sum([int64(row.swap_net_myso), int64(row.reservation_net_myso), gross]));
    return row;
}

function position(value: unknown): Row {
    const keys = ["pool_id", "token_balance", "supply_pct", "current_value_myso", "avg_entry_price", "avg_exit_price", "unrealized_pl_myso", "unrealized_roi_pct", "realized_pl_myso", "realized_roi_pct", "disposed_cost_basis_myso", "total_invested_myso", "total_returned_myso", "lifetime_net_pl_myso", "lifetime_roi_pct", "cost_basis_unknown", "window_pl_myso", "window_capital_at_risk_myso", "window_return_pct"];
    const row = object(value, keys);
    text(row.pool_id, 128);
    for (const key of ["token_balance", "current_value_myso", "unrealized_pl_myso", "realized_pl_myso", "disposed_cost_basis_myso", "total_invested_myso", "total_returned_myso", "lifetime_net_pl_myso", "window_pl_myso", "window_capital_at_risk_myso"]) int64(row[key]);
    for (const key of ["supply_pct", "unrealized_roi_pct", "realized_roi_pct", "lifetime_roi_pct", "window_return_pct"]) nullableNumber(row[key]);
    for (const key of ["avg_entry_price", "avg_exit_price"]) if (row[key] !== null) int64(row[key]);
    if (typeof row.cost_basis_unknown !== "boolean") throw fail();
    return row;
}

function portfolio(value: unknown, derivedAddress: string): Row {
    const keys = ["holder_address", "current_value_myso", "total_invested_myso", "total_returned_myso", "realized_pl_myso", "disposed_cost_basis_myso", "unrealized_pl_myso", "lifetime_net_pl_myso", "lifetime_roi_pct", "realized_roi_pct", "positions"];
    const row = object(value, keys);
    if (!sameId(row.holder_address, derivedAddress)) throw fail();
    for (const key of ["current_value_myso", "total_invested_myso", "total_returned_myso", "realized_pl_myso", "disposed_cost_basis_myso", "unrealized_pl_myso", "lifetime_net_pl_myso"]) int64(row[key]);
    nullableNumber(row.lifetime_roi_pct); nullableNumber(row.realized_roi_pct);
    if (!Array.isArray(row.positions) || row.positions.length > 10_000) throw fail();
    for (const item of row.positions) position(item);
    return row;
}

function agent(value: unknown, expectedAccount: string, expectedAgent?: string): { row: Row; derived: string } {
    const keys = ["agent_object_id", "derived_address", "account_id", "label", "identity_class", "role_tags", "capabilities", "delegatable_caps", "register_scope", "approval_required_caps", "max_action_spend", "platform_scope", "parent_object_id", "depth", "registered_by", "expires_at_ms", "active", "created_at_ms", "deactivated_at_ms", "revoked_at_ms", "updated_at_ms", "organization_id", "event_id", "transaction_id", "time"];
    const row = object(value, keys);
    const agentId = id(row.agent_object_id); const derived = id(row.derived_address);
    if (!sameId(row.account_id, expectedAccount) || (expectedAgent && agentId !== id(expectedAgent))) throw fail();
    for (const key of ["registered_by"]) id(row[key]);
    for (const key of ["platform_scope", "parent_object_id", "organization_id"]) if (row[key] !== null) id(row[key]);
    text(row.label, 256); text(row.event_id, 256); text(row.transaction_id, 256); timestamp(row.time);
    for (const key of ["identity_class", "register_scope", "depth"]) integer(row[key], 0, 0x7fff);
    for (const key of ["role_tags", "capabilities", "delegatable_caps", "approval_required_caps", "created_at_ms", "updated_at_ms"]) if (int64(row[key]) < 0n) throw fail();
    for (const key of ["expires_at_ms", "deactivated_at_ms", "revoked_at_ms", "max_action_spend"]) if (row[key] !== null && int64(row[key]) < 0n) throw fail();
    if (typeof row.active !== "boolean") throw fail();
    return { row, derived };
}

function lifetime(value: unknown): Row {
    const row = object(value, ["realized_pl_myso", "unrealized_pl_myso", "trading_pl_myso", "gross_inbound_myso", "ai_spend_myso", "net_pnl_myso"]);
    const realized = int64(row.realized_pl_myso); const unrealized = int64(row.unrealized_pl_myso);
    const trading = sum([realized, unrealized]); const inbound = int64(row.gross_inbound_myso); const spend = int64(row.ai_spend_myso);
    sameAmount(row.trading_pl_myso, trading); sameAmount(row.net_pnl_myso, sum([trading, inbound, -spend]));
    if (spend < 0n || inbound < 0n) throw fail();
    return row;
}

function windowPnl(value: unknown): Row {
    const row = object(value, ["window", "cash_flow", "ai_spend_myso", "net_cash_flow_after_ai_myso"]);
    const cash = profileWindow(row.cash_flow);
    if (row.window !== cash.window || int64(row.ai_spend_myso) < 0n) throw fail();
    sameAmount(row.net_cash_flow_after_ai_myso, sum([int64(cash.net_cash_flow_myso), -int64(row.ai_spend_myso)]));
    return row;
}

function expectedWindows(args: Record<string, unknown>): string[] {
    const selected = args.window;
    if (selected === undefined) return ["days7", "days30", "all"];
    const mapping: Record<string, string> = { "7d": "days7", "30d": "days30", "180d": "days180", "365d": "days365", all: "all" };
    const mapped = typeof selected === "string" ? mapping[selected] : undefined;
    if (!mapped) throw fail();
    return [mapped];
}

function subAgent(value: unknown, expectedAccount: string, windowsExpected: string[], expectedAgent?: string): Row {
    const row = object(value, ["agent", "status", "lifetime", "portfolio", "windows"]);
    const { derived } = agent(row.agent, expectedAccount, expectedAgent);
    if (!["active", "deactivated", "revoked"].includes(String(row.status))) throw fail();
    const life = lifetime(row.lifetime); portfolio(row.portfolio, derived);
    if (!Array.isArray(row.windows) || row.windows.length !== windowsExpected.length) throw fail();
    for (let index = 0; index < row.windows.length; index += 1) {
        const window = windowPnl(row.windows[index]);
        if (window.window !== windowsExpected[index]) throw fail();
    }
    if ((row.status === "revoked" && (row.agent as Row).revoked_at_ms === null) || (row.status === "deactivated" && (row.agent as Row).active !== false) || (row.status === "active" && ((row.agent as Row).active !== true || (row.agent as Row).revoked_at_ms !== null))) throw fail();
    void life;
    return row;
}

function totals(value: unknown): Row {
    const row = object(value, ["agent_count", "active_count", "deactivated_count", "revoked_count", "realized_pl_myso", "unrealized_pl_myso", "trading_pl_myso", "gross_inbound_myso", "ai_spend_myso", "net_pnl_myso"]);
    const counts = ["agent_count", "active_count", "deactivated_count", "revoked_count"].map((key) => integer(row[key], 0));
    if (counts[1] + counts[2] + counts[3] !== counts[0]) throw fail();
    for (const key of ["realized_pl_myso", "unrealized_pl_myso", "trading_pl_myso", "gross_inbound_myso", "ai_spend_myso", "net_pnl_myso"]) int64(row[key]);
    return row;
}

export function sanitizeAgentOwnPnl(value: unknown, accountId: string, agentObjectId: string, args: Record<string, unknown>): unknown {
    return subAgent(value, accountId, expectedWindows(args), agentObjectId);
}

export function sanitizeAgentOwnedPnl(value: unknown, accountId: string, args: Record<string, unknown>): unknown {
    const row = object(value, ["agents", "totals", "total_count"]);
    if (!Array.isArray(row.agents) || row.agents.length > (typeof args.limit === "number" ? args.limit : 50)) throw fail();
    const totalCount = integer(row.total_count, 0);
    const windows = expectedWindows(args);
    for (const item of row.agents) subAgent(item, accountId, windows);
    const summary = totals(row.totals);
    if (integer(summary.agent_count, 0) > totalCount || row.agents.length > totalCount) throw fail();
    return row;
}
