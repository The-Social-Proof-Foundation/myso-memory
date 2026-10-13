/**
 * Keeps a juror's reasons where the case is read. A vote's rationale is committed on chain only as
 * a digest, and until now the runner was the one place the text lived: if the runner went away, the
 * reason behind a ruling went with it. After a seat reveals, the runner hands the text to the social
 * server, which stores it only if it hashes to the digest the chain recorded for that seat.
 *
 * The answer decides what happens next: `stored` and `already_stored` are done, `mismatch` is final
 * (this is not that vote's text), and `not_revealed` means the reveal has not reached the indexer
 * yet, so the same rationale is offered again on the next pass, for up to a week.
 */

import type { Judgment, JudgmentStore } from "./store.js";

export interface RationalePublisherDeps {
    store: JudgmentStore;
    socialServerUrl: string;
    /** The social server's `x-internal-sync-secret`. */
    secret: string;
    fetch: typeof fetch;
    now: () => number;
    log: (message: string, detail?: unknown) => void;
}

export interface PublishResult {
    stored: number;
    waiting: number;
    refused: number;
    failed: number;
}

/** A reveal that never shows up on the indexer in this long is given up on. */
export const PUBLISH_GIVE_UP_MS = 7 * 24 * 60 * 60 * 1000;

export class RationalePublisher {
    constructor(private readonly deps: RationalePublisherDeps) {}

    async tick(): Promise<PublishResult> {
        const result: PublishResult = { stored: 0, waiting: 0, refused: 0, failed: 0 };
        for (const judgment of this.deps.store.listUnpublished()) {
            const outcome = await this.publish(judgment);
            if (outcome === "stored") result.stored += 1;
            else if (outcome === "waiting") result.waiting += 1;
            else if (outcome === "refused") result.refused += 1;
            else result.failed += 1;
        }
        return result;
    }

    private async publish(judgment: Judgment): Promise<"stored" | "waiting" | "refused" | "failed"> {
        const { store, now, log } = this.deps;
        const at = now();
        let response: Response;
        try {
            response = await this.deps.fetch(`${this.deps.socialServerUrl}/internal/jury/rationales`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-internal-sync-secret": this.deps.secret },
                body: JSON.stringify({
                    caseId: judgment.caseId,
                    round: judgment.round,
                    agentId: judgment.agentId,
                    rationale: judgment.rationale,
                }),
            });
        } catch (error) {
            log("could not publish a rationale; will retry", { caseId: judgment.caseId, error: String(error) });
            return "failed";
        }
        if (!response.ok) {
            log("the social server refused a rationale request", { caseId: judgment.caseId, status: response.status });
            // A client error will not get better by repeating it; a server error might.
            if (response.status >= 400 && response.status < 500) {
                store.markPublished(judgment.caseId, judgment.round, judgment.agentId, at, `server answered ${response.status}`);
                return "refused";
            }
            return "failed";
        }
        const body = (await response.json().catch(() => null)) as { status?: string } | null;
        switch (body?.status) {
            case "stored":
            case "already_stored":
                store.markPublished(judgment.caseId, judgment.round, judgment.agentId, at);
                return "stored";
            case "not_revealed": {
                const waitedMs = at - (judgment.revealIssuedAtMs ?? at);
                if (waitedMs > PUBLISH_GIVE_UP_MS) {
                    store.markPublished(judgment.caseId, judgment.round, judgment.agentId, at, "the reveal never reached the indexer");
                    return "refused";
                }
                return "waiting";
            }
            case "mismatch":
                store.markPublished(judgment.caseId, judgment.round, judgment.agentId, at, "does not match the revealed digest");
                return "refused";
            default:
                return "failed";
        }
    }
}
