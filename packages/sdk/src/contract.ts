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
export const CAP_AI_SPEND = 16384;
export const CAP_BUDGET_MANAGE = 32768;

/** Server error code when AI credit balance is depleted (HTTP 402). */
export const AI_CREDIT_DEPLETED_CODE = "insufficient_ai_credits";
/** Server error code when spend exceeds approval threshold (HTTP 402). */
export const AI_CREDIT_APPROVAL_REQUIRED_CODE = "ai_credit_approval_required";

// Org permission bits (memory.move ORG_PERM_*)
export const ORG_PERM_MEMORY_READ = 1;
export const ORG_PERM_MEMORY_WRITE = 2;
export const ORG_PERM_AGENT_MANAGER = 4;
export const ORG_PERM_BUDGET_MANAGER = 8;
export const ORG_PERM_SPEND_APPROVER = 16;
export const ORG_PERM_DASHBOARD_VIEWER = 32;
export const ORG_PERM_AUDITOR = 64;
export const ORG_PERM_ALL = 127;

// Built-in org role masks
export const ROLE_MASK_OWNER = 127;
export const ROLE_MASK_ADMIN = 111;
export const ROLE_MASK_AGENT_MANAGER = 36;
export const ROLE_MASK_FINANCE_APPROVER = 24;
export const ROLE_MASK_MEMORY_ADMINISTRATOR = 3;
export const ROLE_MASK_AUDITOR = 96;

export const BUILTIN_ORG_ROLE_OWNER = "owner";
export const BUILTIN_ORG_ROLE_ADMIN = "admin";
export const BUILTIN_ORG_ROLE_AGENT_MANAGER = "agent_manager";
export const BUILTIN_ORG_ROLE_FINANCE_APPROVER = "finance_approver";
export const BUILTIN_ORG_ROLE_MEMORY_ADMINISTRATOR = "memory_administrator";
export const BUILTIN_ORG_ROLE_AUDITOR = "auditor";

/** Memory write visibility tiers (relayer vector_entries.visibility). */
export const VISIBILITY_PRIVATE = 0;
export const VISIBILITY_ORG = 1;
export const VISIBILITY_ACCOUNT = 2;

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
export const MAX_ORGANIZATIONS_PER_USER = 8;

// Agentic organization types (must match memory.move ORG_TYPE_*)
export const ORG_TYPE_COMPANY = 0;
export const ORG_TYPE_STARTUP = 1;
export const ORG_TYPE_INVESTMENT_FUND = 2;
export const ORG_TYPE_NONPROFIT = 3;
export const ORG_TYPE_RESEARCH = 4;
export const ORG_TYPE_GOVERNMENT = 5;
export const ORG_TYPE_MEDIA = 6;
export const ORG_TYPE_STEWARDSHIP = 7;
export const ORG_TYPE_BRAND = 8;
export const ORG_TYPE_COMMUNITY = 9;
export const ORG_TYPE_SPORTS = 10;
export const ORG_TYPE_EDUCATION = 11;
export const ORG_TYPE_HEALTHCARE = 12;
export const ORG_TYPE_OTHER = 13;
export const ORG_TYPE_COUNT = 14;

export enum OrganizationType {
    Company = ORG_TYPE_COMPANY,
    Startup = ORG_TYPE_STARTUP,
    InvestmentFund = ORG_TYPE_INVESTMENT_FUND,
    Nonprofit = ORG_TYPE_NONPROFIT,
    Research = ORG_TYPE_RESEARCH,
    Government = ORG_TYPE_GOVERNMENT,
    Media = ORG_TYPE_MEDIA,
    Stewardship = ORG_TYPE_STEWARDSHIP,
    Brand = ORG_TYPE_BRAND,
    Community = ORG_TYPE_COMMUNITY,
    Sports = ORG_TYPE_SPORTS,
    Education = ORG_TYPE_EDUCATION,
    Healthcare = ORG_TYPE_HEALTHCARE,
    Other = ORG_TYPE_OTHER,
}

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
