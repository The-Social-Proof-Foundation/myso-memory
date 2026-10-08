/**
 * Automation memory bridge — HTTP surface.
 *
 * A plain `node:http` server rather than Express, so the bridge has no runtime
 * dependencies beyond the memory SDK and cannot drift from the repo's lockfile
 * for an unrelated reason.
 *
 * Routes:
 *   GET  /health                    → liveness + registered agent count (public, no ref names)
 *   GET  /mydata-keys                 → public halves of the delegate MyData keys (public)
 *   POST /internal/memory/recall    → semantic recall as a resolved agent
 *   POST /internal/memory/remember  → store a memory as a resolved agent
 *   POST /internal/memory/probe     → memory relayer reachability for an agent
 *
 * Every `/internal/*` route requires `x-internal-sync-secret`, the same header
 * the automation engine and the messaging relayer already use.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { BridgeError, MemoryBridge, type MemoryBridgeOptions } from "./bridge.js";
import { loadConfig, type SidecarConfig } from "./config.js";
import { EngineDelegateSource } from "./delegates.js";
import { AgentKeyStore, KeyStoreError } from "./keys.js";
import { MyDataKeyRing } from "./delegate-crypto.js";
import { DelegateVerifier } from "./verify.js";

const SERVICE_NAME = "automation-memory-bridge";

/**
 * Length-safe constant-time comparison.
 *
 * Hashing first means the comparison time does not depend on the secret's
 * length, which a naive `a.length !== b.length` guard would leak.
 */
function secretMatches(provided: string, expected: string): boolean {
    if (!expected) return false;
    const a = createHash("sha256").update(provided).digest();
    const b = createHash("sha256").update(expected).digest();
    return timingSafeEqual(a, b);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        const buf = chunk as Buffer;
        size += buf.length;
        if (size > maxBytes) {
            throw new BridgeError(
                `request body exceeds ${maxBytes} bytes`,
                413,
                "payload_too_large",
            );
        }
        chunks.push(buf);
    }
    if (size === 0) return {};
    const raw = Buffer.concat(chunks).toString("utf8");
    try {
        return JSON.parse(raw);
    } catch (err) {
        throw new BridgeError(`invalid JSON body: ${(err as Error).message}`, 400, "invalid_json");
    }
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new BridgeError(`${field} must be a JSON object`, 400, "invalid_request");
    }
    return value as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, field: string): string {
    const value = body[field];
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new BridgeError(`${field} is required and must be a non-empty string`, 400, "invalid_request");
    }
    return value;
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
    const value = body[field];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new BridgeError(`${field} must be a non-empty string when provided`, 400, "invalid_request");
    }
    return value;
}

function optionalPositiveInt(body: Record<string, unknown>, field: string): number | undefined {
    const value = body[field];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        throw new BridgeError(`${field} must be a positive integer when provided`, 400, "invalid_request");
    }
    return value;
}

export interface BridgeServerDeps {
    config: SidecarConfig;
    bridge: Pick<MemoryBridge, "recall" | "remember" | "probe">;
    /** Static dev keys, absent in production. Used by /health for a count. */
    store?: Pick<AgentKeyStore, "size">;
    /** Public MyData keys for browsers to encrypt delegate seeds to. Never private halves. */
    myDataPublicKeys?: () => Array<{ id: string; publicKey: string }>;
}

export function createBridgeServer(deps: BridgeServerDeps): Server {
    const { config, bridge, store, myDataPublicKeys } = deps;

    return createServer((req, res) => {
        void handle(req, res).catch((err: unknown) => {
            if (res.headersSent) {
                res.end();
                return;
            }
            sendJson(res, 500, { error: "internal bridge error", code: "internal" });
            console.error(`[${SERVICE_NAME}] unhandled:`, err instanceof Error ? err.message : err);
        });
    });

    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const path = url.pathname.replace(/\/+$/, "") || "/";
        const method = req.method ?? "GET";

        if (path === "/health" && method === "GET") {
            // /health is unauthenticated, so it reports a count only. Ref names
            // are tenant-identifying (see MemoryBridge.resolve) and stay behind
            // the shared secret.
            sendJson(res, 200, {
                status: "ok",
                service: SERVICE_NAME,
                agents: store?.size() ?? 0,
                delegates: myDataPublicKeys !== undefined,
            });
            return;
        }

        if (path === "/mydata-keys" && method === "GET") {
            // Public by design: these are the keys a browser encrypts a delegate seed
            // *to*. They cannot open anything.
            sendJson(res, 200, { keys: myDataPublicKeys?.() ?? [] });
            return;
        }

        if (!path.startsWith("/internal/")) {
            sendJson(res, 404, { error: "not found", code: "not_found" });
            return;
        }

        if (method !== "POST") {
            sendJson(res, 405, { error: "method not allowed", code: "method_not_allowed" });
            return;
        }

        const provided = req.headers["x-internal-sync-secret"];
        if (typeof provided !== "string" || !secretMatches(provided, config.internalSyncSecret)) {
            sendJson(res, 401, { error: "unauthorized", code: "unauthorized" });
            return;
        }

        let body: Record<string, unknown>;
        try {
            body = asRecord(await readJsonBody(req, config.maxBodyBytes), "body");
        } catch (err) {
            sendBridgeError(res, err);
            return;
        }

        try {
            switch (path) {
                case "/internal/memory/recall": {
                    const result = await bridge.recall({
                        key_ref: requireString(body, "key_ref"),
                        account_id: requireString(body, "account_id"),
                        query: requireString(body, "query"),
                        limit: optionalPositiveInt(body, "limit"),
                        namespace: optionalString(body, "namespace"),
                    });
                    sendJson(res, 200, result);
                    return;
                }
                case "/internal/memory/remember": {
                    const result = await bridge.remember({
                        key_ref: requireString(body, "key_ref"),
                        account_id: requireString(body, "account_id"),
                        text: requireString(body, "text"),
                        wait: body.wait === undefined ? undefined : body.wait === true,
                        namespace: optionalString(body, "namespace"),
                    });
                    sendJson(res, 200, result);
                    return;
                }
                case "/internal/memory/probe": {
                    const result = await bridge.probe({
                        key_ref: requireString(body, "key_ref"),
                        account_id: requireString(body, "account_id"),
                    });
                    sendJson(res, 200, result);
                    return;
                }
                default:
                    sendJson(res, 404, { error: "not found", code: "not_found" });
                    return;
            }
        } catch (err) {
            sendBridgeError(res, err);
        }
    }
}

