import { McpRuntimeError } from "./errors.js";

export interface AgentAdminReadIdentity { accountId: string }

function readObject(value: unknown, label: string, fields: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned an invalid object.`);
    const object = value as Record<string, unknown>;
    if (Object.keys(object).length !== fields.length || fields.some((field) => !(field in object))) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned an unexpected field set.`);
    return object;
}
function readAddress(value: unknown, label: string): string {
    if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned an invalid address.`);
    return value;
}
function readU64(value: unknown, label: string): string {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > 18_446_744_073_709_551_615n) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned an invalid decimal u64.`);
    return value;
}
function readDigest(value: unknown, label: string): string {
    if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned an invalid transaction digest.`);
    return value;
}
function normalizeHostedId(value: string): string { return value.toLowerCase().replace(/^0x/, "").padStart(64, "0"); }

export function sanitizeAgentAdminRead(name: string, args: Record<string, unknown>, value: unknown, identity: AgentAdminReadIdentity): unknown {
    if (!["agent_admin_list", "agent_admin_get_quote", "agent_admin_get_receipt"].includes(name)) return value;
    const label = name.replaceAll("_", " ");
    const invalid = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned malformed or inconsistent agent authority evidence.`);
    const identityAccountId = normalizeHostedId(readAddress(identity.accountId, label));
    const limit = (input: unknown): void => {
        if (input !== "unlimited") readU64(input, label);
    };
    const agent = (input: unknown, quote: boolean): Record<string, unknown> => {
        const baseFields = ["agentObjectId", "expectedDerivedAddress", "expectedPlatformScope", "expectedCapabilities", "expectedLimitMist", "delegatableCaps", "approvalRequiredCaps", "organizationId", "active", "parentObjectId", "expiresAtMs", "createdAtMs", "identityClass", "roleTags", "registerScope", "depth", "objectVersion", "labelPreview", "effectiveAuthority"];
        const metadata = readObject(input, label, baseFields);
        for (const key of ["agentObjectId", "expectedDerivedAddress", "organizationId"] as const) readAddress(metadata[key], label);
        if (metadata.expectedPlatformScope !== null) readAddress(metadata.expectedPlatformScope, label);
        for (const key of ["expectedCapabilities", "delegatableCaps", "approvalRequiredCaps", "createdAtMs", "identityClass", "roleTags", "registerScope", "depth", "objectVersion"] as const) readU64(metadata[key], label);
        limit(metadata.expectedLimitMist);
        if (typeof metadata.active !== "boolean" || !(metadata.parentObjectId === null || typeof metadata.parentObjectId === "string") || !(metadata.expiresAtMs === null || typeof metadata.expiresAtMs === "string")) throw invalid();
        if (metadata.parentObjectId !== null) readAddress(metadata.parentObjectId, label);
        if (metadata.expiresAtMs !== null) readU64(metadata.expiresAtMs, label);
        const preview = readObject(metadata.labelPreview, label, ["text", "truncated", "source"]);
        if (typeof preview.text !== "string" || Array.from(preview.text).length > 256 || typeof preview.truncated !== "boolean" || preview.source !== "on_chain_label_untrusted") throw invalid();
        if (!quote) {
            if (metadata.effectiveAuthority !== "not_computed") throw invalid();
            return metadata;
        }
        const authority = readObject(metadata.effectiveAuthority, label, ["computed", "activeNow", "accountActive", "currentTimeMs", "effectiveExecutionCapabilitiesMask", "effectivePerActionSpendLimitMist", "limitSemantics", "activeChain", "evidenceSource", "executionRechecksAuthority"]);
        if (authority.computed !== true || typeof authority.activeNow !== "boolean" || typeof authority.accountActive !== "boolean" || typeof authority.activeChain !== "object" || !Array.isArray(authority.activeChain) || !authority.activeChain.length || authority.limitSemantics !== "per_action_not_cumulative" || authority.evidenceSource !== "configured_fullnode_live_object_snapshot" || authority.executionRechecksAuthority !== true) throw invalid();
        readU64(authority.currentTimeMs, label); readU64(authority.effectiveExecutionCapabilitiesMask, label); limit(authority.effectivePerActionSpendLimitMist);
        if (authority.activeNow !== (authority.accountActive && authority.activeChain.every((raw) => {
            const row = readObject(raw, label, ["agentObjectId", "parentObjectId", "active", "expired", "expiresAtMs", "depth"]);
            readAddress(row.agentObjectId, label); readU64(row.depth, label);
            if (row.parentObjectId !== null) readAddress(row.parentObjectId, label);
            if (row.expiresAtMs !== null) readU64(row.expiresAtMs, label);
            if (typeof row.active !== "boolean" || typeof row.expired !== "boolean") throw invalid();
            return row.active && !row.expired;
        }))) throw invalid();
        const expectedCapabilities = metadata.active && authority.activeNow ? String(metadata.expectedCapabilities) : "0";
        const expectedLimit = metadata.active && authority.activeNow ? String(metadata.expectedLimitMist) : "0";
        if (authority.effectiveExecutionCapabilitiesMask !== expectedCapabilities || authority.effectivePerActionSpendLimitMist !== expectedLimit || metadata.effectiveAuthority === "not_computed") throw invalid();
        return metadata;
    };
    if (name === "agent_admin_list") {
        const row = readObject(value, label, ["accountId", "data", "hasNextPage", "nextCursor", "evidenceSource", "effectiveAuthority"]);
        if (normalizeHostedId(readAddress(row.accountId, label)) !== identityAccountId || !Array.isArray(row.data) || typeof row.hasNextPage !== "boolean" || !(row.nextCursor === null || typeof row.nextCursor === "string") || row.evidenceSource !== "configured_fullnode" || row.effectiveAuthority !== "not_computed") throw invalid();
        const limitCount = typeof args.limit === "number" ? args.limit : 20;
        if (row.data.length > limitCount || (row.hasNextPage && (!row.nextCursor || normalizeHostedId(String(row.nextCursor)) === normalizeHostedId(String(args.cursor ?? "")))) || (!row.hasNextPage && row.nextCursor !== null)) throw invalid();
        if (row.nextCursor !== null) readAddress(row.nextCursor, label);
        const seen = new Set<string>();
        for (const item of row.data) {
            const metadata = agent(item, false);
            const agentId = normalizeHostedId(String(metadata.agentObjectId));
            if (seen.has(agentId)) throw invalid();
            seen.add(agentId);
        }
        return row;
    }
    if (name === "agent_admin_get_quote") {
        const row = readObject(value, label, ["accountId", "agent", "supportedGrantMask", "writesEnabled", "authority", "evidenceSource"]);
        const details = agent(row.agent, true);
        if (normalizeHostedId(readAddress(row.accountId, label)) !== identityAccountId || normalizeHostedId(readAddress(details.agentObjectId, label)) !== normalizeHostedId(String(args.id)) || row.authority !== "owner_wallet" || row.evidenceSource !== "configured_fullnode" || typeof row.writesEnabled !== "boolean") throw invalid();
        readU64(row.supportedGrantMask, label);
        const chain = (details.effectiveAuthority as Record<string, unknown>).activeChain as unknown[];
        if (normalizeHostedId(String(chain[0] && (chain[0] as Record<string, unknown>).agentObjectId)) !== normalizeHostedId(String(args.id))) throw invalid();
        return row;
    }
    const row = readObject(value, label, ["digest", "registryAction", "accountId", "agentId", "status", "checkpoint", "evidence", "preparedContext", "evidenceSource", "currentEffectiveAuthority"]);
    const actions = ["agent.revoke_agent.v1", "agent.grant_capability.v1", "agent.revoke_capability.v1", "agent.raise_spending_limit.v1", "agent.lower_spending_limit.v1"];
    if (row.digest !== args.id || normalizeHostedId(readAddress(row.accountId, label)) !== identityAccountId || !actions.includes(String(row.registryAction)) || !["finalized", "executed", "failed", "unknown"].includes(String(row.status)) || !(row.checkpoint === null || typeof row.checkpoint === "string") || !Array.isArray(row.evidence) || row.evidence.length > 1 || ((row.status === "finalized" || row.status === "executed") !== (row.evidence.length === 1)) || row.evidenceSource !== "configured_fullnode_and_scoped_preparation" || row.currentEffectiveAuthority !== "not_computed") throw invalid();
    readDigest(row.digest, label); readAddress(row.accountId, label); readAddress(row.agentId, label);
    if (row.checkpoint !== null) readU64(row.checkpoint, label);
    const context = row.preparedContext;
    if (!context || typeof context !== "object" || Array.isArray(context)) throw invalid();
    const contextRow = context as Record<string, unknown>;
    const contextFields: Record<string, string[]> = {
        "agent.revoke_agent.v1": ["agentObjectId", "expectedDerivedAddress", "expectedPlatformScope", "accountId", "approvingOwner", "expectedSigner", "executionPlatformId"],
        "agent.grant_capability.v1": ["agentObjectId", "expectedDerivedAddress", "expectedPlatformScope", "expectedCapabilities", "capabilityMask", "accountId", "approvingOwner", "expectedSigner", "executionPlatformId"],
        "agent.revoke_capability.v1": ["agentObjectId", "expectedDerivedAddress", "expectedPlatformScope", "expectedCapabilities", "capabilityMask", "accountId", "approvingOwner", "expectedSigner", "executionPlatformId"],
        "agent.raise_spending_limit.v1": ["agentObjectId", "expectedDerivedAddress", "expectedPlatformScope", "expectedLimitMist", "newLimitMist", "accountId", "approvingOwner", "expectedSigner", "executionPlatformId"],
        "agent.lower_spending_limit.v1": ["agentObjectId", "expectedDerivedAddress", "expectedPlatformScope", "expectedLimitMist", "newLimitMist", "accountId", "approvingOwner", "expectedSigner", "executionPlatformId"],
    };
    const expectedContext = contextFields[String(row.registryAction)];
    if (!expectedContext || Object.keys(contextRow).length !== expectedContext.length || expectedContext.some((key) => !(key in contextRow))) throw invalid();
    for (const key of ["accountId", "approvingOwner", "expectedSigner", "executionPlatformId", "agentObjectId", "expectedDerivedAddress", "expectedPlatformScope"] as const) if (contextRow[key] !== null) readAddress(contextRow[key], label);
    if (normalizeHostedId(String(contextRow.accountId)) !== normalizeHostedId(String(row.accountId)) || normalizeHostedId(String(contextRow.agentObjectId)) !== normalizeHostedId(String(row.agentId))) throw invalid();
    if (contextRow.expectedPlatformScope !== null && !["agent.grant_capability.v1", "agent.revoke_capability.v1", "agent.raise_spending_limit.v1", "agent.lower_spending_limit.v1", "agent.revoke_agent.v1"].includes(String(row.registryAction))) throw invalid();
    for (const key of ["expectedCapabilities", "capabilityMask"] as const) if (contextRow[key] !== undefined) readU64(contextRow[key], label);
    for (const key of ["expectedLimitMist", "newLimitMist"] as const) if (contextRow[key] !== undefined) limit(contextRow[key]);
    if (row.evidence.length === 1) {
        const evidence = row.evidence[0] && typeof row.evidence[0] === "object" && !Array.isArray(row.evidence[0]) ? row.evidence[0] as Record<string, unknown> : null;
        if (!evidence || evidence.agentObjectId !== contextRow.agentObjectId || evidence.derivedAddress !== contextRow.expectedDerivedAddress || typeof evidence.proof !== "string") throw invalid();
        if (row.registryAction === "agent.revoke_agent.v1") {
            readObject(evidence, label, ["agentObjectId", "derivedAddress", "proof", "futureCredentialAccess"]);
            if (evidence.proof !== "native_revocation_event_and_object_deletion_with_scoped_preparation" || evidence.futureCredentialAccess !== "revoked") throw invalid();
        } else {
            readObject(evidence, label, ["agentObjectId", "derivedAddress", "changeKind", "previousCapabilities", "nextCapabilities", "capabilityMask", "delegatableCaps", "previousLimitMist", "nextLimitMist", "platformScope", "timestampMs", "proof"]);
            for (const key of ["changeKind", "previousCapabilities", "nextCapabilities", "capabilityMask", "delegatableCaps", "timestampMs"] as const) readU64(evidence[key], label);
            limit(evidence.previousLimitMist); limit(evidence.nextLimitMist);
            if (evidence.platformScope !== null) readAddress(evidence.platformScope, label);
            if (evidence.proof !== "native_owner_policy_delta") throw invalid();
            const actionKind: Record<string, string> = { "agent.grant_capability.v1": "1", "agent.revoke_capability.v1": "2", "agent.raise_spending_limit.v1": "3", "agent.lower_spending_limit.v1": "4" };
            if (evidence.changeKind !== actionKind[String(row.registryAction)] || evidence.platformScope !== contextRow.expectedPlatformScope) throw invalid();
            if (row.registryAction === "agent.grant_capability.v1" || row.registryAction === "agent.revoke_capability.v1") {
                const before = BigInt(String(contextRow.expectedCapabilities));
                const mask = BigInt(String(contextRow.capabilityMask));
                const after = row.registryAction === "agent.grant_capability.v1" ? before | mask : before ^ (before & mask);
                if (evidence.previousCapabilities !== String(before) || evidence.capabilityMask !== String(mask) || evidence.nextCapabilities !== String(after) || evidence.previousLimitMist !== evidence.nextLimitMist) throw invalid();
            } else if (evidence.previousLimitMist !== contextRow.expectedLimitMist || evidence.nextLimitMist !== contextRow.newLimitMist || evidence.previousCapabilities !== evidence.nextCapabilities || evidence.capabilityMask !== "0") throw invalid();
        }
    }
    return row;
}
