/**
 * Mirrors `social_contracts::memory` constants (memory.move + memory_contract.rs).
 * Used by account helpers, manual MYDATA flows, and OpenClaw plugin.
 */

// Capability bits
export const CAP_MEMORY_READ = 1;
export const CAP_MEMORY_WRITE = 2;
export const CAP_MYDATA_READ = 4;
export const CAP_POST_PUBLISH = 16;
export const CAP_MESSAGE_READ = 32;
export const CAP_MESSAGE_SEND = 64;
export const CAP_TRADE_MONITOR = 128;
export const CAP_TRADE_EXECUTE = 256;
export const CAP_COMMENT = 512;
export const CAP_REACT = 1024;
export const CAP_AGENT_REVOKE = 2048;
export const CAP_AGENT_UPDATE = 4096;
export const CAP_AGENT_REGISTER = 8192;

// Identity classes
export const CLASS_HUMAN = 0;
export const CLASS_DELEGATED_AI = 1;
export const CLASS_ORGANIZATION = 2;

// Register scopes
export const REGISTER_SCOPE_CHILD = 1;
export const REGISTER_SCOPE_PEER = 2;
export const REGISTER_SCOPE_BOTH = 3;

// Delegated registration relations
export const REGISTER_RELATION_CHILD = 0;
export const REGISTER_RELATION_PEER = 1;

export const MAX_AGENT_DEPTH = 8;

// Move abort codes (subset used off-chain)
export const E_ACCOUNT_DEACTIVATED = 6;
export const E_SUB_AGENT_NOT_ACTIVE = 15;
export const E_SUB_AGENT_EXPIRED = 16;
export const E_SUB_AGENT_WRONG_PLATFORM_SCOPE = 17;
export const E_SUB_AGENT_MISSING_CAP = 18;
export const E_SUB_AGENT_APPROVAL_REQUIRED = 19;
export const E_SUB_AGENT_INACTIVE_ANCESTOR = 29;
export const E_SUB_AGENT_SPEND_EXCEEDED = 30;

export function hasCap(capabilities: number, required: number): boolean {
    return (capabilities & required) === required;
}

export function capRequiresApproval(approvalRequiredCaps: number, cap: number): boolean {
    return (approvalRequiredCaps & cap) === cap;
}
