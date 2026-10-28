import { MARKET_ACTION_TOOLS, ACTION_ID_BY_TOOL } from "./registry-tools.js";
import { PLATFORM_TOOLS, PLATFORM_TOOL_BY_NAME } from "./platform-tools.js";
import { createHash, randomUUID } from "node:crypto";
import { MEMORY_TYPESCRIPT_COMPATIBILITY_VERSION, canonicalGraphJson, createMySoGraphPublication, encodeMySoGraphPublicationTags, graphManifestHashHex, type MyDataContentRequest, type MyDataGraphItemRequest, type MyDataGraphSearchRequest, type MySoGraphAuthorityProof, type MySoGraphManifest, type MySoGraphOfferTerms } from "@socialproof/memory";
import {
    PROFILE_SUBSCRIPTION_ACTION_IDS, CAP_TRADE_EXECUTE, CAP_AGENT_REGISTER, CAP_AGENT_REVOKE, CAP_AGENT_UPDATE, CAP_BUDGET_MANAGE,
    CAP_MEMORY_READ, CAP_MEMORY_WRITE, CAP_MYDATA_READ, CAP_MESSAGE_READ, CAP_MESSAGE_SEND, CAP_AI_SPEND, CAP_TASK_TRADE,
    PRODUCTION_ACTION_CATALOG,
    PRODUCTION_ACTION_CATALOG_VERSION,
    SOCIAL_ACTION_REGISTRY_VERSION,
    getSocialActionDescriptor,
    type SocialActionId,
    type SocialChainConfig,
    type EditCommentParams,
    type EditPostParams,
    type ProfileRelationParams,
    type RemoveCommentReactionParams,
    type RemovePostReactionParams,
    type RemoveRepostParams,
    type SendMessageParams,
    type CreateMessagingGroupParams,
    type OrganizationInvitationDecisionParams,
    type RegisterChildAgentParams,
    type UpdateManagedAgentParams,
    type ManagedAgentParams,
} from "@socialproof/sub-agents";
import { McpRuntimeError, redactSensitiveText } from "./errors.js";
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
import { sanitizeWorkJournalRead } from "./work-run-read-sanitize.js";
import { sanitizeAgentChildren, sanitizeAgentReceipts, sanitizeProfileAgents } from "./agent-list-read-sanitize.js";
import { sanitizeDexMarket, sanitizeDexMarkets, sanitizeDexOrderbook, sanitizeDexStatus, sanitizeDexSummary, sanitizeDexSwapReceipt, sanitizeDexTicker, sanitizeDexTrades } from "./dex-read-sanitize.js";
import { sanitizeGovernanceRead } from "./governance-read-sanitize.js";
import { sanitizeActionApprovals, sanitizeActionByIdempotencyKey, sanitizeActionReceipt } from "./chain-read-sanitize.js";
import { sanitizeJuryCaseBundle, sanitizeJuryCasesRead, sanitizeJuryCranks, sanitizeJuryHealth, sanitizeJuryListRead, sanitizeJuryOwnProfile, sanitizeJuryRationales, sanitizeJuryReceipt, sanitizeJuryTaskDispute, sanitizeProposalJuryRead, sanitizeTaskDeliverableRead, sanitizeTaskDetailRead, sanitizeTaskDisputeRead, sanitizeTaskHistoryRead, sanitizeTaskMarketRead, sanitizeTaskReceipt, sanitizeTaskRoomRead, sanitizeTaskSettlementReceipt } from "./task-jury-read-sanitize.js";
import type { AgentSigner } from "./signers.js";
import { McpRoomMessagingClient } from "./room-messaging.js";

export interface CreatePostInput {
    content: string;
    idempotencyKey: string;
}

export interface CreateCommentInput {
    postId: string;
    content: string;
    parentCommentId?: string;
    idempotencyKey: string;
}

export interface ReactToPostInput {
    postId: string;
    reaction: string;
    idempotencyKey: string;
}

export interface ReactToCommentInput {
    commentId: string;
    reaction: string;
    idempotencyKey: string;
}

export interface CreateRepostInput {
    originalPostId: string;
    content?: string;
    idempotencyKey: string;
}

type IdempotentInput<T> = T & { idempotencyKey: string };

export interface ActionApprovalInput {
    registryAction: SocialActionId;
    parameters: unknown;
    idempotencyKey: string;
    expiresInSeconds?: number;
    signerAddress?: string;
}

export interface ActionApprovalDecisionInput {
    approvalId: string;
    walletSignature: string;
}

export interface ApprovedActionPrepareInput extends ActionApprovalInput {
    approvalId: string;
}

export interface ApprovedActionSubmitInput {
    registryAction: SocialActionId;
    idempotencyKey: string;
    approvalId: string;
    digest: string;
    walletSignature: string;
}

export interface SocialGateway {
    readonly supportedToolNames: readonly string[];
    /** Configures session-bound encrypted room tools for a hosted deployment. */
    enableRoomMessaging?(relayerUrl: string): void;
    availableToolNames?(): Promise<readonly string[]>;
    listActions(): Promise<unknown>;
    /** Live signed execution identity used to bind hosted dependency factories. */
    getExecutionContext?(): Promise<unknown>;
    executeAction?(action: SocialActionId, parameters: unknown, idempotencyKey: string): Promise<unknown>;
    callPlatformTool?(name: string, args: Record<string, unknown>): Promise<unknown>;
    createPost(input: CreatePostInput): Promise<unknown>;
    createComment(input: CreateCommentInput): Promise<unknown>;
    reactToPost(input: ReactToPostInput): Promise<unknown>;
    reactToComment(input: ReactToCommentInput): Promise<unknown>;
    createRepost(input: CreateRepostInput): Promise<unknown>;
    removePostReaction(input: IdempotentInput<RemovePostReactionParams>): Promise<unknown>;
    removeCommentReaction(input: IdempotentInput<RemoveCommentReactionParams>): Promise<unknown>;
    editPost(input: IdempotentInput<EditPostParams>): Promise<unknown>;
    editComment(input: IdempotentInput<EditCommentParams>): Promise<unknown>;
    removeRepost(input: IdempotentInput<RemoveRepostParams>): Promise<unknown>;
    followProfile(input: IdempotentInput<ProfileRelationParams>): Promise<unknown>;
    unfollowProfile(input: IdempotentInput<ProfileRelationParams>): Promise<unknown>;
    blockProfile(input: IdempotentInput<ProfileRelationParams>): Promise<unknown>;
    unblockProfile(input: IdempotentInput<ProfileRelationParams>): Promise<unknown>;
    sendMessage(input: IdempotentInput<SendMessageParams>): Promise<unknown>;
    createMessagingGroup(input: IdempotentInput<CreateMessagingGroupParams>): Promise<unknown>;
    bindAgentRoomToTask(input: IdempotentInput<{ groupId: string; taskId: string }>): Promise<unknown>;
    acceptOrganizationInvitation(input: IdempotentInput<OrganizationInvitationDecisionParams>): Promise<unknown>;
    declineOrganizationInvitation(input: IdempotentInput<OrganizationInvitationDecisionParams>): Promise<unknown>;
    registerChildAgent(
        input: IdempotentInput<Omit<RegisterChildAgentParams, "parentAgentObjectId"> & { parentAgentObjectId?: string }>,
    ): Promise<unknown>;
    updateChildAgent(input: IdempotentInput<UpdateManagedAgentParams>): Promise<unknown>;
    deactivateChildAgent(input: IdempotentInput<ManagedAgentParams>): Promise<unknown>;
    revokeChildAgent(input: IdempotentInput<ManagedAgentParams>): Promise<unknown>;
    getOrganizationControl(organizationId: string): Promise<unknown>;
    listInbox(input: { limit?: number; offset?: number; groupId?: string; afterCreatedAtMs?: number; afterSeq?: number }): Promise<unknown>;
    waitForMessage(input: { timeoutMs?: number; groupId?: string; afterCreatedAtMs?: number; afterSeq?: number }): Promise<unknown>;
    listRoomConversations?(request: { limit?: number; offset?: number; afterGroupId?: string }): Promise<unknown>;
    getRoomHistory?(request: Parameters<RoomHistoryClient["readRoomHistory"]>[0]): Promise<unknown>;
    getRoomAttachment?(request: NonNullable<RoomHistoryClient["readRoomAttachment"]> extends (request: infer T) => Promise<unknown> ? T : never): Promise<unknown>;
    sendRoomMessage?(request: { groupRef: { groupId: string; encryptionHistoryId: string } | { uuid: string }; text?: string; files?: Array<{ fileName: string; mimeType: string; contentBase64: string }>; idempotencyKey: string }): Promise<unknown>;
    listRoomReactions?(request: Parameters<NonNullable<RoomHistoryClient["listRoomReactions"]>>[0]): Promise<unknown>;
    changeRoomReaction?(request: Parameters<NonNullable<RoomHistoryClient["changeRoomReaction"]>>[0]): Promise<unknown>;
    getRoomReceipts?(request: Parameters<NonNullable<RoomHistoryClient["getRoomReceipts"]>>[0]): Promise<unknown>;
    updateRoomReceipts?(request: Parameters<NonNullable<RoomHistoryClient["updateRoomReceipts"]>>[0]): Promise<unknown>;
    editRoomMessage?(request: Parameters<NonNullable<RoomHistoryClient["editRoomMessage"]>>[0]): Promise<unknown>;
    deleteRoomMessage?(request: Parameters<NonNullable<RoomHistoryClient["deleteRoomMessage"]>>[0]): Promise<unknown>;
    removeRoomMembersAndRotateKey?(request: { groupRef: { groupId: string; encryptionHistoryId: string } | { uuid: string }; members: string[] }): Promise<unknown>;
    addRoomMembers?(request: { groupRef: { groupId: string; encryptionHistoryId: string } | { uuid: string }; members: string[]; acknowledgeHistoryAccess: true }): Promise<unknown>;
    leaveRoom?(request: { groupRef: { groupId: string; encryptionHistoryId: string } | { uuid: string } }): Promise<unknown>;
    setRoomName?(request: { groupRef: { groupId: string; encryptionHistoryId: string } | { uuid: string }; name: string }): Promise<unknown>;
    archiveRoom?(request: { groupRef: { groupId: string; encryptionHistoryId: string } | { uuid: string }; ownerConfirmation: { owner: string; agentObjectId: string; groupId: string; expiresAtMs: number; nonce: string; signature: string } }): Promise<unknown>;
    getRoomReadState?(): Promise<unknown>;
    updateRoomReadState?(request: { groupId: string; readUpto: number }): Promise<unknown>;
    getRoomUnreadCounts?(request: { groupIds: string[] }): Promise<unknown>;
    getActionStatus(digest: string): Promise<unknown>;
    requestActionApproval(input: ActionApprovalInput): Promise<unknown>;
    approveAction(input: ActionApprovalDecisionInput): Promise<unknown>;
    prepareApprovedAction(input: ApprovedActionPrepareInput): Promise<unknown>;
    submitApprovedAction(input: ApprovedActionSubmitInput): Promise<unknown>;
}

interface AgentContextResponse {
    owner: string;
    memoryAccountId: string;
    agentObjectId: string;
    derivedAddress: string;
    capabilities: number;
    approvalRequiredCapabilities: number;
    platformScope?: string | null;
    organizationId?: string | null;
    network: string;
    rpcUrl: string;
    packageId?: string;
    socialChain: SocialChainConfig;
    permittedRegistryActions?: string[];
    indexers?: { orderbook?: boolean };
}

type MySoNetwork = "mainnet" | "testnet" | "devnet" | "localnet";

export interface AuthenticatedSocialExecutionContext {
    network: MySoNetwork;
    rpcUrl: string;
    chain: SocialChainConfig;
}

interface PreparedActionResponse {
    registryAction: string;
    registryVersion: string;
    idempotencyKey: string;
    parameterHash: string;
    transactionKindHash: string;
    packageId: string;
    packageVersion: string;
    bytes: string;
    digest: string;
    status: string;
    expiresAtMs: number;
}

interface SponsorExecuteResponse {
    digest: string;
}

/** Authenticated SDK instance supplies expiring MYDATA sessions without exposing them as tool arguments. */
export interface WorkJournalClient {
    getAgentContext(): Promise<unknown>;
    /** Wallet-authenticated relayer discovery; implementation must filter through live MessagingReader checks. */
    listRoomConversations?(request: { limit?: number; offset?: number; afterGroupId?: string }): Promise<unknown>;
    workTurn(id: string, action: "acquire" | "renew" | "checkpoint" | "finish", request: object): Promise<unknown>;
    createWorkRun(id: string, plan: object, taskId?: string): Promise<unknown>;
    getWorkRun(id: string): Promise<unknown>;
    refreshWorkTaskHistory(id: string): Promise<unknown>;
    listWorkRunOperations(id: string, limit?: number, offset?: number): Promise<unknown>;
    cancelWorkRun(id: string): Promise<unknown>;
    completeWorkRun(id: string): Promise<unknown>;
    issueWorkRunWorkerCredential(id: string, request: object): Promise<unknown>;
    revokeWorkRunWorkerCredential(id: string): Promise<unknown>;
    listWorkRuns(limit?: number, offset?: number): Promise<unknown>;
    saveWorkPlan(id: string, request: object): Promise<unknown>;
    reserveWorkOperation(id: string, request: object): Promise<unknown>;
    settleWorkOperation(id: string, request: object): Promise<unknown>;
    reconcileWorkActionReceipt(id: string, request: object): Promise<unknown>;
    reconcileWorkTaskUpload(id: string, request: object): Promise<unknown>;
    appendWorkActionReceipt(id: string, request: object): Promise<unknown>;
    appendWorkTaskArtifact(id: string, request: object): Promise<unknown>;
    updateWorkStep(id: string, stepId: string, request: object): Promise<unknown>;
}

/** Per-principal session-capable SDK adapter. No session/key is an MCP tool argument. */
export interface MyDataContentClient {
    getAgentContext(): Promise<unknown>;
    readMyDataContent(request: MyDataContentRequest): Promise<unknown>;
    checkCurrentMyDataAccess?(request: MyDataCurrentAccessRequest): Promise<unknown>;
    searchMyDataGraph?(request: MyDataGraphSearchRequest, beforeEachPage?: () => Promise<void>): Promise<unknown>;
    getMyDataGraphItem?(request: MyDataGraphItemRequest, beforeEachPage?: () => Promise<void>): Promise<unknown>;
    verifyMyDataGraphOffer?(mydataId: string): Promise<unknown>;
}

export interface MyDataCurrentAccessRequest {
    mydataId: string;
    encryptedDataDigestHex: string;
    organizationAudienceId?: string;
}

/** Session-bound messaging SDK adapter; plaintext exists only in the requesting MCP process. */
export interface RoomHistoryClient {
    getAgentContext(): Promise<unknown>;
    /** Wallet-authenticated relayer discovery; implementation must filter through live MessagingReader checks. */
    listRoomConversations?(request: { limit?: number; offset?: number; afterGroupId?: string }): Promise<unknown>;
    readRoomHistory(request: {
        groupRef: { groupId: string; encryptionHistoryId: string } | { uuid: string };
        afterOrder?: number;
        beforeOrder?: number;
        limit?: number;
    }): Promise<unknown>;
    /** Decrypt one explicitly selected, signature-verified attachment after live MessagingReader checks. */
    readRoomAttachment?(request: { groupRef: { groupId: string; encryptionHistoryId: string } | { uuid: string }; messageId: string; storageId: string }): Promise<unknown>;
    /** Send E2EE text after a live MessagingSender check, then verify a signed readback. */
    sendRoomMessage?(request: { groupRef: { groupId: string; encryptionHistoryId: string } | { uuid: string }; text?: string; files?: Array<{ fileName: string; mimeType: string; contentBase64: string }>; idempotencyKey: string }): Promise<unknown>;
    /** Relayer metadata only; implementation must recheck live MessagingReader permission. */
    listRoomReactions?(request: { groupRef: { groupId: string; encryptionHistoryId: string } | { uuid: string }; order: number }): Promise<unknown>;
    /** Relayer mutation; implementation must recheck live MessagingSender permission. */
    changeRoomReaction?(request: { groupRef: { groupId: string; encryptionHistoryId: string } | { uuid: string }; order: number; emoji: string; add: boolean }): Promise<unknown>;
    /** Peer-visible relayer watermarks; implementation must recheck live MessagingReader permission. */
    getRoomReceipts?(request: { groupRef: { groupId: string; encryptionHistoryId: string } | { uuid: string } }): Promise<unknown>;
    /** Relayer mutation; implementation must recheck live MessagingReader permission. */
    updateRoomReceipts?(request: { groupRef: { groupId: string; encryptionHistoryId: string } | { uuid: string }; deliveredUpto?: number; readUpto?: number }): Promise<unknown>;
    /** Content mutation; implementation must verify the sender signature and live MessagingSender permission. */
    editRoomMessage?(request: { groupRef: { groupId: string; encryptionHistoryId: string } | { uuid: string }; messageId: string; text: string }): Promise<unknown>;
    /** Soft-delete mutation; implementation must verify message ownership and live MessagingSender permission. */
    deleteRoomMessage?(request: { groupRef: { groupId: string; encryptionHistoryId: string } | { uuid: string }; messageId: string }): Promise<unknown>;
    /** Native destructive action; requires live room admin/key-rotation authority and verifies finalized removal + rotation. */
    removeRoomMembersAndRotateKey?(request: { groupRef: { groupId: string; encryptionHistoryId: string } | { uuid: string }; members: string[] }): Promise<unknown>;
    /** Sensitive history-sharing action; requires live MessagingReader and ExtensionPermissionsAdmin and verifies finalized grants. */
    addRoomMembers?(request: { groupRef: { groupId: string; encryptionHistoryId: string } | { uuid: string }; members: string[]; acknowledgeHistoryAccess: true }): Promise<unknown>;
    /** Self-service native action; removes the acting agent and verifies its finalized absence from membership. */
    leaveRoom?(request: { groupRef: { groupId: string; encryptionHistoryId: string } | { uuid: string } }): Promise<unknown>;
    /** Native metadata update; requires live MetadataAdmin and confirms its fullnode result. */
    setRoomName?(request: { groupRef: { groupId: string; encryptionHistoryId: string } | { uuid: string }; name: string }): Promise<unknown>;
    /** Permanent archive; requires live PermissionsAdmin plus explicit caller confirmation. */
    archiveRoom?(request: { groupRef: { groupId: string; encryptionHistoryId: string } | { uuid: string }; ownerConfirmation: { owner: string; agentObjectId: string; groupId: string; expiresAtMs: number; nonce: string; signature: string } }): Promise<unknown>;
    /** Private encrypted per-agent read markers; distinct from peer-visible group receipts. */
    getRoomReadState?(): Promise<unknown>;
    /** Compare-and-set private read marker; implementation must recheck live MessagingReader permission. */
    updateRoomReadState?(request: { groupId: string; readUpto: number }): Promise<unknown>;
    /** Batched unread metadata; implementation must recheck live MessagingReader permission for every group. */
    getRoomUnreadCounts?(request: { groupIds: string[] }): Promise<unknown>;
}

