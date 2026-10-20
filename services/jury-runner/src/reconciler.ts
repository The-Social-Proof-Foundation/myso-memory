/**
 * The crank reconciler: a recovery path for when the automation engine misses an event, and the way
 * a third party runs the cranks on its own.
 *
 * It reads what the chain says is crankable (`GET /jury/cranks`, a public feed) and runs it through
 * the bridge with the operator's crank key (`operator:jury`). The runner holds no key: the bridge
 * signs with the wallet in its `JURY_CRANK_SIGNER_KEY`. Every crank is permissionless on chain, so
 * any operator can run this against its own bridge. It only acts on cranks that have been due for a
 * while, so the engine gets the first try, and a crank someone else already ran is an expected
 * conflict, not a failure.
 *
 * Off by default. It is a safety net, not the primary path.
 */

import { createHash } from "node:crypto";

/** The bridge's crank signer. */
export const OPERATOR_KEY_REF = "operator:jury";

export interface ReconcilerConfig {
    bridgeUrl: string;
    /** The bridge's `x-internal-sync-secret`. */
    bridgeSecret: string;
    /** The crank operator's MemoryAccount id: the bridge's `JURY_CRANK_OPERATOR_ID`. */
    operatorAccountId: string;
    intervalMs: number;
    /** A crank must have been due this long before the reconciler takes it. */
    graceMs: number;
    batch: number;
}

/** One entry of `GET /jury/cranks`. */
export interface CrankView {
    kind: string;
    caseId?: string;
    round: number;
    subjectKind: number;
    subjectId: string;
    dueMs: number;
    closeCaseFirst?: boolean;
    registryId?: string;
    platformId?: string;
    stage?: number;
    buyerAccountId?: string;
    sellerAccountId?: string;
    /** Roster cranks: `subjectId` is the juror's agent and this is the agent's own account. */
    memoryAccountId?: string;
}

export interface CrankAction {
    actionId: string;
    params: Record<string, unknown>;
}

function omitUndefined(params: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
}

/** The registered action that runs a crank, or `null` for a kind this version does not know. */
export function actionForCrank(crank: CrankView): CrankAction | null {
    const caseId = crank.caseId;
    const task = { taskId: crank.subjectId, buyerAccountId: crank.buyerAccountId, sellerAccountId: crank.sellerAccountId };
    const proposal = { registryId: crank.registryId, proposalId: crank.subjectId, platformId: crank.platformId };
    const pick = (actionId: string, params: Record<string, unknown>): CrankAction => ({
        actionId,
        params: omitUndefined(params),
    });
    switch (crank.kind) {
        case "select_due":
            return pick("jury.select_jury.v1", { caseId });
        case "replace_due":
            return pick("jury.replace_no_shows.v1", { caseId });
        case "round_finalize_due":
            return pick("jury.finalize_round.v1", { caseId });
        case "case_finalize_due":
            return pick("jury.finalize_case.v1", { caseId });
        case "execute_ready":
            return pick("jury.execute_task_verdict.v1", { ...task, caseId, platformObjectId: crank.platformId });
        case "neutral_start_due":
            return pick("jury.start_neutral_resolution.v1", { taskId: crank.subjectId, caseId });
        case "neutral_due":
            return pick("jury.execute_neutral_resolution.v1", { ...task, platformObjectId: crank.platformId });
        case "fees_due":
            return pick("jury.settle_dispute_fees.v1", {
                taskId: crank.subjectId,
                caseId,
                closeCaseFirst: crank.closeCaseFirst,
            });
        case "escalate_due":
            return pick("jury.escalate_proposal.v1", { ...proposal, stage: crank.stage });
        case "proposal_finalize_due":
            return pick("jury.finalize_proposal.v1", proposal);
        case "apply_ready":
            return pick("jury.apply_proposal_decision.v1", { ...proposal, caseId });
        case "roster_refresh_due":
            return pick("jury.refresh_roster_entry.v1", { accountId: crank.memoryAccountId, agentId: crank.subjectId });
        case "evict_due":
            return pick("jury.evict_ineligible.v1", { agentId: crank.subjectId });
        case "sweep_due":
            return pick("jury.sweep_case.v1", { caseId });
        case "vote_refund_sweep_due":
            return pick("jury.sweep_vote_refunds.v1", proposal);
        default:
            return null;
    }
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Stable within an hour, so a retry replays rather than re-runs, and short enough for the relayer's
 * key format whatever the ids are.
 */
export function idempotencyKey(crank: CrankView, nowMs: number): string {
    const digest = createHash("sha256")
        .update(`${crank.kind}|${crank.caseId ?? ""}|${crank.subjectId}|${crank.round}|${crank.stage ?? ""}`)
        .digest("hex")
        .slice(0, 32);
    return `reconcile:${crank.kind}:${digest}:b${Math.floor(nowMs / HOUR_MS)}`;
}

export interface TickResult {
    ran: number;
    conflicts: number;
    failed: number;
    skipped: number;
}

export interface ReconcilerDeps {
    config: ReconcilerConfig;
    socialServerUrl: string;
    fetch: typeof fetch;
    now: () => number;
    log: (message: string, detail?: unknown) => void;
}

export class Reconciler {
    constructor(private readonly deps: ReconcilerDeps) {}

    async tick(): Promise<TickResult> {
        const { config, fetch: doFetch, now, log } = this.deps;
        const result: TickResult = { ran: 0, conflicts: 0, failed: 0, skipped: 0 };
        const listed = await doFetch(`${this.deps.socialServerUrl}/jury/cranks?limit=${config.batch}`);
        if (!listed.ok) {
            log("could not list cranks", { status: listed.status });
            return result;
        }
        const cranks = (await listed.json()) as CrankView[];
        const nowMs = now();
        for (const crank of cranks) {
            const action = actionForCrank(crank);
            if (!action || crank.dueMs > nowMs - config.graceMs) {
                result.skipped += 1;
                continue;
            }
            const response = await doFetch(`${config.bridgeUrl}/internal/chain/act`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-internal-sync-secret": config.bridgeSecret },
                body: JSON.stringify({
                    key_ref: OPERATOR_KEY_REF,
                    account_id: config.operatorAccountId,
                    action_id: action.actionId,
                    params: action.params,
                    idempotency_key: idempotencyKey(crank, nowMs),
                }),
            });
            if (response.ok) {
                result.ran += 1;
            } else if (response.status === 409) {
                result.conflicts += 1;
            } else {
                result.failed += 1;
                log("crank failed", { kind: crank.kind, status: response.status });
            }
        }
        return result;
    }
}
