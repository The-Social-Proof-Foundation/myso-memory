/**
 * What to tell the engine about a jury event.
 *
 * The engine calls the runner with a signed webhook, waits at most 15 seconds, and runs whatever
 * action the reply names with the juror's delegate key. Judging takes longer than that, so the
 * runner answers in two steps: the first poll starts the judgment in the background and replies
 * `noop`; a later poll finds it ready and replies with the commit, and the reveal poll replies with
 * the reveal. Accepting a seat and claiming the fee need no thinking and are answered at once.
 *
 * Every reply for one `delivery_id` is cached, because the engine retries a delivery under the same
 * id and the answer must not change between tries.
 */

import { ABSTAIN, buildBundle, type BundleDeps } from "./bundle.js";
import { computeCommitment, deriveSalt, sha256Hex } from "./commitment.js";
import { judgeCase, type JudgeDeps } from "./judge.js";
import type { Directive, Judgment, JudgmentStore } from "./store.js";

export const ACTION_ACCEPT = "jury.accept.v1";
export const ACTION_COMMIT = "jury.commit_vote.v1";
export const ACTION_REVEAL = "jury.reveal_vote.v1";
export const ACTION_CLAIM = "jury.claim_fee.v1";

export interface EngineRequest {
    delivery_id: string;
    allowed_action_ids?: string[];
    event: {
        event_type: string;
        agent_object_id?: string | null;
        payload?: Record<string, unknown>;
    };
}

export interface JudgmentServiceDeps {
    store: JudgmentStore;
    bundle: BundleDeps;
    judge: JudgeDeps;
    saltSecret: string;
    now: () => number;
    log?: (message: string, detail?: unknown) => void;
    metrics?: import("./metrics.js").Metrics;
}

/** Judges a case once per seat and keeps the result. Never overwrites a stored judgment. */
export class JudgmentService {
    private readonly inflight = new Map<string, Promise<void>>();

    constructor(private readonly deps: JudgmentServiceDeps) {}

    /** Starts judging unless it is done or already running. Returns at once. */
    start(caseId: string, round: number, agentId: string): void {
        if (this.deps.store.getJudgment(caseId, round, agentId)) return;
        const id = `${caseId}:${round}:${agentId}`.toLowerCase();
        if (this.inflight.has(id)) return;
        this.deps.metrics?.inc("jury_runner_judgments_started_total");
        const startedAt = this.deps.now();
        const work = this.run(caseId, round, agentId)
            .then(() => this.deps.metrics?.observeSeconds("jury_runner_judgment", (this.deps.now() - startedAt) / 1000))
            .catch((error: unknown) => {
                this.deps.metrics?.inc("jury_runner_judgments_failed_total");
                this.deps.log?.("judgment failed; the next poll will retry", { caseId, error: String(error) });
            })
            .finally(() => this.inflight.delete(id));
        this.inflight.set(id, work);
    }

    /** For tests: resolves when every judgment that is running has finished. */
    async idle(): Promise<void> {
        await Promise.all([...this.inflight.values()]);
    }

    private async run(caseId: string, round: number, agentId: string): Promise<void> {
        const { bundle, digestHex } = await buildBundle(this.deps.bundle, caseId, round);
        const tag = `${caseId}:${round}:${agentId}`.toLowerCase();
        const verdict = await judgeCase(this.deps.judge, bundle, tag);
        const usage = this.deps.judge.inference.takeUsage?.(tag) ?? [];
        for (const record of usage) this.deps.metrics?.inc("jury_runner_inference_amount_mist_total", {}, record.amountMist);
        this.deps.metrics?.inc("jury_runner_judgments_completed_total");
        if (verdict.outcome === ABSTAIN) this.deps.metrics?.inc("jury_runner_judgments_abstained_total");
        const rationaleDigestHex = sha256Hex(verdict.rationale);
        const saltHex = deriveSalt(this.deps.saltSecret, caseId, round, agentId);
        const commitmentHex = computeCommitment({
            caseId, round, agentId,
            outcome: verdict.outcome,
            rationaleDigestHex,
            evidenceRefs: verdict.evidenceRefs,
            bundleDigestHex: digestHex,
            saltHex,
        });
        // Two judgments of one seat must never both exist: whichever commit reaches the chain is
        // the one that has to be revealed.
        if (this.deps.store.getJudgment(caseId, round, agentId)) return;
        this.deps.store.putJudgment({
            caseId, round, agentId,
            outcome: verdict.outcome,
            rationale: verdict.rationale,
            evidenceRefs: verdict.evidenceRefs,
            rationaleDigestHex,
            bundleDigestHex: digestHex,
            saltHex,
            commitmentHex,
            createdAtMs: this.deps.now(),
            ...(usage.length > 0 ? { inference: usage } : {}),
        });
    }
}

