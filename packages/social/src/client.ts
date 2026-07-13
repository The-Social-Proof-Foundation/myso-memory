import type {
    CreateCommentParams,
    CreatePostParams,
    CreateRepostParams,
    DeleteCommentParams,
    ReactToCommentParams,
    ReactToPostParams,
    RemovePostReactionParams,
    RemoveCommentReactionParams,
    EditPostParams,
    EditCommentParams,
    RemoveRepostParams,
    ProfileRelationParams,
    SendMessageParams,
    CreateMessagingGroupParams,
    CreateOrganizationParams,
    UpdateOrganizationMetadataParams,
    UpdateOrganizationCategoryParams,
    OrganizationObjectParams,
    DefineOrganizationRoleParams,
    OrganizationRoleParams,
    CreateOrganizationInvitationParams,
    OrganizationInvitationDecisionParams,
    RegisterRootAgentParams,
    RegisterChildAgentParams,
    UpdateManagedAgentParams,
    ManagedAgentParams,
    SocialActionResult,
    SocialActionOptions,
    SocialClientConfig,
    OwnerWalletSigner,
} from "./types.js";
import { sha256hex, hexToBytes, bytesToHex, normalizeServerUrl } from "./signing.js";
import { MEMORY_TYPESCRIPT_COMPATIBILITY_VERSION } from "@socialproof/memory";
import {
    SOCIAL_ACTION_REGISTRY_VERSION,
    getSocialActionDescriptor,
    type SocialActionId,
} from "./action-registry/index.js";
import type { SocialChainConfig } from "./types.js";

let _ed: typeof import("@noble/ed25519") | null = null;
async function getEd() {
    if (!_ed) _ed = await import("@noble/ed25519");
    return _ed;
}

interface DeploymentConfig {
    network: "mainnet" | "testnet" | "devnet" | "localnet";
    mysoRpcUrl: string;
    socialChain: SocialChainConfig;
}

interface AgentContext {
    owner: string;
    memoryAccountId: string;
    derivedAddress: string;
    capabilities: number;
    approvalRequiredCapabilities: number;
    platformScope?: string | null;
    network: DeploymentConfig["network"];
    rpcUrl: string;
    packageId?: string;
    socialChain: SocialChainConfig;
    permittedRegistryActions?: string[];
}

function normalizedAddress(value: string): string {
    const hex = value.trim().toLowerCase().replace(/^0x/, "");
    return /^[0-9a-f]{1,64}$/.test(hex) ? `0x${hex.padStart(64, "0")}` : "";
}

function normalizedUrl(value: string): string {
    try {
        const parsed = new URL(value);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
        return parsed.toString().replace(/\/$/, "");
    } catch {
        return "";
    }
}

function assertAuthenticatedDeployment(
    deployment: DeploymentConfig,
    context: AgentContext,
): void {
    if (
        context.network !== deployment.network ||
        normalizedUrl(context.rpcUrl) !== normalizedUrl(deployment.mysoRpcUrl)
    ) {
        throw new Error("Authenticated network context differs from public deployment config");
    }
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
    ] as const satisfies readonly (keyof SocialChainConfig)[];
    for (const field of fields) {
        const publicValue = deployment.socialChain[field] ?? (field === "clockId" ? "0x6" : "");
        const authenticatedValue = context.socialChain[field] ?? (field === "clockId" ? "0x6" : "");
        const publicAddress = normalizedAddress(publicValue);
        const authenticatedAddress = normalizedAddress(authenticatedValue);
        if (!publicAddress || !authenticatedAddress || publicAddress !== authenticatedAddress) {
            throw new Error(`Authenticated socialChain.${field} differs from public deployment config`);
        }
    }
    for (const field of [
        "socialGraphId",
        "messagingPackageId",
        "messagingVersionId",
        "messagingConfigId",
        "messagingNamespaceId",
        "messagingGroupManagerId",
        "messagingGroupLeaverId",
    ] as const satisfies readonly (keyof SocialChainConfig)[]) {
        const publicValue = deployment.socialChain[field];
        const authenticatedValue = context.socialChain[field];
        if (publicValue === undefined && authenticatedValue === undefined) continue;
        if (
            typeof publicValue !== "string" ||
            typeof authenticatedValue !== "string" ||
            normalizedAddress(publicValue) !== normalizedAddress(authenticatedValue)
        ) {
            throw new Error(`Authenticated socialChain.${field} differs from public deployment config`);
        }
    }
    if (
        context.packageId &&
        normalizedAddress(context.packageId) !== normalizedAddress(context.socialChain.packageId)
    ) {
        throw new Error("Authenticated packageId differs from authenticated social chain");
    }
}

