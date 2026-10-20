import { Transaction } from "@socialproof/myso/transactions";

export interface OrgDecryptContext {
    organizationId: string;
    orgMemoryGroupId: string;
}

export interface EncryptedKeyBinding {
    packageId: string;
    services: [string, number][];
    threshold: number;
}

function normalizeId(id: string): string {
    return "0x" + id.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
}

/**
 * Explain why fetched keys cannot open a blob. MyData caches keys under the session key's
 * package and the key server id, and decrypt looks them up under the blob's own package and
 * services, so either mismatch surfaces later as an opaque "Not enough shares".
 */
export function describeKeyMismatch(
    encrypted: EncryptedKeyBinding,
    sessionPackageId: string,
    keyServerIds: string[],
): string | null {
    if (normalizeId(encrypted.packageId) !== normalizeId(sessionPackageId)) {
        return `blob was encrypted for package ${normalizeId(encrypted.packageId)} but the session key is for ${normalizeId(sessionPackageId)}`;
    }
    const configured = new Set(keyServerIds.map(normalizeId));
    const reachable = encrypted.services.filter(([id]) => configured.has(normalizeId(id))).length;
    if (reachable < encrypted.threshold) {
        const blobServers = [...new Set(encrypted.services.map(([id]) => normalizeId(id)))].join(", ");
        return `blob needs ${encrypted.threshold} share(s) from key server(s) ${blobServers}; configured key server(s) ${[...configured].join(", ") || "none"} supply ${reachable}`;
    }
    return null;
}

/** Build against the current memory Move ABI; TxContext is supplied by the VM. */
export function addApproveKeyPolicyCall(
    tx: Transaction,
    packageId: string,
    memoryConfigId: string,
    idBytes: number[],
    accountId: string,
    orgCtx: OrgDecryptContext | null,
): void {
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(memoryConfigId)) {
        throw new Error("MEMORY_CONFIG_ID must identify the shared memory::MemoryConfig object");
    }
    tx.moveCall({
        target: `${packageId}::memory::${orgCtx ? "approve_org_key_policy" : "approve_key_policy"}`,
        // The key id is the FIRST argument, the MyData key-server convention the deployed
        // memory ABI now follows:
        //   approve_key_policy(id, config, account, clock)
        //   approve_org_key_policy(id, config, account, organization, org_memory_group, clock)
        // The key server reads the id from slot 0 and checks config/account/organization as
        // object inputs. Mirrors `buildApproveKeyPolicyTxBytes` /
        // `buildApproveOrgKeyPolicyTxBytes` in `@socialproof/memory/account`.
        arguments: [
            tx.pure("vector<u8>", idBytes),
            tx.object(memoryConfigId),
            tx.object(accountId),
            ...(orgCtx ? [tx.object(orgCtx.organizationId), tx.object(orgCtx.orgMemoryGroupId)] : []),
            tx.object("0x6"),
        ],
    });
}
