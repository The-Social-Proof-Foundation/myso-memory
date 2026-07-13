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
    | "delete_comment";
