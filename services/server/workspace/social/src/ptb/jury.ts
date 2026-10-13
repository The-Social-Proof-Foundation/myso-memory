import type {
    JuryAcceptParams,
    JuryApplyDecisionParams,
    JuryCaseParams,
    JuryClaimFeeParams,
    JuryCommitVoteParams,
    JuryEscalateProposalParams,
    JuryEvictParams,
    JuryExecuteNeutralParams,
    JuryFinalizeProposalParams,
    JuryRefreshRosterParams,
    JuryRevealVoteParams,
    JurySettleFeesParams,
    JuryStartNeutralParams,
    JuryTaskVerdictParams,
    SocialChainConfig,
    TaskAcceptDisputeSettlementParams,
    TaskCancelDisputeParams,
    TaskClearDisputeSettlementParams,
    TaskDisputeEvidenceParams,
    TaskDisputeFeeParams,
    TaskOpenDisputeParams,
    TaskProposeDisputeSettlementParams,
} from "../types.js";
import type { BuildTxContext } from "./post.js";
import { MYSO_CLOCK, MYSO_RANDOM, resolvePlatformObjectId } from "./helpers.js";

const U64_MAX = (1n << 64n) - 1n;
const MAX_EVIDENCE_REFS = 64;

function required(value: string | undefined, label: string): string {
    if (!value?.trim()) {
        throw new TypeError(`${label} is required for this action`);
    }
    return value;
}

function juryConfigId(chain: SocialChainConfig): string {
    return required(chain.juryConfigId, "juryConfigId");
}

function rosterId(chain: SocialChainConfig): string {
    return required(chain.jurorRosterId, "jurorRosterId");
}

function taskConfigId(chain: SocialChainConfig): string {
    return required(chain.taskConfigId, "taskConfigId");
}

function treasuryId(chain: SocialChainConfig): string {
    return required(chain.ecosystemTreasuryId, "ecosystemTreasuryId");
}

function clock(ctx: BuildTxContext, tx: any): unknown {
    return tx.object(ctx.chain.clockId ?? MYSO_CLOCK);
}

function hexBytes(value: string, label: string, length = 32): number[] {
    const pattern = new RegExp(`^[0-9a-f]{${length * 2}}$`);
    if (!pattern.test(value)) {
        throw new TypeError(`${label} must be ${length * 2} lowercase hex characters`);
    }
    return Array.from({ length }, (_, index) =>
        Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
    );
}

function u8(value: number, label: string): number {
    if (!Number.isInteger(value) || value < 0 || value > 255) {
        throw new TypeError(`${label} must be an integer from 0 to 255`);
    }
    return value;
}

function u64Strings(values: readonly string[], label: string): string[] {
    if (values.length > MAX_EVIDENCE_REFS) {
        throw new TypeError(`${label} may hold at most ${MAX_EVIDENCE_REFS} entries`);
    }
    return values.map((value) => {
        if (!/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > U64_MAX) {
            throw new TypeError(`${label} entries must be unsigned u64 decimal strings`);
        }
        return value;
    });
}

function call(ctx: BuildTxContext, module: string, fn: string, args: (tx: any) => unknown[]): any {
    const tx = new ctx.Transaction();
    tx.moveCall({
        target: `${ctx.chain.packageId}::${module}::${fn}`,
        arguments: args(tx),
    });
    return tx;
}

// ============================================================
// A juror's own steps. The acting account is the juror agent's owner account.
// ============================================================

export function buildJuryAcceptTx(ctx: BuildTxContext, params: JuryAcceptParams): any {
    return call(ctx, "jury", "accept_assignment", (tx) => [
        tx.object(juryConfigId(ctx.chain)),
        tx.object(params.caseId),
        tx.object(ctx.chain.memoryConfigId),
        tx.object(ctx.memoryAccountId),
        tx.object(params.agentId),
        clock(ctx, tx),
    ]);
}

export function buildJuryCommitVoteTx(ctx: BuildTxContext, params: JuryCommitVoteParams): any {
    return call(ctx, "jury", "commit_vote", (tx) => [
        tx.object(params.caseId),
        tx.object(ctx.chain.memoryConfigId),
        tx.object(ctx.memoryAccountId),
        tx.object(params.agentId),
        tx.pure("vector<u8>", hexBytes(params.commitmentHex, "commitmentHex")),
        clock(ctx, tx),
    ]);
}

