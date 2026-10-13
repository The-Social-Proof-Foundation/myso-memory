import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SocialReader } from "./bundle.js";
import { computeCommitment, sha256Hex } from "./commitment.js";
import {
    ACTION_ACCEPT, ACTION_CLAIM, ACTION_COMMIT, ACTION_REVEAL,
    DirectiveEngine, JudgmentService, revealParams, type EngineRequest,
} from "./directives.js";
import type { InferenceClient } from "./inference.js";
import { MemoryStore } from "./store.js";

const AGENT = "0x" + "a1".repeat(32);
const CASE = "0x" + "c1".repeat(32);
const ALL = [ACTION_ACCEPT, ACTION_COMMIT, ACTION_REVEAL, ACTION_CLAIM];

function rig(options: { now?: () => number; model?: (system: string) => string; allowed?: string[]; indexed?: () => boolean } = {}) {
    let clock = 1_000;
    const now = options.now ?? (() => clock);
    const store = new MemoryStore();
    const social: SocialReader = {
        getCase: async () => (options.indexed && !options.indexed() ? null : {
            caseId: CASE, subjectKind: 1, subjectId: "0xt1", stage: 0,
            evidence: [{ index: 0, kind: 1, submitter: "0xt1", round: 0, uri: "agent_task:terms", digest: "aa".repeat(32) }],
        }),
        getTask: async () => ({ taskId: "0xt1", title: "Report", amountMist: 5, deliveredAtMs: 1, deliveryDeadlineMs: 2 }),
        getProposal: async () => null,
    };
    let modelCalls = 0;
    const inference: InferenceClient = {
        async completeJson(request) {
            modelCalls += 1;
            if (options.model) return options.model(request.system);
            if (request.system.startsWith("You read case material")) return '{"summary":"s","claims":[],"injection_suspected":false}';
            return JSON.stringify({ outcome: 1, rationale: "the work was not delivered", evidence_refs: [0] });
        },
    };
    const judgments = new JudgmentService({
        store,
        // Evidence cannot be fetched here: the verdict still cites the on-chain record.
        bundle: { social, fetchEvidence: async () => ({ ok: false, reason: "offline" }) },
        judge: { inference },
        saltSecret: "s".repeat(32),
        now,
    });
    const engine = new DirectiveEngine({ store, judgments, now });
    const request = (eventType: string, payload: Record<string, unknown>, extra: Partial<EngineRequest> = {}): EngineRequest => ({
        delivery_id: `d-${Math.random()}`,
        allowed_action_ids: options.allowed ?? ALL,
        event: { event_type: eventType, agent_object_id: AGENT, payload: { case_id: CASE, round: 0, agent_id: AGENT, ...payload } },
        ...extra,
    });
    return { engine, judgments, store, request, modelCalls: () => modelCalls, advance: (ms: number) => { clock += ms; } };
}

describe("accepting and claiming need no thinking", () => {
    it("accepts a drafted seat at once", async () => {
        const { engine, request, modelCalls } = rig();
        const directive = await engine.handle(request("duty_drafted", { duty_kind: "accept" }));
        assert.deepEqual(directive, { action_id: ACTION_ACCEPT, params: { caseId: CASE, agentId: AGENT } });
        assert.equal(modelCalls(), 0);
    });

    it("accepts on an accept poll and claims a fee", async () => {
        const { engine, request } = rig();
        assert.deepEqual(await engine.handle(request("duty_poll", { duty_kind: "accept" })), {
            action_id: ACTION_ACCEPT, params: { caseId: CASE, agentId: AGENT },
        });
        assert.deepEqual(await engine.handle(request("fee_claimable", {})), {
            action_id: ACTION_CLAIM, params: { caseId: CASE, agentId: AGENT },
        });
    });
});

describe("judging happens in the background across polls", () => {
    it("starts on the first commit poll, then commits on a later one", async () => {
        const { engine, judgments, request } = rig();
        const first = await engine.handle(request("duty_poll", { duty_kind: "commit" }));
        assert.deepEqual(first, { noop: true, reason: "judging" });
        await judgments.idle();
        const second = await engine.handle(request("duty_poll", { duty_kind: "commit" }));
        assert.ok("action_id" in second && second.action_id === ACTION_COMMIT);
        assert.match(String(second.params.commitmentHex), /^[0-9a-f]{64}$/);
        assert.equal(second.params.caseId, CASE);
    });

    it("starts judging when voting opens", async () => {
        const { engine, judgments, store, request } = rig();
        assert.deepEqual(await engine.handle(request("voting_started", { duty_kind: "commit" })), { noop: true, reason: "judging" });
        await judgments.idle();
        assert.ok(store.getJudgment(CASE, 0, AGENT));
    });

    it("judges once however many polls arrive while it runs", async () => {
        const { engine, judgments, request, modelCalls } = rig();
        for (let i = 0; i < 5; i += 1) await engine.handle(request("duty_poll", { duty_kind: "commit" }));
        await judgments.idle();
        const afterFirstWave = modelCalls();
        for (let i = 0; i < 3; i += 1) await engine.handle(request("duty_poll", { duty_kind: "commit" }));
        assert.equal(modelCalls(), afterFirstWave);
    });

    it("tries again on the next poll when the case was not indexed yet", async () => {
        let indexed = false;
        const { engine, judgments, store, request } = rig({ indexed: () => indexed });
        assert.deepEqual(await engine.handle(request("duty_poll", { duty_kind: "commit" })), { noop: true, reason: "judging" });
        await judgments.idle();
        assert.equal(store.getJudgment(CASE, 0, AGENT), undefined, "nothing was judged, so nothing is stored");

        indexed = true;
        assert.deepEqual(await engine.handle(request("duty_poll", { duty_kind: "commit" })), { noop: true, reason: "judging" });
        await judgments.idle();
        const ready = await engine.handle(request("duty_poll", { duty_kind: "commit" }));
        assert.ok("action_id" in ready && ready.action_id === ACTION_COMMIT);
    });

    it("abstains rather than stall when the model cannot produce a valid vote", async () => {
        const { engine, judgments, store, request } = rig({ model: (system) => (system.startsWith("You read case material") ? "{}" : "not json") });
        await engine.handle(request("duty_poll", { duty_kind: "commit" }));
        await judgments.idle();
        assert.equal(store.getJudgment(CASE, 0, AGENT)?.outcome, 255);
        assert.ok("action_id" in (await engine.handle(request("duty_poll", { duty_kind: "commit" }))));
    });
});

