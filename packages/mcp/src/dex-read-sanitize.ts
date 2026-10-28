import { McpRuntimeError } from "./errors.js";

const fail = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The Orderbook reader returned malformed or inconsistent market data.");
function obj(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
    const row = value as Record<string, unknown>;
    if (Object.keys(row).length !== keys.length || keys.some((key) => !(key in row))) throw fail();
    return row;
}
function text(value: unknown, max: number): string {
    if (typeof value !== "string" || value.length < 1 || value.length > max) throw fail();
    return value;
}
function safeInteger(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw fail();
    return value;
}
function signedInteger(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) throw fail();
    return value;
}
function address(value: unknown): string {
    if (typeof value !== "string" || !/^(0x)?[0-9a-f]{1,64}$/i.test(value)) throw fail();
    return value.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}
function decimal(value: unknown, positive = false): void {
    if (typeof value !== "string" || value.length > 80 || !/^(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(value)) throw fail();
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || positive && numeric <= 0) throw fail();
}
function finite(value: unknown, integer = false, signed = false): void {
    if (typeof value !== "number" && typeof value !== "string") throw fail();
    if (typeof value === "string" && (value.length > 80 || !/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(value))) throw fail();
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || !signed && numeric < 0 || integer && (!Number.isSafeInteger(numeric) || !signed && numeric < 0)) throw fail();
}
function nullableText(value: unknown, max: number): void { if (value !== null) text(value, max); }
function nullableInteger(value: unknown, min: number, max: number): void { if (value !== null) safeInteger(value, min, max); }

function marketEnvelope(value: unknown, args: Record<string, unknown>, field: "summary" | "ticker" | "trades", source: string, notice: string): Record<string, unknown> {
    const row = obj(value, ["network", "market", field, "source", "notice"]);
    marketResponseMetadata(row, row.network, source, notice);
    const item = market(row.market);
    if (item.poolName !== args.pool_name) throw fail();
    return row;
}

const summaryFields: Record<string, "text" | "number"> = {
    trading_pairs: "text", base_currency: "text", quote_currency: "text", last_price: "number",
    highest_bid: "number", lowest_ask: "number", highest_price_24h: "number", lowest_price_24h: "number",
    price_change_percent_24h: "number", base_volume: "number", quote_volume: "number",
};
function summaryRecord(value: unknown, poolName: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
    const row = value as Record<string, unknown>;
    if (Object.keys(row).length > Object.keys(summaryFields).length || row.trading_pairs !== poolName) throw fail();
    for (const [key, value] of Object.entries(row)) {
        const kind = summaryFields[key];
        if (!kind) throw fail();
        if (kind === "text") text(value, 128); else finite(value);
    }
}

export function sanitizeDexSummary(value: unknown, args: Record<string, unknown>): unknown {
    const row = marketEnvelope(value, args, "summary", "configured Orderbook /summary", "Indexed market summary; values can be stale and are not an execution quote or fill guarantee.");
    summaryRecord(row.summary, args.pool_name);
    return row;
}

export function sanitizeDexTicker(value: unknown, args: Record<string, unknown>): unknown {
    const row = marketEnvelope(value, args, "ticker", "configured Orderbook /ticker", "Indexed market ticker; values can be stale and are not an execution quote or fill guarantee.");
    const ticker = row.ticker;
    if (!ticker || typeof ticker !== "object" || Array.isArray(ticker)) throw fail();
    const fields = ticker as Record<string, unknown>;
    const allowed = new Set(["base_volume", "quote_volume", "last_price", "isFrozen"]);
    if (Object.keys(fields).length > allowed.size || Object.keys(fields).some((key) => !allowed.has(key))) throw fail();
    for (const key of ["base_volume", "quote_volume", "last_price"]) if (fields[key] !== undefined) finite(fields[key]);
    if (fields.isFrozen !== undefined) safeInteger(fields.isFrozen, 0, 1);
    return row;
}

const tradeNumericFields = new Set(["base_volume", "quote_volume", "price", "timestamp", "taker_fee", "maker_fee"]);
const tradeTextFields = new Set(["event_digest", "digest", "trade_id", "type", "maker_order_id", "taker_order_id", "maker_client_order_id", "taker_client_order_id", "maker_balance_manager_id", "taker_balance_manager_id"]);
function tradeRecord(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
    const row = value as Record<string, unknown>;
    if (Object.keys(row).length > tradeNumericFields.size + tradeTextFields.size) throw fail();
    for (const [key, value] of Object.entries(row)) {
        if (tradeNumericFields.has(key)) finite(value, key === "timestamp");
        else if (tradeTextFields.has(key)) text(value, 256);
        else if (["taker_is_bid", "taker_fee_is_myso", "maker_fee_is_myso"].includes(key)) { if (typeof value !== "boolean") throw fail(); }
        else throw fail();
    }
}

