import type { Server } from "node:http";
import { McpRuntimeError } from "./errors.js";
import { getMyDataGraphItem, searchMyDataGraph } from "@socialproof/memory";
import { createHostedMcpHttpServer } from "./hosted.js";
import { OAuthIntrospectionVerifier, type HostedMcpPrincipal } from "./oauth.js";
import { ACTION_ID_BY_TOOL, MARKET_ACTION_TOOLS } from "./registry-tools.js";
import { PLATFORM_TOOLS, PLATFORM_TOOL_BY_NAME } from "./platform-tools.js";
import { CAP_AI_SPEND, CAP_MEMORY_READ, CAP_MEMORY_WRITE, CAP_MESSAGE_READ, CAP_MESSAGE_SEND, CAP_MYDATA_READ, CAP_TASK_TRADE, PRODUCTION_ACTION_CATALOG, SOCIAL_ACTION_REGISTRY_VERSION } from "@socialproof/sub-agents";
import type { CreateCommentInput, CreatePostInput, CreateRepostInput, ReactToCommentInput, ReactToPostInput, SocialGateway } from "./social-gateway.js";
import { TOOL_OAUTH_SCOPES, type MemoryClient, type ToolDependencies } from "./tools.js";
import { sanitizeAccountMemoryUsage, sanitizeAiCreditRead, sanitizeGraphOfferPage, sanitizeOrganizationRead, sanitizeOwnerRotationRead } from "./social-gateway.js";
import { sanitizeSocialRead } from "./social-read-sanitize.js";
import { sanitizeBadgeRead } from "./badge-read-sanitize.js";
import { sanitizeConfigRead } from "./config-read-sanitize.js";
import { isMessagingReadName, sanitizeMessagingRead } from "./messaging-read-sanitize.js";
import { sanitizeAssetReceipt, sanitizeOwnedObject, sanitizeOwnedObjects } from "./asset-read-sanitize.js";
import { sanitizeOrganizationTreasuryRead } from "./organization-treasury-read-sanitize.js";
import { sanitizePaymentRead } from "./payments-read-sanitize.js";
import { sanitizeSubscriptionRead } from "./subscription-read-sanitize.js";
import { sanitizeAgentAdminRead } from "./agent-admin-read-sanitize.js";
import { sanitizeAgentFundingCoins } from "./agent-funding-read-sanitize.js";
import { sanitizeWorkJournalRead } from "./work-run-read-sanitize.js";
import { sanitizeMyDataListingPage, sanitizeMyDataPurchaseQuote, sanitizeMyDataPurchaseReceipt } from "./mydata-purchase-read-sanitize.js";
import { sanitizeMyDataOwnerAccessHistory, sanitizeMyDataOwnerAccessReceipt } from "./mydata-owner-access-read-sanitize.js";
import { sanitizeMyDataIndexedAccess, sanitizeMyDataIndexedListing, sanitizeMyDataIndexedStats } from "./mydata-indexed-read-sanitize.js";
import { sanitizeAgentReputation } from "./agent-reputation-read-sanitize.js";
import { sanitizeAgentOwnPnl, sanitizeAgentOwnedPnl } from "./agent-pnl-read-sanitize.js";
import { sanitizeAccountAuditLogs } from "./audit-log-read-sanitize.js";
import { sanitizePocRead } from "./poc-read-sanitize.js";
import { sanitizePromotionRead } from "./promotion-read-sanitize.js";
import { sanitizeOrganizationPublicRead } from "./organization-public-read-sanitize.js";
import { sanitizeMyDataAnalyticsRead } from "./mydata-analytics-read-sanitize.js";
import { sanitizeMyDataSnapshotRead } from "./mydata-snapshot-read-sanitize.js";
import { sanitizeMyDataMarketCatalogRead } from "./mydata-market-catalog-read-sanitize.js";
import { sanitizeMyDataHistoryRead } from "./mydata-history-read-sanitize.js";
import { sanitizeMyDataCurrentAccess } from "./mydata-current-access-sanitize.js";
import { sanitizeSpotReceiptRead } from "./spot-receipt-read-sanitize.js";
import { sanitizeSptRead } from "./spt-read-sanitize.js";
import { sanitizeAutomationRead } from "./automation-read-sanitize.js";
import { sanitizeAgentChildren, sanitizeAgentReceipts, sanitizeProfileAgents } from "./agent-list-read-sanitize.js";
import { sanitizeDexMarket, sanitizeDexMarkets, sanitizeDexOrderbook, sanitizeDexStatus, sanitizeDexSummary, sanitizeDexSwapReceipt, sanitizeDexTicker, sanitizeDexTrades } from "./dex-read-sanitize.js";
import { sanitizeGovernanceRead } from "./governance-read-sanitize.js";
import { sanitizeActionApprovals, sanitizeActionByIdempotencyKey, sanitizeActionReceipt } from "./chain-read-sanitize.js";
import { sanitizeJuryCaseBundle, sanitizeJuryCasesRead, sanitizeJuryCranks, sanitizeJuryHealth, sanitizeJuryListRead, sanitizeJuryOwnProfile, sanitizeJuryRationales, sanitizeJuryReceipt, sanitizeJuryTaskDispute, sanitizeProposalJuryRead, sanitizeTaskDeliverableRead, sanitizeTaskDetailRead, sanitizeTaskDisputeRead, sanitizeTaskHistoryRead, sanitizeTaskMarketRead, sanitizeTaskReceipt, sanitizeTaskRoomRead, sanitizeTaskSettlementReceipt } from "./task-jury-read-sanitize.js";

export interface HostedMcpEnvConfig {
    port: number;
    resourceUrl: string;
    authorizationServerUrl: string;
    introspectionUrl?: string;
    oauthClientId?: string;
    oauthClientSecret?: string;
    memoryServerUrl: string;
    bridgeUrl: string;
    engineUrl: string;
    internalSyncSecret: string;
    allowedHosts: readonly string[];
    allowedOrigins: readonly string[];
    messagingRelayerUrl?: string;
    fetch?: typeof fetch;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const ROOM_MCP_TOOLS: readonly string[] = [
    "messaging_list_inbox", "messaging_list_rooms", "messaging_get_room_history", "messaging_get_room_attachment", "messaging_send_room_message", "messaging_list_reactions",
    "messaging_add_reaction", "messaging_remove_reaction", "messaging_get_room_receipts", "messaging_update_room_receipts",
    "messaging_edit_message", "messaging_delete_message", "messaging_remove_members_rotate_key", "messaging_add_room_members",
    "messaging_leave_group", "messaging_set_room_name", "messaging_archive_group", "messaging_get_read_state",
    "messaging_update_read_state", "messaging_get_unread_counts", "messaging_wait_for_message",
];
const ROOM_ADMIN_TOOLS = new Set<string>(["messaging_remove_members_rotate_key", "messaging_add_room_members", "messaging_leave_group", "messaging_set_room_name", "messaging_archive_group"]);
const ROOM_READ_TOOLS = new Set<string>(["messaging_list_inbox", "messaging_list_rooms", "messaging_get_room_history", "messaging_get_room_attachment", "messaging_list_reactions", "messaging_get_room_receipts", "messaging_get_read_state", "messaging_get_unread_counts", "messaging_wait_for_message"]);

function normalizeRoomToolArguments(name: string, args: Record<string, unknown>): Record<string, unknown> {
    if (["messaging_list_inbox", "messaging_wait_for_message", "messaging_list_rooms", "messaging_get_read_state", "messaging_get_unread_counts", "messaging_update_read_state"].includes(name)) return args;
    if (args.groupRef && typeof args.groupRef === "object") return args;
    const groupRef = typeof args.uuid === "string" ? { uuid: args.uuid } : { groupId: args.groupId, encryptionHistoryId: args.encryptionHistoryId };
    return { ...args, groupRef };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
    const value = env[name]?.trim();
    if (!value) throw new McpRuntimeError("INVALID_CONFIGURATION", `${name} is required to start the hosted MCP server.`);
    return value;
}

function serviceUrl(value: string, name: string): URL {
    let url: URL;
    try { url = new URL(value); }
    catch { throw new McpRuntimeError("INVALID_CONFIGURATION", `${name} is not a URL.`); }
    if (url.username || url.password || url.search || url.hash) {
        throw new McpRuntimeError("INVALID_CONFIGURATION", `${name} cannot contain credentials, a query, or a fragment.`);
    }
    const privateRailway = url.hostname.endsWith(".railway.internal");
    const loopback = LOOPBACK.has(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && (loopback || privateRailway))) {
        throw new McpRuntimeError("INVALID_CONFIGURATION", `${name} must use HTTPS, except for loopback or Railway private networking.`);
    }
    return url;
}

