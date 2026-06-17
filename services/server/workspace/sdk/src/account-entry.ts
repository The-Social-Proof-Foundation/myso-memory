/**
 * @socialproof/memory/account
 *
 * Sub-agent management entry point — on-chain operations.
 * Requires @socialproof/myso as a peer dependency.
 */

export {
    ensureMemoryAccount,
    registerSubAgent,
    registerSubAgentDelegated,
    deactivateSubAgent,
    revokeSubAgent,
    updateSubAgent,
    updateSubAgentLabel,
    ensureAgentMemoryVault,
    buildApproveKeyPolicyTxBytes,
    buildApproveKeyWritePolicyTxBytes,
    approveKeyPolicy,
    approveKeyWritePolicy,
    generateSubAgentKey,
    deriveMySoAddressFromPublicKey,
    CAP_MEMORY_READ,
    CAP_MEMORY_WRITE,
    CAP_MYDATA_READ,
    CLASS_HUMAN,
    CLASS_DELEGATED_AI,
    CLASS_ORGANIZATION,
    REGISTER_SCOPE_CHILD,
    REGISTER_SCOPE_PEER,
    REGISTER_SCOPE_BOTH,
    REGISTER_RELATION_CHILD,
    REGISTER_RELATION_PEER,
} from "./account.js";

export type {
    EnsureMemoryAccountOpts,
    EnsureMemoryAccountResult,
    RegisterSubAgentOpts,
    RegisterSubAgentResult,
    RegisterSubAgentDelegatedOpts,
    DeactivateSubAgentOpts,
    RevokeSubAgentOpts,
    UpdateSubAgentOpts,
    UpdateSubAgentLabelOpts,
    EnsureAgentMemoryVaultOpts,
    EnsureAgentMemoryVaultResult,
    ApproveKeyPolicyOpts,
} from "./types.js";
