import { McpRuntimeError } from "./errors.js";

const RUN_STATUSES = new Set(["planned", "running", "yielded", "waiting_for_input", "waiting_for_approval", "reconciling", "delivered", "settled", "disputed", "refunded", "cancelled", "failed", "completed"]);
const OPERATION_STATUSES = new Set(["pending", "succeeded", "failed", "reconciling"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(): never {
    throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Work journal response did not match its scoped read contract.", { retryable: false });
}

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
    return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
    const allowed = new Set([...required, ...optional]);
    if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) fail();
}

function text(value: unknown, max = 4096): value is string {
    return typeof value === "string" && value.length <= max;
}

function positiveInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) > 0;
}

function timestamp(value: unknown): boolean {
    return text(value, 64) && Number.isFinite(Date.parse(value));
}

function digest(value: unknown): boolean {
    return text(value, 64) && /^[0-9a-f]{64}$/i.test(value);
}

function boundedJson(value: unknown, max = 131072): void {
    let encoded: string;
    try { encoded = JSON.stringify(value); } catch { return fail(); }
    if (encoded.length > max) fail();
}

function normalizedId(value: string): string {
    return value.replace(/^0x/i, "").replace(/^0+/, "").toLowerCase() || "0";
}

function validateRun(value: unknown, expectedId?: string): Record<string, unknown> {
    const row = object(value);
    exactKeys(row, ["id", "scope", "revision", "status", "cancelRequestedAt", "createdAt", "updatedAt", "plan", "stepStatus", "stepEvidence", "artifacts", "receipts"], ["gasBudgetMist", "taskId", "taskRole", "roomId", "taskHistory", "verifiedTaskState", "taskLifecycleEvents", "messages", "completedAt"]);
    if (!text(row.id, 36) || !UUID.test(row.id) || (expectedId && row.id.toLowerCase() !== expectedId.toLowerCase())
        || !positiveInteger(row.revision) || !text(row.status, 32) || !RUN_STATUSES.has(row.status)
        || !(row.cancelRequestedAt === null || timestamp(row.cancelRequestedAt)) || !timestamp(row.createdAt) || !timestamp(row.updatedAt)) fail();
    if (row.gasBudgetMist !== undefined && !boundedDecimal(row.gasBudgetMist)) fail();
    if (row.completedAt !== undefined && !timestamp(row.completedAt)) fail();

    const scope = object(row.scope);
    exactKeys(scope, ["network", "owner", "accountId", "agentId"], ["organizationId", "platformId"]);
    for (const key of ["network", "owner", "accountId", "agentId", "organizationId", "platformId"] as const) {
        if (scope[key] !== undefined && !text(scope[key], 128)) fail();
    }

    const plan = object(row.plan);
    exactKeys(plan, ["version", "goal", "steps"]);
    if (!positiveInteger(plan.version) || !text(plan.goal, 10000) || plan.goal.length === 0 || !Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > 100) fail();
    const stepIds = new Set<string>();
    for (const rawStep of plan.steps) {
        const step = object(rawStep);
        exactKeys(step, ["id", "title", "dependsOn", "acceptanceCriteria"], ["aiBudgetMist", "actionBudgetMist", "taskEvidenceEvents", "taskEvidenceEventAlternatives", "assigneeAgentId", "deadline"]);
        if (!text(step.id, 64) || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(step.id) || stepIds.has(step.id) || !text(step.title, 200) || step.title.length === 0
            || !Array.isArray(step.dependsOn) || step.dependsOn.length > 100 || step.dependsOn.some((item) => !text(item, 64))
            || !Array.isArray(step.acceptanceCriteria) || step.acceptanceCriteria.length < 1 || step.acceptanceCriteria.length > 30
            || step.acceptanceCriteria.some((item) => !text(item, 2000) || item.length === 0)
            || (step.aiBudgetMist !== undefined && !boundedDecimal(step.aiBudgetMist)) || (step.actionBudgetMist !== undefined && !boundedDecimal(step.actionBudgetMist))) fail();
        stepIds.add(step.id);
    }
    const stepStatus = object(row.stepStatus);
    if (Object.keys(stepStatus).length !== stepIds.size || Object.entries(stepStatus).some(([id, status]) => !stepIds.has(id) || !["pending", "running", "verifying", "succeeded", "failed", "cancelled"].includes(String(status)))) fail();
    if (!row.stepEvidence || typeof row.stepEvidence !== "object" || Array.isArray(row.stepEvidence)
        || !Array.isArray(row.artifacts) || row.artifacts.length > 10000 || !Array.isArray(row.receipts) || row.receipts.length > 10000) fail();
    if (Object.keys(row.stepEvidence as Record<string, unknown>).some((id) => !stepIds.has(id))) fail();
    if (row.messages !== undefined && (!Array.isArray(row.messages) || row.messages.length > 2048)) fail();
    if (row.taskId !== undefined && !text(row.taskId, 66)) fail();
    if (row.taskRole !== undefined && row.taskRole !== "buyer" && row.taskRole !== "seller") fail();
    if (row.roomId !== undefined && !text(row.roomId, 66)) fail();
    return row;
}

