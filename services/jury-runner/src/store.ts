/**
 * What the runner must remember across restarts and retries:
 *
 *  - each judgment, secret until its reveal (the salt is derived, but the outcome and rationale
 *    are not, and judging costs real inference);
 *  - the directive it answered for each engine delivery, because the engine retries one delivery
 *    under the same `delivery_id` and the answer must not change.
 *
 * `FileStore` keeps both in one JSON file replaced atomically on every write, which is enough for
 * one runner process on a volume. `MemoryStore` is the same without the file, for tests.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Judgment {
    caseId: string;
    round: number;
    agentId: string;
    outcome: number;
    rationale: string;
    evidenceRefs: number[];
    rationaleDigestHex: string;
    bundleDigestHex: string;
    saltHex: string;
    commitmentHex: string;
    createdAtMs: number;
    /** Set once a reveal directive has been issued: only then may the rationale be public. */
    revealIssuedAtMs?: number;
    /** When the rationale was saved where the case is read (the social server). */
    publishedAtMs?: number;
    /** Why it will not be published, for a rationale the server refused for good. */
    publishError?: string;
    /** What the model calls behind this judgment cost and which provider generations they were. */
    inference?: import("./inference.js").UsageRecord[];
}

export type Directive =
    | { noop: true; reason?: string }
    | { action_id: string; params: Record<string, unknown> };

export interface JudgmentStore {
    getJudgment(caseId: string, round: number, agentId: string): Judgment | undefined;
    putJudgment(judgment: Judgment): void;
    markRevealIssued(caseId: string, round: number, agentId: string, atMs: number): void;
    /** A rationale by digest, but only once its reveal has been issued. */
    getRevealedRationale(rationaleDigestHex: string): string | undefined;
    /** Revealed judgments whose rationale has not been published or refused yet. */
    listUnpublished(): Judgment[];
    markPublished(caseId: string, round: number, agentId: string, atMs: number, error?: string): void;
    getDelivery(deliveryId: string): Directive | undefined;
    putDelivery(deliveryId: string, directive: Directive, atMs: number): void;
}

const MAX_DELIVERIES = 5_000;

interface Snapshot {
    judgments: Record<string, Judgment>;
    deliveries: Record<string, { directive: Directive; atMs: number }>;
}

const key = (caseId: string, round: number, agentId: string) => `${caseId}:${round}:${agentId}`.toLowerCase();

export class MemoryStore implements JudgmentStore {
    protected state: Snapshot = { judgments: {}, deliveries: {} };

    getJudgment(caseId: string, round: number, agentId: string): Judgment | undefined {
        return this.state.judgments[key(caseId, round, agentId)];
    }

    putJudgment(judgment: Judgment): void {
        this.state.judgments[key(judgment.caseId, judgment.round, judgment.agentId)] = judgment;
        this.persist();
    }

    markRevealIssued(caseId: string, round: number, agentId: string, atMs: number): void {
        const found = this.getJudgment(caseId, round, agentId);
        if (found && found.revealIssuedAtMs === undefined) {
            found.revealIssuedAtMs = atMs;
            this.persist();
        }
    }

    getRevealedRationale(rationaleDigestHex: string): string | undefined {
        for (const judgment of Object.values(this.state.judgments)) {
            if (judgment.rationaleDigestHex === rationaleDigestHex && judgment.revealIssuedAtMs !== undefined) {
                return judgment.rationale;
            }
        }
        return undefined;
    }

    listUnpublished(): Judgment[] {
        return Object.values(this.state.judgments).filter(
            (j) => j.revealIssuedAtMs !== undefined && j.publishedAtMs === undefined && j.publishError === undefined,
        );
    }

    markPublished(caseId: string, round: number, agentId: string, atMs: number, error?: string): void {
        const found = this.getJudgment(caseId, round, agentId);
        if (!found) return;
        if (error === undefined) found.publishedAtMs = atMs;
        else found.publishError = error;
        this.persist();
    }

    getDelivery(deliveryId: string): Directive | undefined {
        return this.state.deliveries[deliveryId]?.directive;
    }

    putDelivery(deliveryId: string, directive: Directive, atMs: number): void {
        this.state.deliveries[deliveryId] = { directive, atMs };
        const ids = Object.keys(this.state.deliveries);
        if (ids.length > MAX_DELIVERIES) {
            ids.sort((a, b) => this.state.deliveries[a]!.atMs - this.state.deliveries[b]!.atMs);
            for (const id of ids.slice(0, ids.length - MAX_DELIVERIES)) delete this.state.deliveries[id];
        }
        this.persist();
    }

    protected persist(): void {}
}

export class FileStore extends MemoryStore {
    constructor(private readonly path: string) {
        super();
        try {
            const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Snapshot>;
            this.state = { judgments: parsed.judgments ?? {}, deliveries: parsed.deliveries ?? {} };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw new Error(`cannot read the judgment store at ${path}: ${(error as Error).message}`);
            }
        }
    }

    protected override persist(): void {
        mkdirSync(dirname(this.path), { recursive: true });
        const temporary = `${this.path}.tmp`;
        writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
        renameSync(temporary, this.path);
    }
}
