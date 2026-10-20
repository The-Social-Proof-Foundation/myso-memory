import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig } from "./config.js";
import { Reconciler, actionForCrank, idempotencyKey, type CrankView, type ReconcilerConfig } from "./reconciler.js";

const CASE = "0x" + "c1".repeat(32);
const TASK = "0x" + "a1".repeat(32);
const PROPOSAL = "0x" + "b1".repeat(32);

const crank = (over: Partial<CrankView>): CrankView => ({
    kind: "select_due",
    caseId: CASE,
    round: 1,
    subjectKind: 1,
    subjectId: TASK,
    dueMs: 1_000,
    ...over,
});

const config: ReconcilerConfig = {
    bridgeUrl: "http://bridge.test",
    bridgeSecret: "bridge-secret",
    operatorAccountId: "0xoperator",
    intervalMs: 60_000,
    graceMs: 900_000,
    batch: 20,
};

describe("actionForCrank", () => {
    it("maps case cranks to the case alone", () => {
        for (const [kind, actionId] of [
            ["select_due", "jury.select_jury.v1"],
            ["replace_due", "jury.replace_no_shows.v1"],
            ["round_finalize_due", "jury.finalize_round.v1"],
            ["case_finalize_due", "jury.finalize_case.v1"],
        ] as const) {
            assert.deepEqual(actionForCrank(crank({ kind })), { actionId, params: { caseId: CASE } });
        }
    });

    it("gives a task crank the accounts and leaves out an absent platform", () => {
        const action = actionForCrank(crank({ kind: "execute_ready", buyerAccountId: "0xb", sellerAccountId: "0xs" }));
        assert.deepEqual(action, {
            actionId: "jury.execute_task_verdict.v1",
            params: { taskId: TASK, caseId: CASE, buyerAccountId: "0xb", sellerAccountId: "0xs" },
        });
        const withPlatform = actionForCrank(
            crank({ kind: "neutral_due", buyerAccountId: "0xb", sellerAccountId: "0xs", platformId: "0xp" }),
        );
        assert.equal(withPlatform?.params.platformObjectId, "0xp");
    });

    it("tells a fee crank whether to close the case first", () => {
        assert.equal(actionForCrank(crank({ kind: "fees_due", closeCaseFirst: true }))?.params.closeCaseFirst, true);
    });

    it("names the proposal, its registry and its step for a governance crank", () => {
        const action = actionForCrank(
            crank({ kind: "escalate_due", caseId: undefined, subjectKind: 2, subjectId: PROPOSAL, registryId: "0xr", stage: 2 }),
        );
        assert.deepEqual(action, {
            actionId: "jury.escalate_proposal.v1",
            params: { registryId: "0xr", proposalId: PROPOSAL, stage: 2 },
        });
        assert.equal(actionForCrank(crank({ kind: "apply_ready", subjectId: PROPOSAL, registryId: "0xr" }))?.params.caseId, CASE);
    });

    it("maps roster upkeep to the agent and a sweep to its case", () => {
        const roster = { subjectKind: 3, subjectId: "0xagent", caseId: undefined, memoryAccountId: "0xacct" };
        assert.deepEqual(actionForCrank(crank({ kind: "roster_refresh_due", ...roster })), {
            actionId: "jury.refresh_roster_entry.v1",
            params: { accountId: "0xacct", agentId: "0xagent" },
        });
        assert.deepEqual(actionForCrank(crank({ kind: "evict_due", ...roster })), {
            actionId: "jury.evict_ineligible.v1",
            params: { agentId: "0xagent" },
        });
        assert.deepEqual(actionForCrank(crank({ kind: "sweep_due" })), {
            actionId: "jury.sweep_case.v1",
            params: { caseId: CASE },
        });
    });

    it("ignores a kind it does not know", () => {
        assert.equal(actionForCrank(crank({ kind: "something_new" })), null);
    });
});