function base64ToBytes(value: string): Uint8Array {
    const binary = atob(value);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

interface PreparedActionResponse {
    registryAction: string;
    registryVersion: string;
    idempotencyKey: string;
    bytes: string;
    digest: string;
    expiresAtMs: number;
}

interface ActionApprovalResponse {
    approvalId: string;
    registryAction: string;
    registryVersion: string;
    idempotencyKey: string;
    parameterHash: string;
    approvalIntent: string;
    status: string;
    expiresAtMs: number;
}

function actionIdempotencyKey(requested?: string): string {
    const key = requested ?? globalThis.crypto?.randomUUID?.();
    if (!key || !/^[A-Za-z0-9._:/-]{8,128}$/.test(key)) {
        throw new Error("idempotencyKey must be 8-128 URL-safe characters");
    }
    return key;
}

export class SocialClient {
    private privateKey: Uint8Array;
    private publicKey: Uint8Array | null = null;
    private serverUrl: string;
    private accountId: string;
    private platformId?: string;
    private ownerWallet?: OwnerWalletSigner;

    private constructor(config: SocialClientConfig) {
        if (!normalizedAddress(config.accountId)) {
            throw new Error("accountId must be a valid MySo object ID");
        }
        this.privateKey =
            typeof config.key === "string" ? hexToBytes(config.key) : config.key;
        this.accountId = config.accountId;
        this.serverUrl = normalizeServerUrl(
            config.serverUrl ?? "https://memory.mysocial.network/",
        );
        this.platformId = config.platformId;
        this.ownerWallet = config.ownerWallet;
    }

    static create(config: SocialClientConfig): SocialClient {
        if (config.ownerCoSignKey) {
            throw new Error(
                "ownerCoSignKey is no longer accepted; owner operations require a wallet approval flow",
            );
        }
        return new SocialClient(config);
    }

    async createPost(
        params: CreatePostParams,
        options?: SocialActionOptions,
    ): Promise<SocialActionResult> {
        return this.executeRegistered("social.create_post.v1", params, options);
    }

    async createComment(
        params: CreateCommentParams,
        options?: SocialActionOptions,
    ): Promise<SocialActionResult> {
        return this.executeRegistered("social.create_comment.v1", params, options);
    }

    async reactToPost(
        params: ReactToPostParams,
        options?: SocialActionOptions,
    ): Promise<SocialActionResult> {
        return this.executeRegistered("social.react_to_post.v1", params, options);
    }

    async reactToComment(
        params: ReactToCommentParams,
        options?: SocialActionOptions,
    ): Promise<SocialActionResult> {
        return this.executeRegistered("social.react_to_comment.v1", params, options);
    }

    async createRepost(
        params: CreateRepostParams,
        options?: SocialActionOptions,
    ): Promise<SocialActionResult> {
        return this.executeRegistered("social.create_repost.v1", params, options);
    }

    async removePostReaction(params: RemovePostReactionParams, options?: SocialActionOptions) {
        return this.executeRegistered("social.remove_post_reaction.v1", params, options);
    }

    async removeCommentReaction(params: RemoveCommentReactionParams, options?: SocialActionOptions) {
        return this.executeRegistered("social.remove_comment_reaction.v1", params, options);
    }

    async editPost(params: EditPostParams, options?: SocialActionOptions) {
        return this.executeRegistered("social.edit_post.v1", params, options);
    }

    async editComment(params: EditCommentParams, options?: SocialActionOptions) {
        return this.executeRegistered("social.edit_comment.v1", params, options);
    }

    async removeRepost(params: RemoveRepostParams, options?: SocialActionOptions) {
        return this.executeRegistered("social.remove_repost.v1", params, options);
    }

    async followProfile(params: ProfileRelationParams, options?: SocialActionOptions) {
        return this.executeRegistered("social.follow_profile.v1", params, options);
    }

    async unfollowProfile(params: ProfileRelationParams, options?: SocialActionOptions) {
        return this.executeRegistered("social.unfollow_profile.v1", params, options);
    }

    async blockProfile(params: ProfileRelationParams, options?: SocialActionOptions) {
        return this.executeRegistered("social.block_profile.v1", params, options);
    }

    async unblockProfile(params: ProfileRelationParams, options?: SocialActionOptions) {
        return this.executeRegistered("social.unblock_profile.v1", params, options);
    }

    async sendMessage(params: SendMessageParams, options?: SocialActionOptions) {
        return this.executeRegistered("messaging.send_message.v1", params, options);
    }

    async createMessagingGroup(params: CreateMessagingGroupParams, options?: SocialActionOptions) {
        return this.executeRegistered("messaging.create_group.v1", params, options);
    }

    async createOrganization(params: CreateOrganizationParams, options?: SocialActionOptions) {
        return this.executeRegistered("organization.create.v1", params, options);
    }

    async updateOrganizationMetadata(params: UpdateOrganizationMetadataParams, options?: SocialActionOptions) {
        return this.executeRegistered("organization.update_metadata.v1", params, options);
    }

    async updateOrganizationCategory(params: UpdateOrganizationCategoryParams, options?: SocialActionOptions) {
        return this.executeRegistered("organization.update_category.v1", params, options);
    }

    async deactivateOrganization(params: OrganizationObjectParams, options?: SocialActionOptions) {
        return this.executeRegistered("organization.deactivate.v1", params, options);
    }

    async ensureOrganizationMemoryGroup(params: OrganizationObjectParams, options?: SocialActionOptions) {
        return this.executeRegistered("organization.ensure_memory_group.v1", params, options);
    }

    async defineOrganizationRole(params: DefineOrganizationRoleParams, options?: SocialActionOptions) {
        return this.executeRegistered("organization.define_role.v1", params, options);
    }

    async assignOrganizationRole(params: OrganizationRoleParams, options?: SocialActionOptions) {
        return this.executeRegistered("organization.assign_role.v1", params, options);
    }

    async revokeOrganizationRole(params: OrganizationRoleParams, options?: SocialActionOptions) {
        return this.executeRegistered("organization.revoke_role.v1", params, options);
    }

    async createOrganizationInvitation(params: CreateOrganizationInvitationParams, options?: SocialActionOptions) {
        return this.executeRegistered("organization.create_invitation.v1", params, options);
    }

    async acceptOrganizationInvitation(params: OrganizationInvitationDecisionParams, options?: SocialActionOptions) {
        return this.executeRegistered("organization.accept_invitation.v1", params, options);
    }

    async declineOrganizationInvitation(params: OrganizationInvitationDecisionParams, options?: SocialActionOptions) {
        return this.executeRegistered("organization.decline_invitation.v1", params, options);
    }

    async registerRootAgent(params: RegisterRootAgentParams, options?: SocialActionOptions) {
        return this.executeRegistered("agent.register_agent.v1", params, options);
    }

    async registerChildAgent(params: RegisterChildAgentParams, options?: SocialActionOptions) {
        return this.executeRegistered("agent.register_child.v1", params, options);
    }

    async updateChildAgent(params: UpdateManagedAgentParams, options?: SocialActionOptions) {
        return this.executeRegistered("agent.update_child.v1", params, options);
    }

    async deactivateChildAgent(params: ManagedAgentParams, options?: SocialActionOptions) {
        return this.executeRegistered("agent.deactivate_child.v1", params, options);
    }

    async revokeChildAgent(params: ManagedAgentParams, options?: SocialActionOptions) {
        return this.executeRegistered("agent.revoke_child.v1", params, options);
    }

    async deletePost(
        postId: string,
        options?: SocialActionOptions,
    ): Promise<SocialActionResult> {
        return this.executeOwnerApproved("social.delete_post.v1", { postId }, options);
    }

    async deleteComment(
        params: DeleteCommentParams,
        options?: SocialActionOptions,
    ): Promise<SocialActionResult> {
        return this.executeOwnerApproved("social.delete_comment.v1", params, options);
    }

    private async executeRegistered(
        actionId: SocialActionId,
        parameters: unknown,
        options?: SocialActionOptions,
    ): Promise<SocialActionResult> {
        const deployment = await this.fetchDeploymentConfig();
        this.platformId ??= deployment.socialChain.platformObjectId;
        const context = await this.signedRequest<AgentContext>(
            "GET",
            "/api/agent/context",
            {},
        );
        const contextAccount = normalizedAddress(context.memoryAccountId);
        const configuredAccount = normalizedAddress(this.accountId);
        if (!contextAccount || !configuredAccount || contextAccount !== configuredAccount) {
            throw new Error("Authenticated agent context does not match accountId");
        }
        assertAuthenticatedDeployment(deployment, context);

        const descriptor = getSocialActionDescriptor(actionId);
        const capability = BigInt(descriptor.requiredCapability);
        if ((BigInt(context.capabilities) & capability) !== capability) {
            throw new Error(`Agent lacks capability required by ${actionId}`);
        }
        if (
            (descriptor.riskTier !== "1A" && descriptor.riskTier !== "1B") ||
            (BigInt(context.approvalRequiredCapabilities) & capability) === capability
        ) {
            return this.executeOwnerApproved(actionId, parameters, options, context);
        }
        if (
            context.permittedRegistryActions &&
            !context.permittedRegistryActions.includes(actionId)
        ) {
            throw new Error(`${actionId} is not present in the authenticated action catalog`);
        }
        if (
            context.platformScope &&
            normalizedAddress(context.platformScope) !==
                normalizedAddress(deployment.socialChain.platformObjectId)
        ) {
            throw new Error("Social action is outside the agent platform scope");
        }

        const { Ed25519Keypair } = await import("@socialproof/myso/keypairs/ed25519");
        const signer = Ed25519Keypair.fromSecretKey(this.privateKey);
        const sender = signer.toMySoAddress();
        if (normalizedAddress(sender) !== normalizedAddress(context.derivedAddress)) {
            throw new Error("Local signer does not match authenticated sub-agent address");
        }
        const idempotencyKey = actionIdempotencyKey(options?.idempotencyKey);
        const prepared = await this.signedRequest<PreparedActionResponse>(
            "POST",
            "/api/chain/actions/prepare",
            {
                registryAction: actionId,
                registryVersion: SOCIAL_ACTION_REGISTRY_VERSION,
                idempotencyKey,
                parameters,
            },
        );
        if (
            prepared.registryAction !== actionId ||
            prepared.registryVersion !== SOCIAL_ACTION_REGISTRY_VERSION ||
            prepared.idempotencyKey !== idempotencyKey ||
            typeof prepared.bytes !== "string" ||
            typeof prepared.digest !== "string" ||
            !Number.isSafeInteger(prepared.expiresAtMs) ||
            prepared.expiresAtMs <= Date.now()
        ) {
            throw new Error("Registered action gateway returned invalid preparation metadata");
        }
        const signed = await signer.signTransaction(base64ToBytes(prepared.bytes));
        const executed = await this.signedRequest<{ digest?: unknown }>(
            "POST",
            "/api/chain/actions/submit",
            {
                registryAction: actionId,
                registryVersion: SOCIAL_ACTION_REGISTRY_VERSION,
                idempotencyKey,
                digest: prepared.digest,
                signature: signed.signature,
            },
        );
        if (executed.digest !== prepared.digest) {
            throw new Error("Sponsored execution returned an unexpected digest");
        }
        return { digest: prepared.digest };
    }

    private async executeOwnerApproved(
        actionId: SocialActionId,
        parameters: unknown,
        options?: SocialActionOptions,
        knownContext?: AgentContext,
    ): Promise<SocialActionResult> {
        const wallet = this.ownerWallet;
        if (!wallet) {
            throw new Error(`${actionId} requires the wallet approval flow and an ownerWallet adapter`);
        }
        const deployment = await this.fetchDeploymentConfig();
        this.platformId ??= deployment.socialChain.platformObjectId;
        const context = knownContext ?? await this.signedRequest<AgentContext>(
            "GET",
            "/api/agent/context",
            {},
        );
        assertAuthenticatedDeployment(deployment, context);
        const walletAddress = await wallet.getAddress();
        if (normalizedAddress(walletAddress) !== normalizedAddress(context.owner)) {
            throw new Error("Configured owner wallet does not own the authenticated MemoryAccount");
        }
        const descriptor = getSocialActionDescriptor(actionId);
        const capability = BigInt(descriptor.requiredCapability);
        if ((BigInt(context.capabilities) & capability) !== capability) {
            throw new Error(`Agent lacks capability required by ${actionId}`);
        }
        if (context.permittedRegistryActions && !context.permittedRegistryActions.includes(actionId)) {
            throw new Error(`${actionId} is not present in the authenticated action catalog`);
        }
        if (
            context.platformScope &&
            normalizedAddress(context.platformScope) !== normalizedAddress(deployment.socialChain.platformObjectId)
        ) {
            throw new Error("Approved social action is outside the agent platform scope");
        }
        const validation = descriptor.validate(parameters as never);
        if (!validation.success) {
            throw new Error(`Invalid ${actionId} parameters`);
        }
        const idempotencyKey = actionIdempotencyKey(options?.idempotencyKey);
        const approval = await this.signedRequest<ActionApprovalResponse>(
            "POST",
            "/api/chain/approvals/request",
            {
                registryAction: actionId,
                registryVersion: SOCIAL_ACTION_REGISTRY_VERSION,
                idempotencyKey,
                parameters,
                expiresInSeconds: 600,
            },
        );
        if (
            approval.registryAction !== actionId ||
            approval.registryVersion !== SOCIAL_ACTION_REGISTRY_VERSION ||
            approval.idempotencyKey !== idempotencyKey ||
            !approval.approvalIntent.startsWith("mysocial-action-approval-v1|") ||
            approval.expiresAtMs <= Date.now()
        ) {
            throw new Error("Action approval gateway returned invalid binding metadata");
        }
        if (approval.status === "pending") {
            const walletApproval = await wallet.signPersonalMessage({
                message: new TextEncoder().encode(approval.approvalIntent),
            });
            const response = await fetch(
                `${this.serverUrl}/api/chain/approvals/${encodeURIComponent(approval.approvalId)}/approve`,
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ walletSignature: walletApproval.signature }),
                },
            );
            if (!response.ok) {
                throw new Error(`Owner action approval failed (${response.status})`);
            }
        }
        const prepared = await this.signedRequest<PreparedActionResponse>(
            "POST",
            "/api/chain/actions/prepare",
            {
                registryAction: actionId,
                registryVersion: SOCIAL_ACTION_REGISTRY_VERSION,
                idempotencyKey,
                parameters,
                approvalId: approval.approvalId,
            },
        );
        if (prepared.digest.length < 43 || prepared.expiresAtMs <= Date.now()) {
            throw new Error("Approved action preparation is invalid or expired");
        }
        const walletTransaction = await wallet.signTransaction({
            transaction: base64ToBytes(prepared.bytes),
        });
        const executed = await this.signedRequest<{ digest?: unknown }>(
            "POST",
            "/api/chain/actions/submit",
            {
                registryAction: actionId,
                registryVersion: SOCIAL_ACTION_REGISTRY_VERSION,
                idempotencyKey,
                approvalId: approval.approvalId,
                digest: prepared.digest,
                signature: walletTransaction.signature,
            },
        );
        if (executed.digest !== prepared.digest) {
            throw new Error("Approved sponsored execution returned an unexpected digest");
        }
        return { digest: prepared.digest, deleted: descriptor.riskTier === "3" };
    }

    private async fetchDeploymentConfig(): Promise<DeploymentConfig> {
        const response = await fetch(`${this.serverUrl}/config`);
        if (!response.ok) {
            throw new Error(`Deployment config failed (${response.status})`);
        }
        const config = (await response.json()) as Partial<DeploymentConfig>;
        if (
            !config.socialChain ||
            typeof config.mysoRpcUrl !== "string" ||
            !["mainnet", "testnet", "devnet", "localnet"].includes(
                String(config.network),
            )
        ) {
            throw new Error("Deployment config does not expose a valid social chain");
        }
        return config as DeploymentConfig;
    }

    private async getPublicKey(): Promise<Uint8Array> {
        if (!this.publicKey) {
            const ed = await getEd();
            this.publicKey = await ed.getPublicKeyAsync(this.privateKey);
        }
        return this.publicKey;
    }

    private async signedRequest<T>(
        method: string,
        path: string,
        body: object,
    ): Promise<T> {
        const ed = await getEd();
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const bodyStr =
            method === "GET" ? "" : JSON.stringify(body);
        const bodySha256 = await sha256hex(bodyStr);
        const nonce = crypto.randomUUID();
        const message = `${timestamp}.${method}.${path}.${bodySha256}.${nonce}.${this.accountId}`;
        const msgBytes = new TextEncoder().encode(message);
        const signature = await ed.signAsync(msgBytes, this.privateKey);
        const publicKey = await this.getPublicKey();

        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "x-public-key": bytesToHex(publicKey),
            "x-signature": bytesToHex(signature),
            "x-timestamp": timestamp,
            "x-nonce": nonce,
            "x-account-id": this.accountId,
            "x-sdk-compatibility": MEMORY_TYPESCRIPT_COMPATIBILITY_VERSION,
        };
        if (this.platformId) {
            headers["x-platform-id"] = this.platformId;
        }

        const url = `${this.serverUrl}${path}`;
        const res = await fetch(url, {
            method,
            headers,
            body: method === "GET" || bodyStr === "" ? undefined : bodyStr,
        });

        if (!res.ok) {
            const raw = await res.text();
            throw new Error(`Social API ${method} ${path} failed (${res.status}): ${raw}`);
        }
        return res.json() as Promise<T>;
    }
}
