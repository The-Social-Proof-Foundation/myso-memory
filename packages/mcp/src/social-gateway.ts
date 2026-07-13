import { createHash, randomUUID } from "node:crypto";
import { MEMORY_TYPESCRIPT_COMPATIBILITY_VERSION } from "@socialproof/memory";
import {
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
import type { AgentSigner } from "./signers.js";

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

export interface DeleteCommentInput {
    postId: string;
    commentId: string;
}

type IdempotentInput<T> = T & { idempotencyKey: string };

export interface ActionApprovalInput {
    registryAction: SocialActionId;
    parameters: unknown;
    idempotencyKey: string;
    expiresInSeconds?: number;
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
    listActions(): Promise<unknown>;
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
    deletePost(postId: string): Promise<unknown>;
    deleteComment(input: DeleteCommentInput): Promise<unknown>;
    getActionStatus(digest: string): Promise<unknown>;
    requestActionApproval(input: ActionApprovalInput): Promise<unknown>;
    approveAction(input: ActionApprovalDecisionInput): Promise<unknown>;
    prepareApprovedAction(input: ApprovedActionPrepareInput): Promise<unknown>;
    submitApprovedAction(input: ApprovedActionSubmitInput): Promise<unknown>;
}

interface AgentContextResponse {
    memoryAccountId: string;
    agentObjectId: string;
    derivedAddress: string;
    capabilities: number;
    approvalRequiredCapabilities: number;
    platformScope?: string | null;
    network: string;
    rpcUrl: string;
    packageId?: string;
    socialChain: SocialChainConfig;
    permittedRegistryActions?: string[];
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

export interface SponsoredSocialGatewayOptions {
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
    "chain_list_actions",
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
    "messaging_send_message",
    "messaging_create_group",
    "messaging_list_inbox",
    "messaging_wait_for_message",
    "organization_get_control",
    "organization_accept_invitation",
    "organization_decline_invitation",
    "agent_register_child",
    "agent_update_child",
    "agent_deactivate_child",
    "agent_revoke_child",
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

function normalizeAddress(value: string): string {
    const hex = value.trim().toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{1,64}$/.test(hex)) return "";
    return `0x${hex.padStart(64, "0")}`;
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
    const requiredStrings = ["memoryAccountId", "agentObjectId", "derivedAddress", "network", "rpcUrl"] as const;
    for (const key of requiredStrings) {
        if (typeof context[key] !== "string" || !context[key]) {
            throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `Agent context is missing ${key}.`);
        }
    }
    if (
        !normalizeAddress(context.memoryAccountId as string) ||
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
    if (
        context.platformScope !== undefined &&
        context.platformScope !== null &&
        (typeof context.platformScope !== "string" || !normalizeAddress(context.platformScope))
    ) {
        throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Agent context contains an invalid platform scope.");
    }
    return {
        memoryAccountId: context.memoryAccountId as string,
        agentObjectId: context.agentObjectId as string,
        derivedAddress: context.derivedAddress as string,
        capabilities: context.capabilities as number,
        approvalRequiredCapabilities: context.approvalRequiredCapabilities as number,
        platformScope: context.platformScope as string | null | undefined,
        network,
        rpcUrl,
        packageId: typeof context.packageId === "string" ? context.packageId : undefined,
        socialChain,
        permittedRegistryActions: context.permittedRegistryActions as string[] | undefined,
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
    readonly supportedToolNames = SUPPORTED_SOCIAL_TOOLS;
    private readonly signer: AgentSigner;
    private readonly accountId: string;
    private readonly serverUrl: string;
    private platformId?: string;
    private readonly networkPin?: MySoNetwork;
    private readonly rpcUrlPin?: string;
    private readonly chainPins?: Partial<SocialChainConfig>;
    private readonly fetchImpl: typeof globalThis.fetch;

    constructor(options: SponsoredSocialGatewayOptions) {
        if (!normalizeAddress(options.accountId)) {
            throw new McpRuntimeError(
                "INVALID_CONFIGURATION",
                "accountId must be a valid MySo object ID.",
            );
        }
        this.signer = options.signer;
        this.accountId = options.accountId;
        this.serverUrl = options.serverUrl.replace(/\/$/, "");
        this.platformId = options.platformId;
        this.networkPin = options.network;
        this.rpcUrlPin = options.rpcUrl;
        this.chainPins = options.chain;
        this.fetchImpl = options.fetch ?? globalThis.fetch;
    }

    async listActions(): Promise<unknown> {
        await this.ensureDeploymentPlatform();
        const context = parseAgentContext(await this.signedJson("GET", "/api/agent/context"));
        const permitted = new Set(context.permittedRegistryActions ?? []);
        return {
            catalogVersion: PRODUCTION_ACTION_CATALOG_VERSION,
            registryVersion: SOCIAL_ACTION_REGISTRY_VERSION,
            actions: PRODUCTION_ACTION_CATALOG.map((action) => ({
                ...action,
                permitted:
                    action.availability === "enabled" &&
                    action.requiredCapability !== null &&
                    capabilityPresent(context.capabilities, action.requiredCapability) &&
                    (!context.permittedRegistryActions || permitted.has(action.id)),
                approvalRequired:
                    action.tier !== "1" ||
                    (action.requiredCapability !== null &&
                        capabilityPresent(
                            context.approvalRequiredCapabilities,
                            action.requiredCapability,
                        )),
            })),
        };
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

    async deletePost(_postId: string): Promise<unknown> {
        throw this.approvalUnavailable("Post deletion");
    }

    async deleteComment(_input: DeleteCommentInput): Promise<unknown> {
        throw this.approvalUnavailable("Comment deletion");
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
    }

    private async assertActionInAuthenticatedCatalog(action: SocialActionId): Promise<void> {
        await this.ensureDeploymentPlatform();
        const descriptor = getSocialActionDescriptor(action);
        const context = parseAgentContext(await this.signedJson("GET", "/api/agent/context"));
        if (!capabilityPresent(context.capabilities, descriptor.requiredCapability)) {
            throw new McpRuntimeError("CAPABILITY_DENIED", "The agent lacks the action capability.");
        }
        if (context.permittedRegistryActions && !context.permittedRegistryActions.includes(action)) {
            throw new McpRuntimeError("CAPABILITY_DENIED", "The action is not in the authenticated registry catalog.");
        }
    }

    private async executeRegisteredAction(
        action: SocialActionId,
        parameters: unknown,
        idempotencyKey: string,
    ): Promise<unknown> {
        const descriptor = getSocialActionDescriptor(action);
        if (descriptor.riskTier !== "1A" && descriptor.riskTier !== "1B") {
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
        if (capabilityPresent(context.approvalRequiredCapabilities, descriptor.requiredCapability)) {
            throw new McpRuntimeError(
                "APPROVAL_FLOW_NOT_AVAILABLE",
                `The registered action ${action} requires owner approval. Use the chain request/approve/prepare/submit tools.`,
                { approvalRequired: true },
            );
        }
        if (
            context.permittedRegistryActions &&
            !context.permittedRegistryActions.includes(action)
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

    private approvalUnavailable(label: string): McpRuntimeError {
        return new McpRuntimeError(
            "APPROVAL_FLOW_NOT_AVAILABLE",
            `${label} requires the chain request/approve/prepare/submit wallet flow.`,
            { approvalRequired: true },
        );
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

    private async signedJson(method: "GET" | "POST", requestPath: string, body?: object): Promise<unknown> {
        const bodyString = method === "GET" ? "" : JSON.stringify(body ?? {});
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
        if (this.platformId) headers["x-platform-id"] = this.platformId;
        return this.requestJson(method, requestPath, headers, bodyString || undefined);
    }

    private async requestJson(
        method: "GET" | "POST",
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
            });
        } catch (error) {
            throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The transaction gateway is unavailable.", {
                retryable: true,
                cause: error,
            });
        }
        const responseText = await response.text();
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
