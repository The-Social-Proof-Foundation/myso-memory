import { Buffer } from "node:buffer";
import { McpRuntimeError } from "./errors.js";

const fail = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The agent funding reader returned malformed or inconsistent coin data.");
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
function decimal(value: unknown): void {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw fail();
}
function digest(value: unknown): void {
    if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(value)) throw fail();
}

export function sanitizeAgentFundingCoins(name: string, value: unknown, args: Record<string, unknown>): unknown {
    const row = obj(value, ["data", "hasNextPage", "nextCursor", "excludedAddressBalanceReservations", "fundingModel", "agentAddress", "maxActionSpendMist", "evidenceSource", "notice"]);
    if (!Array.isArray(row.data) || row.data.length > 50 || typeof row.hasNextPage !== "boolean" || row.fundingModel !== "owned_coin_objects" || row.evidenceSource !== "configured_fullnode") throw fail();
    address(row.agentAddress);
    const expectedNotice = name === "task_list_agent_funding_coins"
        ? "These are the authenticated agent's own MYSO coin objects. A live registered-action check enforces current on-chain capability, approval policy and per-action spend limit when a bounded task offer is prepared."
        : name === "mydata_list_agent_funding_coins"
            ? "These are the authenticated agent's own MYSO coin objects. A live registered-action check enforces current on-chain capability, approval policy and per-action spend limit when a bounded MyData purchase is prepared."
            : null;
    if (expectedNotice === null || row.notice !== expectedNotice) throw fail();
    if (row.maxActionSpendMist !== null) decimal(row.maxActionSpendMist);
    if (typeof row.excludedAddressBalanceReservations !== "number" || !Number.isSafeInteger(row.excludedAddressBalanceReservations) || row.excludedAddressBalanceReservations < 0 || row.excludedAddressBalanceReservations > 50) throw fail();
    if (row.nextCursor !== null) {
        if (typeof row.nextCursor !== "string" || row.nextCursor.length > 2048) throw fail();
        const bytes = Buffer.from(row.nextCursor, "base64");
        if (bytes.toString("base64") !== row.nextCursor) throw fail();
    }
    if (row.hasNextPage ? row.nextCursor === null || row.data.length === 0 : row.nextCursor !== null) throw fail();
    const seen = new Set<string>();
    for (const item of row.data) {
        const coin = obj(item, ["coinObjectId", "coinType", "balanceBaseUnits", "version", "digest", "previousTransaction"]);
        const id = address(coin.coinObjectId);
        if (seen.has(id)) throw fail();
        seen.add(id);
        if (coin.coinType !== "0x0000000000000000000000000000000000000000000000000000000000000002::myso::MYSO") throw fail();
        decimal(coin.balanceBaseUnits); decimal(coin.version); digest(coin.digest); digest(coin.previousTransaction);
    }
    if (typeof args.limit === "number" && row.data.length > Math.min(50, Math.max(1, args.limit))) throw fail();
    return row;
}
