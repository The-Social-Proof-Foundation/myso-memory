import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PUBLISH_GIVE_UP_MS, RationalePublisher } from "./rationale-publisher.js";
import { MemoryStore, type Judgment } from "./store.js";

const judgment = (over: Partial<Judgment> = {}): Judgment => ({
    caseId: "0xc1",
    round: 0,
    agentId: "0xa1",
    outcome: 1,
    rationale: "Because the evidence shows delivery.",
    evidenceRefs: [0],
    rationaleDigestHex: "ab",
    bundleDigestHex: "cd",
    saltHex: "ef",
    commitmentHex: "01",
    createdAtMs: 1,
    revealIssuedAtMs: 1_000,
    ...over,
});

function setup(answer: (call: number) => Response | Error, nowMs = 2_000) {
    const store = new MemoryStore();
    store.putJudgment(judgment());
    const bodies: Array<Record<string, unknown>> = [];
    const headers: Array<Record<string, string>> = [];
    let calls = 0;
    const publisher = new RationalePublisher({
        store,
        socialServerUrl: "http://social.test",
        secret: "shared",
        fetch: (async (_url: string, init?: RequestInit) => {
            bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
            headers.push(init?.headers as Record<string, string>);
            const next = answer(calls++);
            if (next instanceof Error) throw next;
            return next;
        }) as unknown as typeof fetch,
        now: () => nowMs,
        log: () => undefined,
    });
    return { store, publisher, bodies, headers };
}

const reply = (status: string) => new Response(JSON.stringify({ status }), { status: 200 });

describe("RationalePublisher", () => {
    it("sends the text behind a revealed vote with the secret, then stops offering it", async () => {
        const { store, publisher, bodies, headers } = setup(() => reply("stored"));
        assert.deepEqual(await publisher.tick(), { stored: 1, waiting: 0, refused: 0, failed: 0 });
        assert.deepEqual(bodies[0], {
            caseId: "0xc1",
            round: 0,
            agentId: "0xa1",
            rationale: "Because the evidence shows delivery.",
        });
        assert.equal(headers[0]?.["x-internal-sync-secret"], "shared");
        assert.equal(store.listUnpublished().length, 0);
        assert.deepEqual(await publisher.tick(), { stored: 0, waiting: 0, refused: 0, failed: 0 });
    });

    it("never offers a rationale whose reveal has not been issued", async () => {
        const store = new MemoryStore();
        store.putJudgment(judgment({ revealIssuedAtMs: undefined }));
        assert.equal(store.listUnpublished().length, 0);
    });

    it("waits when the reveal has not reached the indexer, and tries the same text again", async () => {
        const { store, publisher } = setup((call) => reply(call === 0 ? "not_revealed" : "stored"));
        assert.equal((await publisher.tick()).waiting, 1);
        assert.equal(store.listUnpublished().length, 1);
        assert.equal((await publisher.tick()).stored, 1);
    });

    it("gives up on a reveal that never shows up, and on a text that does not match", async () => {
        const waited = setup(() => reply("not_revealed"), 1_000 + PUBLISH_GIVE_UP_MS + 1);
        assert.equal((await waited.publisher.tick()).refused, 1);
        assert.match(waited.store.getJudgment("0xc1", 0, "0xa1")?.publishError ?? "", /never reached/);

        const mismatch = setup(() => reply("mismatch"));
        assert.equal((await mismatch.publisher.tick()).refused, 1);
        assert.equal(mismatch.store.listUnpublished().length, 0);
    });

    it("retries after a network failure or a server error, but not after a client error", async () => {
        const down = setup(() => new Error("connection refused"));
        assert.equal((await down.publisher.tick()).failed, 1);
        assert.equal(down.store.listUnpublished().length, 1);

        const broken = setup(() => new Response("{}", { status: 503 }));
        assert.equal((await broken.publisher.tick()).failed, 1);
        assert.equal(broken.store.listUnpublished().length, 1);

        const refused = setup(() => new Response("{}", { status: 400 }));
        assert.equal((await refused.publisher.tick()).refused, 1);
        assert.equal(refused.store.listUnpublished().length, 0);
    });
});
