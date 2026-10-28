import { McpRuntimeError } from "./errors.js";

type Identity = { accountId: string; agentObjectId: string };

function object(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
    return value as Record<string, unknown>;
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[], label: string): void {
    const actual = Object.keys(row).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        fail(`${label} contains an unexpected or missing field.`);
    }
}

function exactOptionalKeys(row: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
    const actual = Object.keys(row).sort();
    const requiredKeys = [...required].sort();
    const allowed = new Set([...required, ...optional]);
    if (requiredKeys.some((key) => !Object.hasOwn(row, key)) || actual.some((key) => !allowed.has(key))) {
        fail(`${label} contains an unexpected or missing field.`);
    }
}

function nullableString(row: Record<string, unknown>, key: string, label: string, maxLength = 4096): void {
    const value = row[key];
    if (value !== null && value !== undefined && (typeof value !== "string" || value.length > maxLength)) {
        fail(`${label}.${key} is invalid.`);
    }
}

function fail(message: string): never {
    throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `Automation response validation failed: ${message}`, { retryable: false });
}

function string(row: Record<string, unknown>, key: string, label: string): string {
    const value = row[key];
    if (typeof value !== "string" || value.length === 0) fail(`${label}.${key} is missing or invalid.`);
    return value;
}

function bool(row: Record<string, unknown>, key: string, label: string): boolean {
    const value = row[key];
    if (typeof value !== "boolean") fail(`${label}.${key} is missing or invalid.`);
    return value;
}

function integer(row: Record<string, unknown>, key: string, label: string, min = 0): number {
    const value = row[key];
    if (!Number.isSafeInteger(value) || Number(value) < min) fail(`${label}.${key} is missing or invalid.`);
    return Number(value);
}

function isoDate(value: unknown, label: string): number {
    if (typeof value !== "string") fail(`${label} is missing or invalid.`);
    const time = Date.parse(value);
    if (!Number.isFinite(time)) fail(`${label} is missing or invalid.`);
    return time;
}

function normalized(value: string): string {
    return value.replace(/^0x/i, "").replace(/^0+/, "").toLowerCase() || "0";
}

function assertJob(value: unknown, identity: Identity, expectedId?: string): Record<string, unknown> {
    const row = object(value, "job");
    exactKeys(row, ["id", "version", "organization_id", "account_id", "owner_address", "name", "enabled", "archived", "trigger_set", "target_agent_object_id", "target_agent_key_ref", "action", "memory_scope", "max_mist_per_run", "retry_policy"], "job");
    const id = string(row, "id", "job");
    if (expectedId && id.toLowerCase() !== expectedId.toLowerCase()) fail("job.id does not match the requested job.");
    if (normalized(string(row, "account_id", "job")) !== normalized(identity.accountId)) fail("job.account_id does not match the authenticated account.");
    if (normalized(string(row, "target_agent_object_id", "job")) !== normalized(identity.agentObjectId)) fail("job.target_agent_object_id does not match the authenticated agent.");
    integer(row, "version", "job", 1);
    string(row, "name", "job");
    bool(row, "enabled", "job");
    bool(row, "archived", "job");
    for (const field of ["organization_id", "target_agent_key_ref", "memory_scope"]) string(row, field, "job");
    if (typeof row.owner_address !== "string" || row.owner_address.length > 66) fail("job.owner_address is invalid.");
    integer(row, "max_mist_per_run", "job", 0);
    const triggerSet = object(row.trigger_set, "job.trigger_set");
    exactKeys(triggerSet, ["match_mode", "evaluation_window_ms", "triggers"], "job.trigger_set");
    if (!["any", "all"].includes(string(triggerSet, "match_mode", "job.trigger_set"))) fail("job.trigger_set.match_mode is unknown.");
    integer(triggerSet, "evaluation_window_ms", "job.trigger_set", 0);
    if (!Array.isArray(triggerSet.triggers) || triggerSet.triggers.length < 1 || triggerSet.triggers.length > 32) fail("job.trigger_set.triggers is invalid.");
    for (const triggerValue of triggerSet.triggers) {
        const trigger = object(triggerValue, "job trigger");
        exactOptionalKeys(trigger, ["kind", "event_family", "event_type", "debounce_window_ms", "cooldown_ms", "replay_behavior"], ["cron_expr", "timezone", "interval_ms", "condition", "organization_id", "account_id", "agent_object_id", "payload_filter", "max_executions_per_window", "deduplication_key"], "job trigger");
        if (!["cron", "interval", "conditional", "event"].includes(string(trigger, "kind", "job trigger"))) fail("job trigger.kind is unknown.");
        string(trigger, "event_family", "job trigger");
        string(trigger, "event_type", "job trigger");
        integer(trigger, "debounce_window_ms", "job trigger", 0);
        integer(trigger, "cooldown_ms", "job trigger", 0);
        if (!["skip", "allow_once", "allow_all"].includes(string(trigger, "replay_behavior", "job trigger"))) fail("job trigger.replay_behavior is unknown.");
        for (const field of ["cron_expr", "timezone", "organization_id", "account_id", "agent_object_id", "deduplication_key"]) nullableString(trigger, field, "job trigger", 256);
        for (const field of ["condition", "payload_filter"]) if (trigger[field] !== undefined && trigger[field] !== null && (typeof trigger[field] !== "object" || Array.isArray(trigger[field]))) fail(`job trigger.${field} is invalid.`);
        if (trigger.interval_ms !== undefined && trigger.interval_ms !== null) integer(trigger, "interval_ms", "job trigger", 1);
        if (trigger.max_executions_per_window !== undefined && trigger.max_executions_per_window !== null) integer(trigger, "max_executions_per_window", "job trigger", 1);
    }
    const retryPolicy = object(row.retry_policy, "job.retry_policy");
    exactKeys(retryPolicy, ["max_attempts", "jitter_ms"], "job.retry_policy");
    integer(retryPolicy, "max_attempts", "job.retry_policy", 1);
    integer(retryPolicy, "jitter_ms", "job.retry_policy", 0);
    const action = object(row.action, "job.action");
    exactKeys(action, ["kind", "config"], "job.action");
    if (!["memory_relayer_call", "registered_action", "webhook", "work_run"].includes(string(action, "kind", "job.action"))) fail("job.action.kind is unknown.");
    const config = object(action.config, "job.action.config");
    if (Object.hasOwn(config, "secret")) fail("redacted webhook secrets must never be returned.");
    if (config.secret_set !== undefined && typeof config.secret_set !== "boolean") fail("job.action.config.secret_set is invalid.");
    noSecretMaterial(config, "job.action.config");
    // Keep validating the legacy database DTO, but do not expose the retired
    // off-chain cap as if it were active authorization policy.
    const sanitized = { ...row };
    delete sanitized.max_mist_per_run;
    return sanitized;
}

