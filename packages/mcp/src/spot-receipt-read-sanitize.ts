import { McpRuntimeError } from "./errors.js";

const fail = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The Spot receipt reader returned malformed or uncorrelated fullnode evidence.");
type Row = Record<string, unknown>;
function object(value: unknown, keys: readonly string[]): Row {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
    const row = value as Row;
    if (Object.keys(row).length !== keys.length || keys.some((key) => !(key in row))) throw fail();
    return row;
}
function text(value: unknown, max = 512): string { if (typeof value !== "string" || !value.length || value.length > max) throw fail(); return value; }
function address(value: unknown): void { if (typeof value !== "string" || !/^(0x)?[0-9a-f]{1,64}$/i.test(value)) throw fail(); }
function decimal(value: unknown): bigint {
    if (typeof value === "number") { if (!Number.isSafeInteger(value) || value < 0) throw fail(); value = String(value); }
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw fail();
    const n = BigInt(value); if (n > (1n << 64n) - 1n) throw fail(); return n;
}
function hashBytes(value: unknown): void { if (!Array.isArray(value) || value.length !== 32 || value.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) throw fail(); }
function nullableAddress(value: unknown): void { if (value !== null) address(value); }
function claim(value: unknown): Row {
    const row = object(value, ["post_id", "user", "amount"]);
    address(row.post_id); address(row.user); if (decimal(row.amount) === 0n) throw fail();
    return row;
}
function bet(value: unknown): Row {
    const row = object(value, ["post_id", "market_id", "user", "option_id", "amount", "timestamp_ms", "referrer_post_id"]);
    address(row.post_id); address(row.market_id); address(row.user);
    if (decimal(row.option_id) > 255n || decimal(row.amount) === 0n) throw fail();
    decimal(row.timestamp_ms); nullableAddress(row.referrer_post_id);
    return row;
}
function market(value: unknown): Row {
    const row = object(value, ["market_id", "claim_id", "market_key_hash", "primary_post_id", "claim_index", "resolution_policy_hash", "created_at_ms", "betting_options", "resolution_at_ms", "max_resolution_window_ms"]);
    address(row.market_id); address(row.claim_id); hashBytes(row.market_key_hash); address(row.primary_post_id);
    decimal(row.claim_index); hashBytes(row.resolution_policy_hash); decimal(row.created_at_ms);
    if (!Array.isArray(row.betting_options) || row.betting_options.length < 2 || row.betting_options.length > 16 || row.betting_options.some((option) => typeof option !== "string" || option.length < 1 || option.length > 128)) throw fail();
    decimal(row.resolution_at_ms);
    if (row.max_resolution_window_ms !== null) decimal(row.max_resolution_window_ms);
    return row;
}
function claimCreated(value: unknown): Row {
    const row = object(value, ["claim_id", "semantic_claim_hash", "created_at_ms"]);
    address(row.claim_id); hashBytes(row.semantic_claim_hash); decimal(row.created_at_ms);
    return row;
}
function common(value: unknown, args: Record<string, unknown>, action: string, eventField: "claim" | "bet" | "market"): Row {
    const events = eventField === "market" ? ["market", "claim"] : [eventField];
    const row = object(value, ["digest", "registryAction", "status", "checkpoint", ...events, "evidenceSource"]);
    if (row.digest !== args.id || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(row.digest)) || row.registryAction !== action) throw fail();
    if (!["finalized", "checkpoint_pending", "failed", "unknown"].includes(String(row.status))) throw fail();
    if (row.checkpoint !== null) decimal(row.checkpoint);
    if (row.evidenceSource !== "configured_fullnode_and_scoped_preparation") throw fail();
    if (row.status === "finalized" && row.checkpoint === null) throw fail();
    return row;
}

export function sanitizeSpotReceiptRead(name: string, value: unknown, args: Record<string, unknown>): unknown {
    if (name === "spot_get_claim_receipt") {
        const row = common(value, args, "spot.claim_payout.v1", "claim");
        if (row.claim !== null) claim(row.claim);
        if (row.status === "finalized" && row.claim === null) throw fail();
        return row;
    }
    if (name === "spot_get_bet_receipt") {
        const row = common(value, args, "spot.place_bet.v1", "bet");
        if (row.bet !== null) bet(row.bet);
        if (row.status === "finalized" && row.bet === null) throw fail();
        return value;
    }
    if (name === "spot_get_market_receipt") {
        const row = common(value, args, "spot.create_market.v1", "market");
        const checkedMarket = row.market === null ? null : market(row.market);
        const checkedClaim = row.claim === null ? null : claimCreated(row.claim);
        if (checkedMarket && checkedClaim && !sameAddress(checkedMarket.claim_id, checkedClaim.claim_id)) throw fail();
        if (row.status === "finalized" && (!checkedMarket || !checkedClaim)) throw fail();
        return value;
    }
    throw fail();
}
function sameAddress(left: unknown, right: unknown): boolean {
    const normalize = (value: unknown) => {
        address(value);
        return String(value).toLowerCase().replace(/^0x/, "").padStart(64, "0");
    };
    return normalize(left) === normalize(right);
}
