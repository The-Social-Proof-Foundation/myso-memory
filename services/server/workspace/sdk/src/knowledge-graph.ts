import type { MyDataContentPage, MyDataContentRequest } from "./types.js";
import type { GraphAuthorityVerifier, MySoGraphPublication } from "./graph-manifest.js";

export type MySoGraphEvidenceState = "asserted" | "verified" | "disputed" | "superseded" | "revoked";
export type MySoGraphNodeKind = "concept" | "person" | "organization" | "task" | "claim" | "artifact" | "room";
export type MySoGraphEvidenceKind = "task_receipt" | "action_receipt" | "artifact" | "room_message" | "owner_assertion" | "external_source";
export type MySoGraphEdgeKind = "related_to" | "supports" | "contradicts" | "depends_on" | "assigned_to" | "member_of" | "participates_in" | "references" | "derived_from" | "created_by" | "delivered_to" | "published_in" | "owns" | "completed_by" | "originates_from";
export interface MySoGraphNode {
    id: string; kind: MySoGraphNodeKind; label: string; statement: string;
    aliases: string[]; evidenceIds: string[]; state: MySoGraphEvidenceState;
}
export interface MySoGraphEdge {
    id: string; kind: MySoGraphEdgeKind; sourceId: string; targetId: string;
    evidenceIds: string[]; state: MySoGraphEvidenceState;
}
export interface MySoGraphEvidence {
    id: string; kind: MySoGraphEvidenceKind; sourceId: string; sourceVersion: string;
    digestHex?: string; receiptId?: string; artifactId?: string; visibility: "private" | "organization" | "room";
    derivationEvidenceIds: string[]; state: MySoGraphEvidenceState; recordedAt: string;
}
export interface MySoGraphProvenance {
    id: string; subjectType: "node" | "edge"; subjectId: string; evidenceId: string;
    actor: "owner" | "agent" | "system"; recordedAt: string; state: MySoGraphEvidenceState;
}
export interface MySoKnowledgeGraph {
    schemaVersion: "myso.knowledge-graph.v1"; graphId: string; graphVersion: number; title: string;
    nodes: MySoGraphNode[]; edges: MySoGraphEdge[]; evidence: MySoGraphEvidence[]; provenance: MySoGraphProvenance[];
}
export interface MyDataGraphSearchRequest {
    mydataId: string; encryptedDataDigestHex: string; query: string; limit?: number; kinds?: MySoGraphNodeKind[]; organizationAudienceId?: string;
}
export interface MyDataGraphSearchResult {
    mydataId: string; encryptedDataDigestHex: string; graphId: string; graphVersion: number;
    query: string; matches: Array<{ node: MySoGraphNode; edges: MySoGraphEdge[]; evidence: MySoGraphEvidence[]; provenance: MySoGraphProvenance[] }>;
    access: MyDataContentPage["access"];
    verifiedPublication?: MySoGraphPublication;
    evidenceNotice: "Graph assertions are private content; verified state is a label and does not replace independent receipt verification.";
}
export interface MyDataGraphItemRequest {
    mydataId: string; encryptedDataDigestHex: string; kind: "node" | "edge" | "evidence"; id: string; organizationAudienceId?: string;
}
export interface MyDataGraphItemResult {
    mydataId: string; encryptedDataDigestHex: string; graphId: string; graphVersion: number;
    kind: MyDataGraphItemRequest["kind"]; item: MySoGraphNode | MySoGraphEdge | MySoGraphEvidence;
    nodes: MySoGraphNode[]; edges: MySoGraphEdge[]; evidence: MySoGraphEvidence[]; provenance: MySoGraphProvenance[];
    access: MyDataContentPage["access"];
    verifiedPublication?: MySoGraphPublication;
    evidenceNotice: MyDataGraphSearchResult["evidenceNotice"];
}

const nodeKinds = new Set<MySoGraphNodeKind>(["concept", "person", "organization", "task", "claim", "artifact", "room"]);
const evidenceKinds = new Set<MySoGraphEvidenceKind>(["task_receipt", "action_receipt", "artifact", "room_message", "owner_assertion", "external_source"]);
const edgeKinds = new Set<MySoGraphEdgeKind>(["related_to", "supports", "contradicts", "depends_on", "assigned_to", "member_of", "participates_in", "references", "derived_from", "created_by", "delivered_to", "published_in", "owns", "completed_by", "originates_from"]);
const states = new Set<MySoGraphEvidenceState>(["asserted", "verified", "disputed", "superseded", "revoked"]);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown, max = 4096): value is string => typeof value === "string" && value.length <= max;
function strings(value: unknown, maximum: number): value is string[] { return Array.isArray(value) && value.length <= maximum && value.every((item) => string(item, 512)); }
function uniqueIds(values: string[]): boolean { return values.every((value) => idPattern.test(value)) && new Set(values).size === values.length; }
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }

