/**
 * Memory bridge operations.
 *
 * The automation engine (Rust) cannot call the memory relayer directly: every
 * `/api/*` memory route sits behind Ed25519 signed-request auth, and this
 * service is the one place that holds agent keys and signs on the agent's
 * behalf. The engine sends a `key_ref`; the bridge resolves it and talks to the
 * relayer through `@socialproof/memory`, the same client the chat-app uses.
 *
 * Reusing the published SDK rather than re-implementing the signing scheme in
 * Rust is deliberate — one implementation of the request contract means the
 * chat-app and a scheduled job cannot drift apart.
 */

import { createHash } from "node:crypto";

import { Memory } from "@socialproof/memory";

import { BridgeError } from "./bridge-error.js";
import { normalizeObjectId } from "./ids.js";
import { DELEGATE_REF_PREFIX, type DelegateSource } from "./delegates.js";
import type { AgentKeyStore, ResolvedAgentKey } from "./keys.js";
import { NEEDS_RECALL, NEEDS_REMEMBER, type DelegateVerifier } from "./verify.js";

export { BridgeError, normalizeObjectId };

export interface RecallRequest {
    key_ref: string;
    /** MemoryAccount the caller acts for. Must own `key_ref`; see {@link MemoryBridge}. */
    account_id: string;
    query: string;
    limit?: number;
    /** Override the key entry's namespace for this call. */
    namespace?: string;
}

export interface RecallResponse {
    results: Array<{
        text: string;
        distance: number;
        blob_id: string;
        score?: number;
        visibility?: number;
        source_agent_id?: string;
    }>;
    total: number;
    /**
     * True when the relayer returned a full page. The relayer caps recall at
     * `limit` and silently drops the remainder, so a full page means possible
     * truncation rather than an exact answer.
     */
    truncated: boolean;
    degraded_scope?: boolean;
    agent_object_id?: string;
    namespace: string;
}

export interface RememberRequest {
    key_ref: string;
    account_id: string;
    text: string;
    /** Block until the relayer reports `done`. Defaults to true. */
    wait?: boolean;
    namespace?: string;
}

export interface RememberResponse {
    job_id: string;
    status: string;
    blob_id?: string;
    agent_object_id?: string;
    namespace: string;
}

export interface ProbeRequest {
    key_ref: string;
    account_id: string;
}

export interface ProbeResponse {
    status: string;
    version: string;
    namespace: string;
}

export interface MemoryBridgeOptions {
    /**
     * Static key file/variable. Development only: it holds plaintext seeds, so
     * the server refuses to construct it in production and production resolves
     * `delegate:<name>` refs instead.
     */
    store?: AgentKeyStore;
    /** Encrypted, capability-scoped delegate keys (the production path). */
    delegates?: DelegateSource;
    /** Checks the delegate against the chain, via the relayer, on every request. */
    verifier?: Pick<DelegateVerifier, "verify">;
    /** Relayer origin and namespace for delegates, which carry neither. */
    delegateDefaults?: { serverUrl?: string; namespace: string };
    requestTimeoutMs: number;
    eventsUrl?: string;
    /** Secret for the event sink. Falls back to the bridge's own shared secret. */
    eventsSecret?: string;
    /** Injectable for tests. */
    createClient?: (agent: ResolvedAgentKey) => Memory;
    fetchImpl?: typeof fetch;
}

/**
 * `done` is durability, not read-after-write consistency: the vector index can
 * lag a completed write. Surfaced here so callers do not treat a remember as
 * immediately recallable.
 */
export interface BridgeEvent {
    event_version: 1;
    event_family: "memory";
    event_type: "created";
    organization_id?: string;
    account_id: string;
    agent_object_id?: string;
    payload: Record<string, unknown>;
    occurred_at_ms: number;
    source_event_id: string;
    deduplication_key: string;
    source_service: string;
}

function defaultCreateClient(agent: ResolvedAgentKey): Memory {
    return Memory.create({
        key: agent.key,
        accountId: agent.accountId,
        serverUrl: agent.serverUrl,
        namespace: agent.namespace,
        platformId: agent.platformId,
    });
}

