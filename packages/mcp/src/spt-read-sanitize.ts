import { McpRuntimeError } from "./errors.js";

const fail = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The SPT reader returned malformed or uncorrelated indexed data.");
type Row = Record<string, unknown>;
function obj(value: unknown, keys: readonly string[]): Row {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
    const row = value as Row;
    if (Object.keys(row).length !== keys.length || keys.some((key) => !(key in row))) throw fail();
    return row;
}
function address(value: unknown): string {
    if (typeof value !== "string" || !/^(0x)?[0-9a-f]{1,64}$/i.test(value)) throw fail();
    return value.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}
function same(left: unknown, right: unknown): boolean { return address(left) === address(right); }
function poolId(value: unknown): string {
    if (typeof value === "string" && value.startsWith("reservation_pool_")) {
        const suffix = address(value.slice("reservation_pool_".length));
        return `reservation_pool_${suffix}`;
    }
    return `0x${address(value)}`;
}
function number(value: unknown, signed = false): bigint {
    if (typeof value === "number") { if (!Number.isSafeInteger(value)) throw fail(); value = String(value); }
    if (typeof value !== "string" || !(signed ? /^(0|-?[1-9][0-9]*)$/ : /^(0|[1-9][0-9]*)$/).test(value)) throw fail();
    const n = BigInt(value); if (n > (1n << 63n) - 1n || n < (signed ? -(1n << 63n) : 0n)) throw fail(); return n;
}
function u64(value: unknown): bigint {
    if (typeof value === "number") { if (!Number.isSafeInteger(value) || value < 0) throw fail(); value = String(value); }
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw fail();
    const n = BigInt(value); if (n > (1n << 64n) - 1n) throw fail(); return n;
}
function text(value: unknown, max = 512, empty = false): string { if (typeof value !== "string" || value.length > max || (!empty && value.length === 0)) throw fail(); return value; }
function timestamp(value: unknown): number { const t = Date.parse(text(value, 64)); if (!Number.isFinite(t)) throw fail(); return t; }
function pageRows(value: unknown, args: Record<string, unknown>, fallback = 20): Row[] {
    const limit = typeof args.limit === "number" ? args.limit : fallback;
    if (!Array.isArray(value) || value.length > limit) throw fail();
    return value.map((v) => { if (!v || typeof v !== "object" || Array.isArray(v)) throw fail(); return v as Row; });
}
function sortedDescending(items: Row[], field: string, parse: (v: unknown) => bigint | number): void {
    let previous: bigint | number | undefined;
    for (const row of items) { const current = parse(row[field]); if (previous !== undefined && current > previous) throw fail(); previous = current; }
}
function pool(value: unknown): Row {
    const r = obj(value, ["pool_id", "token_type", "owner", "associated_id", "circulating_supply", "launch_supply", "base_price", "quadratic_coefficient", "created_at", "time", "transaction_id"]);
    address(r.pool_id); if (number(r.token_type, true) < -32768n || number(r.token_type, true) > 32767n) throw fail();
    address(r.owner); address(r.associated_id); number(r.circulating_supply); number(r.launch_supply); number(r.base_price); number(r.quadratic_coefficient); number(r.created_at); timestamp(r.time); text(r.transaction_id, 128);
    return r;
}
function transaction(value: unknown, id: string): Row {
    const r = obj(value, ["pool_id", "transaction_type", "sender", "amount", "myso_amount", "fee_amount", "creator_fee", "platform_fee", "treasury_fee", "price", "created_at", "time", "transaction_id", "counterparty_pool_id", "is_swap_leg"]);
    if (!same(r.pool_id, id)) throw fail(); text(r.transaction_type, 64); address(r.sender);
    number(r.amount, true); number(r.myso_amount, true);
    for (const k of ["fee_amount", "creator_fee", "platform_fee", "treasury_fee", "price", "created_at"]) number(r[k]);
    timestamp(r.time); text(r.transaction_id, 128); if (r.counterparty_pool_id !== null) address(r.counterparty_pool_id);
    if (typeof r.is_swap_leg !== "boolean" || (r.is_swap_leg !== (r.counterparty_pool_id !== null))) throw fail();
    return r;
}
function swap(value: unknown, id: string): Row {
    const keys = ["transaction_id", "trader", "source_pool_id", "dest_pool_id", "sell_amount", "dest_amount", "sell_myso_gross", "buy_myso_gross", "sell_fee_amount", "buy_fee_amount", "sell_creator_fee", "sell_platform_fee", "sell_treasury_fee", "buy_creator_fee", "buy_platform_fee", "buy_treasury_fee", "leftover_myso", "source_new_price", "dest_new_price", "created_at", "time"];
    const r = obj(value, keys); text(r.transaction_id, 128); address(r.trader); address(r.source_pool_id); address(r.dest_pool_id);
    if (!same(r.source_pool_id, id) && !same(r.dest_pool_id, id)) throw fail();
    for (const k of keys.slice(4, 20)) number(r[k]);
    number(r.created_at); timestamp(r.time); return r;
}
function transfer(value: unknown, id: string): Row {
    const r = obj(value, ["transaction_id", "pool_id", "from_address", "to_address", "amount", "created_at", "time"]);
    text(r.transaction_id, 128); if (!same(r.pool_id, id)) throw fail(); address(r.from_address); address(r.to_address); number(r.amount); number(r.created_at); timestamp(r.time); return r;
}
function holding(value: unknown): Row {
    const r = obj(value, ["holder_address", "balance"]); address(r.holder_address); number(r.balance, true); return r;
}
function price(value: unknown, id: string): Row {
    const r = obj(value, ["pool_id", "price", "circulating_supply", "time", "transaction_id"]);
    if (!same(r.pool_id, id)) throw fail(); number(r.price); number(r.circulating_supply); timestamp(r.time); text(r.transaction_id, 128); return r;
}
function revenue(value: unknown, id: string): Row {
    const r = obj(value, ["pool_id", "transaction_type", "trader", "creator_address", "platform_address", "treasury_address", "creator_fee", "platform_fee", "treasury_fee", "total_fee", "token_amount", "myso_amount", "token_price", "revenue_time", "time", "transaction_id"]);
    if (!same(r.pool_id, id)) throw fail(); text(r.transaction_type, 64); address(r.trader); address(r.creator_address); address(r.platform_address); address(r.treasury_address);
    for (const k of ["creator_fee", "platform_fee", "treasury_fee", "total_fee", "token_amount", "myso_amount", "token_price", "revenue_time"]) number(r[k]);
    if (number(r.creator_fee) + number(r.platform_fee) + number(r.treasury_fee) !== number(r.total_fee)) throw fail();
    timestamp(r.time); text(r.transaction_id, 128); return r;
}
function reservationPool(value: unknown): Row {
    const r = obj(value, ["pool_id", "associated_id", "token_type", "owner", "total_reserved", "required_threshold", "status", "created_at", "time", "transaction_id"]);
    address(r.pool_id); address(r.associated_id); const kind = number(r.token_type, true); if (kind < -32768n || kind > 32767n) throw fail();
    address(r.owner); number(r.total_reserved); number(r.required_threshold); text(r.status, 64); number(r.created_at); timestamp(r.time); text(r.transaction_id, 128); return r;
}
function reservation(value: unknown, id?: string): Row {
    const r = obj(value, ["pool_id", "reserver_address", "amount", "reserved_at", "created_at", "fee_amount", "creator_fee", "platform_fee", "treasury_fee", "time", "transaction_id"]);
    const returnedPool = poolId(r.pool_id); if (id && !returnedPool.startsWith("reservation_pool_") && returnedPool !== poolId(id)) throw fail(); address(r.reserver_address); number(r.amount, true); number(r.reserved_at); number(r.created_at);
    for (const k of ["fee_amount", "creator_fee", "platform_fee", "treasury_fee"]) if (r[k] !== null) number(r[k]);
    timestamp(r.time); text(r.transaction_id, 128); return r;
}
function userHolding(value: unknown, sourceExpected?: "holding" | "reservation" | "either"): Row {
    const required = ["pool_id", "amount", "acquired_at", "source", "token_type", "associated_id"];
    const optional = ["profile_address", "username", "display_name", "profile_photo", "total_reserved", "required_threshold", "reservation_percentage", "remaining_percentage", "threshold_met", "pool_status"];
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
    const r = value as Row;
    if (required.some((k) => !(k in r)) || Object.keys(r).some((k) => !required.includes(k) && !optional.includes(k))) throw fail();
    poolId(r.pool_id); number(r.amount); number(r.acquired_at); address(r.associated_id);
    if (number(r.token_type, true) < -32768n || number(r.token_type, true) > 32767n) throw fail();
    if ((r.source !== "reservation" && r.source !== "holding") || (sourceExpected && sourceExpected !== "either" && r.source !== sourceExpected)) throw fail();
    if (r.profile_address !== undefined && r.profile_address !== null) address(r.profile_address);
    for (const k of ["username", "display_name", "profile_photo", "pool_status"]) if (r[k] !== undefined && r[k] !== null) text(r[k], 1024);
    for (const k of ["total_reserved", "required_threshold"]) if (r[k] !== undefined && r[k] !== null) number(r[k]);
    for (const k of ["reservation_percentage", "remaining_percentage"]) if (r[k] !== undefined && r[k] !== null && (typeof r[k] !== "number" || !Number.isFinite(r[k]) || r[k] < 0 || r[k] > 100)) throw fail();
    if (r.threshold_met !== undefined && r.threshold_met !== null && typeof r.threshold_met !== "boolean") throw fail();
    if (r.source === "reservation" && (r.total_reserved === undefined || r.required_threshold === undefined || typeof r.threshold_met !== "boolean")) throw fail();
    return r;
}
function config(value: unknown): Row {
    const keys = ["updated_by", "post_threshold", "profile_threshold", "max_individual_reservation_bps", "total_fee_bps", "creator_fee_bps", "platform_fee_bps", "treasury_fee_bps", "trading_creator_fee_bps", "trading_platform_fee_bps", "trading_treasury_fee_bps", "reservation_creator_fee_bps", "reservation_platform_fee_bps", "reservation_treasury_fee_bps", "max_reservers_per_pool", "base_price", "quadratic_coefficient", "max_hold_percent_bps", "trading_enabled", "non_platform_platform_to_creator_bps", "non_platform_platform_to_treasury_bps", "updated_at", "time", "transaction_id"];
    const r = obj(value, keys); address(r.updated_by); for (const k of keys.slice(1, 18)) number(r[k]);
    if (typeof r.trading_enabled !== "boolean") throw fail(); number(r.non_platform_platform_to_creator_bps); number(r.non_platform_platform_to_treasury_bps); number(r.updated_at); timestamp(r.time); text(r.transaction_id, 128); return r;
}
function reservationPoolWithDisplay(value: unknown): Row {
    const keys = ["id", "pool_id", "associated_id", "token_type", "owner", "total_reserved", "required_threshold", "status", "created_at_epoch", "created_at", "transaction_id", "icon", "primary_label", "secondary_label", "volume_24h", "volume_change_24h", "volume_change_percent_24h"];
    const r = obj(value, keys); number(r.id); address(r.pool_id); address(r.associated_id); number(r.token_type, true); address(r.owner);
    number(r.total_reserved); number(r.required_threshold); text(r.status, 64); number(r.created_at_epoch); timestamp(r.created_at); text(r.transaction_id, 128);
    for (const k of ["icon", "primary_label", "secondary_label"]) if (r[k] !== null) text(r[k], 2048);
    number(r.volume_24h); number(r.volume_change_24h, true);
    if (r.volume_change_percent_24h !== null && (typeof r.volume_change_percent_24h !== "number" || !Number.isFinite(r.volume_change_percent_24h))) throw fail();
    return r;
}
function reservationBucket(value: unknown): Row {
    const keys = ["bucket_start", "bucket_end", "earliest_at", "latest_at", "deposit_volume", "withdrawal_volume", "deposit_count", "withdrawal_count"];
    const r = obj(value, keys); const start = number(r.bucket_start), end = number(r.bucket_end), earliest = number(r.earliest_at), latest = number(r.latest_at);
    if (end < start || latest < earliest) throw fail();
    for (const k of keys.slice(4)) number(r[k]); return r;
}
function optionalInt(row: Row, key: string, signed = true): bigint | null {
    if (row[key] === null) return null;
    return number(row[key], signed);
}
function optionalFloat(row: Row, key: string, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY): number | null {
    if (row[key] === null) return null;
    if (typeof row[key] !== "number" || !Number.isFinite(row[key]) || row[key] < min || row[key] > max) throw fail();
    return row[key];
}
function position(value: unknown): Row {
    const keys = ["pool_id", "token_balance", "supply_pct", "current_value_myso", "avg_entry_price", "avg_exit_price", "unrealized_pl_myso", "unrealized_roi_pct", "realized_pl_myso", "realized_roi_pct", "disposed_cost_basis_myso", "total_invested_myso", "total_returned_myso", "lifetime_net_pl_myso", "lifetime_roi_pct", "cost_basis_unknown", "window_pl_myso", "window_capital_at_risk_myso", "window_return_pct"];
    const r = obj(value, keys); address(r.pool_id);
    for (const k of ["token_balance", "current_value_myso", "unrealized_pl_myso", "realized_pl_myso", "disposed_cost_basis_myso", "total_invested_myso", "total_returned_myso", "lifetime_net_pl_myso", "window_pl_myso", "window_capital_at_risk_myso"]) number(r[k], true);
    for (const k of ["avg_entry_price", "avg_exit_price"]) optionalInt(r, k);
    optionalFloat(r, "supply_pct", 0); optionalFloat(r, "unrealized_roi_pct"); optionalFloat(r, "realized_roi_pct"); optionalFloat(r, "lifetime_roi_pct"); optionalFloat(r, "window_return_pct");
    if (typeof r.cost_basis_unknown !== "boolean") throw fail();
    if (number(r.lifetime_net_pl_myso, true) !== number(r.realized_pl_myso, true) + number(r.unrealized_pl_myso, true)) throw fail();
    return r;
}
function portfolio(value: unknown, holder?: unknown): Row {
    const keys = ["holder_address", "current_value_myso", "total_invested_myso", "total_returned_myso", "realized_pl_myso", "disposed_cost_basis_myso", "unrealized_pl_myso", "lifetime_net_pl_myso", "lifetime_roi_pct", "realized_roi_pct", "positions"];
    const r = obj(value, keys); address(r.holder_address); if (holder !== undefined && !same(r.holder_address, holder)) throw fail();
    for (const k of keys.slice(1, 8)) number(r[k], true);
    optionalFloat(r, "lifetime_roi_pct"); optionalFloat(r, "realized_roi_pct");
    if (!Array.isArray(r.positions) || r.positions.length > 500) throw fail();
    const positions = r.positions.map(position); const pools = new Set<string>();
    for (const item of positions) { const key = address(item.pool_id); if (pools.has(key)) throw fail(); pools.add(key); }
    const sum = (key: string) => positions.reduce((total, item) => total + number(item[key], true), 0n);
    for (const key of ["current_value_myso", "total_invested_myso", "total_returned_myso", "realized_pl_myso", "disposed_cost_basis_myso", "unrealized_pl_myso"]) if (number(r[key], true) !== sum(key)) throw fail();
    const net = number(r.realized_pl_myso, true) + number(r.unrealized_pl_myso, true);
    if (number(r.lifetime_net_pl_myso, true) !== net) throw fail();
    const invested = number(r.total_invested_myso, true), disposed = number(r.disposed_cost_basis_myso, true);
    if (r.lifetime_roi_pct === null ? invested > 0n : invested <= 0n || Math.abs((r.lifetime_roi_pct as number) - Number(net) / Number(invested) * 100) > Math.max(0.001, Math.abs(r.lifetime_roi_pct as number) * 1e-9)) throw fail();
    if (r.realized_roi_pct === null ? disposed > 0n : disposed <= 0n || Math.abs((r.realized_roi_pct as number) - Number(number(r.realized_pl_myso, true)) / Number(disposed) * 100) > Math.max(0.001, Math.abs(r.realized_roi_pct as number) * 1e-9)) throw fail();
    return r;
}
function digest(value: unknown): void { if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(value)) throw fail(); }
function spotEvent(value: unknown, kind: "buy" | "sell"): Row {
    const party = kind === "buy" ? "buyer" : "seller";
    const r = obj(value, ["id", party, "amount", "myso_amount", "fee_amount", "creator_fee", "platform_fee", "treasury_fee", "new_price"]);
    address(r.id); address(r[party]);
    for (const k of ["amount", "myso_amount", "fee_amount", "creator_fee", "platform_fee", "treasury_fee", "new_price"]) u64(r[k]);
    if (u64(r.creator_fee) + u64(r.platform_fee) + u64(r.treasury_fee) !== u64(r.fee_amount)) throw fail();
    return r;
}
function feeSettlement(value: unknown): Row {
    const r = obj(value, ["pool_id", "trader", "source_post_id", "creator_fee", "wallet_amount", "vault_amount"]);
    address(r.pool_id); address(r.trader); u64(r.creator_fee); u64(r.wallet_amount); u64(r.vault_amount);
    if (r.source_post_id !== null) {
        const option = r.source_post_id;
        if (Array.isArray(option)) { if (option.length > 1) throw fail(); if (option.length === 1) address(option[0]); }
        else if (typeof option === "object") {
            const row = option as Row; const vec = Array.isArray(row.vec) ? row.vec : (row.fields as Row | undefined)?.vec;
            if (!Array.isArray(vec) || vec.length > 1) throw fail(); if (vec.length === 1) address(vec[0]);
        } else address(option);
    }
    if (u64(r.wallet_amount) + u64(r.vault_amount) !== u64(r.creator_fee)) throw fail();
    return r;
}
function quote(value: unknown, args: Record<string, unknown>): Row {
    const keys = ["kind", "poolId", "inputBaseUnits", "outputBaseUnits", "curveBaseUnits", "feeBaseUnits", "creatorFeeBaseUnits", "totalTradingFeeBps", "currentSupplyBaseUnits", "requiredEscrowBeneficiaries", "evidence", "executionAuthority"];
    const r = obj(value, keys); address(r.poolId);
    if (!same(r.poolId, args.poolId) || r.kind !== args.tradeKind || u64(r.inputBaseUnits) !== u64(args.amountBaseUnits)) throw fail();
    const output = u64(r.outputBaseUnits), curve = u64(r.curveBaseUnits), fee = u64(r.feeBaseUnits), creatorFee = u64(r.creatorFeeBaseUnits);
    if (u64(r.totalTradingFeeBps) < 1n || u64(r.totalTradingFeeBps) > 10_000n || creatorFee > fee || (r.kind === "sell" && output !== curve - fee) || (r.kind === "buy" && curve + fee > u64(r.inputBaseUnits))) throw fail();
    u64(r.currentSupplyBaseUnits);
    if (!Array.isArray(r.requiredEscrowBeneficiaries) || r.requiredEscrowBeneficiaries.length > 32) throw fail();
    const beneficiaries = new Set<string>(); for (const item of r.requiredEscrowBeneficiaries) { const normalized = address(item); if (beneficiaries.has(normalized)) throw fail(); beneficiaries.add(normalized); }
    if (r.evidence !== "latest_configured_fullnode_object_state" || r.executionAuthority !== "indicative_only_move_rechecks_live_state_and_minimum_output") throw fail();
    return r;
}
function topPerformer(value: unknown): Row {
    const r = obj(value, ["pool_id", "current_price", "previous_price", "current_volume", "previous_volume", "price_change_percentage", "volume_change_percentage"]);
    address(r.pool_id); for (const k of ["current_price", "previous_price"]) number(r[k]);
    for (const k of ["current_volume", "previous_volume"]) number(r[k], true);
    for (const k of ["price_change_percentage", "volume_change_percentage"]) if (typeof r[k] !== "number" || !Number.isFinite(r[k])) throw fail();
    const previous = number(r.previous_price), current = number(r.current_price);
    const expected = previous === 0n ? 0 : (Number(current - previous) / Number(previous)) * 100;
    if (Math.abs((r.price_change_percentage as number) - expected) > Math.max(0.001, Math.abs(expected) * 1e-9)) throw fail();
    const previousVolume = number(r.previous_volume, true), currentVolume = number(r.current_volume, true);
    const expectedVolume = previousVolume === 0n ? 0 : (Number(currentVolume - previousVolume) / Number(previousVolume)) * 100;
    if (Math.abs((r.volume_change_percentage as number) - expectedVolume) > Math.max(0.001, Math.abs(expectedVolume) * 1e-9)) throw fail();
    return r;
}
function marketSentiment(value: unknown): Row {
    const keys = ["overall_sentiment", "buy_volume_24h", "sell_volume_24h", "transaction_count_24h", "unique_buyers_24h", "unique_sellers_24h", "reservation_volume_24h", "reservation_count_24h", "unique_reservers_24h", "volume_change_percentage", "price_momentum"];
    const r = obj(value, keys); if (optionalFloat(r, "overall_sentiment", -1, 1) === null) throw fail();
    for (const k of keys.slice(1, 9)) number(r[k]);
    if (typeof r.volume_change_percentage !== "number" || !Number.isFinite(r.volume_change_percentage) || !Array.isArray(r.price_momentum) || r.price_momentum.length !== 0) throw fail();
    return r;
}
function liquidityProfile(value: unknown, id: unknown): Row {
    const keys = ["pool_id", "total_volume_24h", "transaction_count_24h", "average_transaction_size", "largest_transaction", "unique_traders_count", "buy_volume_24h", "sell_volume_24h", "buy_sell_ratio", "reservation_metrics"];
    const r = obj(value, keys); if (!same(r.pool_id, id)) throw fail();
    for (const k of keys.slice(1, 8)) number(r[k], ["total_volume_24h", "average_transaction_size", "largest_transaction", "buy_volume_24h", "sell_volume_24h"].includes(k));
    if (typeof r.buy_sell_ratio !== "number" || !Number.isFinite(r.buy_sell_ratio) || r.buy_sell_ratio < 0) throw fail();
    if (!r.reservation_metrics || typeof r.reservation_metrics !== "object" || Array.isArray(r.reservation_metrics)) throw fail();
    const reservationMetrics = r.reservation_metrics as Row;
    if (Object.keys(reservationMetrics).length) {
        obj(reservationMetrics, ["total_reserved", "required_threshold", "status", "associated_id", "token_type"]);
        number(reservationMetrics.total_reserved); number(reservationMetrics.required_threshold); text(reservationMetrics.status, 64); address(reservationMetrics.associated_id); number(reservationMetrics.token_type, true);
    }
    return r;
}
function creatorRevenue(value: unknown, expectedAddress: unknown): Row {
    const r = obj(value, ["address", "total_revenue", "token_pools", "revenue_by_period"]);
    if (!same(r.address, expectedAddress) || !Array.isArray(r.token_pools) || r.token_pools.length > 1000 || !Array.isArray(r.revenue_by_period) || r.revenue_by_period.length !== 0) throw fail();
    const rows = r.token_pools.map((v) => obj(v, ["pool_id", "total_revenue", "buy_revenue", "sell_revenue", "transactions_count"]));
    const seen = new Set<string>(); let total = 0n;
    for (const row of rows) {
        const pool = address(row.pool_id); if (seen.has(pool)) throw fail(); seen.add(pool);
        const buy = number(row.buy_revenue), sell = number(row.sell_revenue), rowTotal = number(row.total_revenue);
        if (buy + sell !== rowTotal) throw fail(); number(row.transactions_count); total += rowTotal;
    }
    if (number(r.total_revenue) !== total) throw fail();
    return r;
}
function timePoint(value: unknown): Row {
    const r = obj(value, ["time", "token_balance", "supply_pct", "mark_value_myso", "unrealized_roi_pct"]);
    timestamp(r.time); number(r.token_balance, true); optionalFloat(r, "supply_pct", 0); number(r.mark_value_myso, true); optionalFloat(r, "unrealized_roi_pct"); return r;
}
function leaderboard(value: unknown, args: Record<string, unknown>): unknown {
    const items = pageRows(value, args); const offset = typeof args.offset === "number" ? args.offset : 0;
    const sort = args.sort ?? "highest_window_return_pct";
    const metricBySort: Record<string, string> = { highest_lifetime_roi: "lifetimeRoiPct", highest_lifetime_net_pl: "lifetimeNetPlMyso", highest_window_net_pl: "windowPlMyso", highest_window_return_pct: "windowReturnPct", highest_realized_pl_in_window: "windowRealizedPlMyso", largest_portfolio_value: "currentValueMyso" };
    const metric = metricBySort[String(sort)]; if (!metric) throw fail();
    for (let index = 0; index < items.length; index++) {
        const row = obj(items[index], ["rank", "wallet", "sort_value", "sort_metric", "metrics"]);
        if (number(row.rank) !== BigInt(offset + index + 1) || row.sort_metric !== metric || typeof row.sort_value !== "number" || !Number.isFinite(row.sort_value)) throw fail();
        const checked = portfolio(row.metrics, row.wallet);
        if (metric === "lifetimeRoiPct" && checked.lifetime_roi_pct !== null && row.sort_value !== checked.lifetime_roi_pct) throw fail();
        if (metric === "lifetimeNetPlMyso" && Math.abs(Number(number(checked.lifetime_net_pl_myso, true)) - row.sort_value) > Math.max(1, Math.abs(row.sort_value) * 1e-12)) throw fail();
    }
    return value;
}

