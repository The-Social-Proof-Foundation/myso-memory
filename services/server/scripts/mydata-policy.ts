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