describe("the reveal opens exactly what was committed", () => {
    it("reveals the stored judgment and then allows its rationale to be public", async () => {
        const { engine, judgments, store, request } = rig();
        await engine.handle(request("duty_poll", { duty_kind: "commit" }));
        await judgments.idle();
        const commit = await engine.handle(request("duty_poll", { duty_kind: "commit" }));
        const reveal = await engine.handle(request("duty_poll", { duty_kind: "reveal" }));
        assert.ok("action_id" in commit && "action_id" in reveal && reveal.action_id === ACTION_REVEAL);

        const params = reveal.params as Record<string, unknown>;
        // The commitment sent earlier is the hash of exactly these fields.
        assert.equal(
            computeCommitment({
                caseId: CASE, round: 0, agentId: AGENT,
                outcome: params.outcome as number,
                rationaleDigestHex: params.rationaleDigestHex as string,
                evidenceRefs: (params.evidenceRefs as string[]).map(Number),
                bundleDigestHex: params.bundleDigestHex as string,
                saltHex: params.saltHex as string,
            }),
            (commit as { params: { commitmentHex: string } }).params.commitmentHex,
        );
        assert.equal(sha256Hex(store.getJudgment(CASE, 0, AGENT)!.rationale), params.rationaleDigestHex);
        assert.equal(store.getRevealedRationale(params.rationaleDigestHex as string), "the work was not delivered");
    });

    it("keeps the rationale private until the reveal is issued", async () => {
        const { engine, judgments, store, request } = rig();
        await engine.handle(request("duty_poll", { duty_kind: "commit" }));
        await judgments.idle();
        const judgment = store.getJudgment(CASE, 0, AGENT)!;
        assert.equal(store.getRevealedRationale(judgment.rationaleDigestHex), undefined);
    });

    it("says nothing when there is nothing to reveal", async () => {
        const { engine, request } = rig();
        assert.deepEqual(await engine.handle(request("duty_poll", { duty_kind: "reveal" })), {
            noop: true, reason: "no judgment to reveal",
        });
    });

    it("refuses to reveal a judgment that no longer matches its commitment", async () => {
        const { engine, judgments, store, request } = rig();
        await engine.handle(request("duty_poll", { duty_kind: "commit" }));
        await judgments.idle();
        store.getJudgment(CASE, 0, AGENT)!.outcome = 0;
        const reveal = await engine.handle(request("duty_poll", { duty_kind: "reveal" }));
        assert.deepEqual(reveal, { noop: true, reason: "the stored judgment does not match its commitment" });
        assert.throws(() => revealParams(store.getJudgment(CASE, 0, AGENT)!), /no longer matches/);
    });
});

describe("guards", () => {
    it("answers a repeated delivery with the same directive even if the world changed", async () => {
        const { engine, judgments, request } = rig();
        const poll = request("duty_poll", { duty_kind: "commit" });
        const first = await engine.handle(poll);
        await judgments.idle();
        assert.deepEqual(first, { noop: true, reason: "judging" });
        // The judgment is ready now, but the engine's retry of delivery `poll` gets its first answer.
        assert.deepEqual(await engine.handle(poll), first);
    });

    it("ignores an event whose deadline has passed", async () => {
        const { engine, request } = rig();
        assert.deepEqual(
            await engine.handle(request("duty_drafted", { duty_kind: "accept", expires_at_ms: 999 })),
            { noop: true, reason: "the deadline has passed" },
        );
    });

    it("ignores an event for another agent or with no seat", async () => {
        const { engine, request } = rig();
        const other = request("duty_drafted", {});
        other.event.agent_object_id = "0x" + "b2".repeat(32);
        assert.deepEqual(await engine.handle(other), { noop: true, reason: "the event is for a different agent" });
        const bare = request("duty_drafted", {});
        bare.event.payload = {};
        assert.deepEqual(await engine.handle(bare), { noop: true, reason: "the event names no seat" });
    });

    it("never names an action the job did not allow", async () => {
        const { engine, request } = rig({ allowed: [ACTION_ACCEPT] });
        assert.deepEqual(await engine.handle(request("fee_claimable", {})), {
            noop: true, reason: `this job may not run ${ACTION_CLAIM}`,
        });
        assert.ok("action_id" in (await engine.handle(request("duty_drafted", {}))));
    });

    it("does nothing for events it does not act on", async () => {
        const { engine, request } = rig();
        assert.deepEqual(await engine.handle(request("replace_due", {})), {
            noop: true, reason: "not an event this runner acts on: replace_due",
        });
        assert.deepEqual(await engine.handle(request("duty_poll", { duty_kind: "dance" })), { noop: true, reason: "unknown duty dance" });
    });
});