function boundedDecimal(value: unknown): boolean {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return false;
    try { return BigInt(value) <= (1n << 64n) - 1n; } catch { return false; }
}

function validateOperation(value: unknown, expectedRunId: string): void {
    const row = object(value);
    exactKeys(row, ["id", "runId", "toolCallId", "toolName", "inputHash", "idempotencyKey", "status", "acquired"], ["maxAmountMist", "stepId", "result", "error"]);
    if (!text(row.id, 36) || !UUID.test(row.id) || !text(row.runId, 36) || row.runId.toLowerCase() !== expectedRunId.toLowerCase()
        || !text(row.toolCallId, 200) || row.toolCallId.length === 0 || !text(row.toolName, 100) || row.toolName.length === 0
        || !text(row.inputHash, 64) || !/^[0-9a-f]{64}$/.test(row.inputHash) || !text(row.idempotencyKey, 256)
        || !OPERATION_STATUSES.has(String(row.status)) || typeof row.acquired !== "boolean") fail();
    if (row.maxAmountMist !== undefined && (typeof row.maxAmountMist !== "string" || !/^(0|[1-9][0-9]*)$/.test(row.maxAmountMist))) fail();
    if (row.stepId !== undefined && (typeof row.stepId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(row.stepId))) fail();
    if (row.error !== undefined && !text(row.error, 2000)) fail();
    if (row.result !== undefined) {
        boundedJson(row.result);
    }
}

function validateTurn(name: string, value: unknown): Record<string, unknown> {
    const row = object(value);
    if (name === "work_run_acquire_turn") {
        exactKeys(row, ["acquired", "id", "status"], ["token", "leaseUntil", "resumed"]);
        if (typeof row.acquired !== "boolean" || !text(row.id, 36) || !UUID.test(row.id)
            || !["running", "yielded", "finished", "failed", "reconciling", "planned", "waiting_for_input", "waiting_for_approval", "cancelled", "completed", "delivered", "settled", "disputed", "refunded"].includes(String(row.status))) fail();
        if (row.acquired) {
            if (!text(row.token, 36) || !UUID.test(row.token) || !timestamp(row.leaseUntil)) fail();
            if (row.resumed !== undefined && row.resumed !== true) fail();
        } else if (row.token !== undefined || row.leaseUntil !== undefined || row.resumed !== undefined) fail();
        return row;
    }
    if (name === "work_run_renew_turn") {
        exactKeys(row, ["renewed", "leaseUntil"]);
        if (typeof row.renewed !== "boolean" || !(row.leaseUntil === null || timestamp(row.leaseUntil)) || row.renewed !== (row.leaseUntil !== null)) fail();
        return row;
    }
    exactKeys(row, ["ok"]);
    if (row.ok !== true) fail();
    return row;
}

function validateReconciliation(name: string, value: unknown): Record<string, unknown> {
    const row = object(value);
    if (name === "work_run_reconcile_action_receipt") {
        if (typeof row.resolved !== "boolean" || !text(row.status, 32)) fail();
        if (row.resolved) {
            exactKeys(row, ["resolved", "status", "digest", "registryAction", "parameterHash", "verification"]);
            if (row.status !== "succeeded" && row.status !== "failed" || !digest(row.digest) || !text(row.registryAction, 128) || !digest(row.parameterHash) || !["finalized", "failed"].includes(String(row.verification))) fail();
        } else {
            exactKeys(row, ["resolved", "status", "reason"], ["digest"]);
            if (!text(row.reason, 128) || !OPERATION_STATUSES.has(row.status) && !["finalized", "failed", "submitted", "not_found"].includes(row.status)) fail();
            if (row.digest !== undefined && !digest(row.digest)) fail();
        }
        return row;
    }
    if (typeof row.resolved !== "boolean" || !text(row.status, 32)) fail();
    if (row.retry !== undefined) {
        const retry = object(row.retry);
        exactKeys(retry, ["taskId", "idempotencyKey", "digestHex"]);
        if (!text(retry.taskId, 66) || !text(retry.idempotencyKey, 128) || !digest(retry.digestHex)) fail();
    }
    if (row.resolved) {
        exactKeys(row, ["resolved", "status", "taskId", "uri", "digestHex", "contentLength", "verification"]);
        if (row.status !== "succeeded" || !text(row.taskId, 66) || !text(row.uri, 512) || !digest(row.digestHex)
            || !positiveInteger(row.contentLength) || Number(row.contentLength) > 512 * 1024 || row.verification !== "participant_upload_ledger_and_r2_bytes") fail();
    } else {
        exactKeys(row, ["resolved", "status", "reason"], ["retry"]);
        if (!text(row.reason, 128) || !["pending", "uploaded", "failed", "reconciling"].includes(row.status)) fail();
    }
    return row;
}

