/**
 * The case file a juror judges: what the chain says the dispute or proposal is, the menu of
 * outcomes, and every piece of evidence with a verdict on whether its bytes match the digest the
 * chain recorded. The bundle is canonical JSON, and its sha256 goes into the vote's commitment, so
 * the vote is bound to exactly the material the juror was shown.
 */

import { createHash } from "node:crypto";

import { sha256Hex } from "./commitment.js";
import type { EvidenceResult } from "./safe-fetch.js";

export const SUBJECT_TASK = 1;
export const SUBJECT_GOVERNANCE = 2;
export const ABSTAIN = 255;
const MAX_EXCERPT_CHARS = 4_000;

export interface SocialReader {
    getCase(caseId: string): Promise<Record<string, unknown> | null>;
    getTask(taskId: string): Promise<Record<string, unknown> | null>;
    getProposal(proposalId: string): Promise<Record<string, unknown> | null>;
}

export class HttpSocialReader implements SocialReader {
    constructor(
        private readonly baseUrl: string,
        private readonly fetchImpl: typeof fetch = fetch,
        private readonly timeoutMs = 10_000,
    ) {}

    private async get(path: string): Promise<Record<string, unknown> | null> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
                headers: { accept: "application/json" },
                signal: controller.signal,
            });
            if (response.status === 404) return null;
            if (!response.ok) throw new Error(`social server answered ${response.status} for ${path}`);
            return (await response.json()) as Record<string, unknown>;
        } finally {
            clearTimeout(timer);
        }
    }

    getCase = (id: string) => this.get(`/jury/cases/${encodeURIComponent(id)}`);
    getTask = (id: string) => this.get(`/tasks/${encodeURIComponent(id)}`);
    getProposal = (id: string) => this.get(`/governance/proposals/${encodeURIComponent(id)}`);
}

export type EvidenceStatus = "verified" | "mismatch" | "unavailable";

export interface BundleEvidence {
    index: number;
    kind: number;
    submitter: string;
    round: number;
    uri: string;
    digest: string;
    status: EvidenceStatus;
    /** Text of verified evidence only, cut to a bounded length. */
    excerpt?: string;
}

export interface MenuOption {
    index: number;
    label: string;
}

export interface CaseBundle {
    version: 1;
    caseId: string;
    round: number;
    subjectKind: number;
    stage: number;
    menu: MenuOption[];
    subject: Record<string, unknown>;
    verifiedFacts: Record<string, unknown>;
    evidence: BundleEvidence[];
}

export class BundleError extends Error {}

/** Key-sorted JSON, so the same bundle always hashes the same. */
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
}

export function menuFor(subjectKind: number, stage: number): MenuOption[] {
    if (subjectKind === SUBJECT_TASK) {
        return [
            { index: 0, label: "pay the seller in full" },
            { index: 1, label: "refund the buyer in full" },
            { index: 2, label: "split the escrow 50/50" },
        ];
    }
    if (stage === 2) {
        return [
            { index: 0, label: "approve the proposal" },
            { index: 1, label: "reject the proposal" },
        ];
    }
    return [
        { index: 0, label: "advance the proposal to the community vote" },
        { index: 1, label: "reject the proposal" },
    ];
}

const pick = (record: Record<string, unknown> | null | undefined, keys: readonly string[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const key of keys) if (record && record[key] !== undefined) out[key] = record[key];
    return out;
};

function toExcerpt(bytes: Buffer): string | undefined {
    const text = bytes.toString("utf8");
    const replacements = (text.match(/�/g) ?? []).length;
    if (text.length === 0 || replacements / text.length > 0.05) return undefined;
    // eslint-disable-next-line no-control-regex
    return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").slice(0, MAX_EXCERPT_CHARS);
}

/** The chain records a sha256 or a sha3-256 digest depending on who attached the evidence. */
export function digestMatches(bytes: Buffer, digestHex: string): boolean {
    const wanted = digestHex.toLowerCase().replace(/^0x/, "");
    return sha256Hex(bytes) === wanted || createHash("sha3-256").update(bytes).digest("hex") === wanted;
}

export interface BundleDeps {
    social: SocialReader;
    fetchEvidence: (uri: string) => Promise<EvidenceResult>;
}

export async function buildBundle(
    deps: BundleDeps,
    caseId: string,
    round: number,
): Promise<{ bundle: CaseBundle; canonical: string; digestHex: string }> {
    const found = await deps.social.getCase(caseId);
    if (!found) throw new BundleError(`case ${caseId} is not indexed yet`);
    const subjectKind = Number(found.subjectKind);
    const stage = Number(found.stage ?? 0);
    const subjectId = String(found.subjectId);

    let subject: Record<string, unknown> = {};
    let verifiedFacts: Record<string, unknown> = {};
    if (subjectKind === SUBJECT_TASK) {
        const task = await deps.social.getTask(subjectId);
        if (!task) throw new BundleError(`task ${subjectId} is not indexed yet`);
        subject = pick(task, [
            "taskId", "title", "amountMist", "status", "scopeDigest", "termsDigest",
            "deliverableDigest", "deliverableUri", "deliveredAtMs", "deliveryDeadlineMs",
            "settleDeadlineMs", "buyerPrincipal", "sellerPrincipal",
        ]);
        const delivered = Number(task.deliveredAtMs);
        const due = Number(task.deliveryDeadlineMs);
        verifiedFacts = {
            amountMist: task.amountMist,
            deliveredOnTime: Number.isFinite(delivered) && Number.isFinite(due) ? delivered <= due : null,
        };
    } else if (subjectKind === SUBJECT_GOVERNANCE) {
        const wrapper = await deps.social.getProposal(subjectId);
        const proposal = (wrapper?.proposal ?? wrapper) as Record<string, unknown> | null;
        if (!proposal) throw new BundleError(`proposal ${subjectId} is not indexed yet`);
        subject = pick(proposal, [
            "object_id", "title", "description", "proposal_type", "status", "submitter",
            "metadata_json", "reference_id",
        ]);
        verifiedFacts = pick(proposal, [
            "community_votes_for", "community_votes_against", "delegate_approval_count",
            "delegate_rejection_count", "voting_end_time",
        ]);
        verifiedFacts.stage = stage;
    } else {
        throw new BundleError(`case ${caseId} has an unknown subject kind ${subjectKind}`);
    }

    const items = (Array.isArray(found.evidence) ? found.evidence : []) as Array<Record<string, unknown>>;
    const evidence: BundleEvidence[] = [];
    for (const item of items) {
        const base = {
            index: Number(item.index),
            kind: Number(item.kind),
            submitter: String(item.submitter),
            round: Number(item.round),
            uri: String(item.uri),
            digest: String(item.digest),
        };
        const result = await deps.fetchEvidence(base.uri);
        if (!result.ok) {
            evidence.push({ ...base, status: "unavailable" });
        } else if (!digestMatches(result.bytes, base.digest)) {
            evidence.push({ ...base, status: "mismatch" });
        } else {
            const excerpt = toExcerpt(result.bytes);
            evidence.push({ ...base, status: "verified", ...(excerpt ? { excerpt } : {}) });
        }
    }

    const bundle: CaseBundle = {
        version: 1,
        caseId,
        round,
        subjectKind,
        stage,
        menu: menuFor(subjectKind, stage),
        subject,
        verifiedFacts,
        evidence: evidence.sort((a, b) => a.index - b.index),
    };
    const canonical = canonicalJson(bundle);
    return { bundle, canonical, digestHex: sha256Hex(canonical) };
}
