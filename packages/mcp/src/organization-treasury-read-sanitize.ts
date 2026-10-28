import { McpRuntimeError } from "./errors.js";

const fail = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The organization treasury reader returned malformed or inconsistent fullnode evidence.");
function row(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
    const result = value as Record<string, unknown>;
    if (Object.keys(result).length !== keys.length || keys.some((key) => !(key in result))) throw fail();
    return result;
}
function address(value: unknown): string {
    if (typeof value !== "string" || !/^(0x)?[0-9a-f]{1,64}$/i.test(value)) throw fail();
    return value.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
}
function sameAddress(left: unknown, right: unknown): boolean { return address(left) === address(right); }
function coinType(value: unknown): void {
    if (typeof value !== "string" || value.length > 512 || !value.includes("::") || /[\s\u0000-\u001f]/.test(value)) throw fail();
}

export function sanitizeOrganizationTreasuryRead(name: string, value: unknown, args: Record<string, unknown>): unknown {
    if (name === "organization_get_treasury_balance") {
        const result = row(value, ["organizationId", "coinType", "balanceBaseUnits", "evidenceSource"]);
        if (!sameAddress(result.organizationId, args.id) || result.evidenceSource !== "configured_fullnode_live_dynamic_field") throw fail();
        coinType(result.coinType);
        if (result.coinType !== args.coinType || typeof result.balanceBaseUnits !== "string" || !/^(0|[1-9][0-9]*)$/.test(result.balanceBaseUnits)) throw fail();
        return result;
    }
    if (name === "organization_get_treasury_access") {
        const result = row(value, ["organizationId", "recipient", "hasTreasuryAccess", "evidenceSource"]);
        if (!sameAddress(result.organizationId, args.id) || !sameAddress(result.recipient, args.recipient) || typeof result.hasTreasuryAccess !== "boolean" || result.evidenceSource !== "configured_fullnode_live_dynamic_field") throw fail();
        return result;
    }
    throw fail();
}
