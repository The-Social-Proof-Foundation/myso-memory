import { McpRuntimeError } from "./errors.js";

type Row = Record<string, unknown>;
const fail = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The indexed system configuration has an invalid schema or numeric value.");
function exact(value: unknown, keys: readonly string[]): Row {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
    const row = value as Row;
    if (Object.keys(row).length !== keys.length || keys.some((key) => !(key in row))) throw fail();
    return row;
}
function address(value: unknown): void { if (typeof value !== "string" || !/^(0x)?[0-9a-f]{1,64}$/i.test(value)) throw fail(); }
function int64(value: unknown): void {
    let parsed: bigint;
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) throw fail();
        parsed = BigInt(value);
    } else if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) parsed = BigInt(value);
    else throw fail();
    if (parsed > (1n << 63n) - 1n) throw fail();
}
function i16(value: unknown): void { if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 32767) throw fail(); }

export function sanitizeConfigRead(name: string, value: unknown): unknown {
    const fields: Record<string, readonly string[]> = {
        config_profile: ["updatedBy", "maxVestingPieces", "curveFactorMin", "curveFactorMax", "curvePrecision", "minClaimThresholdDivisor", "minUsernameLength", "maxUsernameLength", "usernameSaleFeeBps", "version", "updatedAt"],
        config_platform: ["updatedBy", "maxReasoningLength", "maxCoverPhotoUrlLength", "maxMediaPreviews", "maxBadgeNameLength", "maxBadgeDescriptionLength", "version", "updatedAt"],
        config_memory: ["updatedBy", "maxOrganizationsPerUser", "orgCategoryUpdateCooldownMs", "maxAgentDepth", "maxLabelLength", "maxOrgNameLength", "maxOrgDescriptionLength", "version", "updatedAt"],
        config_ai_credit: ["id", "updated_by", "oracle_pubkey_hex", "treasury_address", "min_deposit_mist", "max_single_settlement_mist", "receipt_ttl_ms", "oracle_markup_bps", "catalog_version", "version", "updated_at", "transaction_id", "time"],
    };
    const keys = fields[name];
    if (!keys) throw fail();
    const row = exact(value, keys);
    if (name === "config_ai_credit") {
        if (typeof row.id !== "number" || !Number.isInteger(row.id) || row.id < 0 || row.id > 2_147_483_647) throw fail();
        address(row.updated_by); address(row.treasury_address);
        if (typeof row.oracle_pubkey_hex !== "string" || !/^(?:[0-9a-f]{2}){1,64}$/i.test(row.oracle_pubkey_hex)) throw fail();
        for (const field of ["min_deposit_mist", "max_single_settlement_mist", "receipt_ttl_ms", "oracle_markup_bps", "version", "updated_at"]) int64(row[field]);
        if (row.catalog_version !== null && (typeof row.catalog_version !== "string" || row.catalog_version.length > 128)) throw fail();
        if (typeof row.transaction_id !== "string" || row.transaction_id.length < 1 || row.transaction_id.length > 128 || typeof row.time !== "string" || !Number.isFinite(Date.parse(row.time))) throw fail();
        return row;
    }
    address(row.updatedBy);
    const narrow = name === "config_memory" ? ["maxOrganizationsPerUser", "maxAgentDepth"] : [];
    for (const key of keys.slice(1)) narrow.includes(key) ? i16(row[key]) : int64(row[key]);
    if (name === "config_profile" && BigInt(String(row.curveFactorMin)) > BigInt(String(row.curveFactorMax))) throw fail();
    if (name === "config_profile" && BigInt(String(row.minUsernameLength)) > BigInt(String(row.maxUsernameLength))) throw fail();
    return row;
}
