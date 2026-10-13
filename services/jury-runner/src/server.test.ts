import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { DirectiveEngine, JudgmentService } from "./directives.js";
import { createJurorServer } from "./server.js";
import { signatureFor } from "./signature.js";
import { MemoryStore } from "./store.js";

const SECRET = "a-webhook-secret-of-16+";
const AGENT = "0x" + "a1".repeat(32);
const CASE = "0x" + "c1".repeat(32);

describe("juror server", () => {
    let server: Server;
    let base = "";
    let store: MemoryStore;
    let modelCalls = 0;

    before(async () => {
        store = new MemoryStore();
        const judgments = new JudgmentService({
            store,
            bundle: {
                social: { getCase: async () => null, getTask: async () => null, getProposal: async () => null },
                fetchEvidence: async () => ({ ok: false, reason: "offline" }),
            },
            judge: { inference: { completeJson: async () => { modelCalls += 1; return "{}"; } } },
            saltSecret: "s".repeat(32),
            now: Date.now,
        });
        const engine = new DirectiveEngine({ store, judgments, now: Date.now });
        server = createJurorServer({ webhookSecret: SECRET, engine, store, maxBodyBytes: 4_096 });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(() => new Promise<void>((resolve) => server.close(() => resolve())));

    function signed(body: unknown, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)) {
        const raw = Buffer.from(JSON.stringify(body));
        return {
            raw,
            headers: {
                "content-type": "application/json",
                "x-myso-timestamp": String(timestamp),
                "x-myso-signature": signatureFor(secret, timestamp, raw),
            },
        };
    }

    const drafted = (id = "d1") => ({
        delivery_id: id,
        allowed_action_ids: ["jury.accept.v1"],
        event: { event_type: "duty_drafted", agent_object_id: AGENT, payload: { case_id: CASE, round: 0, agent_id: AGENT } },
    });

    it("is alive without credentials", async () => {
        const res = await fetch(`${base}/health`);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { status: "ok", service: "jury-runner" });
    });

    it("answers a signed webhook with a directive", async () => {
        const { raw, headers } = signed(drafted());
        const res = await fetch(`${base}/webhook/engine`, { method: "POST", headers, body: raw });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { action_id: "jury.accept.v1", params: { caseId: CASE, agentId: AGENT } });
    });

    it("rejects an unsigned, wrongly signed or stale request before any work", async () => {
        const body = JSON.stringify(drafted("d2"));
        const bare = await fetch(`${base}/webhook/engine`, { method: "POST", body });
        assert.equal(bare.status, 401);

        const forged = signed(drafted("d2"), "another-secret-of-16+");
        assert.equal((await fetch(`${base}/webhook/engine`, { method: "POST", headers: forged.headers, body: forged.raw })).status, 401);

        const old = signed(drafted("d2"), SECRET, Math.floor(Date.now() / 1000) - 3_600);
        assert.equal((await fetch(`${base}/webhook/engine`, { method: "POST", headers: old.headers, body: old.raw })).status, 401);

        const tampered = signed(drafted("d2"));
        const res = await fetch(`${base}/webhook/engine`, { method: "POST", headers: tampered.headers, body: JSON.stringify(drafted("d3")) });
        assert.equal(res.status, 401);
        assert.equal(modelCalls, 0);
        assert.equal(store.getDelivery("d2"), undefined);
    });

    it("rejects a signed body that is not an engine request", async () => {
        for (const body of [{ not: "a request" }, { delivery_id: "x" }, { delivery_id: "x", event: {} }]) {
            const { raw, headers } = signed(body);
            assert.equal((await fetch(`${base}/webhook/engine`, { method: "POST", headers, body: raw })).status, 400, JSON.stringify(body));
        }
    });

    it("refuses a body over the limit", async () => {
        const raw = Buffer.alloc(8_192, "x");
        const res = await fetch(`${base}/webhook/engine`, {
            method: "POST",
            headers: { "x-myso-timestamp": String(Math.floor(Date.now() / 1000)), "x-myso-signature": signatureFor(SECRET, Math.floor(Date.now() / 1000), raw) },
            body: raw,
        });
        assert.equal(res.status, 413);
    });

    it("serves a rationale only after its reveal and only by a well formed digest", async () => {
        store.putJudgment({
            caseId: CASE, round: 0, agentId: AGENT, outcome: 1, rationale: "private until revealed",
            evidenceRefs: [0], rationaleDigestHex: "ab".repeat(32), bundleDigestHex: "cd".repeat(32),
            saltHex: "ef".repeat(16), commitmentHex: "01".repeat(32), createdAtMs: 1,
        });
        assert.equal((await fetch(`${base}/rationales/${"ab".repeat(32)}`)).status, 404);
        store.markRevealIssued(CASE, 0, AGENT, 2);
        const res = await fetch(`${base}/rationales/${"ab".repeat(32).toUpperCase()}`);
        assert.equal(res.status, 200);
        assert.equal(await res.text(), "private until revealed");
        assert.equal((await fetch(`${base}/rationales/not-a-digest`)).status, 404);
    });

    it("has no other routes", async () => {
        assert.equal((await fetch(`${base}/nope`)).status, 404);
        assert.equal((await fetch(`${base}/webhook/engine`)).status, 404);
    });
});
