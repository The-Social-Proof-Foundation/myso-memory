import { McpRuntimeError } from "./errors.js";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

const fail = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The task or jury reader returned malformed or inconsistent receipt evidence.");
const taskActions: Record<string, readonly string[]> = {
    "task.create.v1": ["TaskOffered"],
    "task.accept.v1": ["TaskAccepted"],
    "task.decline.v1": ["TaskCancelled"],
    "task.cancel_offer.v1": ["TaskCancelled"],
    "task.expire_offer.v1": ["TaskCancelled"],
    "task.deliver.v1": ["TaskDelivered"],
    "task.settle.v1": ["TaskReceiptSettled"],
    "task.release.v1": ["TaskReceiptSettled"],
    "task.refund.v1": ["TaskRefunded"],
    "task.accept_refund.v1": ["TaskRefunded"],
    "task.propose_refund.v1": ["TaskRefundProposed"],
    "task.reject_refund.v1": ["TaskRefundProposalCleared"],
    "task.withdraw_refund.v1": ["TaskRefundProposalCleared"],
    "task.open_dispute.v1": ["TaskDisputed", "CaseOpened"],
    "task.respond_dispute.v1": ["TaskDisputeFeePaid"],
    "task.appeal.v1": ["TaskDisputeFeePaid", "CaseAppealed"],
    "task.submit_evidence.v1": ["EvidenceSubmitted"],
    "task.cancel_dispute.v1": ["TaskDisputeCancelled", "CaseCancelled"],
    "task.propose_dispute_settlement.v1": ["TaskDisputeSettlementProposed"],
    "task.accept_dispute_settlement.v1": ["TaskDisputeResolved", "TaskReceiptSettled", "TaskRefunded"],
    "task.clear_dispute_settlement.v1": ["TaskDisputeSettlementCleared"],
    "task.review.v1": ["TaskReviewSubmitted"],
};
const juryEvents: Record<string, { module: string; names: readonly string[] }> = {
    "jury.accept.v1": { module: "jury", names: ["AssignmentAccepted"] },
    "jury.commit_vote.v1": { module: "jury", names: ["VoteCommitted"] },
    "jury.reveal_vote.v1": { module: "jury", names: ["VoteRevealed"] },
    "jury.claim_fee.v1": { module: "jury", names: ["JurorPaid"] },
    "jury.select_jury.v1": { module: "jury", names: ["JuryDrawn"] },
    "jury.replace_no_shows.v1": { module: "jury", names: ["JurorReplaced", "JuryDrawn", "VotingStarted", "CaseFailed"] },
    "jury.finalize_round.v1": { module: "jury", names: ["RoundFinalized"] },
    "jury.finalize_case.v1": { module: "jury", names: ["CaseFinalized", "CaseFailed"] },
    "jury.execute_task_verdict.v1": { module: "agent_task", names: ["TaskDisputeResolved"] },
    "jury.start_neutral_resolution.v1": { module: "agent_task", names: ["TaskNeutralWindowOpened"] },
    "jury.execute_neutral_resolution.v1": { module: "agent_task", names: ["TaskDisputeResolved"] },
    "jury.settle_dispute_fees.v1": { module: "agent_task", names: ["TaskDisputeFeesSettled"] },
    "jury.escalate_proposal.v1": { module: "governance", names: ["ProposalEscalatedToJuryEvent", "JuryUnavailableEvent"] },
    "jury.finalize_proposal.v1": { module: "governance", names: ["ProposalApprovedForVotingEvent", "ProposalRejectedByCommunityEvent", "ProposalEscalatedToJuryEvent", "JuryUnavailableEvent", "JuryDecisionAppliedEvent"] },
    "jury.apply_proposal_decision.v1": { module: "governance", names: ["JuryDecisionAppliedEvent", "ProposalRejectedByJuryEvent", "ProposalApprovedEvent"] },
    "jury.sweep_vote_refunds.v1": { module: "governance", names: ["VoteRefundsSweptEvent"] },
    "jury.sweep_case.v1": { module: "governance", names: ["JuryCaseRemainderSweptEvent"] },
    "jury.refresh_roster_entry.v1": { module: "jury", names: ["RosterEntryRefreshed"] },
    "jury.evict_ineligible.v1": { module: "jury", names: ["RosterLeft"] },
};

function obj(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
    const row = value as Record<string, unknown>;
    if (Object.keys(row).length !== keys.length || keys.some((key) => !(key in row))) throw fail();
    return row;
}
function address(value: unknown): string {
    if (typeof value !== "string" || !/^(0x)?[0-9a-f]{1,64}$/i.test(value)) throw fail();
    return value;
}
function normalize(value: unknown): string {
    return address(value).toLowerCase().replace(/^0x/, "").padStart(64, "0");
}
function sameId(a: unknown, b: unknown): boolean { return normalize(a) === normalize(b); }
function maybeAddress(value: unknown): void { if (value !== null) address(value); }
function digest(value: unknown): string {
    if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(value)) throw fail();
    return value;
}
function decimal(value: unknown): string {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
    if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) return value;
    throw fail();
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw fail();
    return value;
}
function text(value: unknown, max = 16_384): string {
    if (typeof value !== "string" || value.length > max) throw fail();
    return value;
}
function walk(value: unknown, depth = 0): void {
    if (depth > 8) throw fail();
    if (typeof value === "number") { if (!Number.isSafeInteger(value)) throw fail(); return; }
    if (typeof value === "string") { if (value.length > 16_384) throw fail(); return; }
    if (value === null || typeof value === "boolean") return;
    if (Array.isArray(value)) { if (value.length > 1000) throw fail(); for (const item of value) walk(item, depth + 1); return; }
    if (typeof value === "object") { for (const item of Object.values(value as Record<string, unknown>)) walk(item, depth + 1); return; }
    throw fail();
}
function digestHex(value: unknown): string {
    let hex: string;
    if (typeof value === "string") hex = value.replace(/^0x/i, "").toLowerCase();
    else if (Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 255)) hex = value.map((item) => item.toString(16).padStart(2, "0")).join("");
    else throw fail();
    if (!/^[0-9a-f]{64}$/.test(hex)) throw fail();
    return hex;
}
function eventId(value: unknown): string {
    if (typeof value === "string") return address(value);
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const row = value as Record<string, unknown>;
        if (typeof row.Some === "string") return address(row.Some);
        if (typeof row.id === "string") return address(row.id);
    }
    throw fail();
}
function receiptEvent(input: unknown): { type: string; data: Record<string, unknown> } {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw fail();
    const row = input as Record<string, unknown>;
    const keys = Object.keys(row);
    if (!(keys.length === 2 && keys.includes("type") && keys.includes("data"))
        && !(keys.length === 4 && ["type", "data", "eventSeq", "occurredAtMs"].every(key => keys.includes(key)))) throw fail();
    if (row.eventSeq !== undefined && row.eventSeq !== null) decimal(row.eventSeq);
    if (row.occurredAtMs !== undefined && row.occurredAtMs !== null) decimal(row.occurredAtMs);
    const event = row;
    const type = text(event.type, 512);
    const data = event.data && typeof event.data === "object" && !Array.isArray(event.data) ? event.data as Record<string, unknown> : null;
    if (!type.includes("::") || !data) throw fail();
    walk(data);
    return { type, data };
}

