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
    generateSubAgentKey,
    deriveMySoAddressFromPublicKey,
    CAP_MEMORY_READ,
    CAP_MEMORY_WRITE,
    CLASS_DELEGATED_AI,
    REGISTER_SCOPE_CHILD,
    REGISTER_SCOPE_PEER,
    REGISTER_SCOPE_BOTH,
} from "./account.js";

export type {
    EnsureMemoryAccountOpts,
    EnsureMemoryAccountResult,
    RegisterSubAgentOpts,
    RegisterSubAgentResult,
    RegisterSubAgentDelegatedOpts,
    DeactivateSubAgentOpts,
    RevokeSubAgentOpts,
} from "./types.js";