export function buildJuryRevealVoteTx(ctx: BuildTxContext, params: JuryRevealVoteParams): any {
    return call(ctx, "jury", "reveal_vote", (tx) => [
        tx.object(params.caseId),
        tx.object(ctx.chain.memoryConfigId),
        tx.object(ctx.memoryAccountId),
        tx.object(params.agentId),
        tx.pure("u8", u8(params.outcome, "outcome")),
        tx.pure("vector<u8>", hexBytes(params.rationaleDigestHex, "rationaleDigestHex")),
        tx.pure("vector<u64>", u64Strings(params.evidenceRefs, "evidenceRefs")),
        tx.pure("vector<u8>", hexBytes(params.bundleDigestHex, "bundleDigestHex")),
        tx.pure("vector<u8>", hexBytes(params.saltHex, "saltHex", 16)),
        clock(ctx, tx),
    ]);
}

/** The share is sent to the juror's payout address, so the delegate never receives funds. */
export function buildJuryClaimFeeTx(ctx: BuildTxContext, params: JuryClaimFeeParams): any {
    return call(ctx, "jury", "claim_juror_fee", (tx) => [
        tx.object(params.caseId),
        tx.pure("address", params.agentId),
    ]);
}

// ============================================================
// Keeper cranks: permissionless on chain, so each takes only shared objects.
// ============================================================

/** `select_jury` and `replace_no_shows` read the network's randomness at `0x8`. */
function drawCrank(fn: "select_jury" | "replace_no_shows") {
    return (ctx: BuildTxContext, params: JuryCaseParams): any =>
        call(ctx, "jury", fn, (tx) => [
            tx.object(juryConfigId(ctx.chain)),
            tx.object(rosterId(ctx.chain)),
            tx.object(params.caseId),
            tx.object(MYSO_RANDOM),
            clock(ctx, tx),
        ]);
}

export const buildJurySelectTx = drawCrank("select_jury");
export const buildJuryReplaceNoShowsTx = drawCrank("replace_no_shows");

function finalizeCrank(fn: "finalize_round" | "finalize_case") {
    return (ctx: BuildTxContext, params: JuryCaseParams): any =>
        call(ctx, "jury", fn, (tx) => [
            tx.object(juryConfigId(ctx.chain)),
            tx.object(rosterId(ctx.chain)),
            tx.object(params.caseId),
            clock(ctx, tx),
        ]);
}

export const buildJuryFinalizeRoundTx = finalizeCrank("finalize_round");
export const buildJuryFinalizeCaseTx = finalizeCrank("finalize_case");

/** Pays what jurors did not claim back to the address the case named. */
export function buildJurySweepCaseTx(ctx: BuildTxContext, params: JuryCaseParams): any {
    return call(ctx, "governance", "sweep_jury_case", (tx) => [tx.object(params.caseId)]);
}

export function buildJuryRefreshRosterTx(ctx: BuildTxContext, params: JuryRefreshRosterParams): any {
    return call(ctx, "jury", "refresh_roster_entry", (tx) => [
        tx.object(juryConfigId(ctx.chain)),
        tx.object(rosterId(ctx.chain)),
        tx.object(ctx.chain.memoryConfigId),
        tx.object(params.accountId),
        tx.object(params.agentId),
        clock(ctx, tx),
    ]);
}

export function buildJuryEvictTx(ctx: BuildTxContext, params: JuryEvictParams): any {
    return call(ctx, "jury", "evict_ineligible", (tx) => [
        tx.object(juryConfigId(ctx.chain)),
        tx.object(rosterId(ctx.chain)),
        tx.pure("address", params.agentId),
        clock(ctx, tx),
    ]);
}

// ============================================================
// A task in front of a jury
// ============================================================

/** Apply a final verdict: pays out exactly the menu outcome the jury chose. */
export function buildJuryExecuteTaskVerdictTx(ctx: BuildTxContext, params: JuryTaskVerdictParams): any {
    return call(ctx, "agent_task", "execute_verdict", (tx) => [
        tx.object(taskConfigId(ctx.chain)),
        tx.object(params.taskId),
        tx.object(params.caseId),
        tx.object(params.buyerAccountId),
        tx.object(params.sellerAccountId),
        tx.object(resolvePlatformObjectId(ctx.chain, params.platformObjectId)),
        clock(ctx, tx),
    ]);
}