/** Reads the hosted process environment. A missing memory, bridge, or login check refuses to boot. */
export function loadHostedMcpConfig(env: NodeJS.ProcessEnv = process.env): HostedMcpEnvConfig {
    const resource = serviceUrl(required(env, "MCP_RESOURCE_URL"), "MCP_RESOURCE_URL");
    if (resource.pathname !== "/mcp") {
        throw new McpRuntimeError("INVALID_CONFIGURATION", "MCP_RESOURCE_URL must be the public /mcp URL.");
    }
    const authorizationServerUrl = serviceUrl(env.MCP_AUTHORIZATION_SERVER_URL?.trim() || "https://auth.testnet.mysocial.network", "MCP_AUTHORIZATION_SERVER_URL").toString();
    const introspectionUrl = env.MCP_OAUTH_INTROSPECTION_URL?.trim();
    if (introspectionUrl) serviceUrl(introspectionUrl, "MCP_OAUTH_INTROSPECTION_URL");
    const memoryServerUrl = serviceUrl(required(env, "MEMORY_SERVER_URL"), "MEMORY_SERVER_URL").toString().replace(/\/$/, "");
    const bridgeUrl = serviceUrl(required(env, "AUTOMATION_BRIDGE_URL"), "AUTOMATION_BRIDGE_URL").toString().replace(/\/$/, "");
    const engineUrl = serviceUrl(required(env, "AUTOMATION_ENGINE_URL"), "AUTOMATION_ENGINE_URL").toString().replace(/\/$/, "");
    const oauthClientId = env.MCP_OAUTH_CLIENT_ID?.trim();
    const oauthClientSecret = env.MCP_OAUTH_CLIENT_SECRET?.trim();
    const internalSyncSecret = required(env, "INTERNAL_SYNC_SECRET");
    const listedHosts = required(env, "MCP_ALLOWED_HOSTS").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
    const allowedHosts = [...new Set([resource.hostname.toLowerCase(), ...listedHosts])];
    const allowedOrigins = (env.MCP_ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);
    for (const origin of allowedOrigins) serviceUrl(origin, "MCP_ALLOWED_ORIGINS");
    const port = Number(env.PORT ?? "8080");
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new McpRuntimeError("INVALID_CONFIGURATION", "PORT must be a TCP port.");
    const messagingRelayerUrl = env.MCP_MESSAGING_RELAYER_URL?.trim();
    if (messagingRelayerUrl) serviceUrl(messagingRelayerUrl, "MCP_MESSAGING_RELAYER_URL");
    return {
        port,
        resourceUrl: resource.toString(),
        authorizationServerUrl,
        ...(introspectionUrl ? { introspectionUrl } : {}),
        ...(oauthClientId ? { oauthClientId } : {}),
        ...(oauthClientSecret ? { oauthClientSecret } : {}),
        memoryServerUrl,
        bridgeUrl,
        engineUrl,
        internalSyncSecret,
        allowedHosts,
        allowedOrigins,
        ...(messagingRelayerUrl ? { messagingRelayerUrl } : {}),
    };
}

const REFUSAL = "This action is outside the registered delegate allowlist.";
const CHAIN_CLASS_ACTIONS_FOR_HOSTED = new Set<string>(PRODUCTION_ACTION_CATALOG.filter((entry) =>
    entry.availability === "enabled" && entry.approval === "agent-capability" && entry.requiredCapability !== null
        && !entry.id.startsWith("task.") && !entry.id.startsWith("jury."),
).map((entry) => entry.id));

function refuse(): never {
    throw new McpRuntimeError("CAPABILITY_DENIED", REFUSAL);
}

class HostedPrincipalClient implements MemoryClient {
    constructor(
        private readonly config: HostedMcpEnvConfig,
        private readonly principal: HostedMcpPrincipal,
    ) {}

    destroy(): void {}

    getAgentContext(): Promise<unknown> {
        return serviceJson(this.config, this.config.memoryServerUrl, "POST", "/internal/mcp/agent-context", {
            accountId: this.principal.accountId,
            agentObjectId: this.principal.agentObjectId,
        }).then((value) => {
            if (!this.principal.workerRun || !value || typeof value !== "object") return value;
            const parent = value as Record<string, unknown>;
            return { ...parent, parentCapabilities: parent.capabilities, parentPermittedRegistryActions: parent.permittedRegistryActions,
                capabilities: this.principal.workerRun.workerCapabilities,
                allowPrivateGraph: this.principal.workerRun.allowPrivateGraph,
                allowRoomHistory: this.principal.workerRun.allowRoomHistory,
                allowPrivateTaskArtifacts: this.principal.workerRun.allowPrivateTaskArtifacts,
                allowPrivateContentSharing: this.principal.workerRun.allowPrivateContentSharing };
        });
    }

    health(): Promise<unknown> {
        return serviceJson(this.config, this.config.memoryServerUrl, "GET", "/health");
    }

    async rememberAndWait(text: string, subLabel?: string): Promise<unknown> {
        const keyRef = await delegateKeyRef(this.config, this.principal);
        return serviceJson(this.config, this.config.bridgeUrl, "POST", "/internal/memory/remember", {
            key_ref: keyRef,
            account_id: this.principal.accountId,
            text,
            wait: true,
            ...(subLabel ? { namespace: subLabel } : {}),
        });
    }

    async recall(query: string, limit = 10): Promise<unknown> {
        const keyRef = await delegateKeyRef(this.config, this.principal);
        return serviceJson(this.config, this.config.bridgeUrl, "POST", "/internal/memory/recall", {
            key_ref: keyRef,
            account_id: this.principal.accountId,
            query,
            limit,
        });
    }
}

class BridgeBoundGateway implements SocialGateway {
    readonly supportedToolNames: readonly string[];

    constructor(
        private readonly config: HostedMcpEnvConfig,
        private readonly principal: HostedMcpPrincipal,
        private readonly context: () => Promise<unknown>,
    ) {
        this.supportedToolNames = [
            "agent_get_context",
            "ai_list_models",
            "ai_chat",
            "mydata_search_graph", "mydata_get_graph_item", "mydata_check_current_access",
            "chain_request_action_approval", "chain_approve_action", "chain_prepare_approved_action", "chain_submit_approved_action",
            ...MARKET_ACTION_TOOLS.map((entry) => entry.tool.name),
            ...PLATFORM_TOOLS.filter((entry) => entry.name.startsWith("work_run_")).map((entry) => entry.name),
            ...PLATFORM_TOOLS.filter((entry) => entry.name.startsWith("automation_")).map((entry) => entry.name),
            ...(config.messagingRelayerUrl ? ROOM_MCP_TOOLS : []),
            ...[...ACTION_ID_BY_TOOL].filter(([, actionId]) => {
                const descriptor = PRODUCTION_ACTION_CATALOG.find((item) => item.id === actionId);
                return descriptor?.availability === "enabled" && descriptor.approval === "agent-capability" && descriptor.requiredCapability !== null
                    && !actionId.startsWith("task.") && !actionId.startsWith("jury.");
            }).map(([toolName]) => toolName),
            ...PLATFORM_TOOLS.filter((entry) => entry.method === "GET" && entry.path.startsWith("/api/agent/read/")).map((entry) => entry.name),
        ];
    }

    enableRoomMessaging(): void {}