const taskListFields = ["taskId", "buyerPrincipal", "buyerAgentId", "buyerMemoryAccountId", "sellerPrincipal", "sellerAgentId", "sellerMemoryAccountId", "organizationId", "roomGroupId", "platformId", "title", "scopeDigest", "amountMist", "acceptWindowMs", "deliveryWindowMs", "settleWindowMs", "platformFeeBps", "ecosystemFeeBps", "termsDigest", "status", "closeKind", "settlementKind", "refundKind", "createdAtMs", "acceptDeadlineMs", "acceptedAtMs", "deliveryDeadlineMs", "deliveredAtMs", "settleDeadlineMs", "settledAtMs", "refundedAtMs", "cancelledAtMs", "reviewDeadlineMs", "deliverableDigest", "deliverableUri", "platformFeeMist", "ecosystemFeeMist", "netAmountMist", "refundProposer", "refundProposedAtMs", "buyerCredibilityBps", "sellerCredibilityBps", "buyerReviewStars", "sellerReviewStars", "transactionId"] as const;
const taskOptionalAddresses = ["buyerAgentId", "organizationId", "roomGroupId", "platformId"] as const;
const taskOptionalIntegers = ["closeKind", "settlementKind", "refundKind", "acceptedAtMs", "deliveryDeadlineMs", "deliveredAtMs", "settleDeadlineMs", "settledAtMs", "refundedAtMs", "cancelledAtMs", "reviewDeadlineMs", "refundProposedAtMs", "buyerCredibilityBps", "sellerCredibilityBps", "buyerReviewStars", "sellerReviewStars"] as const;
function numberOrDecimal(value: unknown): number | string {
    if (typeof value === "number" && Number.isSafeInteger(value)) return value;
    if (typeof value === "string" && /^-?(0|[1-9][0-9]*)$/.test(value)) return value;
    throw fail();
}
function nullableNumberOrDecimal(value: unknown): void { if (value !== null) numberOrDecimal(value); }
type TaskListPrincipal = { owner?: string; agentObjectId?: string; organizationId?: string | null };
function sanitizeTaskList(value: unknown, args: Record<string, unknown>, scope?: { name: string; principal: TaskListPrincipal }): unknown {
    if (!Array.isArray(value) || value.length > 50) throw fail();
    const requestedStatuses = typeof args.status === "string" ? new Set(args.status.split(",").map(Number)) : undefined;
    const role = args.role === "buyer" ? "buyer" : "seller";
    let previousCreatedAt: bigint | undefined;
    let previousTaskId: string | undefined;
    const seenTaskIds = new Set<string>();
    for (const item of value) {
        const row = obj(item, taskListFields);
        for (const key of ["taskId", "buyerPrincipal", "buyerMemoryAccountId", "sellerPrincipal", "sellerAgentId", "sellerMemoryAccountId"] as const) address(row[key]);
        for (const key of taskOptionalAddresses) maybeAddress(row[key]);
        decimal(row.amountMist);
        for (const key of ["platformFeeMist", "ecosystemFeeMist", "netAmountMist"] as const) if (row[key] !== null) decimal(row[key]);
        for (const key of ["acceptWindowMs", "deliveryWindowMs", "settleWindowMs", "platformFeeBps", "ecosystemFeeBps", "status", "createdAtMs", "acceptDeadlineMs", "refundProposer"] as const) numberOrDecimal(row[key]);
        if (integer(Number(row.status), 0, 6) !== Number(row.status)) throw fail();
        for (const key of taskOptionalIntegers) nullableNumberOrDecimal(row[key]);
        text(row.title, 512); text(row.scopeDigest, 256); text(row.termsDigest, 256); digest(row.transactionId);
        if (row.deliverableDigest !== null) text(row.deliverableDigest, 256);
        if (row.deliverableUri !== null) text(row.deliverableUri, 2048);
        if (row.buyerReviewStars !== null && (Number(row.buyerReviewStars) < 1 || Number(row.buyerReviewStars) > 5)) throw fail();
        if (row.sellerReviewStars !== null && (Number(row.sellerReviewStars) < 1 || Number(row.sellerReviewStars) > 5)) throw fail();
        const createdAt = BigInt(String(row.createdAtMs));
        const taskId = normalize(row.taskId);
        if (seenTaskIds.has(taskId) || previousCreatedAt !== undefined && (createdAt > previousCreatedAt || createdAt === previousCreatedAt && taskId <= previousTaskId!)) throw fail();
        seenTaskIds.add(taskId);
        previousCreatedAt = createdAt;
        previousTaskId = taskId;
        const status = Number(row.status);
        if (requestedStatuses && !requestedStatuses.has(status)) throw fail();
        if (scope?.name === "task_list") {
            if (!scope.principal.owner || !sameId(role === "buyer" ? row.buyerPrincipal : row.sellerPrincipal, scope.principal.owner)) throw fail();
        } else if (scope?.name === "task_list_for_agent") {
            const expectedAgent = scope.principal.agentObjectId;
            const actualAgent = role === "buyer" ? row.buyerAgentId : row.sellerAgentId;
            if (!expectedAgent || actualAgent === null || !sameId(actualAgent, expectedAgent)) throw fail();
        } else if (scope?.name === "task_list_for_organization") {
            if (!scope.principal.organizationId || row.organizationId === null || !sameId(row.organizationId, scope.principal.organizationId)) throw fail();
        } else if (scope?.name === "task_market_list") {
            if (status !== 0) throw fail();
        }
    }
    const requestedLimit = args.limit;
    if (typeof requestedLimit === "number" && value.length > Math.min(50, Math.max(1, requestedLimit))) throw fail();
    return value;
}
function sanitizeTaskMarketStats(value: unknown): unknown {
    const row = obj(value, ["openOffers", "accepted", "delivered", "disputed", "settled", "refunded", "cancelled", "totalEscrowedMist", "totalSettledMist", "settledLast24h", "activeAgents"]);
    for (const key of ["openOffers", "accepted", "delivered", "disputed", "settled", "refunded", "cancelled", "settledLast24h", "activeAgents"] as const) numberOrDecimal(row[key]);
    for (const key of ["totalEscrowedMist", "totalSettledMist"] as const) decimal(row[key]);
    return row;
}
function sanitizeTopAgents(value: unknown, args: Record<string, unknown>): unknown {
    if (!Array.isArray(value) || value.length > 50) throw fail();
    const sort = args.sort === undefined ? "score" : args.sort;
    if (sort !== "score" && sort !== "reviews" && sort !== "volume") throw fail();
    const minReviews = args.min_reviews === undefined ? 0n : BigInt(String(integer(args.min_reviews, 0, 1_000_000)));
    let previous: { agentId: string; reviews: bigint; score: bigint; volume: bigint } | undefined;
    const seen = new Set<string>();
    for (const item of value) {
        const row = obj(item, ["sellerAccountId", "agentObjectId", "capabilities", "expiresAtMs", "label", "principal", "organizationId", "reviewCount", "scoreMilli", "score", "confidenceBps", "settledCount", "volumeMist", "credibilityBps"]);
        for (const key of ["sellerAccountId", "agentObjectId", "principal"] as const) address(row[key]);
        maybeAddress(row.organizationId); nullableNumberOrDecimal(row.expiresAtMs);
        for (const key of ["capabilities", "reviewCount", "scoreMilli", "confidenceBps", "settledCount", "credibilityBps"] as const) numberOrDecimal(row[key]);
        decimal(row.volumeMist); text(row.label, 512);
        if (typeof row.score !== "number" || !Number.isFinite(row.score) || row.score < 0 || row.score > 5) throw fail();
        const reviews = BigInt(String(row.reviewCount));
        const score = BigInt(String(row.scoreMilli));
        const volume = BigInt(decimal(row.volumeMist));
        const confidence = BigInt(String(row.confidenceBps));
        const settled = BigInt(String(row.settledCount));
        const credibility = BigInt(String(row.credibilityBps));
        const agentId = normalize(row.agentObjectId);
        if (reviews < minReviews || score < 0n || score > 5_000n || row.score !== Number(score) / 1_000
            || confidence < 0n || confidence > 10_000n || settled < 0n || credibility < 0n || credibility > 10_000n
            || seen.has(agentId)) throw fail();
        if (previous) {
            const order = sort === "reviews"
                ? reviews < previous.reviews || reviews === previous.reviews && (score < previous.score || score === previous.score && agentId <= previous.agentId)
                : sort === "volume"
                    ? volume > previous.volume || volume === previous.volume && (score < previous.score || score === previous.score && agentId <= previous.agentId)
                    : score < previous.score || score === previous.score && (reviews < previous.reviews || reviews === previous.reviews && agentId <= previous.agentId);
            if (order) throw fail();
        }
        seen.add(agentId);
        previous = { agentId, reviews, score, volume };
    }
    if (typeof args.limit === "number" && value.length > Math.min(50, Math.max(1, args.limit))) throw fail();
    return value;
}