describe("idempotencyKey", () => {
    it("is stable within an hour, differs across hours and cranks, and fits the relayer's format", () => {
        const a = idempotencyKey(crank({}), 3_600_000 * 5 + 1);
        assert.equal(a, idempotencyKey(crank({}), 3_600_000 * 5 + 59_000));
        assert.notEqual(a, idempotencyKey(crank({}), 3_600_000 * 6));
        assert.notEqual(a, idempotencyKey(crank({ round: 2 }), 3_600_000 * 5));
        assert.notEqual(a, idempotencyKey(crank({ kind: "replace_due" }), 3_600_000 * 5));
        assert.match(a, /^[A-Za-z0-9._:/-]{8,128}$/);
    });
});

describe("Reconciler", () => {
    function harness(cranks: CrankView[], statusFor: (action: string) => number) {
        const acts: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
        const fakeFetch = (async (url: string, init?: RequestInit) => {
            if (url.startsWith("http://social.test/jury/cranks")) {
                return new Response(JSON.stringify(cranks), { status: 200 });
            }
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            acts.push({ headers: init?.headers as Record<string, string>, body });
            return new Response("{}", { status: statusFor(String(body.action_id)) });
        }) as unknown as typeof fetch;
        const reconciler = new Reconciler({
            config,
            socialServerUrl: "http://social.test",
            fetch: fakeFetch,
            now: () => 10_000_000,
            log: () => undefined,
        });
        return { reconciler, acts };
    }

    it("runs an old crank with the operator key through the bridge", async () => {
        const { reconciler, acts } = harness([crank({ dueMs: 1_000 })], () => 200);
        assert.deepEqual(await reconciler.tick(), { ran: 1, conflicts: 0, failed: 0, skipped: 0 });
        assert.equal(acts[0]?.headers["x-internal-sync-secret"], "bridge-secret");
        assert.equal(acts[0]?.body.key_ref, "operator:jury");
        assert.equal(acts[0]?.body.account_id, "0xoperator");
        assert.equal(acts[0]?.body.action_id, "jury.select_jury.v1");
    });

    it("leaves a fresh crank to the engine", async () => {
        const { reconciler, acts } = harness([crank({ dueMs: 10_000_000 - 60_000 })], () => 200);
        assert.deepEqual(await reconciler.tick(), { ran: 0, conflicts: 0, failed: 0, skipped: 1 });
        assert.equal(acts.length, 0);
    });

    it("counts a conflict as done and a server error as failed, and keeps going", async () => {
        const { reconciler } = harness(
            [crank({ kind: "select_due" }), crank({ kind: "replace_due" }), crank({ kind: "finalize_nothing" })],
            (action) => (action === "jury.select_jury.v1" ? 409 : 502),
        );
        assert.deepEqual(await reconciler.tick(), { ran: 0, conflicts: 1, failed: 1, skipped: 1 });
    });
});

describe("reconciler config", () => {
    const base = {
        JUROR_WEBHOOK_SECRET: "a-webhook-secret-of-16+",
        JUROR_SALT_SECRET: "s".repeat(32),
        SOCIAL_SERVER_URL: "http://social.test",
        INFERENCE_URL: "http://inference.test/v1",
        INFERENCE_API_KEY: "k",
        INFERENCE_MODEL: "m",
    };

    it("is off unless asked for", () => {
        assert.equal(loadConfig(base).reconciler, null);
    });

    it("needs the bridge and the crank operator's account", () => {
        assert.throws(() => loadConfig({ ...base, RECONCILER_ENABLED: "true" }), /BRIDGE_URL/);
        const env = {
            ...base,
            RECONCILER_ENABLED: "true",
            BRIDGE_URL: "http://bridge.test/",
            BRIDGE_SECRET: "s",
        };
        assert.throws(() => loadConfig(env), /JURY_CRANK_OPERATOR_ID/);
        const loaded = loadConfig({ ...env, JURY_CRANK_OPERATOR_ID: "0xoperator" }).reconciler;
        assert.equal(loaded?.bridgeUrl, "http://bridge.test");
        assert.equal(loaded?.graceMs, 900_000);
    });
});