/** Strict schema and cross-reference validation for encrypted MySo graph JSON. */
export function parseMySoKnowledgeGraph(value: unknown): MySoKnowledgeGraph {
    if (!record(value) || !exactKeys(value, ["schemaVersion", "graphId", "graphVersion", "title", "nodes", "edges", "evidence", "provenance"]) || value.schemaVersion !== "myso.knowledge-graph.v1" || !string(value.graphId, 200) || !idPattern.test(value.graphId)
        || !Number.isSafeInteger(value.graphVersion) || Number(value.graphVersion) < 1 || !string(value.title, 500)
        || !Array.isArray(value.nodes) || value.nodes.length > 2000 || !Array.isArray(value.edges) || value.edges.length > 10000
        || !Array.isArray(value.evidence) || value.evidence.length > 10000 || !Array.isArray(value.provenance) || value.provenance.length > 20000) {
        throw new Error("Unsupported MySo knowledge graph manifest");
    }
    const nodes = value.nodes as unknown[]; const edges = value.edges as unknown[];
    const evidence = value.evidence as unknown[]; const provenance = value.provenance as unknown[];
    const nodeMap = new Map<string, MySoGraphNode>(); const edgeMap = new Map<string, MySoGraphEdge>(); const evidenceMap = new Map<string, MySoGraphEvidence>(); const allIds = new Set<string>();
    for (const raw of nodes) {
        if (!record(raw) || !exactKeys(raw, ["id", "kind", "label", "statement", "aliases", "evidenceIds", "state"]) || !string(raw.id, 128) || !idPattern.test(raw.id) || allIds.has(raw.id) || !nodeKinds.has(raw.kind as MySoGraphNodeKind)
            || !string(raw.label, 500) || raw.label.length === 0 || !string(raw.statement) || !strings(raw.aliases, 100)
            || !strings(raw.evidenceIds, 500) || !uniqueIds(raw.evidenceIds as string[]) || !states.has(raw.state as MySoGraphEvidenceState)) throw new Error("Invalid MySo knowledge graph node");
        nodeMap.set(raw.id, raw as unknown as MySoGraphNode); allIds.add(raw.id);
    }
    for (const raw of edges) {
        if (!record(raw) || !exactKeys(raw, ["id", "kind", "sourceId", "targetId", "evidenceIds", "state"]) || !string(raw.id, 128) || !idPattern.test(raw.id) || allIds.has(raw.id)
            || !edgeKinds.has(raw.kind as MySoGraphEdgeKind) || !string(raw.sourceId, 128) || !string(raw.targetId, 128)
            || !strings(raw.evidenceIds, 500) || !uniqueIds(raw.evidenceIds as string[]) || !states.has(raw.state as MySoGraphEvidenceState)) throw new Error("Invalid MySo knowledge graph edge");
        edgeMap.set(raw.id, raw as unknown as MySoGraphEdge); allIds.add(raw.id);
    }
    for (const raw of evidence) {
        if (!record(raw) || !exactKeys(raw, ["id", "kind", "sourceId", "sourceVersion", "digestHex", "receiptId", "artifactId", "visibility", "derivationEvidenceIds", "state", "recordedAt"]) || !string(raw.id, 128) || !idPattern.test(raw.id) || allIds.has(raw.id)
            || !evidenceKinds.has(raw.kind as MySoGraphEvidenceKind) || !string(raw.sourceId, 2048) || raw.sourceId.length === 0
            || !string(raw.sourceVersion, 256) || raw.sourceVersion.length === 0
            || (raw.digestHex !== undefined && (typeof raw.digestHex !== "string" || !/^[0-9a-f]{64}$/.test(raw.digestHex)))
            || (raw.receiptId !== undefined && !string(raw.receiptId, 256)) || (raw.artifactId !== undefined && !string(raw.artifactId, 256))
            || !["private", "organization", "room"].includes(String(raw.visibility)) || !strings(raw.derivationEvidenceIds, 500) || !uniqueIds(raw.derivationEvidenceIds as string[])
            || !states.has(raw.state as MySoGraphEvidenceState) || !string(raw.recordedAt, 64) || !Number.isFinite(Date.parse(raw.recordedAt))) throw new Error("Invalid MySo knowledge graph evidence");
        evidenceMap.set(raw.id, raw as unknown as MySoGraphEvidence); allIds.add(raw.id);
    }
    for (const edge of edgeMap.values()) if (!nodeMap.has(edge.sourceId) || !nodeMap.has(edge.targetId)) throw new Error("MySo graph edge references a missing node");
    for (const node of nodeMap.values()) for (const evidenceId of node.evidenceIds) if (!evidenceMap.has(evidenceId)) throw new Error("MySo graph node references missing evidence");
    for (const edge of edgeMap.values()) for (const evidenceId of edge.evidenceIds) if (!evidenceMap.has(evidenceId)) throw new Error("MySo graph edge references missing evidence");
    for (const item of evidenceMap.values()) for (const parent of item.derivationEvidenceIds) if (!evidenceMap.has(parent)) throw new Error("MySo graph evidence references missing derivation evidence");
    const provenanceIds = new Set<string>();
    for (const raw of provenance) {
        if (!record(raw) || !exactKeys(raw, ["id", "subjectType", "subjectId", "evidenceId", "actor", "recordedAt", "state"]) || !string(raw.id, 128) || !idPattern.test(raw.id) || allIds.has(raw.id) || provenanceIds.has(raw.id)
            || !["node", "edge"].includes(String(raw.subjectType)) || !string(raw.subjectId, 128)
            || (raw.subjectType === "node" ? !nodeMap.has(String(raw.subjectId)) : !edgeMap.has(String(raw.subjectId)))
            || !string(raw.evidenceId, 128) || !evidenceMap.has(String(raw.evidenceId))
            || !["owner", "agent", "system"].includes(String(raw.actor)) || !string(raw.recordedAt, 64)
            || !Number.isFinite(Date.parse(raw.recordedAt)) || !states.has(raw.state as MySoGraphEvidenceState)) throw new Error("Invalid MySo graph provenance record");
        provenanceIds.add(raw.id); allIds.add(raw.id);
    }
    return value as unknown as MySoKnowledgeGraph;
}

