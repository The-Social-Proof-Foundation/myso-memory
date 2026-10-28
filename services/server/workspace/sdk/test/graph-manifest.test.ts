import assert from "node:assert/strict";
import test from "node:test";
import { getPublicKeyAsync, signAsync } from "@noble/ed25519";
import { blake2b } from "@noble/hashes/blake2.js";
import { bytesToHex } from "../src/utils.js";
import { canonicalGraphJson, createMySoGraphPublication, decodeMySoGraphPublicationTags, encodeMySoGraphPublicationTags, graphManifestHashHex, parseMySoGraphManifest, verifyMySoGraphPublication, verifyMySoGraphPublicationMetadata, type MySoGraphManifest } from "../src/graph-manifest.js";

const privateKey = new Uint8Array(32).fill(7);
const sourceOwner = "0x0000000000000000000000000000000000000000000000000000000000000009";
const organizationId = "0x0000000000000000000000000000000000000000000000000000000000000010";
const manifest: MySoGraphManifest = {
    schemaVersion: "myso.graph-manifest.v1", graphId: "team-graph", graphVersion: 1, title: "Team graph",
    entities: [{ id: "task-1", kind: "task", label: "Review", statement: "Review the task", aliases: [], evidenceIds: ["evidence-1"], state: "asserted" }],
    relations: [],
    evidenceRefs: [{ id: "evidence-1", kind: "owner_assertion", sourceId: "owner://task-1", sourceVersion: "1", visibility: "organization", derivationEvidenceIds: [], state: "asserted", recordedAt: "2026-10-25T00:00:00.000Z" }],
    provenance: [], coverageKeys: ["task:task-1"], encryptionEnvelopeRefs: [`sha256:${"a".repeat(64)}`],
    sourceRights: [{ entityId: "task-1", evidenceRefIds: ["evidence-1"], sourceOwnerAddress: sourceOwner, license: "owner-granted", permissions: ["read", "derive", "publish", "sell_graph"], expiresAtMs: null }],
};
const terms = { accessKind: 3 as const, priceMist: "2500", durationDays: "30", revocationPolicy: "subscription_period_end" as const, entitlement: "pinned_version" as const, audiencePolicy: "buyer_agent_or_explicit_org" as const };
const authorityProof = { kind: "organization_admin" as const, organizationId, capability: "sell_graph" as const, checkedAtMs: 1_798_272_000_000 };

async function signer() {
    const publicKey = await getPublicKeyAsync(privateKey);
    const address = `0x${bytesToHex(blake2b(new Uint8Array([0, ...publicKey]), { dkLen: 32 }))}`;
    return { sellerAddress: address, sellerPublicKeyHex: bytesToHex(publicKey), sign: (message: Uint8Array) => signAsync(message, privateKey) };
}

test("canonical graph JSON commits object keys in stable order", () => {
    assert.equal(canonicalGraphJson({ b: 2, a: 1 }), canonicalGraphJson({ a: 1, b: 2 }));
    assert.equal(graphManifestHashHex(manifest), graphManifestHashHex({ ...manifest, title: "Team graph" }));
});

test("GraphManifest rejects entities without complete sell_graph rights", () => {
    const invalid = structuredClone(manifest);
    invalid.sourceRights[0]!.evidenceRefIds = [];
    assert.throws(() => parseMySoGraphManifest(invalid), /source_rights/);
});

test("publication binds the seller key, manifest, live authority and exact MyData terms", async () => {
    const owner = await signer();
    const document = await createMySoGraphPublication(manifest, authorityProof, terms, owner, async () => true, 1_798_272_000_001);
    const verified = await verifyMySoGraphPublication(document, owner.sellerAddress, { accessKind: 3, priceMist: "2500", durationDays: "30" }, async () => true);
    assert.equal(verified.publication.manifestHashHex, graphManifestHashHex(manifest));
    assert.equal(verified.publication.graphId, manifest.graphId);
    assert.equal(verified.publication.graphVersion, manifest.graphVersion);
    await assert.rejects(verifyMySoGraphPublication({ ...document, publication: { ...document.publication, graphVersion: 2 } }, owner.sellerAddress, { accessKind: 3, priceMist: "2500", durationDays: "30" }, async () => true), /signature is invalid/);
    await assert.rejects(verifyMySoGraphPublication(document, owner.sellerAddress, { accessKind: 3, priceMist: "2501", durationDays: "30" }, async () => true), /do not match/);
    await assert.rejects(verifyMySoGraphPublication(document, sourceOwner, { accessKind: 3, priceMist: "2500", durationDays: "30" }, async () => true), /not bound/);
    await assert.rejects(verifyMySoGraphPublication(document, owner.sellerAddress, { accessKind: 3, priceMist: "2500", durationDays: "30" }, async () => false), /live graph-selling authority/);
});

test("public tags carry a bounded proof that verifies before purchase", async () => {
    const owner = await signer();
    const document = await createMySoGraphPublication(manifest, authorityProof, terms, owner, async () => true, 1_798_272_000_001);
    const tags = encodeMySoGraphPublicationTags(document.publication);
    assert.ok(tags.length <= 10);
    assert.ok(tags.every((tag) => new TextEncoder().encode(tag).byteLength <= 64));
    const capsule = decodeMySoGraphPublicationTags(tags, owner.sellerAddress);
    const verified = await verifyMySoGraphPublicationMetadata(capsule, owner.sellerAddress, { accessKind: 3, priceMist: "2500", durationDays: "30" }, async () => true);
    assert.equal(verified.manifestHashHex, graphManifestHashHex(manifest));
    assert.equal(verified.graphId, manifest.graphId);
    assert.equal(verified.graphVersion, manifest.graphVersion);
    assert.throws(() => decodeMySoGraphPublicationTags(tags.slice(0, -1), owner.sellerAddress), /incomplete/);
});
