import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { BundleError, buildBundle, canonicalJson, digestMatches, menuFor, type SocialReader } from "./bundle.js";
import { sha256Hex } from "./commitment.js";

const sha3 = (text: string) => createHash("sha3-256").update(text).digest("hex");

function reader(overrides: Partial<SocialReader> & { caseRow?: Record<string, unknown> | null } = {}): SocialReader {
    const caseRow =
        overrides.caseRow === undefined
            ? {
                  caseId: "0xc1",
                  subjectKind: 1,
                  subjectId: "0xt1",
                  stage: 0,
                  evidence: [
                      { index: 1, kind: 2, submitter: "0xb", round: 0, uri: "https://e.example.com/b", digest: sha256Hex("buyer says no") },
                      { index: 0, kind: 1, submitter: "0xt1", round: 0, uri: "agent_task:terms", digest: sha3("terms") },
                  ],
              }
            : overrides.caseRow;
    return {
        getCase: overrides.getCase ?? (async () => caseRow),
        getTask:
            overrides.getTask ??
            (async () => ({
                taskId: "0xt1", title: "Report", amountMist: 5_000_000_000, status: 6,
                deliveredAtMs: 900, deliveryDeadlineMs: 1000, secretField: "must not leak",
            })),
        getProposal: overrides.getProposal ?? (async () => null),
    };
}

describe("canonicalJson", () => {
    it("sorts keys at every depth and drops undefined", () => {
        assert.equal(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } }), '{"a":{"d":[3,{"x":2,"y":1}]},"b":1}');
        assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
    });
});

describe("digestMatches", () => {
    it("accepts either hash the chain may have recorded, in any case", () => {
        assert.equal(digestMatches(Buffer.from("x"), sha256Hex("x")), true);
        assert.equal(digestMatches(Buffer.from("x"), sha256Hex("x").toUpperCase()), true);
        assert.equal(digestMatches(Buffer.from("x"), `0x${sha3("x")}`), true);
        assert.equal(digestMatches(Buffer.from("x"), sha256Hex("y")), false);
    });
});

describe("menuFor", () => {
    it("names the fixed outcomes of each kind of case", () => {
        assert.deepEqual(menuFor(1, 0).map((o) => o.index), [0, 1, 2]);
        assert.deepEqual(menuFor(2, 1).map((o) => o.label), ["advance the proposal to the community vote", "reject the proposal"]);
        assert.deepEqual(menuFor(2, 2).map((o) => o.label), ["approve the proposal", "reject the proposal"]);
    });
});

describe("buildBundle", () => {
    const fetchEvidence = async (uri: string) =>
        uri === "https://e.example.com/b" ? { ok: true as const, bytes: Buffer.from("buyer says no") } : { ok: false as const, reason: "not a link" };

    it("verifies evidence against the chain's digest and keeps only what the juror needs", async () => {
        const { bundle } = await buildBundle({ social: reader(), fetchEvidence }, "0xc1", 0);
        assert.deepEqual(bundle.evidence.map((e) => [e.index, e.status]), [[0, "unavailable"], [1, "verified"]]);
        assert.equal(bundle.evidence[1]!.excerpt, "buyer says no");
        assert.equal(bundle.evidence[0]!.excerpt, undefined);
        assert.equal(bundle.subject.title, "Report");
        assert.equal("secretField" in bundle.subject, false);
        assert.deepEqual(bundle.verifiedFacts, { amountMist: 5_000_000_000, deliveredOnTime: true });
    });

    it("flags evidence whose bytes do not match the recorded digest and withholds it", async () => {
        const { bundle } = await buildBundle(
            { social: reader(), fetchEvidence: async () => ({ ok: true, bytes: Buffer.from("someone swapped this") }) },
            "0xc1",
            0,
        );
        assert.equal(bundle.evidence[1]!.status, "mismatch");
        assert.equal(bundle.evidence[1]!.excerpt, undefined);
    });

    it("does not offer binary content as text", async () => {
        const { bundle } = await buildBundle(
            { social: reader(), fetchEvidence: async () => ({ ok: true, bytes: Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xfb]) }) },
            "0xc1",
            0,
        );
        assert.ok(bundle.evidence.every((e) => e.excerpt === undefined));
    });

    it("hashes the same bundle to the same digest and a changed one differently", async () => {
        const a = await buildBundle({ social: reader(), fetchEvidence }, "0xc1", 0);
        const b = await buildBundle({ social: reader(), fetchEvidence }, "0xc1", 0);
        assert.equal(a.digestHex, b.digestHex);
        assert.equal(a.digestHex, sha256Hex(a.canonical));
        const later = await buildBundle({ social: reader(), fetchEvidence }, "0xc1", 1);
        assert.notEqual(a.digestHex, later.digestHex);
    });

    it("builds a governance bundle from the proposal and its stage", async () => {
        const social = reader({
            caseRow: { caseId: "0xc2", subjectKind: 2, subjectId: "0xp1", stage: 2, evidence: [] },
            getProposal: async () => ({
                proposal: { object_id: "0xp1", title: "Raise cap", description: "Because", status: 2, community_votes_for: 0, community_votes_against: 0, internal: "x" },
            }),
        });
        const { bundle } = await buildBundle({ social, fetchEvidence }, "0xc2", 0);
        assert.equal(bundle.subject.title, "Raise cap");
        assert.equal("internal" in bundle.subject, false);
        assert.equal(bundle.verifiedFacts.stage, 2);
        assert.deepEqual(bundle.menu.map((o) => o.label), ["approve the proposal", "reject the proposal"]);
    });

    it("waits for the indexer instead of judging a case it cannot see", async () => {
        await assert.rejects(buildBundle({ social: reader({ caseRow: null }), fetchEvidence }, "0xc1", 0), BundleError);
        await assert.rejects(
            buildBundle({ social: reader({ getTask: async () => null }), fetchEvidence }, "0xc1", 0),
            /not indexed yet/,
        );
        await assert.rejects(
            buildBundle({ social: reader({ caseRow: { caseId: "0xc", subjectKind: 9, subjectId: "0x1", evidence: [] } }), fetchEvidence }, "0xc", 0),
            /unknown subject kind/,
        );
    });
});
