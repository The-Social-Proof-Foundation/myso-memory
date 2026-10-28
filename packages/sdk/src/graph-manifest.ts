import { blake2b } from "@noble/hashes/blake2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { verifyAsync } from "@noble/ed25519";
import { bytesToHex } from "./utils.js";
import { parseMySoKnowledgeGraph, type MySoKnowledgeGraph } from "./knowledge-graph.js";

export interface MySoGraphAuthorityProof {
    kind: "organization_admin" | "sell_graph_delegate";
    organizationId: string;
    delegateId?: string;
    capability: "sell_graph";
    checkedAtMs: number;
}
export interface MySoGraphSourceRight {
    entityId: string;
    evidenceRefIds: string[];
    sourceOwnerAddress: string;
    license: string;
    permissions: Array<"read" | "derive" | "publish" | "sell_graph">;
    expiresAtMs: number | null;
}
export interface MySoGraphOfferTerms {
    accessKind: 2 | 3;
    priceMist: string;
    durationDays: string;
    revocationPolicy: "one_time_perpetual" | "subscription_period_end" | "subscription_early_future_only";
    entitlement: "pinned_version" | "series_stream";
    seriesId?: string;
    audiencePolicy: "buyer_agent_or_explicit_org";
}
export interface MySoGraphManifest {
    schemaVersion: "myso.graph-manifest.v1";
    graphId: string;
    graphVersion: number;
    title: string;
    entities: MySoKnowledgeGraph["nodes"];
    relations: MySoKnowledgeGraph["edges"];
    evidenceRefs: MySoKnowledgeGraph["evidence"];
    provenance: MySoKnowledgeGraph["provenance"];
    coverageKeys: string[];
    encryptionEnvelopeRefs: string[];
    sourceRights: MySoGraphSourceRight[];
}
export interface MySoGraphPublication {
    schemaVersion: "myso.graph-publication.v1";
    sellerAddress: string;
    sellerPublicKeyHex: string;
    manifestHashHex: string;
    /** Present in publication capsule v2; absent only on legacy v1 offers. */
    graphId?: string;
    graphVersion?: number;
    publishedAtMs: number;
    authorityProof: MySoGraphAuthorityProof;
    offerTerms: MySoGraphOfferTerms;
    signatureHex: string;
}
export interface MySoGraphPublicationDocument {
    manifest: MySoGraphManifest;
    publication: MySoGraphPublication;
}
export type GraphAuthorityVerifier = (sellerAddress: string, proof: MySoGraphAuthorityProof) => Promise<boolean>;
export interface GraphPublicationSigner {
    sellerAddress: string;
    sellerPublicKeyHex: string;
    sign(message: Uint8Array): Promise<Uint8Array>;
}
export interface GraphOnchainQuoteTerms { accessKind: 2 | 3; priceMist: string; durationDays: string }

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const addressPattern = /^0x[0-9a-fA-F]{1,64}$/;
const hex = (value: string, bytes?: number) => /^[0-9a-f]+$/i.test(value) && value.length % 2 === 0 && (bytes === undefined || value.length === bytes * 2);
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));

