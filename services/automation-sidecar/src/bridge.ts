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
import { SOCIAL_ACTION_IDS, SocialClient } from "@socialproof/sub-agents";

import { BridgeError } from "./bridge-error.js";
import { normalizeObjectId } from "./ids.js";
import { DELEGATE_REF_PREFIX, type DelegateSource } from "./delegates.js";
import type { AgentKeyStore, ResolvedAgentKey } from "./keys.js";
import {
    CAP_JURY,
    CAP_JURY_KEEPER,
    CAP_TASK_TRADE,
    NEEDS_RECALL,
    NEEDS_REMEMBER,
    type DelegateClass,
    type DelegateVerifier,
} from "./verify.js";

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

/** The delegate classes that act on chain. `memory` never does. */
export type ChainDelegateClass = Exclude<DelegateClass, "memory">;

/** Task market actions, run by a `task_worker`. */
export const TASK_ACTION_IDS: ReadonlySet<string> = new Set(
    SOCIAL_ACTION_IDS.filter((id) => id.startsWith("task.")),
);

/** A juror's own steps, run by a `juror`. */
export const JUROR_ACTION_IDS: ReadonlySet<string> = new Set(
    ["jury.accept.v1", "jury.commit_vote.v1", "jury.reveal_vote.v1", "jury.claim_fee.v1"].filter(
        (id) => (SOCIAL_ACTION_IDS as readonly string[]).includes(id),
    ),
);

/** The permissionless jury cranks, run by a `jury_keeper`: every other jury action. */
export const KEEPER_ACTION_IDS: ReadonlySet<string> = new Set(
    SOCIAL_ACTION_IDS.filter((id) => id.startsWith("jury.") && !JUROR_ACTION_IDS.has(id)),
);

/** What each chain-acting class may run, and the one capability it needs to run it. */
export const CHAIN_CLASS_ACTIONS: Readonly<Record<ChainDelegateClass, ReadonlySet<string>>> = Object.freeze({
    task_worker: TASK_ACTION_IDS,
    juror: JUROR_ACTION_IDS,
    jury_keeper: KEEPER_ACTION_IDS,
});
export const CHAIN_CLASS_NEEDS: Readonly<Record<ChainDelegateClass, number>> = Object.freeze({
    task_worker: CAP_TASK_TRADE,
    juror: CAP_JURY,
    jury_keeper: CAP_JURY_KEEPER,
});

/** The one class that may run an action, or `undefined` if no delegate class may. */
export function classForAction(actionId: string): ChainDelegateClass | undefined {
    for (const delegateClass of Object.keys(CHAIN_CLASS_ACTIONS) as ChainDelegateClass[]) {
        if (CHAIN_CLASS_ACTIONS[delegateClass].has(actionId)) return delegateClass;
    }
    return undefined;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:/-]{8,128}$/;
const MAX_ACTION_PARAMS_BYTES = 32 * 1024;

export interface ChainActRequest {
    key_ref: string;
    /** MemoryAccount the delegate acts for. */
    account_id: string;
    action_id: string;
    params: unknown;
    /** Stable per (job, event, action): a retry or a re-delivered event must not act twice. */
    idempotency_key: string;
}

export interface ChainActResponse {
    status: "executed";
    action_id: string;
    digest: string;
}

export interface DelegateStatusRequest {
    key_ref: string;
    account_id: string;
}

export interface DelegateStatusResponse {
    /** `inactive` once the delegate is revoked, deactivated or expired: nothing it signs will run. */
    status: "active" | "inactive";
    delegate_class: string;
    expires_at_ms: number | null;
    expires_in_ms: number | null;
    reason?: string;
}

/** The slice of `SocialClient` the bridge uses, so tests need no network or chain. */
export interface ChainClient {
    executeAction(
        actionId: string,
        params: unknown,
        options: { idempotencyKey: string },
    ): Promise<{ digest: string }>;
}

export interface ChainClientTarget {
    seedHex: string;
    accountId: string;
    serverUrl: string;
}