function sanitizeJuryList(name: string, value: unknown, args: Record<string, unknown>): unknown {
    if (!Array.isArray(value) || value.length > 200) throw fail();
    if (name === "jury_list_assignments") {
        for (const item of value) {
            const row = obj(item, ["caseId", "round", "agentId", "status", "dutyKind", "deadlineMs", "commitment", "revealed", "caseState", "subjectKind", "subjectId"]);
            address(row.caseId); address(row.agentId); address(row.subjectId);
            integer(Number(row.status), 1, 6); integer(Number(row.caseState), 1, 8); integer(Number(row.subjectKind), 1, 2);
            numberOrDecimal(row.round); nullableNumberOrDecimal(row.deadlineMs);
            if (row.dutyKind !== null && !["accept", "commit", "reveal"].includes(String(row.dutyKind))) throw fail();
            if (row.commitment !== null) text(row.commitment, 256);
            if (typeof row.revealed !== "boolean") throw fail();
        }
    } else if (name === "jury_list_roster") {
        for (const item of value) {
            const row = obj(item, ["agentId", "owner", "memoryAccountId", "organizationId", "payoutAddress", "modelFamily", "exempt", "status", "suspendedUntilMs", "dutyScore", "strikes", "joinedAtMs", "leftAtMs"]);
            for (const key of ["agentId", "owner", "memoryAccountId", "organizationId", "payoutAddress"] as const) address(row[key]);
            integer(Number(row.modelFamily), 0, 255);
            if (typeof row.exempt !== "boolean" || ![0, 1, 3].includes(Number(row.status))) throw fail();
            nullableNumberOrDecimal(row.suspendedUntilMs); nullableNumberOrDecimal(row.dutyScore); nullableNumberOrDecimal(row.leftAtMs);
            numberOrDecimal(row.strikes); numberOrDecimal(row.joinedAtMs);
        }
    } else throw fail();
    if (typeof args.limit === "number" && value.length > Math.min(200, Math.max(1, args.limit))) throw fail();
    return value;
}

export function sanitizeTaskMarketRead(name: string, value: unknown, args: Record<string, unknown>, principal?: TaskListPrincipal): unknown {
    if (["task_list", "task_list_for_agent", "task_list_for_organization", "task_market_list"].includes(name)) return sanitizeTaskList(value, args, { name, principal: principal ?? {} });
    if (name === "task_market_get_stats") return sanitizeTaskMarketStats(value);
    if (name === "task_market_list_sellers") return sanitizeTopAgents(value, args);
    if (name === "task_get_config") return sanitizeTaskConfig(value);
    throw fail();
}

function sanitizeTaskConfig(value: unknown): unknown {
    const fields = ["updatedBy", "platformFeeBps", "ecosystemFeeBps", "ecosystemFeeRecipient", "minEscrowMist", "acceptWindowMinMs", "acceptWindowDefaultMs", "acceptWindowMaxMs", "deliveryWindowMinMs", "deliveryWindowMaxMs", "settleWindowMinMs", "settleWindowMaxMs", "releaseGraceMs", "reviewWindowMs", "maxTitleBytes", "maxUriBytes", "active", "priorMeanMilli", "priorWeightBps", "valueRefMist", "minValueWeightBps", "maxValueWeightBps", "credBaseBps", "credStepBps", "credCapN", "credMaxBps", "overallSellerWeightBps", "overallBuyerWeightBps", "timestampMs", "transactionId"] as const;
    const row = obj(value, fields);
    address(row.updatedBy); address(row.ecosystemFeeRecipient); digest(row.transactionId);
    const numeric = Object.fromEntries(fields.filter((key) => !["updatedBy", "ecosystemFeeRecipient", "active", "transactionId", "minEscrowMist", "valueRefMist"].includes(key)).map((key) => [key, integer(row[key], 0)])) as Record<string, number>;
    const minEscrowMist = BigInt(decimal(row.minEscrowMist));
    const valueRefMist = BigInt(decimal(row.valueRefMist));
    if (typeof row.active !== "boolean"
        || numeric.platformFeeBps > 10_000 || numeric.ecosystemFeeBps > 10_000 || numeric.platformFeeBps + numeric.ecosystemFeeBps > 10_000
        || minEscrowMist < 1n
        || numeric.acceptWindowMinMs < 1 || numeric.acceptWindowMinMs > numeric.acceptWindowDefaultMs || numeric.acceptWindowDefaultMs > numeric.acceptWindowMaxMs
        || numeric.deliveryWindowMinMs < 1 || numeric.deliveryWindowMinMs > numeric.deliveryWindowMaxMs
        || numeric.settleWindowMinMs < 1 || numeric.settleWindowMinMs > numeric.settleWindowMaxMs
        || numeric.releaseGraceMs > 2_592_000_000 || numeric.reviewWindowMs < 1 || numeric.reviewWindowMs > 31_536_000_000
        || numeric.maxTitleBytes < 1 || numeric.maxUriBytes < 1
        || numeric.priorMeanMilli < 1_000 || numeric.priorMeanMilli > 5_000 || numeric.priorWeightBps < 1 || numeric.priorWeightBps > 1_000_000
        || valueRefMist < 1n || numeric.minValueWeightBps < 1 || numeric.minValueWeightBps > numeric.maxValueWeightBps || numeric.maxValueWeightBps > 100_000
        || numeric.credBaseBps < 1 || numeric.credBaseBps > numeric.credMaxBps || numeric.credMaxBps > 10_000 || numeric.credStepBps > 10_000 || numeric.credCapN > 10_000
        || numeric.overallSellerWeightBps > 10_000 || numeric.overallBuyerWeightBps > 10_000 || numeric.overallSellerWeightBps + numeric.overallBuyerWeightBps !== 10_000) throw fail();
    return row;
}

export function sanitizeJuryListRead(name: string, value: unknown, args: Record<string, unknown>, principal?: { owner?: string; agentId?: string }): unknown {
    const result = sanitizeJuryList(name, value, args) as unknown[];
    const requestedStatuses = typeof args.status === "string" ? new Set(args.status.split(",").map(Number)) : undefined;
    for (const item of result) {
        const row = item as Record<string, unknown>;
        if (requestedStatuses && !requestedStatuses.has(Number(row.status))) throw fail();
        if (name === "jury_list_assignments") {
            if (!principal?.agentId || !sameId(row.agentId, principal.agentId)) throw fail();
        } else if (name === "jury_list_roster") {
            if (!principal?.owner || !sameId(row.owner, principal.owner)) throw fail();
        } else throw fail();
    }
    return result;
}

export function sanitizeJuryHealth(value: unknown, args: Record<string, unknown>): unknown {
    const row = obj(value, ["status", "reasons", "unsentEvents", "oldestUnsentEventMs", "overdueCranks", "roster"]);
    if (!["ok", "warn", "critical"].includes(String(row.status)) || !Array.isArray(row.reasons) || row.reasons.length > 32
        || row.reasons.some((reason) => typeof reason !== "string" || reason.length > 512)) throw fail();
    integer(row.unsentEvents, 0);
    if (row.oldestUnsentEventMs !== null) integer(row.oldestUnsentEventMs, 0);
    if (!Array.isArray(row.overdueCranks) || row.overdueCranks.length > 32) throw fail();
    for (const raw of row.overdueCranks) {
        const crank = obj(raw, ["kind", "count", "oldestOverdueMs"]);
        text(crank.kind, 128); integer(crank.count, 1); integer(crank.oldestOverdueMs, 1);
    }
    const roster = obj(row.roster, ["active", "suspended", "eligibleOwners", "minimum"]);
    integer(roster.active, 0); integer(roster.suspended, 0); integer(roster.eligibleOwners, 0);
    const minimum = args.min_roster ?? 20;
    if (!Number.isSafeInteger(minimum) || roster.minimum !== minimum) throw fail();
    integer(roster.minimum, 0, 10_000);
    return row;
}

