/**
 * The runner's HTTP surface.
 *
 *   GET  /health                     liveness, public
 *   POST /webhook/engine             the automation engine's signed webhook; replies with a directive
 *   GET  /rationales/:digest         a juror's rationale, only after its reveal was issued
 *
 * `node:http` only. The webhook is authenticated by its HMAC alone: there is no shared-header
 * fallback, so a request that is not signed by the engine cannot start a judgment or cost
 * inference.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { DirectiveEngine, type EngineRequest } from "./directives.js";
import type { Metrics } from "./metrics.js";
import { checkSignature } from "./signature.js";
import type { JudgmentStore } from "./store.js";
import { buildBundle, type BundleDeps } from "./bundle.js";

export interface ServerDeps {
    webhookSecret: string;
    engine: DirectiveEngine;
    store: JudgmentStore;
    maxBodyBytes: number;
    /** Counters for `/metrics`. */
    metrics?: Metrics;
    /** Bearer token that unlocks `/metrics`. Without one the route does not exist. */
    metricsToken?: string;
    /** Shared only with the authenticated MySo Agents server; enables verified bundle reads. */
    bundleReadToken?: string;
    bundle?: BundleDeps;
    now?: () => number;
    log?: (message: string, detail?: unknown) => void;
}

function send(res: ServerResponse, status: number, body: unknown, contentType = "application/json; charset=utf-8"): void {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, { "content-type": contentType, "content-length": Buffer.byteLength(payload) });
    res.end(payload);
}

class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        const buffer = chunk as Buffer;
        size += buffer.length;
        if (size > maxBytes) throw new BodyTooLarge();
        chunks.push(buffer);
    }
    return Buffer.concat(chunks);
}

function header(req: IncomingMessage, name: string): string | undefined {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
}

function parseRequest(raw: Buffer): EngineRequest | null {
    try {
        const parsed = JSON.parse(raw.toString("utf8")) as Partial<EngineRequest>;
        if (typeof parsed.delivery_id !== "string" || !parsed.delivery_id) return null;
        if (!parsed.event || typeof parsed.event !== "object" || typeof parsed.event.event_type !== "string") return null;
        return parsed as EngineRequest;
    } catch {
        return null;
    }
}

export function createJurorServer(deps: ServerDeps): Server {
    const now = deps.now ?? Date.now;
    return createServer((req, res) => {
        void route(req, res).catch((error: unknown) => {
            deps.log?.("request failed", String(error));
            if (!res.headersSent) send(res, 500, { error: "internal_error" });
        });
    });

    async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? "/", "http://runner");
        if (req.method === "GET" && url.pathname === "/health") {
            return send(res, 200, { status: "ok", service: "jury-runner" });
        }
        if (req.method === "GET" && url.pathname === "/metrics" && deps.metrics && deps.metricsToken) {
            if (header(req, "authorization") !== `Bearer ${deps.metricsToken}`) {
                return send(res, 401, { error: "unauthorized" });
            }
            return send(res, 200, deps.metrics.render(), "text/plain; version=0.0.4; charset=utf-8");
        }
        if (req.method === "GET" && url.pathname === "/case-bundle" && deps.bundle && deps.bundleReadToken) {
            if (header(req, "authorization") !== `Bearer ${deps.bundleReadToken}`) {
                return send(res, 401, { error: "unauthorized" });
            }
            const caseId = url.searchParams.get("caseId") ?? "";
            const round = Number(url.searchParams.get("round"));
            if (!/^0x[0-9a-fA-F]{1,64}$/.test(caseId) || !Number.isSafeInteger(round) || round < 0) {
                return send(res, 400, { error: "invalid_request" });
            }
            try {
                const result = await buildBundle(deps.bundle, caseId, round);
                return send(res, 200, { bundle: result.bundle, digestHex: result.digestHex });
            } catch (error) {
                deps.log?.("case bundle unavailable", String(error));
                return send(res, 404, { error: "bundle_unavailable" });
            }
        }
        if (req.method === "GET" && url.pathname.startsWith("/rationales/")) {
            const digest = url.pathname.slice("/rationales/".length).toLowerCase();
            const rationale = /^[0-9a-f]{64}$/.test(digest) ? deps.store.getRevealedRationale(digest) : undefined;
            if (rationale === undefined) return send(res, 404, { error: "not_found" });
            return send(res, 200, rationale, "text/plain; charset=utf-8");
        }
        if (req.method === "POST" && url.pathname === "/webhook/engine") {
            let raw: Buffer;
            try {
                raw = await readBody(req, deps.maxBodyBytes);
            } catch (error) {
                if (error instanceof BodyTooLarge) {
                    deps.metrics?.inc("jury_runner_webhooks_rejected_total");
                    return send(res, 413, { error: "payload_too_large" });
                }
                throw error;
            }
            const failure = checkSignature(
                deps.webhookSecret,
                header(req, "x-myso-timestamp"),
                header(req, "x-myso-signature"),
                raw,
                now(),
            );
            if (failure) {
                deps.metrics?.inc("jury_runner_webhooks_rejected_total");
                return send(res, 401, { error: "unauthorized", reason: failure });
            }
            const request = parseRequest(raw);
            if (!request) {
                deps.metrics?.inc("jury_runner_webhooks_rejected_total");
                return send(res, 400, { error: "invalid_request" });
            }
            const directive = await deps.engine.handle(request);
            if ("action_id" in directive) deps.metrics?.inc("jury_runner_directives_total", { action: directive.action_id });
            return send(res, 200, directive);
        }
        return send(res, 404, { error: "not_found" });
    }
}