/** Stable JSON encoding used for the manifest commitment and signature payload. */
export function canonicalGraphJson(value: unknown): string {
    if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) throw new Error("Graph commitments only accept safe integer numbers");
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(canonicalGraphJson).join(",")}]`;
    if (isRecord(value)) {
        const entries = Object.keys(value).sort().map((key) => {
            const child = value[key];
            if (child === undefined) throw new Error("Graph commitments do not accept undefined values");
            return `${JSON.stringify(key)}:${canonicalGraphJson(child)}`;
        });
        return `{${entries.join(",")}}`;
    }
    throw new Error("Graph commitments require JSON-compatible data");
}

export function graphManifestHashHex(manifest: MySoGraphManifest): string {
    return bytesToHex(sha256(new TextEncoder().encode(canonicalGraphJson(manifest))));
}

const GRAPH_PUBLICATION_TAG_PREFIX = "mysog1:";
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function encodeBase64(bytes: Uint8Array): string {
    let result = "";
    for (let offset = 0; offset < bytes.length; offset += 3) {
        const a = bytes[offset]!, b = bytes[offset + 1], c = bytes[offset + 2];
        const value = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
        result += BASE64_ALPHABET[(value >>> 18) & 63] + BASE64_ALPHABET[(value >>> 12) & 63]
            + (b === undefined ? "=" : BASE64_ALPHABET[(value >>> 6) & 63])
            + (c === undefined ? "=" : BASE64_ALPHABET[value & 63]);
    }
    return result;
}
function decodeBase64(value: string): Uint8Array {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("Invalid graph publication metadata encoding");
    const output: number[] = [];
    for (let offset = 0; offset < value.length; offset += 4) {
        const chunk = value.slice(offset, offset + 4); const a = BASE64_ALPHABET.indexOf(chunk[0]!); const b = BASE64_ALPHABET.indexOf(chunk[1]!);
        const c = chunk[2] === "=" ? 0 : BASE64_ALPHABET.indexOf(chunk[2]!); const d = chunk[3] === "=" ? 0 : BASE64_ALPHABET.indexOf(chunk[3]!);
        const bits = (a << 18) | (b << 12) | (c << 6) | d;
        output.push((bits >>> 16) & 255); if (chunk[2] !== "=") output.push((bits >>> 8) & 255); if (chunk[3] !== "=") output.push(bits & 255);
    }
    const bytes = Uint8Array.from(output); if (encodeBase64(bytes) !== value) throw new Error("Non-canonical graph publication metadata encoding"); return bytes;
}
function bytesFromHex(value: string, size: number): Uint8Array {
    if (!hex(value, size)) throw new Error("Invalid graph publication metadata bytes");
    return Uint8Array.from(value.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));
}
function addressBytes(value: string): Uint8Array {
    if (!addressPattern.test(value)) throw new Error("Invalid graph publication address");
    return bytesFromHex(value.slice(2).padStart(64, "0"), 32);
}
function canonicalGraphAddress(value: string): string { return `0x${bytesToHex(addressBytes(value))}`; }
function pushU64(out: number[], value: string | number): void {
    const parsed = BigInt(value); if (parsed < 0n || parsed > (1n << 64n) - 1n) throw new Error("Graph publication timestamp or offer term exceeds u64");
    for (let byte = 0; byte < 8; byte++) out.push(Number((parsed >> BigInt(byte * 8)) & 255n));
}
function readU64(bytes: Uint8Array, offset: number): [string, number] {
    if (offset + 8 > bytes.length) throw new Error("Truncated graph publication metadata");
    let value = 0n; for (let byte = 0; byte < 8; byte++) value |= BigInt(bytes[offset + byte]!) << BigInt(byte * 8);
    return [value.toString(), offset + 8];
}

/** Split the compact signed publication capsule across MyData's public 64-byte tags. */
export function encodeMySoGraphPublicationTags(publicationInput: MySoGraphPublication): string[] {
    const publication = validatePublication(publicationInput); const terms = publication.offerTerms; const proof = publication.authorityProof;
    const series = new TextEncoder().encode(terms.seriesId ?? "");
    if (series.byteLength > 128 || (terms.seriesId !== undefined && !idPattern.test(terms.seriesId))) throw new Error("Graph publication series ID is too long for public metadata");
    const capsuleVersion = publication.graphId === undefined ? 1 : 2;
    const out = [0x4d, 0x47, 0x50, 0x31, capsuleVersion, ...bytesFromHex(publication.sellerPublicKeyHex, 32), ...bytesFromHex(publication.manifestHashHex, 32)];
    if (capsuleVersion === 2) {
        const graphId = new TextEncoder().encode(publication.graphId!);
        if (graphId.byteLength > 128) throw new Error("Graph ID is too long for public metadata");
        out.push(graphId.byteLength, ...graphId);
        pushU64(out, publication.graphVersion!);
    }
    pushU64(out, publication.publishedAtMs); out.push(proof.kind === "organization_admin" ? 0 : 1, ...addressBytes(proof.organizationId));
    out.push(...(proof.delegateId ? addressBytes(proof.delegateId) : new Uint8Array(32))); pushU64(out, proof.checkedAtMs);
    out.push(terms.accessKind); pushU64(out, terms.priceMist); pushU64(out, terms.durationDays);
    out.push(terms.revocationPolicy === "one_time_perpetual" ? 0 : terms.revocationPolicy === "subscription_period_end" ? 1 : 2);
    out.push(terms.entitlement === "pinned_version" ? 0 : 1, series.byteLength, ...series, ...bytesFromHex(publication.signatureHex, 64));
    const payload = encodeBase64(Uint8Array.from(out)); const maxChunk = 51; const count = Math.ceil(payload.length / maxChunk);
    if (count < 1 || count > 10) throw new Error("Graph publication proof exceeds MyData's public tag capacity");
    const tags = Array.from({ length: count }, (_, index) => `${GRAPH_PUBLICATION_TAG_PREFIX}${index + 1}/${count}:${payload.slice(index * maxChunk, (index + 1) * maxChunk)}`);
    if (tags.some((tag) => new TextEncoder().encode(tag).byteLength > 64)) throw new Error("Graph publication proof exceeds MyData's per-tag limit");
    return tags;
}

/** Reassemble the publication capsule from the quoted listing's public tags. */
export function decodeMySoGraphPublicationTags(tags: string[], expectedSellerAddress: string): MySoGraphPublication {
    if (!addressPattern.test(expectedSellerAddress) || !Array.isArray(tags) || tags.length > 10 || tags.some((tag) => typeof tag !== "string" || new TextEncoder().encode(tag).byteLength > 64)) throw new Error("Invalid graph publication tags");
    const chunks = tags.filter((tag) => tag.startsWith(GRAPH_PUBLICATION_TAG_PREFIX)).map((tag) => {
        const match = /^mysog1:(\d{1,2})\/(\d{1,2}):([A-Za-z0-9+/=]+)$/.exec(tag); if (!match) throw new Error("Malformed graph publication tag");
        return { index: Number(match[1]), count: Number(match[2]), value: match[3]! };
    });
    if (chunks.length === 0 || chunks.length > 10 || chunks.some((chunk) => chunk.count !== chunks.length || chunk.index < 1 || chunk.index > chunks.length)
        || new Set(chunks.map((chunk) => chunk.index)).size !== chunks.length) throw new Error("Graph publication tags are incomplete");
    chunks.sort((a, b) => a.index - b.index); const bytes = decodeBase64(chunks.map((chunk) => chunk.value).join("")); let offset = 0;
    const take = (length: number): Uint8Array => { if (length < 0 || offset + length > bytes.length) throw new Error("Truncated graph publication metadata"); const value = bytes.slice(offset, offset + length); offset += length; return value; };
    const magic = take(5); const capsuleVersion = magic[4];
    if (bytesToHex(magic.slice(0, 4)) !== "4d475031" || (capsuleVersion !== 1 && capsuleVersion !== 2)) throw new Error("Unsupported graph publication tag version");
    const publicKey = take(32); const manifestHash = take(32); let publishedAtMs: string; [publishedAtMs, offset] = readU64(bytes, offset);
    let graphId: string | undefined; let graphVersion: string | undefined;
    if (capsuleVersion === 2) {
        const graphIdLength = take(1)[0]!;
        graphId = new TextDecoder("utf-8", { fatal: true }).decode(take(graphIdLength));
        [graphVersion, offset] = readU64(bytes, offset);
    }
    const proofKind = take(1)[0]!; if (proofKind > 1) throw new Error("Invalid graph seller authority kind");
    const organizationId = `0x${bytesToHex(take(32))}`; const delegateBytes = take(32); let checkedAtMs: string; [checkedAtMs, offset] = readU64(bytes, offset);
    const accessKind = take(1)[0]!; if (accessKind !== 2 && accessKind !== 3) throw new Error("Invalid graph access kind");
    let priceMist: string; [priceMist, offset] = readU64(bytes, offset); let durationDays: string; [durationDays, offset] = readU64(bytes, offset);
    const revocationCode = take(1)[0]!; const entitlementCode = take(1)[0]!; const seriesLength = take(1)[0]!; const seriesBytes = take(seriesLength);
    const signature = take(64); if (offset !== bytes.length || revocationCode > 2 || entitlementCode > 1) throw new Error("Malformed graph publication metadata payload");
    const seriesId = new TextDecoder("utf-8", { fatal: true }).decode(seriesBytes);
    const publication: MySoGraphPublication = {
        schemaVersion: "myso.graph-publication.v1", sellerAddress: expectedSellerAddress,
        sellerPublicKeyHex: bytesToHex(publicKey), manifestHashHex: bytesToHex(manifestHash), publishedAtMs: Number(publishedAtMs),
        ...(graphId !== undefined ? { graphId, graphVersion: Number(graphVersion) } : {}),
        authorityProof: { kind: proofKind === 0 ? "organization_admin" : "sell_graph_delegate", organizationId,
            ...(proofKind === 1 ? { delegateId: `0x${bytesToHex(delegateBytes)}` } : {}), capability: "sell_graph", checkedAtMs: Number(checkedAtMs) },
        offerTerms: { accessKind, priceMist, durationDays,
            revocationPolicy: revocationCode === 0 ? "one_time_perpetual" : revocationCode === 1 ? "subscription_period_end" : "subscription_early_future_only",
            entitlement: entitlementCode === 0 ? "pinned_version" : "series_stream", ...(seriesLength ? { seriesId } : {}), audiencePolicy: "buyer_agent_or_explicit_org" },
        signatureHex: bytesToHex(signature),
    };
    return validatePublication(publication);
}

export function parseMySoGraphManifest(value: unknown, nowMs = Date.now()): MySoGraphManifest {
    if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "graphId", "graphVersion", "title", "entities", "relations", "evidenceRefs", "provenance", "coverageKeys", "encryptionEnvelopeRefs", "sourceRights"]) || value.schemaVersion !== "myso.graph-manifest.v1"
        || typeof value.graphId !== "string" || !idPattern.test(value.graphId)
        || !Number.isSafeInteger(value.graphVersion) || Number(value.graphVersion) < 1
        || typeof value.title !== "string" || value.title.length > 500
        || !Array.isArray(value.entities) || !Array.isArray(value.relations) || !Array.isArray(value.evidenceRefs)
        || !Array.isArray(value.provenance) || !Array.isArray(value.coverageKeys) || value.coverageKeys.length > 20_000
        || !Array.isArray(value.encryptionEnvelopeRefs) || value.encryptionEnvelopeRefs.length < 1 || value.encryptionEnvelopeRefs.length > 10_000
        || !Array.isArray(value.sourceRights) || value.sourceRights.length > 2_000) throw new Error("Unsupported MySocial GraphManifest");
    const graph = parseMySoKnowledgeGraph({
        schemaVersion: "myso.knowledge-graph.v1", graphId: value.graphId, graphVersion: value.graphVersion,
        title: value.title, nodes: value.entities, edges: value.relations, evidence: value.evidenceRefs, provenance: value.provenance,
    });
    const coverage = value.coverageKeys as unknown[];
    if (coverage.some((key) => typeof key !== "string" || key.length < 1 || key.length > 256) || new Set(coverage).size !== coverage.length) throw new Error("Invalid GraphManifest coverage keys");
    const envelopes = value.encryptionEnvelopeRefs as unknown[];
    if (envelopes.some((ref) => typeof ref !== "string" || !/^sha256:[0-9a-f]{64}$/.test(ref)) || new Set(envelopes).size !== envelopes.length) throw new Error("Invalid GraphManifest encryption-envelope reference");
    const evidenceIds = new Set(graph.evidence.map((item) => item.id));
    const rights = value.sourceRights as unknown[];
    const rightsByEntity = new Map<string, MySoGraphSourceRight>();
    for (const right of rights) {
        if (!isRecord(right) || !exactKeys(right, ["entityId", "evidenceRefIds", "sourceOwnerAddress", "license", "permissions", "expiresAtMs"]) || typeof right.entityId !== "string" || !idPattern.test(right.entityId) || rightsByEntity.has(right.entityId)
            || !Array.isArray(right.evidenceRefIds) || right.evidenceRefIds.length > 500
            || right.evidenceRefIds.some((id) => typeof id !== "string" || !evidenceIds.has(id))
            || typeof right.sourceOwnerAddress !== "string" || !addressPattern.test(right.sourceOwnerAddress)
            || typeof right.license !== "string" || right.license.length < 1 || right.license.length > 256
            || !Array.isArray(right.permissions) || right.permissions.length === 0
            || new Set(right.permissions).size !== right.permissions.length
            || right.permissions.some((permission) => !["read", "derive", "publish", "sell_graph"].includes(String(permission)))
            || (right.expiresAtMs !== null && (!Number.isSafeInteger(right.expiresAtMs) || Number(right.expiresAtMs) < nowMs))) throw new Error("Invalid or expired GraphManifest source_rights claim");
        rightsByEntity.set(right.entityId, right as unknown as MySoGraphSourceRight);
    }
    for (const entity of graph.nodes) {
        const right = rightsByEntity.get(entity.id);
        if (!right || !right.permissions.includes("sell_graph") || entity.evidenceIds.some((id) => !right.evidenceRefIds.includes(id))) throw new Error("A graph entity lacks complete sell_graph source_rights");
    }
    if (rightsByEntity.size !== graph.nodes.length) throw new Error("GraphManifest source_rights references an unknown entity");
    const coveredEvidence = new Set([...rightsByEntity.values()].flatMap((right) => right.evidenceRefIds));
    if (graph.evidence.some((item) => !coveredEvidence.has(item.id))) throw new Error("A graph evidence source lacks a seller-signed source_rights claim");
    return value as unknown as MySoGraphManifest;
}

/** Produces the immutable seller publication record after the caller has checked live sell_graph authority. */
export async function createMySoGraphPublication(
    manifestInput: unknown,
    authorityProof: MySoGraphAuthorityProof,
    offerTerms: MySoGraphOfferTerms,
    signer: GraphPublicationSigner,
    hasLiveAuthority: GraphAuthorityVerifier,
    publishedAtMs = Date.now(),
): Promise<MySoGraphPublicationDocument> {
    const manifest = parseMySoGraphManifest(manifestInput);
    const publicKeyHex = signer.sellerPublicKeyHex.toLowerCase();
    const sellerAddress = signer.sellerAddress.toLowerCase();
    const normalizedProof = { ...authorityProof, organizationId: canonicalGraphAddress(authorityProof.organizationId), ...(authorityProof.delegateId ? { delegateId: canonicalGraphAddress(authorityProof.delegateId) } : {}) };
    if (!addressPattern.test(sellerAddress) || !hex(publicKeyHex, 32) || !Number.isSafeInteger(publishedAtMs) || publishedAtMs < 0) throw new Error("Invalid graph publication signer");
    if (offerTerms.entitlement !== "pinned_version") throw new Error("MyData graph purchases cover one immutable version; future versions require separate offers and purchases");
    const publicKey = Uint8Array.from(publicKeyHex.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));
    const derivedAddress = `0x${bytesToHex(blake2b(new Uint8Array([0, ...publicKey]), { dkLen: 32 }))}`;
    if (derivedAddress !== sellerAddress) throw new Error("Graph publication signer address does not match its public key");
    if (!await hasLiveAuthority(sellerAddress, normalizedProof)) throw new Error("Seller does not have current graph-selling authority");
    validateOfferTerms(offerTerms);
    validateAuthorityProof(normalizedProof);
    if (normalizedProof.kind === "sell_graph_delegate" && normalizedProof.delegateId !== sellerAddress) throw new Error("Graph selling delegation must identify the signing seller");
    validatePublication({ schemaVersion: "myso.graph-publication.v1", sellerAddress, sellerPublicKeyHex: publicKeyHex,
        manifestHashHex: graphManifestHashHex(manifest), graphId: manifest.graphId, graphVersion: manifest.graphVersion, publishedAtMs, authorityProof: normalizedProof, offerTerms, signatureHex: "00".repeat(64) });
    const signed = { domain: "mysocial-graph-publication-v1", manifestHashHex: graphManifestHashHex(manifest),
        sellerAddress, graphId: manifest.graphId, graphVersion: manifest.graphVersion, publishedAtMs, authorityProof: normalizedProof, offerTerms };
    const signature = await signer.sign(new TextEncoder().encode(canonicalGraphJson(signed)));
    if (signature.byteLength !== 64) throw new Error("Graph publication signer returned an invalid Ed25519 signature");
    return { manifest, publication: { schemaVersion: "myso.graph-publication.v1", sellerAddress,
        sellerPublicKeyHex: publicKeyHex, manifestHashHex: signed.manifestHashHex, graphId: manifest.graphId, graphVersion: manifest.graphVersion,
        publishedAtMs, authorityProof: normalizedProof, offerTerms, signatureHex: bytesToHex(signature) } };
}

function validateAuthorityProof(value: unknown): asserts value is MySoGraphAuthorityProof {
    if (!isRecord(value) || !exactKeys(value, ["kind", "organizationId", "delegateId", "capability", "checkedAtMs"])
        || value.capability !== "sell_graph" || !["organization_admin", "sell_graph_delegate"].includes(String(value.kind))
        || typeof value.organizationId !== "string" || !addressPattern.test(value.organizationId)
        || (value.kind === "sell_graph_delegate" && (typeof value.delegateId !== "string" || !addressPattern.test(value.delegateId)))
        || (value.kind === "organization_admin" && value.delegateId !== undefined)
        || !Number.isSafeInteger(value.checkedAtMs) || Number(value.checkedAtMs) < 0) throw new Error("Invalid graph-selling authority proof");
}

function validateOfferTerms(value: unknown): asserts value is MySoGraphOfferTerms {
    if (!isRecord(value) || !exactKeys(value, ["accessKind", "priceMist", "durationDays", "revocationPolicy", "entitlement", "seriesId", "audiencePolicy"])
        || ![2, 3].includes(Number(value.accessKind))
        || typeof value.priceMist !== "string" || !/^[1-9][0-9]{0,19}$/.test(value.priceMist) || BigInt(value.priceMist) > (1n << 64n) - 1n
        || typeof value.durationDays !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value.durationDays) || BigInt(value.durationDays) > (1n << 64n) - 1n
        || !["one_time_perpetual", "subscription_period_end", "subscription_early_future_only"].includes(String(value.revocationPolicy))
        || !["pinned_version", "series_stream"].includes(String(value.entitlement))
        || value.audiencePolicy !== "buyer_agent_or_explicit_org") throw new Error("Invalid graph offer terms");
    const accessKind = Number(value.accessKind); const duration = BigInt(value.durationDays);
    if ((accessKind === 2 && (duration !== 0n || value.revocationPolicy !== "one_time_perpetual" || value.entitlement !== "pinned_version" || value.seriesId !== undefined))
        || (accessKind === 3 && (duration === 0n || value.revocationPolicy === "one_time_perpetual"))
        || (value.entitlement === "series_stream" && (accessKind !== 3 || typeof value.seriesId !== "string" || !idPattern.test(value.seriesId)))
        || (value.entitlement === "pinned_version" && value.seriesId !== undefined)) throw new Error("Graph offer terms conflict with the MyData access kind");
}

function validatePublication(value: unknown): MySoGraphPublication {
    if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "sellerAddress", "sellerPublicKeyHex", "manifestHashHex", "publishedAtMs", "authorityProof", "offerTerms", "signatureHex", "graphId", "graphVersion"]) || value.schemaVersion !== "myso.graph-publication.v1"
        || typeof value.sellerAddress !== "string" || !addressPattern.test(value.sellerAddress)
        || typeof value.sellerPublicKeyHex !== "string" || !hex(value.sellerPublicKeyHex, 32)
        || typeof value.manifestHashHex !== "string" || !hex(value.manifestHashHex, 32)
        || ((value.graphId === undefined) !== (value.graphVersion === undefined))
        || (value.graphId !== undefined && (typeof value.graphId !== "string" || !idPattern.test(value.graphId)
            || !Number.isSafeInteger(value.graphVersion) || Number(value.graphVersion) < 1))
        || !Number.isSafeInteger(value.publishedAtMs) || Number(value.publishedAtMs) < 0
        || typeof value.signatureHex !== "string" || !hex(value.signatureHex, 64)) throw new Error("Invalid GraphManifest publication record");
    validateAuthorityProof(value.authorityProof);
    validateOfferTerms(value.offerTerms);
    return value as unknown as MySoGraphPublication;
}

/** Verifies public seller metadata and current authority before a buyer spends. */
export async function verifyMySoGraphPublicationMetadata(
    value: unknown,
    expectedSellerAddress: string,
    expectedOnchainTerms: GraphOnchainQuoteTerms,
    hasLiveAuthority: GraphAuthorityVerifier,
): Promise<MySoGraphPublication> {
    if (!addressPattern.test(expectedSellerAddress)) throw new Error("Invalid quoted MyData seller address");
    const publication = validatePublication(value);
    if (publication.authorityProof.kind === "sell_graph_delegate" && publication.authorityProof.delegateId?.toLowerCase() !== publication.sellerAddress.toLowerCase()) throw new Error("Graph publication delegate does not match the seller");
    if (publication.offerTerms.accessKind !== expectedOnchainTerms.accessKind || publication.offerTerms.priceMist !== expectedOnchainTerms.priceMist || publication.offerTerms.durationDays !== expectedOnchainTerms.durationDays) throw new Error("Signed graph terms do not match the current MyData quote");
    const publicKey = Uint8Array.from(publication.sellerPublicKeyHex.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));
    const derivedAddress = `0x${bytesToHex(blake2b(new Uint8Array([0, ...publicKey]), { dkLen: 32 }))}`;
    if (derivedAddress.toLowerCase() !== publication.sellerAddress.toLowerCase() || derivedAddress.toLowerCase() !== expectedSellerAddress.toLowerCase()) throw new Error("Graph publication key is not bound to the quoted MyData seller");
    const signed: Record<string, unknown> = {
        domain: "mysocial-graph-publication-v1", manifestHashHex: publication.manifestHashHex,
        sellerAddress: publication.sellerAddress, publishedAtMs: publication.publishedAtMs, authorityProof: publication.authorityProof, offerTerms: publication.offerTerms,
    };
    if (publication.graphId !== undefined) { signed.graphId = publication.graphId; signed.graphVersion = publication.graphVersion; }
    const signature = Uint8Array.from(publication.signatureHex.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));
    if (!await verifyAsync(signature, new TextEncoder().encode(canonicalGraphJson(signed)), publicKey)) throw new Error("Graph publication signature is invalid");
    if (!await hasLiveAuthority(publication.sellerAddress, publication.authorityProof)) throw new Error("Seller no longer has live graph-selling authority");
    return publication;
}

/** Validates the immutable content hash, seller key/address binding, Ed25519 signature and live selling authority. */
export async function verifyMySoGraphPublication(
    value: unknown,
    expectedSellerAddress: string,
    expectedOnchainTerms: GraphOnchainQuoteTerms,
    hasLiveAuthority: GraphAuthorityVerifier,
): Promise<MySoGraphPublicationDocument> {
    if (!isRecord(value) || !exactKeys(value, ["manifest", "publication"]) || !isRecord(value.manifest)) throw new Error("Graph publication document is malformed");
    const manifest = parseMySoGraphManifest(value.manifest);
    const publication = await verifyMySoGraphPublicationMetadata(value.publication, expectedSellerAddress, expectedOnchainTerms, hasLiveAuthority);
    const expectedHash = graphManifestHashHex(manifest);
    if (publication.manifestHashHex !== expectedHash) throw new Error("GraphManifest hash does not match its publication");
    if (publication.graphId !== undefined && (publication.graphId !== manifest.graphId || publication.graphVersion !== manifest.graphVersion)) throw new Error("GraphManifest identity does not match its signed publication");
    return { manifest, publication };
}