const juryCaseFields = ["caseId", "subjectKind", "subjectId", "stage", "menuLen", "approvalBps", "quorum", "roundSizes", "appealable", "failurePath", "openedBy", "feeMist", "createdAtMs", "evidenceDeadlineMs", "state", "currentRound", "finalOutcome", "appealsUsed", "failedAppeal", "participants", "perJurorFeeMist", "failReason", "finalizedAtMs", "cancelledAtMs", "transactionId"] as const;
function sanitizeJuryCaseRow(value: unknown): Record<string, unknown> {
    const row = obj(value, juryCaseFields);
    address(row.caseId); address(row.subjectId); address(row.openedBy); digest(row.transactionId);
    integer(row.subjectKind, 1, 2); integer(row.stage, 0, 32); integer(row.menuLen, 0, 32);
    integer(row.approvalBps, 0, 10_000); integer(row.quorum, 0); integer(row.failurePath, 0, 32);
    integer(row.feeMist, 0); integer(row.createdAtMs, 0); integer(row.evidenceDeadlineMs, 0);
    integer(row.state, 1, 8); integer(row.currentRound, 0); integer(row.appealsUsed, 0);
    if (typeof row.appealable !== "boolean" || typeof row.failedAppeal !== "boolean" || !Array.isArray(row.roundSizes) || row.roundSizes.length > 32) throw fail();
    for (const size of row.roundSizes) integer(size, 0);
    for (const key of ["finalOutcome", "participants", "perJurorFeeMist", "failReason", "finalizedAtMs", "cancelledAtMs"] as const) if (row[key] !== null) integer(row[key], 0);
    return row;
}

export function sanitizeJuryCasesRead(name: string, value: unknown, args: Record<string, unknown>): unknown {
    if (name === "jury_get_case") {
        const row = obj(value, [...juryCaseFields, "rounds", "jurors", "evidence", "payouts"]);
        const caseRow = sanitizeJuryCaseRow(Object.fromEntries(juryCaseFields.map((key) => [key, row[key]])));
        if (!sameId(caseRow.caseId, args.id)) throw fail();
        for (const key of ["rounds", "jurors", "evidence", "payouts"] as const) if (!Array.isArray(row[key]) || row[key].length > 1000) throw fail();
        walk(row.rounds); walk(row.jurors); walk(row.evidence); walk(row.payouts);
        return row;
    }
    if (!Array.isArray(value) || value.length > 100) throw fail();
    const states = typeof args.state === "string" ? args.state.split(",").map(Number) : [];
    const subjectId = args.subject_id;
    for (const item of value) {
        const row = sanitizeJuryCaseRow(item);
        if (typeof args.subject_kind === "number" && row.subjectKind !== args.subject_kind
            || typeof subjectId === "string" && !sameId(row.subjectId, subjectId)
            || states.length > 0 && !states.includes(row.state as number)) throw fail();
    }
    if (typeof args.limit === "number" && value.length > Math.min(100, args.limit)) throw fail();
    return value;
}