async function readMyDataGraph(
    readPage: (request: MyDataContentRequest) => Promise<MyDataContentPage>,
    request: { mydataId: string; encryptedDataDigestHex: string; organizationAudienceId?: string },
    beforeEachPage?: () => Promise<void>,
    verifyGraphAuthority?: GraphAuthorityVerifier,
): Promise<{ graph: MySoKnowledgeGraph; access: MyDataContentPage["access"]; verifiedPublication?: MySoGraphPublication }> {
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(request.mydataId) || !/^[0-9a-f]{64}$/.test(request.encryptedDataDigestHex)) throw new Error("Invalid private graph identity");
    const chunks: string[] = []; let offset = 0; let total: number | undefined; let version: string | undefined; let access: MyDataContentPage["access"] | undefined;
    let accessFingerprint: string | undefined;
    for (let pageNumber = 0; pageNumber < 34; pageNumber++) {
        await beforeEachPage?.();
        const page = await readPage({ mydataId: request.mydataId, encryptedDataDigestHex: request.encryptedDataDigestHex, format: "utf8", offset, limit: 8000, organizationAudienceId: request.organizationAudienceId });
        const scalarCount = Array.from(page.data).length;
        if (page.format !== "utf8" || page.offsetUnit !== "unicode_scalar" || page.offset !== offset || scalarCount > 8000
            || page.nextOffset !== (page.hasNext ? offset + scalarCount : null) || offset + scalarCount > page.total
            || page.mydataId.toLowerCase() !== request.mydataId.toLowerCase() || page.encryptedDataDigestHex !== request.encryptedDataDigestHex
            || (total !== undefined && total !== page.total) || (version !== undefined && version !== page.objectVersion)
            || (accessFingerprint !== undefined && accessFingerprint !== JSON.stringify(page.access))
            || page.total > 262144 || page.total === 0) throw new Error("Private graph pages are inconsistent or exceed the read limit");
        total = page.total; version = page.objectVersion; access = page.access; accessFingerprint = JSON.stringify(page.access); chunks.push(page.data); offset += scalarCount;
        if (!page.hasNext) break;
        if (page.nextOffset === null || page.nextOffset <= offset - scalarCount || pageNumber === 33) throw new Error("Private graph page cursor did not advance");
        offset = page.nextOffset;
    }
    if (total === undefined || offset !== total || !access) throw new Error("Private graph document is incomplete");
    if (!access.purchaseQuote) throw new Error("Private graph reads require the exact current MyData purchase quote");
    const serialized = chunks.join("");
    if (new TextEncoder().encode(serialized).byteLength > 1_048_576) throw new Error("Private graph exceeds the parsing limit");
    let parsed: unknown; try { parsed = JSON.parse(serialized); } catch { throw new Error("Private MyData content is not a JSON graph manifest"); }
    if (record(parsed) && Object.keys(parsed).sort().join(",") === "manifest,publication") {
        if (access.purchaseQuote.mediaType !== "application/vnd.mysocial.graph-manifest+json;version=1") throw new Error("GraphManifest content does not match the quoted MyData media type");
        if (!verifyGraphAuthority || !access.purchaseQuote) throw new Error("A GraphManifest requires live seller-authority verification and a quote from the current MyData listing");
        const { canonicalGraphJson, decodeMySoGraphPublicationTags, verifyMySoGraphPublication } = await import("./graph-manifest.js");
        const listedPublication = decodeMySoGraphPublicationTags(access.purchaseQuote.tags, access.purchaseQuote.expectedSeller);
        const verified = await verifyMySoGraphPublication(parsed, access.purchaseQuote.expectedSeller, {
            accessKind: access.purchaseQuote.accessKind, priceMist: access.purchaseQuote.priceMist,
            durationDays: access.purchaseQuote.durationDays,
        }, verifyGraphAuthority);
        if (canonicalGraphJson(listedPublication) !== canonicalGraphJson(verified.publication)) throw new Error("The encrypted GraphManifest publication differs from the seller proof pinned in public listing tags");
        return { graph: parseMySoKnowledgeGraph({
            schemaVersion: "myso.knowledge-graph.v1", graphId: verified.manifest.graphId,
            graphVersion: verified.manifest.graphVersion, title: verified.manifest.title,
            nodes: verified.manifest.entities, edges: verified.manifest.relations,
            evidence: verified.manifest.evidenceRefs, provenance: verified.manifest.provenance,
        }), access, verifiedPublication: verified.publication };
    }
    if (access.purchaseQuote.mediaType !== "application/vnd.mysocial.knowledge-graph+json;version=1") throw new Error("Legacy graph content does not match the quoted MyData media type");
    return { graph: parseMySoKnowledgeGraph(parsed), access };
}

