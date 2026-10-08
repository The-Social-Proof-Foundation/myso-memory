import { Transaction } from "@socialproof/myso/transactions";

export interface OrgDecryptContext {
    organizationId: string;
    orgMemoryGroupId: string;
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
        // Argument order is the deployed memory ABI, not the mydata_approve convention:
        //   approve_key_policy(config, id, account, clock)
        //   approve_org_key_policy(config, id, account, organization, org_memory_group, clock)
        // The key server reads the encryption id from slot 1 for these two hooks, so the
        // config MUST stay first. Mirrors `buildApproveKeyPolicyTxBytes` /
        // `buildApproveOrgKeyPolicyTxBytes` in `@socialproof/memory/account`.
        arguments: [
            tx.object(memoryConfigId),
            tx.pure("vector<u8>", idBytes),
            tx.object(accountId),
            ...(orgCtx ? [tx.object(orgCtx.organizationId), tx.object(orgCtx.orgMemoryGroupId)] : []),
            tx.object("0x6"),
        ],
    });
}