function canonicalBundleJson(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(canonicalBundleJson).join(",")}]`;
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonicalBundleJson(row[key])}`).join(",")}}`;
}

export function sanitizeJuryCaseBundle(value: unknown, args: Record<string, unknown>): unknown {
    const outer = obj(value, ["bundle", "digestHex"]);
    if (typeof outer.digestHex !== "string" || !/^[0-9a-f]{64}$/i.test(outer.digestHex)) throw fail();
    const bundle = obj(outer.bundle, ["version", "caseId", "round", "subjectKind", "stage", "menu", "subject", "verifiedFacts", "evidence"]);
    if (bundle.version !== 1 || !sameId(bundle.caseId, args.id) || integer(bundle.round, 0, 255) !== args.round) throw fail();
    const subjectKind = integer(bundle.subjectKind, 1, 2);
    integer(bundle.stage, 0, 255);
    const menu = bundle.menu;
    if (!Array.isArray(menu) || menu.length < 1 || menu.length > 16) throw fail();
    for (let index = 0; index < menu.length; index++) {
        const option = obj(menu[index], ["index", "label"]);
        if (integer(option.index, 0, 15) !== index) throw fail();
        text(option.label, 256);
    }
    const subject = bundle.subject;
    if (!subject || typeof subject !== "object" || Array.isArray(subject)) throw fail();
    const facts = bundle.verifiedFacts;
    if (!facts || typeof facts !== "object" || Array.isArray(facts)) throw fail();
    const allowedSubject = subjectKind === 1
        ? ["taskId", "title", "amountMist", "status", "scopeDigest", "termsDigest", "deliverableDigest", "deliverableUri", "deliveredAtMs", "deliveryDeadlineMs", "settleDeadlineMs", "buyerPrincipal", "sellerPrincipal"]
        : ["object_id", "title", "description", "proposal_type", "status", "submitter", "metadata_json", "reference_id"];
    if (Object.keys(subject as object).some((key) => !allowedSubject.includes(key))) throw fail();
    if (subjectKind === 1 && Object.keys(facts as object).some((key) => !["amountMist", "deliveredOnTime"].includes(key))
        || subjectKind === 2 && Object.keys(facts as object).some((key) => !["community_votes_for", "community_votes_against", "delegate_approval_count", "delegate_rejection_count", "voting_end_time", "stage"].includes(key))) throw fail();
    walk(subject); walk(facts);
    if (!Array.isArray(bundle.evidence) || bundle.evidence.length > 1000) throw fail();
    let previous = -1;
    for (const raw of bundle.evidence) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw fail();
        const evidence = obj(raw, "excerpt" in raw
            ? ["index", "kind", "submitter", "round", "uri", "digest", "status", "excerpt"]
            : ["index", "kind", "submitter", "round", "uri", "digest", "status"]);
        const index = integer(evidence.index, 0);
        if (index <= previous) throw fail();
        previous = index;
        integer(evidence.kind, 0, 255); address(evidence.submitter); integer(evidence.round, 0, 255);
        text(evidence.uri, 2048);
        if (typeof evidence.digest !== "string" || !/^(?:0x)?[0-9a-f]{64}$/i.test(evidence.digest)) throw fail();
        if (!["verified", "mismatch", "unavailable"].includes(String(evidence.status))) throw fail();
        if ("excerpt" in evidence) {
            if (evidence.status !== "verified") throw fail();
            text(evidence.excerpt, 4000);
        }
    }
    const actual = createHash("sha256").update(canonicalBundleJson(bundle), "utf8").digest("hex");
    if (actual !== outer.digestHex.toLowerCase()) throw fail();
    return outer;
}

export function sanitizeJuryOwnProfile(value: unknown, expectedAgentId: string): unknown {
    const row = obj(value, ["agentId", "owner", "memoryAccountId", "organizationId", "payoutAddress", "modelFamily", "exempt", "status", "suspendedUntilMs", "dutyScore", "strikes", "joinedAtMs", "leftAtMs"]);
    for (const key of ["agentId", "owner", "memoryAccountId", "organizationId", "payoutAddress"] as const) address(row[key]);
    if (!sameId(row.agentId, expectedAgentId) || typeof row.exempt !== "boolean") throw fail();
    integer(row.modelFamily, 0, 32); integer(row.status, 0, 3); integer(row.strikes, 0); integer(row.joinedAtMs, 0);
    for (const key of ["suspendedUntilMs", "dutyScore", "leftAtMs"] as const) if (row[key] !== null) integer(row[key], 0);
    if (![0, 1, 3].includes(row.status as number)) throw fail();
    return row;
}

export function sanitizeJuryRationales(value: unknown, args: Record<string, unknown>): unknown {
    if (!Array.isArray(value) || value.length > 1024) throw fail();
    for (const raw of value) {
        const row = obj(raw, ["round", "agentId", "outcome", "rationaleDigest", "revealedAtMs", "rationale"]);
        integer(row.round, 0); address(row.agentId);
        if (row.outcome !== null) integer(row.outcome, 0, 32);
        if (row.rationaleDigest !== null && (typeof row.rationaleDigest !== "string" || !/^[0-9a-f]{64}$/i.test(row.rationaleDigest))) throw fail();
        if (row.revealedAtMs !== null) integer(row.revealedAtMs, 0);
        if (row.rationale !== null) {
            const rationale = text(row.rationale, 16_384);
            if (typeof row.rationaleDigest !== "string" || createHash("sha256").update(rationale, "utf8").digest("hex") !== row.rationaleDigest.toLowerCase()) throw fail();
        }
    }
    void args;
    return value;
}

export function sanitizeJuryCranks(value: unknown, args: Record<string, unknown>): unknown {
    const maxLimit = typeof args.limit === "number" ? Math.min(100, Math.max(1, args.limit)) : 20;
    if (!Array.isArray(value) || value.length > maxLimit * 8) throw fail();
    const kinds = new Set(["select_due", "replace_due", "round_finalize_due", "case_finalize_due", "execute_ready", "neutral_start_due", "neutral_due", "fees_due"]);
    const optional = ["closeCaseFirst", "registryId", "platformId", "stage", "buyerAccountId", "sellerAccountId", "memoryAccountId"];
    for (const raw of value) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw fail();
        const row = raw as Record<string, unknown>;
        const required = ["kind", "caseId", "round", "subjectKind", "subjectId", "dueMs"];
        if (required.some((key) => !(key in row)) || Object.keys(row).some((key) => !required.includes(key) && !optional.includes(key))) throw fail();
        if (!kinds.has(String(row.kind)) || (row.kind === "fees_due") !== ("closeCaseFirst" in row)) throw fail();
        address(row.caseId); address(row.subjectId); integer(row.round, 0); integer(row.subjectKind, 1, 2); integer(row.dueMs, 0);
        if ("closeCaseFirst" in row && typeof row.closeCaseFirst !== "boolean") throw fail();
        for (const key of ["registryId", "platformId", "buyerAccountId", "sellerAccountId", "memoryAccountId"] as const) if (key in row) address(row[key]);
        if ("stage" in row) integer(row.stage, 0, 32);
    }
    return value;
}

function sanitizeProposalRefund(input: unknown): Record<string, unknown> {
    const row = obj(input, ["submitter", "submitterRefundMist", "voterRefundPoolMist", "outstandingMist", "claimDeadlineMs", "refundedAtMs", "sweptAtMs"]);
    address(row.submitter);
    for (const key of ["submitterRefundMist", "voterRefundPoolMist", "outstandingMist", "claimDeadlineMs", "refundedAtMs"] as const) numberOrDecimal(row[key]);
    nullableNumberOrDecimal(row.sweptAtMs);
    return row;
}

export function sanitizeProposalJuryRead(name: string, value: unknown, args: Record<string, unknown>): unknown {
    if (name === "jury_get_proposal_case") {
        const row = obj(value, ["reviews", "referrals", "refund"]);
        if (!Array.isArray(row.reviews) || row.reviews.length > 2 || !Array.isArray(row.referrals) || row.referrals.length > 1000) throw fail();
        for (const raw of row.reviews) {
            const review = obj(raw, ["proposalId", "stage", "state", "trigger", "caseId", "referralCount", "escalatedAtMs", "decidedAtMs", "decision", "failed", "unavailableAtMs", "deferredSinceMs", "formableSeats", "requiredSeats", "resolvedByWait"]);
            if (!sameId(review.proposalId, args.id)) throw fail();
            integer(review.stage, 1, 2); integer(review.state, 1, 4); integer(review.trigger, 0, 32);
            if (review.caseId !== null) address(review.caseId);
            numberOrDecimal(review.referralCount);
            for (const key of ["escalatedAtMs", "decidedAtMs", "decision", "unavailableAtMs", "deferredSinceMs", "formableSeats", "requiredSeats"] as const) nullableNumberOrDecimal(review[key]);
            if (typeof review.failed !== "boolean" || typeof review.resolvedByWait !== "boolean") throw fail();
            const resolvedByWait = review.state === 4 && review.caseId === null && review.deferredSinceMs !== null;
            if (review.resolvedByWait !== resolvedByWait) throw fail();
        }
        for (const raw of row.referrals) {
            const referral = obj(raw, ["delegateAddress", "reason", "referredAtMs"]);
            address(referral.delegateAddress);
            if (referral.reason !== null) text(referral.reason, 2048);
            numberOrDecimal(referral.referredAtMs);
        }
        if (row.refund !== null) sanitizeProposalRefund(row.refund);
        return row;
    }
    const row = obj(value, ["refund", "voters"]);
    if (!Array.isArray(row.voters) || row.voters.length > 100_000) throw fail();
    if (row.refund === null && row.voters.length !== 0) throw fail();
    if (row.refund !== null) sanitizeProposalRefund(row.refund);
    for (const raw of row.voters) {
        const voter = obj(raw, ["voter", "amountMist", "claimedAtMs"]);
        address(voter.voter); numberOrDecimal(voter.amountMist); nullableNumberOrDecimal(voter.claimedAtMs);
    }
    return row;
}

export function sanitizeJuryTaskDispute(value: unknown, args: Record<string, unknown>): unknown {
    const row = obj(value, ["taskId", "caseId", "openedByRole", "state", "feeEachMist", "buyerPaidMist", "sellerPaidMist", "openedAtMs", "neutralWindowEndsMs", "agreementProposer", "agreementOutcome", "resolvedOutcome", "resolvedSource", "resolvedAtMs", "feesSettled", "buyerFeeRefundMist", "sellerFeeRefundMist", "case"]);
    if (!sameId(row.taskId, args.id)) throw fail();
    address(row.caseId); integer(Number(row.openedByRole), 1, 2); integer(Number(row.state), 0, 8);
    for (const key of ["feeEachMist", "buyerPaidMist", "sellerPaidMist"] as const) decimal(row[key]);
    numberOrDecimal(row.openedAtMs); integer(Number(row.agreementProposer), 0, 2);
    for (const key of ["neutralWindowEndsMs", "agreementOutcome", "resolvedOutcome", "resolvedSource", "resolvedAtMs"] as const) nullableNumberOrDecimal(row[key]);
    for (const key of ["buyerFeeRefundMist", "sellerFeeRefundMist"] as const) if (row[key] !== null) decimal(row[key]);
    if (typeof row.feesSettled !== "boolean") throw fail();
    if (row.case !== null) {
        const caseRow = sanitizeJuryCaseDetail(row.case);
        if (!sameId(caseRow.caseId, row.caseId) || caseRow.subjectKind !== 1 || !sameId(caseRow.subjectId, row.taskId)) throw fail();
    }
    return row;
}

export function sanitizeTaskRoomRead(value: unknown, args: Record<string, unknown>): unknown {
    const row = obj(value, ["taskId", "groupId", "groupUuid", "evidenceSource", "messagingPermission"]);
    if (!sameId(row.taskId, args.id)) throw fail();
    address(row.groupId); text(row.groupUuid, 128);
    if ((row.groupUuid as string).length === 0 || row.evidenceSource !== "authorized_task_participant_and_social_indexer_room_binding" || row.messagingPermission !== "not_proven_by_this_read") throw fail();
    return row;
}

export function sanitizeTaskDetailRead(value: unknown, args: Record<string, unknown>): unknown {
    const row = obj(value, [...taskListFields, "reviews", "dispute"]);
    const task = Object.fromEntries(taskListFields.map((key) => [key, row[key]]));
    sanitizeTaskList([task], { id: args.id, limit: 1 });
    if (!sameId(row.taskId, args.id) || !Array.isArray(row.reviews) || row.reviews.length > 2) throw fail();
    for (const raw of row.reviews) {
        const review = obj(raw, ["taskId", "raterRole", "raterPrincipal", "raterAgentId", "revieweePrincipal", "revieweeAgentId", "stars", "raterCredibilityBps", "valueWeightBps", "baseWeightBps", "priorPairReviews", "weightBps", "reviewedAtMs", "transactionId"]);
        if (!sameId(review.taskId, row.taskId)) throw fail();
        for (const key of ["raterPrincipal", "revieweePrincipal"] as const) address(review[key]);
        for (const key of ["raterAgentId", "revieweeAgentId"] as const) maybeAddress(review[key]);
        integer(Number(review.raterRole), 0, 1); integer(Number(review.stars), 1, 5);
        for (const key of ["raterCredibilityBps", "valueWeightBps", "baseWeightBps", "priorPairReviews", "weightBps", "reviewedAtMs"] as const) numberOrDecimal(review[key]);
        digest(review.transactionId);
    }
    if (row.dispute !== null) {
        const dispute = obj(row.dispute, ["taskId", "caseId", "openedByRole", "state", "feeEachMist", "buyerPaidMist", "sellerPaidMist", "openedAtMs", "neutralWindowEndsMs", "agreementProposer", "agreementOutcome", "resolvedOutcome", "resolvedSource", "resolvedAtMs", "feesSettled", "buyerFeeRefundMist", "sellerFeeRefundMist"]);
        if (!sameId(dispute.taskId, row.taskId)) throw fail();
        address(dispute.caseId); integer(Number(dispute.openedByRole), 1, 2); integer(Number(dispute.state), 0, 8);
        for (const key of ["feeEachMist", "buyerPaidMist", "sellerPaidMist"] as const) decimal(dispute[key]);
        numberOrDecimal(dispute.openedAtMs); integer(Number(dispute.agreementProposer), 0, 2);
        for (const key of ["neutralWindowEndsMs", "agreementOutcome", "resolvedOutcome", "resolvedSource", "resolvedAtMs"] as const) nullableNumberOrDecimal(dispute[key]);
        for (const key of ["buyerFeeRefundMist", "sellerFeeRefundMist"] as const) if (dispute[key] !== null) decimal(dispute[key]);
        if (typeof dispute.feesSettled !== "boolean") throw fail();
    }
    return row;
}

export function sanitizeTaskDeliverableRead(value: unknown, args: Record<string, unknown>): unknown {
    const row = obj(value, ["taskId", "uri", "digestHex", "contentBase64", "contentLength", "encoding", "digestVerified", "verification", "disclosure"]);
    if (!sameId(row.taskId, args.id) || typeof row.uri !== "string" || !/^r2:\/\/0x[0-9a-f]{64}\/[0-9a-f]{64}$/i.test(row.uri) || typeof row.digestHex !== "string" || !/^[0-9a-f]{64}$/i.test(row.digestHex)) throw fail();
    if (typeof row.contentBase64 !== "string" || row.contentBase64.length > 4 * Math.ceil((512 * 1024) / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.contentBase64)) throw fail();
    const bytes = Buffer.from(row.contentBase64, "base64");
    if (bytes.length > 512 * 1024 || bytes.toString("base64") !== row.contentBase64 || integer(row.contentLength, 0, 512 * 1024) !== bytes.length) throw fail();
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== String(row.digestHex).toLowerCase() || row.encoding !== "base64" || row.digestVerified !== true || row.verification !== "finalized_task_delivery_event_and_r2_sha256" || row.disclosure !== "The private R2 task artifact is disclosed to the authenticated participant and connected MCP client.") throw fail();
    return row;
}

function sanitizeJuryCaseDetail(input: unknown): Record<string, unknown> {
    const row = obj(input, ["caseId", "subjectKind", "subjectId", "stage", "menuLen", "approvalBps", "quorum", "roundSizes", "appealable", "failurePath", "openedBy", "feeMist", "createdAtMs", "evidenceDeadlineMs", "state", "currentRound", "finalOutcome", "appealsUsed", "failedAppeal", "participants", "perJurorFeeMist", "failReason", "finalizedAtMs", "cancelledAtMs", "transactionId", "rounds", "jurors", "evidence", "payouts"]);
    address(row.caseId); address(row.subjectId); address(row.openedBy); digest(row.transactionId);
    integer(Number(row.subjectKind), 1, 2); integer(Number(row.state), 1, 8); integer(Number(row.stage), 0, 255); integer(Number(row.menuLen), 0, 255); integer(Number(row.approvalBps), 0, 10_000); numberOrDecimal(row.quorum); numberOrDecimal(row.failurePath); numberOrDecimal(row.createdAtMs); numberOrDecimal(row.evidenceDeadlineMs); numberOrDecimal(row.currentRound); numberOrDecimal(row.appealsUsed);
    decimal(row.feeMist);
    for (const key of ["finalOutcome", "participants", "perJurorFeeMist", "failReason", "finalizedAtMs", "cancelledAtMs"] as const) nullableNumberOrDecimal(row[key]);
    if (typeof row.appealable !== "boolean" || typeof row.failedAppeal !== "boolean" || !Array.isArray(row.roundSizes) || row.roundSizes.length > 16 || !Array.isArray(row.rounds) || row.rounds.length > 16 || !Array.isArray(row.jurors) || row.jurors.length > 256 || !Array.isArray(row.evidence) || row.evidence.length > 1000 || !Array.isArray(row.payouts) || row.payouts.length > 256) throw fail();
    for (const size of row.roundSizes) numberOrDecimal(size);
    for (const raw of row.rounds) {
        const round = obj(raw, ["round", "acceptDeadlineMs", "commitDeadlineMs", "revealDeadlineMs", "tally", "abstain", "revealed", "decisive", "leading", "appealDeadlineMs"]);
        numberOrDecimal(round.round); numberOrDecimal(round.acceptDeadlineMs);
        for (const key of ["commitDeadlineMs", "revealDeadlineMs", "abstain", "revealed", "leading", "appealDeadlineMs"] as const) nullableNumberOrDecimal(round[key]);
        if (round.tally !== null) { if (!Array.isArray(round.tally) || round.tally.length > 16) throw fail(); for (const n of round.tally) numberOrDecimal(n); }
        if (round.decisive !== null && typeof round.decisive !== "boolean") throw fail();
    }
    for (const raw of row.jurors) {
        const juror = obj(raw, ["round", "agentId", "status", "acceptDeadlineMs", "acceptedAtMs", "commitment", "outcome", "rationaleDigest", "evidenceRefs", "bundleDigest", "revealedAtMs"]);
        numberOrDecimal(juror.round); address(juror.agentId); integer(Number(juror.status), 1, 6); numberOrDecimal(juror.acceptDeadlineMs);
        for (const key of ["acceptedAtMs", "outcome", "revealedAtMs"] as const) nullableNumberOrDecimal(juror[key]);
        for (const key of ["commitment", "rationaleDigest", "bundleDigest"] as const) if (juror[key] !== null) text(juror[key], 256);
        if (juror.evidenceRefs !== null && (!Array.isArray(juror.evidenceRefs) || juror.evidenceRefs.length > 1000)) throw fail();
        if (Array.isArray(juror.evidenceRefs)) for (const ref of juror.evidenceRefs) numberOrDecimal(ref);
    }
    for (const raw of row.evidence) {
        const evidence = obj(raw, ["index", "submitter", "round", "kind", "digest", "uri", "submittedAtMs"]);
        address(evidence.submitter); integer(Number(evidence.index), 0); numberOrDecimal(evidence.round); numberOrDecimal(evidence.kind); text(evidence.digest, 256); text(evidence.uri, 2048); numberOrDecimal(evidence.submittedAtMs);
    }
    for (const raw of row.payouts) {
        const payout = obj(raw, ["agentId", "recipient", "amountMist"]);
        address(payout.agentId); address(payout.recipient); decimal(payout.amountMist);
    }
    return row;
}

export function sanitizeTaskDisputeRead(value: unknown, args: Record<string, unknown>): unknown {
    const row = obj(value, ["taskId", "caseId", "openedByRole", "state", "feeEachMist", "buyerPaidMist", "sellerPaidMist", "openedAtMs", "neutralWindowEndsMs", "agreementProposer", "agreementOutcome", "resolvedOutcome", "resolvedSource", "resolvedAtMs", "feesSettled", "buyerFeeRefundMist", "sellerFeeRefundMist", "case"]);
    if (!sameId(row.taskId, args.id)) throw fail();
    address(row.caseId); integer(Number(row.openedByRole), 1, 2); integer(Number(row.state), 0, 8);
    for (const key of ["feeEachMist", "buyerPaidMist", "sellerPaidMist"] as const) decimal(row[key]);
    numberOrDecimal(row.openedAtMs); integer(Number(row.agreementProposer), 0, 2);
    for (const key of ["neutralWindowEndsMs", "agreementOutcome", "resolvedOutcome", "resolvedSource", "resolvedAtMs"] as const) nullableNumberOrDecimal(row[key]);
    for (const key of ["buyerFeeRefundMist", "sellerFeeRefundMist"] as const) if (row[key] !== null) decimal(row[key]);
    if (typeof row.feesSettled !== "boolean") throw fail();
    if (row.case !== null) {
        const caseInfo = sanitizeJuryCaseDetail(row.case);
        if (!sameId(caseInfo.caseId, row.caseId) || !sameId(caseInfo.subjectId, row.taskId) || Number(caseInfo.subjectKind) !== 1) throw fail();
    }
    return row;
}

export function sanitizeTaskHistoryRead(name: string, value: unknown, args: Record<string, unknown>): unknown {
    const lifecycle = name === "task_get_lifecycle_history";
    const keys = lifecycle ? ["taskId", "events", "limit", "offset", "nextOffset", "evidenceSource"] : ["taskId", "events", "limit", "offset", "nextOffset"];
    const row = obj(value, keys);
    if (!sameId(row.taskId, args.id) || !Array.isArray(row.events) || row.events.length > 100) throw fail();
    const limit = integer(row.limit, 1, 100); const offset = integer(row.offset, 0, 100_000);
    if (typeof args.limit === "number" && limit > args.limit || typeof args.offset === "number" && offset !== args.offset || row.events.length > limit) throw fail();
    if (row.nextOffset !== null) {
        const nextOffset = integer(row.nextOffset, 0, 100_000);
        if (row.events.length !== limit || nextOffset !== offset + limit) throw fail();
    }
    if (lifecycle && row.evidenceSource !== "participant_indexed_history_with_fullnode_event_checks") throw fail();
    const allowed = new Set(["TaskOffered", "TaskAccepted", "TaskDelivered", "TaskReceiptSettled", "TaskRefunded", "TaskCancelled", "TaskDisputed"]);
    const seenTransitions = new Set<string>();
    let priorTime: bigint | undefined, priorType: string | undefined, priorSource: string | undefined;
    for (const item of row.events) {
        const eventKeys = lifecycle ? ["eventType", "occurredAtMs", "sourceEventId", "status", "verification", "digest", "checkpoint"] : ["eventType", "occurredAtMs", "sourceEventId", "status"];
        const event = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : null;
        if (!event || eventKeys.some((key) => !(key in event)) || Object.keys(event).some((key) => !eventKeys.includes(key))) throw fail();
        const eventType = text(event.eventType, 512);
        if (!allowed.has(eventType.split("::").at(-1)!)) throw fail();
        const occurredAt = BigInt(String(numberOrDecimal(event.occurredAtMs)));
        const sourceEventId = text(event.sourceEventId, 160);
        const transition = `${eventType}\u0000${sourceEventId}`;
        if (seenTransitions.has(transition)
            || priorTime !== undefined && (occurredAt < priorTime
                || occurredAt === priorTime && (eventType < priorType!
                    || eventType === priorType && sourceEventId < priorSource!))) throw fail();
        seenTransitions.add(transition);
        priorTime = occurredAt; priorType = eventType; priorSource = sourceEventId;
        if (event.status !== null) integer(Number(event.status), 0, 6);
        if (lifecycle) {
            if (!["indexer_preview", "fullnode_unavailable", "fullnode_mismatch", "checkpoint_pending_task_event", "failed_task_transaction", "finalized_fullnode_task_event", "fullnode_event_mismatch", "fullnode_unavailable_or_unknown"].includes(String(event.verification))) throw fail();
            if (event.digest !== null) digest(event.digest);
            if (event.checkpoint !== null) decimal(event.checkpoint);
        }
    }
    return row;
}

export function sanitizeTaskReceipt(value: unknown, args: Record<string, unknown>): unknown {
    const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
    if (!row) throw fail();
    const action = row.registryAction;
    const actionEvents = typeof action === "string" ? taskActions[action] : undefined;
    if (!actionEvents) throw fail();
    const delivery = action === "task.deliver.v1";
    const keys = delivery
        ? ["digest", "registryAction", "taskId", "caseId", "status", "checkpoint", "events", "evidenceSource", "currentTaskState", "deliverableDigestHex", "deliverableUri"]
        : ["digest", "registryAction", "taskId", "caseId", "status", "checkpoint", "events", "evidenceSource", "currentTaskState"];
    obj(row, keys);
    digest(row.digest);
    if (row.digest !== args.id || !["finalized", "checkpoint_pending", "failed", "unknown"].includes(String(row.status)) || !(row.checkpoint === null || typeof row.checkpoint === "string") || row.evidenceSource !== "configured_fullnode_and_scoped_action_record" || row.currentTaskState !== "not_checked" || !Array.isArray(row.events) || row.events.length > 20) throw fail();
    if (row.checkpoint !== null) decimal(row.checkpoint);
    maybeAddress(row.taskId); maybeAddress(row.caseId);
    if (row.status === "finalized" && row.events.length === 0) throw fail();
    const eventNames = new Set<string>();
    for (const raw of row.events) {
        const event = receiptEvent(raw);
        const type = event.type;
        const suffix = type.split("::").at(-1)!;
        const module = type.split("::").at(-2);
        if (module !== "agent_task" && module !== "jury" || !actionEvents.includes(suffix)) throw fail();
        eventNames.add(suffix);
        const data = event.data;
        if (row.taskId !== null && data.task_id !== undefined && !sameId(eventId(data.task_id), row.taskId)) throw fail();
        if (suffix === "CaseOpened" && row.taskId !== null && !sameId(eventId(data.subject_id), row.taskId)) throw fail();
        if (suffix === "TaskDisputed" && row.caseId !== null && !sameId(eventId(data.case_id), row.caseId)) throw fail();
        if (action === "task.accept_dispute_settlement.v1" && suffix === "TaskDisputeResolved") {
            address(data.case_id); integer(data.outcome, 0, 2);
            if (data.source !== 2) throw fail();
        }
        if (action === "task.accept_dispute_settlement.v1" && suffix === "TaskRefunded" && data.refund_kind !== 3) throw fail();
        if (action === "task.accept_dispute_settlement.v1" && suffix === "TaskReceiptSettled" && ![4, 6].includes(Number(data.settlement_kind))) throw fail();
        if (delivery && suffix === "TaskDelivered") {
            if (digestHex(data.deliverable_digest) !== row.deliverableDigestHex || data.deliverable_uri !== row.deliverableUri) throw fail();
        }
    }
    if (row.status === "finalized" && ["task.open_dispute.v1", "task.appeal.v1", "task.cancel_dispute.v1"].includes(String(action)) && actionEvents.some((event) => !eventNames.has(event))) throw fail();
    if (row.status === "finalized" && action === "task.accept_dispute_settlement.v1") {
        const resolved = (row.events as Array<{ type: string; data: Record<string, unknown> }>).find(event => event.type.endsWith("::agent_task::TaskDisputeResolved"));
        const outcome = resolved?.data.outcome;
        const expectedPayout = outcome === 1 ? "TaskRefunded" : "TaskReceiptSettled";
        const payout = (row.events as Array<{ type: string; data: Record<string, unknown> }>).find(event => event.type.endsWith(`::agent_task::${expectedPayout}`));
        const payoutMatches = outcome === 1 ? payout?.data.refund_kind === 3 : payout?.data.settlement_kind === (outcome === 0 ? 4 : 6);
        if (!eventNames.has("TaskDisputeResolved") || !eventNames.has(expectedPayout) || eventNames.has(expectedPayout === "TaskRefunded" ? "TaskReceiptSettled" : "TaskRefunded") || !payoutMatches) throw fail();
    }
    if (delivery) {
        if (typeof row.deliverableDigestHex !== "string" || !/^[0-9a-f]{64}$/.test(row.deliverableDigestHex) || typeof row.deliverableUri !== "string" || row.deliverableUri.length < 1 || row.deliverableUri.length > 2048) throw fail();
    }
    return row;
}

const receiptFields = ["taskId", "receiptId", "buyerPrincipal", "buyerAgentId", "sellerPrincipal", "sellerAgentId", "organizationId", "roomGroupId", "settlementKind", "amountMist", "platformFeeMist", "ecosystemFeeMist", "netAmountMist", "deliverableDigest", "deliverableUri", "buyerCredibilityBps", "sellerCredibilityBps", "settleDeadlineMs", "reviewDeadlineMs", "settledAtMs", "transactionId"] as const;
function validateSettlementReceipt(receipt: unknown, taskId: unknown): Record<string, unknown> {
    const row = obj(receipt, receiptFields);
    for (const key of ["taskId", "receiptId", "buyerPrincipal", "sellerPrincipal", "sellerAgentId"] as const) address(row[key]);
    for (const key of ["buyerAgentId", "organizationId", "roomGroupId"] as const) maybeAddress(row[key]);
    for (const key of ["amountMist", "platformFeeMist", "ecosystemFeeMist", "netAmountMist"] as const) decimal(row[key]);
    for (const key of ["settlementKind", "buyerCredibilityBps", "sellerCredibilityBps", "settleDeadlineMs", "reviewDeadlineMs", "settledAtMs"] as const) decimal(row[key]);
    if (!sameId(row.taskId, taskId) || !sameId(row.receiptId, taskId)) throw fail();
    if (row.deliverableDigest !== null) digestHex(row.deliverableDigest);
    if (row.deliverableUri !== null) text(row.deliverableUri, 2048);
    digest(row.transactionId);
    return row;
}
export function sanitizeTaskSettlementReceipt(value: unknown, args: Record<string, unknown>): unknown {
    const base = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
    if (!base) throw fail();
    if (base.settled === false) {
        const row = obj(base, ["taskId", "settled", "status", "receipt", "verification"]);
        if (!sameId(row.taskId, args.id) || row.receipt !== null || row.verification !== "task_not_indexed_as_settled") throw fail();
        integer(row.status, 0, 6);
        return row;
    }
    const row = obj(base, ["taskId", "settled", "status", "receipt", "transactionDigest", "checkpoint", "event", "verification"]);
    if (row.settled !== true || !sameId(row.taskId, args.id) || row.status !== 3 || row.verification !== "finalized_fullnode_task_receipt_settled_event") throw fail();
    const receipt = validateSettlementReceipt(row.receipt, row.taskId);
    digest(row.transactionDigest); digest(receipt.transactionId);
    if (row.transactionDigest !== receipt.transactionId) throw fail();
    decimal(row.checkpoint);
    const event = obj(row.event, ["task_id", "receipt_id", "buyer_principal", "buyer_agent_id", "seller_principal", "seller_agent_id", "organization_id", "room_group_id", "settlement_kind", "amount_mist", "platform_fee_mist", "ecosystem_fee_mist", "net_amount_mist", "deliverable_digest", "deliverable_uri", "buyer_credibility_bps", "seller_credibility_bps", "settle_deadline_ms", "review_deadline_ms", "settled_at_ms"]);
    if (!sameId(eventId(event.task_id), receipt.taskId) || !sameId(eventId(event.receipt_id), receipt.receiptId)) throw fail();
    for (const [eventKey, receiptKey] of [["buyer_principal", "buyerPrincipal"], ["seller_principal", "sellerPrincipal"], ["seller_agent_id", "sellerAgentId"]] as const) if (!sameId(eventId(event[eventKey]), receipt[receiptKey])) throw fail();
    for (const [eventKey, receiptKey] of [["buyer_agent_id", "buyerAgentId"], ["organization_id", "organizationId"], ["room_group_id", "roomGroupId"]] as const) {
        const left = event[eventKey] === null ? null : eventId(event[eventKey]); const right = receipt[receiptKey] === null ? null : receipt[receiptKey];
        if (left === null ? right !== null : right === null || !sameId(left, right)) throw fail();
    }
    for (const [eventKey, receiptKey] of [["settlement_kind", "settlementKind"], ["amount_mist", "amountMist"], ["platform_fee_mist", "platformFeeMist"], ["ecosystem_fee_mist", "ecosystemFeeMist"], ["net_amount_mist", "netAmountMist"], ["buyer_credibility_bps", "buyerCredibilityBps"], ["seller_credibility_bps", "sellerCredibilityBps"], ["settle_deadline_ms", "settleDeadlineMs"], ["review_deadline_ms", "reviewDeadlineMs"], ["settled_at_ms", "settledAtMs"]] as const) if (decimal(event[eventKey]) !== decimal(receipt[receiptKey])) throw fail();
    if (event.deliverable_digest === null ? receipt.deliverableDigest !== null : digestHex(event.deliverable_digest) !== digestHex(receipt.deliverableDigest)) throw fail();
    if (event.deliverable_uri !== receipt.deliverableUri) throw fail();
    return row;
}

export function sanitizeJuryReceipt(value: unknown, args: Record<string, unknown>): unknown {
    const row = obj(value, ["digest", "registryAction", "caseId", "taskId", "proposalId", "registryId", "jurorId", "subjectAgentId", "status", "checkpoint", "events", "evidenceSource"]);
    const action = typeof row.registryAction === "string" ? juryEvents[row.registryAction] : undefined;
    if (!action || row.digest !== args.id || !["finalized", "checkpoint_pending", "failed", "unknown"].includes(String(row.status)) || !(row.checkpoint === null || typeof row.checkpoint === "string") || !Array.isArray(row.events) || row.events.length > 100 || row.evidenceSource !== "configured_fullnode_and_scoped_jury_action") throw fail();
    digest(row.digest); if (row.checkpoint !== null) decimal(row.checkpoint);
    for (const key of ["caseId", "taskId", "proposalId", "registryId", "jurorId", "subjectAgentId"] as const) maybeAddress(row[key]);
    if (row.status === "finalized" && row.events.length === 0) throw fail();
    if (JSON.stringify(row).length > 512 * 1024) throw fail();
    for (const raw of row.events) {
        const event = receiptEvent(raw);
        const parts = event.type.split("::");
        if (parts.length < 3 || parts.at(-2) !== action.module || !action.names.includes(parts.at(-1)!)) throw fail();
        const data = event.data;
        for (const [key, expected] of [["case_id", row.caseId], ["task_id", row.taskId], ["proposal_id", row.proposalId]] as const) {
            if (expected !== null && data[key] !== undefined) {
                const observed = key === "case_id" && data[key] && typeof data[key] === "object" ? (data[key] as Record<string, unknown>).Some ?? data[key] : data[key];
                if (!sameId(eventId(observed), expected)) throw fail();
            }
        }
        const expectedAgent = row.jurorId ?? row.subjectAgentId;
        if (expectedAgent !== null && data.agent_id !== undefined && !sameId(eventId(data.agent_id), expectedAgent)) throw fail();
    }
    return row;
}