/** Reads fresh authorized pages, validates one bounded graph manifest, and returns only matches. */
export async function searchMyDataGraph(
    readPage: (request: MyDataContentRequest) => Promise<MyDataContentPage>,
    request: MyDataGraphSearchRequest,
    beforeEachPage?: () => Promise<void>,
    verifyGraphAuthority?: GraphAuthorityVerifier,
): Promise<MyDataGraphSearchResult> {
    if (typeof request.query !== "string" || request.query.trim().length < 1 || request.query.length > 200
        || (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 20))
        || (request.kinds !== undefined && (!Array.isArray(request.kinds) || request.kinds.some((kind) => !nodeKinds.has(kind))))) throw new Error("Invalid private graph search request");
    const { graph, access, verifiedPublication } = await readMyDataGraph(readPage, request, beforeEachPage, verifyGraphAuthority);
    const query = request.query.trim(); const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
    const limit = request.limit ?? 10; const wantedKinds = request.kinds ? new Set(request.kinds) : undefined;
    const matches = graph.nodes.filter((node) => (!wantedKinds || wantedKinds.has(node.kind))
        && terms.every((term) => `${node.label} ${node.statement} ${node.aliases.join(" ")}`.toLocaleLowerCase().includes(term))).slice(0, limit);
    const nodeIds = new Set(matches.map((node) => node.id));
    const edges = graph.edges.filter((edge) => nodeIds.has(edge.sourceId) || nodeIds.has(edge.targetId));
    const evidenceById = new Map(graph.evidence.map((item) => [item.id, item]));
    const resultMatches = matches.map((node) => {
        const nodeEdges = edges.filter((edge) => edge.sourceId === node.id || edge.targetId === node.id);
        const evidenceIds = new Set([...node.evidenceIds, ...nodeEdges.flatMap((edge) => edge.evidenceIds)]);
        const pending = [...evidenceIds];
        while (pending.length) {
            const evidenceItem = evidenceById.get(pending.pop()!);
            for (const parent of evidenceItem?.derivationEvidenceIds ?? []) if (!evidenceIds.has(parent)) { evidenceIds.add(parent); pending.push(parent); }
        }
        const subjectIds = new Set([`node:${node.id}`, ...nodeEdges.map((edge) => `edge:${edge.id}`)]);
        return { node, edges: nodeEdges, evidence: graph.evidence.filter((item) => evidenceIds.has(item.id)), provenance: graph.provenance.filter((item) => subjectIds.has(`${item.subjectType}:${item.subjectId}`) || evidenceIds.has(item.evidenceId)) };
    });
    const result: MyDataGraphSearchResult = { mydataId: request.mydataId, encryptedDataDigestHex: request.encryptedDataDigestHex, graphId: graph.graphId, graphVersion: graph.graphVersion, query, matches: resultMatches, access, ...(verifiedPublication ? { verifiedPublication } : {}), evidenceNotice: "Graph assertions are private content; verified state is a label and does not replace independent receipt verification." };
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 750_000) throw new Error("Private graph search result exceeds the disclosure limit");
    return result;
}

