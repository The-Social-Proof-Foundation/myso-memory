export interface SocialChainConfig {
    packageId: string;
    usernameRegistryId: string;
    platformRegistryId: string;
    platformObjectId: string;
    blockListRegistryId: string;
    postConfigId: string;
    memoryConfigId: string;
    mydataRegistryId: string;
    socialGraphId?: string;
    /** Shared `agent_task::TaskConfig`; required by the `task.*` actions. */
    taskConfigId?: string;
    messagingPackageId?: string;
    messagingVersionId?: string;
    messagingConfigId?: string;
    messagingNamespaceId?: string;
    messagingGroupManagerId?: string;
    messagingGroupLeaverId?: string;
    clockId?: string;
}

export interface SocialClientConfig {
    key: string | Uint8Array;
    accountId: string;
    serverUrl?: string;
    platformId?: string;
    /** @deprecated Raw owner keys are rejected; use the wallet approval flow. */
    ownerCoSignKey?: string | Uint8Array;
    /** Wallet-standard adapter used only for explicit owner approval and owner-sent transactions. */
    ownerWallet?: OwnerWalletSigner;
}

export interface OwnerWalletSigner {
    getAddress(): string | Promise<string>;
    signPersonalMessage(input: { message: Uint8Array }):
        | { signature: string }
        | Promise<{ signature: string }>;
    signTransaction(input: { transaction: Uint8Array }):
        | { signature: string }
        | Promise<{ signature: string }>;
}

export interface SocialActionOptions {
    /** Stable across retries; generated automatically when omitted. */
    idempotencyKey?: string;
}

export interface CreatePostParams {
    content: string;
    platformObjectId?: string;
    mediaUrls?: string[];
    mentions?: string[];
    metadataJson?: string;
    allowComments?: boolean;
    allowReactions?: boolean;
    allowReposts?: boolean;
    allowQuotes?: boolean;
    allowTips?: boolean;
    enableSpt?: boolean;
    /** @deprecated `post::create_post` no longer accepts PoC enablement. */
    enablePoc?: boolean;
    enableSpot?: boolean;
    /** Defaults to public only when no access-specific fields are supplied. */
    accessKind?: PostAccessKind;
    subscriptionServiceId?: string;
    linkedMydataId?: string;
    subscriptionMinTierLevel?: number;
    /** @deprecated Use `linkedMydataId` with an explicit non-public `accessKind`. */
    mydataId?: string;
}

export type PostAccessKind = 1 | 2 | 3;

export interface CreateCommentParams {
    postId: string;
    content: string;
    parentCommentId?: string;
    mediaUrls?: string[];
    mentions?: string[];
    metadataJson?: string;
}

export interface ReactToPostParams {
    postId: string;
    reaction: string;
    platformObjectId?: string;
}

export interface ReactToCommentParams {
    commentId: string;
    reaction: string;
    platformObjectId?: string;
}

export interface RemovePostReactionParams { postId: string; platformObjectId?: string }
export interface RemoveCommentReactionParams { commentId: string; platformObjectId?: string }
export interface EditPostParams {
    postId: string;
    content: string;
    mediaUrls?: string[];
    mentions?: string[];
    metadataJson?: string;
    platformObjectId?: string;
}
export interface EditCommentParams {
    commentId: string;
    content: string;
    mentions?: string[];
    platformObjectId?: string;
}
export interface RemoveRepostParams {
    originalPostId: string;
    repostId: string;
    platformObjectId?: string;
}
export interface ProfileRelationParams {
    targetOwner: string;
    platformObjectId?: string;
}
export interface SendMessageParams {
    groupId: string;
    messageLogId: string;
    recipient: string;
    /** SHA-256 digest of the encrypted message, encoded as 64 lowercase hex characters. */
    contentDigestHex: string;
    /** Durable URI for the encrypted payload. Plaintext is never accepted. */
    contentUri: string;
    dedupeKey: string;
    /** Unsigned u128 decimal string. */
    nonce: string;
    platformObjectId?: string;
}

export interface CreateMessagingGroupParams {
    name: string;
    uuid: string;
    /** Encrypted data-encryption key bytes encoded as lowercase hex. */
    encryptedDekHex: string;
    /** Derived agent or human wallet addresses to add to the conversation. */
    initialMembers: string[];
    /** MemoryAccount for a cross-principal agent peer; defaults to the creator account. */
    crossPrincipalPeerAccountId?: string;
    platformObjectId?: string;
    /** Tags the group as an agent room; only `1` (agent room) exists on-chain. */
    roomKind?: number;
    /** Opaque task object id the room is bound to. Requires `roomKind`. */
    roomTaskId?: string;
}

export interface CreateOrganizationParams {
    orgType: number;
    name?: string;
    description?: string;
}

export interface UpdateOrganizationMetadataParams {
    organizationId: string;
    name?: string;
    description?: string;
}

export interface UpdateOrganizationCategoryParams {
    organizationId: string;
    orgType: number;
}

export interface OrganizationObjectParams {
    organizationId: string;
}

export interface OrganizationRoleParams {
    organizationId: string;
    orgMemoryGroupId: string;
    memberAddress: string;
    roleName: string;
}

export interface DefineOrganizationRoleParams {
    organizationId: string;
    orgMemoryGroupId: string;
    roleName: string;
    permissionsMask: string;
}

export interface CreateOrganizationInvitationParams {
    organizationId: string;
    orgMemoryGroupId: string;
    invitee: string;
    roleName?: string;
    permissionsMask: string;
    expiresAtMs?: string;
}

