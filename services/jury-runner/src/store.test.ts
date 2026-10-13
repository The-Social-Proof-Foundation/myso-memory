import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { FileStore, MemoryStore, type Judgment } from "./store.js";

function judgment(over: Partial<Judgment> = {}): Judgment {
    return {
        caseId: "0xC1", round: 0, agentId: "0xA1", outcome: 1, rationale: "because",
        evidenceRefs: [0], rationaleDigestHex: "aa".repeat(32), bundleDigestHex: "bb".repeat(32),
        saltHex: "cc".repeat(16), commitmentHex: "dd".repeat(32), createdAtMs: 1, ...over,
    };
}

describe("MemoryStore", () => {
    it("finds a judgment regardless of id case", () => {
        const store = new MemoryStore();
        store.putJudgment(judgment());
        assert.equal(store.getJudgment("0xc1", 0, "0xa1")?.outcome, 1);
        assert.equal(store.getJudgment("0xc1", 1, "0xa1"), undefined);
        assert.equal(store.getJudgment("0xc1", 0, "0xa2"), undefined);
    });

    it("keeps a rationale private until its reveal has been issued", () => {
        const store = new MemoryStore();
        store.putJudgment(judgment());
        assert.equal(store.getRevealedRationale("aa".repeat(32)), undefined);
        store.markRevealIssued("0xC1", 0, "0xA1", 5);
        assert.equal(store.getRevealedRationale("aa".repeat(32)), "because");
        // Marking again keeps the first time.
        store.markRevealIssued("0xC1", 0, "0xA1", 9);
        assert.equal(store.getJudgment("0xc1", 0, "0xa1")?.revealIssuedAtMs, 5);
    });

    it("replays the same directive for a repeated delivery", () => {
        const store = new MemoryStore();
        store.putDelivery("d1", { noop: true, reason: "first" }, 1);
        assert.deepEqual(store.getDelivery("d1"), { noop: true, reason: "first" });
        assert.equal(store.getDelivery("d2"), undefined);
    });

    it("forgets the oldest deliveries beyond its bound", () => {
        const store = new MemoryStore();
        for (let i = 0; i < 5_003; i += 1) store.putDelivery(`d${i}`, { noop: true }, i);
        assert.equal(store.getDelivery("d0"), undefined);
        assert.equal(store.getDelivery("d2"), undefined);
        assert.ok(store.getDelivery("d5002"));
    });
});

describe("FileStore", () => {
    it("survives a restart and writes a private file", () => {
        const path = join(mkdtempSync(join(tmpdir(), "jury-store-")), "nested", "store.json");
        const first = new FileStore(path);
        first.putJudgment(judgment());
        first.putDelivery("d1", { action_id: "jury.accept.v1", params: { caseId: "0xc1" } }, 3);

        const second = new FileStore(path);
        assert.equal(second.getJudgment("0xc1", 0, "0xa1")?.rationale, "because");
        assert.deepEqual(second.getDelivery("d1"), { action_id: "jury.accept.v1", params: { caseId: "0xc1" } });
        assert.equal(statSync(path).mode & 0o077, 0, "the file must not be readable by others");
        assert.doesNotThrow(() => JSON.parse(readFileSync(path, "utf8")));
    });

    it("starts empty when there is no file yet and refuses a corrupt one", () => {
        const dir = mkdtempSync(join(tmpdir(), "jury-store-"));
        assert.equal(new FileStore(join(dir, "none.json")).getDelivery("x"), undefined);
        const bad = join(dir, "bad.json");
        writeFileSync(bad, "{not json");
        assert.throws(() => new FileStore(bad), /cannot read the judgment store/);
    });
});