const noop = (reason: string): Directive => ({ noop: true, reason });

function text(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function whole(value: unknown): number | undefined {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export class DirectiveEngine {
    constructor(
        private readonly deps: {
            store: JudgmentStore;
            judgments: JudgmentService;
            now: () => number;
        },
    ) {}

    async handle(request: EngineRequest): Promise<Directive> {
        const cached = this.deps.store.getDelivery(request.delivery_id);
        if (cached) return cached;
        const directive = this.decide(request);
        this.deps.store.putDelivery(request.delivery_id, directive, this.deps.now());
        return directive;
    }

    private decide(request: EngineRequest): Directive {
        const { event } = request;
        const payload = event.payload ?? {};
        const caseId = text(payload.case_id);
        const agentId = text(payload.agent_id);
        const round = whole(payload.round);
        if (!caseId || !agentId || round === undefined) return noop("the event names no seat");
        if (event.agent_object_id && event.agent_object_id.toLowerCase() !== agentId.toLowerCase()) {
            return noop("the event is for a different agent");
        }
        const expires = whole(payload.expires_at_ms);
        if (expires !== undefined && this.deps.now() > expires) return noop("the deadline has passed");

        const allowed = (action: string) => (request.allowed_action_ids ?? []).includes(action);
        const act = (action: string, params: Record<string, unknown>): Directive =>
            allowed(action) ? { action_id: action, params } : noop(`this job may not run ${action}`);

        const kind = event.event_type === "duty_poll" ? text(payload.duty_kind) : undefined;
        switch (event.event_type) {
            case "duty_drafted":
                return act(ACTION_ACCEPT, { caseId, agentId });
            case "voting_started":
                // Start thinking now; the commit goes out on a later poll.
                this.deps.judgments.start(caseId, round, agentId);
                return noop("judging");
            case "fee_claimable":
                return act(ACTION_CLAIM, { caseId, agentId });
            case "duty_poll":
                break;
            default:
                return noop(`not an event this runner acts on: ${event.event_type}`);
        }

        if (kind === "accept") return act(ACTION_ACCEPT, { caseId, agentId });
        if (kind === "commit") {
            const judgment = this.deps.store.getJudgment(caseId, round, agentId);
            if (!judgment) {
                this.deps.judgments.start(caseId, round, agentId);
                return noop("judging");
            }
            return act(ACTION_COMMIT, { caseId, agentId, commitmentHex: judgment.commitmentHex });
        }
        if (kind === "reveal") {
            const judgment = this.deps.store.getJudgment(caseId, round, agentId);
            if (!judgment) return noop("no judgment to reveal");
            if (!allowed(ACTION_REVEAL)) return noop(`this job may not run ${ACTION_REVEAL}`);
            let params: Record<string, unknown>;
            try {
                params = revealParams(judgment);
            } catch {
                // Revealing something other than what was committed would only abort on chain and
                // cost the juror its duty, so say nothing instead.
                return noop("the stored judgment does not match its commitment");
            }
            this.deps.store.markRevealIssued(caseId, round, agentId, this.deps.now());
            return { action_id: ACTION_REVEAL, params };
        }
        return noop(`unknown duty ${String(kind)}`);
    }
}

/** The reveal that opens exactly the commitment already stored, or throws if it would not. */
export function revealParams(judgment: Judgment): Record<string, unknown> {
    const recomputed = computeCommitment({
        caseId: judgment.caseId,
        round: judgment.round,
        agentId: judgment.agentId,
        outcome: judgment.outcome,
        rationaleDigestHex: judgment.rationaleDigestHex,
        evidenceRefs: judgment.evidenceRefs,
        bundleDigestHex: judgment.bundleDigestHex,
        saltHex: judgment.saltHex,
    });
    if (recomputed !== judgment.commitmentHex) {
        throw new Error("the stored judgment no longer matches its commitment");
    }
    return {
        caseId: judgment.caseId,
        agentId: judgment.agentId,
        outcome: judgment.outcome,
        rationaleDigestHex: judgment.rationaleDigestHex,
        evidenceRefs: judgment.evidenceRefs.map(String),
        bundleDigestHex: judgment.bundleDigestHex,
        saltHex: judgment.saltHex,
    };
}