    async availableToolNames(): Promise<readonly string[]> {
        try {
            const delegates = await listDelegateRows(this.config, this.principal);
            const context = await this.context() as { capabilities?: unknown; parentCapabilities?: unknown; permittedRegistryActions?: unknown; parentPermittedRegistryActions?: unknown };
            const capabilities = typeof context.capabilities === "number" && Number.isSafeInteger(context.capabilities) ? context.capabilities : 0;
            return this.supportedToolNames.filter((name) => {
                if (this.principal.workerRun) {
                    if (name === "mydata_search_graph" || name === "mydata_get_graph_item") return this.principal.workerRun.allowPrivateGraph
                        && !!this.principal.myDataSession
                        && (this.principal.workerRun.workerCapabilities & CAP_MYDATA_READ) === CAP_MYDATA_READ;
                    if (name.startsWith("automation_")) return false;
                    if (ROOM_MCP_TOOLS.includes(name)) {
                        if (name !== "messaging_get_room_history" && name !== "messaging_get_room_attachment") return false;
                        return this.principal.workerRun.allowRoomHistory
                            && (this.principal.workerRun.workerCapabilities & CAP_MESSAGE_READ) === CAP_MESSAGE_READ;
                    }
                    if (name === "agent_get_context") return true;
                    if (name === "ai_list_models") return true;
                    if (name === "task_get_deliverable") return this.principal.workerRun.allowPrivateTaskArtifacts
                        && this.principal.workerRun.taskId !== null
                        && (this.principal.workerRun.workerCapabilities & CAP_TASK_TRADE) === CAP_TASK_TRADE;
                    if (name === "ai_chat") {
                        const parentCaps = typeof context.parentCapabilities === "number" && Number.isSafeInteger(context.parentCapabilities) ? context.parentCapabilities : 0;
                        const actions = context.parentPermittedRegistryActions;
                        return (parentCaps & CAP_AI_SPEND) === CAP_AI_SPEND && Array.isArray(actions) && actions.includes("ai.run_inference.v1");
                    }
                    if (name.startsWith("work_run_")) {
                        if (["work_run_create", "work_run_list", "work_run_issue_worker_credential", "work_run_revoke_worker_credential"].includes(name)) return false;
                        const readOnly = name === "work_run_get" || name === "work_run_list_operations";
                        const needed = readOnly ? CAP_MEMORY_READ : CAP_MEMORY_WRITE;
                        return !!this.principal.myDataSession
                            && (this.principal.workerRun.workerCapabilities & CAP_MYDATA_READ) === CAP_MYDATA_READ
                            && (this.principal.workerRun.workerCapabilities & needed) === needed;
                    }
                    const workerAction = MARKET_ACTION_TOOLS.find((entry) => entry.tool.name === name)?.actionId ?? ACTION_ID_BY_TOOL.get(name);
                    return workerAction !== undefined && this.principal.workerRun.allowedActionIds.includes(workerAction);
                }
                if (name === "ai_chat") return false;
                if (name.startsWith("automation_")) return (capabilities & CAP_MEMORY_READ) === CAP_MEMORY_READ
                    && Array.isArray(context.permittedRegistryActions)
                    && context.permittedRegistryActions.includes("automation.access.v1");
                if (name === "mydata_check_current_access") return !!this.principal.myDataSession
                    && (capabilities & CAP_MYDATA_READ) === CAP_MYDATA_READ
                    && Array.isArray(context.permittedRegistryActions)
                    && context.permittedRegistryActions.includes("mydata.read_content.v1");
                if (ROOM_MCP_TOOLS.includes(name)) {
                    const needed = ROOM_READ_TOOLS.has(name) ? CAP_MESSAGE_READ : CAP_MESSAGE_SEND;
                    if ((capabilities & needed) !== needed) return false;
                    const actionIds = ROOM_ADMIN_TOOLS.has(name) ? ["messaging.create_group.v1"]
                        : ROOM_READ_TOOLS.has(name) ? ["messaging.send_message.v1", "messaging.create_group.v1"]
                            : ["messaging.send_message.v1"];
                    return delegates.some((row) => row.delegate_class === "action_worker"
                        && typeof row.delegate_ref === "string" && typeof row.agent_object_id === "string"
                        && normalizeHostedId(row.agent_object_id) === normalizeHostedId(this.principal.agentObjectId)
                        && Array.isArray(row.allowed_action_ids) && actionIds.some((actionId) => (row.allowed_action_ids as unknown[]).includes(actionId)));
                }
                if (name.startsWith("work_run_")) {
                    if (!this.principal.myDataSession) return false;
                    const readOnly = name === "work_run_get" || name === "work_run_list" || name === "work_run_list_operations";
                    const memoryCapability = readOnly ? CAP_MEMORY_READ : CAP_MEMORY_WRITE;
                    return (capabilities & CAP_MYDATA_READ) === CAP_MYDATA_READ && (capabilities & memoryCapability) === memoryCapability;
                }
                const actionId = MARKET_ACTION_TOOLS.find((entry) => entry.tool.name === name)?.actionId ?? ACTION_ID_BY_TOOL.get(name);
                if (!actionId) return true;
                const expectedClass = delegateClassForAction(actionId);
                return delegates.some((row) => row.delegate_class === expectedClass
                    && typeof row.delegate_ref === "string" && typeof row.agent_object_id === "string"
                    && normalizeHostedId(row.agent_object_id) === normalizeHostedId(this.principal.agentObjectId)
                    && Array.isArray(row.allowed_action_ids) && row.allowed_action_ids.includes(actionId));
            });
        } catch {
            if (this.principal.workerRun) return [];
            // Keep public/read tools available, but never advertise a write tool when the
            // account-scoped encrypted delegate catalog cannot be checked.
            return this.supportedToolNames.filter((name) => name === "agent_get_context" || name === "ai_list_models"
                || (PLATFORM_TOOL_BY_NAME.get(name)?.tool.annotations?.readOnlyHint === true
                    && name !== "mydata_check_current_access"
                    && !name.startsWith("work_run_") && !name.startsWith("automation_")
                    && !MARKET_ACTION_TOOLS.some((entry) => entry.tool.name === name) && !ACTION_ID_BY_TOOL.has(name)));
        }
    }

    getExecutionContext(): Promise<unknown> {
        return this.context();
    }

    listInbox(input: Parameters<SocialGateway["listInbox"]>[0]): Promise<unknown> { return this.callRoomTool("messaging_list_inbox", input); }
    waitForMessage(input: Parameters<SocialGateway["waitForMessage"]>[0]): Promise<unknown> { return this.callRoomTool("messaging_wait_for_message", input); }
    listRoomConversations(input: NonNullable<SocialGateway["listRoomConversations"]> extends (request: infer T) => unknown ? T : never): Promise<unknown> { return this.callRoomTool("messaging_list_rooms", input as Record<string, unknown>); }
    getRoomHistory(input: Parameters<NonNullable<SocialGateway["getRoomHistory"]>>[0]): Promise<unknown> { return this.callRoomTool("messaging_get_room_history", input as unknown as Record<string, unknown>); }
    getRoomAttachment(input: { groupRef: { groupId: string; encryptionHistoryId: string } | { uuid: string }; messageId: string; storageId: string }): Promise<unknown> { return this.callRoomTool("messaging_get_room_attachment", input as unknown as Record<string, unknown>); }
    sendRoomMessage(input: Parameters<NonNullable<SocialGateway["sendRoomMessage"]>>[0]): Promise<unknown> { return this.callRoomTool("messaging_send_room_message", input as unknown as Record<string, unknown>); }
    listRoomReactions(input: Parameters<NonNullable<SocialGateway["listRoomReactions"]>>[0]): Promise<unknown> { return this.callRoomTool("messaging_list_reactions", input as Record<string, unknown>); }
    changeRoomReaction(input: Parameters<NonNullable<SocialGateway["changeRoomReaction"]>>[0]): Promise<unknown> { return this.callRoomTool(input.add ? "messaging_add_reaction" : "messaging_remove_reaction", input as Record<string, unknown>); }
    getRoomReceipts(input: Parameters<NonNullable<SocialGateway["getRoomReceipts"]>>[0]): Promise<unknown> { return this.callRoomTool("messaging_get_room_receipts", input as Record<string, unknown>); }
    updateRoomReceipts(input: Parameters<NonNullable<SocialGateway["updateRoomReceipts"]>>[0]): Promise<unknown> { return this.callRoomTool("messaging_update_room_receipts", input as Record<string, unknown>); }
    editRoomMessage(input: Parameters<NonNullable<SocialGateway["editRoomMessage"]>>[0]): Promise<unknown> { return this.callRoomTool("messaging_edit_message", input as Record<string, unknown>); }
    deleteRoomMessage(input: Parameters<NonNullable<SocialGateway["deleteRoomMessage"]>>[0]): Promise<unknown> { return this.callRoomTool("messaging_delete_message", input as Record<string, unknown>); }
    removeRoomMembersAndRotateKey(input: Parameters<NonNullable<SocialGateway["removeRoomMembersAndRotateKey"]>>[0]): Promise<unknown> { return this.callRoomTool("messaging_remove_members_rotate_key", input as Record<string, unknown>); }
    addRoomMembers(input: Parameters<NonNullable<SocialGateway["addRoomMembers"]>>[0]): Promise<unknown> { return this.callRoomTool("messaging_add_room_members", input as Record<string, unknown>); }
    leaveRoom(input: Parameters<NonNullable<SocialGateway["leaveRoom"]>>[0]): Promise<unknown> { return this.callRoomTool("messaging_leave_group", input as Record<string, unknown>); }
    setRoomName(input: Parameters<NonNullable<SocialGateway["setRoomName"]>>[0]): Promise<unknown> { return this.callRoomTool("messaging_set_room_name", input as Record<string, unknown>); }
    archiveRoom(input: Parameters<NonNullable<SocialGateway["archiveRoom"]>>[0]): Promise<unknown> { return this.callRoomTool("messaging_archive_group", input as Record<string, unknown>); }
    getRoomReadState(): Promise<unknown> { return this.callRoomTool("messaging_get_read_state", {}); }
    updateRoomReadState(input: Parameters<NonNullable<SocialGateway["updateRoomReadState"]>>[0]): Promise<unknown> { return this.callRoomTool("messaging_update_read_state", input); }
    getRoomUnreadCounts(input: Parameters<NonNullable<SocialGateway["getRoomUnreadCounts"]>>[0]): Promise<unknown> { return this.callRoomTool("messaging_get_unread_counts", input); }

