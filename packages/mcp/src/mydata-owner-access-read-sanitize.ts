import { McpRuntimeError } from "./errors.js";

const fail = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The MyData access reader returned malformed or inconsistent scoped evidence.");
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
function decimal(value: unknown): void { if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw fail(); }
function digest(value: unknown): void { if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(value)) throw fail(); }
function boundedText(value: unknown, max: number): void { if (typeof value !== "string" || value.length < 1 || value.length > max) throw fail(); }

export interface MyDataReadIdentity {
    accountId: string;
    agentObjectId: string;
    ownerAddress: string;
    agentAddress: string;
}

export function sanitizeMyDataOwnerAccessReceipt(value: unknown, args: Record<string, unknown>, identity: MyDataReadIdentity): unknown {
    const row = obj(value, ["digest", "registryAction", "accountId", "agentId", "status", "checkpoint", "events", "evidenceSource", "currentAccess", "previouslyDisclosedDataErased"]);
    digest(row.digest);
    if (row.digest !== args.id || !["access.share_mydata.v1", "access.revoke_mydata_share.v1"].includes(String(row.registryAction))
        || !sameAddress(row.accountId, identity.accountId) || !sameAddress(row.agentId, identity.agentObjectId)
        || !["finalized", "executed", "failed", "unknown"].includes(String(row.status))
        || row.checkpoint !== null && (typeof row.checkpoint !== "string" || !/^(0|[1-9][0-9]*)$/.test(row.checkpoint))
        || !Array.isArray(row.events) || row.events.length > 16
        || row.evidenceSource !== "configured_fullnode" || row.currentAccess !== "not_checked" || row.previouslyDisclosedDataErased !== false) throw fail();
    const expectedKind = row.registryAction === "access.share_mydata.v1" ? "AccessGrantedEvent" : "AccessRevokedEvent";
    if (["finalized", "executed"].includes(String(row.status)) !== (row.events.length > 0)) throw fail();
    for (const raw of row.events) {
        const event = obj(raw, ["kind", "mydataId", "recipient", "owner", "accessType", "timestampMs"]);
        if (event.kind !== expectedKind) throw fail();
        address(event.mydataId); address(event.recipient); address(event.owner);
        if (!sameAddress(event.owner, identity.ownerAddress) && !sameAddress(event.owner, identity.agentAddress)) throw fail();
        if (!["one_time", "subscription", "all"].includes(String(event.accessType)) || expectedKind === "AccessGrantedEvent" && event.accessType === "all") throw fail();
        decimal(event.timestampMs);
    }
    return row;
}

export function sanitizeMyDataOwnerAccessHistory(value: unknown, args: Record<string, unknown>, identity: MyDataReadIdentity): unknown {
    const row = obj(value, ["accountId", "agentId", "ownerAddress", "agentAddress", "entries", "limit", "offset", "hasMore", "evidenceSource", "notice"]);
    if (!sameAddress(row.accountId, identity.accountId) || !sameAddress(row.agentId, identity.agentObjectId)
        || !Array.isArray(row.entries) || row.entries.length > 50
        || !Number.isSafeInteger(row.limit) || (row.limit as number) < 1 || (row.limit as number) > 50
        || !Number.isSafeInteger(row.offset) || (row.offset as number) < 0 || (row.offset as number) > 100_000
        || row.limit !== (args.limit ?? 50) || row.offset !== (args.offset ?? 0)
        || typeof row.hasMore !== "boolean" || row.evidenceSource !== "authenticated_action_journal_and_configured_fullnode") throw fail();
    if (!sameAddress(row.ownerAddress, identity.ownerAddress) || !sameAddress(row.agentAddress, identity.agentAddress)) throw fail();
    boundedText(row.notice, 1024);
    const seen = new Set<string>();
    for (const raw of row.entries) {
        const entry = obj(raw, ["registryAction", "actionStatus", "digest", "createdAt", "chainReceipt"]);
        if (!["access.share_mydata.v1", "access.revoke_mydata_share.v1"].includes(String(entry.registryAction))) throw fail();
        boundedText(entry.actionStatus, 64);
        if (entry.digest !== null) digest(entry.digest);
        boundedText(entry.createdAt, 128);
        if (entry.digest !== null) {
            if (seen.has(entry.digest as string)) throw fail();
            seen.add(entry.digest as string);
        }
        if (entry.chainReceipt === null) {
            if (entry.digest !== null) throw fail();
        } else {
            if (entry.digest === null) throw fail();
            sanitizeMyDataOwnerAccessReceipt(entry.chainReceipt, { id: entry.digest }, identity);
            const receipt = entry.chainReceipt as Record<string, unknown>;
            if (receipt.registryAction !== entry.registryAction) throw fail();
        }
    }
    return row;
}
