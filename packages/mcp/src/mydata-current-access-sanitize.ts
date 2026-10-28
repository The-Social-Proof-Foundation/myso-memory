interface MyDataCurrentAccessEvidence {
    authorized: true;
    mydataId: string;
    encryptedDataDigestHex: string;
    objectVersion: string;
    source: "current_key_server_policy";
    callerAddress: string;
    accountId: string;
    agentId: string;
    network: string;
    plaintextReturned: false;
    sharedDerivedKeyCache: false;
    organizationAudienceId?: string;
}

function canonicalId(value: string): string {
    return value.slice(2).toLowerCase().padStart(64, "0");
}

export function sanitizeMyDataCurrentAccess(value: unknown, args: Record<string, unknown>, principal?: { accountId: string; agentId: string; callerAddress?: string }): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MyData current-access evidence is malformed");
    const raw = value as Record<string, unknown>;
    const allowed = new Set(["authorized", "mydataId", "encryptedDataDigestHex", "objectVersion", "source", "callerAddress", "accountId", "agentId", "network", "plaintextReturned", "sharedDerivedKeyCache", "organizationAudienceId"]);
    if (Object.keys(raw).some(key => !allowed.has(key)) || raw.authorized !== true || typeof raw.mydataId !== "string"
        || !/^0x[0-9a-fA-F]{1,64}$/.test(raw.mydataId) || typeof raw.encryptedDataDigestHex !== "string" || !/^[0-9a-f]{64}$/.test(raw.encryptedDataDigestHex)
        || typeof raw.objectVersion !== "string" || !/^(0|[1-9][0-9]*)$/.test(raw.objectVersion) || raw.objectVersion.length > 20 || BigInt(raw.objectVersion) > 18_446_744_073_709_551_615n
        || raw.source !== "current_key_server_policy" || typeof raw.callerAddress !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(raw.callerAddress)
        || typeof raw.accountId !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(raw.accountId)
        || typeof raw.agentId !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(raw.agentId)
        || typeof raw.network !== "string" || raw.network.length < 1 || raw.network.length > 32
        || raw.plaintextReturned !== false || raw.sharedDerivedKeyCache !== false
        || (raw.organizationAudienceId !== undefined && (typeof raw.organizationAudienceId !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(raw.organizationAudienceId)))) {
        throw new Error("MyData current-access evidence is malformed");
    }
    const result = raw as unknown as MyDataCurrentAccessEvidence;
    const request = args.request;
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("MyData access check request is missing");
    const input = request as Record<string, unknown>;
    if (typeof input.mydataId !== "string" || typeof input.encryptedDataDigestHex !== "string"
        || canonicalId(result.mydataId) !== canonicalId(input.mydataId)
        || result.encryptedDataDigestHex !== input.encryptedDataDigestHex
        || (input.organizationAudienceId === undefined) !== (result.organizationAudienceId === undefined)
        || (typeof input.organizationAudienceId === "string" && result.organizationAudienceId !== undefined
            && canonicalId(input.organizationAudienceId) !== canonicalId(result.organizationAudienceId))) {
        throw new Error("MyData current-access evidence does not match the requested listing and audience");
    }
    if (principal && (canonicalId(result.accountId) !== canonicalId(principal.accountId)
        || canonicalId(result.agentId) !== canonicalId(principal.agentId)
        || (principal.callerAddress !== undefined && canonicalId(result.callerAddress) !== canonicalId(principal.callerAddress)))) {
        throw new Error("MyData current-access evidence does not match the authenticated principal");
    }
    return result;
}