export class MemoryBridge {
    /**
     * One client per (key_ref, key, serverUrl, namespace). The SDK caches MYDATA
     * session keys per instance, so reusing clients avoids rebuilding a
     * SessionKey on every scheduled tick.
     *
     * The key fingerprint is part of the cache key so that rotating a seed in
     * the key file takes effect on the next call. Without it a cached client
     * would keep signing with the old, possibly revoked, key until restart.
     */
    private readonly clients = new Map<string, Memory>();
    private readonly createClient: (agent: ResolvedAgentKey) => Memory;
    private readonly fetchImpl: typeof fetch;

    constructor(private readonly opts: MemoryBridgeOptions) {
        this.createClient = opts.createClient ?? defaultCreateClient;
        this.fetchImpl = opts.fetchImpl ?? fetch;
    }

    private client(agent: ResolvedAgentKey, keyRef: string, namespace: string): Memory {
        const fingerprint = createHash("sha256").update(agent.key).digest("hex").slice(0, 16);
        const prefix = `${keyRef}|${fingerprint}|`;
        const cacheKey = `${prefix}${agent.serverUrl}|${namespace}`;
        let client = this.clients.get(cacheKey);
        if (!client) {
            // Evict clients built from a previous key for this ref.
            for (const [existing, stale] of this.clients) {
                if (existing.startsWith(`${keyRef}|`) && !existing.startsWith(prefix)) {
                    stale.destroy();
                    this.clients.delete(existing);
                }
            }
            client = this.createClient({ ...agent, namespace });
            this.clients.set(cacheKey, client);
        }
        return client;
    }

    /**
     * Resolve a key ref **for a specific account**, ready to sign with.
     *
     * Two kinds of ref:
     *   - `delegate:<name>`: a encrypted delegate registered by the account owner.
     *     It is opened, then verified against the chain through the relayer on
     *     *this* request, so revocation and expiry apply immediately.
     *   - anything else: a static development key.
     *
     * The ref alone is not an authorization: it is a name the job's creator
     * chose. A static entry must be registered under the caller's account, and a
     * delegate is looked up under that account, so one tenant cannot name
     * another's key. Both failures read exactly like an unknown ref, so the
     * response cannot be used to probe which refs exist.
     */
    private async resolve(
        keyRef: string,
        accountId: string,
        needs: number,
        namespaceOverride?: string,
    ): Promise<ResolvedAgentKey> {
        const unknown = () =>
            new BridgeError(
                `unknown agent key ref ${JSON.stringify(keyRef)}`,
                404,
                "key_store:unknown_ref",
            );

        let agent: ResolvedAgentKey;
        if (keyRef.startsWith(DELEGATE_REF_PREFIX)) {
            const { delegates, verifier, delegateDefaults } = this.opts;
            if (!delegates || !verifier || !delegateDefaults?.serverUrl) throw unknown();
            const opened = await delegates.open(accountId, keyRef.slice(DELEGATE_REF_PREFIX.length));
            agent = {
                key: opened.seedHex,
                accountId,
                serverUrl: delegateDefaults.serverUrl,
                namespace: delegateDefaults.namespace,
            };
            await verifier.verify({
                seedHex: opened.seedHex,
                serverUrl: agent.serverUrl,
                accountId,
                agentObjectId: opened.agentObjectId,
                needs,
            });
        } else {
            if (!this.opts.store) throw unknown();
            agent = this.opts.store.resolve(keyRef);
            if (normalizeObjectId(agent.accountId) !== normalizeObjectId(accountId)) throw unknown();
        }
        return namespaceOverride ? { ...agent, namespace: namespaceOverride } : agent;
    }

    /** Wipe cached client key material. Call on shutdown. */
    dispose(): void {
        for (const client of this.clients.values()) {
            client.destroy();
        }
        this.clients.clear();
    }

    async recall(req: RecallRequest): Promise<RecallResponse> {
        if (!req.query || req.query.trim().length === 0) {
            throw new BridgeError("recall requires a non-empty query", 400, "invalid_request");
        }
        const agent = await this.resolve(req.key_ref, req.account_id, NEEDS_RECALL, req.namespace);
        const limit = req.limit ?? 10;
        if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
            throw new BridgeError("limit must be an integer between 1 and 100", 400, "invalid_request");
        }