export function buildJuryStartNeutralTx(ctx: BuildTxContext, params: JuryStartNeutralParams): any {
    return call(ctx, "agent_task", "start_neutral_resolution", (tx) => [
        tx.object(juryConfigId(ctx.chain)),
        tx.object(params.taskId),
        tx.object(params.caseId),
        clock(ctx, tx),
    ]);
}

/** After a failed jury and its settlement window: the escrow splits 50/50. */
export function buildJuryExecuteNeutralTx(ctx: BuildTxContext, params: JuryExecuteNeutralParams): any {
    return call(ctx, "agent_task", "execute_neutral_resolution", (tx) => [
        tx.object(taskConfigId(ctx.chain)),
        tx.object(params.taskId),
        tx.object(params.buyerAccountId),
        tx.object(params.sellerAccountId),
        tx.object(resolvePlatformObjectId(ctx.chain, params.platformObjectId)),
        clock(ctx, tx),
    ]);
}

/** Pays the fee pool back out. When the case is still open it is closed first, in one transaction. */
export function buildJurySettleFeesTx(ctx: BuildTxContext, params: JurySettleFeesParams): any {
    const tx = new ctx.Transaction();
    if (params.closeCaseFirst) {
        tx.moveCall({
            target: `${ctx.chain.packageId}::agent_task::close_case_after_resolution`,
            arguments: [
                tx.object(juryConfigId(ctx.chain)),
                tx.object(rosterId(ctx.chain)),
                tx.object(params.taskId),
                tx.object(params.caseId),
                clock(ctx, tx),
            ],
        });
    }
    tx.moveCall({
        target: `${ctx.chain.packageId}::agent_task::settle_dispute_fees`,
        arguments: [tx.object(params.taskId), tx.object(params.caseId), clock(ctx, tx)],
    });
    return tx;
}

// ============================================================
// A party's dispute steps (the acting account resolves to buyer or seller on chain)
// ============================================================

export function buildTaskOpenDisputeTx(ctx: BuildTxContext, params: TaskOpenDisputeParams): any {
    return call(ctx, "agent_task", "open_dispute", (tx) => [
        tx.object(taskConfigId(ctx.chain)),
        tx.object(juryConfigId(ctx.chain)),
        tx.object(rosterId(ctx.chain)),
        tx.object(params.taskId),
        tx.object(ctx.chain.memoryConfigId),
        tx.object(params.buyerAccountId),
        tx.object(params.sellerAccountId),
        tx.object(params.sellerAgentId),
        tx.object(params.feeCoinId),
        clock(ctx, tx),
    ]);
}

function feeStep(fn: "respond_dispute" | "appeal_dispute") {
    return (ctx: BuildTxContext, params: TaskDisputeFeeParams): any =>
        call(ctx, "agent_task", fn, (tx) => [
            tx.object(params.taskId),
            tx.object(params.caseId),
            tx.object(ctx.chain.memoryConfigId),
            tx.object(params.buyerAccountId),
            tx.object(params.sellerAgentId),
            tx.object(params.feeCoinId),
            clock(ctx, tx),
        ]);
}

export const buildTaskRespondDisputeTx = feeStep("respond_dispute");
export const buildTaskAppealDisputeTx = feeStep("appeal_dispute");

export function buildTaskDisputeEvidenceTx(ctx: BuildTxContext, params: TaskDisputeEvidenceParams): any {
    if (new TextEncoder().encode(params.uri).length > 2048) {
        throw new TypeError("uri must be at most 2048 bytes");
    }
    return call(ctx, "agent_task", "submit_dispute_evidence", (tx) => [
        tx.object(juryConfigId(ctx.chain)),
        tx.object(params.taskId),
        tx.object(params.caseId),
        tx.object(ctx.chain.memoryConfigId),
        tx.object(params.buyerAccountId),
        tx.object(params.sellerAgentId),
        tx.pure("vector<u8>", hexBytes(params.digestHex, "digestHex")),
        tx.pure("vector<u8>", Array.from(new TextEncoder().encode(params.uri))),
        clock(ctx, tx),
    ]);
}

export function buildTaskCancelDisputeTx(ctx: BuildTxContext, params: TaskCancelDisputeParams): any {
    return call(ctx, "agent_task", "cancel_dispute_before_draw", (tx) => [
        tx.object(params.taskId),
        tx.object(params.caseId),
        tx.object(ctx.chain.memoryConfigId),
        tx.object(params.buyerAccountId),
        tx.object(params.sellerAgentId),
        clock(ctx, tx),
    ]);
}