function validateReceipt(value: unknown): void {
    const row = object(value);
    exactKeys(row, ["id", "kind", "operationId", "digest", "verification", "recordedAt"], ["taskId", "artifactDigest", "gasCostMist", "gasRefundMist", "sourceEvidenceIds", "eventEvidence"]);
    if (!text(row.id, 36) || !UUID.test(row.id) || row.operationId !== row.id || !["action", "task_delivery", "task_settlement"].includes(String(row.kind))
        || !text(row.digest, 256) || row.digest.length === 0 || !["verified", "rejected", "pending"].includes(String(row.verification)) || !timestamp(row.recordedAt)) fail();
    if (row.taskId !== undefined && !text(row.taskId, 66)) fail();
    if (row.artifactDigest !== undefined && !digest(row.artifactDigest)) fail();
    if (row.gasCostMist !== undefined && !boundedDecimal(row.gasCostMist)) fail();
    if (row.gasRefundMist !== undefined && !boundedDecimal(row.gasRefundMist)) fail();
    if (row.sourceEvidenceIds !== undefined && (!Array.isArray(row.sourceEvidenceIds) || row.sourceEvidenceIds.length > 1000 || row.sourceEvidenceIds.some((id) => !text(id, 256)))) fail();
    if (row.eventEvidence !== undefined) {
        if (!Array.isArray(row.eventEvidence) || row.eventEvidence.length > 1000) fail();
        boundedJson(row.eventEvidence, 262144);
    }
}

function validateArtifact(value: unknown): void {
    const row = object(value);
    exactKeys(row, ["id", "uri", "contentDigest", "mediaType", "ownerAccountId", "taskId", "sourceEvidenceIds", "verification", "contentLength"], ["transactionDigest"]);
    if (!text(row.id, 36) || !UUID.test(row.id) || !text(row.uri, 512) || !row.uri.startsWith("r2://") || !digest(row.contentDigest)
        || row.mediaType !== "application/octet-stream" || !text(row.ownerAccountId, 128) || !text(row.taskId, 66)
        || !Array.isArray(row.sourceEvidenceIds) || row.sourceEvidenceIds.length > 1000 || row.sourceEvidenceIds.some((id) => !text(id, 256))
        || !["pending", "verified"].includes(String(row.verification)) || !positiveInteger(row.contentLength) || Number(row.contentLength) > 512 * 1024) fail();
    if (row.transactionDigest !== undefined && !text(row.transactionDigest, 256)) fail();
}

