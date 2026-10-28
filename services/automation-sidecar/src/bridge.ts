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
import { CAP_MESSAGE_READ, CAP_MESSAGE_SEND, SOCIAL_ACTION_IDS, SocialClient, getProductionActionDescriptor } from "@socialproof/sub-agents";
import { LocalEd25519Signer, SponsoredSocialGateway } from "@socialproof/memory-mcp";

import { BridgeError } from "./bridge-error.js";
import { normalizeObjectId } from "./ids.js";
import { DELEGATE_REF_PREFIX, type DelegateSource } from "./delegates.js";
import type { AgentKeyStore, ResolvedAgentKey } from "./keys.js";
import {
    CAP_MYDATA_READ,
    CAP_JURY,
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

/** One operation on a previously issued per-run worker credential. */
export interface WorkRunJournalRequest {
    key_ref: string;
    account_id: string;
    parent_agent_id: string;
    worker_agent_id: string;
    run_id: string;
    credential: string;
    operation: string;
    params: Record<string, unknown>;
}

/** Proxy one MCP JSON-RPC request while keeping the action-worker seed/session in the sidecar. */
export interface WorkRunMcpRequest extends Omit<WorkRunJournalRequest, "operation" | "params"> {
    request: Record<string, unknown>;
}

/** One consented encrypted-room history read for an unattended worker run. */
export interface WorkRoomHistoryRequest extends Omit<WorkRunJournalRequest, "operation" | "params"> {
    tool_name: "messaging_get_room_history" | "messaging_get_room_attachment";
    request: Record<string, unknown>;
}

/** Caller-bound, explicitly confirmed room administration through the hosted MCP. */
export interface RoomManagementRequest {
    key_ref: string;
    account_id: string;
    agent_object_id: string;
    operation: "set_name" | "archive";
    request: Record<string, unknown>;
}

/** Execute one allowlisted, caller-bound room MCP tool through the shared room client. */
export interface RoomToolRequest {
    key_ref: string;
    account_id: string;
    agent_object_id: string;
    tool_name: string;
    arguments: Record<string, unknown>;
}

const ROOM_TOOL_METHODS: Readonly<Record<string, string>> = Object.freeze({
    messaging_list_inbox: "listInbox",
    messaging_list_rooms: "listRoomConversations",
    messaging_get_room_history: "getRoomHistory",
    messaging_get_room_attachment: "getRoomAttachment",
    messaging_send_room_message: "sendRoomMessage",
    messaging_list_reactions: "listRoomReactions",
    messaging_add_reaction: "changeRoomReaction",
    messaging_remove_reaction: "changeRoomReaction",
    messaging_get_room_receipts: "getRoomReceipts",
    messaging_update_room_receipts: "updateRoomReceipts",
    messaging_edit_message: "editRoomMessage",
    messaging_delete_message: "deleteRoomMessage",
    messaging_remove_members_rotate_key: "removeRoomMembersAndRotateKey",
    messaging_add_room_members: "addRoomMembers",
    messaging_leave_group: "leaveRoom",
    messaging_set_room_name: "setRoomName",
    messaging_archive_group: "archiveRoom",
    messaging_get_read_state: "getRoomReadState",
    messaging_update_read_state: "updateRoomReadState",
    messaging_get_unread_counts: "getRoomUnreadCounts",
    messaging_wait_for_message: "waitForMessage",
});
const ROOM_ADMIN_TOOLS = new Set(["messaging_remove_members_rotate_key", "messaging_add_room_members", "messaging_leave_group", "messaging_set_room_name", "messaging_archive_group"]);
const ROOM_READ_TOOLS = new Set(["messaging_list_inbox", "messaging_list_rooms", "messaging_get_room_history", "messaging_get_room_attachment", "messaging_list_reactions", "messaging_get_room_receipts", "messaging_get_read_state", "messaging_get_unread_counts", "messaging_wait_for_message"]);

/** Owner-approved harness configuration queued by automation; never contains OAuth or key material. */
export interface WorkRunDispatchRequest {
    key_ref: string;
    account_id: string;
    parent_agent_id: string;
    run_id: string;
    dispatch_id: string;
    turn: Record<string, unknown>;
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

/**
 * The permissionless jury cranks: every other jury action. No delegate runs them; they sign with
 * the operator's crank key ({@link OPERATOR_KEY_REF}).
 */
export const CRANK_ACTION_IDS: ReadonlySet<string> = new Set(
    SOCIAL_ACTION_IDS.filter((id) => id.startsWith("jury.") && !JUROR_ACTION_IDS.has(id)),
);

/**
 * Curated owner-selectable action-worker set. Keep aligned with the app's
 * ACTION_WORKER_ACTIONS and the automation engine/Memory storage allowlists.
 */
const ACTION_WORKER_ACTION_IDS = [
    "access.publish_mydata_graph.v1", "access.purchase_mydata_access.v1", "access.purchase_post_access.v1",
    "task.create.v1", "spt.buy.v1",
    "social.react_to_post.v1", "social.remove_post_reaction.v1", "social.react_to_comment.v1",
    "social.remove_comment_reaction.v1", "social.create_post.v1", "social.edit_post.v1",
    "social.create_comment.v1", "social.edit_comment.v1", "social.create_repost.v1",
    "social.remove_repost.v1", "social.follow_profile.v1", "social.unfollow_profile.v1",
    "social.block_profile.v1", "social.unblock_profile.v1", "messaging.send_message.v1",
    "messaging.create_group.v1", "messaging.bind_room_to_task.v1", "organization.accept_invitation.v1",
    "organization.decline_invitation.v1", "agent.register_child.v1", "agent.update_child.v1",
    "agent.deactivate_child.v1", "agent.revoke_child.v1",
] as const;

/** The key ref a crank job names to sign with {@link MemoryBridgeOptions.crankSigner}. */
export const OPERATOR_KEY_REF = "operator:jury";

/** What each chain-acting class may run, and the one capability it needs to run it. */
export const CHAIN_CLASS_ACTIONS: Readonly<Record<ChainDelegateClass, ReadonlySet<string>>> = Object.freeze({
    task_worker: TASK_ACTION_IDS,
    juror: JUROR_ACTION_IDS,
    action_worker: new Set(ACTION_WORKER_ACTION_IDS.filter((id) => {
        const descriptor = getProductionActionDescriptor(id);
        return descriptor?.availability === "enabled" && descriptor.approval === "agent-capability" && descriptor.requiredCapability !== null;
    })),
});
export const CHAIN_CLASS_NEEDS: Readonly<Record<ChainDelegateClass, number>> = Object.freeze({
    task_worker: CAP_TASK_TRADE,
    juror: CAP_JURY,
    action_worker: 0,
});

/** The one class that may run an action, or `undefined` if no delegate class may. */
export function classForAction(actionId: string): ChainDelegateClass | undefined {
    for (const delegateClass of ["task_worker", "juror", "action_worker"] as const) {
        if (CHAIN_CLASS_ACTIONS[delegateClass].has(actionId)) return delegateClass;
    }
    return undefined;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:/-]{8,128}$/;
const MAX_ACTION_PARAMS_BYTES = 32 * 1024;
const MAX_WORK_MCP_REQUEST_BYTES = 256 * 1024;

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
    verifier?: Pick<DelegateVerifier, "verify" | "inspect">;
    /** Relayer origin and namespace for delegates, which carry neither. */
    delegateDefaults?: { serverUrl?: string; namespace: string };
    /**
     * The crank operator's wallet (`JURY_CRANK_SIGNER_KEY`), a sub-agent seed of the account
     * `JURY_CRANK_OPERATOR_ID`. The cranks are permissionless on chain, so it needs no capability;
     * it signs only {@link CRANK_ACTION_IDS} and only for that account.
     */
    crankSigner?: { seedHex: string; accountId: string };
    requestTimeoutMs: number;
    eventsUrl?: string;
    /** Secret for the event sink. Falls back to the bridge's own shared secret. */
    eventsSecret?: string;
    /** Shared secret for the fixed internal Memory work-journal endpoint. */
    internalSyncSecret?: string;
    /** Hosted MCP endpoint used only for an action-worker's scoped run calls. */
    workMcpUrl?: string;
    /** Messaging relayer used only for explicitly consented run-scoped history reads. */
    messagingRelayerUrl?: string;
    /** MySo Agents app origin and dispatch secret. */
    workDispatchUrl?: string;
    workDispatchSecret?: string;
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
     * Run one chain action: a task market action as a `task_worker` delegate, a juror's own step
     * as a `juror` delegate, or a permissionless jury crank with the operator's crank key.
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
        if (req.key_ref === OPERATOR_KEY_REF) return this.crank(req);
        const requiredClass = classForAction(req.action_id);
        if (!requiredClass) {
            throw new BridgeError(
                `${JSON.stringify(req.action_id)} is not an action a delegate may run`,
                403,
                "action_not_allowed",
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
            needs: requiredClass === "action_worker"
                ? getProductionActionDescriptor(req.action_id)?.requiredCapability ?? Number.MAX_SAFE_INTEGER
                : CHAIN_CLASS_NEEDS[requiredClass],
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

    /** A crank on the operator's key: no delegate, no capability, only the operator's own account. */
    private async crank(req: ChainActRequest): Promise<ChainActResponse> {
        if (!CRANK_ACTION_IDS.has(req.action_id)) {
            throw new BridgeError(
                `${JSON.stringify(req.action_id)} is not a jury crank`,
                403,
                "action_not_allowed",
            );
        }
        const signer = this.opts.crankSigner;
        const serverUrl = this.opts.delegateDefaults?.serverUrl;
        if (!signer || !serverUrl) {
            throw new BridgeError(
                `unknown agent key ref ${JSON.stringify(req.key_ref)}`,
                404,
                "key_store:unknown_ref",
            );
        }
        if (normalizeObjectId(req.account_id) !== normalizeObjectId(signer.accountId)) {
            throw new BridgeError(
                "the crank key signs only for the crank operator's account",
                403,
                "delegate_wrong_account",
            );
        }
        const client = this.createChainClient({ seedHex: signer.seedHex, accountId: signer.accountId, serverUrl });
        try {
            const result = await client.executeAction(req.action_id, req.params as Record<string, unknown>, {
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
     * Execute one already-authorized run-journal operation as its action_worker.
     * The delegate seed and exported short-lived MyData SessionKey stay inside
     * this sidecar; the worker credential is forwarded only to Memory's fixed
     * internal endpoint and is never persisted here.
     */
    async workJournal(req: WorkRunJournalRequest): Promise<unknown> {
        const allowed = new Set([
            "work_run_get", "work_run_list_operations", "work_run_save_plan",
            "work_run_reserve_operation", "work_run_settle_operation",
            "work_run_append_action_receipt", "work_run_append_task_artifact",
            "work_run_update_step", "work_run_acquire_turn", "work_run_renew_turn",
            "work_run_checkpoint", "work_run_finish_turn", "work_run_complete",
        ]);
        if (!allowed.has(req.operation) || req.operation === "work_run_create" || req.operation === "work_run_list") {
            throw new BridgeError("operation is unavailable to a run worker", 403, "work_operation_not_allowed");
        }
        if (!/^delegate:[A-Za-z0-9._-]{1,64}$/.test(req.key_ref)
            || !/^[0-9a-f-]{36}$/i.test(req.run_id)
            || !/^mwr1\.[0-9a-f-]{36}\.[0-9a-f-]{36}$/i.test(req.credential)
            || Buffer.byteLength(JSON.stringify(req.params)) > MAX_ACTION_PARAMS_BYTES) {
            throw new BridgeError("invalid worker journal request", 400, "invalid_request");
        }
        if (["work_run_get", "work_run_list_operations", "work_run_save_plan", "work_run_reserve_operation",
            "work_run_append_action_receipt", "work_run_append_task_artifact", "work_run_update_step",
            "work_run_acquire_turn", "work_run_renew_turn", "work_run_checkpoint", "work_run_finish_turn", "work_run_complete"]
            .includes(req.operation) && req.params.runId !== req.run_id) {
            throw new BridgeError("worker operation must name its bound run", 403, "work_run_scope_mismatch");
        }
        if (!this.opts.internalSyncSecret) {
            throw new BridgeError("run worker journal bridge is not configured", 503, "work_journal_unavailable");
        }
        const { delegates, verifier, delegateDefaults } = this.opts;
        if (!delegates || !verifier || !delegateDefaults?.serverUrl) {
            throw new BridgeError("encrypted action-worker keys are unavailable", 503, "delegate_store_unavailable");
        }
        const ref = req.key_ref.slice(DELEGATE_REF_PREFIX.length);
        const opened = await delegates.open(req.account_id, ref);
        if (opened.delegateClass !== "action_worker"
            || normalizeObjectId(opened.agentObjectId) !== normalizeObjectId(req.worker_agent_id)) {
            throw new BridgeError("credential is not bound to this action_worker", 403, "delegate_mismatch");
        }
        await verifier.verify({
            seedHex: opened.seedHex,
            serverUrl: delegateDefaults.serverUrl,
            accountId: req.account_id,
            agentObjectId: opened.agentObjectId,
            needs: CAP_MYDATA_READ,
            delegateClass: "action_worker",
        });
        const agent: ResolvedAgentKey = {
            key: opened.seedHex,
            accountId: req.account_id,
            serverUrl: delegateDefaults.serverUrl,
            namespace: delegateDefaults.namespace,
        };
        const client = this.client(agent, req.key_ref, agent.namespace);
        const target = `${agent.serverUrl.replace(/\/+$/, "")}/internal/mcp/work-journal`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.opts.requestTimeoutMs);
        try {
            return await client.withMyDataSession(async (session) => {
                const response = await this.fetchImpl(target, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        "x-internal-sync-secret": this.opts.internalSyncSecret!,
                        "x-mydata-session": session,
                        "x-work-run-credential": req.credential,
                    },
                    body: JSON.stringify({
                        accountId: req.account_id,
                        agentObjectId: req.parent_agent_id,
                        workerAgentObjectId: opened.agentObjectId,
                        operation: req.operation,
                        params: req.params,
                    }),
                    signal: controller.signal,
                });
                const raw = await response.text();
                if (!response.ok) {
                    const code = response.status === 401 || response.status === 403 ? "work_credential_rejected"
                        : response.status === 409 ? "work_operation_conflict"
                            : response.status === 404 ? "work_record_unavailable" : "work_journal_unavailable";
                    throw new BridgeError(`work journal rejected the worker request (${response.status})`, response.status, code);
                }
                try { return JSON.parse(raw) as unknown; }
                catch { throw new BridgeError("work journal returned invalid JSON", 502, "work_journal_unavailable"); }
            });
        } catch (err) {
            if (err instanceof BridgeError) throw err;
            throw new BridgeError("work journal request failed", 502, "work_journal_unavailable");
        } finally {
            clearTimeout(timer);
        }
    }

    async workMcp(req: WorkRunMcpRequest): Promise<unknown> {
        const rpc = req.request;
        if (!/^delegate:[A-Za-z0-9._-]{1,64}$/.test(req.key_ref)
            || !/^[0-9a-f-]{36}$/i.test(req.run_id)
            || !/^mwr1\.[0-9a-f-]{36}\.[0-9a-f-]{36}$/i.test(req.credential)
            || rpc.jsonrpc !== "2.0" || !["tools/list", "tools/call"].includes(String(rpc.method))
            || !["string", "number"].includes(typeof rpc.id)
            || Buffer.byteLength(JSON.stringify(rpc)) > MAX_WORK_MCP_REQUEST_BYTES) {
            throw new BridgeError("invalid worker MCP request", 400, "invalid_request");
        }
        if (rpc.method === "tools/call") {
            const params = rpc.params;
            if (!params || typeof params !== "object" || Array.isArray(params)
                || typeof (params as Record<string, unknown>).name !== "string"
                || ["work_run_issue_worker_credential", "work_run_revoke_worker_credential"].includes((params as Record<string, unknown>).name as string)) {
                throw new BridgeError("worker MCP operation is unavailable", 403, "work_operation_not_allowed");
            }
        }
        if (!this.opts.workMcpUrl) throw new BridgeError("run worker MCP proxy is not configured", 503, "work_mcp_unavailable");
        const { delegates, verifier, delegateDefaults } = this.opts;
        if (!delegates || !verifier || !delegateDefaults?.serverUrl) throw new BridgeError("encrypted action-worker keys are unavailable", 503, "delegate_store_unavailable");
        const opened = await delegates.open(req.account_id, req.key_ref.slice(DELEGATE_REF_PREFIX.length));
        if (opened.delegateClass !== "action_worker" || normalizeObjectId(opened.agentObjectId) !== normalizeObjectId(req.worker_agent_id)) {
            throw new BridgeError("credential is not bound to this action_worker", 403, "delegate_mismatch");
        }
        await verifier.verify({ seedHex: opened.seedHex, serverUrl: delegateDefaults.serverUrl, accountId: req.account_id, agentObjectId: opened.agentObjectId, needs: CAP_MYDATA_READ, delegateClass: "action_worker" });
        const agent: ResolvedAgentKey = { key: opened.seedHex, accountId: req.account_id, serverUrl: delegateDefaults.serverUrl, namespace: delegateDefaults.namespace };
        const client = this.client(agent, req.key_ref, agent.namespace);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.opts.requestTimeoutMs);
        try {
            return await client.withMyDataSession(async (session) => {
                const response = await this.fetchImpl(this.opts.workMcpUrl!, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        "accept": "application/json, text/event-stream",
                        "MCP-Protocol-Version": "2025-03-26",
                        "authorization": `Bearer ${req.credential}`,
                        "x-mydata-session": session,
                    },
                    body: JSON.stringify(rpc),
                    redirect: "error",
                    signal: controller.signal,
                });
                const raw = await response.text();
                if (!response.ok) throw new BridgeError(`hosted MCP rejected the run worker (${response.status})`, response.status, response.status === 401 || response.status === 403 ? "work_credential_rejected" : "work_mcp_unavailable");
                if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new BridgeError("hosted MCP response exceeds 2 MiB", 502, "payload_too_large");
                try { return JSON.parse(raw) as unknown; }
                catch { throw new BridgeError("hosted MCP returned invalid JSON", 502, "work_mcp_unavailable"); }
            });
        } catch (err) {
            if (err instanceof BridgeError) throw err;
            throw new BridgeError("hosted MCP worker proxy failed", 502, "work_mcp_unavailable");
        } finally { clearTimeout(timer); }
    }

    /** Read encrypted room history as the live action_worker, after per-run consent. */
    async workRoomHistory(req: WorkRoomHistoryRequest): Promise<unknown> {
        if (!this.opts.messagingRelayerUrl || !this.opts.internalSyncSecret) {
            throw new BridgeError("run worker room history is not configured", 503, "room_history_unavailable");
        }
        if ((req.tool_name !== "messaging_get_room_history" && req.tool_name !== "messaging_get_room_attachment")
            || !/^delegate:[A-Za-z0-9._-]{1,64}$/.test(req.key_ref)
            || !/^0x[0-9a-fA-F]{1,64}$/.test(req.account_id)
            || !/^0x[0-9a-fA-F]{1,64}$/.test(req.parent_agent_id)
            || !/^0x[0-9a-fA-F]{1,64}$/.test(req.worker_agent_id)
            || !/^[0-9a-f-]{36}$/i.test(req.run_id)
            || !/^mwr1\.[0-9a-f-]{36}\.[0-9a-f-]{36}$/i.test(req.credential)
            || Buffer.byteLength(JSON.stringify(req.request)) > 64 * 1024) {
            throw new BridgeError("invalid worker room-history request", 400, "invalid_request");
        }
        const { delegates, verifier, delegateDefaults } = this.opts;
        if (!delegates || !verifier || !delegateDefaults?.serverUrl) {
            throw new BridgeError("encrypted action-worker keys are unavailable", 503, "delegate_store_unavailable");
        }
        const ref = req.key_ref.slice(DELEGATE_REF_PREFIX.length);
        const opened = await delegates.open(req.account_id, ref);
        if (opened.delegateClass !== "action_worker"
            || normalizeObjectId(opened.agentObjectId) !== normalizeObjectId(req.worker_agent_id)) {
            throw new BridgeError("credential is not bound to this action_worker", 403, "delegate_mismatch");
        }
        await verifier.verify({
            seedHex: opened.seedHex,
            serverUrl: delegateDefaults.serverUrl,
            accountId: req.account_id,
            agentObjectId: opened.agentObjectId,
            needs: CAP_MYDATA_READ | CAP_MESSAGE_READ,
            delegateClass: "action_worker",
        });
        const agent: ResolvedAgentKey = {
            key: opened.seedHex,
            accountId: req.account_id,
            serverUrl: delegateDefaults.serverUrl,
            namespace: delegateDefaults.namespace,
        };
        const contextUrl = `${agent.serverUrl.replace(/\/+$/, "")}/internal/mcp/work-worker-context`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.opts.requestTimeoutMs);
        const signer = new LocalEd25519Signer("development-file", req.key_ref, Buffer.from(opened.seedHex, "hex"));
        try {
            const contextResponse = await this.fetchImpl(contextUrl, {
                method: "POST",
                headers: {
                    "x-internal-sync-secret": this.opts.internalSyncSecret,
                    "x-work-run-credential": req.credential,
                },
                redirect: "error",
                signal: controller.signal,
            });
            if (!contextResponse.ok) throw new BridgeError("Memory rejected the room-history worker credential", contextResponse.status, "work_credential_rejected");
            const context = await contextResponse.json() as Record<string, unknown>;
            if (context.runId !== req.run_id
                || normalizeObjectId(String(context.accountId)) !== normalizeObjectId(req.account_id)
                || normalizeObjectId(String(context.parentAgentId)) !== normalizeObjectId(req.parent_agent_id)
                || normalizeObjectId(String(context.workerAgentId)) !== normalizeObjectId(opened.agentObjectId)
                || context.delegateRef !== ref
                || context.allowRoomHistory !== true
                || context.cancelRequestedAt !== null
                || !Number.isSafeInteger(context.workerCapabilities)
                || !((context.workerCapabilities as number) & CAP_MESSAGE_READ)) {
                throw new BridgeError("room-history run consent or live worker authority is missing", 403, "room_history_consent_required");
            }
            const gateway = new SponsoredSocialGateway({
                signer,
                accountId: req.account_id,
                serverUrl: agent.serverUrl,
                messagingRelayerUrl: this.opts.messagingRelayerUrl,
            });
            return req.tool_name === "messaging_get_room_attachment"
                ? await gateway.getRoomAttachment(req.request as never)
                : await gateway.getRoomHistory(req.request as never);
        } catch (err) {
            if (err instanceof BridgeError) throw err;
            throw new BridgeError("encrypted room history could not be read", 502, "room_history_unavailable");
        } finally {
            clearTimeout(timer);
            signer.destroy();
        }
    }

    /** Run native room administration with an owner-matched delegated signer. */
    async roomManagement(req: RoomManagementRequest): Promise<unknown> {
        return this.roomTool({
            key_ref: req.key_ref,
            account_id: req.account_id,
            agent_object_id: req.agent_object_id,
            tool_name: req.operation === "archive" ? "messaging_archive_group" : "messaging_set_room_name",
            arguments: req.operation === "archive"
                ? { ...req.request, ownerConfirmation: req.request.ownerConfirmation }
                : req.request,
        });
    }

    /** Execute a caller-selected room tool only through the signed, permission-checking MCP gateway. */
    async roomTool(req: RoomToolRequest): Promise<unknown> {
        if (!this.opts.messagingRelayerUrl || !this.opts.delegates || !this.opts.verifier || !this.opts.delegateDefaults?.serverUrl) {
            throw new BridgeError("room messaging is not configured", 503, "room_tool_unavailable");
        }
        if (!/^delegate:[A-Za-z0-9._-]{1,64}$/.test(req.key_ref)
            || !/^0x[0-9a-fA-F]{1,64}$/.test(req.account_id)
            || !/^0x[0-9a-fA-F]{1,64}$/.test(req.agent_object_id)
            || !Object.hasOwn(ROOM_TOOL_METHODS, req.tool_name)
            || Buffer.byteLength(JSON.stringify(req.arguments)) > (req.tool_name === "messaging_send_room_message" ? 72 * 1024 * 1024 : 128 * 1024)) {
            throw new BridgeError("invalid room tool request", 400, "invalid_request");
        }
        const ref = req.key_ref.slice(DELEGATE_REF_PREFIX.length);
        const opened = await this.opts.delegates.open(req.account_id, ref);
        const authorizedActionIds = ROOM_ADMIN_TOOLS.has(req.tool_name)
            ? ["messaging.create_group.v1"]
            : req.tool_name === "messaging_get_room_history" || ROOM_READ_TOOLS.has(req.tool_name)
                ? ["messaging.send_message.v1", "messaging.create_group.v1"]
                : ["messaging.send_message.v1"];
        if (opened.delegateClass !== "action_worker"
            || normalizeObjectId(opened.agentObjectId) !== normalizeObjectId(req.agent_object_id)
            || !authorizedActionIds.some((actionId) => opened.allowedActionIds.includes(actionId))) {
            throw new BridgeError("no explicitly authorized room action-worker delegate is available", 403, "delegate_mismatch");
        }
        const needs = ROOM_READ_TOOLS.has(req.tool_name) ? CAP_MESSAGE_READ : CAP_MESSAGE_SEND;
        await this.opts.verifier.verify({
            seedHex: opened.seedHex,
            serverUrl: this.opts.delegateDefaults.serverUrl,
            accountId: req.account_id,
            agentObjectId: opened.agentObjectId,
            needs,
            delegateClass: "action_worker",
        });
        const signer = new LocalEd25519Signer("development-file", req.key_ref, Buffer.from(opened.seedHex, "hex"));
        try {
            const gateway = new SponsoredSocialGateway({
                signer,
                accountId: req.account_id,
                serverUrl: this.opts.delegateDefaults.serverUrl,
                messagingRelayerUrl: this.opts.messagingRelayerUrl,
            });
            const methodName = ROOM_TOOL_METHODS[req.tool_name]!;
            const method = (gateway as unknown as Record<string, unknown>)[methodName];
            if (typeof method !== "function") throw new BridgeError("room tool is unavailable in this MCP build", 503, "room_tool_unavailable");
            const arguments_ = req.tool_name === "messaging_add_reaction" || req.tool_name === "messaging_remove_reaction"
                ? { ...req.arguments, add: req.tool_name === "messaging_add_reaction" }
                : req.arguments;
            return await (method as (input: Record<string, unknown>) => Promise<unknown>).call(gateway, arguments_);
        } catch (error) {
            if (error instanceof BridgeError) throw error;
            const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 502;
            const message = error instanceof Error ? error.message : "room tool failed";
            throw new BridgeError(message, status >= 400 && status < 600 ? status : 502, "room_tool_failed");
        } finally {
            signer.destroy();
        }
    }

    /** Dispatch one durable harness turn using a just-in-time run credential. */
    async workRunDispatch(req: WorkRunDispatchRequest): Promise<unknown> {
        if (!this.opts.workDispatchUrl || !this.opts.workDispatchSecret || !this.opts.internalSyncSecret) {
            throw new BridgeError("durable work dispatch is not configured", 503, "work_dispatch_unavailable");
        }
        if (!this.opts.delegates || !this.opts.verifier || !this.opts.delegateDefaults?.serverUrl
            || !/^delegate:[A-Za-z0-9._-]{1,64}$/.test(req.key_ref)
            || !/^0x[0-9a-fA-F]{1,64}$/.test(req.account_id)
            || !/^0x[0-9a-fA-F]{1,64}$/.test(req.parent_agent_id)
            || !/^[0-9a-f-]{36}$/i.test(req.run_id)
            || !/^[0-9a-f-]{36}$/i.test(req.dispatch_id)
            || Buffer.byteLength(JSON.stringify(req.turn)) > 32 * 1024) {
            throw new BridgeError("invalid durable work dispatch", 400, "invalid_request");
        }
        const delegateRef = req.key_ref.slice(DELEGATE_REF_PREFIX.length);
        const opened = await this.opts.delegates.open(req.account_id, delegateRef);
        if (opened.delegateClass !== "action_worker") throw new BridgeError("durable harness runs require an action_worker delegate", 403, "delegate_class_mismatch");
        await this.opts.verifier.verify({
            seedHex: opened.seedHex,
            serverUrl: this.opts.delegateDefaults.serverUrl,
            accountId: req.account_id,
            agentObjectId: opened.agentObjectId,
            needs: CAP_MYDATA_READ,
            delegateClass: "action_worker",
        });
        const agent: ResolvedAgentKey = {
            key: opened.seedHex,
            accountId: req.account_id,
            serverUrl: this.opts.delegateDefaults.serverUrl,
            namespace: this.opts.delegateDefaults.namespace,
        };
        const client = this.client(agent, req.key_ref, agent.namespace);
        const issueUrl = `${agent.serverUrl.replace(/\/+$/, "")}/internal/mcp/work-worker-credential/issue`;
        const revokeUrl = `${agent.serverUrl.replace(/\/+$/, "")}/internal/mcp/work-worker-credential/revoke`;
        const appUrl = `${this.opts.workDispatchUrl.replace(/\/+$/, "")}/api/myso/internal/work/runs/${req.run_id}/turn`;
        return client.withMyDataSession(async (session) => {
            const issueResponse = await this.fetchImpl(issueUrl, {
                method: "POST", redirect: "error",
                headers: { "content-type": "application/json", "x-internal-sync-secret": this.opts.internalSyncSecret!, "x-mydata-session": session },
                body: JSON.stringify({ accountId: req.account_id, parentAgentId: req.parent_agent_id, runId: req.run_id, delegateRef, ttlSeconds: 1800,
                    allowPrivateGraph: req.turn.allowPrivateGraph === true,
                    allowRoomHistory: req.turn.allowRoomHistory === true,
                    allowPrivateTaskArtifacts: req.turn.allowPrivateTaskArtifacts === true,
                    allowPrivateContentSharing: req.turn.allowPrivateContentSharing === true }),
                signal: AbortSignal.timeout(this.opts.requestTimeoutMs),
            });
            if (!issueResponse.ok) throw new BridgeError(`Memory refused run credential issuance (${issueResponse.status})`, issueResponse.status, "work_credential_issue_failed");
            const issued = await issueResponse.json() as { credential?: unknown; workerAgentId?: unknown; runId?: unknown };
            if (typeof issued.credential !== "string" || !/^mwr1\.[0-9a-f-]{36}\.[0-9a-f-]{36}$/i.test(issued.credential)
                || typeof issued.workerAgentId !== "string" || normalizeObjectId(issued.workerAgentId) !== normalizeObjectId(opened.agentObjectId)
                || issued.runId !== req.run_id) throw new BridgeError("Memory returned a mismatched run credential", 502, "work_credential_issue_failed");
            const dispatchController = new AbortController();
            // One sidecar request owns one resumable model slice. The automation worker
            // dispatches continuations as separate calls under its durable delivery lease.
            // Keep this deadline shorter than the credential's 30-minute lifetime.
            const dispatchTimer = setTimeout(() => dispatchController.abort(), 25 * 60 * 1000);
            try {
                const worker = { keyRef: req.key_ref, accountId: req.account_id, parentAgentId: req.parent_agent_id, workerAgentId: opened.agentObjectId, runId: req.run_id, credential: issued.credential };
                const maxModelTurns = req.turn.maxModelTurns;
                if (typeof maxModelTurns !== "number" || !Number.isInteger(maxModelTurns) || maxModelTurns < 1 || maxModelTurns > 100) {
                    throw new BridgeError("Work-run model-turn limit is invalid", 400, "invalid_work_run_turn");
                }
                const turn = { ...req.turn, maxModelTurns: 1, requestId: req.dispatch_id, continueRun: req.turn.continueRun === true };
                let delayMs = 5_000;
                while (!dispatchController.signal.aborted) {
                    let response: Response;
                    try {
                        response = await this.fetchImpl(appUrl, {
                            method: "POST", redirect: "error",
                            headers: { "content-type": "application/json", "x-myso-worker-secret": this.opts.workDispatchSecret! },
                            body: JSON.stringify({ worker, turn }),
                            signal: dispatchController.signal,
                        });
                    } catch (error) {
                        if (dispatchController.signal.aborted) throw error;
                        // A lost connection does not tell us whether the app completed the turn.
                        // Reissue the same idempotent request so its fenced journal can replay or resume it.
                        await new Promise((resolve) => setTimeout(resolve, delayMs));
                        delayMs = Math.min(delayMs * 2, 60_000);
                        continue;
                    }
                    if (response.status === 202) {
                        const retryAfter = Number(response.headers.get("retry-after"));
                        await response.body?.cancel().catch(() => undefined);
                        await new Promise((resolve) => setTimeout(resolve, Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 60_000) : delayMs));
                        continue;
                    }
                    if (response.status >= 500) {
                        await response.body?.cancel().catch(() => undefined);
                        await new Promise((resolve) => setTimeout(resolve, delayMs));
                        delayMs = Math.min(delayMs * 2, 60_000);
                        continue;
                    }
                    if (response.status === 409) {
                        const text = await response.text();
                        let message = "";
                        try { message = String((JSON.parse(text) as { error?: unknown }).error ?? ""); } catch { /* Preserve the generic conflict below. */ }
                        if (message.includes("work turn is busy, expired or requires reconciliation")) {
                            await new Promise((resolve) => setTimeout(resolve, delayMs));
                            delayMs = Math.min(delayMs * 2, 60_000);
                            continue;
                        }
                        throw new BridgeError(`MySo Agents could not safely resume the durable run (${response.status})`, response.status, "work_dispatch_reconciliation_required");
                    }
                    if (!response.ok) throw new BridgeError(`MySo Agents rejected the durable run turn (${response.status})`, response.status, response.status === 401 || response.status === 403 ? "work_dispatch_rejected" : "work_dispatch_failed");
                    const text = await response.text();
                    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new BridgeError("MySo Agents work response exceeds 2 MiB", 502, "payload_too_large");
                    return JSON.parse(text) as unknown;
                }
                throw new BridgeError("durable work turn exceeded its credential window", 504, "work_dispatch_timeout");
            } finally {
                clearTimeout(dispatchTimer);
                const revokeResponse = await this.fetchImpl(revokeUrl, {
                    method: "POST", redirect: "error",
                    headers: { "content-type": "application/json", "x-internal-sync-secret": this.opts.internalSyncSecret!, "x-mydata-session": session },
                    body: JSON.stringify({ accountId: req.account_id, parentAgentId: req.parent_agent_id, runId: req.run_id }),
                    signal: AbortSignal.timeout(this.opts.requestTimeoutMs),
                }).catch(() => undefined);
                if (!revokeResponse?.ok) console.warn("run credential revocation could not be confirmed; the credential will expire automatically");
            }
        });
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