export function sanitizeDexTrades(value: unknown, args: Record<string, unknown>): unknown {
    const row = marketEnvelope(value, args, "trades", "configured Orderbook /trades", "Recent indexed trades; records can be delayed and do not guarantee current price or liquidity.");
    const trades = row.trades;
    const requested = args.limit ?? 50;
    if (!Array.isArray(trades) || !Number.isSafeInteger(requested) || (requested as number) < 1 || (requested as number) > 100 || trades.length > (requested as number)) throw fail();
    for (const trade of trades) tradeRecord(trade);
    return row;
}

function pipelineStatus(value: unknown): void {
    const row = value as Record<string, unknown>;
    const keys = ["pipeline", "indexed_checkpoint", "indexed_epoch", "indexed_timestamp_ms", "checkpoint_lag", "time_lag_seconds", "latest_onchain_checkpoint"];
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length !== keys.length || keys.some((key) => !(key in row))) throw fail();
    if (typeof row.pipeline !== "string" || row.pipeline.length > 128) throw fail();
    for (const key of ["indexed_checkpoint", "indexed_epoch", "indexed_timestamp_ms", "latest_onchain_checkpoint"]) safeInteger(row[key], 0);
    signedInteger(row.checkpoint_lag);
    signedInteger(row.time_lag_seconds);
}

export function sanitizeDexStatus(value: unknown): unknown {
    const row = obj(value, ["network", "status", "source", "notice"]);
    marketResponseMetadata(row, row.network, "configured Orderbook /status", "Indexer health and checkpoint lag are operational metadata, not proof of market availability or transaction success.");
    if (!row.status || typeof row.status !== "object" || Array.isArray(row.status)) throw fail();
    const status = row.status as Record<string, unknown>;
    const keys = ["status", "latest_onchain_checkpoint", "current_time_ms", "earliest_checkpoint", "max_lag_pipeline", "pipelines", "max_checkpoint_lag", "max_time_lag_seconds"];
    if (Object.keys(status).length !== keys.length || keys.some((key) => !(key in status)) || !["OK", "UNHEALTHY"].includes(String(status.status))) throw fail();
    for (const key of ["latest_onchain_checkpoint", "current_time_ms", "earliest_checkpoint"]) safeInteger(status[key], 0);
    signedInteger(status.max_checkpoint_lag);
    signedInteger(status.max_time_lag_seconds);
    if (typeof status.max_lag_pipeline !== "string" || status.max_lag_pipeline.length > 128) throw fail();
    if (!Array.isArray(status.pipelines) || status.pipelines.length > 256) throw fail();
    for (const pipeline of status.pipelines) pipelineStatus(pipeline);
    return row;
}

function nonNegativeIntegerValue(value: unknown): void {
    if (typeof value === "number") { safeInteger(value, 0); return; }
    if (typeof value === "string" && value.length <= 40 && /^(0|[1-9][0-9]*)$/.test(value)) return;
    throw fail();
}

export function sanitizeDexSwapReceipt(value: unknown, args: Record<string, unknown>): unknown {
    const row = obj(value, ["digest", "registryAction", "status", "finalized", "verified", "checkpoint", "poolId", "poolName", "direction", "inputAmountBaseUnits", "minimumOutputBaseUnits", "actualOutputBaseUnits", "outputAssetType", "fills", "evidenceSource"]);
    if (typeof args.id !== "string" || row.digest !== args.id || row.registryAction !== "dex.swap.v1"
        || !["failed", "finalized", "checkpoint_pending_or_fill_unverified", "unknown"].includes(String(row.status))
        || typeof row.finalized !== "boolean" || typeof row.verified !== "boolean"
        || row.evidenceSource !== "configured_fullnode_and_scoped_preparation") throw fail();
    if (row.checkpoint !== null) nonNegativeIntegerValue(row.checkpoint);
    address(row.poolId); text(row.poolName, 128); text(row.outputAssetType, 512);
    if (row.direction !== "sell_base" && row.direction !== "buy_base") throw fail();
    for (const key of ["inputAmountBaseUnits", "minimumOutputBaseUnits", "actualOutputBaseUnits"]) {
        const amount = row[key];
        if (typeof amount !== "string" || amount.length > 40 || !/^(0|[1-9][0-9]*)$/.test(amount)) throw fail();
    }
    if (row.inputAmountBaseUnits === "0" || row.minimumOutputBaseUnits === "0") throw fail();
    if (!Array.isArray(row.fills) || row.fills.length > 1_000) throw fail();
    let fillOutput = 0n;
    for (const raw of row.fills) {
        const fill = obj(raw, ["price", "baseQuantity", "quoteQuantity", "takerFee", "takerFeeIsMyso"]);
        for (const key of ["price", "baseQuantity", "quoteQuantity", "takerFee"]) nonNegativeIntegerValue(fill[key]);
        const baseQuantity = BigInt(String(fill.baseQuantity));
        const quoteQuantity = BigInt(String(fill.quoteQuantity));
        if (baseQuantity === 0n || quoteQuantity === 0n || String(fill.price) === "0") throw fail();
        fillOutput += row.direction === "buy_base" ? baseQuantity : quoteQuantity;
        if (typeof fill.takerFeeIsMyso !== "boolean") throw fail();
    }
    if (fillOutput.toString() !== row.actualOutputBaseUnits) throw fail();
    const verified = row.verified === true;
    if (verified && (row.status !== "finalized" || row.finalized !== true || row.checkpoint === null || (row.fills as unknown[]).length === 0 || fillOutput < BigInt(String(row.minimumOutputBaseUnits)))) throw fail();
    if (row.status === "finalized" && !verified || row.finalized && row.checkpoint === null
        || (row.status === "failed" || row.status === "unknown") && (row.finalized || verified)) throw fail();
    return row;
}