interface CoinRecord {
    coinObjectId: string;
    balance: string;
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
    /** Injectable for tests. Built per call and never cached: a chain client holds the signing key. */
    createChainClient?: (target: ChainClientTarget) => ChainClient;
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

function defaultCreateChainClient(target: ChainClientTarget): ChainClient {
    return SocialClient.create({
        key: target.seedHex,
        accountId: target.accountId,
        serverUrl: target.serverUrl,
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
    private readonly createChainClient: (target: ChainClientTarget) => ChainClient;
    private readonly fetchImpl: typeof fetch;

    constructor(private readonly opts: MemoryBridgeOptions) {
        this.createClient = opts.createClient ?? defaultCreateClient;
        this.createChainClient = opts.createChainClient ?? defaultCreateChainClient;
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
                // Only a non-default class is passed, so a plain memory delegate is verified
                // exactly as before.
                ...(opened.delegateClass && opened.delegateClass !== "memory"
                    ? { delegateClass: opened.delegateClass }
                    : {}),
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

    /**
     * Run one chain action as a delegate: a task market action as a `task_worker`, a juror's own
     * step as a `juror`, or a permissionless jury crank as a `jury_keeper`.
     *
     * Four independent gates stand between a request and a signature, and any one failing is
     * enough: the action must belong to a delegate class; the delegate must be of exactly that
     * class and registered for that exact action; the chain must confirm it is active,
     * unexpired, spend-capped (to zero for a jury class) and holds the class capability and
     * nothing beyond it; and the relayer re-checks capability, approval-required caps and the
     * action catalog when it prepares the transaction. Nothing is cached: revoking or expiring
     * the delegate takes effect on the next call.
     */
    /**
     * Whether a delegate can still act and when it stops being able to. Reads the delegate's own
     * chain state through the same relayer check as `act`, signs nothing and changes nothing, so a
     * monitor can ask as often as it likes and warn long before an expiry turns into failed jobs.
     */
    async delegateStatus(req: DelegateStatusRequest): Promise<DelegateStatusResponse> {
        if (!req.key_ref.startsWith(DELEGATE_REF_PREFIX)) {
            throw new BridgeError("only delegate:<name> keys have a status", 400, "invalid_request");
        }
        const { delegates, verifier, delegateDefaults } = this.opts;
        if (!delegates || !verifier || !delegateDefaults?.serverUrl) {
            throw new BridgeError(
                `unknown agent key ref ${JSON.stringify(req.key_ref)}`,
                404,
                "key_store:unknown_ref",
            );
        }
        const opened = await delegates.open(req.account_id, req.key_ref.slice(DELEGATE_REF_PREFIX.length));
        try {
            const context = await verifier.inspect({
                seedHex: opened.seedHex,
                serverUrl: delegateDefaults.serverUrl,
                accountId: req.account_id,
            });
            const now = Date.now();
            return {
                status: context.expiresAtMs !== null && context.expiresAtMs <= now ? "inactive" : "active",
                delegate_class: opened.delegateClass,
                expires_at_ms: context.expiresAtMs,
                expires_in_ms: context.expiresAtMs === null ? null : context.expiresAtMs - now,
            };
        } catch (err) {
            // A revoked, expired or deactivated delegate is a finding, not a failure of this call.
            if (err instanceof BridgeError && err.code === "delegate_rejected") {
                return {
                    status: "inactive",
                    delegate_class: opened.delegateClass,
                    expires_at_ms: null,
                    expires_in_ms: null,
                    reason: err.message,
                };
            }
            throw err;
        }
    }

    async act(req: ChainActRequest): Promise<ChainActResponse> {
        const requiredClass = classForAction(req.action_id);
        if (!requiredClass) {
            throw new BridgeError(
                `${JSON.stringify(req.action_id)} is not an action a delegate may run`,
                403,
                "action_not_allowed",
            );
        }
        if (typeof req.idempotency_key !== "string" || !IDEMPOTENCY_KEY.test(req.idempotency_key)) {
            throw new BridgeError(
                "idempotency_key must be 8-128 URL-safe characters",
                400,
                "invalid_request",
            );
        }
        if (!req.params || typeof req.params !== "object" || Array.isArray(req.params)) {
            throw new BridgeError("params must be a JSON object", 400, "invalid_request");
        }
        if (Buffer.byteLength(JSON.stringify(req.params)) > MAX_ACTION_PARAMS_BYTES) {
            throw new BridgeError(
                `params exceed ${MAX_ACTION_PARAMS_BYTES} bytes`,
                413,
                "payload_too_large",
            );
        }
        if (!req.key_ref.startsWith(DELEGATE_REF_PREFIX)) {
            throw new BridgeError(
                "chain actions can only be signed by a delegate:<name> key",
                403,
                "chain_requires_delegate",
            );
        }

        const { delegates, verifier, delegateDefaults } = this.opts;
        if (!delegates || !verifier || !delegateDefaults?.serverUrl) {
            throw new BridgeError(
                `unknown agent key ref ${JSON.stringify(req.key_ref)}`,
                404,
                "key_store:unknown_ref",
            );
        }
        const opened = await delegates.open(req.account_id, req.key_ref.slice(DELEGATE_REF_PREFIX.length));
        if (opened.delegateClass !== requiredClass) {
            throw new BridgeError(
                `this delegate is not a ${requiredClass}; register one with the ${requiredClass} class`,
                403,
                "delegate_wrong_class",
            );
        }
        if (!opened.allowedActionIds.includes(req.action_id)) {
            throw new BridgeError(
                `this delegate was not registered to run ${req.action_id}`,
                403,
                "action_not_allowed",
            );
        }
        const context = await verifier.verify({
            seedHex: opened.seedHex,
            serverUrl: delegateDefaults.serverUrl,
            accountId: req.account_id,
            agentObjectId: opened.agentObjectId,
            needs: CHAIN_CLASS_NEEDS[requiredClass],
            delegateClass: requiredClass,
        });

        const params = await this.withPaymentCoin(req.action_id, req.params as Record<string, unknown>, context);
        const client = this.createChainClient({
            seedHex: opened.seedHex,
            accountId: req.account_id,
            serverUrl: delegateDefaults.serverUrl,
        });
        try {
            const result = await client.executeAction(req.action_id, params, {
                idempotencyKey: req.idempotency_key,
            });
            return { status: "executed", action_id: req.action_id, digest: result.digest };
        } catch (err) {
            throw wrapChainError(err, req.action_id);
        }
    }

    /**
     * `task.create.v1` escrows funds from a coin the delegate owns, and an event cannot name one.
     * When the job leaves `paymentCoinId` out, pick the smallest MYSO coin at the delegate's own
     * address that covers the amount. The delegate's spend cap still bounds the escrow on chain.
     * The choice is deterministic, so a retry of an unsubmitted action picks the same coin.
     */
    private async withPaymentCoin(
        actionId: string,
        params: Record<string, unknown>,
        context: { derivedAddress?: string | null; rpcUrl?: string | null },
    ): Promise<Record<string, unknown>> {
        if (actionId !== "task.create.v1" || params.paymentCoinId !== undefined) return params;

        const amountText = params.amountMist;
        if (typeof amountText !== "string" || !/^[1-9][0-9]{0,19}$/.test(amountText)) {
            throw new BridgeError("amountMist must be a positive decimal string", 400, "invalid_request");
        }
        const amount = BigInt(amountText);
        if (!context.derivedAddress || !context.rpcUrl) {
            throw new BridgeError(
                "this relayer does not report the delegate's address, so a payment coin cannot be chosen; name one with paymentCoinId",
                422,
                "payment_coin_required",
            );
        }

        let coins: CoinRecord[];
        try {
            const res = await this.fetchImpl(context.rpcUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "mysox_getCoins",
                    params: [context.derivedAddress, "0x2::myso::MYSO", null, 50],
                }),
                signal: AbortSignal.timeout(this.opts.requestTimeoutMs),
            });
            const body = (await res.json()) as { result?: { data?: CoinRecord[] } };
            coins = body.result?.data ?? [];
        } catch {
            throw new BridgeError("could not list the delegate's coins", 502, "relayer_unavailable");
        }

        const best = coins
            .filter((coin) => /^[0-9]+$/.test(coin.balance) && BigInt(coin.balance) >= amount)
            .sort((a, b) => {
                const diff = BigInt(a.balance) - BigInt(b.balance);
                return diff < 0n ? -1 : diff > 0n ? 1 : a.coinObjectId.localeCompare(b.coinObjectId);
            })[0];
        if (!best) {
            throw new BridgeError(
                `the delegate's address holds no single MYSO coin of at least ${amountText} MIST; fund it first`,
                422,
                "insufficient_funds",
            );
        }
        return { ...params, paymentCoinId: best.coinObjectId };
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

/**
 * Map a failed chain action onto the status the engine acts on: 409 means the task moved on and
 * the run is skipped, other 4xx are the caller's to fix and are never retried, and anything else
 * is an outage and retries. The relayer's own status is read from the SDK's error message.
 */
export function wrapChainError(err: unknown, actionId: string): BridgeError {
    if (err instanceof BridgeError) return err;
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(/\((\d{3})\)/.exec(message)?.[1] ?? 0);

    if (/lacks capability/i.test(message)) {
        return new BridgeError(`${actionId}: the delegate lacks the capability it needs`, 403, "delegate_missing_capability");
    }
    if (/wallet approval|owner wallet|approval required/i.test(message)) {
        return new BridgeError(
            `${actionId} needs the owner's approval, which an unattended worker cannot give`,
            403,
            "approval_required",
        );
    }
    if (/not present in the authenticated action catalog|outside the agent platform scope/i.test(message)) {
        return new BridgeError(`${actionId} is not permitted for this delegate`, 403, "action_not_allowed");
    }
    if (status === 409) {
        return new BridgeError(`${actionId}: ${message}`, 409, "chain_state");
    }
    if (status === 401 || status === 403) {
        return new BridgeError(`${actionId} was refused by the relayer`, 403, "delegate_rejected");
    }
    if (status >= 400 && status < 500 && status !== 429) {
        return new BridgeError(`${actionId} was rejected: ${message}`, 422, "action_invalid");
    }
    return new BridgeError(`${actionId} failed: ${message}`, 502, "relayer_unavailable");
}