function sanitizeRoomReactions(value: unknown, expectedOrder: number): unknown {
    if (!Array.isArray(value) || value.length > 500) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room reaction client returned an invalid or oversized response.");
    const seen = new Set<string>();
    return value.map((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room reaction client returned an invalid row.");
        const row = raw as Record<string, unknown>;
        if (row.chainSeq !== expectedOrder || !Number.isSafeInteger(row.chainSeq) || Number(row.chainSeq) < 0 || typeof row.emoji !== "string" || !row.emoji || row.emoji.length > 32 || row.emoji.normalize("NFC") !== row.emoji || !Number.isSafeInteger(row.count) || Number(row.count) < 0 || !Array.isArray(row.reactors) || row.reactors.length > 500 || row.reactors.length !== row.count || row.reactors.some((reactor) => typeof reactor !== "string" || !normalizeAddress(reactor))) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room reaction client returned an invalid row.");
        const key = `${row.chainSeq}:${row.emoji}`;
        if (seen.has(key)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room reaction client returned duplicate rows.");
        seen.add(key);
        const reactors = (row.reactors as string[]).map(normalizeAddress);
        if (new Set(reactors).size !== reactors.length) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room reaction client returned duplicate reactors.");
        return { chainSeq: row.chainSeq, emoji: row.emoji, count: row.count, reactors };
    });
}

function sanitizeRoomConversations(value: unknown, limit: number, requestedOffset: number, requestedAfterGroupId?: string): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room discovery client returned an invalid page.");
    const page = value as Record<string, unknown>;
    const cursorMode = requestedAfterGroupId !== undefined;
    const expectedOffset = cursorMode ? null : requestedOffset;
    const expectedCursor = cursorMode ? normalizeAddress(requestedAfterGroupId) : null;
    if (Object.keys(page).length !== 10 || !Array.isArray(page.conversations) || page.conversations.length > limit
        || page.offset !== expectedOffset || page.afterGroupId !== expectedCursor || page.limit !== limit
        || typeof page.hasMore !== "boolean"
        || (page.offset !== null && !Number.isSafeInteger(page.offset)) || !Number.isSafeInteger(page.limit)
        || page.nextOffset !== (!cursorMode && page.hasMore ? requestedOffset + limit : null)
        || (page.hasMore && (typeof page.nextAfterGroupId !== "string" || !normalizeAddress(page.nextAfterGroupId)))
        || (!page.hasMore && page.nextAfterGroupId !== null)
        || page.membershipSource !== "relayer_membership_index"
        || page.permissionSource !== "live_fullnode_messaging_reader_checked"
        || page.metadataSource !== "configured_fullnode_group_metadata") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room discovery client returned an invalid or inconsistent page.");
    const seen = new Set<string>();
    const conversations = page.conversations.map((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room discovery client returned an invalid row.");
        const row = raw as Record<string, unknown>;
        const groupId = normalizeAddress(typeof row.groupId === "string" ? row.groupId : "");
        if (groupId && Object.keys(row).every((key) => ["groupId", "groupName", "groupUuid", "creatorPrincipal"].includes(key))) {
            if (row.groupName !== undefined && row.groupName !== null && (typeof row.groupName !== "string" || row.groupName.length > 1024)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room discovery client returned invalid on-chain metadata.");
            if (row.groupUuid !== undefined && row.groupUuid !== null && (typeof row.groupUuid !== "string" || row.groupUuid.length > 128)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room discovery client returned invalid on-chain metadata.");
            if (row.creatorPrincipal !== undefined && row.creatorPrincipal !== null && (typeof row.creatorPrincipal !== "string" || !normalizeAddress(row.creatorPrincipal))) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room discovery client returned invalid on-chain metadata.");
            if (seen.has(groupId)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room discovery client returned duplicate rooms.");
            seen.add(groupId);
            return { groupId, ...(typeof row.groupName === "string" ? { groupName: row.groupName } : {}), ...(typeof row.groupUuid === "string" ? { groupUuid: row.groupUuid } : {}), ...(typeof row.creatorPrincipal === "string" ? { creatorPrincipal: normalizeAddress(row.creatorPrincipal) } : {}) };
        }
        const creatorActor = normalizeAddress(typeof row.creatorActor === "string" ? row.creatorActor : "");
        const creatorPrincipal = normalizeAddress(typeof row.creatorPrincipal === "string" ? row.creatorPrincipal : "");
        if (!groupId || !creatorActor || !creatorPrincipal || !Number.isSafeInteger(row.createdAt) || Number(row.createdAt) < 0 || (row.creatorSubAgentId !== undefined && row.creatorSubAgentId !== null && typeof row.creatorSubAgentId !== "string") || (row.creatorIdentityClass !== undefined && row.creatorIdentityClass !== null && (!Number.isSafeInteger(row.creatorIdentityClass) || Number(row.creatorIdentityClass) < 0 || Number(row.creatorIdentityClass) > 255)) || (row.organizationId !== undefined && row.organizationId !== null && (typeof row.organizationId !== "string" || !normalizeAddress(row.organizationId))) || (row.groupName !== undefined && row.groupName !== null && (typeof row.groupName !== "string" || row.groupName.length > 256)) || (row.groupUuid !== undefined && row.groupUuid !== null && (typeof row.groupUuid !== "string" || !row.groupUuid || row.groupUuid.length > 128))) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room discovery client returned an invalid row.");
        if (seen.has(groupId)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room discovery client returned duplicate rooms.");
        seen.add(groupId);
        return { groupId, creatorActor, creatorPrincipal, ...(row.creatorSubAgentId == null ? {} : { creatorSubAgentId: row.creatorSubAgentId }), ...(row.creatorIdentityClass == null ? {} : { creatorIdentityClass: row.creatorIdentityClass }), ...(row.organizationId == null ? {} : { organizationId: normalizeAddress(row.organizationId as string) }), ...(row.groupName == null ? {} : { groupName: row.groupName }), ...(row.groupUuid == null ? {} : { groupUuid: row.groupUuid }), createdAt: Number(row.createdAt) };
    });
    return { conversations, offset: page.offset, limit, hasMore: page.hasMore, nextOffset: page.nextOffset, afterGroupId: page.afterGroupId, nextAfterGroupId: page.nextAfterGroupId, membershipSource: page.membershipSource, permissionSource: page.permissionSource, metadataSource: page.metadataSource };
}

function sanitizeRoomMemberRemoval(value: unknown, expectedGroupId: string, expectedMembers: string[]): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room administration client returned an invalid result.");
    const result = value as Record<string, unknown>;
    const groupId = normalizeAddress(typeof result.groupId === "string" ? result.groupId : "");
    const removedMembers = result.removedMembers;
    if (groupId !== normalizeAddress(expectedGroupId) || typeof result.digest !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{30,60}$/.test(result.digest) || !Array.isArray(removedMembers) || removedMembers.length !== expectedMembers.length || removedMembers.some((member) => typeof member !== "string" || !normalizeAddress(member)) || new Set((removedMembers as string[]).map(normalizeAddress)).size !== expectedMembers.length || new Set((removedMembers as string[]).map(normalizeAddress)).size !== new Set(expectedMembers.map(normalizeAddress)).size || removedMembers.some((member) => !expectedMembers.map(normalizeAddress).includes(normalizeAddress(member as string))) || typeof result.keyVersionBefore !== "string" || !/^(0|[1-9][0-9]*)$/.test(result.keyVersionBefore) || typeof result.keyVersionAfter !== "string" || !/^(0|[1-9][0-9]*)$/.test(result.keyVersionAfter) || BigInt(result.keyVersionAfter) <= BigInt(result.keyVersionBefore) || result.verification !== "finalized_membership_and_key_version" || result.source !== "myso_fullnode") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room administration client could not verify the exact membership removal and key rotation.");
    return { groupId, digest: result.digest, removedMembers: (removedMembers as string[]).map(normalizeAddress), keyVersionBefore: result.keyVersionBefore, keyVersionAfter: result.keyVersionAfter, verification: result.verification, source: result.source };
}

function sanitizeRoomMemberAddition(value: unknown, expectedGroupId: string, expectedMembers: string[]): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room invitation client returned an invalid result.");
    const result = value as Record<string, unknown>;
    const groupId = normalizeAddress(typeof result.groupId === "string" ? result.groupId : "");
    const grantedMembers = result.grantedMembers;
    if (groupId !== normalizeAddress(expectedGroupId) || typeof result.digest !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{30,60}$/.test(result.digest) || !Array.isArray(grantedMembers) || grantedMembers.length !== expectedMembers.length || grantedMembers.some((member) => typeof member !== "string" || !normalizeAddress(member)) || new Set((grantedMembers as string[]).map(normalizeAddress)).size !== expectedMembers.length || new Set((grantedMembers as string[]).map(normalizeAddress)).size !== new Set(expectedMembers.map(normalizeAddress)).size || grantedMembers.some((member) => !expectedMembers.map(normalizeAddress).includes(normalizeAddress(member as string))) || result.verification !== "finalized_reader_and_sender_permissions" || result.source !== "myso_fullnode") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room invitation client could not verify the exact finalized reader and sender grants.");
    return { groupId, digest: result.digest, grantedMembers: (grantedMembers as string[]).map(normalizeAddress), historyAccess: "existing_and_future", verification: result.verification, source: result.source };
}

function sanitizeRoomLeave(value: unknown, expectedGroupId?: string): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room leave client returned an invalid result.");
    const result = value as Record<string, unknown>;
    const groupId = normalizeAddress(typeof result.groupId === "string" ? result.groupId : "");
    const alreadyAbsent = result.verification === "already_absent_from_membership" && result.digest === null;
    const finalizedLeave = result.verification === "finalized_membership_absent" && typeof result.digest === "string" && /^[1-9A-HJ-NP-Za-km-z]{30,60}$/.test(result.digest);
    if (result.left !== true || !groupId || (expectedGroupId && groupId !== normalizeAddress(expectedGroupId)) || (!alreadyAbsent && !finalizedLeave) || result.source !== "myso_fullnode") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room leave client could not verify the acting agent's exact membership removal.");
    return { left: true, groupId, digest: result.digest, verification: result.verification, source: result.source };
}

function sanitizeRoomRename(value: unknown, expectedName: string, expectedGroupId?: string): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room rename client returned an invalid result.");
    const result = value as Record<string, unknown>;
    const groupId = normalizeAddress(typeof result.groupId === "string" ? result.groupId : "");
    if (result.updated !== true || !groupId || (expectedGroupId && groupId !== normalizeAddress(expectedGroupId)) || result.name !== expectedName || typeof result.digest !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{30,60}$/.test(result.digest) || result.verification !== "fullnode_metadata_refetched" || result.source !== "myso_fullnode") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room rename client could not verify the exact fullnode metadata update.");
    return { updated: true, groupId, name: expectedName, digest: result.digest, verification: result.verification, source: result.source };
}

function sanitizeRoomReceipts(value: unknown): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room receipt client returned an invalid response.");
    const members = (value as Record<string, unknown>).members;
    if (!Array.isArray(members) || members.length > 500) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room receipt client returned an invalid or oversized response.");
    const seen = new Set<string>();
    return { members: members.map((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room receipt client returned an invalid row.");
        const row = raw as Record<string, unknown>;
        if (typeof row.member !== "string" || !normalizeAddress(row.member) || !validRoomSequence(row.deliveredUpto) || !validRoomSequence(row.readUpto)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room receipt client returned an invalid row.");
        const member = normalizeAddress(row.member);
        if (seen.has(member)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room receipt client returned duplicate members.");
        seen.add(member);
        return { member, deliveredUpto: row.deliveredUpto, readUpto: row.readUpto };
    }) };
}

function sanitizeRoomReadState(value: unknown): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The private room read-state client returned an invalid response.");
    const state = value as Record<string, unknown>;
    if (state.version !== 1 || !Number.isSafeInteger(state.updatedAt) || Number(state.updatedAt) < 0 || !state.groups || typeof state.groups !== "object" || Array.isArray(state.groups)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The private room read-state client returned an invalid response.");
    const entries = Object.entries(state.groups as Record<string, unknown>);
    if (entries.length > 10000) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The private room read-state response is oversized.");
    const groups: Record<string, { readUpto: number; muted?: boolean }> = {};
    for (const [rawId, rawEntry] of entries) {
        const groupId = normalizeAddress(rawId);
        if (!groupId || !rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The private room read-state client returned an invalid group marker.");
        const entry = rawEntry as Record<string, unknown>;
        if (!Number.isSafeInteger(entry.readUpto) || Number(entry.readUpto) < 0 || (entry.muted !== undefined && typeof entry.muted !== "boolean")) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The private room read-state client returned an invalid group marker.");
        groups[groupId] = { readUpto: Number(entry.readUpto), ...(entry.muted === undefined ? {} : { muted: entry.muted }) };
    }
    return { version: 1, updatedAt: Number(state.updatedAt), groups };
}

function sanitizeUnreadCounts(value: unknown, requestedGroupIds: string[]): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The unread-count client returned an invalid response.");
    const rawCounts = value as Record<string, unknown>;
    const requested = new Map(requestedGroupIds.map((id) => [normalizeAddress(id)!, id]));
    const counts: Record<string, number> = {};
    for (const [rawId, rawCount] of Object.entries(rawCounts)) {
        const groupId = normalizeAddress(rawId);
        if (!groupId || !requested.has(groupId) || !Number.isSafeInteger(rawCount) || Number(rawCount) < 0) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The unread-count client returned an invalid or unrequested room count.");
        counts[groupId] = Number(rawCount);
    }
    for (const groupId of requested.keys()) if (counts[groupId] === undefined) counts[groupId] = 0;
    return { counts, metadataSource: "messaging_relayer" };
}

function sanitizeRoomAttachmentPlaintext(value: unknown, expectedMessageId: string, expectedStorageId: string): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The selected attachment response is invalid.");
    const row = value as Record<string, unknown>;
    const encoded = row.contentBase64;
    if (row.messageId !== expectedMessageId || row.storageId !== expectedStorageId
        || row.senderVerified !== true || row.attachmentIntegrity !== "verified"
        || typeof row.groupId !== "string" || !/^0x[0-9a-f]{64}$/i.test(row.groupId)
        || typeof row.fileName !== "string" || row.fileName.length < 1 || row.fileName.length > 255
        || typeof row.mimeType !== "string" || row.mimeType.length < 1 || row.mimeType.length > 128
        || typeof encoded !== "string" || encoded.length > 6990508 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
        || !Number.isSafeInteger(row.fileSize) || Number(row.fileSize) < 0 || Number(row.fileSize) > 5 * 1024 * 1024
        || !/^[0-9a-f]{64}$/i.test(String(row.contentSha256 ?? ""))) {
        throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The selected attachment response did not match the verified request and metadata.");
    }
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.byteLength !== row.fileSize || createHash("sha256").update(bytes).digest("hex") !== String(row.contentSha256).toLowerCase()) {
        throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The decrypted attachment failed its size or digest check.");
    }
    return row;
}

