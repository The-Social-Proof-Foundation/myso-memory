/** Mirrors `social_contracts::memory` capability bits (subset used by social SDK). */

export const CAP_MEMORY_READ = 1;
export const CAP_MEMORY_WRITE = 2;
export const CAP_MYDATA_READ = 4;
export const CAP_POST_PUBLISH = 16;
export const CAP_COMMENT = 512;
export const CAP_REACT = 1024;
export const CAP_MESSAGE_READ = 32;
export const CAP_MESSAGE_SEND = 64;
export const CAP_TRADE_MONITOR = 128;
export const CAP_TRADE_EXECUTE = 256;
export const CAP_AGENT_REVOKE = 2048;
export const CAP_AGENT_UPDATE = 4096;
export const CAP_AGENT_REGISTER = 8192;
/** Mirrors memory::CAP_AI_SPEND; this bit is independent of memory writes. */
export const CAP_AI_SPEND = 16384;
export const CAP_BUDGET_MANAGE = 32768;
export const CAP_SOCIAL_GRAPH = 65536;
export const CAP_TASK_TRADE = 131072;
/** Mirrors `memory::CAP_JURY`: serve on a jury (accept, commit, reveal, claim). Spends nothing. */
export const CAP_JURY = 262144;
/** The jury cranks are permissionless on chain, so driving one needs no capability. */
export const CAP_NONE = 0;

/** Mirrors `post::POST_ACCESS_*`. */
export const POST_ACCESS_PUBLIC = 1;
export const POST_ACCESS_PROFILE_SUBSCRIPTION = 2;
export const POST_ACCESS_MARKETPLACE_ONE_TIME = 3;

export function hasCap(capabilities: number, required: number): boolean {
    return (capabilities & required) === required;
}

export function capRequiresApproval(approvalRequiredCaps: number, cap: number): boolean {
    return (approvalRequiredCaps & cap) === cap;
}