const marketKeys = ["poolId", "poolName", "baseAssetId", "baseSymbol", "baseName", "baseDecimals", "quoteAssetId", "quoteSymbol", "quoteName", "quoteDecimals", "minSizeBaseUnits", "lotSizeBaseUnits", "tickSizeQuoteUnits"] as const;
function market(value: unknown): Record<string, unknown> {
    const row = obj(value, marketKeys);
    address(row.poolId); text(row.poolName, 128); text(row.baseAssetId, 256); text(row.quoteAssetId, 256);
    nullableText(row.baseSymbol, 32); nullableText(row.quoteSymbol, 32); nullableText(row.baseName, 256); nullableText(row.quoteName, 256);
    nullableInteger(row.baseDecimals, 0, 18); nullableInteger(row.quoteDecimals, 0, 18);
    decimal(row.minSizeBaseUnits); decimal(row.lotSizeBaseUnits, true); decimal(row.tickSizeQuoteUnits, true);
    return row;
}
function marketResponseMetadata(row: Record<string, unknown>, network: unknown, source: string, notice: string): void {
    text(network, 32);
    if (row.source !== source || row.notice !== notice) throw fail();
}

export function sanitizeDexMarkets(value: unknown): unknown {
    const row = obj(value, ["network", "markets", "source", "notice"]);
    marketResponseMetadata(row, row.network, "configured Orderbook Indexer /get_pools", "Indexed pool configuration only; this does not prove current pool pause state, liquidity, live tradability, or execution success. Check live pool state before trading.");
    if (!Array.isArray(row.markets) || row.markets.length > 2_000) throw fail();
    const seen = new Set<string>();
    for (const raw of row.markets) {
        const item = market(raw);
        if (seen.has(item.poolName as string)) throw fail();
        seen.add(item.poolName as string);
    }
    return row;
}

export function sanitizeDexMarket(value: unknown, args: Record<string, unknown>): unknown {
    const row = obj(value, ["market", "poolId", "orderbookPackageId", "poolType", "baseAssetType", "quoteAssetType", "poolOwner", "source", "checkedAtMs"]);
    const item = market(row.market);
    if (item.poolName !== args.pool_name || !/^0x[0-9a-f]{64}$/i.test(String(row.poolId)) || !/^0x[0-9a-f]{64}$/i.test(String(row.orderbookPackageId))
        || row.poolOwner !== "shared" || row.source !== "configured Orderbook REST catalog plus configured fullnode live object") throw fail();
    if (address(row.poolId) !== address(item.poolId) || item.baseAssetId !== row.baseAssetType || item.quoteAssetId !== row.quoteAssetType) throw fail();
    text(row.poolType, 1024); text(row.baseAssetType, 512); text(row.quoteAssetType, 512); safeInteger(row.checkedAtMs, 0);
    return row;
}

export function sanitizeDexOrderbook(value: unknown, args: Record<string, unknown>): unknown {
    const row = obj(value, ["network", "market", "bids", "asks", "levelsPerSide", "source", "notice"]);
    marketResponseMetadata(row, row.network, "configured Orderbook /orderbook endpoint", "Current on-chain pool snapshot returned by the Orderbook service; depth may change before execution and does not guarantee a fill or execution success.");
    const item = market(row.market);
    if (item.poolName !== args.pool_name) throw fail();
    const levels = args.levels_per_side ?? 10;
    if (!Number.isSafeInteger(levels) || (levels as number) < 1 || (levels as number) > 20 || row.levelsPerSide !== levels) throw fail();
    for (const sideName of ["bids", "asks"] as const) {
        const side = row[sideName];
        if (!Array.isArray(side) || side.length > (levels as number)) throw fail();
        for (const raw of side) {
            const level = obj(raw, ["price", "size"]);
            decimal(level.price, true); decimal(level.size, true);
        }
    }
    return row;
}
