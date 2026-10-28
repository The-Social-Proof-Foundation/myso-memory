import { McpRuntimeError } from "./errors.js";

const fail = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The governance reader returned malformed or inconsistent chain evidence.");
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
    const row = value as Record<string, unknown>;
    if (Object.keys(row).length !== keys.length || keys.some((key) => !(key in row))) throw fail();
    return row;
}
function text(value: unknown, max: number, allowEmpty = false): string {
    if (typeof value !== "string" || value.length > max || (!allowEmpty && value.length === 0)) throw fail();
    return value;
}
function decimal(value: unknown, positive = false): string {
    if (typeof value !== "string" || value.length > 20 || !/^(0|[1-9][0-9]*)$/.test(value) || positive && value === "0" || BigInt(value) > 18_446_744_073_709_551_615n) throw fail();
    return value;
}
function address(value: unknown): string {
    if (typeof value !== "string" || !/^(0x)?[0-9a-f]{1,64}$/i.test(value)) throw fail();
    return value.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}
function safeInteger(value: unknown, min: number, max: number): void {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw fail();
}

const quoteWarning = "Quote is a current object-state estimate; the native vote entry rechecks proposal membership, phase, time, eligibility and payment at execution. Registry membership is not proven by this object read.";
export function sanitizeGovernanceRead(name: string, value: unknown, args: Record<string, unknown>): unknown {
    if (name === "governance_get_vote_quote") {
        const row = object(value, ["registryId", "proposalId", "voteCount", "approve", "registryMaxVotesPerUser", "quadraticBaseCostMist", "estimatedVoteCostMist", "proposalStatus", "communityVotingStatus", "currentlyInCommunityVoting", "votingStartTimeMs", "votingEndTimeMs", "quoteSource", "warning"]);
        if (address(row.registryId) !== address(args.registryId) || address(row.proposalId) !== address(args.proposalId)) throw fail();
        const voteCount = BigInt(decimal(row.voteCount, true));
        if (voteCount !== BigInt(decimal(args.voteCount, true)) || row.approve !== "must_be_chosen_by_owner") throw fail();
        const maxVotes = BigInt(decimal(row.registryMaxVotesPerUser));
        const baseCost = BigInt(decimal(row.quadraticBaseCostMist));
        const quotedCost = BigInt(decimal(row.estimatedVoteCostMist));
        if (voteCount > maxVotes) throw fail();
        const expectedCost = voteCount <= 1n ? 0n : baseCost * (voteCount * voteCount - 1n);
        if (expectedCost > 18_446_744_073_709_551_615n || quotedCost !== expectedCost) throw fail();
        safeInteger(row.proposalStatus, 0, 255);
        if (row.communityVotingStatus !== 2 || typeof row.currentlyInCommunityVoting !== "boolean" || row.currentlyInCommunityVoting !== (row.proposalStatus === 2)) throw fail();
        if (row.votingStartTimeMs !== null) decimal(row.votingStartTimeMs);
        if (row.votingEndTimeMs !== null) decimal(row.votingEndTimeMs);
        if (row.quoteSource !== "configured_fullnode_current_object_state" || row.warning !== quoteWarning) throw fail();
        return row;
    }

    if (name !== "governance_get_vote_receipt" && name !== "governance_get_delegate_vote_receipt") throw fail();
    const row = object(value, ["digest", "registryAction", "status", "checkpoint", ...(name === "governance_get_delegate_vote_receipt" ? ["route"] : []), "vote", "evidenceSource"]);
    const expectedAction = name === "governance_get_vote_receipt" ? "governance.vote.v1" : "governance.delegate_vote.v1";
    if (row.digest !== args.id || row.registryAction !== expectedAction || !["finalized", "checkpoint_pending", "failed", "unknown"].includes(String(row.status)) || row.evidenceSource !== "configured_fullnode_and_scoped_preparation") throw fail();
    if (row.checkpoint !== null) decimal(row.checkpoint);
    if (row.status === "finalized" && row.checkpoint === null) throw fail();
    if (name === "governance_get_delegate_vote_receipt" && row.route !== "ecosystem" && row.route !== "platform") throw fail();
    if (row.vote === null) {
        if (row.status === "finalized") throw fail();
        return row;
    }
    if (name === "governance_get_vote_receipt") {
        const vote = object(row.vote, ["proposal_id", "voter", "vote_weight", "approve", "vote_time", "vote_cost"]);
        address(vote.proposal_id); address(vote.voter); decimal(vote.vote_weight, true); decimal(vote.vote_time); decimal(vote.vote_cost);
        if (typeof vote.approve !== "boolean") throw fail();
    } else {
        const vote = object(row.vote, ["proposal_id", "delegate_address", "approve", "vote_time", "reason"]);
        address(vote.proposal_id); address(vote.delegate_address); decimal(vote.vote_time);
        if (typeof vote.approve !== "boolean" || vote.reason !== null && (typeof vote.reason !== "string" || vote.reason.length > 1_000)) throw fail();
    }
    if (row.status === "finalized" && row.vote === null) throw fail();
    return row;
}