    private async callRoomTool(name: string, args: object): Promise<unknown> {
        if (!this.config.messagingRelayerUrl || this.principal.workerRun) throw new McpRuntimeError("CAPABILITY_DENIED", "This hosted session cannot perform that room action.");
        const delegates = await listDelegateRows(this.config, this.principal);
        const actionIds = ROOM_ADMIN_TOOLS.has(name) ? ["messaging.create_group.v1"]
            : ROOM_READ_TOOLS.has(name) ? ["messaging.send_message.v1", "messaging.create_group.v1"]
                : ["messaging.send_message.v1"];
        const row = delegates.find((candidate) => candidate.delegate_class === "action_worker"
            && typeof candidate.delegate_ref === "string" && typeof candidate.agent_object_id === "string"
            && normalizeHostedId(candidate.agent_object_id) === normalizeHostedId(this.principal.agentObjectId)
            && Array.isArray(candidate.allowed_action_ids) && actionIds.some((actionId) => (candidate.allowed_action_ids as unknown[]).includes(actionId)));
        if (!row || typeof row.delegate_ref !== "string") throw new McpRuntimeError("CAPABILITY_DENIED", "An explicitly authorized action-worker delegate is required for room access.");
        return serviceJson(this.config, this.config.bridgeUrl, "POST", "/internal/mcp/room-tool", {
            key_ref: `delegate:${row.delegate_ref}`,
            account_id: this.principal.accountId,
            agent_object_id: this.principal.agentObjectId,
            tool_name: name,
            arguments: args,
        });
    }

    async listActions(): Promise<unknown> {
        return this.context();
    }