function sanitizeRoomHistoryPage(value: unknown, expectedGroupId?: string, requestedLimit?: number): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room history client returned an invalid page.");
    const page = value as Record<string, unknown>;
    const entries = page.entries;
    if (typeof page.groupId !== "string" || !normalizeAddress(page.groupId) || page.groupId.length > 200 || (expectedGroupId && normalizeAddress(page.groupId) !== normalizeAddress(expectedGroupId)) || !Array.isArray(entries) || entries.length > Math.min(requestedLimit ?? 50, 50) || typeof page.hasNext !== "boolean" || page.metadataSource !== "relayer_unverified") {
        throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room history client returned an invalid page.");
    }
    let bytes = 0;
    const clean = entries.map((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room history client returned an invalid entry.");
        const entry = raw as Record<string, unknown>;
        if (typeof entry.messageId !== "string" || !entry.messageId || entry.messageId.length > 128 || !validRoomSequence(entry.order)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room history client returned an invalid entry.");
        const status = entry.status;
        if (["unverified_content", "unavailable_content", "system_metadata", "deleted_metadata"].includes(String(status))) return { messageId: entry.messageId, order: entry.order, status };
        if (status !== "verified_content" || !entry.content || typeof entry.content !== "object" || Array.isArray(entry.content)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room history client returned an invalid entry.");
        const content = entry.content as Record<string, unknown>;
        const allowedContentKeys = new Set(["text", "senderAddress", "kind", "attachmentIntegrity", "attachmentCount", "attachmentMetadataStatus", "attachments", "attributionIntegrity", "isAgentMessage", "attribution"]);
        if (Object.keys(content).some((key) => !allowedContentKeys.has(key))
            || typeof content.text !== "string" || typeof content.senderAddress !== "string" || content.senderAddress.length > 80
            || (content.kind !== undefined && typeof content.kind !== "string")
            || !["none", "verified", "legacy_unverified", "signature_unverified"].includes(String(content.attachmentIntegrity))
            || !Number.isSafeInteger(content.attachmentCount) || Number(content.attachmentCount) < 0 || Number(content.attachmentCount) > 10
            || !["none", "verified", "unavailable"].includes(String(content.attachmentMetadataStatus))
            || !Array.isArray(content.attachments) || content.attachments.length > 10
            || !["none", "verified", "legacy_unverified", "signature_unverified"].includes(String(content.attributionIntegrity))
            || typeof content.isAgentMessage !== "boolean") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room history client returned invalid verified content.");
        const attachments = content.attachments.map((rawAttachment) => {
            if (!rawAttachment || typeof rawAttachment !== "object" || Array.isArray(rawAttachment)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room history client returned invalid attachment metadata.");
            const attachment = rawAttachment as Record<string, unknown>;
            if (Object.keys(attachment).sort().join(",") !== "fileName,fileSize,mimeType,storageId"
                || typeof attachment.fileName !== "string" || !attachment.fileName || attachment.fileName.length > 255
                || typeof attachment.mimeType !== "string" || !attachment.mimeType || attachment.mimeType.length > 128
                || !Number.isSafeInteger(attachment.fileSize) || Number(attachment.fileSize) < 0 || Number(attachment.fileSize) > 5 * 1024 * 1024
                || typeof attachment.storageId !== "string" || !/^r2room:\/\/(?:0x)?[0-9a-fA-F]{1,64}\/[0-9a-f-]{36}$/i.test(attachment.storageId)
                || normalizeAddress(attachment.storageId.slice("r2room://".length).split("/")[0] ?? "") !== normalizeAddress(page.groupId as string)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room history client returned invalid attachment metadata.");
            return { fileName: attachment.fileName, mimeType: attachment.mimeType, fileSize: attachment.fileSize, storageId: attachment.storageId };
        });
        if (content.attachmentMetadataStatus === "none" && (content.attachmentCount !== 0 || content.attachmentIntegrity !== "none" || attachments.length !== 0)
            || content.attachmentMetadataStatus === "verified" && (content.attachmentIntegrity !== "verified" || content.attachmentCount !== attachments.length || attachments.length === 0)
            || content.attachmentMetadataStatus === "unavailable" && (content.attachmentCount === 0 || attachments.length !== 0)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room history attachment integrity state is inconsistent.");
        let attribution: Record<string, unknown> | undefined;
        if (content.attribution !== undefined) {
            if (content.attributionIntegrity !== "verified" || !content.attribution || typeof content.attribution !== "object" || Array.isArray(content.attribution)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room history attribution is not signature-verified.");
            const rawAttribution = content.attribution as Record<string, unknown>;
            const allowed = new Set(["principalOwner", "subAgentId", "identityClass"]);
            if (Object.keys(rawAttribution).length < 1 || Object.keys(rawAttribution).some((key) => !allowed.has(key))
                || (rawAttribution.principalOwner !== undefined && (typeof rawAttribution.principalOwner !== "string" || !normalizeAddress(rawAttribution.principalOwner)))
                || (rawAttribution.subAgentId !== undefined && (typeof rawAttribution.subAgentId !== "string" || !normalizeAddress(rawAttribution.subAgentId)))
                || (rawAttribution.identityClass !== undefined && ![0, 1, 2].includes(Number(rawAttribution.identityClass)))) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room history attribution fields are invalid.");
            attribution = rawAttribution;
        }
        if (content.isAgentMessage && content.attributionIntegrity !== "verified") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "An agent message lacks verified signed attribution.");
        const size = Buffer.byteLength(content.text, "utf8");
        if (size > 1024 * 1024 || bytes + size > 4 * 1024 * 1024) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room history page exceeds the plaintext response limit.");
        bytes += size;
        return { messageId: entry.messageId, order: entry.order, status, content: { text: content.text, ...(content.kind === undefined ? {} : { kind: content.kind }), senderAddress: content.senderAddress, attachmentIntegrity: content.attachmentIntegrity, attachmentCount: content.attachmentCount, attachmentMetadataStatus: content.attachmentMetadataStatus, attachments, attributionIntegrity: content.attributionIntegrity, isAgentMessage: content.isAgentMessage, ...(attribution ? { attribution } : {}) } };
    });
    const cursor = page.nextCursor;
    if (cursor !== null) {
        if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room history cursor is invalid.");
        const value = cursor as Record<string, unknown>;
        if (Object.keys(value).length < 1 || Object.keys(value).length > 2 || Object.keys(value).some((key) => !["afterOrder", "beforeOrder"].includes(key)) || Object.values(value).some((order) => !validRoomSequence(order))) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room history cursor is invalid.");
    }
    if (page.hasNext && (!clean.length || cursor === null)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room history page did not advance its cursor.");
    return { groupId: page.groupId, entries: clean, hasNext: page.hasNext, nextCursor: cursor, allContentVerified: clean.length > 0 && clean.every((entry) => entry.status === "verified_content"), metadataSource: "relayer_unverified" };
}

export interface SponsoredSocialGatewayOptions {
    workJournal?: WorkJournalClient;
    privateData?: MyDataContentClient;
    roomHistory?: RoomHistoryClient;
    messagingRelayerUrl?: string;
    signer: AgentSigner;
    accountId: string;
    serverUrl: string;
    platformId?: string;
    /** Optional deployment pin checked against authenticated agent context. */
    network?: MySoNetwork;
    /** Optional deployment pin checked against authenticated agent context. */
    rpcUrl?: string;
    /** Optional object-id pins checked against authenticated agent context. */
    chain?: Partial<SocialChainConfig>;
    fetch?: typeof globalThis.fetch;
}

const SUPPORTED_SOCIAL_TOOLS = [
    ...PROFILE_SUBSCRIPTION_ACTION_IDS.map(id=>id.replace(/\.v1$/,"").replaceAll(".","_")),
    "access_share_mydata",
    "access_revoke_mydata_share",
    ...MARKET_ACTION_TOOLS.map((entry) => entry.name),
    ...PLATFORM_TOOLS.map((entry) => entry.name),
    "chain_list_actions",
    "account_configure_multisig",
    "social_create_post",
    "social_create_comment",
    "social_react_post",
    "social_react_comment",
    "social_create_repost",
    "social_remove_post_reaction",
    "social_remove_comment_reaction",
    "social_edit_post",
    "social_edit_comment",
    "social_remove_repost",
    "social_follow_profile",
    "social_unfollow_profile",
    "social_block_profile",
    "social_unblock_profile",
    "payments_send_token",
    "governance_vote",
    "governance_delegate_vote",
    "assets_transfer_object",
    "assets_burn_object",
    "payments_tip_post",
    "social_delete_post",
    "social_delete_comment",
    "messaging_send_message",
    "messaging_create_group",
    "messaging_bind_room_to_task",
    "messaging_list_inbox",
    "messaging_list_rooms",
    "messaging_get_room_history",
    "messaging_get_room_attachment",
    "messaging_send_room_message",
    "messaging_list_reactions",
    "messaging_add_reaction",
    "messaging_remove_reaction",
    "messaging_get_room_receipts",
    "messaging_update_room_receipts",
    "messaging_edit_message",
    "messaging_delete_message",
    "messaging_remove_members_rotate_key",
    "messaging_revoke_member_from_all_rooms",
    "messaging_add_room_members",
    "messaging_leave_group",
    "messaging_set_room_name",
    "messaging_archive_group",
    "messaging_get_read_state",
    "messaging_update_read_state",
    "messaging_get_unread_counts",
    "messaging_wait_for_message",
    "organization_get_control",
    "organization_accept_invitation",
    "organization_decline_invitation",
    "agent_register_child",
    "agent_update_child",
    "agent_deactivate_child",
    "agent_revoke_child",
    "agent_admin_request_revoke",
    "agent_admin_request_grant_capability",
    "agent_admin_request_revoke_capability",
    "agent_admin_request_raise_spending_limit",
    "agent_admin_request_lower_spending_limit",
    "organization_create",
    "organization_update_metadata",
    "organization_update_category",
    "organization_deactivate",
    "organization_ensure_memory_group",
    "organization_define_role",
    "organization_assign_role",
    "organization_revoke_role",
    "organization_create_invitation",
    "agent_provision_signer",
    "agent_register_root",
    "chain_get_action_status",
    "chain_request_action_approval",
    "chain_approve_action",
    "chain_prepare_approved_action",
    "chain_submit_approved_action",
] as const;

function bytesToHex(value: Uint8Array): string {
    return Buffer.from(value).toString("hex");
}

function coerceRoomSequence(value: unknown): number | undefined | null {
    if (value === undefined) return undefined;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
    if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
        const parsed = BigInt(value);
        return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : null;
    }
    return null;
}
function validRoomSequence(value: unknown): boolean {
    if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0;
    return typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value);
}
function normalizeAddress(value: string): string {
    const hex = value.trim().toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{1,64}$/.test(hex)) return "";
    return `0x${hex.padStart(64, "0")}`;
}

function sanitizeRoomAttachmentResponse(name: string, value: unknown, request: Record<string, unknown>): unknown {
    const invalid = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The encrypted room attachment response failed its integrity checks.");
    const row = requireJsonObject(value, name);
    if (name === "messaging_upload_room_attachment") {
        if (Object.keys(row).sort().join(",") !== ["ciphertextOnly", "contentLength", "idempotentReplay", "sha256Hex", "storage", "storageId", "groupId"].sort().join(",")) throw invalid();
        if (typeof request.groupId !== "string" || typeof request.contentBase64 !== "string") throw invalid();
        const groupId = normalizeAddress(request.groupId);
        const content = Buffer.from(request.contentBase64, "base64");
        if (!groupId || content.length < 1 || content.length > 5 * 1024 * 1024 || content.toString("base64") !== request.contentBase64) throw invalid();
        const digest = createHash("sha256").update(content).digest("hex");
        const storageId = row.storageId;
        if (row.storage !== "cloudflare_r2" || row.ciphertextOnly !== true || row.contentLength !== content.length || row.sha256Hex !== digest || typeof row.idempotentReplay !== "boolean" || row.idempotentReplay && typeof request.idempotencyKey !== "string" || typeof row.groupId !== "string" || normalizeAddress(row.groupId) !== groupId || typeof storageId !== "string" || !storageId.startsWith("r2room://") || normalizeAddress(storageId.slice("r2room://".length).split("/")[0] ?? "") !== groupId || !/^r2room:\/\/(?:0x)?[0-9a-fA-F]{1,64}\/[0-9a-f-]{36}$/i.test(storageId)) throw invalid();
        return row;
    }
    if (Object.keys(row).sort().join(",") !== ["ciphertextOnly", "contentBase64", "contentLength", "sha256Hex", "storage", "storageId", "groupId"].sort().join(",") || typeof request.storageId !== "string") throw invalid();
    const match = /^r2room:\/\/(0x)?([0-9a-fA-F]{1,64})\/([0-9a-f-]{36})$/i.exec(request.storageId);
    const groupId = match ? normalizeAddress(`${match[1] ?? ""}${match[2]}`) : "";
    if (!match || !groupId || row.storageId !== request.storageId || typeof row.groupId !== "string" || normalizeAddress(row.groupId) !== groupId || row.storage !== "cloudflare_r2" || row.ciphertextOnly !== true || typeof row.contentBase64 !== "string") throw invalid();
    const content = Buffer.from(row.contentBase64, "base64");
    if (content.length < 1 || content.length > 5 * 1024 * 1024 || content.toString("base64") !== row.contentBase64 || row.contentLength !== content.length || row.sha256Hex !== createHash("sha256").update(content).digest("hex")) throw invalid();
    return row;
}

export function sanitizeOwnerRotationRead(name: string, value: unknown, args: Record<string, unknown>, identity: { accountId?: string } = {}): unknown {
    const row = requireJsonObject(value, name);
    const invalid = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The owner migration reader returned malformed or inconsistent chain evidence.");
    const exactFields = (expected: readonly string[]): void => {
        const actual = Object.keys(row).sort();
        const fields = [...expected].sort();
        if (actual.length !== fields.length || actual.some((key, index) => key !== fields[index])) throw invalid();
    };
    const address = (field: string): string => {
        const raw = row[field];
        if (typeof raw !== "string" || !normalizeAddress(raw)) throw invalid();
        return raw;
    };
    const bindAccount = (): void => {
        const accountId = address("accountId");
        if (identity.accountId && normalizeAddress(accountId) !== normalizeAddress(identity.accountId)) throw invalid();
    };
    const decimal = (field: string): void => {
        if (typeof row[field] !== "string" || !/^(0|[1-9][0-9]*)$/.test(row[field] as string)) throw invalid();
    };
    const uniqueIds = (field: string): string[] => {
        const raw = row[field];
        if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string" || !normalizeAddress(item))) throw invalid();
        const normalized = raw.map((item) => normalizeAddress(item as string));
        if (new Set(normalized).size !== normalized.length) throw invalid();
        return raw as string[];
    };
    if (name === "agent_admin_owner_rotation_manifest") {
        exactFields(["kind", "accountId", "owner", "profileId", "tableCount", "items", "hasNextPage", "nextCursor", "evidenceSource"]);
        if (row.kind !== args.state || !["agents", "organizations"].includes(String(row.kind)) || row.evidenceSource !== "configured_fullnode") throw invalid();
        bindAccount(); address("owner"); address("profileId"); decimal("tableCount");
        const items = uniqueIds("items");
        if (typeof row.hasNextPage !== "boolean" || (row.hasNextPage ? typeof row.nextCursor !== "string" || !normalizeAddress(row.nextCursor) : row.nextCursor !== null)) throw invalid();
        if (row.hasNextPage && (!items.length || normalizeAddress(row.nextCursor as string) === normalizeAddress(String(args.cursor ?? "")))) throw invalid();
        if (items.length > Number(args.limit ?? 50)) throw invalid();
        return row;
    }
    if (name === "agent_admin_owner_rotation_status") {
        if (row.evidenceSource !== "configured_fullnode_live_dynamic_field" || typeof row.pending !== "boolean") throw invalid();
        exactFields(row.pending
            ? ["accountId", "pending", "oldOwner", "newOwner", "agentCount", "organizationCount", "updatedAgentCount", "updatedOrganizationCount", "proposedAtMs", "evidenceSource"]
            : ["accountId", "pending", "evidenceSource"]);
        bindAccount();
        if (row.pending) {
            address("oldOwner"); address("newOwner");
            if (normalizeAddress(row.oldOwner as string) === normalizeAddress(row.newOwner as string)) throw invalid();
            for (const field of ["agentCount", "organizationCount", "updatedAgentCount", "updatedOrganizationCount", "proposedAtMs"]) decimal(field);
        } else if (["oldOwner", "newOwner", "agentCount", "organizationCount", "updatedAgentCount", "updatedOrganizationCount", "proposedAtMs"].some((field) => field in row)) throw invalid();
        return row;
    }
    if (name === "agent_admin_owner_rotation_progress") {
        exactFields(["state", "accountId", "oldOwner", "newOwner", "updatedCount", "items", "hasNextPage", "nextCursor", "evidenceSource"]);
        if (row.state !== args.state || !["agents", "organizations"].includes(String(row.state)) || row.evidenceSource !== "configured_fullnode_live_dynamic_field") throw invalid();
        bindAccount(); address("oldOwner"); address("newOwner"); decimal("updatedCount");
        const items = uniqueIds("items");
        if (typeof row.hasNextPage !== "boolean" || (row.hasNextPage ? typeof row.nextCursor !== "string" || !normalizeAddress(row.nextCursor) : row.nextCursor !== null)) throw invalid();
        if (row.hasNextPage && (!items.length || normalizeAddress(row.nextCursor as string) === normalizeAddress(String(args.cursor ?? "")))) throw invalid();
        if (items.length > Number(args.limit ?? 50)) throw invalid();
        return row;
    }
    if (name === "agent_admin_owner_rotation_receipt") {
        const requestedDigest = args.id;
        if (typeof row.digest !== "string" || row.digest !== requestedDigest || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(row.digest)) throw invalid();
        bindAccount();
        if (!["failed", "executed", "finalized"].includes(String(row.status))) throw invalid();
        if (row.status === "failed") {
            exactFields(["digest", "accountId", "status", "evidence", "evidenceSource"]);
            if (!Array.isArray(row.evidence) || row.evidence.length !== 0 || row.evidenceSource !== "configured_fullnode_transaction") throw invalid();
            return row;
        }
        if (row.stage === "proposal") {
            exactFields(["digest", "accountId", "status", "stage", "oldOwner", "newOwner", "agentCount", "organizationCount", "proposedAtMs", "evidenceSource"]);
            address("oldOwner"); address("newOwner"); decimal("agentCount"); decimal("organizationCount"); decimal("proposedAtMs");
            if (row.evidenceSource !== "configured_fullnode_scoped_native_event") throw invalid();
        } else if (row.stage === "accepted") {
            exactFields(["digest", "accountId", "profileId", "status", "stage", "oldOwner", "newOwner", "updatedAgentCount", "updatedOrganizationCount", "finalTransactionAgentUpdateCount", "finalTransactionOrganizationUpdateCount", "finalTransactionUniqueReferenceCount", "completionProof", "evidenceSource"]);
            address("profileId"); address("oldOwner"); address("newOwner");
            for (const field of ["updatedAgentCount", "updatedOrganizationCount", "finalTransactionAgentUpdateCount", "finalTransactionOrganizationUpdateCount", "finalTransactionUniqueReferenceCount"]) {
                if (!Number.isSafeInteger(row[field]) && !(typeof row[field] === "string" && /^(0|[1-9][0-9]*)$/.test(row[field]))) throw invalid();
            }
            if (row.completionProof !== "Move accepted owner rotation only after every immutable manifest reference was updated" || row.evidenceSource !== "configured_fullnode_scoped_native_events_live_registry_counts_and_move_completion_guard") throw invalid();
        } else throw invalid();
        return row;
    }
    return value;
}

export function sanitizeOrganizationRead(name: string, value: unknown, args: Record<string, unknown>, context?: { organizationId?: string | null }): unknown {
    const fail = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The organization reader returned malformed or inconsistent data.");
    const expectedOrganization = context?.organizationId;
    const rows = (expected: readonly string[], validate: (row: Record<string, unknown>) => void): unknown[] => {
        if (!expectedOrganization || !normalizeAddress(expectedOrganization) || !Array.isArray(value) || value.length > Number(args.limit ?? 20) || value.length > 100) throw fail();
        return value.map((raw) => {
            const row = requireJsonObject(raw, name);
            const actual = Object.keys(row).sort();
            const required = [...expected].sort();
            if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) throw fail();
            validate(row);
            const hasOrganization = Object.hasOwn(row, "organization_id") || Object.hasOwn(row, "organizationId");
            const rowOrganization = Object.hasOwn(row, "organization_id") ? row.organization_id : row.organizationId;
            if (hasOrganization && (typeof rowOrganization !== "string" || normalizeAddress(rowOrganization) !== normalizeAddress(expectedOrganization))) throw fail();
            return row;
        });
    };
    const text = (row: Record<string, unknown>, key: string, max = 2048): void => {
        if (typeof row[key] !== "string" || !(row[key] as string).length || (row[key] as string).length > max) throw fail();
    };
    const optionalText = (row: Record<string, unknown>, key: string, max = 2048): void => {
        if (row[key] !== null && row[key] !== undefined) text(row, key, max);
    };
    const integer = (row: Record<string, unknown>, key: string): void => {
        if (!Number.isSafeInteger(row[key])) throw fail();
    };
    const optionalInteger = (row: Record<string, unknown>, key: string): void => {
        if (row[key] !== null && row[key] !== undefined) integer(row, key);
    };
    const integerOrDecimal = (value: unknown): boolean => Number.isSafeInteger(value)
        || (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value));
    const decimal = (row: Record<string, unknown>, key: string): void => {
        if (typeof row[key] !== "string" || !/^(0|[1-9][0-9]*)$/.test(row[key] as string) || BigInt(row[key] as string) > 9_223_372_036_854_775_807n) throw fail();
    };
    const optionalDecimal = (row: Record<string, unknown>, key: string): void => {
        if (row[key] !== null && row[key] !== undefined) decimal(row, key);
    };
    const address = (row: Record<string, unknown>, key: string): void => {
        const raw = row[key];
        if (typeof raw !== "string" || !normalizeAddress(raw)) throw fail();
    };
    const optionalAddress = (row: Record<string, unknown>, key: string): void => {
        if (row[key] !== null && row[key] !== undefined) address(row, key);
    };
    const timestamp = (row: Record<string, unknown>, key: string): void => {
        if (typeof row[key] !== "string" || !Number.isFinite(Date.parse(row[key] as string))) throw fail();
    };
    const timestampNanos = (value: unknown): bigint => {
        if (typeof value !== "string") throw fail();
        const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/.exec(value);
        if (!match) throw fail();
        const epochMs = Date.parse(`${match[1]}${match[3]}`);
        if (!Number.isFinite(epochMs)) throw fail();
        const seconds = BigInt(Math.floor(epochMs / 1000));
        const fraction = BigInt((match[2] ?? "").padEnd(9, "0").slice(0, 9));
        return seconds * 1_000_000_000n + fraction;
    };
    const bool = (row: Record<string, unknown>, key: string): void => {
        if (typeof row[key] !== "boolean") throw fail();
    };
    const commonEvent = (row: Record<string, unknown>): void => {
        text(row, "event_id"); text(row, "transaction_id", 128); timestamp(row, "time");
    };
    switch (name) {
        case "organization_list_messaging_groups": {
            const seen = new Set<string>();
            return rows(["groupId", "creatorActor", "creatorPrincipal", "creatorSubAgentId", "creatorIdentityClass", "organizationId", "groupName", "groupUuid", "createdAtMs", "transactionId"], (row) => {
                address(row, "groupId"); address(row, "creatorActor"); address(row, "creatorPrincipal"); optionalAddress(row, "creatorSubAgentId"); integer(row, "creatorIdentityClass"); optionalAddress(row, "organizationId"); text(row, "groupName", 512); text(row, "groupUuid", 128); integer(row, "createdAtMs"); text(row, "transactionId", 128);
                const groupId = normalizeAddress(row.groupId as string);
                if (!groupId || seen.has(groupId)) throw fail();
                seen.add(groupId);
            });
        }
        case "organization_list_roles": {
            const seen = new Set<string>();
            const result = rows(["organization_id", "role_name", "mask", "is_builtin", "defined_by", "active", "updated_at_ms", "event_id", "transaction_id", "time"], (row) => {
                address(row, "organization_id"); text(row, "role_name", 100); integer(row, "mask"); bool(row, "is_builtin"); address(row, "defined_by"); bool(row, "active"); integer(row, "updated_at_ms"); commonEvent(row);
            });
            for (const item of result) {
                const row = item as Record<string, unknown>;
                if (row.active !== true || seen.has(String(row.role_name))) throw fail();
                seen.add(String(row.role_name));
            }
            return result;
        }
        case "organization_list_role_assignments": {
            let expectedMember: string | undefined;
            if (args.member !== undefined) {
                if (typeof args.member !== "string") throw fail();
                const normalized = normalizeAddress(args.member);
                if (!normalized) throw fail();
                expectedMember = normalized;
            }
            const seen = new Set<string>();
            let previousAssignedAt: number | undefined;
            const result = rows(["organization_id", "member_address", "role_name", "role_mask", "assigned_mask", "active", "assigned_by", "assigned_at_ms", "revoked_at_ms", "event_id", "transaction_id", "time"], (row) => {
                address(row, "organization_id"); address(row, "member_address"); text(row, "role_name", 100); integer(row, "role_mask"); integer(row, "assigned_mask"); bool(row, "active"); address(row, "assigned_by"); integer(row, "assigned_at_ms"); optionalInteger(row, "revoked_at_ms"); commonEvent(row);
            });
            for (const item of result) {
                const row = item as Record<string, unknown>;
                if (typeof row.member_address !== "string") throw fail();
                const member = normalizeAddress(row.member_address);
                const assignedAt = Number(row.assigned_at_ms);
                if (!member || expectedMember !== undefined && member !== expectedMember || (args.active_only ?? true) && row.active !== true) throw fail();
                const key = `${member}:${String(row.role_name)}`;
                if (seen.has(key) || previousAssignedAt !== undefined && previousAssignedAt < assignedAt) throw fail();
                seen.add(key);
                previousAssignedAt = assignedAt;
            }
            return result;
        }
        case "organization_list_invitations": {
            let expectedInvitee: string | undefined;
            if (args.member !== undefined) {
                if (typeof args.member !== "string") throw fail();
                const normalized = normalizeAddress(args.member);
                if (!normalized) throw fail();
                expectedInvitee = normalized;
            }
            const seen = new Set<string>();
            let previous: Record<string, unknown> | undefined;
            const result = rows(["organization_id", "invitee_address", "role_name", "permissions_mask", "status", "invited_by", "created_at_ms", "expires_at_ms", "responded_at_ms", "responded_by", "granted_mask", "event_id", "transaction_id", "time"], (row) => {
                address(row, "organization_id"); address(row, "invitee_address"); optionalText(row, "role_name", 100); integer(row, "permissions_mask");
                if (!["pending", "accepted", "declined"].includes(String(row.status))) throw fail();
                address(row, "invited_by"); integer(row, "created_at_ms"); optionalInteger(row, "expires_at_ms"); optionalInteger(row, "responded_at_ms"); optionalAddress(row, "responded_by"); optionalInteger(row, "granted_mask"); commonEvent(row);
            });
            for (const item of result) {
                const row = item as Record<string, unknown>;
                if (typeof row.invitee_address !== "string") throw fail();
                const invitee = normalizeAddress(row.invitee_address);
                if (!invitee || seen.has(invitee) || expectedInvitee !== undefined && invitee !== expectedInvitee || (args.active_only ?? true) && row.status !== "pending") throw fail();
                seen.add(invitee);
                if (previous) {
                    const previousCreated = Number(previous.created_at_ms);
                    const currentCreated = Number(row.created_at_ms);
                    if (previousCreated < currentCreated || previousCreated === currentCreated && String(previous.invitee_address) > String(row.invitee_address)) throw fail();
                }
                previous = row;
            }
            return result;
        }
        case "organization_list_memory_permissions": {
            let expectedMember: string | undefined;
            if (args.member !== undefined) {
                if (typeof args.member !== "string") throw fail();
                const normalized = normalizeAddress(args.member);
                if (!normalized) throw fail();
                expectedMember = normalized;
            }
            const seen = new Set<string>();
            let previousKind = -1;
            let previousMember = "";
            const result = rows(["organization_id", "member_address", "permission_kind", "active", "granted_by", "group_id", "event_id", "transaction_id", "time"], (row) => {
                address(row, "organization_id"); address(row, "member_address"); integer(row, "permission_kind"); bool(row, "active"); address(row, "granted_by"); optionalAddress(row, "group_id"); commonEvent(row);
            });
            for (const item of result) {
                const row = item as Record<string, unknown>;
                if (typeof row.member_address !== "string") throw fail();
                const member = normalizeAddress(row.member_address);
                const kind = Number(row.permission_kind);
                if (!member || expectedMember !== undefined && member !== expectedMember || (args.active_only ?? true) && row.active !== true) throw fail();
                const key = `${member}:${kind}`;
                if (seen.has(key) || kind < previousKind || kind === previousKind && member < previousMember) throw fail();
                seen.add(key);
                previousKind = kind;
                previousMember = member;
            }
            return result;
        }
        case "organization_list_spend_approvals": {
            let expectedAgent: string | undefined;
            if (args.agent !== undefined) {
                if (typeof args.agent !== "string") throw fail();
                const normalized = normalizeAddress(args.agent);
                if (!normalized) throw fail();
                expectedAgent = normalized;
            }
            let previousUpdatedAt: bigint | undefined;
            let previousAgent = "";
            const result = rows(["balance_id", "agent_object_id", "status", "requested_amount_mist", "threshold_mist", "approval_nonce", "max_amount_mist", "expires_at_ms", "approved_by", "approved_by_agent_id", "organization_id", "consumed_amount_mist", "requested_at", "updated_at", "event_id"], (row) => {
                text(row, "balance_id"); address(row, "agent_object_id"); text(row, "status", 32);
                for (const key of ["requested_amount_mist", "threshold_mist", "max_amount_mist", "consumed_amount_mist"]) optionalDecimal(row, key);
                if (row.approval_nonce !== null && row.approval_nonce !== undefined && !integerOrDecimal(row.approval_nonce)) throw fail();
                optionalInteger(row, "expires_at_ms"); optionalAddress(row, "approved_by"); optionalAddress(row, "approved_by_agent_id"); optionalAddress(row, "organization_id"); timestamp(row, "requested_at"); timestamp(row, "updated_at"); optionalText(row, "event_id");
            });
            for (const item of result) {
                const row = item as Record<string, unknown>;
                if (typeof row.agent_object_id !== "string") throw fail();
                const agent = normalizeAddress(row.agent_object_id);
                const updatedAt = timestampNanos(row.updated_at);
                if (!agent || expectedAgent !== undefined && agent !== expectedAgent || args.status !== undefined && row.status !== args.status) throw fail();
                if (previousUpdatedAt !== undefined && (previousUpdatedAt < updatedAt || previousUpdatedAt === updatedAt && previousAgent > agent)) throw fail();
                previousUpdatedAt = updatedAt;
                previousAgent = agent;
            }
            return result;
        }
        case "organization_list_spend_breakdown": {
            if (!(args.window === undefined || ["7d", "30d", "180d", "365d", "all"].includes(String(args.window)))) throw fail();
            const seen = new Set<string>();
            let previousSpent: bigint | undefined;
            const result = rows(["agent_object_id", "label", "derived_address", "spent_mist", "usage_events", "budget_mist", "require_approval_above_mist", "budget_enabled", "memory_entries", "memory_bytes", "org_shared_memory_entries"], (row) => {
                address(row, "agent_object_id"); text(row, "label", 256); address(row, "derived_address"); decimal(row, "spent_mist"); integer(row, "usage_events"); optionalDecimal(row, "budget_mist"); optionalDecimal(row, "require_approval_above_mist"); bool(row, "budget_enabled"); integer(row, "memory_entries"); integer(row, "memory_bytes"); integer(row, "org_shared_memory_entries");
            });
            for (const item of result) {
                const row = item as Record<string, unknown>;
                if (typeof row.agent_object_id !== "string") throw fail();
                const agent = normalizeAddress(row.agent_object_id);
                const spent = BigInt(row.spent_mist as string);
                if (!agent || seen.has(agent) || [row.usage_events, row.memory_entries, row.memory_bytes, row.org_shared_memory_entries].some((count) => typeof count !== "number" || count < 0)) throw fail();
                if (previousSpent !== undefined && previousSpent < spent) throw fail();
                seen.add(agent);
                previousSpent = spent;
            }
            return result;
        }
        case "organization_list_audit_logs": {
            let expectedActor: string | undefined;
            if (args.actor !== undefined) {
                if (typeof args.actor !== "string") throw fail();
                const normalized = normalizeAddress(args.actor);
                if (!normalized) throw fail();
                expectedActor = normalized;
            }
            const seen = new Set<string>();
            let previousTime: bigint | undefined;
            const result = rows(["id", "time", "source", "actor_address", "actor_type", "action", "target_type", "target_id", "organization_id", "account_id", "prev_state", "new_state", "tx_digest", "event_id", "idempotency_key", "metadata"], (row) => {
                if (!integerOrDecimal(row.id)) throw fail();
                timestamp(row, "time"); text(row, "source", 128); address(row, "actor_address"); text(row, "actor_type", 80); text(row, "action", 120); text(row, "target_type", 80); text(row, "target_id", 256);
                optionalAddress(row, "organization_id"); optionalAddress(row, "account_id");
                for (const key of ["tx_digest", "event_id", "idempotency_key"]) optionalText(row, key, 256);
            });
            for (const item of result) {
                const row = item as Record<string, unknown>;
                const id = String(row.id);
                const actor = typeof row.actor_address === "string" ? normalizeAddress(row.actor_address) : null;
                const time = timestampNanos(row.time);
                if (seen.has(id) || !actor || expectedActor !== undefined && actor !== expectedActor
                    || args.action !== undefined && row.action !== args.action
                    || args.target_type !== undefined && row.target_type !== args.target_type
                    || args.source !== undefined && row.source !== args.source
                    || previousTime !== undefined && previousTime < time) throw fail();
                seen.add(id);
                previousTime = time;
            }
            return result;
        }
        default:
            return value;
    }
}

export function sanitizeAccountMemoryUsage(value: unknown, accountId: string): unknown {
    const fail = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The stored account memory usage is malformed or is not for this account.");
    const row = requireJsonObject(value, "account_get_memory_usage");
    const expected = ["accountId", "agents", "available", "bytes", "entries", "orgSharedEntries", "updatedAt"];
    if (Object.keys(row).sort().join("|") !== expected.join("|")) throw fail();
    const expectedAccount = normalizeAddress(accountId);
    const returnedAccount = typeof row.accountId === "string" ? normalizeAddress(row.accountId) : null;
    if (!expectedAccount || returnedAccount !== expectedAccount || typeof row.available !== "boolean" || !Array.isArray(row.agents) || row.agents.length > 500) throw fail();
    const decimal = (item: unknown): boolean => typeof item === "string" && /^(0|[1-9][0-9]{0,18})$/.test(item) && BigInt(item) <= 9_223_372_036_854_775_807n;
    const time = (item: unknown): boolean => typeof item === "string" && Number.isFinite(Date.parse(item));
    if (!row.available) {
        if (row.updatedAt !== null || row.entries !== null || row.bytes !== null || row.orgSharedEntries !== null || row.agents.length !== 0) throw fail();
        return row;
    }
    if (!time(row.updatedAt) || !decimal(row.entries) || !decimal(row.bytes) || !decimal(row.orgSharedEntries)) throw fail();
    const seen = new Set<string>();
    let entries = 0n;
    let bytes = 0n;
    let shared = 0n;
    let newest = "";
    for (const raw of row.agents) {
        const agent = requireJsonObject(raw, "account_get_memory_usage");
        const fields = ["agentObjectId", "bytes", "entries", "orgSharedEntries", "organizationId", "updatedAt"];
        if (Object.keys(agent).sort().join("|") !== fields.join("|")) throw fail();
        const agentId = typeof agent.agentObjectId === "string" ? normalizeAddress(agent.agentObjectId) : null;
        if (!agentId || seen.has(agentId) || !decimal(agent.entries) || !decimal(agent.bytes) || !decimal(agent.orgSharedEntries) || !time(agent.updatedAt)) throw fail();
        if (agent.organizationId !== null && (typeof agent.organizationId !== "string" || !normalizeAddress(agent.organizationId))) throw fail();
        seen.add(agentId);
        entries += BigInt(agent.entries as string);
        bytes += BigInt(agent.bytes as string);
        shared += BigInt(agent.orgSharedEntries as string);
        if (String(agent.updatedAt) > newest) newest = String(agent.updatedAt);
    }
    if (entries !== BigInt(row.entries as string) || bytes !== BigInt(row.bytes as string) || shared !== BigInt(row.orgSharedEntries as string) || newest !== row.updatedAt) throw fail();
    return row;
}