/** Reads one typed graph item and a bounded neighborhood, rechecking caller access on every page. */
export async function getMyDataGraphItem(
    readPage: (request: MyDataContentRequest) => Promise<MyDataContentPage>,
    request: MyDataGraphItemRequest,
    beforeEachPage?: () => Promise<void>,
    verifyGraphAuthority?: GraphAuthorityVerifier,
): Promise<MyDataGraphItemResult> {
    if (!("node edge evidence".split(" ").includes(request.kind)) || typeof request.id !== "string" || !idPattern.test(request.id)) throw new Error("Invalid private graph item request");
    const { graph, access, verifiedPublication } = await readMyDataGraph(readPage, request, beforeEachPage, verifyGraphAuthority);
    const item = request.kind === "node" ? graph.nodes.find((value) => value.id === request.id)
        : request.kind === "edge" ? graph.edges.find((value) => value.id === request.id)
            : graph.evidence.find((value) => value.id === request.id);
    if (!item) throw new Error("Private graph item was not found");
    const selectedNodes = new Set<string>(); const selectedEdges = new Set<string>(); const selectedEvidence = new Set<string>();
    if (request.kind === "node") {
        const node = item as MySoGraphNode; selectedNodes.add(node.id); node.evidenceIds.forEach((id) => selectedEvidence.add(id));
        for (const edge of graph.edges) if (edge.sourceId === node.id || edge.targetId === node.id) { selectedEdges.add(edge.id); selectedNodes.add(edge.sourceId); selectedNodes.add(edge.targetId); edge.evidenceIds.forEach((id) => selectedEvidence.add(id)); }
    } else if (request.kind === "edge") {
        const edge = item as MySoGraphEdge; selectedEdges.add(edge.id); selectedNodes.add(edge.sourceId); selectedNodes.add(edge.targetId); edge.evidenceIds.forEach((id) => selectedEvidence.add(id));
    } else selectedEvidence.add(item.id);
    const evidenceById = new Map(graph.evidence.map((value) => [value.id, value])); const pending = [...selectedEvidence];
    while (pending.length) for (const parent of evidenceById.get(pending.pop()!)?.derivationEvidenceIds ?? []) if (!selectedEvidence.has(parent)) { selectedEvidence.add(parent); pending.push(parent); }
    if (request.kind === "evidence") {
        for (const node of graph.nodes) if (node.evidenceIds.some((id) => selectedEvidence.has(id))) selectedNodes.add(node.id);
        for (const edge of graph.edges) if (edge.evidenceIds.some((id) => selectedEvidence.has(id))) { selectedEdges.add(edge.id); selectedNodes.add(edge.sourceId); selectedNodes.add(edge.targetId); }
    }
    if (selectedNodes.size > 100 || selectedEdges.size > 200 || selectedEvidence.size > 500) throw new Error("Private graph item neighborhood exceeds the disclosure limit");
    const subjectIds = new Set([...Array.from(selectedNodes, (id) => `node:${id}`), ...Array.from(selectedEdges, (id) => `edge:${id}`)]);
    const result: MyDataGraphItemResult = {
        mydataId: request.mydataId, encryptedDataDigestHex: request.encryptedDataDigestHex, graphId: graph.graphId, graphVersion: graph.graphVersion,
        kind: request.kind, item, nodes: graph.nodes.filter((value) => selectedNodes.has(value.id)), edges: graph.edges.filter((value) => selectedEdges.has(value.id)),
        evidence: graph.evidence.filter((value) => selectedEvidence.has(value.id)),
        provenance: graph.provenance.filter((value) => subjectIds.has(`${value.subjectType}:${value.subjectId}`) || selectedEvidence.has(value.evidenceId)),
        access, ...(verifiedPublication ? { verifiedPublication } : {}), evidenceNotice: "Graph assertions are private content; verified state is a label and does not replace independent receipt verification.",
    };
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 750_000) throw new Error("Private graph item result exceeds the disclosure limit");
    return result;
}