export function buildTaskProposeDisputeSettlementTx(
    ctx: BuildTxContext,
    params: TaskProposeDisputeSettlementParams,
): any {
    if (![0, 1, 2].includes(params.outcome)) {
        throw new TypeError("outcome must be 0 (pay the seller), 1 (refund the buyer) or 2 (split 50/50)");
    }
    return call(ctx, "agent_task", "propose_dispute_settlement", (tx) => [
        tx.object(params.taskId),
        tx.object(ctx.chain.memoryConfigId),
        tx.object(params.buyerAccountId),
        tx.object(params.sellerAgentId),
        tx.pure("u8", params.outcome),
        clock(ctx, tx),
    ]);
}

export function buildTaskAcceptDisputeSettlementTx(
    ctx: BuildTxContext,
    params: TaskAcceptDisputeSettlementParams,
): any {
    return call(ctx, "agent_task", "accept_dispute_settlement", (tx) => [
        tx.object(taskConfigId(ctx.chain)),
        tx.object(params.taskId),
        tx.object(ctx.chain.memoryConfigId),
        tx.object(params.buyerAccountId),
        tx.object(params.sellerAccountId),
        tx.object(params.sellerAgentId),
        tx.object(resolvePlatformObjectId(ctx.chain, params.platformObjectId)),
        clock(ctx, tx),
    ]);
}

export function buildTaskClearDisputeSettlementTx(
    ctx: BuildTxContext,
    params: TaskClearDisputeSettlementParams,
): any {
    return call(ctx, "agent_task", "clear_dispute_settlement", (tx) => [
        tx.object(params.taskId),
        tx.object(ctx.chain.memoryConfigId),
        tx.object(params.buyerAccountId),
        tx.object(params.sellerAgentId),
        clock(ctx, tx),
    ]);
}

// ============================================================
// Governance: the jury behind the council and the community vote
// ============================================================

/** Send a proposal to the jury at the step that has earned it (global or platform registry). */
export function buildJuryEscalateProposalTx(ctx: BuildTxContext, params: JuryEscalateProposalParams): any {
    if (params.stage !== 1 && params.stage !== 2) {
        throw new TypeError("stage must be 1 (council) or 2 (community)");
    }
    if (params.platformId) {
        return call(ctx, "platform", "escalate_platform_proposal_to_jury", (tx) => [
            tx.object(params.platformId),
            tx.object(params.registryId),
            tx.object(params.proposalId),
            tx.object(juryConfigId(ctx.chain)),
            tx.pure("u8", params.stage),
            clock(ctx, tx),
        ]);
    }
    return call(ctx, "governance", "escalate_to_jury", (tx) => [
        tx.object(params.registryId),
        tx.object(params.proposalId),
        tx.object(juryConfigId(ctx.chain)),
        tx.object(treasuryId(ctx.chain)),
        tx.pure("u8", params.stage),
        clock(ctx, tx),
    ]);
}

/** End a finished community vote. With no quorum or a tie it hands the proposal to the jury. */
export function buildJuryFinalizeProposalTx(ctx: BuildTxContext, params: JuryFinalizeProposalParams): any {
    if (params.platformId) {
        return call(ctx, "platform", "finalize_platform_governance_proposal", (tx) => [
            tx.object(params.platformId),
            tx.object(params.registryId),
            tx.object(params.proposalId),
            clock(ctx, tx),
        ]);
    }
    return call(ctx, "governance", "finalize_proposal", (tx) => [
        tx.object(params.registryId),
        tx.object(params.proposalId),
        tx.object(treasuryId(ctx.chain)),
        clock(ctx, tx),
    ]);
}

/** Apply a finished jury case to its proposal. */
export function buildJuryApplyDecisionTx(ctx: BuildTxContext, params: JuryApplyDecisionParams): any {
    if (params.platformId) {
        return call(ctx, "platform", "apply_platform_jury_decision", (tx) => [
            tx.object(params.platformId),
            tx.object(params.registryId),
            tx.object(params.proposalId),
            tx.object(params.caseId),
            clock(ctx, tx),
        ]);
    }
    return call(ctx, "governance", "apply_jury_decision", (tx) => [
        tx.object(params.registryId),
        tx.object(params.proposalId),
        tx.object(params.caseId),
        tx.object(treasuryId(ctx.chain)),
        clock(ctx, tx),
    ]);
}