export function sanitizeSptRead(name: string, value: unknown, args: Record<string, unknown>): unknown {
    const id = args.id !== undefined ? address(args.id) : undefined;
    const paged = (validator: (v: unknown) => Row, field?: string) => {
        const checked = pageRows(value, args);
        const mapped = checked.map(validator);
        if (field) sortedDescending(mapped, field, (v) => field === "time" ? timestamp(v) : number(v));
        return value;
    };
    if (["spt_get_pool", "spt_get_pool_by_associated_id"].includes(name)) {
        const row = pool(value);
        if (name === "spt_get_pool" && !same(row.pool_id, args.id)) throw fail();
        if (name === "spt_get_pool_by_associated_id" && !same(row.associated_id, args.id)) throw fail();
        return row;
    }
    if (name === "spt_list_pools") {
        const result = paged((v) => pool(v), "created_at") as Row[];
        if (args.address !== undefined && result.some((row) => !same(row.owner, args.address))) throw fail();
        if (args.token_type !== undefined && result.some((row) => number(row.token_type, true) !== BigInt(args.token_type as number))) throw fail();
        return result;
    }
    if (name === "spt_list_popular_pools") return paged((v) => pool(v));
    if (name === "spt_list_pool_transactions") return paged((v) => transaction(v, id!), "time");
    if (name === "spt_list_pool_swaps") return paged((v) => swap(v, id!), "time");
    if (name === "spt_list_pool_transfers") return paged((v) => transfer(v, id!), "time");
    if (name === "spt_list_pool_holdings") return paged((v) => { const r = holding(v); return r; });
    if (name === "spt_list_pool_price_history") return paged((v) => price(v, id!), "time");
    if (name === "spt_list_pool_revenue") return paged((v) => revenue(v, id!), "revenue_time");
    if (name === "spt_get_configuration") return config(value);
    if (name === "spt_get_reservation_pool") { const r = reservationPool(value); if (!same(r.pool_id, args.id)) throw fail(); return r; }
    if (name === "spt_list_reservations") return paged((v) => reservation(v, id), "time");
    if (name === "spt_list_user_reservations") return paged((v) => userHolding(v, "reservation"), "acquired_at");
    if (name === "spt_get_user_holdings") return paged((v) => userHolding(v, args.include_reservations === true ? "either" : "holding"), "acquired_at");
    if (name === "spt_list_reservation_pools") {
        const root = obj(value, ["data", "pagination"]); const limit = typeof args.limit === "number" ? args.limit : 20; const offset = typeof args.offset === "number" ? args.offset : 0;
        if (!Array.isArray(root.data) || root.data.length > limit) throw fail();
        const page = obj(root.pagination, ["page", "limit", "total", "total_pages"]);
        const total = number(page.total), pages = number(page.total_pages);
        if (number(page.page) !== BigInt(Math.floor(offset / limit) + 1) || number(page.limit) !== BigInt(limit) || pages !== (total === 0n ? 1n : (total + BigInt(limit) - 1n) / BigInt(limit))) throw fail();
        root.data.map(reservationPoolWithDisplay); return value;
    }
    if (name === "spt_get_reservation_volume_history") {
        const checked = pageRows(value, args, 168); const mapped = checked.map(reservationBucket);
        let previous: bigint | undefined; for (const row of mapped) { const current = number(row.bucket_start); if (previous !== undefined && current > previous) throw fail(); previous = current; }
        return value;
    }
    if (name === "spt_get_market_sentiment") return marketSentiment(value);
    if (name === "spt_get_pool_liquidity_profile") return liquidityProfile(value, args.id);
    if (name === "spt_get_portfolio_performance") return portfolio(value, args.address);
    if (name === "spt_get_position_metrics") {
        const checked = pageRows(value, args, 50); if (checked.length > 200) throw fail();
        return checked.map(position);
    }
    if (name === "spt_get_position_timeseries") {
        if (!Array.isArray(value) || value.length > 10_000) throw fail();
        const checked = value.map(timePoint); let prior = Number.NEGATIVE_INFINITY;
        for (const point of checked) { const current = timestamp(point.time); if (current < prior) throw fail(); prior = current; }
        return checked;
    }
    if (name === "spt_get_top_performers") {
        if (!Array.isArray(value) || value.length > 50) throw fail();
        const checked = value.map(topPerformer);
        sortedDescending(checked, "price_change_percentage", (v) => { if (typeof v !== "number" || !Number.isFinite(v)) throw fail(); return v; });
        return checked;
    }
    if (name === "spt_list_creator_revenue_streams") return creatorRevenue(value, args.address);
    if (name === "spt_list_trader_leaderboard") return leaderboard(value, args);
    if (name === "spt_get_trade_quote") return quote(value, args);
    if (name === "spt_get_trade_receipt") {
        const row = obj(value, ["digest", "registryAction", "status", "checkpoint", "trade", "creatorFeeSettlement", "evidenceSource"]);
        digest(row.digest); if (row.digest !== args.id || !["spt.buy.v1", "spt.sell.v1"].includes(String(row.registryAction))) throw fail();
        if (!["finalized", "checkpoint_pending", "failed", "unknown"].includes(String(row.status))) throw fail();
        if (row.checkpoint !== null) u64(row.checkpoint);
        text(row.evidenceSource, 128);
        let checkedTrade: Row | null = null;
        if (row.trade !== null) checkedTrade = spotEvent(row.trade, row.registryAction === "spt.buy.v1" ? "buy" : "sell");
        let settlement: Row | null = null;
        if (row.creatorFeeSettlement !== null) settlement = feeSettlement(row.creatorFeeSettlement);
        if (checkedTrade && settlement && (!same(settlement.pool_id, checkedTrade.id) || !same(settlement.trader, checkedTrade[row.registryAction === "spt.buy.v1" ? "buyer" : "seller"]) || u64(settlement.creator_fee) !== u64(checkedTrade.creator_fee))) throw fail();
        if (row.status === "finalized" && (row.checkpoint === null || !checkedTrade || !settlement)) throw fail();
        return row;
    }
    throw fail();
}
