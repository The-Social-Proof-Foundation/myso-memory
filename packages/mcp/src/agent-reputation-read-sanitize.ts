import { McpRuntimeError } from "./errors.js";

const fail = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The agent reputation reader returned malformed or inconsistent indexed data.");
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
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw fail();
    return value;
}
function decimal(value: unknown): void { if (typeof value !== "string" || value.length > 40 || !/^(0|[1-9][0-9]*)$/.test(value)) throw fail(); }

function score(value: unknown): Record<string, unknown> {
    const row = obj(value, ["reviewCount", "histogram", "scoreMilli", "score", "confidenceBps", "lastReceiptId", "updatedAtMs"]);
    const reviewCount = integer(row.reviewCount);
    if (!Array.isArray(row.histogram) || row.histogram.length !== 5) throw fail();
    let histogramCount = 0;
    for (const count of row.histogram) histogramCount += integer(count);
    if (histogramCount !== reviewCount) throw fail();
    integer(row.scoreMilli, 0, 5000); integer(row.confidenceBps, 0, 10_000);
    if (typeof row.score !== "number" || !Number.isFinite(row.score) || row.score < 0 || row.score > 5) throw fail();
    if (row.lastReceiptId !== null && (typeof row.lastReceiptId !== "string" || row.lastReceiptId.length > 128)) throw fail();
    if (row.updatedAtMs !== null) integer(row.updatedAtMs);
    return row;
}

export function sanitizeAgentReputation(value: unknown, expectedAgentId: string): unknown {
    const row = obj(value, ["agentObjectId", "asSeller", "asBuyer", "overall", "credibility"]);
    if (!sameAddress(row.agentObjectId, expectedAgentId)) throw fail();
    score(row.asSeller); score(row.asBuyer);
    const overall = obj(row.overall, ["scoreMilli", "score", "confidenceBps"]);
    integer(overall.scoreMilli, 0, 5000); integer(overall.confidenceBps, 0, 10_000);
    if (typeof overall.score !== "number" || !Number.isFinite(overall.score) || overall.score < 0 || overall.score > 5) throw fail();
    if (row.credibility !== null) {
        const credibility = obj(row.credibility, ["accountId", "settledCount", "volumeMist", "credibilityBps"]);
        address(credibility.accountId); integer(credibility.settledCount); decimal(credibility.volumeMist); integer(credibility.credibilityBps, 0, 10_000);
    }
    return row;
}