export function sanitizeAiCreditRead(name: string, value: unknown, args: Record<string, unknown>, expectedOwner: string): unknown {
    const fail = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The AI-credit reader returned malformed or inconsistent data.");
    // Core's indexed AI-credit DTOs use PostgreSQL BIGINT/i64 for every
    // decimal quantity; do not accept values that cannot exist in that source.
    const maxI64 = 9_223_372_036_854_775_807n;
    const decimal = (value: unknown, optional = false): boolean => (optional && value === null)
        || (typeof value === "string" && value.length <= 19 && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= maxI64);
    const int = (value: unknown, optional = false): boolean => (optional && value === null)
        || Number.isSafeInteger(value);
    const text = (value: unknown, optional = false, max = 2048): boolean => (optional && value === null)
        || (typeof value === "string" && value.length > 0 && value.length <= max);
    const addr = (value: unknown, optional = false): boolean => (optional && value === null)
        || (typeof value === "string" && !!normalizeAddress(value));
    const time = (value: unknown): boolean => typeof value === "string" && Number.isFinite(Date.parse(value));
    const instantNanos = (value: string): bigint => {
        const match=/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/.exec(value);
        if(!match)return BigInt(Date.parse(value))*1_000_000n;
        const epochMs=Date.parse(`${match[1]}${match[3]}`);
        if(!Number.isFinite(epochMs))throw fail();
        const seconds=BigInt(Math.floor(epochMs/1000));
        const fraction=BigInt((match[2]??"").padEnd(9,"0").slice(0,9));
        return seconds*1_000_000_000n+fraction;
    };
    const obj = (raw: unknown, expected: readonly string[]): Record<string, unknown> => {
        const row = requireJsonObject(raw, name);
        const keys = Object.keys(row).sort(), expectedKeys = [...expected].sort();
        if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) throw fail();
        return row;
    };
    const page = (expected: readonly string[], validate: (row: Record<string, unknown>) => void): unknown[] => {
        if (!Array.isArray(value) || value.length > Math.min(Number(args.limit ?? 20), 200)) throw fail();
        return value.map((raw) => { const row = obj(raw, expected); validate(row); return row; });
    };
    const eventFields = (row: Record<string, unknown>, eventKey: string, transactionKey: string, timeKey = "time"): void => {
        if (!text(row[eventKey]) || !text(row[transactionKey], false, 128) || !time(row[timeKey])) throw fail();
    };
    const balanceFields = ["balance_id", "memory_account_id", "principal_owner", "profile_id", "balance_mist", "spent_total_mist", "reserved_mist", "daily_cap_mist", "monthly_cap_mist", "spent_day_mist", "spent_month_mist", "settlement_nonce", "reservation_nonce", "active", "contract_version", "updated_at_ms", "event_id", "transaction_id", "time"] as const;
    const budgetFields = ["balance_id", "agent_object_id", "budget_mist", "spent_mist", "reserved_mist", "daily_cap_mist", "monthly_cap_mist", "require_approval_above_mist", "enabled", "updated_at_ms", "event_id", "transaction_id", "time"] as const;
    const reservationFields = ["balance_id", "reservation_nonce", "agent_object_id", "status", "max_amount_mist", "captured_mist", "released_mist", "provider_envelope_hash_hex", "request_hash_hex", "fx_quote_id_hex", "myso_usd_e8", "markup_bps", "provider_cost_usd_micros", "provider_generation_hash_hex", "capture_deadline_ms", "hard_expiry_ms", "available_mist", "reserve_event_id", "reserve_transaction_id", "terminal_event_id", "terminal_transaction_id", "terminal_at_ms", "created_at", "updated_at"] as const;
    const approvalFields = ["balance_id", "agent_object_id", "status", "requested_amount_mist", "threshold_mist", "approval_nonce", "max_amount_mist", "expires_at_ms", "approved_by", "approved_by_agent_id", "organization_id", "consumed_amount_mist", "requested_at", "updated_at", "event_id"] as const;
    const checkReservation = (raw: unknown): Record<string, unknown> => {
        const row = obj(raw, reservationFields);
        if (!text(row.balance_id) || !int(row.reservation_nonce) && !decimal(row.reservation_nonce)
            || BigInt(String(row.reservation_nonce)) < 0n
            || !addr(row.agent_object_id) || !["reserved", "captured", "cancelled", "expired"].includes(String(row.status))
            || !decimal(row.max_amount_mist) || !decimal(row.captured_mist, true) || !decimal(row.released_mist, true)
            || !/^[0-9a-f]{64}$/.test(String(row.provider_envelope_hash_hex)) || !/^[0-9a-f]{64}$/.test(String(row.request_hash_hex))
            || !/^[0-9a-f]{64}$/.test(String(row.fx_quote_id_hex)) || !int(row.myso_usd_e8) && !decimal(row.myso_usd_e8)
            || !int(row.markup_bps) && !decimal(row.markup_bps) || !decimal(row.provider_cost_usd_micros, true)
            || !text(row.provider_generation_hash_hex, true, 64) || !int(row.capture_deadline_ms) && !decimal(row.capture_deadline_ms)
            || !int(row.hard_expiry_ms) && !decimal(row.hard_expiry_ms) || !decimal(row.available_mist)
            || !text(row.reserve_event_id) || !text(row.reserve_transaction_id, false, 128)
            || !text(row.terminal_event_id, true) || !text(row.terminal_transaction_id, true, 128)
            || !int(row.terminal_at_ms, true) && !decimal(row.terminal_at_ms, true)
            || !time(row.created_at) || !time(row.updated_at)) throw fail();
        return row;
    };
    if (name === "ai_get_balance") {
        const root = requireJsonObject(value, name);
        const expected = ["balance", "billing_unit", "available_mist", "agent_budgets", "active_reservations"];
        if (Object.keys(root).sort().join("|") !== [...expected].sort().join("|") || root.billing_unit !== "MIST"
            || !decimal(root.available_mist) || !Array.isArray(root.agent_budgets) || root.agent_budgets.length > 500
            || !Array.isArray(root.active_reservations) || root.active_reservations.length > 100) throw fail();
        const balance = obj(root.balance, balanceFields);
        for (const key of ["balance_mist", "spent_total_mist", "reserved_mist", "spent_day_mist", "spent_month_mist", "daily_cap_mist", "monthly_cap_mist"]) {
            if (!decimal(balance[key], key === "daily_cap_mist" || key === "monthly_cap_mist")) throw fail();
        }
        for (const key of ["settlement_nonce", "reservation_nonce", "contract_version", "updated_at_ms"]) if (!int(balance[key]) && !decimal(balance[key])) throw fail();
        for (const key of ["balance_id", "memory_account_id", "profile_id"]) if (!text(balance[key])) throw fail();
        const balanceOwner = typeof balance.principal_owner === "string" ? normalizeAddress(balance.principal_owner) : null;
        const authenticatedOwner = normalizeAddress(expectedOwner);
        if (!addr(balance.principal_owner) || !balanceOwner || !authenticatedOwner || balanceOwner !== authenticatedOwner
            || typeof balance.active !== "boolean") throw fail();
        eventFields(balance, "event_id", "transaction_id");
        const budgetAgentIds = new Set<string>();
        for (const raw of root.agent_budgets) {
            const row = obj(raw, budgetFields);
            for (const key of ["balance_id", "event_id"]) if (!text(row[key])) throw fail();
            if (row.balance_id !== balance.balance_id) throw fail();
            if (!addr(row.agent_object_id) || typeof row.enabled !== "boolean") throw fail();
            const agentId = normalizeAddress(row.agent_object_id as string);
            if (!agentId || budgetAgentIds.has(agentId)) throw fail();
            budgetAgentIds.add(agentId);
            for (const key of ["budget_mist", "spent_mist", "reserved_mist", "daily_cap_mist", "monthly_cap_mist", "require_approval_above_mist"]) if (!decimal(row[key], key !== "spent_mist" && key !== "reserved_mist")) throw fail();
            for (const key of ["updated_at_ms"]) if (!int(row[key])) throw fail();
            eventFields(row, "event_id", "transaction_id");
        }
        const reservationNonces = new Set<string>();let priorActiveNonce:bigint|undefined;
        for (const raw of root.active_reservations) {
            const row = checkReservation(raw);
            const nonce = BigInt(String(row.reservation_nonce));
            if (row.balance_id !== balance.balance_id || row.status !== "reserved" || reservationNonces.has(nonce.toString())
                || priorActiveNonce!==undefined&&nonce>=priorActiveNonce) throw fail();
            reservationNonces.add(nonce.toString());priorActiveNonce=nonce;
        }
        return root;
    }
    if (name === "ai_list_approvals") {
        let expectedAgent: string | undefined;
        if (args.agent !== undefined) {
            if (typeof args.agent !== "string") throw fail();
            const normalized = normalizeAddress(args.agent);
            if (!normalized) throw fail();
            expectedAgent = normalized;
        }
        const seen = new Set<string>();
        let previousTime: bigint | undefined;
        let previousAgent = "";
        return page(approvalFields, (row) => {
            if (!text(row.balance_id) || !addr(row.agent_object_id) || !["requested", "approved", "consumed", "revoked", "expired"].includes(String(row.status))) throw fail();
            for (const key of ["requested_amount_mist", "threshold_mist", "max_amount_mist", "consumed_amount_mist"]) if (!decimal(row[key], true)) throw fail();
            if (row.approval_nonce !== null && !int(row.approval_nonce) && !decimal(row.approval_nonce)) throw fail();
            if (!int(row.expires_at_ms, true) && !decimal(row.expires_at_ms, true)) throw fail();
            for (const key of ["approved_by", "approved_by_agent_id", "organization_id"]) if (!addr(row[key], true)) throw fail();
            if (!time(row.requested_at) || !time(row.updated_at) || !text(row.event_id, true)) throw fail();
            const agent = normalizeAddress(row.agent_object_id as string);
            const updatedAt = instantNanos(String(row.updated_at));
            if (!agent || expectedAgent !== undefined && agent !== expectedAgent || args.status !== undefined && row.status !== args.status) throw fail();
            const key = `${String(row.balance_id)}:${agent}`;
            if (seen.has(key) || previousTime !== undefined && (previousTime < updatedAt || previousTime === updatedAt && previousAgent > agent)) throw fail();
            seen.add(key);
            previousTime = updatedAt;
            previousAgent = agent;
        });
    }
    if (name === "ai_list_usage") {
        const seenIds = new Set<string>(), seenReceipts = new Set<string>();
        let balanceId: string | undefined;
        let priorTime:bigint|undefined, priorId: bigint | undefined;
        return page(["id", "receipt_id", "balance_id", "agent_object_id", "usage_kind", "amount_mist", "model_id", "tool_id", "metadata", "settled", "settlement_tx", "created_at", "organization_id"], (row) => {
        if (!int(row.id) && !decimal(row.id) || !text(row.receipt_id) || !text(row.balance_id) || !addr(row.agent_object_id)
            || !int(row.usage_kind) || ![1, 2, 3].includes(Number(row.usage_kind)) || !decimal(row.amount_mist) || !text(row.model_id, true, 256) || !text(row.tool_id, true, 256)
            || typeof row.settled !== "boolean" || !text(row.settlement_tx, true, 128) || !time(row.created_at) || !addr(row.organization_id, true)) throw fail();
        if (balanceId !== undefined && row.balance_id !== balanceId) throw fail();
        balanceId = String(row.balance_id);
        if (row.id !== null && row.id !== undefined) {
            const id=BigInt(String(row.id));
            const created=instantNanos(String(row.created_at));
            if(id<=0n||seenIds.has(id.toString())||seenReceipts.has(String(row.receipt_id))||priorTime!==undefined&&created>priorTime||created===priorTime&&priorId!==undefined&&id>=priorId) throw fail();
            seenIds.add(id.toString());seenReceipts.add(String(row.receipt_id));priorTime=created;priorId=id;
        }
        if(row.metadata!==null&&row.metadata!==undefined){
            if(!row.metadata||typeof row.metadata!=="object"||Array.isArray(row.metadata)||Object.keys(row.metadata as object).length>64)throw fail();
            const encoded=JSON.stringify(row.metadata);if(typeof encoded!=="string"||encoded.length>64*1024)throw fail();
        }
        });
    }
    if (name === "ai_list_reservations") {
        let priorNonce:bigint|undefined, balanceId:string|undefined;const seen=new Set<string>();
        return page(reservationFields, (row) => {
            checkReservation(row);
            const nonce=BigInt(String(row.reservation_nonce));
            if(balanceId!==undefined&&balanceId!==row.balance_id||seen.has(nonce.toString())||priorNonce!==undefined&&nonce>=priorNonce||args.status!==undefined&&row.status!==args.status)throw fail();
            balanceId=String(row.balance_id);seen.add(nonce.toString());priorNonce=nonce;
        });
    }
    if (name === "ai_get_reservation") {
        const row = checkReservation(value);
        if (String(row.reservation_nonce) !== String(args.reservation_nonce)) throw fail();
        return row;
    }
    return value;
}

export function sanitizeGraphOfferPage(value: unknown, args: Record<string, unknown>): unknown {
    const fail = () => new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The MyData graph-offer reader returned malformed or inconsistent data.");
    const root = requireJsonObject(value, "mydata_list_graph_offers");
    const expectedRoot = ["offers", "offset", "scannedCount", "nextOffset", "mediaType"];
    if (Object.keys(root).sort().join("|") !== expectedRoot.sort().join("|")
        || root.mediaType !== "application/vnd.mysocial.graph-offer-preview.v1"
        || !Number.isSafeInteger(root.offset) || !Number.isSafeInteger(root.scannedCount)
        || Number(root.offset) !== Number(args.offset ?? 0)
        || Number(root.scannedCount) < 0 || Number(root.scannedCount) > Number(args.limit ?? 20)
        || !Array.isArray(root.offers) || root.offers.length > Number(root.scannedCount)) throw fail();
    const offset = Number(args.offset ?? 0);
    const limit = Number(args.limit ?? 20);
    const scannedCount = Number(root.scannedCount);
    const expectedNext = scannedCount === limit && offset < 100_000 && offset + scannedCount <= 100_000 ? offset + scannedCount : null;
    if (root.nextOffset !== expectedNext) throw fail();
    let previousCreatedAt: bigint | undefined;
    let previousMyDataId: string | undefined;
    const seenMyDataIds = new Set<string>();
    for (const raw of root.offers) {
        const row = requireJsonObject(raw, "mydata_list_graph_offers");
        const fields = ["mydataId", "owner", "mediaType", "schemaVersion", "tags", "oneTimePriceMist", "subscriptionPriceMist", "subscriptionDurationDays", "createdAt"];
        if (Object.keys(row).sort().join("|") !== fields.sort().join("|")
            || typeof row.mydataId !== "string" || !normalizeAddress(row.mydataId)
            || typeof row.owner !== "string" || !normalizeAddress(row.owner)
            || !["application/vnd.mysocial.knowledge-graph+json;version=1", "application/vnd.mysocial.graph-manifest+json;version=1"].includes(String(row.mediaType))
            || row.schemaVersion !== (row.mediaType === "application/vnd.mysocial.graph-manifest+json;version=1" ? "myso.graph-manifest.v1" : "myso.knowledge-graph.v1")
            || !Array.isArray(row.tags) || row.tags.length > 20 || row.tags.some((tag) => typeof tag !== "string" || tag.length > 80)
            || (row.oneTimePriceMist !== null && (typeof row.oneTimePriceMist !== "string" || !/^(0|[1-9][0-9]*)$/.test(row.oneTimePriceMist)))
            || (row.subscriptionPriceMist !== null && (typeof row.subscriptionPriceMist !== "string" || !/^(0|[1-9][0-9]*)$/.test(row.subscriptionPriceMist)))
            || (row.oneTimePriceMist === null && row.subscriptionPriceMist === null)
            || BigInt(String(row.oneTimePriceMist ?? "0")) === 0n && BigInt(String(row.subscriptionPriceMist ?? "0")) === 0n
            || typeof row.subscriptionDurationDays !== "string" || !/^(0|[1-9][0-9]*)$/.test(row.subscriptionDurationDays)
            || typeof row.createdAt !== "string" || !/^(0|[1-9][0-9]*)$/.test(row.createdAt)) throw fail();
        const maxI64 = 9_223_372_036_854_775_807n;
        const myDataId = normalizeAddress(row.mydataId)!;
        const createdAt = BigInt(row.createdAt as string);
        const oneTimePrice = BigInt(String(row.oneTimePriceMist ?? "0"));
        const subscriptionPrice = BigInt(String(row.subscriptionPriceMist ?? "0"));
        const durationDays = BigInt(row.subscriptionDurationDays as string);
        if (seenMyDataIds.has(myDataId) || createdAt > maxI64 || oneTimePrice > maxI64 || subscriptionPrice > maxI64 || durationDays > maxI64
            || subscriptionPrice > 0n && durationDays === 0n
            || previousCreatedAt !== undefined && (createdAt > previousCreatedAt || createdAt === previousCreatedAt && myDataId < previousMyDataId!)) throw fail();
        seenMyDataIds.add(myDataId);
        previousCreatedAt = createdAt;
        previousMyDataId = myDataId;
    }
    return root;
}

function normalizeRpcUrl(value: string): string {
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Agent context contains an invalid RPC URL.");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Agent context RPC URL must use HTTP or HTTPS.");
    }
    const localHostnames = new Set(["localhost", "127.0.0.1", "::1"]);
    if (parsed.protocol === "http:" && !localHostnames.has(parsed.hostname)) {
        throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Agent context RPC URL must use HTTPS unless it targets localhost.");
    }
    return parsed.toString().replace(/\/$/, "");
}

function parseNetwork(value: unknown): MySoNetwork {
    if (value === "mainnet" || value === "testnet" || value === "devnet" || value === "localnet") {
        return value;
    }
    throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Agent context contains an unsupported network.");
}

function parseChainObject(value: unknown): SocialChainConfig {
    const chain = requireJsonObject(value, "Agent context social chain");
    const fields = [
        "packageId",
        "usernameRegistryId",
        "platformRegistryId",
        "platformObjectId",
        "blockListRegistryId",
        "postConfigId",
        "memoryConfigId",
        "mydataRegistryId",
    ] as const satisfies readonly (keyof SocialChainConfig)[];
    const parsed = {} as SocialChainConfig;
    for (const field of fields) {
        const objectId = chain[field];
        if (typeof objectId !== "string" || !normalizeAddress(objectId)) {
            throw new McpRuntimeError(
                "UPSTREAM_UNAVAILABLE",
                `Agent context social chain is missing a valid ${field}.`,
            );
        }
        parsed[field] = objectId;
    }
    const clockId = chain.clockId;
    if (clockId !== undefined && (typeof clockId !== "string" || !normalizeAddress(clockId))) {
        throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Agent context social chain contains an invalid clockId.");
    }
    parsed.clockId = typeof clockId === "string" ? clockId : "0x6";
    for (const field of [
        "socialGraphId",
        "mydataConfigId",
        "subscriptionConfigId",
        "taskConfigId",
        "juryConfigId",
        "jurorRosterId",
        "ecosystemTreasuryId",
        "pocConfigId",
        "messagingPackageId",
        "messagingVersionId",
        "messagingConfigId",
        "messagingNamespaceId",
        "messagingGroupManagerId",
        "messagingGroupLeaverId",
    ] as const satisfies readonly (keyof SocialChainConfig)[]) {
        const objectId = chain[field];
        if (objectId !== undefined && (typeof objectId !== "string" || !normalizeAddress(objectId))) {
            throw new McpRuntimeError(
                "UPSTREAM_UNAVAILABLE",
                `Agent context social chain contains an invalid ${field}.`,
            );
        }
        if (typeof objectId === "string") parsed[field] = objectId;
    }
    return parsed;
}

function statusError(status: number, body: string): McpRuntimeError {
    const safeDetail = redactSensitiveText(body.trim());
    const suffix = safeDetail ? ` ${safeDetail}` : "";
    if (status === 401) {
        return new McpRuntimeError("AUTHENTICATION_FAILED", `Gateway authentication failed.${suffix}`);
    }
    if (status === 403) {
        if (body.includes("action_approval_required")) {
            return new McpRuntimeError(
                "APPROVAL_FLOW_NOT_AVAILABLE",
                `Owner wallet approval is required.${suffix}`,
                { approvalRequired: true },
            );
        }
        return new McpRuntimeError("CAPABILITY_DENIED", `The agent is not permitted to perform this action.${suffix}`);
    }
    if (status === 404) return new McpRuntimeError("NOT_FOUND", "The scoped record is unavailable.");
    if (status === 409) {
        return new McpRuntimeError("CONFLICT", `The action conflicts with current chain state.${suffix}`);
    }
    if (status === 429) {
        return new McpRuntimeError("RATE_LIMITED", "The sponsorship rate limit was reached.", {
            retryable: true,
        });
    }
    return new McpRuntimeError(
        status >= 500 ? "UPSTREAM_UNAVAILABLE" : "SOCIAL_GATEWAY_UNAVAILABLE",
        `The gateway rejected the request with status ${status}.${suffix}`,
        { retryable: status >= 500 },
    );
}

function requireJsonObject(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `${label} returned an invalid response.`);
    }
    return value as Record<string, unknown>;
}

