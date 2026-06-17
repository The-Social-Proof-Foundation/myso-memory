/** Mirrors `social_contracts::memory` capability bits (subset used by social SDK). */

export const CAP_POST_PUBLISH = 16;
export const CAP_COMMENT = 512;
export const CAP_REACT = 1024;
export const CAP_MESSAGE_READ = 32;
export const CAP_MESSAGE_SEND = 64;

export function hasCap(capabilities: number, required: number): boolean {
    return (capabilities & required) === required;
}

export function capRequiresApproval(approvalRequiredCaps: number, cap: number): boolean {
    return (approvalRequiredCaps & cap) === cap;
}