function assertPage<T>(value: unknown, label: string, validate: (item: unknown) => T): T[] {
    if (!Array.isArray(value)) fail(`${label} must be an array.`);
    return value.map(validate);
}

function noSecretMaterial(value: unknown, label: string): void {
    if (Array.isArray(value)) {
        for (const child of value) noSecretMaterial(child, label);
        return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (["encrypted_key", "private_key", "signing_key", "seed", "secret"].includes(key.toLowerCase())) fail(`${label} contains forbidden key material.`);
        noSecretMaterial(child, label);
    }
}

/** Validate owner-scoped automation read contracts before they leave either MCP gateway. */
export function sanitizeAutomationRead(name: string, response: unknown, args: Record<string, unknown>, identity: Identity): unknown {
    if (name === "automation_health") {
        const row = object(response, "health");
        exactKeys(row, ["status", "service", "configured"], "health");
        if (!["ok", "degraded", "unknown"].includes(string(row, "status", "health"))) fail("health.status is unknown.");
        if (string(row, "service", "health") !== "myso-automation" || bool(row, "configured", "health") !== true) fail("health service identity is inconsistent.");
        return row;
    }
    if (name === "automation_list_jobs") {
        const jobs = assertPage(response, "jobs", (item) => assertJob(item, identity));
        const ids = jobs.map((job) => string(job, "id", "job"));
        if (new Set(ids.map((id) => id.toLowerCase())).size !== ids.length) fail("jobs contains duplicate IDs.");
        if (jobs.some((job, index) => index > 0 && String(jobs[index - 1].id).localeCompare(String(job.id)) > 0)) fail("jobs are not in stable ascending ID order.");
        return jobs;
    }
    if (name === "automation_get_job") return assertJob(response, identity, String(args.jobId));
    if (name === "automation_reconcile_orphan_run") {
        const row = object(response, "reconciled run");
        exactKeys(row, ["id", "job_id", "status", "attempt", "cost_mist", "error", "started_at", "finished_at"], "reconciled run");
        if (string(row, "id", "reconciled run").toLowerCase() !== String(args.runId).toLowerCase()) fail("reconciled run.id does not match the requested run.");
        if (String(row.job_id).toLowerCase() !== String(args.jobId).toLowerCase()) fail("reconciled run.job_id does not match the requested job.");
        if (!["succeeded", "abandoned"].includes(string(row, "status", "reconciled run"))) fail("reconciled run.status is not terminal.");
        integer(row, "attempt", "reconciled run", 0);
        if (row.cost_mist !== null && row.cost_mist !== undefined) integer(row, "cost_mist", "reconciled run", 0);
        nullableString(row, "error", "reconciled run", 4096);
        isoDate(row.started_at, "reconciled run.started_at");
        if (typeof row.finished_at !== "string") fail("reconciled run.finished_at must be set.");
        isoDate(row.finished_at, "reconciled run.finished_at");
        if (typeof row.error !== "string" || !row.error.startsWith("Owner reconciliation (")) fail("reconciled run is missing its owner-audit record.");
        return row;
    }
    if (name === "automation_list_runs") {
        const rows = assertPage(response, "runs", (item) => {
            const row = object(item, "run");
            exactKeys(row, ["id", "job_id", "status", "attempt", "cost_mist", "error", "started_at", "finished_at"], "run");
            const id = string(row, "id", "run");
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) fail("run.id is not a UUID.");
            if (String(row.job_id).toLowerCase() !== String(args.jobId).toLowerCase()) fail("run.job_id does not match the requested job.");
            const status = string(row, "status", "run");
            if (!["running", "reconciling", "succeeded", "failed", "skipped", "abandoned"].includes(status)) fail("run.status is unknown.");
            integer(row, "attempt", "run", 0);
            if (row.cost_mist !== null && row.cost_mist !== undefined) integer(row, "cost_mist", "run", 0);
            nullableString(row, "error", "run", 4096);
            const started = isoDate(row.started_at, "run.started_at");
            if (row.finished_at !== null && row.finished_at !== undefined) isoDate(row.finished_at, "run.finished_at");
            return { row, id: id.toLowerCase(), started };
        });
        if (rows.some((row, index) => index > 0 && (rows[index - 1].started < row.started
            || rows[index - 1].started === row.started && rows[index - 1].id < row.id))) fail("runs are not in stable newest-first order.");
        return rows.map(({ row }) => row);
    }
    if (name === "automation_list_deliveries") {
        return assertPage(response, "deliveries", (item) => {
            const row = object(item, "delivery");
            exactKeys(row, ["id", "job_id", "event_key", "status", "attempts", "lease_until", "error", "resolved_by", "resolution", "resolution_note", "resolution_history"], "delivery");
            string(row, "id", "delivery");
            if (String(row.job_id).toLowerCase() !== String(args.jobId).toLowerCase()) fail("delivery.job_id does not match the requested job.");
            const status = string(row, "status", "delivery");
            if (!["pending", "running", "done", "reconciling", "cancelled"].includes(status)) fail("delivery.status is unknown.");
            string(row, "event_key", "delivery");
            integer(row, "attempts", "delivery", 0);
            if (row.lease_until !== null && row.lease_until !== undefined) isoDate(row.lease_until, "delivery.lease_until");
            nullableString(row, "error", "delivery", 4096);
            nullableString(row, "resolved_by", "delivery", 200);
            nullableString(row, "resolution", "delivery", 100);
            nullableString(row, "resolution_note", "delivery", 1000);
            if (!Array.isArray(row.resolution_history) || row.resolution_history.length > 1000) fail("delivery.resolution_history is missing or invalid.");
            for (const entryValue of row.resolution_history) {
                const entry = object(entryValue, "delivery resolution");
                exactKeys(entry, ["actor", "resolution", "note", "created_at"], "delivery resolution");
                string(entry, "actor", "delivery resolution");
                string(entry, "resolution", "delivery resolution");
                string(entry, "note", "delivery resolution");
                isoDate(entry.created_at, "delivery resolution.created_at");
            }
            return row;
        });
    }
    if (name === "automation_list_delegates" || name === "automation_list_delegate_key_events") {
        const page = object(response, "page");
        exactKeys(page, ["data", "has_next_page", "next_cursor"], "page");
        if (!Array.isArray(page.data)) fail("page.data must be an array.");
        const hasNext = bool(page, "has_next_page", "page");
        if (hasNext !== (typeof page.next_cursor === "string" && page.next_cursor.length > 0)) fail("page cursor does not match has_next_page.");
        noSecretMaterial(page.data, "delegate page");
        if (name === "automation_list_delegates") {
            const data = page.data.map((item) => {
                const row = object(item, "delegate");
                exactKeys(row, ["delegate_ref", "agent_object_id", "mydata_key_id", "delegate_class", "allowed_action_ids", "created_at"], "delegate");
                string(row, "delegate_ref", "delegate");
                if (normalized(string(row, "agent_object_id", "delegate")) !== normalized(identity.agentObjectId)) fail("delegate.agent_object_id does not match the authenticated agent.");
                string(row, "mydata_key_id", "delegate");
                if (!["memory", "task_worker", "juror", "action_worker"].includes(string(row, "delegate_class", "delegate"))) fail("delegate.delegate_class is unknown.");
                if (!Array.isArray(row.allowed_action_ids) || row.allowed_action_ids.length > 16 || row.allowed_action_ids.some((id) => typeof id !== "string" || id.length < 1 || id.length > 100)) fail("delegate.allowed_action_ids is invalid.");
                isoDate(row.created_at, "delegate.created_at");
                return row;
            });
            if (data.some((row, index) => index > 0 && String(data[index - 1].delegate_ref).localeCompare(String(row.delegate_ref)) >= 0)) fail("delegates are not in stable delegateRef order.");
        } else {
            const data = page.data.map((item) => {
                const row = object(item, "delegate key event");
                exactKeys(row, ["id", "delegate_ref", "agent_object_id", "mydata_key_id", "event_type", "recorded_at"], "delegate key event");
                const id = string(row, "id", "delegate key event");
                if (!/^[1-9][0-9]*$/.test(id)) fail("delegate key event.id is invalid.");
                string(row, "delegate_ref", "delegate key event");
                if (normalized(string(row, "agent_object_id", "delegate key event")) !== normalized(identity.agentObjectId)) fail("delegate key event belongs to another agent.");
                string(row, "mydata_key_id", "delegate key event");
                string(row, "event_type", "delegate key event");
                if (!["created", "replaced", "deleted"].includes(row.event_type as string)) fail("delegate key event.event_type is unknown.");
                isoDate(row.recorded_at, "delegate key event.recorded_at");
                return row;
            });
            if (data.some((row, index) => index > 0 && BigInt(String(data[index - 1].id)) >= BigInt(String(row.id)))) fail("delegate key events are not in ascending ID order.");
        }
        return page;
    }
    if (name === "automation_get_delegate_status") {
        const row = object(response, "delegate status");
        exactOptionalKeys(row, ["status", "delegate_class", "expires_at_ms", "expires_in_ms"], ["reason"], "delegate status");
        if (!["active", "inactive"].includes(string(row, "status", "delegate status"))) fail("delegate status is unknown.");
        if (!["memory", "task_worker", "juror", "action_worker"].includes(string(row, "delegate_class", "delegate status"))) fail("delegate status class is unknown.");
        if (row.expires_at_ms !== null && (!Number.isSafeInteger(row.expires_at_ms) || Number(row.expires_at_ms) < 0)) fail("delegate status.expires_at_ms is invalid.");
        if (row.expires_in_ms !== null && !Number.isSafeInteger(row.expires_in_ms)) fail("delegate status.expires_in_ms is invalid.");
        if (row.reason !== undefined && (typeof row.reason !== "string" || row.reason.length > 400)) fail("delegate status.reason is invalid.");
        noSecretMaterial(row, "delegate status");
        return row;
    }
    if (name === "automation_get_delegate_keys") {
        const row = object(response, "public delegate keys");
        if (Object.keys(row).join("|") !== "keys" || !Array.isArray(row.keys) || row.keys.length > 32) fail("public delegate keys page is invalid.");
        const ids = new Set<string>();
        for (const item of row.keys) {
            const key = object(item, "public delegate key");
            if (Object.keys(key).sort().join("|") !== "id|publicKey" || typeof key.id !== "string" || key.id.length < 1 || key.id.length > 200
                || typeof key.publicKey !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(key.publicKey) || ids.has(key.id)) fail("public delegate key is invalid.");
            ids.add(key.id);
        }
        return row;
    }
    if (name === "automation_run_job_now") {
        const row = object(response, "run-now receipt");
        exactKeys(row, ["jobId", "requestId", "accepted", "deduplicated", "status"], "run-now receipt");
        if (String(row.jobId).toLowerCase() !== String(args.jobId).toLowerCase()) fail("run-now jobId does not match the request.");
        const request = object(args.request, "request");
        if (row.requestId !== request.requestId) fail("run-now requestId does not match the idempotency key.");
        const accepted = bool(row, "accepted", "run-now receipt");
        if (bool(row, "deduplicated", "run-now receipt") === accepted) fail("run-now accepted/deduplicated flags conflict.");
        if (row.status !== (accepted ? "queued" : "already_queued_or_processed")) fail("run-now status is inconsistent with acceptance.");
        return row;
    }
    return response;
}