    async callPlatformTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
        const worker = this.principal.workerRun;
        if (worker && name.startsWith("automation_")) throw new McpRuntimeError("CAPABILITY_DENIED", "Durable work credentials cannot manage automation jobs or delegate records.");
        if (worker) {
            const canFinishInFlightWork = new Set([
                "work_run_get", "work_run_list_operations", "work_run_settle_operation",
                "work_run_append_action_receipt", "work_run_append_task_artifact",
                "work_run_renew_turn", "work_run_checkpoint", "work_run_finish_turn",
                "work_run_revoke_worker_credential",
            ]).has(name);
            const context = await serviceJson(this.config, this.config.memoryServerUrl, "POST", "/internal/mcp/work-worker-context", undefined, {
                "x-work-run-credential": worker.credential,
            }) as { cancelRequestedAt?: unknown };
            if (context.cancelRequestedAt && !canFinishInFlightWork) {
                throw new McpRuntimeError("CAPABILITY_DENIED", "The owner requested cancellation; no new work or action may start.");
            }
        }
        if (name === "agent_get_context") {
            const context=await this.context();
            if(this.principal.workerRun&&context&&typeof context==="object"){
                const publicContext={...(context as Record<string,unknown>)};
                delete publicContext.parentCapabilities;
                delete publicContext.parentPermittedRegistryActions;
                return publicContext;
            }
            return context;
        }
        if (name === "mydata_check_current_access") {
            if (worker || !this.principal.myDataSession) throw new McpRuntimeError("CAPABILITY_DENIED", "An interactive authenticated MyData session is required for this access check.");
            const request = args.request;
            if (!request || typeof request !== "object" || Array.isArray(request)) throw new McpRuntimeError("INVALID_ARGUMENT", "A named MyData listing version is required.");
            const result = await serviceJson(this.config, this.config.memoryServerUrl, "POST", "/internal/mcp/mydata-current-access", {
                accountId: this.principal.accountId,
                agentObjectId: this.principal.agentObjectId,
                request,
            }, { "x-mydata-session": this.principal.myDataSession });
            return sanitizeMyDataCurrentAccess(result, args, { accountId: this.principal.accountId, agentId: this.principal.agentObjectId });
        }
        if (name === "ai_chat" && this.principal.workerRun) {
            const request = args.request;
            if (!request || typeof request !== "object" || Array.isArray(request)) throw new McpRuntimeError("INVALID_ARGUMENT", "A structured AI request is required.");
            return serviceJson(this.config, this.config.memoryServerUrl, "POST", "/internal/mcp/work-inference", { request }, {
                "x-work-run-credential": this.principal.workerRun.credential,
            });
        }
        if (name === "mydata_search_graph" || name === "mydata_get_graph_item") {
            const worker = this.principal.workerRun;
            const request = args.request;
            if (!worker || !worker.allowPrivateGraph || !this.principal.myDataSession
                || (worker.workerCapabilities & CAP_MYDATA_READ) !== CAP_MYDATA_READ
                || !request || typeof request !== "object" || Array.isArray(request)) {
                throw new McpRuntimeError("CAPABILITY_DENIED", "This run has no consented, currently authorized private-graph read.");
            }
            const headers = { "x-work-run-credential": worker.credential, "x-mydata-session": this.principal.myDataSession };
            const readPage = (page: object) => serviceJson(this.config, this.config.memoryServerUrl, "POST", "/internal/mcp/work-graph-content", {
                accountId: this.principal.accountId, workerAgentId: worker.workerAgentObjectId, request: page,
            }, headers);
            const verifyAuthority = async (sellerAddress: string, proof: { organizationId: string }) => {
                const result = await serviceJson(this.config, this.config.memoryServerUrl, "POST", "/internal/mcp/work-graph-seller", {
                    accountId: this.principal.accountId, workerAgentId: worker.workerAgentObjectId,
                    request: { organizationId: proof.organizationId, sellerAddress },
                }, headers) as { authorized?: unknown };
                return result.authorized === true;
            };
            return name === "mydata_search_graph"
                ? searchMyDataGraph(readPage as never, request as never, undefined, verifyAuthority as never)
                : getMyDataGraphItem(readPage as never, request as never, undefined, verifyAuthority as never);
        }
        if (ROOM_MCP_TOOLS.includes(name)) {
            const worker = this.principal.workerRun;
            if (!this.config.messagingRelayerUrl) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "Room messaging is not configured.");
            if (worker) {
                const request = args.request;
                if ((name !== "messaging_get_room_history" && name !== "messaging_get_room_attachment") || !worker.allowRoomHistory || !request || typeof request !== "object" || Array.isArray(request)) {
                    throw new McpRuntimeError("CAPABILITY_DENIED", "This work run has not been approved to read encrypted room history.");
                }
                return serviceJson(this.config, this.config.bridgeUrl, "POST", "/internal/work/room-history", {
                    key_ref: `delegate:${worker.delegateRef}`,
                    account_id: this.principal.accountId,
                    parent_agent_id: this.principal.agentObjectId,
                    worker_agent_id: worker.workerAgentObjectId,
                    run_id: worker.runId,
                    credential: worker.credential,
                    tool_name: name,
                    request,
                });
            }
            return this.callRoomTool(name, normalizeRoomToolArguments(name, args));
        }
        if (name === "task_get_deliverable" && worker) {
            const taskId=args.id;
            if(!worker.allowPrivateTaskArtifacts||!worker.taskId||typeof taskId!=="string"||normalizeHostedId(taskId)!==normalizeHostedId(worker.taskId)){
                throw new McpRuntimeError("CAPABILITY_DENIED","This work run may read only its explicitly approved linked-task artifact.");
            }
            const result=await serviceJson(this.config,this.config.memoryServerUrl,"POST","/internal/mcp/work-task-artifact",{taskId:worker.taskId},{"x-work-run-credential":worker.credential});
            return sanitizeTaskDeliverableRead(result,args);
        }
        if (name.startsWith("work_run_")) {
            if (!this.principal.myDataSession) throw new McpRuntimeError("CAPABILITY_DENIED", "A short-lived MyData custody session is required for work journal access.");
            const result = await serviceJson(this.config, this.config.memoryServerUrl, "POST", "/internal/mcp/work-journal", {
                accountId: this.principal.accountId,
                agentObjectId: this.principal.agentObjectId,
                ...(this.principal.workerRun ? { workerAgentObjectId: this.principal.workerRun.workerAgentObjectId } : {}),
                operation: name,
                params: args,
            }, {
                "x-mydata-session": this.principal.myDataSession,
                ...(this.principal.workerRun ? { "x-work-run-credential": this.principal.workerRun.credential } : {}),
            });
            return sanitizeWorkJournalRead(name, result, args);
        }
        const definition = PLATFORM_TOOL_BY_NAME.get(name);
        if (definition && name.startsWith("automation_")) {
            const response = await serviceJson(this.config, this.config.memoryServerUrl, "POST", "/internal/mcp/automation-tool", {
                accountId: this.principal.accountId,
                agentObjectId: this.principal.agentObjectId,
                toolName: name,
                arguments: args,
            });
            return sanitizeAutomationRead(name, response, args, {
                accountId: this.principal.accountId,
                agentObjectId: this.principal.agentObjectId,
            });
        }
        if (name === "ai_list_models" && definition?.method === "GET" && definition.path === "/api/models") {
            if (this.principal.workerRun) {
                return serviceJson(this.config, this.config.memoryServerUrl, "POST", "/internal/mcp/work-models", {}, {
                    "x-work-run-credential": this.principal.workerRun.credential,
                });
            }
            return serviceJson(this.config, this.config.memoryServerUrl, "GET", definition.path);
        }
        if (definition?.method === "GET" && definition.path.startsWith("/api/agent/read/")) {
            const resource = definition.path.slice("/api/agent/read/".length);
            if (!resource || resource.includes("/")) return refuse();
            const query: Record<string, unknown> = {};
            for (const key of definition.queryKeys ?? []) if (args[key] !== undefined) query[key] = args[key];
            const result = await serviceJson(this.config, this.config.memoryServerUrl, "POST", "/internal/mcp/platform-read", {
                account_id: this.principal.accountId,
                agent_object_id: this.principal.agentObjectId,
                resource,
                query,
            });
            let checked = result;
            if (name.startsWith("config_")) checked = sanitizeConfigRead(name, checked);
            if (name.startsWith("badge_")) checked = sanitizeBadgeRead(name, checked, args);
            if (name.startsWith("promotion_")) checked = sanitizePromotionRead(name, checked, args);
            if (name.startsWith("social_")) checked = sanitizeSocialRead(name, checked, args, definition.scope);
            if (isMessagingReadName(name)) {
                let owner: string | undefined;
                if (["messaging_list_my_wallet_history", "messaging_list_my_paid_message_history", "messaging_get_my_revenue_summary", "room_list"].includes(name)) {
                    const context = await this.context() as { owner?: unknown };
                    if (typeof context.owner !== "string") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The authenticated owner context is unavailable for messaging evidence.");
                    owner = context.owner;
                }
                checked = sanitizeMessagingRead(name, checked, args, owner);
            }
            if (name === "task_get_receipt") checked = sanitizeTaskReceipt(checked, args);
            if (name === "task_get_settlement_receipt") checked = sanitizeTaskSettlementReceipt(checked, args);
            if (name === "jury_get_action_receipt") checked = sanitizeJuryReceipt(checked, args);
            if (["jury_list_assignments", "jury_list_roster"].includes(name)) {
                const context = await this.context() as { owner?: unknown };
                checked = sanitizeJuryListRead(name, checked, args, {
                    owner: typeof context.owner === "string" ? context.owner : undefined,
                    agentId: this.principal.agentObjectId,
                });
            }
            if (name === "jury_health") checked = sanitizeJuryHealth(checked, args);
            if (name === "jury_get_case_bundle") checked = sanitizeJuryCaseBundle(checked, args);
            if (["jury_list_cases", "jury_get_case"].includes(name)) checked = sanitizeJuryCasesRead(name, checked, args);
            if (name === "jury_get_own_profile") checked = sanitizeJuryOwnProfile(checked, this.principal.agentObjectId);
            if (name === "jury_list_case_rationales") checked = sanitizeJuryRationales(checked, args);
            if (name === "jury_list_cranks") checked = sanitizeJuryCranks(checked, args);
            if (name === "jury_get_task_dispute") checked = sanitizeJuryTaskDispute(checked, args);
            if (["jury_get_proposal_case", "jury_get_proposal_vote_refunds"].includes(name)) checked = sanitizeProposalJuryRead(name, checked, args);
            if (name === "agent_get_reputation") checked = sanitizeAgentReputation(checked, this.principal.agentObjectId);
            if (name === "agent_get_own_pnl") checked = sanitizeAgentOwnPnl(checked, this.principal.accountId, this.principal.agentObjectId, args);
            if (name === "agent_list_owned_pnl") checked = sanitizeAgentOwnedPnl(checked, this.principal.accountId, args);
            if (name === "account_list_audit_logs") {
                const context = await this.context() as { owner?: unknown };
                if (typeof context.owner !== "string") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The authenticated agent context has no owner identity for audit-log correlation.");
                checked = sanitizeAccountAuditLogs(checked, context.owner, args);
            }
            if (name.startsWith("poc_")) {
                const context = await this.context() as { owner?: unknown; network?: unknown; packageId?: unknown; socialChain?: { packageId?: unknown } };
                checked = sanitizePocRead(name, checked, args,
                    typeof context.owner === "string" ? context.owner : undefined,
                    typeof context.network === "string" ? context.network : undefined,
                    typeof context.socialChain?.packageId === "string" ? context.socialChain.packageId : typeof context.packageId === "string" ? context.packageId : undefined);
            }
            if (name === "task_market_get_seller_reputation") checked = sanitizeAgentReputation(checked, String(args.id));
            if (name === "agent_list_children") checked = sanitizeAgentChildren(checked, args, this.principal.agentObjectId);
            if (name === "agent_list_profile_agents") checked = sanitizeProfileAgents(checked, args);
            if (name === "agent_list_receipts") checked = sanitizeAgentReceipts(checked, args, this.principal.agentObjectId);
            if (name === "dex_get_swap_receipt") checked = sanitizeDexSwapReceipt(checked, args);
            if (name === "chain_list_action_approvals") {
                const context = await this.context() as { owner?: unknown };
                if (typeof context.owner !== "string") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The authenticated owner context is unavailable for wallet approvals.");
                checked = sanitizeActionApprovals(checked, args, { ...this.principal, ownerAddress: context.owner });
            }
            if (name === "chain_find_action_by_idempotency_key") checked = sanitizeActionByIdempotencyKey(checked, args, this.principal);
            if (name === "chain_get_action_receipt") checked = sanitizeActionReceipt(checked, args, this.principal);
            if (["governance_get_vote_quote", "governance_get_vote_receipt", "governance_get_delegate_vote_receipt"].includes(name)) checked = sanitizeGovernanceRead(name, checked, args);
            if (name === "dex_list_markets") checked = sanitizeDexMarkets(checked);
            if (name === "dex_get_market") checked = sanitizeDexMarket(checked, args);
            if (name === "dex_get_orderbook") checked = sanitizeDexOrderbook(checked, args);
            if (name === "dex_get_summary") checked = sanitizeDexSummary(checked, args);
            if (name === "dex_get_ticker") checked = sanitizeDexTicker(checked, args);
            if (name === "dex_list_trades") checked = sanitizeDexTrades(checked, args);
            if (name === "dex_get_indexer_status") checked = sanitizeDexStatus(checked);
            if (["task_list", "task_list_for_agent", "task_list_for_organization", "task_market_list", "task_market_list_sellers", "task_market_get_stats", "task_get_config"].includes(name)) {
                if (["task_list", "task_list_for_agent", "task_list_for_organization"].includes(name)) {
                    const context = await this.context() as { owner?: unknown; agentObjectId?: unknown; organizationId?: unknown };
                    checked = sanitizeTaskMarketRead(name, checked, args, {
                        owner: typeof context.owner === "string" ? context.owner : undefined,
                        agentObjectId: typeof context.agentObjectId === "string" ? context.agentObjectId : undefined,
                        organizationId: typeof context.organizationId === "string" ? context.organizationId : null,
                    });
                } else checked = sanitizeTaskMarketRead(name, checked, args);
            }
            if (name === "task_get_room") checked = sanitizeTaskRoomRead(checked, args);
            if (name === "task_get") checked = sanitizeTaskDetailRead(checked, args);
            if (name === "task_get_deliverable") checked = sanitizeTaskDeliverableRead(checked, args);
            if (name === "task_get_dispute") checked = sanitizeTaskDisputeRead(checked, args);
            if (["assets_get_owned_object", "assets_list_owned_objects", "assets_get_transfer_receipt", "assets_get_burn_receipt"].includes(name)) {
                const context = await this.context() as { owner?: unknown };
                if (typeof context.owner !== "string") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The authenticated owner context is unavailable for asset evidence.");
                if (name === "assets_get_owned_object") checked = sanitizeOwnedObject(checked, args, context.owner);
                else if (name === "assets_list_owned_objects") checked = sanitizeOwnedObjects(checked, args, context.owner);
                else checked = sanitizeAssetReceipt(name, checked, args, context.owner);
            }
            if (["organization_get_treasury_balance", "organization_get_treasury_access"].includes(name)) checked = sanitizeOrganizationTreasuryRead(name, checked, args);
            if (["task_list_agent_funding_coins", "mydata_list_agent_funding_coins"].includes(name)) checked = sanitizeAgentFundingCoins(name, checked, args);
            if (name === "mydata_get_purchase_quote") {
                const context = await this.context() as { derivedAddress?: unknown };
                if (typeof context.derivedAddress !== "string") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The authenticated buyer address is unavailable.");
                checked = sanitizeMyDataPurchaseQuote(checked, args, { agentAddress: context.derivedAddress });
            }
            if (name === "mydata_get_purchase_receipt") {
                const context = await this.context() as { owner?: unknown; derivedAddress?: unknown };
                if (typeof context.owner !== "string" || typeof context.derivedAddress !== "string") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The authenticated purchase identity is unavailable.");
                checked = sanitizeMyDataPurchaseReceipt(checked, args, {
                    accountId: this.principal.accountId,
                    agentObjectId: this.principal.agentObjectId,
                    ownerAddress: context.owner,
                    agentAddress: context.derivedAddress,
                });
            }
            if (name === "mydata_get_owner_access_receipt" || name === "mydata_list_owner_access_history") {
                const context = await this.context() as { owner?: unknown; derivedAddress?: unknown };
                if (typeof context.owner !== "string" || typeof context.derivedAddress !== "string") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The authenticated owner-access identity is unavailable.");
                const identity = {
                    accountId: this.principal.accountId,
                    agentObjectId: this.principal.agentObjectId,
                    ownerAddress: context.owner,
                    agentAddress: context.derivedAddress,
                };
                checked = name === "mydata_get_owner_access_receipt"
                    ? sanitizeMyDataOwnerAccessReceipt(checked, args, identity)
                    : sanitizeMyDataOwnerAccessHistory(checked, args, identity);
            }
            if (["mydata_list_listings", "mydata_list_owned_listings"].includes(name)) {
                let expectedOwner: string | undefined;
                if (name === "mydata_list_owned_listings") {
                    const context = await this.context() as { owner?: unknown };
                    if (typeof context.owner !== "string") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The authenticated owner context is unavailable for MyData listings.");
                    expectedOwner = context.owner;
                }
                checked = sanitizeMyDataListingPage(checked, args, expectedOwner);
            }
            if (name === "mydata_check_indexed_access") checked = sanitizeMyDataIndexedAccess(checked, args);
            if (name === "mydata_get_indexed_listing") checked = sanitizeMyDataIndexedListing(checked, args);
            if (name === "mydata_get_indexed_stats") checked = sanitizeMyDataIndexedStats(checked, args);
            if (["mydata_get_indexed_configuration", "mydata_get_indexed_revenue_timeline", "mydata_get_indexed_access_analytics"].includes(name)) checked = sanitizeMyDataAnalyticsRead(name, checked);
            if (["mydata_get_snapshot_anchor", "mydata_get_snapshot_distribution", "mydata_get_snapshot_merkle_root", "mydata_get_snapshot_escrow", "mydata_list_snapshot_claims"].includes(name)) checked = sanitizeMyDataSnapshotRead(name, checked, args);
            if (["mydata_read_indexed_catalog", "mydata_list_popular_indexed", "mydata_list_creator_listings", "mydata_list_broad_pools", "mydata_list_broad_pool_sub_pools", "mydata_list_listing_sub_pools", "mydata_list_sub_pool_listings"].includes(name)) checked = sanitizeMyDataMarketCatalogRead(name, checked, args);
            if (name === "mydata_list_distribution_rounds") checked = sanitizeMyDataSnapshotRead(name, checked, args);
            if (["mydata_list_indexed_access_logs", "mydata_list_indexed_purchases", "mydata_list_indexed_revenue", "mydata_list_indexed_subscriptions"].includes(name)) checked = sanitizeMyDataHistoryRead(name, checked, args);
            if (name === "mydata_list_my_purchases") {
                const context = await this.context() as { owner?: unknown; derivedAddress?: unknown };
                if (typeof context.owner !== "string" || typeof context.derivedAddress !== "string") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The authenticated MyData buyer context is unavailable.");
                checked = sanitizeMyDataHistoryRead(name, checked, args, { ownerAddress: context.owner, agentAddress: context.derivedAddress });
            }
            if (["spot_get_bet_receipt", "spot_get_claim_receipt", "spot_get_market_receipt"].includes(name)) checked = sanitizeSpotReceiptRead(name, checked, args);
            if (["spt_get_configuration", "spt_get_pool", "spt_get_pool_by_associated_id", "spt_get_reservation_pool", "spt_get_user_holdings", "spt_list_pool_holdings", "spt_list_pool_price_history", "spt_list_pool_revenue", "spt_list_pool_swaps", "spt_list_pool_transactions", "spt_list_pool_transfers", "spt_list_pools", "spt_list_popular_pools", "spt_list_reservation_pools", "spt_list_reservations", "spt_get_reservation_volume_history", "spt_list_user_reservations", "spt_get_market_sentiment", "spt_get_pool_liquidity_profile", "spt_get_portfolio_performance", "spt_get_position_metrics", "spt_get_position_timeseries", "spt_get_top_performers", "spt_list_creator_revenue_streams", "spt_list_trader_leaderboard", "spt_get_trade_quote", "spt_get_trade_receipt"].includes(name)) checked = sanitizeSptRead(name, checked, args);
            if (["task_list_history", "task_get_lifecycle_history"].includes(name)) checked = sanitizeTaskHistoryRead(name, checked, args);
            if (["agent_admin_owner_rotation_manifest", "agent_admin_owner_rotation_status", "agent_admin_owner_rotation_progress", "agent_admin_owner_rotation_receipt"].includes(name)) checked = sanitizeOwnerRotationRead(name, checked, args, { accountId: this.principal.accountId });
            if (name.startsWith("organization_list_") && ["organization_list_messaging_groups", "organization_list_roles", "organization_list_role_assignments", "organization_list_invitations", "organization_list_memory_permissions", "organization_list_spend_approvals", "organization_list_spend_breakdown", "organization_list_audit_logs"].includes(name)) {
                const context = await this.context() as { organizationId?: unknown };
                checked = sanitizeOrganizationRead(name, checked, args, {
                    organizationId: typeof context.organizationId === "string" ? context.organizationId : null,
                });
            }
            if (["organization_get", "organization_get_statistics", "organization_list_categories", "organization_list_leaderboard", "organization_list_my_invitations", "organization_list_owned", "organization_list_rooms"].includes(name)) {
                const context = await this.context() as { owner?: unknown; organizationId?: unknown; derivedAddress?: unknown };
                checked = sanitizeOrganizationPublicRead(name, checked, args, {
                    owner: typeof context.owner === "string" ? context.owner : undefined,
                    organizationId: typeof context.organizationId === "string" ? context.organizationId : null,
                    derivedAddress: typeof context.derivedAddress === "string" ? context.derivedAddress : undefined,
                });
            }
            if (name === "account_get_memory_usage") checked = sanitizeAccountMemoryUsage(checked, this.principal.accountId);
            if (["ai_get_balance", "ai_list_approvals", "ai_list_usage", "ai_list_reservations", "ai_get_reservation"].includes(name)) {
                const context = await this.context() as { owner?: unknown };
                if (typeof context.owner !== "string") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The authenticated AI-credit owner context is unavailable.");
                checked = sanitizeAiCreditRead(name, checked, args, context.owner);
            }
            if (name === "mydata_list_graph_offers") checked = sanitizeGraphOfferPage(checked, args);
            let paymentOwner: string | undefined;
            if (name.startsWith("payments_")) {
                const context = await this.context() as { owner?: unknown };
                if (typeof context.owner !== "string") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The authenticated agent context has no owner identity for payment correlation.");
                paymentOwner = context.owner;
            }
            return validateAgentAdminRead(name, args, validateSubscriptionRead(name, args, validatePaymentRead(name, args, checked, this.principal, paymentOwner), this.principal), this.principal);
        }
        return refuse();
    }

    async executeAction(action: string, parameters: unknown, idempotencyKey: string): Promise<unknown> {
        const descriptor = PRODUCTION_ACTION_CATALOG.find((item) => item.id === action);
        const context = await this.context() as { approvalRequiredCapabilities?: unknown };
        const required = descriptor?.requiredCapability;
        const approvalMask = typeof context.approvalRequiredCapabilities === "number" && Number.isSafeInteger(context.approvalRequiredCapabilities)
            ? context.approvalRequiredCapabilities : 0;
        const policyRequiresOwner = !!descriptor && (
            descriptor.approval !== "agent-capability" || descriptor.tier !== "1"
            || (required !== null && required !== undefined && (approvalMask & required) === required)
        );
        if (policyRequiresOwner && action !== "access.purchase_mydata_access.v1") {
            return this.requestActionApproval({ registryAction: action as never, parameters: parameters as Record<string, unknown>, idempotencyKey });
        }
        const keyRef = await delegateKeyRef(this.config, this.principal, action);
        try {
            return await serviceJson(this.config, this.config.bridgeUrl, "POST", "/internal/chain/act", {
                key_ref: keyRef,
                account_id: this.principal.accountId,
                action_id: action,
                params: parameters,
                idempotency_key: idempotencyKey,
            });
        } catch (error) {
            if (error instanceof McpRuntimeError && error.approvalRequired) {
                return this.requestActionApproval({ registryAction: action as never, parameters: parameters as Record<string, unknown>, idempotencyKey });
            }
            throw error;
        }
    }

    private async runRegisteredAction(actionId: string, input: object): Promise<unknown> {
        const values = input as Record<string, unknown>;
        const idempotencyKey = values.idempotencyKey;
        if (typeof idempotencyKey !== "string") throw new McpRuntimeError("INVALID_ARGUMENT", "An idempotency key is required for this action.");
        const { idempotencyKey: _key, ...parameters } = values;
        const keyRef = await delegateKeyRef(this.config, this.principal, actionId);
        return serviceJson(this.config, this.config.bridgeUrl, "POST", "/internal/chain/act", {
            key_ref: keyRef, account_id: this.principal.accountId, action_id: actionId,
            params: parameters, idempotency_key: idempotencyKey,
        });
    }

    createPost(input: CreatePostInput): Promise<unknown> { return this.runRegisteredAction("social.create_post.v1", input); }
    createComment(input: CreateCommentInput): Promise<unknown> { return this.runRegisteredAction("social.create_comment.v1", input); }
    reactToPost(input: ReactToPostInput): Promise<unknown> { return this.runRegisteredAction("social.react_to_post.v1", input); }
    reactToComment(input: ReactToCommentInput): Promise<unknown> { return this.runRegisteredAction("social.react_to_comment.v1", input); }
    createRepost(input: CreateRepostInput): Promise<unknown> { return this.runRegisteredAction("social.create_repost.v1", input); }
    removePostReaction(input: Parameters<SocialGateway["removePostReaction"]>[0]): Promise<unknown> { return this.runRegisteredAction("social.remove_post_reaction.v1", input); }
    removeCommentReaction(input: Parameters<SocialGateway["removeCommentReaction"]>[0]): Promise<unknown> { return this.runRegisteredAction("social.remove_comment_reaction.v1", input); }
    editPost(input: Parameters<SocialGateway["editPost"]>[0]): Promise<unknown> { return this.runRegisteredAction("social.edit_post.v1", input); }
    editComment(input: Parameters<SocialGateway["editComment"]>[0]): Promise<unknown> { return this.runRegisteredAction("social.edit_comment.v1", input); }
    removeRepost(input: Parameters<SocialGateway["removeRepost"]>[0]): Promise<unknown> { return this.runRegisteredAction("social.remove_repost.v1", input); }
    followProfile(input: Parameters<SocialGateway["followProfile"]>[0]): Promise<unknown> { return this.runRegisteredAction("social.follow_profile.v1", input); }
    unfollowProfile(input: Parameters<SocialGateway["unfollowProfile"]>[0]): Promise<unknown> { return this.runRegisteredAction("social.unfollow_profile.v1", input); }
    blockProfile(input: Parameters<SocialGateway["blockProfile"]>[0]): Promise<unknown> { return this.runRegisteredAction("social.block_profile.v1", input); }
    unblockProfile(input: Parameters<SocialGateway["unblockProfile"]>[0]): Promise<unknown> { return this.runRegisteredAction("social.unblock_profile.v1", input); }
    sendMessage(input: Parameters<SocialGateway["sendMessage"]>[0]): Promise<unknown> { return this.runRegisteredAction("messaging.send_message.v1", input); }
    createMessagingGroup(input: Parameters<SocialGateway["createMessagingGroup"]>[0]): Promise<unknown> { return this.runRegisteredAction("messaging.create_group.v1", input); }
    bindAgentRoomToTask(input: Parameters<SocialGateway["bindAgentRoomToTask"]>[0]): Promise<unknown> { return this.runRegisteredAction("messaging.bind_room_to_task.v1", input); }
    acceptOrganizationInvitation(input: Parameters<SocialGateway["acceptOrganizationInvitation"]>[0]): Promise<unknown> { return this.runRegisteredAction("organization.accept_invitation.v1", input); }
    declineOrganizationInvitation(input: Parameters<SocialGateway["declineOrganizationInvitation"]>[0]): Promise<unknown> { return this.runRegisteredAction("organization.decline_invitation.v1", input); }
    registerChildAgent(input: Parameters<SocialGateway["registerChildAgent"]>[0]): Promise<unknown> { return this.runRegisteredAction("agent.register_child.v1", { ...input, parentAgentObjectId: input.parentAgentObjectId ?? this.principal.agentObjectId }); }
    updateChildAgent(input: Parameters<SocialGateway["updateChildAgent"]>[0]): Promise<unknown> { return this.runRegisteredAction("agent.update_child.v1", input); }
    deactivateChildAgent(input: Parameters<SocialGateway["deactivateChildAgent"]>[0]): Promise<unknown> { return this.runRegisteredAction("agent.deactivate_child.v1", input); }
    revokeChildAgent(input: Parameters<SocialGateway["revokeChildAgent"]>[0]): Promise<unknown> { return this.runRegisteredAction("agent.revoke_child.v1", input); }
    getOrganizationControl(): Promise<unknown> { return refuse(); }
    getActionStatus(): Promise<unknown> { return refuse(); }
    requestActionApproval(input: Parameters<SocialGateway["requestActionApproval"]>[0]): Promise<unknown> {
        return serviceJson(this.config, this.config.memoryServerUrl, "POST", "/internal/mcp/action-approval/request", {
            account_id: this.principal.accountId, agent_object_id: this.principal.agentObjectId,
            request: {
                registryAction: input.registryAction, registryVersion: SOCIAL_ACTION_REGISTRY_VERSION, idempotencyKey: input.idempotencyKey,
                parameters: input.parameters, expiresInSeconds: input.expiresInSeconds, signerAddress: input.signerAddress,
            },
        });
    }
    approveAction(input: Parameters<SocialGateway["approveAction"]>[0]): Promise<unknown> {
        return serviceJson(this.config, this.config.memoryServerUrl, "POST", `/api/chain/approvals/${encodeURIComponent(input.approvalId)}/approve`, { walletSignature: input.walletSignature });
    }
    prepareApprovedAction(input: Parameters<SocialGateway["prepareApprovedAction"]>[0]): Promise<unknown> {
        return serviceJson(this.config, this.config.memoryServerUrl, "POST", "/internal/mcp/action-approval/prepare", {
            account_id: this.principal.accountId, agent_object_id: this.principal.agentObjectId,
            request: {
                registryAction: input.registryAction, registryVersion: SOCIAL_ACTION_REGISTRY_VERSION, idempotencyKey: input.idempotencyKey,
                parameters: input.parameters, approvalId: input.approvalId,
            },
        });
    }
    submitApprovedAction(input: Parameters<SocialGateway["submitApprovedAction"]>[0]): Promise<unknown> {
        return serviceJson(this.config, this.config.memoryServerUrl, "POST", "/internal/mcp/action-approval/submit", {
            account_id: this.principal.accountId, agent_object_id: this.principal.agentObjectId,
            request: {
                registryAction: input.registryAction, registryVersion: SOCIAL_ACTION_REGISTRY_VERSION, idempotencyKey: input.idempotencyKey,
                approvalId: input.approvalId, digest: input.digest, signature: input.walletSignature,
            },
        });
    }
}