function parseAgentContext(value: unknown): AgentContextResponse {
    const context = requireJsonObject(value, "Agent context");
    const requiredStrings = ["owner", "memoryAccountId", "agentObjectId", "derivedAddress", "network", "rpcUrl"] as const;
    for (const key of requiredStrings) {
        if (typeof context[key] !== "string" || !context[key]) {
            throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `Agent context is missing ${key}.`);
        }
    }
    if (
        !normalizeAddress(context.memoryAccountId as string) ||
        !normalizeAddress(context.owner as string) ||
        !normalizeAddress(context.agentObjectId as string) ||
        !normalizeAddress(context.derivedAddress as string)
    ) {
        throw new McpRuntimeError(
            "UPSTREAM_UNAVAILABLE",
            "Agent context contains an invalid account or signer address.",
        );
    }
    if (!Number.isSafeInteger(context.capabilities) || !Number.isSafeInteger(context.approvalRequiredCapabilities)) {
        throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Agent context contains an unsafe capability bitmap.");
    }
    const network = parseNetwork(context.network);
    const rpcUrl = normalizeRpcUrl(context.rpcUrl as string);
    const socialChain = parseChainObject(context.socialChain);
    if (
        context.packageId !== undefined &&
        (typeof context.packageId !== "string" ||
            normalizeAddress(context.packageId) !== normalizeAddress(socialChain.packageId))
    ) {
        throw new McpRuntimeError(
            "UPSTREAM_UNAVAILABLE",
            "Agent context packageId does not match its social chain packageId.",
        );
    }
    if (
        context.permittedRegistryActions !== undefined &&
        (!Array.isArray(context.permittedRegistryActions) ||
            !context.permittedRegistryActions.every((action) => typeof action === "string"))
    ) {
        throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Agent context contains an invalid action catalog.");
    }
    if (context.indexers !== undefined && (typeof context.indexers !== "object" || context.indexers === null || Array.isArray(context.indexers)
        || Object.values(context.indexers as Record<string, unknown>).some((available) => typeof available !== "boolean"))) {
        throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Agent context contains invalid indexer compatibility metadata.");
    }
    if (
        context.platformScope !== undefined &&
        context.platformScope !== null &&
        (typeof context.platformScope !== "string" || !normalizeAddress(context.platformScope))
    ) {
        throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Agent context contains an invalid platform scope.");
    }
    return {
        owner: context.owner as string,
        memoryAccountId: context.memoryAccountId as string,
        agentObjectId: context.agentObjectId as string,
        derivedAddress: context.derivedAddress as string,
        capabilities: context.capabilities as number,
        approvalRequiredCapabilities: context.approvalRequiredCapabilities as number,
        platformScope: context.platformScope as string | null | undefined,
        organizationId: typeof context.organizationId === "string" && normalizeAddress(context.organizationId) ? context.organizationId : undefined,
        network,
        rpcUrl,
        packageId: typeof context.packageId === "string" ? context.packageId : undefined,
        socialChain,
        permittedRegistryActions: context.permittedRegistryActions as string[] | undefined,
        indexers: context.indexers as { orderbook?: boolean } | undefined,
    };
}

function parsePreparedAction(
    value: unknown,
    expectedAction: SocialActionId,
    expectedIdempotencyKey: string,
): PreparedActionResponse {
    const prepared = requireJsonObject(value, "Registered action gateway");
    if (
        prepared.registryAction !== expectedAction ||
        prepared.registryVersion !== SOCIAL_ACTION_REGISTRY_VERSION ||
        prepared.idempotencyKey !== expectedIdempotencyKey ||
        typeof prepared.bytes !== "string" ||
        typeof prepared.digest !== "string" ||
        typeof prepared.parameterHash !== "string" ||
        typeof prepared.transactionKindHash !== "string" ||
        typeof prepared.packageId !== "string" ||
        typeof prepared.packageVersion !== "string" ||
        typeof prepared.status !== "string" ||
        !Number.isSafeInteger(prepared.expiresAtMs)
    ) {
        throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Registered action gateway returned incomplete metadata.");
    }
    const decoded = Buffer.from(prepared.bytes, "base64");
    if (decoded.length < 10 || decoded.length > 128 * 1024) {
        throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Registered action gateway returned invalid transaction bytes.");
    }
    if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(prepared.digest as string)) {
        throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Registered action gateway returned an invalid digest.");
    }
    return prepared as unknown as PreparedActionResponse;
}

function parseExecution(value: unknown, expectedDigest: string): SponsorExecuteResponse {
    const execution = requireJsonObject(value, "Sponsor execution");
    if (execution.digest !== expectedDigest) {
        throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Sponsor execution returned an unexpected digest.");
    }
    return { digest: expectedDigest };
}

function capabilityPresent(bitmap: number, capability: number): boolean {
    return (BigInt(bitmap) & BigInt(capability)) === BigInt(capability);
}

function assertAddressPin(label: string, configured: string | undefined, authenticated: string): void {
    if (configured === undefined) return;
    if (!normalizeAddress(configured)) {
        throw new McpRuntimeError("INVALID_CONFIGURATION", `${label} is not a valid object ID.`);
    }
    if (normalizeAddress(configured) !== normalizeAddress(authenticated)) {
        throw new McpRuntimeError(
            "CONFLICT",
            `${label} does not match the authenticated agent context. Refresh or remove the local deployment pin.`,
        );
    }
}

function resolveExecutionContext(
    authenticated: AgentContextResponse,
    pins: Pick<SponsoredSocialGatewayOptions, "network" | "rpcUrl" | "chain">,
): AuthenticatedSocialExecutionContext {
    if (pins.network !== undefined && pins.network !== authenticated.network) {
        throw new McpRuntimeError(
            "CONFLICT",
            "mysoNetwork does not match the authenticated agent context. Refresh or remove the local deployment pin.",
        );
    }
    if (pins.rpcUrl !== undefined && normalizeRpcUrl(pins.rpcUrl) !== authenticated.rpcUrl) {
        throw new McpRuntimeError(
            "CONFLICT",
            "mysoRpcUrl does not match the authenticated agent context. Refresh or remove the local deployment pin.",
        );
    }
    const chainPins = pins.chain;
    if (chainPins) {
        const fields = [
            "packageId",
            "usernameRegistryId",
            "platformRegistryId",
            "platformObjectId",
            "blockListRegistryId",
            "postConfigId",
            "memoryConfigId",
            "mydataRegistryId",
            "clockId",
            "socialGraphId",
            "mydataConfigId",
        "subscriptionConfigId",
            "taskConfigId",
            "juryConfigId",
            "jurorRosterId",
            "ecosystemTreasuryId",
            "pocConfigId",
            "messagingPackageId",
            "messagingVersionId",
            "messagingConfigId",
            "messagingNamespaceId",
            "messagingGroupManagerId",
            "messagingGroupLeaverId",
        ] as const satisfies readonly (keyof SocialChainConfig)[];
        for (const field of fields) {
            const authenticatedValue = authenticated.socialChain[field];
            if (chainPins[field] !== undefined && authenticatedValue === undefined) {
                throw new McpRuntimeError(
                    "CONFLICT",
                    `socialChain.${field} is not configured by the gateway.`,
                );
            }
            assertAddressPin(
                `socialChain.${field}`,
                chainPins[field],
                authenticatedValue ?? (field === "clockId" ? "0x6" : ""),
            );
        }
    }
    return {
        network: authenticated.network as MySoNetwork,
        rpcUrl: authenticated.rpcUrl,
        chain: authenticated.socialChain,
    };
}

/**
 * Executes only hard-coded, versioned Tier 1A/1B action-registry entries.
 * There is no arbitrary action name, Move target, PTB, or direct-sign fallback
 * in the public MCP path. Tier 3 owner actions remain disabled until the
 * wallet-approval workflow is available.
 */
export class SponsoredSocialGateway implements SocialGateway {
    supportedToolNames: readonly string[] = [];
    private readonly workJournal?: WorkJournalClient;
    private readonly privateData?: MyDataContentClient;
    private roomHistory?: RoomHistoryClient;
    private readonly signer: AgentSigner;
    private readonly accountId: string;
    private readonly serverUrl: string;
    private platformId?: string;
    private readonly networkPin?: MySoNetwork;
    private readonly rpcUrlPin?: string;
    private readonly chainPins?: Partial<SocialChainConfig>;
    private readonly fetchImpl: typeof globalThis.fetch;
    private readonly graphPublishPreparations = new Map<string, { inputHash: string; promise: Promise<{ parameters: unknown; manifestHashHex: string; graphId: string; graphVersion: number }> }>();

    constructor(options: SponsoredSocialGatewayOptions) {
        if (!normalizeAddress(options.accountId)) {
            throw new McpRuntimeError(
                "INVALID_CONFIGURATION",
                "accountId must be a valid MySo object ID.",
            );
        }
        this.workJournal = options.workJournal;
        this.privateData = options.privateData;
        this.roomHistory = options.roomHistory;
        this.signer = options.signer;
        this.accountId = options.accountId;
        this.serverUrl = options.serverUrl.replace(/\/$/, "");
        this.platformId = options.platformId;
        this.networkPin = options.network;
        this.rpcUrlPin = options.rpcUrl;
        this.chainPins = options.chain;
        this.fetchImpl = options.fetch ?? globalThis.fetch;
        if (options.messagingRelayerUrl) this.enableRoomMessaging(options.messagingRelayerUrl);
        else this.refreshSupportedToolNames();
    }

    enableRoomMessaging(relayerUrl: string): void {
        this.roomHistory = new McpRoomMessagingClient(
            this.signer,
            relayerUrl,
            () => this.getExecutionContext(),
            (method, path, body) => this.signedJson(method, path, body),
        );
        this.refreshSupportedToolNames();
    }

    private refreshSupportedToolNames(): void {
        const roomHistory = this.roomHistory;
        this.supportedToolNames = SUPPORTED_SOCIAL_TOOLS.filter((name) => (!name.startsWith("work_run_") || !!this.workJournal) && (!name.startsWith("mydata_") || !["mydata_read_content", "mydata_search_graph", "mydata_get_graph_item", "mydata_verify_graph_offer", "mydata_check_current_access"].includes(name) || !!this.privateData) && (name !== "mydata_check_current_access" || !!this.privateData?.checkCurrentMyDataAccess) && (name !== "mydata_search_graph" || !!this.privateData?.searchMyDataGraph) && (name !== "mydata_get_graph_item" || !!this.privateData?.getMyDataGraphItem) && (name !== "mydata_verify_graph_offer" || !!this.privateData?.verifyMyDataGraphOffer) && (name !== "messaging_list_rooms" || !!roomHistory?.listRoomConversations) && (name !== "messaging_revoke_member_from_all_rooms" || (!!roomHistory?.listRoomConversations && !!roomHistory?.removeRoomMembersAndRotateKey)) && (name !== "messaging_get_room_history" || !!roomHistory) && (name !== "messaging_get_room_attachment" || !!roomHistory?.readRoomAttachment) && (name !== "messaging_send_room_message" || !!roomHistory?.sendRoomMessage) && (name !== "messaging_list_reactions" || !!roomHistory?.listRoomReactions) && (!["messaging_add_reaction", "messaging_remove_reaction"].includes(name) || !!roomHistory?.changeRoomReaction) && (name !== "messaging_get_room_receipts" || !!roomHistory?.getRoomReceipts) && (name !== "messaging_update_room_receipts" || !!roomHistory?.updateRoomReceipts) && (name !== "messaging_edit_message" || !!roomHistory?.editRoomMessage) && (name !== "messaging_delete_message" || !!roomHistory?.deleteRoomMessage) && (name !== "messaging_remove_members_rotate_key" || !!roomHistory?.removeRoomMembersAndRotateKey) && (name !== "messaging_add_room_members" || !!roomHistory?.addRoomMembers) && (name !== "messaging_leave_group" || !!roomHistory?.leaveRoom) && (name !== "messaging_set_room_name" || !!roomHistory?.setRoomName) && (name !== "messaging_archive_group" || !!roomHistory?.archiveRoom) && (name !== "messaging_get_read_state" || !!roomHistory?.getRoomReadState) && (name !== "messaging_update_read_state" || !!roomHistory?.updateRoomReadState) && (name !== "messaging_get_unread_counts" || !!roomHistory?.getRoomUnreadCounts));
    }

    async availableToolNames(): Promise<readonly string[]> {
        const catalog = await this.listActions() as { permittedRegistryActions: string[]; capabilities: number; organizationId?: string; indexers?: { orderbook?: boolean }; actions: Array<{ id: string; permitted: boolean }> };
        const permitted = new Set(catalog.actions.filter((action) => action.permitted).map((action) => action.id));
        // Worker credential management is callable only by the trusted app
        // controller; never advertise the one-time bearer to a model transcript.
        return this.supportedToolNames.filter((name) => !["work_run_issue_worker_credential", "work_run_revoke_worker_credential"].includes(name)).filter((name) => {
            const caps = catalog.capabilities ?? 0;
            if(name.startsWith("payments_") && !ACTION_ID_BY_TOOL.has(name) && (!capabilityPresent(caps,CAP_TRADE_EXECUTE)||!catalog.permittedRegistryActions?.includes("payments.read.v1")))return false;
            if(name.startsWith("subscription_") && !ACTION_ID_BY_TOOL.has(name) && (!capabilityPresent(caps,CAP_TRADE_EXECUTE)||!catalog.permittedRegistryActions?.includes("subscription.read.v1")))return false;
            if(name.startsWith("agent_admin_") && (!catalog.permittedRegistryActions?.includes("agent.admin.read.v1") || ![CAP_AGENT_REGISTER,CAP_AGENT_REVOKE,CAP_AGENT_UPDATE,CAP_BUDGET_MANAGE].some(capability=>capabilityPresent(caps,capability))))return false;
            if (["messaging_list_inbox", "messaging_list_rooms", "messaging_revoke_member_from_all_rooms", "messaging_get_room_history", "messaging_get_room_attachment", "messaging_wait_for_message", "messaging_get_room_details", "messaging_get_group_creation_receipt", "messaging_get_membership_change_receipt", "messaging_list_room_members", "messaging_list_room_digests", "messaging_get_message_receipt", "messaging_download_room_attachment", "room_list", "organization_list_rooms"].includes(name) && !capabilityPresent(caps, CAP_MESSAGE_READ)) return false;
            if (name === "messaging_upload_room_attachment" && !capabilityPresent(caps, CAP_MESSAGE_SEND)) return false;
            if (name === "messaging_send_room_message" && !capabilityPresent(caps, CAP_MESSAGE_SEND)) return false;
            if (["messaging_add_reaction", "messaging_remove_reaction"].includes(name) && !capabilityPresent(caps, CAP_MESSAGE_SEND)) return false;
            if (["messaging_edit_message", "messaging_delete_message"].includes(name) && !capabilityPresent(caps, CAP_MESSAGE_SEND)) return false;
            if (name === "messaging_remove_members_rotate_key" && !capabilityPresent(caps, CAP_MESSAGE_SEND)) return false;
            if (name === "messaging_revoke_member_from_all_rooms" && !capabilityPresent(caps, CAP_MESSAGE_SEND)) return false;
            if (name === "messaging_add_room_members" && !capabilityPresent(caps, CAP_MESSAGE_SEND)) return false;
            if (name === "messaging_leave_group" && !capabilityPresent(caps, CAP_MESSAGE_SEND)) return false;
            if (name === "messaging_set_room_name" && !capabilityPresent(caps, CAP_MESSAGE_SEND)) return false;
            if (name === "messaging_archive_group" && !capabilityPresent(caps, CAP_MESSAGE_SEND)) return false;
            if (["messaging_get_read_state", "messaging_get_unread_counts", "messaging_update_read_state"].includes(name) && !capabilityPresent(caps, CAP_MESSAGE_READ)) return false;
            if (["messaging_list_reactions", "messaging_get_room_receipts"].includes(name) && !capabilityPresent(caps, CAP_MESSAGE_READ)) return false;
            if (name === "messaging_update_room_receipts" && !capabilityPresent(caps, CAP_MESSAGE_READ)) return false;
            if (name === "organization_list_rooms" && !catalog.organizationId) return false;
            if (name === "organization_get_control" && !capabilityPresent(caps, CAP_MEMORY_READ)) return false;
            if (name === "ai_chat" && (!capabilityPresent(caps, CAP_AI_SPEND) || !catalog.permittedRegistryActions?.includes("ai.run_inference.v1"))) return false;
            if (name.startsWith("automation_") && (!capabilityPresent(caps, CAP_MEMORY_READ) || !catalog.permittedRegistryActions?.includes("automation.access.v1"))) return false;
            if (name.startsWith("work_run_") && (!capabilityPresent(caps, CAP_MYDATA_READ) || !capabilityPresent(caps, name === "work_run_get" || name === "work_run_list" ? CAP_MEMORY_READ : CAP_MEMORY_WRITE))) return false;
            if (name.startsWith("dex_") && name !== "dex_get_swap_receipt" && catalog.indexers?.orderbook !== true) return false;
            if (name === "task_upload_deliverable" && (!capabilityPresent(caps, CAP_TASK_TRADE) || !catalog.permittedRegistryActions?.includes("task.deliver.v1"))) return false;
            if (["poc_start_beneficiary_transfer_verification", "poc_get_beneficiary_transfer_verification", "poc_propose_beneficiary_transfer", "poc_get_beneficiary_transfer_job", "poc_get_beneficiary_transfer_proposal_receipt"].includes(name) && !catalog.permittedRegistryActions?.includes("poc.beneficiary_transfer.v1")) return false;
            if (["mydata_read_content", "mydata_search_graph", "mydata_get_graph_item", "mydata_check_current_access"].includes(name) && !catalog.permittedRegistryActions?.includes("mydata.read_content.v1")) return false;
            if (name === "mydata_list_my_purchases" && !capabilityPresent(catalog.capabilities ?? 0, CAP_MYDATA_READ)) return false;
            if (name === "mydata_list_owner_access_history" && !capabilityPresent(catalog.capabilities ?? 0, CAP_MYDATA_READ)) return false;
            if (["mydata_list_listings", "mydata_list_graph_offers", "mydata_list_owned_listings", "mydata_read_content", "mydata_search_graph", "mydata_get_graph_item", "mydata_check_current_access", "mydata_get_purchase_quote", "mydata_get_purchase_receipt", "mydata_get_owner_access_receipt", "mydata_verify_graph_offer"].includes(name) && !capabilityPresent(catalog.capabilities ?? 0, getSocialActionDescriptor("access.purchase_mydata_access.v1").requiredCapability)) return false;
            if (name === "mydata_publish_graph" && (!capabilityPresent(catalog.capabilities ?? 0, getSocialActionDescriptor("access.publish_mydata_graph.v1").requiredCapability) || !catalog.permittedRegistryActions?.includes("access.publish_mydata_graph.v1"))) return false;
            if (["mydata_list_listings", "mydata_list_graph_offers", "mydata_list_owned_listings", "mydata_verify_graph_offer"].includes(name) && !catalog.permittedRegistryActions?.includes("mydata.search.v1")) return false;
            const action = ACTION_ID_BY_TOOL.get(name);
            return !action || permitted.has(action);
        });
    }