export function sanitizeWorkJournalRead(name: string, value: unknown, args: Record<string, unknown>): unknown {
    if (name === "work_run_list") {
        const page = object(value);
        exactKeys(page, ["runs"]);
        if (!Array.isArray(page.runs) || page.runs.length > 200) return fail();
        for (const raw of page.runs) {
            const row = object(raw);
            exactKeys(row, ["id", "revision", "status", "createdAt", "updatedAt", "cancelRequestedAt"]);
            if (!text(row.id, 36) || !UUID.test(row.id) || !positiveInteger(row.revision) || !RUN_STATUSES.has(String(row.status))
                || !timestamp(row.createdAt) || !timestamp(row.updatedAt) || !(row.cancelRequestedAt === null || timestamp(row.cancelRequestedAt))) fail();
        }
        return page;
    }
    if (name === "work_run_get") return validateRun(value, typeof args.runId === "string" ? args.runId : undefined);
    if (["work_run_create", "work_run_save_plan", "work_run_update_step", "work_run_complete"].includes(name)) {
        return validateRun(value, name === "work_run_create" && typeof args.id === "string" ? args.id : typeof args.runId === "string" ? args.runId : undefined);
    }
    if (name === "work_run_purge_revoked_listing") {
        const response = object(value);
        exactKeys(response, ["purged", "scanned"]);
        if (!Number.isSafeInteger(response.purged) || Number(response.purged) < 0 || Number(response.purged) > 50 || response.scanned !== 50) fail();
        return response;
    }
    if (name === "work_run_refresh_task_history") {
        const response = object(value);
        exactKeys(response, ["run", "added", "complete"], ["truncated"]);
        if (!Number.isSafeInteger(response.added) || Number(response.added) < 0 || Number(response.added) > 100 || typeof response.complete !== "boolean"
            || (response.truncated !== undefined && typeof response.truncated !== "boolean")) fail();
        validateRun(response.run, typeof args.runId === "string" ? args.runId : undefined);
        return response;
    }
    if (name === "work_run_cancel") {
        const response = object(value);
        exactKeys(response, ["runId", "status", "cancelRequested", "cancelRequestedAt", "alreadyTerminal", "reconciliationRequired"]);
        if (!text(response.runId, 36) || !UUID.test(response.runId)
            || (typeof args.runId === "string" && response.runId.toLowerCase() !== args.runId.toLowerCase())
            || !RUN_STATUSES.has(String(response.status)) || typeof response.cancelRequested !== "boolean"
            || !(response.cancelRequestedAt === null || timestamp(response.cancelRequestedAt))
            || typeof response.alreadyTerminal !== "boolean" || typeof response.reconciliationRequired !== "boolean") fail();
        return response;
    }
    if (["work_run_acquire_turn", "work_run_renew_turn", "work_run_checkpoint", "work_run_finish_turn"].includes(name)) return validateTurn(name, value);
    if (name === "work_run_issue_worker_credential") {
        const response = object(value);
        exactKeys(response, ["credentialId", "credential", "runId", "delegateRef", "workerAgentId", "expiresAt"]);
        if (!text(response.credentialId, 36) || !UUID.test(response.credentialId) || !text(response.credential, 128)
            || !/^mwr1\.[0-9a-f-]{36}\.[0-9a-f-]{36}$/i.test(response.credential)
            || !text(response.runId, 36) || !UUID.test(response.runId) || (typeof args.runId === "string" && response.runId.toLowerCase() !== args.runId.toLowerCase())
            || !text(response.delegateRef, 256) || !text(response.workerAgentId, 128) || !timestamp(response.expiresAt)) fail();
        return response;
    }
    if (name === "work_run_revoke_worker_credential") {
        const response = object(value);
        exactKeys(response, ["runId", "revoked"]);
        if (!text(response.runId, 36) || !UUID.test(response.runId) || (typeof args.runId === "string" && response.runId.toLowerCase() !== args.runId.toLowerCase()) || typeof response.revoked !== "boolean") fail();
        return response;
    }
    if (name === "work_run_reserve_operation") {
        const runId = args.runId;
        if (typeof runId !== "string" || !UUID.test(runId)) fail();
        validateOperation(value, runId);
        return value;
    }
    if (["work_run_settle_operation"].includes(name)) {
        const response = object(value);
        exactKeys(response, ["ok"]);
        if (response.ok !== true) fail();
        return response;
    }
    if (["work_run_reconcile_action_receipt", "work_run_reconcile_task_upload"].includes(name)) return validateReconciliation(name, value);
    if (name === "work_run_append_action_receipt") {
        const response = object(value);
        exactKeys(response, ["receipt", "verificationEvidence"]);
        validateReceipt(response.receipt);
        boundedJson(response.verificationEvidence, 262144);
        return response;
    }
    if (name === "work_run_append_task_artifact") {
        const response = object(value);
        exactKeys(response, ["artifact"]);
        validateArtifact(response.artifact);
        return response;
    }
    if (name === "work_run_list_operations") {
        const page = object(value);
        exactKeys(page, ["operations", "hasNext", "nextOffset"]);
        const runId = args.runId;
        if (typeof runId !== "string" || !UUID.test(runId) || !Array.isArray(page.operations) || page.operations.length > 200 || typeof page.hasNext !== "boolean"
            || !(page.nextOffset === null || (Number.isSafeInteger(page.nextOffset) && Number(page.nextOffset) >= 0)) || page.hasNext !== (page.nextOffset !== null)) fail();
        for (const raw of page.operations) validateOperation(raw, runId);
        return page;
    }
    return value;
}