async function delegateKeyRef(config: HostedMcpEnvConfig, principal: HostedMcpPrincipal, actionId?: string): Promise<string> {
    const expectedClass = actionId === undefined ? "memory" : delegateClassForAction(actionId);
    const delegates = await listDelegateRows(config, principal);
    const ref = delegates.find((item) => item.delegate_class === expectedClass
        && typeof item.delegate_ref === "string" && item.delegate_ref.trim()
        && typeof item.agent_object_id === "string" && normalizeHostedId(item.agent_object_id) === normalizeHostedId(principal.agentObjectId)
        && (actionId === undefined ? Array.isArray(item.allowed_action_ids) && item.allowed_action_ids.length === 0
            : Array.isArray(item.allowed_action_ids) && item.allowed_action_ids.includes(actionId)))?.delegate_ref;
    if (typeof ref !== "string") throw new McpRuntimeError("CAPABILITY_DENIED", "No registered delegate can sign this action.");
    return `delegate:${ref}`;
}

type HostedDelegateRow = { delegate_ref?: unknown; agent_object_id?: unknown; delegate_class?: unknown; allowed_action_ids?: unknown };

function normalizeHostedId(value: string): string {
    return value.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function delegateClassForAction(actionId: string): "task_worker" | "juror" | "action_worker" {
    return actionId.startsWith("task.") ? "task_worker"
        : ["jury.accept.v1", "jury.commit_vote.v1", "jury.reveal_vote.v1", "jury.claim_fee.v1"].includes(actionId) ? "juror"
            : "action_worker";
}

async function listDelegateRows(config: HostedMcpEnvConfig, principal: HostedMcpPrincipal): Promise<HostedDelegateRow[]> {
    let cursor: string | undefined;
    const rows: HostedDelegateRow[] = [];
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
        const query = new URLSearchParams({ account_id: principal.accountId, expected_agent_object_id: principal.agentObjectId, limit: "200", ...(cursor ? { cursor } : {}) });
        const page = await serviceJson(config, config.engineUrl, "GET", `/v1/automation/delegates?${query}`) as {
            data?: HostedDelegateRow[];
            has_next_page?: unknown;
            next_cursor?: unknown;
        };
        if (!Array.isArray(page.data) || page.data.length > 200) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The delegate catalog returned an invalid page.");
        rows.push(...page.data);
        if (page.has_next_page !== true) return rows;
        if (typeof page.next_cursor !== "string" || !page.next_cursor || page.next_cursor === cursor) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The delegate catalog cursor did not advance.");
        cursor = page.next_cursor;
    }
    throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The delegate catalog exceeds its bounded page limit.");
}

