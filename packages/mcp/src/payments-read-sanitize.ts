import { McpRuntimeError } from "./errors.js";

export interface PaymentReadIdentity {
    accountId?: string;
    agentObjectId?: string;
    owner?: string;
}

function invalid(label: string): McpRuntimeError {
    return new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned malformed or inconsistent payment evidence.`);
}
function object(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(label);
    const row = value as Record<string, unknown>;
    if (Object.keys(row).length !== keys.length || keys.some((key) => !(key in row))) throw invalid(label);
    return row;
}
function address(value: unknown, label: string): string {
    if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value)) throw invalid(label);
    return value;
}
function sameId(left: unknown, right: unknown, label: string): boolean {
    const normalize = (value: unknown) => address(value, label).toLowerCase().replace(/^0x/, "").padStart(64, "0");
    return normalize(left) === normalize(right);
}
function u64(value: unknown, label: string): string {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > 18_446_744_073_709_551_615n) throw invalid(label);
    return value;
}
function coinType(value: unknown, label: string): string {
    if (typeof value !== "string" || value.length < 1 || value.length > 512 || value !== value.trim()) throw invalid(label);
    return value;
}
function sameCoinType(left: string, right: string): boolean {
    return left.replace(/\s+/g, "") === right.replace(/\s+/g, "");
}
function digest(value: unknown, label: string): string {
    if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) throw invalid(label);
    return value;
}
function owner(row: Record<string, unknown>, identity: PaymentReadIdentity, label: string): void {
    const actual = address(row.approvingOwner, label);
    if (identity.owner && !sameId(actual, identity.owner, label)) throw invalid(label);
}

/** Verify payment reads identically at the local and hosted MCP boundary. */
export function sanitizePaymentRead(name: string, args: Record<string, unknown>, value: unknown, identity: PaymentReadIdentity = {}): unknown {
    if (!["payments_get_balance", "payments_list_coins", "payments_get_transfer_quote", "payments_get_transfer_receipt"].includes(name)) return value;
    const label = name.replaceAll("_", " ");
    if (name === "payments_get_balance") {
        const row = object(value, label, ["approvingOwner", "coinType", "totalBalanceBaseUnits", "fundsInAddressBalanceBaseUnits", "coinObjectCount", "transferFundingModel", "evidenceSource"]);
        owner(row, identity, label);
        if (!sameCoinType(coinType(row.coinType, label), String(args.coinType)) || row.transferFundingModel !== "owned_coin_objects" || row.evidenceSource !== "configured_fullnode") throw invalid(label);
        const total = BigInt(u64(row.totalBalanceBaseUnits, label));
        const addressBalance = BigInt(u64(row.fundsInAddressBalanceBaseUnits, label));
        if (addressBalance > total) throw invalid(label);
        u64(row.coinObjectCount, label);
        return row;
    }
    if (name === "payments_list_coins") {
        const row = object(value, label, ["data", "hasNextPage", "nextCursor", "excludedAddressBalanceReservations", "fundingModel", "approvingOwner", "evidenceSource"]);
        owner(row, identity, label);
        if (!Array.isArray(row.data) || typeof row.hasNextPage !== "boolean" || !(row.nextCursor === null || typeof row.nextCursor === "string" && row.nextCursor.length >= 1 && row.nextCursor.length <= 2048)
            || !Number.isSafeInteger(row.excludedAddressBalanceReservations) || (row.excludedAddressBalanceReservations as number) < 0
            || row.fundingModel !== "owned_coin_objects" || row.evidenceSource !== "configured_fullnode") throw invalid(label);
        const limit = typeof args.limit === "number" ? args.limit : 20;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || row.data.length > limit
            || (row.excludedAddressBalanceReservations as number) > limit
            || (row.hasNextPage && (!row.data.length || !row.nextCursor)) || (!row.hasNextPage && row.nextCursor !== null)) throw invalid(label);
        const ids = new Set<string>();
        for (const item of row.data) {
            const coin = object(item, label, ["coinObjectId", "coinType", "balanceBaseUnits", "version", "digest", "previousTransaction"]);
            const objectId = address(coin.coinObjectId, label);
            if (!sameCoinType(coinType(coin.coinType, label), String(args.coinType))) throw invalid(label);
            const normalized = objectId.toLowerCase();
            if (ids.has(normalized)) throw invalid(label);
            ids.add(normalized);
            u64(coin.balanceBaseUnits, label); u64(coin.version, label); digest(coin.digest, label); digest(coin.previousTransaction, label);
        }
        return row;
    }
    if (name === "payments_get_transfer_quote") {
        const row = object(value, label, ["transferParameters", "fundingCoin", "approvingOwner", "evidenceSource", "writesEnabled", "fundingModel", "approval", "quoteLocksFunds"]);
        owner(row, identity, label);
        const params = object(row.transferParameters, label, ["paymentCoinId", "recipient", "coinType", "amountBaseUnits"]);
        const coin = object(row.fundingCoin, label, ["coinObjectId", "coinType", "balanceBaseUnits", "version"]);
        const paymentId = address(params.paymentCoinId, label);
        const coinId = address(coin.coinObjectId, label);
        if (!sameId(paymentId, args.id, label) || !sameId(paymentId, coinId, label)
            || !sameId(params.recipient, args.recipient, label) || !sameCoinType(coinType(params.coinType, label), String(args.coinType))
            || !sameCoinType(coinType(coin.coinType, label), String(args.coinType)) || u64(params.amountBaseUnits, label) !== args.amountBaseUnits
            || row.evidenceSource !== "configured_fullnode" || row.fundingModel !== "owned_coin_objects"
            || row.approval !== "owner_wallet" || row.quoteLocksFunds !== false || typeof row.writesEnabled !== "boolean") throw invalid(label);
        if (BigInt(u64(coin.balanceBaseUnits, label)) < BigInt(u64(params.amountBaseUnits, label))) throw invalid(label);
        u64(coin.version, label);
        return row;
    }
    const row = object(value, label, ["digest", "registryAction", "accountId", "agentId", "status", "checkpoint", "transfer", "preparedContext", "evidenceSource"]);
    if (digest(row.digest, label) !== args.id || row.registryAction !== "payments.send_token.v1"
        || identity.accountId && row.accountId !== identity.accountId
        || identity.agentObjectId && !sameId(row.agentId, identity.agentObjectId, label)
        || !["finalized", "executed", "failed", "unknown"].includes(String(row.status))
        || !(row.checkpoint === null || typeof row.checkpoint === "string")
        || row.evidenceSource !== "configured_fullnode_and_scoped_preparation") throw invalid(label);
    if (row.status === "finalized" || row.status === "executed") {
        const transfer = object(row.transfer, label, ["coinObjectId", "version", "objectDigest", "recipient", "coinType", "amountBaseUnits", "proof", "currentOwnership"]);
        address(transfer.coinObjectId, label); u64(transfer.version, label); digest(transfer.objectDigest, label); address(transfer.recipient, label);
        coinType(transfer.coinType, label); u64(transfer.amountBaseUnits, label);
        if (transfer.proof !== "created_coin_at_effect_version" || transfer.currentOwnership !== "not_checked") throw invalid(label);
    } else if (row.transfer !== null) throw invalid(label);
    const context = object(row.preparedContext, label, ["paymentCoinId", "recipient", "coinType", "amountBaseUnits", "approvingOwner", "executionPlatformId"]);
    address(context.paymentCoinId, label); address(context.recipient, label); coinType(context.coinType, label); u64(context.amountBaseUnits, label);
    address(context.approvingOwner, label); address(context.executionPlatformId, label);
    return row;
}