export interface OrganizationInvitationDecisionParams {
    /** MemoryAccount that owns the organization. */
    organizationAccountId: string;
    organizationId: string;
    orgMemoryGroupId?: string;
    invitee: string;
}

export interface AgentPolicyParams {
    publicKeyHex: string;
    derivedAddress: string;
    label: string;
    identityClass?: number;
    roleTags?: string;
    capabilities?: string;
    delegatableCaps?: string;
    registerScope?: number;
    approvalRequiredCaps?: string;
    maxActionSpendMist?: string;
    platformScope?: string;
    expiresAtMs?: string;
}

export interface RegisterRootAgentParams extends AgentPolicyParams {
    organizationId: string;
}

export interface RegisterChildAgentParams extends AgentPolicyParams {
    parentAgentObjectId: string;
    registerRelation: number;
}

export interface UpdateManagedAgentParams {
    agentObjectId: string;
    identityClass: number;
    roleTags: string;
    capabilities: string;
    delegatableCaps: string;
    registerScope: number;
    approvalRequiredCaps: string;
    maxActionSpendMist?: string;
    platformScope?: string;
    expiresAtMs?: string;
}

export interface ManagedAgentParams {
    agentObjectId: string;
}

export interface CreateRepostParams {
    originalPostId: string;
    content?: string;
    platformObjectId?: string;
    mediaUrls?: string[];
    mentions?: string[];
    metadataJson?: string;
    allowComments?: boolean;
    allowReactions?: boolean;
    allowReposts?: boolean;
    allowQuotes?: boolean;
    allowTips?: boolean;
    enableSpt?: boolean;
    /** @deprecated `post::create_repost` no longer accepts PoC enablement. */
    enablePoc?: boolean;
    enableSpot?: boolean;
}

export interface DeleteCommentParams {
    postId: string;
    commentId: string;
}

export interface DeletePostParams {
    postId: string;
}

/** Fields shared by task actions. The acting account is always `BuildTxContext.memoryAccountId`. */
export interface TaskCreateParams {
    sellerAccountId: string;
    sellerAgentId: string;
    /** u64 decimal string, in MIST. */
    amountMist: string;
    /** sha256 of the scope document as 64 lowercase hex characters. */
    scopeDigestHex: string;
    title: string;
    acceptWindowMs: string;
    deliveryWindowMs: string;
    settleWindowMs: string;
    /** MYSO coin object that funds the escrow; its balance must cover `amountMist`. */
    paymentCoinId: string;
    roomGroupId?: string;
    platformId?: string;
}

export interface TaskAcceptParams {
    taskId: string;
    sellerAgentId: string;
    /** The terms digest the seller verified, 64 lowercase hex characters. */
    termsDigestHex: string;
}

export interface TaskSellerParams {
    taskId: string;
    sellerAgentId: string;
}

export interface TaskCancelOfferParams {
    taskId: string;
}

export interface TaskPermissionlessParams {
    taskId: string;
}

export interface TaskDeliverParams {
    taskId: string;
    sellerAgentId: string;
    /** Deliverable digest as 64 lowercase hex characters. */
    digestHex: string;
    uri: string;
}

export interface TaskSettleParams {
    taskId: string;
    sellerAccountId: string;
    platformObjectId?: string;
}

export interface TaskReleaseParams {
    taskId: string;
    buyerAccountId: string;
    sellerAccountId: string;
    platformObjectId?: string;
}

export interface TaskRefundProposalParams {
    taskId: string;
    buyerAccountId: string;
    sellerAgentId: string;
}

export interface TaskReviewParams {
    taskId: string;
    /** Which side is rating: `buyer` rates the seller agent, `seller` rates the buyer. */
    raterRole: "buyer" | "seller";
    stars: number;
    buyerAccountId: string;
    sellerAgentId: string;
    /** Required when the buyer rates (the seller account holds the seller aggregates). */
    sellerAccountId?: string;
    /** Required when the seller rates a buyer that bought through an agent. */
    buyerAgentId?: string;
}

export interface SocialActionResult {
    digest: string;
    postId?: string;
    commentId?: string;
    repostId?: string;
    deleted?: boolean;
    messageGroupId?: string;
    messageSeq?: number;
}

export type SocialExecuteAction =
    | "create_post"
    | "edit_post"
    | "create_comment"
    | "edit_comment"
    | "react_to_post"
    | "remove_post_reaction"
    | "react_to_comment"
    | "remove_comment_reaction"
    | "create_repost"
    | "remove_repost"
    | "follow_profile"
    | "unfollow_profile"
    | "block_profile"
    | "unblock_profile"
    | "send_message"
    | "create_messaging_group"
    | "create_organization"
    | "update_organization_metadata"
    | "update_organization_category"
    | "deactivate_organization"
    | "ensure_organization_memory_group"
    | "define_organization_role"
    | "assign_organization_role"
    | "revoke_organization_role"
    | "create_organization_invitation"
    | "accept_organization_invitation"
    | "decline_organization_invitation"
    | "register_root_agent"
    | "register_child_agent"
    | "update_managed_agent"
    | "deactivate_managed_agent"
    | "revoke_managed_agent"
    | "delete_post"
    | "delete_comment"
    | "task_create"
    | "task_accept"
    | "task_decline"
    | "task_cancel_offer"
    | "task_deliver"
    | "task_settle"
    | "task_refund"
    | "task_release"
    | "task_expire_offer"
    | "task_propose_refund"
    | "task_accept_refund"
    | "task_reject_refund"
    | "task_withdraw_refund"
    | "task_review";
