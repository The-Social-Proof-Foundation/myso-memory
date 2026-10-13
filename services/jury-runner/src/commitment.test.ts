import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { bcsId, bcsU64, bcsU64Vector, computeCommitment, deriveSalt, sha256Hex } from "./commitment.js";

const rep = (byte: string, n: number) => byte.repeat(n);

describe("commitment", () => {
    // The same vector as the Move test `the_commitment_matches_the_reference_vector_the_runner_uses`.
    it("matches the on-chain reference vector", () => {
        const commitment = computeCommitment({
            caseId: "0xc1",
            round: 1,
            agentId: "0xa1",
            outcome: 1,
            rationaleDigestHex: rep("07", 32),
            evidenceRefs: [0, 2],
            bundleDigestHex: rep("09", 32),
            saltHex: rep("03", 16),
        });
        assert.equal(commitment, "718d31370f8c35fa555188fa50d4feb33e2971449d4d3bc29b4ea7d36b534c31");
    });

    it("binds every field", () => {
        const base = {
            caseId: "0xc1", round: 1, agentId: "0xa1", outcome: 1,
            rationaleDigestHex: rep("07", 32), evidenceRefs: [0, 2],
            bundleDigestHex: rep("09", 32), saltHex: rep("03", 16),
        };
        const reference = computeCommitment(base);
        const variants = [
            { ...base, caseId: "0xc2" },
            { ...base, round: 2 },
            { ...base, agentId: "0xa2" },
            { ...base, outcome: 0 },
            { ...base, rationaleDigestHex: rep("08", 32) },
            { ...base, evidenceRefs: [0] },
            { ...base, bundleDigestHex: rep("0a", 32) },
            { ...base, saltHex: rep("04", 16) },
        ];
        for (const variant of variants) {
            assert.notEqual(computeCommitment(variant), reference);
        }
    });

    it("encodes ids, u64 and vectors like BCS", () => {
        assert.equal(bcsId("0x1").length, 32);
        assert.equal(bcsId("0xAB").toString("hex"), `${"00".repeat(31)}ab`);
        assert.equal(bcsU64(1).toString("hex"), "0100000000000000");
        assert.equal(bcsU64Vector([]).toString("hex"), "00");
        assert.equal(bcsU64Vector([3]).toString("hex"), "010300000000000000");
        // Lengths of 128 and up need a second ULEB128 byte.
        assert.equal(bcsU64Vector(new Array(128).fill(0)).subarray(0, 2).toString("hex"), "8001");
    });

    it("refuses malformed input instead of hashing something else", () => {
        assert.throws(() => bcsId("not hex"));
        assert.throws(() => bcsU64(-1));
        assert.throws(() => bcsU64(2n ** 64n));
        assert.throws(() =>
            computeCommitment({
                caseId: "0xc1", round: 1, agentId: "0xa1", outcome: 256,
                rationaleDigestHex: rep("07", 32), evidenceRefs: [], bundleDigestHex: rep("09", 32), saltHex: rep("03", 16),
            }),
        );
        assert.throws(() =>
            computeCommitment({
                caseId: "0xc1", round: 1, agentId: "0xa1", outcome: 1,
                rationaleDigestHex: rep("07", 31), evidenceRefs: [], bundleDigestHex: rep("09", 32), saltHex: rep("03", 16),
            }),
        );
    });
});

describe("salt", () => {
    it("is stable for one vote and different for another", () => {
        const secret = "s".repeat(32);
        const a = deriveSalt(secret, "0xc1", 0, "0xa1");
        assert.equal(a, deriveSalt(secret, "0xc1", 0, "0xa1"));
        assert.equal(a.length, 32);
        assert.notEqual(a, deriveSalt(secret, "0xc1", 1, "0xa1"));
        assert.notEqual(a, deriveSalt(secret, "0xc2", 0, "0xa1"));
        assert.notEqual(a, deriveSalt(secret, "0xc1", 0, "0xa2"));
        assert.notEqual(a, deriveSalt("t".repeat(32), "0xc1", 0, "0xa1"));
    });
});

describe("sha256Hex", () => {
    it("hashes text and bytes the same way", () => {
        assert.equal(sha256Hex("abc"), sha256Hex(new TextEncoder().encode("abc")));
        assert.equal(sha256Hex("").length, 64);
    });
});