        const client = this.client(agent, req.key_ref, agent.namespace);
        try {
            const result = await client.recall(req.query, {
                limit,
                subLabel: agent.namespace,
            });
            return {
                results: result.results.map((m) => ({
                    text: m.text,
                    distance: m.distance,
                    blob_id: m.blob_id,
                    ...(m.score !== undefined ? { score: m.score } : {}),
                    ...(m.visibility !== undefined ? { visibility: m.visibility } : {}),
                    ...(m.source_agent_id ? { source_agent_id: m.source_agent_id } : {}),
                })),
                total: result.total,
                truncated: result.results.length >= limit,
                ...(result.degraded_scope !== undefined
                    ? { degraded_scope: result.degraded_scope }
                    : {}),
                namespace: agent.namespace,
            };
        } catch (err) {
            throw wrapSdkError(err, "recall");
        }
    }

    async remember(req: RememberRequest): Promise<RememberResponse> {
        if (!req.text || req.text.trim().length === 0) {
            throw new BridgeError("remember requires non-empty text", 400, "invalid_request");
        }
        const agent = await this.resolve(req.key_ref, req.account_id, NEEDS_REMEMBER, req.namespace);
        const client = this.client(agent, req.key_ref, agent.namespace);
        const wait = req.wait !== false;

        try {
            if (!wait) {
                const accepted = await client.remember(req.text, { subLabel: agent.namespace });
                return {
                    job_id: accepted.job_id,
                    status: accepted.status,
                    namespace: agent.namespace,
                };
            }
            const job = await client.rememberAndWait(req.text, agent.namespace, {
                timeoutMs: this.opts.requestTimeoutMs,
            });
            const response: RememberResponse = {
                job_id: job.job_id,
                status: job.status,
                ...(job.blob_id ? { blob_id: job.blob_id } : {}),
                ...(job.agent_object_id ? { agent_object_id: job.agent_object_id } : {}),
                namespace: agent.namespace,
            };
            await this.emitMemoryCreated(agent, response);
            return response;
        } catch (err) {
            throw wrapSdkError(err, "remember");
        }
    }

    async probe(req: ProbeRequest): Promise<ProbeResponse> {
        const agent = await this.resolve(req.key_ref, req.account_id, 0);
        const client = this.client(agent, req.key_ref, agent.namespace);
        try {
            const health = await client.health();
            return {
                status: health.status,
                version: health.version,
                namespace: agent.namespace,
            };
        } catch (err) {
            throw wrapSdkError(err, "probe");
        }
    }

    /**
     * Best-effort `memory.created` publish to the automation engine.
     *
     * A failure here must not fail the write — the memory is already durable.
     * This is what lets an event-triggered job react to a memory the bridge
     * just stored.
     */
    private async emitMemoryCreated(
        agent: ResolvedAgentKey,
        response: RememberResponse,
    ): Promise<void> {
        const url = this.opts.eventsUrl;
        if (!url) return;
        const event: BridgeEvent = {
            event_version: 1,
            event_family: "memory",
            event_type: "created",
            account_id: agent.accountId,
            ...(response.agent_object_id ? { agent_object_id: response.agent_object_id } : {}),
            payload: {
                blob_id: response.blob_id ?? null,
                job_id: response.job_id,
                namespace: response.namespace,
            },
            occurred_at_ms: Date.now(),
            source_event_id: response.job_id,
            deduplication_key: `memory:created:${response.job_id}`,
            source_service: "automation_memory_bridge",
        };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);
        try {
            await this.fetchImpl(`${url.replace(/\/+$/, "")}/internal/automation/events`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-internal-sync-secret": this.opts.eventsSecret ?? "",
                },
                body: JSON.stringify(event),
                signal: controller.signal,
            });
        } catch {
            // Deliberately swallowed: see the doc comment above.
        } finally {
            clearTimeout(timer);
        }
    }
}

/**
 * Map an SDK failure onto an HTTP-facing error without leaking internals.
 *
 * 4xx from the relayer is the caller's problem to fix (bad key, unregistered
 * agent, insufficient credits) and is passed through; anything else becomes a
 * 502 so the automation engine treats it as retryable rather than terminal.
 */
function wrapSdkError(err: unknown, op: string): BridgeError {
    if (err instanceof BridgeError) return err;
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number } | null)?.status;
    if (typeof status === "number" && status >= 400 && status < 500) {
        return new BridgeError(`${op} rejected by memory relayer: ${message}`, status, "relayer_rejected");
    }
    return new BridgeError(`${op} failed: ${message}`, 502, "relayer_unavailable");
}