function readObject(value: unknown, label: string, fields: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned an invalid object.`);
    const object = value as Record<string, unknown>;
    if (Object.keys(object).length !== fields.length || fields.some((field) => !(field in object))) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned an unexpected field set.`);
    return object;
}
function readAddress(value: unknown, label: string): string {
    if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned an invalid address.`);
    return value;
}
function readU64(value: unknown, label: string): string {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > 18_446_744_073_709_551_615n) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned an invalid decimal u64.`);
    return value;
}
function readCoinType(value: unknown, label: string): string {
    if (typeof value !== "string" || value.length < 1 || value.length > 512 || value !== value.trim()) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned an invalid coin type.`);
    return value;
}
function readDigest(value: unknown, label: string): string {
    if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `The ${label} read returned an invalid transaction digest.`);
    return value;
}
function validatePaymentRead(name: string, args: Record<string, unknown>, value: unknown, principal: HostedMcpPrincipal, owner?: string): unknown {
    return sanitizePaymentRead(name, args, value, { accountId: principal.accountId, agentObjectId: principal.agentObjectId, owner });
}

function validateSubscriptionRead(name: string, args: Record<string, unknown>, value: unknown, principal: HostedMcpPrincipal): unknown {
    return sanitizeSubscriptionRead(name, args, value, { accountId: principal.accountId, agentObjectId: principal.agentObjectId });
}

function validateAgentAdminRead(name: string, args: Record<string, unknown>, value: unknown, principal: HostedMcpPrincipal): unknown {
    return sanitizeAgentAdminRead(name, args, value, { accountId: principal.accountId });
}

async function serviceJson(config: HostedMcpEnvConfig, origin: string, method: "GET" | "POST", path: string, body?: object, extraHeaders: Record<string, string> = {}): Promise<unknown> {
    const fetchImpl = config.fetch ?? fetch;
    let response: Response;
    try {
        response = await fetchImpl(`${origin}${path}`, {
            method,
            headers: {
                "x-internal-sync-secret": config.internalSyncSecret,
                ...extraHeaders,
                ...(body ? { "content-type": "application/json" } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
            redirect: "error",
        });
    } catch (error) {
        throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The memory service is unavailable.", { retryable: true, cause: error });
    }
    const payload = await response.json().catch(() => ({})) as { error?: unknown; code?: unknown };
    if (!response.ok) {
        const message = typeof payload.error === "string" ? payload.error : `The service returned ${response.status}`;
        if (payload.code === "approval_required") {
            throw new McpRuntimeError("CAPABILITY_DENIED", message, { approvalRequired: true });
        }
        if (response.status === 401 || response.status === 403) throw new McpRuntimeError("CAPABILITY_DENIED", message);
        if (response.status === 404) throw new McpRuntimeError("NOT_FOUND", message);
        throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", message, { retryable: response.status >= 500 });
    }
    return payload;
}

export function createHostedDependencies(config: HostedMcpEnvConfig, principal: HostedMcpPrincipal): ToolDependencies {
    const memory = new HostedPrincipalClient(config, principal);
    const social = new BridgeBoundGateway(config, principal, () => memory.getAgentContext());
    return { memory, social };
}

function loginVerifier(config: HostedMcpEnvConfig) {
    if (config.introspectionUrl && config.oauthClientId && config.oauthClientSecret) {
        return new OAuthIntrospectionVerifier({
            introspectionUrl: config.introspectionUrl,
            clientId: config.oauthClientId,
            clientSecret: config.oauthClientSecret,
            resourceUrl: config.resourceUrl,
            ...(config.fetch ? { fetch: config.fetch } : {}),
        });
    }
    return { async verifyAccessToken(): Promise<never> { throw new McpRuntimeError("AUTHENTICATION_FAILED", "OAuth introspection is not configured."); } };
}

export function createConfiguredHostedServer(config: HostedMcpEnvConfig): Server {
    return createHostedMcpHttpServer({
        verifier: loginVerifier(config),
        async resolveWalletPrincipal(walletAddress, boundAgentId) {
            try {
                const raw = await serviceJson(config, config.memoryServerUrl, "POST", "/internal/mcp/wallet-root", {
                    walletAddress,
                    ...(boundAgentId ? { agentObjectId: boundAgentId } : {}),
                });
                if (!raw || typeof raw !== "object") return null;
                const value = raw as Record<string, unknown>;
                if (typeof value.accountId !== "string" || typeof value.agentObjectId !== "string" || typeof value.signerSessionId !== "string") return null;
                return { accountId: value.accountId, agentObjectId: value.agentObjectId, signerSessionId: value.signerSessionId };
            } catch {
                return null;
            }
        },
        resourceUrl: config.resourceUrl,
        authorizationServerUrl: config.authorizationServerUrl,
        allowedHosts: config.allowedHosts,
        allowedOrigins: config.allowedOrigins,
        ...(config.messagingRelayerUrl ? { messagingRelayerUrl: config.messagingRelayerUrl } : {}),
        async authenticateWorkerRequest(request, credential) {
            const myDataSession = request.headers["x-mydata-session"];
            if (typeof myDataSession !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(myDataSession) || myDataSession.length > 32_768) {
                throw new McpRuntimeError("AUTHENTICATION_FAILED", "A bounded action-worker MyData session is required.");
            }
            const raw = await serviceJson(config, config.memoryServerUrl, "POST", "/internal/mcp/work-worker-context", undefined, {
                "x-work-run-credential": credential,
            });
            if (!raw || typeof raw !== "object") throw new McpRuntimeError("AUTHENTICATION_FAILED", "The work-run identity is invalid.");
            const context = raw as Record<string, unknown>;
            const required = ["runId", "accountId", "parentAgentId", "delegateRef", "workerAgentId", "expiresAt"];
            if (required.some((key) => typeof context[key] !== "string" || !(context[key] as string).trim())
                || typeof context.workerCapabilities !== "number" || !Number.isSafeInteger(context.workerCapabilities) || context.workerCapabilities < 0
                || !/^(0|[1-9][0-9]*)$/.test(String(context.workerMaxActionSpend))
                || typeof context.allowPrivateGraph !== "boolean" || typeof context.allowRoomHistory !== "boolean"
                || typeof context.allowPrivateTaskArtifacts !== "boolean"
                || !(context.taskId===null||typeof context.taskId==="string")
                || typeof context.allowPrivateContentSharing !== "boolean") {
                throw new McpRuntimeError("AUTHENTICATION_FAILED", "The work-run identity is incomplete.");
            }
            const parent = context.parentAgentId as string;
            const accountId = context.accountId as string;
            const delegates = await listDelegateRows(config, {
                accountId, agentObjectId: parent, signerSessionId: "", auth: {} as HostedMcpPrincipal["auth"],
            });
            const delegate = delegates.find((row) => row.delegate_ref === context.delegateRef
                && row.delegate_class === "action_worker"
                && typeof row.agent_object_id === "string"
                && normalizeHostedId(row.agent_object_id) === normalizeHostedId(context.workerAgentId as string)
                && Array.isArray(row.allowed_action_ids)
                && row.allowed_action_ids.length > 0 && row.allowed_action_ids.length <= 16
                && row.allowed_action_ids.every((id) => typeof id === "string" && CHAIN_CLASS_ACTIONS_FOR_HOSTED.has(id)));
            if (!delegate || !Array.isArray(delegate.allowed_action_ids)) throw new McpRuntimeError("AUTHENTICATION_FAILED", "The credential is not bound to a registered action_worker.");
            const expiresAt = context.expiresAt as string;
            const expiresAtMs = Date.parse(expiresAt);
            if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) throw new McpRuntimeError("AUTHENTICATION_FAILED", "The work-run credential has expired.");
            const scopes = [...new Set(Object.values(TOOL_OAUTH_SCOPES))];
            const workerRun = {
                credential, runId: context.runId as string, workerAgentObjectId: context.workerAgentId as string,
                workerCapabilities: context.workerCapabilities, workerMaxActionSpend: String(context.workerMaxActionSpend),
                delegateRef: context.delegateRef as string, allowedActionIds: delegate.allowed_action_ids as string[], expiresAt,
                taskId: context.taskId as string | null,
                allowPrivateGraph: context.allowPrivateGraph,
                allowRoomHistory: context.allowRoomHistory,
                allowPrivateTaskArtifacts: context.allowPrivateTaskArtifacts,
                allowPrivateContentSharing: context.allowPrivateContentSharing,
            };
            return {
                auth: { token: credential, clientId: "myso-work-run", scopes, expiresAt: Math.floor(expiresAtMs / 1000), resource: new URL(config.resourceUrl), extra: { accountId, agentObjectId: parent, signerSessionId: `work-run:${workerRun.runId}` } } as HostedMcpPrincipal["auth"],
                accountId, agentObjectId: parent, signerSessionId: `work-run:${workerRun.runId}`, myDataSession, workerRun,
            };
        },
        async createDependencies(principal) {
            return createHostedDependencies(config, principal);
        },
    });
}

export function startHostedMcpServer(config: HostedMcpEnvConfig): Server {
    const server = createConfiguredHostedServer(config);
    server.listen(config.port, "0.0.0.0");
    return server;
}