function sendBridgeError(res: ServerResponse, err: unknown): void {
    if (err instanceof BridgeError) {
        sendJson(res, err.status, { error: err.message, code: err.code });
        return;
    }
    if (err instanceof KeyStoreError) {
        // Misconfiguration is the caller's to fix, not an outage.
        const status = err.code === "unknown_ref" ? 404 : 500;
        sendJson(res, status, { error: err.message, code: `key_store:${err.code}` });
        return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVICE_NAME}] error:`, message);
    sendJson(res, 500, { error: message, code: "internal" });
}

async function main(): Promise<void> {
    const config = loadConfig();

    // Static keys exist only outside production (loadConfig refuses them there).
    let store: AgentKeyStore | undefined;
    if (config.allowStaticKeys) {
        store = new AgentKeyStore({
            file: config.agentKeysFile,
            inlineJson: config.agentKeysJson,
            defaultServerUrl: config.defaultServerUrl,
            defaultNamespace: config.defaultNamespace,
        });
        // Fail at boot on a broken key source rather than on the first job.
        store.reload();
    }

    // Encrypted delegate keys: ciphertext in the engine's database, opened here.
    const keyring = config.myDataPrivateKeys ? MyDataKeyRing.parse(config.myDataPrivateKeys) : undefined;
    const delegates =
        keyring && config.engineUrl
            ? new EngineDelegateSource({
                  engineUrl: config.engineUrl,
                  secret: config.internalSyncSecret,
                  keyring,
              })
            : undefined;

    const bridgeOptions: MemoryBridgeOptions = {
        store,
        delegates,
        verifier: delegates ? new DelegateVerifier({ timeoutMs: config.requestTimeoutMs }) : undefined,
        delegateDefaults: { serverUrl: config.defaultServerUrl, namespace: config.defaultNamespace },
        requestTimeoutMs: config.requestTimeoutMs,
        eventsUrl: config.eventsUrl,
        eventsSecret: config.eventsSecret ?? config.internalSyncSecret,
    };
    const bridge = new MemoryBridge(bridgeOptions);

    const server = createBridgeServer({
        config,
        bridge,
        store,
        myDataPublicKeys: keyring ? () => keyring.publicKeys() : undefined,
    });

    await new Promise<void>((resolve) => {
        server.listen(config.port, config.host, () => {
            console.log(
                `[${SERVICE_NAME}] listening on http://${config.host}:${config.port} ` +
                    `| keys=${store ? (store.isInline ? "static inline (dev)" : "static file (dev)") : "encrypted delegates"} ` +
                    `| agents=${store?.size() ?? 0} ` +
                    `| namespace=${config.defaultNamespace} ` +
                    `| memory=${config.defaultServerUrl ?? "(per-key)"}`,
            );
            if (config.host === "127.0.0.1" || config.host === "localhost") {
                // The common container misconfiguration: the process starts, the
                // log looks healthy, and every platform healthcheck fails because
                // nothing outside the container can reach loopback.
                console.warn(
                    `[${SERVICE_NAME}] HOST is ${config.host} — unreachable from outside this ` +
                        "machine or container. Set HOST=0.0.0.0 when deploying.",
                );
            }
            resolve();
        });
    });

    const shutdown = (signal: string) => {
        console.log(`[${SERVICE_NAME}] ${signal} received — shutting down`);
        bridge.dispose();
        server.close(() => process.exit(0));
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Only start when executed directly, so tests can import createBridgeServer.
const invokedDirectly =
    process.argv[1] !== undefined &&
    import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
    main().catch((err: unknown) => {
        console.error(`[${SERVICE_NAME}] failed to start:`, err instanceof Error ? err.message : err);
        process.exit(1);
    });
}
