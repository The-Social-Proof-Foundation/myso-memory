import type { GovernanceDelegateVoteParams, GovernanceVoteParams } from "../types.js";
import type { BuildTxContext } from "./post.js";
import { MYSO_CLOCK } from "./helpers.js";

const U64_MAX = (1n << 64n) - 1n;

function objectId(value: string, label: string): void {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) {
        throw new TypeError(`${label} must be a chain object ID`);
    }
}

export function validateGovernanceVote(p: GovernanceVoteParams): void {
    objectId(p.registryId, "registryId");
    objectId(p.proposalId, "proposalId");
    objectId(p.paymentCoinId, "paymentCoinId");
    if (typeof p.voteCount !== "string" || !/^[1-9][0-9]{0,19}$/.test(p.voteCount) || BigInt(p.voteCount) > U64_MAX) {
        throw new TypeError("voteCount must be a positive u64 decimal string");
    }
    if (typeof p.approve !== "boolean") throw new TypeError("approve must be a boolean");
}

/** Owner-wallet vote. The native entry validates registry type, profile, phase,
 * vote limits, quadratic cost and payment; the MCP only fixes exact object IDs. */
export function buildGovernanceVoteTx(ctx: BuildTxContext, p: GovernanceVoteParams): any {
    validateGovernanceVote(p);
    if (!ctx.chain.usernameRegistryId) throw new TypeError("usernameRegistryId is required for governance votes");
    const tx = new ctx.Transaction();
    tx.moveCall({
        target: `${ctx.chain.packageId}::governance::community_vote_on_proposal`,
        arguments: [
            tx.object(p.registryId),
            tx.object(ctx.chain.usernameRegistryId),
            tx.object(p.proposalId),
            tx.pure("u64", p.voteCount),
            tx.pure("bool", p.approve),
            tx.object(p.paymentCoinId),
            tx.object(ctx.chain.clockId ?? MYSO_CLOCK),
        ],
    });
    return tx;
}

export function validateGovernanceDelegateVote(p: GovernanceDelegateVoteParams): void {
    objectId(p.registryId, "registryId"); objectId(p.proposalId, "proposalId");
    if (p.route !== "ecosystem" && p.route !== "platform") throw new TypeError("route must be ecosystem or platform");
    if (typeof p.approve !== "boolean") throw new TypeError("approve must be a boolean");
    if (p.reason !== undefined && (typeof p.reason !== "string" || p.reason.length === 0 || p.reason.length > 1000)) throw new TypeError("reason must contain 1–1000 characters when supplied");
}

/** Owner-approved delegate vote; native council membership and proposal phase remain authoritative. */
export function buildGovernanceDelegateVoteTx(ctx: BuildTxContext, p: GovernanceDelegateVoteParams): any {
    validateGovernanceDelegateVote(p);
    const tx = new ctx.Transaction();
    const sharedArgs = [tx.object(p.registryId), tx.object(p.proposalId)];
    const voteArgs = [tx.pure("bool", p.approve), tx.pure("option<string>", p.reason ?? null), tx.object(ctx.chain.clockId ?? MYSO_CLOCK)];
    if (p.route === "ecosystem") {
        const treasuryId = ctx.chain.ecosystemTreasuryId;
        if (!treasuryId) throw new TypeError("ecosystemTreasuryId is required for ecosystem delegate votes");
        objectId(treasuryId, "ecosystemTreasuryId");
        tx.moveCall({ target: `${ctx.chain.packageId}::governance::delegate_vote_on_proposal`, arguments: [...sharedArgs.slice(0, 1), sharedArgs[1], tx.object(treasuryId), ...voteArgs] });
    } else {
        objectId(ctx.chain.platformObjectId, "platformObjectId");
        tx.moveCall({ target: `${ctx.chain.packageId}::platform::delegate_vote_on_platform_governance_proposal`, arguments: [tx.object(ctx.chain.platformObjectId), ...sharedArgs, ...voteArgs] });
    }
    return tx;
}