    async executeAction(action: SocialActionId, parameters: unknown, idempotencyKey: string): Promise<unknown> {
        // Public execution is restricted to the same named registry actions advertised as tools.
        if (!MARKET_ACTION_TOOLS.some((entry) => entry.actionId === action)) {
            throw new McpRuntimeError("CAPABILITY_DENIED", "Use the dedicated tool for this action.");
        }
        const validation = getSocialActionDescriptor(action).validate(parameters as never);
        if (!validation.success) throw new McpRuntimeError("INVALID_ARGUMENT", validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
        if (action === "dex.swap.v1") {
            return this.requestActionApproval({ registryAction: action, parameters: validation.value as unknown as Record<string, unknown>, idempotencyKey });
        }
        return this.executeRegisteredAction(action, validation.value, idempotencyKey);
    }

    async callPlatformTool(name: string, args: Record<string, unknown>): Promise<unknown> {
        const definition = PLATFORM_TOOL_BY_NAME.get(name);
        if (!definition) throw new McpRuntimeError("UNKNOWN_TOOL", "Unknown platform tool.");
        const properties = definition.tool.inputSchema.properties ?? {};
        if (Object.keys(args).some((key) => !(key in properties))) throw new McpRuntimeError("INVALID_ARGUMENT", "Unexpected tool parameter.");
        for (const key of definition.tool.inputSchema.required ?? []) {
            if (args[key] === undefined) throw new McpRuntimeError("INVALID_ARGUMENT", `${key} is required.`);
        }
        let path = definition.path;
        for (const key of definition.pathKeys ?? []) {
            const value = args[key];
            const property = properties[key] as { format?: string; pattern?: string } | undefined;
            if (typeof value !== "string") throw new McpRuntimeError("INVALID_ARGUMENT", `${key} must be a string.`);
            if (property?.format === "uuid" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new McpRuntimeError("INVALID_ARGUMENT", `${key} must be a UUID.`);
            if (property?.pattern && !new RegExp(property.pattern).test(value)) throw new McpRuntimeError("INVALID_ARGUMENT", `${key} has an invalid format.`);
            path = path.replace(`{${key}}`, encodeURIComponent(value));
        }
        const query = new URLSearchParams();
        for (const key of definition.queryKeys ?? []) {
            const value = args[key];
            if (value !== undefined) {
                if (key === "limit" && (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 200)) throw new McpRuntimeError("INVALID_ARGUMENT", "limit must be an integer between 1 and 200.");
                query.set(key, String(value));
            }
        }
        if (query.size) path += `?${query}`;
        let body: object | undefined;
        if (definition.bodyKey) {
            const value = args[definition.bodyKey];
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpRuntimeError("INVALID_ARGUMENT", `${definition.bodyKey} must be an object.`);
            if (Buffer.byteLength(JSON.stringify(value)) > (name === "ai_chat" ? 768 : name === "task_upload_deliverable" ? 720 : name === "messaging_upload_room_attachment" ? 7100 : name === "mydata_publish_graph" ? 256 : name.startsWith("work_run_") ? 192 : 64) * 1024) throw new McpRuntimeError("INVALID_ARGUMENT", "Tool input exceeds the request limit.");
            body = value;
        }
        if (name === "mydata_publish_graph") {
            if (!body || typeof body !== "object" || Array.isArray(body)) throw new McpRuntimeError("INVALID_ARGUMENT", "request is required.");
            return this.publishMyDataGraph(body as Record<string, unknown>);
        }
        if (name === "mydata_verify_graph_offer") {
            if (!this.privateData?.verifyMyDataGraphOffer) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "A caller-bound MyData quote verifier is required.");
            const request = (body as { mydataId?: unknown } | undefined);
            if (!request || typeof request.mydataId !== "string") throw new McpRuntimeError("INVALID_ARGUMENT", "request.mydataId is required.");
            try { await this.boundSessionContext(this.privateData); return await this.privateData.verifyMyDataGraphOffer(request.mydataId); }
            catch (error) { if (error instanceof McpRuntimeError) throw error; const status = (error as {status?:number}).status; if (typeof status === "number") throw statusError(status, ""); throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The graph offer's public seller proof could not be verified.", { retryable: false }); }
        }
        if (name === "mydata_check_current_access") {
            if (!this.privateData?.checkCurrentMyDataAccess) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "A caller-bound MyData access-check client is required.");
            const request = (body as { mydataId?: unknown; encryptedDataDigestHex?: unknown; organizationAudienceId?: unknown } | undefined);
            if (!request || typeof request.mydataId !== "string" || typeof request.encryptedDataDigestHex !== "string"
                || (request.organizationAudienceId !== undefined && typeof request.organizationAudienceId !== "string")) {
                throw new McpRuntimeError("INVALID_ARGUMENT", "A named MyData listing version is required.");
            }
            try {
                const context = parseAgentContext(await this.boundSessionContext(this.privateData));
                const result = await this.privateData.checkCurrentMyDataAccess(request as MyDataCurrentAccessRequest);
                return sanitizeMyDataCurrentAccess(result, args, { accountId: context.memoryAccountId, agentId: context.agentObjectId, callerAddress: context.derivedAddress });
            } catch (error) {
                if (error instanceof McpRuntimeError) throw error;
                const status = (error as { status?: number }).status;
                if (typeof status === "number") throw statusError(status, "");
                throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Current MyData access could not be checked with the caller's active session.", { retryable: false });
            }
        }
        if (name === "mydata_read_content" || name === "mydata_search_graph" || name === "mydata_get_graph_item") {
            if (!this.privateData) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "A caller-bound MyData content client is required.");
            try {
                await this.boundSessionContext(this.privateData);
                if (name === "mydata_search_graph") {
                    if (!this.privateData.searchMyDataGraph) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "A caller-bound MyData graph search client is required.");
                    return await this.privateData.searchMyDataGraph(body as unknown as MyDataGraphSearchRequest, async () => { await this.boundSessionContext(this.privateData!); });
                }
                if (name === "mydata_get_graph_item") {
                    if (!this.privateData.getMyDataGraphItem) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "A caller-bound MyData graph item client is required.");
                    return await this.privateData.getMyDataGraphItem(body as unknown as MyDataGraphItemRequest, async () => { await this.boundSessionContext(this.privateData!); });
                }
                return await this.privateData.readMyDataContent(body as unknown as MyDataContentRequest);
            }
            catch (error) {
                if (error instanceof McpRuntimeError) throw error;
                const status = (error as {status?:number}).status;
                if (typeof status === "number") throw statusError(status, "");
                throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Private MyData content could not be read with the current session.", { retryable: false });
            }
        }
        if (name === "agent_get_context" && this.workJournal) return this.boundSessionContext(this.workJournal);
        if (name.startsWith("work_run_")) {
            const client = this.workJournal;
            if (!client) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "A session-capable work journal client is required.");
            const request = body as Record<string, unknown>;
            try {
                await this.boundSessionContext(client);
                const turnAction = { work_run_acquire_turn: "acquire", work_run_renew_turn: "renew", work_run_checkpoint: "checkpoint", work_run_finish_turn: "finish" } as const;
                if (name in turnAction) return sanitizeWorkJournalRead(name, await client.workTurn(args.runId as string, turnAction[name as keyof typeof turnAction], request), args);
                switch (name) {
                    case "work_run_list": return sanitizeWorkJournalRead(name, await client.listWorkRuns(args.limit as number | undefined, args.offset as number | undefined), args);
                    case "work_run_get": return sanitizeWorkJournalRead(name, await client.getWorkRun(args.runId as string), args);
                    case "work_run_refresh_task_history": return sanitizeWorkJournalRead(name, await client.refreshWorkTaskHistory(args.runId as string), args);
                    case "work_run_list_operations": return sanitizeWorkJournalRead(name, await client.listWorkRunOperations(args.runId as string, args.limit as number | undefined, args.offset as number | undefined), args);
                    case "work_run_cancel": return sanitizeWorkJournalRead(name, await client.cancelWorkRun(args.runId as string), args);
                    case "work_run_complete": return sanitizeWorkJournalRead(name, await client.completeWorkRun(args.runId as string), args);
                    case "work_run_issue_worker_credential": return sanitizeWorkJournalRead(name, await client.issueWorkRunWorkerCredential(args.runId as string, request), args);
                    case "work_run_revoke_worker_credential": return sanitizeWorkJournalRead(name, await client.revokeWorkRunWorkerCredential(args.runId as string), args);
                    case "work_run_create": return sanitizeWorkJournalRead(name, await client.createWorkRun(request.id as string, request.plan as object, request.taskId as string | undefined), args);
                    case "work_run_save_plan": return sanitizeWorkJournalRead(name, await client.saveWorkPlan(args.runId as string, request), args);
                    case "work_run_reserve_operation": return sanitizeWorkJournalRead(name, await client.reserveWorkOperation(args.runId as string, request), args);
                    case "work_run_settle_operation": return sanitizeWorkJournalRead(name, await client.settleWorkOperation(args.operationId as string, request), args);
                    case "work_run_reconcile_action_receipt": return sanitizeWorkJournalRead(name, await client.reconcileWorkActionReceipt(args.runId as string, request), args);
                    case "work_run_reconcile_task_upload": return sanitizeWorkJournalRead(name, await client.reconcileWorkTaskUpload(args.runId as string, request), args);
                    case "work_run_append_action_receipt": return sanitizeWorkJournalRead(name, await client.appendWorkActionReceipt(args.runId as string, request), args);
                    case "work_run_append_task_artifact": return sanitizeWorkJournalRead(name, await client.appendWorkTaskArtifact(args.runId as string, request), args);
                    case "work_run_update_step": return sanitizeWorkJournalRead(name, await client.updateWorkStep(args.runId as string, args.stepId as string, request), args);
                }
            } catch (error) {
                if (error instanceof McpRuntimeError) throw error;
                const status = (error as { status?: number }).status;
                if (typeof status === "number") throw statusError(status, "");
                throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Work journal access failed; reconcile existing operations before another dispatch.", { retryable: false });
            }
            throw new McpRuntimeError("UNKNOWN_TOOL", "Unknown work journal operation.");
        }
        await this.ensureDeploymentPlatform();
        const response = await this.signedJson(definition.method, path, body);
        if (name === "mydata_check_current_access") return sanitizeMyDataCurrentAccess(response, args);
        if (name.startsWith("automation_")) {
            const context = parseAgentContext(await this.getExecutionContext());
            return sanitizeAutomationRead(name, response, args, {
                accountId: context.memoryAccountId,
                agentObjectId: context.agentObjectId,
            });
        }
        if ((name === "messaging_upload_room_attachment" || name === "messaging_download_room_attachment") && body && typeof body === "object" && !Array.isArray(body)) return sanitizeRoomAttachmentResponse(name, response, body as Record<string, unknown>);
        if (definition.method === "GET" && isMessagingReadName(name)) {
            const ownerBound = ["messaging_list_my_wallet_history", "messaging_list_my_paid_message_history", "messaging_get_my_revenue_summary", "room_list"].includes(name);
            const owner = ownerBound ? parseAgentContext(await this.getExecutionContext()).owner : undefined;
            return sanitizeMessagingRead(name, response, args, owner);
        }
        if (name === "task_get_receipt") return sanitizeTaskReceipt(response, args);
        if (name === "task_get_settlement_receipt") return sanitizeTaskSettlementReceipt(response, args);
        if (name === "jury_get_action_receipt") return sanitizeJuryReceipt(response, args);
        if (["jury_list_assignments", "jury_list_roster"].includes(name)) {
            const context = parseAgentContext(await this.getExecutionContext());
            return sanitizeJuryListRead(name, response, args, { owner: context.owner, agentId: context.agentObjectId });
        }
        if (name === "jury_health") return sanitizeJuryHealth(response, args);
        if (name === "jury_get_case_bundle") return sanitizeJuryCaseBundle(response, args);
        if (name === "jury_list_cases" || name === "jury_get_case") return sanitizeJuryCasesRead(name, response, args);
        if (name === "jury_get_own_profile") {
            const context = parseAgentContext(await this.getExecutionContext());
            return sanitizeJuryOwnProfile(response, context.agentObjectId);
        }
        if (name === "jury_list_case_rationales") return sanitizeJuryRationales(response, args);
        if (name === "jury_list_cranks") return sanitizeJuryCranks(response, args);
        if (name === "jury_get_task_dispute") return sanitizeJuryTaskDispute(response, args);
        if (name === "jury_get_proposal_case" || name === "jury_get_proposal_vote_refunds") return sanitizeProposalJuryRead(name, response, args);
        if (name === "agent_get_reputation") {
            const context = parseAgentContext(await this.getExecutionContext());
            return sanitizeAgentReputation(response, context.agentObjectId);
        }
        if (name === "agent_get_own_pnl") {
            const context = parseAgentContext(await this.getExecutionContext());
            return sanitizeAgentOwnPnl(response, context.memoryAccountId, context.agentObjectId, args);
        }
        if (name === "agent_list_owned_pnl") {
            const context = parseAgentContext(await this.getExecutionContext());
            return sanitizeAgentOwnedPnl(response, context.memoryAccountId, args);
        }
        if (name === "account_list_audit_logs") {
            const context = parseAgentContext(await this.getExecutionContext());
            return sanitizeAccountAuditLogs(response, context.owner, args);
        }
        if (name.startsWith("poc_")) {
            const context = parseAgentContext(await this.getExecutionContext());
            return sanitizePocRead(name, response, args, context.owner, context.network, context.socialChain.packageId);
        }
        if (["organization_get", "organization_get_statistics", "organization_list_categories", "organization_list_leaderboard", "organization_list_my_invitations", "organization_list_owned", "organization_list_rooms"].includes(name)) {
            const context = parseAgentContext(await this.getExecutionContext());
            return sanitizeOrganizationPublicRead(name, response, args, {
                owner: context.owner,
                organizationId: context.organizationId,
                derivedAddress: context.derivedAddress,
            });
        }
        if (name === "task_market_get_seller_reputation") return sanitizeAgentReputation(response, String(args.id));
        if (name === "agent_list_children") {
            const context = parseAgentContext(await this.getExecutionContext());
            return sanitizeAgentChildren(response, args, context.agentObjectId);
        }
        if (name === "agent_list_profile_agents") return sanitizeProfileAgents(response, args);
        if (name === "agent_list_receipts") {
            const context = parseAgentContext(await this.getExecutionContext());
            return sanitizeAgentReceipts(response, args, context.agentObjectId);
        }
        if (name === "dex_get_swap_receipt") return sanitizeDexSwapReceipt(response, args);
        if (name === "chain_list_action_approvals") {
            const context = parseAgentContext(await this.getExecutionContext());
            return sanitizeActionApprovals(response, args, { accountId: context.memoryAccountId, agentObjectId: context.agentObjectId, ownerAddress: context.owner });
        }
        if (name === "chain_find_action_by_idempotency_key") {
            const context = parseAgentContext(await this.getExecutionContext());
            return sanitizeActionByIdempotencyKey(response, args, { accountId: context.memoryAccountId, agentObjectId: context.agentObjectId });
        }
        if (name === "chain_get_action_receipt") {
            const context = parseAgentContext(await this.getExecutionContext());
            return sanitizeActionReceipt(response, args, { accountId: context.memoryAccountId, agentObjectId: context.agentObjectId });
        }
        if (["governance_get_vote_quote", "governance_get_vote_receipt", "governance_get_delegate_vote_receipt"].includes(name)) return sanitizeGovernanceRead(name, response, args);
        if (name === "dex_list_markets") return sanitizeDexMarkets(response);
        if (name === "dex_get_market") return sanitizeDexMarket(response, args);
        if (name === "dex_get_orderbook") return sanitizeDexOrderbook(response, args);
        if (name === "dex_get_summary") return sanitizeDexSummary(response, args);
        if (name === "dex_get_ticker") return sanitizeDexTicker(response, args);
        if (name === "dex_list_trades") return sanitizeDexTrades(response, args);
        if (name === "dex_get_indexer_status") return sanitizeDexStatus(response);
        if (["task_list", "task_list_for_agent", "task_list_for_organization"].includes(name)) {
            const context = parseAgentContext(await this.getExecutionContext());
            return sanitizeTaskMarketRead(name, response, args, {
                owner: context.owner,
                agentObjectId: context.agentObjectId,
                organizationId: context.organizationId,
            });
        }
        if (["task_market_list", "task_market_list_sellers", "task_market_get_stats", "task_get_config"].includes(name)) return sanitizeTaskMarketRead(name, response, args);
        if (name === "task_get_room") return sanitizeTaskRoomRead(response, args);
        if (name === "task_get") return sanitizeTaskDetailRead(response, args);
        if (name === "task_get_deliverable") return sanitizeTaskDeliverableRead(response, args);
        if (name === "task_get_dispute") return sanitizeTaskDisputeRead(response, args);
        if (["task_list_history", "task_get_lifecycle_history"].includes(name)) return sanitizeTaskHistoryRead(name, response, args);
        if (["assets_get_owned_object", "assets_list_owned_objects", "assets_get_transfer_receipt", "assets_get_burn_receipt"].includes(name)) {
            const context = parseAgentContext(await this.getExecutionContext());
            if (name === "assets_get_owned_object") return sanitizeOwnedObject(response, args, context.owner);
            if (name === "assets_list_owned_objects") return sanitizeOwnedObjects(response, args, context.owner);
            return sanitizeAssetReceipt(name, response, args, context.owner);
        }
        if (["payments_get_balance", "payments_list_coins", "payments_get_transfer_quote", "payments_get_transfer_receipt"].includes(name)) {
            const context = parseAgentContext(await this.getExecutionContext());
            return sanitizePaymentRead(name, args, response, { accountId: context.memoryAccountId, agentObjectId: context.agentObjectId, owner: context.owner });
        }
        if (name.startsWith("subscription_")) {
            const context = parseAgentContext(await this.getExecutionContext());
            return sanitizeSubscriptionRead(name, args, response, { accountId: context.memoryAccountId, agentObjectId: context.agentObjectId });
        }
        if (["agent_admin_list", "agent_admin_get_quote", "agent_admin_get_receipt"].includes(name)) {
            const context = parseAgentContext(await this.getExecutionContext());
            return sanitizeAgentAdminRead(name, args, response, { accountId: context.memoryAccountId });
        }
        if (["organization_get_treasury_balance", "organization_get_treasury_access"].includes(name)) return sanitizeOrganizationTreasuryRead(name, response, args);
        if (["task_list_agent_funding_coins", "mydata_list_agent_funding_coins"].includes(name)) return sanitizeAgentFundingCoins(name, response, args);
        if (name === "mydata_get_purchase_quote") {
            const context = parseAgentContext(await this.getExecutionContext());
            return sanitizeMyDataPurchaseQuote(response, args, { agentAddress: context.derivedAddress });
        }
        if (name === "mydata_list_owned_listings") {
            const context = parseAgentContext(await this.getExecutionContext());
            return sanitizeMyDataListingPage(response, args, context.owner);
        }
        if (name === "mydata_list_listings") return sanitizeMyDataListingPage(response, args);
        if (name === "mydata_check_indexed_access") return sanitizeMyDataIndexedAccess(response, args);
        if (name === "mydata_get_indexed_listing") return sanitizeMyDataIndexedListing(response, args);
        if (name === "mydata_get_indexed_stats") return sanitizeMyDataIndexedStats(response, args);
        if (["mydata_get_indexed_configuration", "mydata_get_indexed_revenue_timeline", "mydata_get_indexed_access_analytics"].includes(name)) return sanitizeMyDataAnalyticsRead(name, response);
        if (["mydata_get_snapshot_anchor", "mydata_get_snapshot_distribution", "mydata_get_snapshot_merkle_root", "mydata_get_snapshot_escrow", "mydata_list_snapshot_claims"].includes(name)) return sanitizeMyDataSnapshotRead(name, response, args);
        if (["mydata_read_indexed_catalog", "mydata_list_popular_indexed", "mydata_list_creator_listings", "mydata_list_broad_pools", "mydata_list_broad_pool_sub_pools", "mydata_list_listing_sub_pools", "mydata_list_sub_pool_listings"].includes(name)) return sanitizeMyDataMarketCatalogRead(name, response, args);
        if (name === "mydata_list_distribution_rounds") return sanitizeMyDataSnapshotRead(name, response, args);
        if (["mydata_list_indexed_access_logs", "mydata_list_indexed_purchases", "mydata_list_indexed_revenue", "mydata_list_indexed_subscriptions"].includes(name)) return sanitizeMyDataHistoryRead(name, response, args);
        if (name === "mydata_list_my_purchases") {
            const context = parseAgentContext(await this.getExecutionContext());
            return sanitizeMyDataHistoryRead(name, response, args, { ownerAddress: context.owner, agentAddress: context.derivedAddress });
        }
        if (["spot_get_bet_receipt", "spot_get_claim_receipt", "spot_get_market_receipt"].includes(name)) return sanitizeSpotReceiptRead(name, response, args);
        if (["spt_get_configuration", "spt_get_pool", "spt_get_pool_by_associated_id", "spt_get_reservation_pool", "spt_get_user_holdings", "spt_list_pool_holdings", "spt_list_pool_price_history", "spt_list_pool_revenue", "spt_list_pool_swaps", "spt_list_pool_transactions", "spt_list_pool_transfers", "spt_list_pools", "spt_list_popular_pools", "spt_list_reservation_pools", "spt_list_reservations", "spt_get_reservation_volume_history", "spt_list_user_reservations", "spt_get_market_sentiment", "spt_get_pool_liquidity_profile", "spt_get_portfolio_performance", "spt_get_position_metrics", "spt_get_position_timeseries", "spt_get_top_performers", "spt_list_creator_revenue_streams", "spt_list_trader_leaderboard", "spt_get_trade_quote", "spt_get_trade_receipt"].includes(name)) return sanitizeSptRead(name, response, args);
        if (name === "mydata_get_purchase_receipt") {
            const context = parseAgentContext(await this.getExecutionContext());
            return sanitizeMyDataPurchaseReceipt(response, args, {
                accountId: context.memoryAccountId,
                agentObjectId: context.agentObjectId,
                ownerAddress: context.owner,
                agentAddress: context.derivedAddress,
            });
        }
        if (name === "mydata_get_owner_access_receipt" || name === "mydata_list_owner_access_history") {
            const context = parseAgentContext(await this.getExecutionContext());
            const identity = {
                accountId: context.memoryAccountId,
                agentObjectId: context.agentObjectId,
                ownerAddress: context.owner,
                agentAddress: context.derivedAddress,
            };
            return name === "mydata_get_owner_access_receipt"
                ? sanitizeMyDataOwnerAccessReceipt(response, args, identity)
                : sanitizeMyDataOwnerAccessHistory(response, args, identity);
        }
        if (name.startsWith("config_")) return sanitizeConfigRead(name, response);
        if (name.startsWith("badge_")) return sanitizeBadgeRead(name, response, args);
        if (name.startsWith("promotion_")) return sanitizePromotionRead(name, response, args);
        if (name.startsWith("social_")) return sanitizeSocialRead(name, response, args, definition.scope);
        if (["agent_admin_owner_rotation_manifest", "agent_admin_owner_rotation_status", "agent_admin_owner_rotation_progress", "agent_admin_owner_rotation_receipt"].includes(name)) {
            const context = parseAgentContext(await this.getExecutionContext());
            return sanitizeOwnerRotationRead(name, response, args, { accountId: context.memoryAccountId });
        }
        if (name.startsWith("organization_list_") && [
            "organization_list_messaging_groups",
            "organization_list_roles", "organization_list_role_assignments", "organization_list_invitations",
            "organization_list_memory_permissions", "organization_list_spend_approvals",
            "organization_list_spend_breakdown", "organization_list_audit_logs",
        ].includes(name)) {
            const context = parseAgentContext(await this.getExecutionContext());
            return sanitizeOrganizationRead(name, response, args, { organizationId: context.organizationId });
        }
        if (name === "account_get_memory_usage") return sanitizeAccountMemoryUsage(response, this.accountId);
        if (["ai_get_balance", "ai_list_approvals", "ai_list_usage", "ai_list_reservations", "ai_get_reservation"].includes(name)) {
            const context = parseAgentContext(await this.getExecutionContext());
            return sanitizeAiCreditRead(name, response, args, context.owner);
        }
        if (name === "mydata_list_graph_offers") return sanitizeGraphOfferPage(response, args);
        return response;
    }

    async getExecutionContext(): Promise<unknown> {
        await this.ensureDeploymentPlatform();
        const raw = await this.signedJson("GET", "/api/agent/context");
        const context = parseAgentContext(raw);
        resolveExecutionContext(context, { network: this.networkPin, rpcUrl: this.rpcUrlPin, chain: this.chainPins });
        const signerAddress = normalizeAddress(await this.signer.getMySoAddress());
        if (normalizeAddress(context.memoryAccountId) !== normalizeAddress(this.accountId) || !signerAddress || signerAddress !== normalizeAddress(context.derivedAddress)) {
            throw new McpRuntimeError("AUTHENTICATION_FAILED", "The signer does not match the authenticated execution context.");
        }
        if (context.platformScope && normalizeAddress(context.platformScope) !== normalizeAddress(this.platformId ?? "")) {
            throw new McpRuntimeError("CAPABILITY_DENIED", "The configured platform is outside the agent's scope.");
        }
        return raw;
    }

    /** Session adapters are independently authenticated clients, never ambient authority. */
    private async boundSessionContext(client: { getAgentContext(): Promise<unknown> }): Promise<unknown> {
        const [rawSource, rawRecipient] = await Promise.all([this.getExecutionContext(), client.getAgentContext()]);
        const source = parseAgentContext(rawSource), recipient = parseAgentContext(rawRecipient);
        if (normalizeAddress(source.memoryAccountId) !== normalizeAddress(this.accountId)
            || normalizeAddress(recipient.memoryAccountId) !== normalizeAddress(source.memoryAccountId)
            || normalizeAddress(recipient.agentObjectId) !== normalizeAddress(source.agentObjectId)
            || normalizeAddress(recipient.derivedAddress) !== normalizeAddress(source.derivedAddress)
            || recipient.network !== source.network || recipient.rpcUrl !== source.rpcUrl
            || normalizeAddress(recipient.socialChain.packageId) !== normalizeAddress(source.socialChain.packageId)
            || normalizeAddress(recipient.platformScope ?? "") !== normalizeAddress(source.platformScope ?? "")) {
            throw new McpRuntimeError("AUTHENTICATION_FAILED", "The session client does not match this connection's execution identity.");
        }
        return rawRecipient;
    }

    async listActions(): Promise<unknown> {
        const context = parseAgentContext(await this.getExecutionContext());
        const permitted = new Set(context.permittedRegistryActions ?? []);
        return {
            capabilities: context.capabilities,
            organizationId: context.organizationId,
            indexers: context.indexers,
            permittedRegistryActions: context.permittedRegistryActions ?? [],
            catalogVersion: PRODUCTION_ACTION_CATALOG_VERSION,
            registryVersion: SOCIAL_ACTION_REGISTRY_VERSION,
                actions: PRODUCTION_ACTION_CATALOG.map((action) => ({
                    ...action,
                    permitted:
                        action.availability === "enabled" &&
                        (action.id === "account.rotate_owner_key.v1"
                            ? permitted.has(action.id)
                            : action.requiredCapability !== null &&
                              capabilityPresent(context.capabilities, action.requiredCapability) &&
                              (action.id.startsWith("subscription.") || action.id.startsWith("access.") || action.id==="payments.send_token.v1" || action.id==="poc.claim_creator_vault.v1" || action.id.startsWith("spot.") ? permitted.has(action.id) : !context.permittedRegistryActions || permitted.has(action.id))),
                approvalRequired: action.tier !== "1" ||
                    (action.requiredCapability !== null && capabilityPresent(context.approvalRequiredCapabilities, action.requiredCapability)),
                ...(action.id === "access.purchase_mydata_access.v1"
                    ? { approvalPolicy: "conditional_live_on_chain_agent_capability_and_spend_limit" }
                    : {}),
            })),
        };
    }

    async getRoomAttachment(request: NonNullable<RoomHistoryClient["readRoomAttachment"]> extends (request: infer T) => Promise<unknown> ? T : never): Promise<unknown> {
        const client = this.roomHistory;
        if (!client?.readRoomAttachment) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "A caller-bound encrypted room attachment client is required.");
        try {
            await this.boundSessionContext(client);
            return sanitizeRoomAttachmentPlaintext(await client.readRoomAttachment(request), request.messageId, request.storageId);
        } catch (error) {
            if (error instanceof McpRuntimeError) throw error;
            const status = (error as { status?: number }).status;
            if (typeof status === "number") throw statusError(status, "");
            throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The selected encrypted room attachment could not be verified and decrypted.", { retryable: false });
        }
    }

    async getRoomHistory(request: Parameters<RoomHistoryClient["readRoomHistory"]>[0]): Promise<unknown> {
        const client = this.roomHistory;
        if (!client) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "A caller-bound encrypted room history client is required.");
        try {
            await this.boundSessionContext(client);
            return sanitizeRoomHistoryPage(await client.readRoomHistory(request), "groupId" in request.groupRef ? request.groupRef.groupId : undefined, request.limit);
        } catch (error) {
            if (error instanceof McpRuntimeError) throw error;
            const status = (error as { status?: number }).status;
            if (typeof status === "number") throw statusError(status, "");
            throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Encrypted room history could not be read with the current room permission and session.", { retryable: false });
        }
    }

    async sendRoomMessage(request: { groupRef: { groupId: string; encryptionHistoryId: string } | { uuid: string }; text?: string; files?: Array<{ fileName: string; mimeType: string; contentBase64: string }>; idempotencyKey: string }): Promise<unknown> {
        const client = await this.roomMessagingContext("send");
        if (!client.sendRoomMessage) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "A caller-bound encrypted room sender is required.");
        if (request.text !== undefined && (typeof request.text !== "string" || Buffer.byteLength(request.text, "utf8") > 64 * 1024)) throw new McpRuntimeError("INVALID_ARGUMENT", "Room message text may contain at most 65,536 UTF-8 bytes.");
        if (!(request.text ?? "").trim() && (!Array.isArray(request.files) || request.files.length === 0)) throw new McpRuntimeError("INVALID_ARGUMENT", "Provide nonempty text or at least one attachment.");
        if (request.files !== undefined && (!Array.isArray(request.files) || request.files.length > 10)) throw new McpRuntimeError("INVALID_ARGUMENT", "Provide at most 10 room attachments.");
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.idempotencyKey)) throw new McpRuntimeError("INVALID_ARGUMENT", "idempotencyKey must be a canonical UUID v4.");
        try {
            const value = await client.sendRoomMessage(request);
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid receipt");
            const receipt = value as Record<string, unknown>;
            const groupId = normalizeAddress(typeof receipt.groupId === "string" ? receipt.groupId : "");
            const expectedGroup = "groupId" in request.groupRef ? normalizeAddress(request.groupRef.groupId) : undefined;
            const text = request.text ?? "";
            if (Object.keys(receipt).sort().join(",") !== ["messageId", "groupId", "order", "senderAddress", "textSha256", "signatureVerified", "permissionSource", "contentSource", "attachmentCount", "attachmentIntegrity"].sort().join(",")
                || typeof receipt.messageId !== "string" || !receipt.messageId || receipt.messageId.length > 128
                || !groupId || (expectedGroup && groupId !== expectedGroup)
                || !Number.isSafeInteger(receipt.order) || Number(receipt.order) < 0
                || typeof receipt.senderAddress !== "string" || !normalizeAddress(receipt.senderAddress)
                || receipt.textSha256 !== createHash("sha256").update(text, "utf8").digest("hex")
                || receipt.signatureVerified !== true
                || receipt.permissionSource !== "live_fullnode_messaging_sender_checked_before_and_after"
                || receipt.contentSource !== "relayer_readback_signature_verified"
                || receipt.attachmentCount !== (request.files?.length ?? 0)
                || receipt.attachmentIntegrity !== ((request.files?.length ?? 0) > 0 ? "verified" : "none")) throw new Error("invalid receipt");
            return { ...receipt, groupId, senderAddress: normalizeAddress(receipt.senderAddress), receiptSource: "caller_bound_verified_message_readback" };
        } catch (error) {
            if (error instanceof McpRuntimeError) throw error;
            const status = (error as { status?: number }).status;
            if (typeof status === "number") throw statusError(status, "");
            throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The encrypted room message could not be sent and verified under the current sender permission. Reuse the same idempotency key only to reconcile a lost response.", { retryable: false });
        }
    }

    async listRoomConversations(request: { limit?: number; offset?: number; afterGroupId?: string }): Promise<unknown> {
        const client = this.roomHistory;
        if (!client?.listRoomConversations) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "A caller-bound room discovery client is required.");
        if (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100)) throw new McpRuntimeError("INVALID_ARGUMENT", "limit must be between 1 and 100.");
        if (request.offset !== undefined && (!Number.isSafeInteger(request.offset) || request.offset < 0)) throw new McpRuntimeError("INVALID_ARGUMENT", "offset must be a nonnegative safe integer.");
        if (request.afterGroupId !== undefined && !normalizeAddress(request.afterGroupId)) throw new McpRuntimeError("INVALID_ARGUMENT", "afterGroupId must be a MySo room ID.");
        if (request.afterGroupId !== undefined && request.offset !== undefined) throw new McpRuntimeError("INVALID_ARGUMENT", "Use either afterGroupId or offset, not both.");
        try { return sanitizeRoomConversations(await client.listRoomConversations(request), request.limit ?? 50, request.offset ?? 0, request.afterGroupId); }
        catch (error) { if (error instanceof McpRuntimeError) throw error; const status = (error as { status?: number }).status; if (typeof status === "number") throw statusError(status, ""); throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Agent room discovery failed or returned invalid data.", { retryable: false }); }
    }

    private async roomMessagingContext(permission: "read" | "send"): Promise<RoomHistoryClient> {
        const client = this.roomHistory;
        if (!client) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "A caller-bound room messaging client is required.");
        const context = parseAgentContext(await this.boundSessionContext(client));
        const capability = permission === "read" ? CAP_MESSAGE_READ : CAP_MESSAGE_SEND;
        if (!capabilityPresent(context.capabilities, capability)) throw new McpRuntimeError("CAPABILITY_DENIED", `The authenticated agent lacks Messaging${permission === "read" ? "Reader" : "Sender"} capability.`);
        return client;
    }

    async listRoomReactions(request: Parameters<NonNullable<RoomHistoryClient["listRoomReactions"]>>[0]): Promise<unknown> {
        const client = await this.roomMessagingContext("read");
        if (!client.listRoomReactions) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "The caller-bound room messaging client does not support reactions.");
        if (!Number.isSafeInteger(request.order) || request.order < 0) throw new McpRuntimeError("INVALID_ARGUMENT", "order must be a nonnegative safe integer.");
        try { return sanitizeRoomReactions(await client.listRoomReactions(request), request.order); }
        catch (error) { if (error instanceof McpRuntimeError) throw error; const status = (error as { status?: number }).status; if (typeof status === "number") throw statusError(status, ""); throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Room reactions could not be read with the current room permission.", { retryable: false }); }
    }

    async changeRoomReaction(request: Parameters<NonNullable<RoomHistoryClient["changeRoomReaction"]>>[0]): Promise<unknown> {
        const client = await this.roomMessagingContext("send");
        if (!client.changeRoomReaction) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "The caller-bound room messaging client does not support reactions.");
        if (!Number.isSafeInteger(request.order) || request.order < 0 || !request.emoji || request.emoji.length > 32 || request.emoji.normalize("NFC") !== request.emoji) throw new McpRuntimeError("INVALID_ARGUMENT", "Reaction order or emoji is invalid.");
        try {
            const context = parseAgentContext(await this.boundSessionContext(client));
            const reactorAddress = normalizeAddress(context.derivedAddress);
            if (!reactorAddress) throw new McpRuntimeError("AUTHENTICATION_FAILED", "The authenticated reaction signer address is invalid.");
            const reactions = sanitizeRoomReactions(await client.changeRoomReaction(request), request.order) as Array<{ chainSeq: number; emoji: string; count: number; reactors: string[] }>;
            const state = reactions.find((reaction) => reaction.emoji === request.emoji);
            const observed = state?.reactors.includes(reactorAddress) ?? false;
            if (observed !== request.add) {
                throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The reaction mutation returned, but the caller-bound readback did not confirm the requested state. Read the reaction list before deciding whether to retry.", { retryable: false });
            }
            return {
                reactionReceipt: {
                    kind: "room_reaction_state",
                    verification: "caller_bound_readback",
                    desiredState: request.add ? "present" : "absent",
                    observedState: observed ? "present" : "absent",
                    groupRef: request.groupRef,
                    order: request.order,
                    emoji: request.emoji,
                    reactorAddress,
                },
                reactions,
            };
        }
        catch (error) { if (error instanceof McpRuntimeError) throw error; const status = (error as { status?: number }).status; if (typeof status === "number") throw statusError(status, ""); throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room reaction could not be changed with the current sender permission.", { retryable: false }); }
    }

    async getRoomReceipts(request: Parameters<NonNullable<RoomHistoryClient["getRoomReceipts"]>>[0]): Promise<unknown> {
        const client = await this.roomMessagingContext("read");
        if (!client.getRoomReceipts) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "The caller-bound room messaging client does not support receipts.");
        try { return sanitizeRoomReceipts(await client.getRoomReceipts(request)); }
        catch (error) { if (error instanceof McpRuntimeError) throw error; const status = (error as { status?: number }).status; if (typeof status === "number") throw statusError(status, ""); throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Room receipts could not be read with the current room permission.", { retryable: false }); }
    }

    async updateRoomReceipts(request: Parameters<NonNullable<RoomHistoryClient["updateRoomReceipts"]>>[0]): Promise<unknown> {
        const client = await this.roomMessagingContext("read");
        if (!client.updateRoomReceipts) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "The caller-bound room messaging client does not support receipt updates.");
        const readUpto = coerceRoomSequence(request.readUpto);
        const deliveredUpto = coerceRoomSequence(request.deliveredUpto);
        if (readUpto === null || deliveredUpto === null) throw new McpRuntimeError("INVALID_ARGUMENT", "This room sequence is stored as a decimal string because it does not fit a safe JavaScript number.");
        if (readUpto === undefined && deliveredUpto === undefined) throw new McpRuntimeError("INVALID_ARGUMENT", "Provide a nonnegative readUpto or deliveredUpto value.");
        try {
            await client.updateRoomReceipts({ ...request, ...(readUpto === undefined ? {} : { readUpto }), ...(deliveredUpto === undefined ? {} : { deliveredUpto }) });
            return { updated: true, ...(request.deliveredUpto === undefined ? {} : { deliveredUpto: request.deliveredUpto }), ...(request.readUpto === undefined ? {} : { readUpto: request.readUpto }), metadataSource: "relayer_unverified" };
        } catch (error) { if (error instanceof McpRuntimeError) throw error; const status = (error as { status?: number }).status; if (typeof status === "number") throw statusError(status, ""); throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room receipt watermark could not be updated with the current reader permission.", { retryable: false }); }
    }

    async getRoomReadState(): Promise<unknown> {
        const client = await this.roomMessagingContext("read");
        if (!client.getRoomReadState) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "The caller-bound room client does not support private read-state sync.");
        try { return sanitizeRoomReadState(await client.getRoomReadState()); }
        catch (error) { if (error instanceof McpRuntimeError) throw error; const status = (error as { status?: number }).status; if (typeof status === "number") throw statusError(status, ""); throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Private room read state could not be decrypted for the authenticated agent.", { retryable: false }); }
    }

    async updateRoomReadState(request: { groupId: string; readUpto: number }): Promise<unknown> {
        const client = await this.roomMessagingContext("read");
        if (!client.updateRoomReadState) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "The caller-bound room client does not support private read-state updates.");
        if (!/^0x[0-9a-fA-F]{1,64}$/.test(request.groupId) || !Number.isSafeInteger(request.readUpto) || request.readUpto < 0) throw new McpRuntimeError("INVALID_ARGUMENT", "A MySo room ID and nonnegative safe-integer readUpto are required.");
        try { return sanitizeRoomReadState(await client.updateRoomReadState(request)); }
        catch (error) { if (error instanceof McpRuntimeError) throw error; const status = (error as { status?: number }).status; if (typeof status === "number") throw statusError(status, ""); throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The private room read marker could not be updated with current reader permission.", { retryable: false }); }
    }

    async getRoomUnreadCounts(request: { groupIds: string[] }): Promise<unknown> {
        const client = await this.roomMessagingContext("read");
        if (!client.getRoomUnreadCounts) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "The caller-bound room client does not support unread-count sync.");
        if (!Array.isArray(request.groupIds) || request.groupIds.length < 1 || request.groupIds.length > 50 || request.groupIds.some((id) => !/^0x[0-9a-fA-F]{1,64}$/.test(id)) || new Set(request.groupIds.map((id) => id.toLowerCase())).size !== request.groupIds.length) throw new McpRuntimeError("INVALID_ARGUMENT", "groupIds must contain 1–50 unique MySo room IDs.");
        try { return sanitizeUnreadCounts(await client.getRoomUnreadCounts(request), request.groupIds); }
        catch (error) { if (error instanceof McpRuntimeError) throw error; const status = (error as { status?: number }).status; if (typeof status === "number") throw statusError(status, ""); throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Unread counts could not be read with current reader permission for every room.", { retryable: false }); }
    }

    async reactToPost(input: ReactToPostInput): Promise<unknown> {
        const { idempotencyKey, ...parameters } = input;
        return this.executeRegisteredAction("social.react_to_post.v1", parameters, idempotencyKey);
    }

    async createPost(input: CreatePostInput): Promise<unknown> {
        const { idempotencyKey, ...parameters } = input;
        return this.executeRegisteredAction("social.create_post.v1", parameters, idempotencyKey);
    }

    async createComment(input: CreateCommentInput): Promise<unknown> {
        const { idempotencyKey, ...parameters } = input;
        return this.executeRegisteredAction("social.create_comment.v1", parameters, idempotencyKey);
    }

    async reactToComment(input: ReactToCommentInput): Promise<unknown> {
        const { idempotencyKey, ...parameters } = input;
        return this.executeRegisteredAction("social.react_to_comment.v1", parameters, idempotencyKey);
    }

    async createRepost(input: CreateRepostInput): Promise<unknown> {
        const { idempotencyKey, ...parameters } = input;
        return this.executeRegisteredAction("social.create_repost.v1", parameters, idempotencyKey);
    }

    private executeInput<T extends object>(
        action: SocialActionId,
        input: T & { idempotencyKey: string },
    ): Promise<unknown> {
        const { idempotencyKey, ...parameters } = input;
        return this.executeRegisteredAction(action, parameters, idempotencyKey);
    }

    async removePostReaction(input: IdempotentInput<RemovePostReactionParams>): Promise<unknown> {
        return this.executeInput("social.remove_post_reaction.v1", input);
    }

    async removeCommentReaction(input: IdempotentInput<RemoveCommentReactionParams>): Promise<unknown> {
        return this.executeInput("social.remove_comment_reaction.v1", input);
    }

    async editPost(input: IdempotentInput<EditPostParams>): Promise<unknown> {
        return this.executeInput("social.edit_post.v1", input);
    }

    async editComment(input: IdempotentInput<EditCommentParams>): Promise<unknown> {
        return this.executeInput("social.edit_comment.v1", input);
    }

    async removeRepost(input: IdempotentInput<RemoveRepostParams>): Promise<unknown> {
        return this.executeInput("social.remove_repost.v1", input);
    }

    async followProfile(input: IdempotentInput<ProfileRelationParams>): Promise<unknown> {
        return this.executeInput("social.follow_profile.v1", input);
    }

    async unfollowProfile(input: IdempotentInput<ProfileRelationParams>): Promise<unknown> {
        return this.executeInput("social.unfollow_profile.v1", input);
    }

    async blockProfile(input: IdempotentInput<ProfileRelationParams>): Promise<unknown> {
        return this.executeInput("social.block_profile.v1", input);
    }

    async unblockProfile(input: IdempotentInput<ProfileRelationParams>): Promise<unknown> {
        return this.executeInput("social.unblock_profile.v1", input);
    }

    async sendMessage(input: IdempotentInput<SendMessageParams>): Promise<unknown> {
        return this.executeInput("messaging.send_message.v1", input);
    }

    async createMessagingGroup(input: IdempotentInput<CreateMessagingGroupParams>): Promise<unknown> {
        return this.executeInput("messaging.create_group.v1", input);
    }

    async bindAgentRoomToTask(input: IdempotentInput<{ groupId: string; taskId: string }>): Promise<unknown> {
        return this.executeInput("messaging.bind_room_to_task.v1", input);
    }

    async acceptOrganizationInvitation(input: IdempotentInput<OrganizationInvitationDecisionParams>): Promise<unknown> {
        return this.executeInput("organization.accept_invitation.v1", input);
    }

    async declineOrganizationInvitation(input: IdempotentInput<OrganizationInvitationDecisionParams>): Promise<unknown> {
        return this.executeInput("organization.decline_invitation.v1", input);
    }

    async registerChildAgent(
        input: IdempotentInput<Omit<RegisterChildAgentParams, "parentAgentObjectId"> & { parentAgentObjectId?: string }>,
    ): Promise<unknown> {
        await this.ensureDeploymentPlatform();
        const context = parseAgentContext(await this.signedJson("GET", "/api/agent/context"));
        return this.executeInput("agent.register_child.v1", {
            ...input,
            parentAgentObjectId: input.parentAgentObjectId ?? context.agentObjectId,
        });
    }

    async updateChildAgent(input: IdempotentInput<UpdateManagedAgentParams>): Promise<unknown> {
        return this.executeInput("agent.update_child.v1", input);
    }

    async deactivateChildAgent(input: IdempotentInput<ManagedAgentParams>): Promise<unknown> {
        return this.executeInput("agent.deactivate_child.v1", input);
    }

    async revokeChildAgent(input: IdempotentInput<ManagedAgentParams>): Promise<unknown> {
        return this.executeInput("agent.revoke_child.v1", input);
    }

    async getOrganizationControl(organizationId: string): Promise<unknown> {
        if (!normalizeAddress(organizationId)) {
            throw new McpRuntimeError("INVALID_ARGUMENT", "organizationId must be an object ID.");
        }
        await this.ensureDeploymentPlatform();
        return this.signedJson(
            "GET",
            `/api/organizations/${encodeURIComponent(organizationId)}/control`,
        );
    }

    async listInbox(input: { limit?: number; offset?: number; groupId?: string; afterCreatedAtMs?: number; afterSeq?: number }): Promise<unknown> {
        await this.ensureDeploymentPlatform();
        const query = new URLSearchParams();
        if (input.limit !== undefined) query.set("limit", String(input.limit));
        if (input.offset !== undefined) query.set("offset", String(input.offset));
        if (input.groupId) query.set("groupId", input.groupId);
        if (input.afterCreatedAtMs !== undefined) query.set("afterCreatedAtMs", String(input.afterCreatedAtMs));
        if (input.afterSeq !== undefined) query.set("afterSeq", String(input.afterSeq));
        const suffix = query.size > 0 ? `?${query}` : "";
        return this.signedJson("GET", `/api/messaging/inbox${suffix}`);
    }

    async waitForMessage(input: { timeoutMs?: number; groupId?: string; afterCreatedAtMs?: number; afterSeq?: number }): Promise<unknown> {
        await this.ensureDeploymentPlatform();
        const query = new URLSearchParams();
        if (input.timeoutMs !== undefined) query.set("timeoutMs", String(input.timeoutMs));
        if (input.groupId) query.set("groupId", input.groupId);
        if (input.afterCreatedAtMs !== undefined) query.set("afterCreatedAtMs", String(input.afterCreatedAtMs));
        if (input.afterSeq !== undefined) query.set("afterSeq", String(input.afterSeq));
        const suffix = query.size > 0 ? `?${query}` : "";
        return this.signedJson("GET", `/api/messaging/wait${suffix}`);
    }

    async getActionStatus(digest: string): Promise<unknown> {
        if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(digest)) {
            throw new McpRuntimeError("INVALID_ARGUMENT", "digest must be a 43- or 44-character base58 transaction digest.");
        }
        await this.ensureDeploymentPlatform();
        return this.signedJson("GET", `/api/chain/actions/${encodeURIComponent(digest)}`);
    }

    async requestActionApproval(input: ActionApprovalInput): Promise<unknown> {
        this.validateApprovalInput(input);
        await this.assertActionInAuthenticatedCatalog(input.registryAction);
        return this.signedJson("POST", "/api/chain/approvals/request", {
            registryAction: input.registryAction,
            registryVersion: SOCIAL_ACTION_REGISTRY_VERSION,
            idempotencyKey: input.idempotencyKey,
            parameters: input.parameters,
            expiresInSeconds: input.expiresInSeconds,
            signerAddress: input.signerAddress,
        });
    }

    async approveAction(input: ActionApprovalDecisionInput): Promise<unknown> {
        if (!/^[0-9a-f-]{36}$/i.test(input.approvalId)) {
            throw new McpRuntimeError("INVALID_ARGUMENT", "approvalId must be a UUID.");
        }
        if (input.walletSignature.length < 80 || input.walletSignature.length > 4096) {
            throw new McpRuntimeError("INVALID_ARGUMENT", "A serialized wallet personal-message signature is required.");
        }
        return this.requestJson(
            "POST",
            `/api/chain/approvals/${encodeURIComponent(input.approvalId)}/approve`,
            { "content-type": "application/json" },
            JSON.stringify({ walletSignature: input.walletSignature }),
        );
    }

    async prepareApprovedAction(input: ApprovedActionPrepareInput): Promise<unknown> {
        this.validateApprovalInput(input);
        if (!/^[0-9a-f-]{36}$/i.test(input.approvalId)) {
            throw new McpRuntimeError("INVALID_ARGUMENT", "approvalId must be a UUID.");
        }
        await this.assertActionInAuthenticatedCatalog(input.registryAction);
        return this.signedJson("POST", "/api/chain/actions/prepare", {
            registryAction: input.registryAction,
            registryVersion: SOCIAL_ACTION_REGISTRY_VERSION,
            idempotencyKey: input.idempotencyKey,
            parameters: input.parameters,
            approvalId: input.approvalId,
        });
    }

    async submitApprovedAction(input: ApprovedActionSubmitInput): Promise<unknown> {
        getSocialActionDescriptor(input.registryAction);
        if (!/^[A-Za-z0-9._:/-]{8,128}$/.test(input.idempotencyKey)) {
            throw new McpRuntimeError("INVALID_ARGUMENT", "idempotencyKey must be 8-128 URL-safe characters.");
        }
        if (!/^[0-9a-f-]{36}$/i.test(input.approvalId) || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(input.digest)) {
            throw new McpRuntimeError("INVALID_ARGUMENT", "approvalId or digest is invalid.");
        }
        if (!input.walletSignature.trim()) {
            throw new McpRuntimeError("INVALID_ARGUMENT", "walletSignature is required.");
        }
        await this.assertActionInAuthenticatedCatalog(input.registryAction);
        return this.signedJson("POST", "/api/chain/actions/submit", {
            registryAction: input.registryAction,
            registryVersion: SOCIAL_ACTION_REGISTRY_VERSION,
            idempotencyKey: input.idempotencyKey,
            approvalId: input.approvalId,
            digest: input.digest,
            signature: input.walletSignature,
        });
    }

    private validateApprovalInput(input: ActionApprovalInput): void {
        const validation = getSocialActionDescriptor(input.registryAction).validate(input.parameters as never);
        if (!validation.success) {
            throw new McpRuntimeError(
                "INVALID_ARGUMENT",
                `Registered action parameters are invalid: ${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`,
            );
        }
        if (!/^[A-Za-z0-9._:/-]{8,128}$/.test(input.idempotencyKey)) {
            throw new McpRuntimeError("INVALID_ARGUMENT", "idempotencyKey must be 8-128 URL-safe characters.");
        }
        if (input.signerAddress !== undefined && !/^0x[0-9a-fA-F]{1,64}$/.test(input.signerAddress)) {
            throw new McpRuntimeError("INVALID_ARGUMENT", "signerAddress must be a MySo address.");
        }
    }

    async editRoomMessage(request: Parameters<NonNullable<RoomHistoryClient["editRoomMessage"]>>[0]): Promise<unknown> {
        const client = await this.roomMessagingContext("send");
        if (!client.editRoomMessage) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "The caller-bound room messaging client does not support message edits.");
        if (!request.messageId.trim() || !request.text.trim() || request.text.length > 8000) throw new McpRuntimeError("INVALID_ARGUMENT", "Message ID and nonempty text up to 8000 characters are required.");
        try { return await client.editRoomMessage(request); }
        catch (error) { if (error instanceof McpRuntimeError) throw error; const status = (error as { status?: number }).status; if (typeof status === "number") throw statusError(status, ""); throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The message could not be edited and verified with current room permission.", { retryable: false }); }
    }

    async deleteRoomMessage(request: Parameters<NonNullable<RoomHistoryClient["deleteRoomMessage"]>>[0]): Promise<unknown> {
        const client = await this.roomMessagingContext("send");
        if (!client.deleteRoomMessage) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "The caller-bound room messaging client does not support message deletion.");
        if (!request.messageId.trim()) throw new McpRuntimeError("INVALID_ARGUMENT", "messageId is required.");
        try { return await client.deleteRoomMessage(request); }
        catch (error) { if (error instanceof McpRuntimeError) throw error; const status = (error as { status?: number }).status; if (typeof status === "number") throw statusError(status, ""); throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The message could not be deleted and verified with current room permission.", { retryable: false }); }
    }

    async removeRoomMembersAndRotateKey(request: { groupRef: { groupId: string; encryptionHistoryId: string } | { uuid: string }; members: string[] }): Promise<unknown> {
        const client = await this.roomMessagingContext("send");
        if (!client.removeRoomMembersAndRotateKey) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "The caller-bound room client does not support member removal with key rotation.");
        const groupId = "groupId" in request.groupRef ? request.groupRef.groupId : undefined;
        if (!Array.isArray(request.members) || request.members.length < 1 || request.members.length > 50 || request.members.some((member) => !normalizeAddress(member)) || new Set(request.members.map(normalizeAddress)).size !== request.members.length) throw new McpRuntimeError("INVALID_ARGUMENT", "Provide 1–50 unique MySo member addresses.");
        try {
            const result = await client.removeRoomMembersAndRotateKey(request);
            if (!groupId) {
                if (!result || typeof result !== "object" || Array.isArray(result) || typeof (result as Record<string, unknown>).groupId !== "string") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The removal result is missing its verified room ID.");
                return sanitizeRoomMemberRemoval(result, (result as Record<string, unknown>).groupId as string, request.members);
            }
            return sanitizeRoomMemberRemoval(result, groupId, request.members);
        } catch (error) { if (error instanceof McpRuntimeError) throw error; const status = (error as { status?: number }).status; if (typeof status === "number") throw statusError(status, ""); throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The members could not be removed and room key rotation verified.", { retryable: false }); }
    }

    async addRoomMembers(request: { groupRef: { groupId: string; encryptionHistoryId: string } | { uuid: string }; members: string[]; acknowledgeHistoryAccess: true }): Promise<unknown> {
        const client = await this.roomMessagingContext("send");
        if (!client.addRoomMembers) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "The caller-bound room client does not support member invitations.");
        if (request.acknowledgeHistoryAccess !== true) throw new McpRuntimeError("INVALID_ARGUMENT", "Explicitly acknowledge that every invited wallet can access existing and future room history.");
        const groupId = "groupId" in request.groupRef ? request.groupRef.groupId : undefined;
        if (!Array.isArray(request.members) || request.members.length < 1 || request.members.length > 50 || request.members.some((member) => !normalizeAddress(member)) || new Set(request.members.map(normalizeAddress)).size !== request.members.length) throw new McpRuntimeError("INVALID_ARGUMENT", "Provide 1–50 unique MySo member addresses.");
        try {
            const result = await client.addRoomMembers(request);
            if (!groupId) {
                if (!result || typeof result !== "object" || Array.isArray(result) || typeof (result as Record<string, unknown>).groupId !== "string") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The invitation result is missing its verified room ID.");
                return sanitizeRoomMemberAddition(result, (result as Record<string, unknown>).groupId as string, request.members);
            }
            return sanitizeRoomMemberAddition(result, groupId, request.members);
        } catch (error) { if (error instanceof McpRuntimeError) throw error; const status = (error as { status?: number }).status; if (typeof status === "number") throw statusError(status, ""); throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room members could not be invited and their history access verified.", { retryable: false }); }
    }

    async leaveRoom(request: { groupRef: { groupId: string; encryptionHistoryId: string } | { uuid: string } }): Promise<unknown> {
        const client = await this.roomMessagingContext("send");
        if (!client.leaveRoom) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "The caller-bound room client does not support self-removal.");
        const groupId = "groupId" in request.groupRef ? request.groupRef.groupId : undefined;
        try {
            const result = await client.leaveRoom(request);
            if (!groupId && (!result || typeof result !== "object" || Array.isArray(result) || typeof (result as Record<string, unknown>).groupId !== "string")) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The leave result omitted its verified room ID.");
            return sanitizeRoomLeave(result, groupId ?? (result as Record<string, unknown>).groupId as string);
        } catch (error) { if (error instanceof McpRuntimeError) throw error; const status = (error as { status?: number }).status; if (typeof status === "number") throw statusError(status, ""); throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The agent could not leave the room and verify its membership status.", { retryable: false }); }
    }

    async setRoomName(request: { groupRef: { groupId: string; encryptionHistoryId: string } | { uuid: string }; name: string }): Promise<unknown> {
        const client = await this.roomMessagingContext("send");
        if (!client.setRoomName) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "The caller-bound room client does not support metadata updates.");
        const name = request.name.trim().normalize("NFC");
        if (!name || name.length > 128 || /[\u0000-\u001f\u007f]/u.test(name)) throw new McpRuntimeError("INVALID_ARGUMENT", "Room name must contain 1–128 printable characters.");
        try { return sanitizeRoomRename(await client.setRoomName({ ...request, name }), name, "groupId" in request.groupRef ? request.groupRef.groupId : undefined); }
        catch (error) { if (error instanceof McpRuntimeError) throw error; const status = (error as { status?: number }).status; if (typeof status === "number") throw statusError(status, ""); throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room name could not be updated and verified against the configured fullnode.", { retryable: false }); }
    }

    async archiveRoom(request: { groupRef: { groupId: string; encryptionHistoryId: string } | { uuid: string }; ownerConfirmation: { owner: string; agentObjectId: string; groupId: string; expiresAtMs: number; nonce: string; signature: string } }): Promise<unknown> {
        const client = await this.roomMessagingContext("send");
        if (!client.archiveRoom) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "The caller-bound room client does not support permanent archiving.");
        try {
            const result = await client.archiveRoom(request);
            if (!result || typeof result !== "object" || Array.isArray(result)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The archive client returned an invalid receipt.");
            const receipt = result as Record<string, unknown>;
            const expectedGroupId = "groupId" in request.groupRef ? normalizeAddress(request.groupRef.groupId) : undefined;
            if (receipt.archived !== true || typeof receipt.groupId !== "string" || !normalizeAddress(receipt.groupId)
                || (expectedGroupId && normalizeAddress(receipt.groupId) !== expectedGroupId)
                || typeof receipt.digest !== "string" || !receipt.digest
                || receipt.verification !== "finalized_archive_transaction" || receipt.source !== "myso_fullnode") {
                throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The archive receipt did not match the finalized room transaction.");
            }
            return { archived: true, groupId: normalizeAddress(receipt.groupId), digest: receipt.digest, verification: "finalized_archive_transaction", source: "myso_fullnode" };
        } catch (error) { if (error instanceof McpRuntimeError) throw error; const status = (error as { status?: number }).status; if (typeof status === "number") throw statusError(status, ""); throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room could not be permanently archived and verified.", { retryable: false }); }
    }

    private async assertActionInAuthenticatedCatalog(action: SocialActionId): Promise<void> {
        await this.ensureDeploymentPlatform();
        const descriptor = getSocialActionDescriptor(action);
        // Owner rotation is a two-wallet, owner-signed protocol. The agent
        // capability catalog is not its authorization source; the Memory
        // approval route checks the authenticated old owner, pending migration,
        // selected signer, exact manifest references and Move's state guards.
        if (action === "account.rotate_owner_key.v1") return;
        const context = parseAgentContext(await this.signedJson("GET", "/api/agent/context"));
        if (!capabilityPresent(context.capabilities, descriptor.requiredCapability)) {
            throw new McpRuntimeError("CAPABILITY_DENIED", "The agent lacks the action capability.");
        }
        if (((action.startsWith("subscription.") || action.startsWith("access.") || action==="payments.send_token.v1" || action==="poc.claim_creator_vault.v1" || action.startsWith("spot.")) && !context.permittedRegistryActions?.includes(action))
            || (context.permittedRegistryActions && !context.permittedRegistryActions.includes(action))) {
            throw new McpRuntimeError("CAPABILITY_DENIED", "The action is not in the authenticated registry catalog.");
        }
    }

    private async publishMyDataGraph(request: Record<string, unknown>): Promise<unknown> {
        const idempotencyKey = request.idempotencyKey;
        if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:/-]{8,128}$/.test(idempotencyKey)) {
            throw new McpRuntimeError("INVALID_ARGUMENT", "request.idempotencyKey must be 8-128 URL-safe characters.");
        }
        const inputHash = createHash("sha256").update(canonicalGraphJson(request)).digest("hex");
        const cacheKey = `${this.accountId}:${idempotencyKey}`;
        let preparation = this.graphPublishPreparations.get(cacheKey);
        if (preparation && preparation.inputHash !== inputHash) {
            throw new McpRuntimeError("CONFLICT", "This idempotencyKey was already used with different graph publication input.");
        }
        if (!preparation) {
            const promise = this.prepareMyDataGraphListing(request);
            preparation = { inputHash, promise };
            this.graphPublishPreparations.set(cacheKey, preparation);
            if (this.graphPublishPreparations.size > 256) {
                const oldest = this.graphPublishPreparations.keys().next().value;
                if (oldest && oldest !== cacheKey) this.graphPublishPreparations.delete(oldest);
            }
            void promise.catch(() => {
                if (this.graphPublishPreparations.get(cacheKey)?.promise === promise) this.graphPublishPreparations.delete(cacheKey);
            });
        }
        const prepared = await preparation.promise;
        const result = await this.executeRegisteredAction("access.publish_mydata_graph.v1", prepared.parameters, idempotencyKey);
        return { ...requireJsonObject(result, "Graph publication action"), graphId: prepared.graphId, graphVersion: prepared.graphVersion,
            manifestHashHex: prepared.manifestHashHex, mydataMediaType: "application/vnd.mysocial.graph-manifest+json;version=1" };
    }

    private async prepareMyDataGraphListing(request: Record<string, unknown>): Promise<{ parameters: unknown; manifestHashHex: string; graphId: string; graphVersion: number }> {
        const manifest = request.manifest;
        const authorityInput = request.authorityProof;
        const offerTerms = request.offerTerms as MySoGraphOfferTerms | undefined;
        if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || !authorityInput || typeof authorityInput !== "object" || Array.isArray(authorityInput)
            || !offerTerms || typeof offerTerms !== "object" || !Number.isSafeInteger(request.publishedAtMs) || Number(request.publishedAtMs) < 1) {
            throw new McpRuntimeError("INVALID_ARGUMENT", "A GraphManifest, authority proof, offer terms and publishedAtMs are required.");
        }
        const proof = authorityInput as Record<string, unknown>;
        if ((proof.kind !== "organization_admin" && proof.kind !== "sell_graph_delegate") || typeof proof.organizationId !== "string"
            || !Number.isSafeInteger(proof.checkedAtMs) || Number(proof.checkedAtMs) < 0
            || (proof.kind === "organization_admin" && proof.delegateId !== undefined)) {
            throw new McpRuntimeError("INVALID_ARGUMENT", "The seller authority proof is malformed.");
        }
        await this.ensureDeploymentPlatform();
        const context = parseAgentContext(await this.signedJson("GET", "/api/agent/context"));
        const sellerAddress = normalizeAddress(await this.signer.getMySoAddress());
        const configuredAddress = normalizeAddress(context.derivedAddress);
        if (!sellerAddress || sellerAddress !== configuredAddress || !capabilityPresent(context.capabilities, CAP_MYDATA_READ)
            || !context.permittedRegistryActions?.includes("access.publish_mydata_graph.v1")) {
            throw new McpRuntimeError("CAPABILITY_DENIED", "The authenticated agent cannot publish MyData GraphManifest listings.");
        }
        const publicKey = await this.signer.getPublicKey();
        const normalizedProof: MySoGraphAuthorityProof = {
            kind: proof.kind,
            organizationId: proof.organizationId,
            capability: "sell_graph",
            checkedAtMs: Number(proof.checkedAtMs),
            ...(proof.kind === "sell_graph_delegate" ? { delegateId: typeof proof.delegateId === "string" ? proof.delegateId : sellerAddress } : {}),
        };
        const document = await createMySoGraphPublication(
            manifest,
            normalizedProof,
            offerTerms,
            { sellerAddress, sellerPublicKeyHex: Buffer.from(publicKey).toString("hex"), sign: (message) => this.signer.sign(message) },
            async (address, authority) => {
                const checked = requireJsonObject(await this.signedJson("POST", "/api/mydata/graph/verify-seller", { organizationId: authority.organizationId, sellerAddress: address }), "Graph seller authority");
                return checked.authorized === true && checked.kind === authority.kind;
            },
            Number(request.publishedAtMs),
        );
        const manifestHashHex = graphManifestHashHex(document.manifest);
        const graph = document.manifest as MySoGraphManifest;
        const encryptionId = `mysocial-graph-v1:${sellerAddress}:${graph.graphId}:${graph.graphVersion}:${manifestHashHex}`;
        const tags = encodeMySoGraphPublicationTags(document.publication);
        const encrypted = requireJsonObject(await this.signedJson("POST", "/api/mydata/graph/encrypt", { document, tags, encryptionId, idempotencyKey: request.idempotencyKey }), "Encrypted GraphManifest");
        if (typeof encrypted.encryptedDataBase64 !== "string" || typeof encrypted.encryptionIdHex !== "string"
            || typeof encrypted.encryptedDataDigestHex !== "string" || encrypted.manifestHashHex !== manifestHashHex) {
            throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The MyData encryption service returned an invalid GraphManifest result.");
        }
        const accessKind = offerTerms.accessKind;
        const parameters = {
            mediaType: "application/vnd.mysocial.graph-manifest+json;version=1",
            tags,
            timestampStart: String(request.publishedAtMs),
            encryptedDataHex: Buffer.from(encrypted.encryptedDataBase64, "base64").toString("hex"),
            encryptionIdHex: encrypted.encryptionIdHex,
            accessKind,
            priceMist: offerTerms.priceMist,
            durationDays: offerTerms.durationDays,
            platformObjectId: this.platformId,
        };
        const validation = getSocialActionDescriptor("access.publish_mydata_graph.v1").validate(parameters);
        if (!validation.success) throw new McpRuntimeError("INVALID_ARGUMENT", validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
        return { parameters: validation.value, manifestHashHex, graphId: graph.graphId, graphVersion: graph.graphVersion };
    }

    private async executeRegisteredAction(
        action: SocialActionId,
        parameters: unknown,
        idempotencyKey: string,
    ): Promise<unknown> {
        const descriptor = getSocialActionDescriptor(action);
        const boundedSptTrade = action === "spt.buy.v1" || action === "spt.sell.v1";
        if (descriptor.riskTier !== "1A" && descriptor.riskTier !== "1B" && !boundedSptTrade) {
            throw new McpRuntimeError(
                "CAPABILITY_DENIED",
                "Only registered Tier 1A and Tier 1B actions may execute automatically.",
            );
        }
        await this.ensureDeploymentPlatform();
        const context = parseAgentContext(await this.signedJson("GET", "/api/agent/context"));
        resolveExecutionContext(context, {
            network: this.networkPin,
            rpcUrl: this.rpcUrlPin,
            chain: this.chainPins,
        });
        const signerAddress = normalizeAddress(await this.signer.getMySoAddress());
        const contextAccount = normalizeAddress(context.memoryAccountId);
        const configuredAccount = normalizeAddress(this.accountId);
        const contextSigner = normalizeAddress(context.derivedAddress);
        if (
            !contextAccount ||
            !configuredAccount ||
            !contextSigner ||
            !signerAddress ||
            contextAccount !== configuredAccount ||
            contextSigner !== signerAddress
        ) {
            throw new McpRuntimeError("AUTHENTICATION_FAILED", "The signer does not match the authenticated agent context.");
        }
        if (!capabilityPresent(context.capabilities, descriptor.requiredCapability)) {
            throw new McpRuntimeError("CAPABILITY_DENIED", "The agent lacks the capability required by the registered action.");
        }
        // MyData purchases have an exact quote-based automatic policy in the
        // server (live on-chain capability, per-action cap and audience checks).
        // Let that policy decide instead of rejecting on the broader capability bit.
        if (boundedSptTrade && capabilityPresent(context.approvalRequiredCapabilities, descriptor.requiredCapability)) {
            return this.requestActionApproval({ registryAction: action, parameters: parameters as Record<string, unknown>, idempotencyKey });
        }
        if (action === "poc.claim_creator_vault.v1" || action.startsWith("spot.") || (action !== "access.purchase_mydata_access.v1" && capabilityPresent(context.approvalRequiredCapabilities, descriptor.requiredCapability))) {
            throw new McpRuntimeError(
                "APPROVAL_FLOW_NOT_AVAILABLE",
                `The registered action ${action} requires owner approval. Use the chain request/approve/prepare/submit tools.`,
                { approvalRequired: true },
            );
        }
        if (
            ((action.startsWith("subscription.") || action.startsWith("access.") || action==="payments.send_token.v1") && !context.permittedRegistryActions?.includes(action)) ||
            (context.permittedRegistryActions && !context.permittedRegistryActions.includes(action))
        ) {
            throw new McpRuntimeError(
                "CAPABILITY_DENIED",
                "The authenticated action catalog does not expose this registered action.",
            );
        }
        if (
            context.platformScope &&
            normalizeAddress(context.platformScope) !== normalizeAddress(this.platformId ?? "")
        ) {
            throw new McpRuntimeError("CAPABILITY_DENIED", "The configured platform is outside the agent's scope.");
        }

        if (!/^[A-Za-z0-9._:/-]{8,128}$/.test(idempotencyKey)) {
            throw new McpRuntimeError(
                "INVALID_ARGUMENT",
                "idempotencyKey must be 8-128 URL-safe characters.",
            );
        }
        const prepared = parsePreparedAction(
            await this.signedJson("POST", "/api/chain/actions/prepare", {
                registryAction: action,
                registryVersion: SOCIAL_ACTION_REGISTRY_VERSION,
                idempotencyKey,
                parameters,
            }),
            action,
            idempotencyKey,
        );
        const sponsoredBytes = Uint8Array.from(Buffer.from(prepared.bytes, "base64"));
        const signature = await this.signer.signTransaction(sponsoredBytes);
        const executed = parseExecution(
            await this.signedJson("POST", "/api/chain/actions/submit", {
                registryAction: action,
                registryVersion: SOCIAL_ACTION_REGISTRY_VERSION,
                idempotencyKey,
                digest: prepared.digest,
                signature,
            }),
            prepared.digest,
        );

        return {
            registryAction: action,
            registryVersion: SOCIAL_ACTION_REGISTRY_VERSION,
            idempotencyKey,
            digest: executed.digest,
            parameterHash: prepared.parameterHash,
            transactionKindHash: prepared.transactionKindHash,
            packageId: prepared.packageId,
            packageVersion: prepared.packageVersion,
            chain: { status: "submitted", digest: executed.digest },
            indexer: { status: "pending" },
        };
    }

    private async ensureDeploymentPlatform(): Promise<void> {
        if (this.platformId) return;
        const config = requireJsonObject(
            await this.requestJson("GET", "/config", {}, undefined),
            "Deployment config",
        );
        const chain = parseChainObject(config.socialChain);
        this.platformId = chain.platformObjectId;
    }

    private async signedJson(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", requestPath: string, body?: object): Promise<unknown> {
        const bodyString = method === "POST" || method === "PUT" || method === "PATCH" ? JSON.stringify(body ?? {}) : "";
        const bodyHash = createHash("sha256").update(bodyString).digest("hex");
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const nonce = randomUUID();
        const canonical = `${timestamp}.${method}.${requestPath}.${bodyHash}.${nonce}.${this.accountId}`;
        const message = new TextEncoder().encode(canonical);
        const [signature, publicKey] = await Promise.all([
            this.signer.sign(message),
            this.signer.getPublicKey(),
        ]);
        const headers: Record<string, string> = {
            "x-public-key": bytesToHex(publicKey),
            "x-signature": bytesToHex(signature),
            "x-timestamp": timestamp,
            "x-nonce": nonce,
            "x-account-id": this.accountId,
            "x-sdk-compatibility": MEMORY_TYPESCRIPT_COMPATIBILITY_VERSION,
        };
        if (bodyString) headers["content-type"] = "application/json";
        if (this.platformId) {
            headers["x-platform-id"] = this.platformId;
            headers["x-platform-signature"] = bytesToHex(await this.signer.sign(new TextEncoder().encode(`mysocial-request-platform-v1|${this.platformId}|${canonical}`)));
        }
        return this.requestJson(method, requestPath, headers, bodyString || undefined);
    }

    private async requestJson(
        method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        requestPath: string,
        headers: Record<string, string>,
        body?: string,
    ): Promise<unknown> {
        let response: Response;
        try {
            response = await this.fetchImpl(`${this.serverUrl}${requestPath}`, {
                method,
                headers,
                body,
                redirect: "error",
                signal: AbortSignal.timeout(requestPath === "/api/ai-credit/chat" ? 210000 : 30000),
            });
        } catch (error) {
            throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The transaction gateway is unavailable.", {
                retryable: true,
                cause: error,
            });
        }
        if (!response.body) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The gateway returned an empty response.");
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = []; let size = 0;
        try {
            for (;;) {
                const part = await reader.read(); if (part.done) break;
                size += part.value.byteLength;
                if (size > 2 * 1024 * 1024) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The gateway response exceeded 2 MiB; reconcile the operation before retrying.");
                chunks.push(part.value);
            }
        } finally { await reader.cancel().catch(() => {}); }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const responseText = new TextDecoder().decode(bytes);
        if (!response.ok) throw statusError(response.status, responseText);
        if (!responseText) return {};
        try {
            return JSON.parse(responseText) as unknown;
        } catch (error) {
            throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The transaction gateway returned invalid JSON.", {
                retryable: true,
                cause: error,
            });
        }
    }
}
