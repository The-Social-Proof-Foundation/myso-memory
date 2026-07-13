import {
    CAP_AGENT_REGISTER,
    CAP_AGENT_REVOKE,
    CAP_AGENT_UPDATE,
    CAP_COMMENT,
    CAP_MEMORY_READ,
    CAP_MESSAGE_SEND,
    CAP_POST_PUBLISH,
    CAP_REACT,
    CAP_SOCIAL_GRAPH,
} from "../contract.js";
import {
    buildCreateCommentTx,
    buildCreatePostTx,
    buildCreateRepostTx,
    buildDeleteCommentTx,
    buildDeletePostTx,
    buildReactToCommentTx,
    buildReactToPostTx,
    resolveCreatePostAccess,
} from "../ptb/post.js";
import {
    buildBlockProfileTx,
    buildEditCommentTx,
    buildEditPostTx,
    buildFollowProfileTx,
    buildRemoveCommentReactionTx,
    buildRemovePostReactionTx,
    buildRemoveRepostTx,
    buildSendMessageTx,
    buildUnblockProfileTx,
    buildUnfollowProfileTx,
    validateSendMessageParams,
} from "../ptb/tier1.js";
import {
    buildAcceptOrganizationInvitationTx,
    buildAssignOrganizationRoleTx,
    buildCreateMessagingGroupTx,
    buildCreateOrganizationInvitationTx,
    buildCreateOrganizationTx,
    buildDeactivateManagedAgentTx,
    buildDeactivateOrganizationTx,
    buildDeclineOrganizationInvitationTx,
    buildDefineOrganizationRoleTx,
    buildEnsureOrganizationMemoryGroupTx,
    buildRegisterChildAgentTx,
    buildRegisterRootAgentTx,
    buildRevokeManagedAgentTx,
    buildRevokeOrganizationRoleTx,
    buildUpdateManagedAgentTx,
    buildUpdateOrganizationCategoryTx,
    buildUpdateOrganizationMetadataTx,
    validateAgentPolicy,
} from "../ptb/organization.js";
import type { BuildTxContext } from "../ptb/post.js";
import { hashActionParameters, isSha256Digest } from "./canonical.js";
import {
    SOCIAL_ACTION_IDS,
    SOCIAL_ACTION_REGISTRY_VERSION,
} from "./types.js";
import type {
    AnySocialActionDescriptor,
    FinalizeSocialActionPreparationOptions,
    PreparedSocialActionMetadata,
    SocialActionDescriptor,
    SocialActionId,
    SocialActionInput,
    SocialActionInputSchema,
    SocialActionRegistry,
    SocialActionRequestMetadata,
    SocialActionValidationIssue,
} from "./types.js";
import { createSocialActionValidator } from "./validation.js";

const NON_EMPTY_STRING = Object.freeze({ type: "string", minLength: 1 } as const);
const OPTIONAL_STRING = Object.freeze({ type: "string" } as const);
const OPTIONAL_BOOLEAN = Object.freeze({ type: "boolean" } as const);
const ACCESS_KIND = Object.freeze({
    type: "integer",
    enum: Object.freeze([1, 2, 3]),
} as const);
const NON_NEGATIVE_INTEGER = Object.freeze({
    type: "integer",
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
} as const);
const STRING_ARRAY = Object.freeze({
    type: "array",
    items: NON_EMPTY_STRING,
} as const);
const MAX_32_STRINGS = Object.freeze({
    type: "array",
    items: NON_EMPTY_STRING,
    maxItems: 32,
} as const);
const ORG_TYPE = Object.freeze({
    type: "integer",
    enum: Object.freeze(Array.from({ length: 14 }, (_, index) => index)),
} as const);
const U8 = Object.freeze({ type: "integer", minimum: 0, maximum: 255 } as const);

const AGENT_POLICY_PROPERTIES = Object.freeze({
    publicKeyHex: NON_EMPTY_STRING,
    derivedAddress: NON_EMPTY_STRING,
    label: NON_EMPTY_STRING,
    identityClass: U8,
    roleTags: NON_EMPTY_STRING,
    capabilities: NON_EMPTY_STRING,
    delegatableCaps: NON_EMPTY_STRING,
    registerScope: U8,
    approvalRequiredCaps: NON_EMPTY_STRING,
    maxActionSpendMist: NON_EMPTY_STRING,
    platformScope: NON_EMPTY_STRING,
    expiresAtMs: NON_EMPTY_STRING,
} as const);

const POST_OPTION_PROPERTIES = Object.freeze({
    platformObjectId: NON_EMPTY_STRING,
    mediaUrls: STRING_ARRAY,
    mentions: STRING_ARRAY,
    metadataJson: OPTIONAL_STRING,
    allowComments: OPTIONAL_BOOLEAN,
    allowReactions: OPTIONAL_BOOLEAN,
    allowReposts: OPTIONAL_BOOLEAN,
    allowQuotes: OPTIONAL_BOOLEAN,
    allowTips: OPTIONAL_BOOLEAN,
    enableSpt: OPTIONAL_BOOLEAN,
    enableSpot: OPTIONAL_BOOLEAN,
} as const);

function objectSchema(
    required: readonly string[],
    properties: SocialActionInputSchema["properties"],
): SocialActionInputSchema {
    return Object.freeze({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: Object.freeze([...required]),
        properties: Object.freeze({ ...properties }),
    });
}

const IDEMPOTENCY_POLICY = Object.freeze({
    required: true,
    scope: "account-agent-action",
    parameterHashAlgorithm: "sha256-canonical-json-v1",
    replayBehavior: "return-existing-result",
} as const);

function defineAction<TId extends SocialActionId>(
    descriptor: Omit<SocialActionDescriptor<TId>, "validate">,
    refine?: (input: SocialActionInput<TId>) => void,
): SocialActionDescriptor<TId> {
    const validateSchema = createSocialActionValidator<SocialActionInput<TId>>(
        descriptor.inputSchema,
    );
    return Object.freeze({
        ...descriptor,
        validate: (input: unknown) => {
            const result = validateSchema(input);
            if (!result.success || !refine) return result;
            try {
                refine(result.value);
                return result;
            } catch (error) {
                return {
                    success: false as const,
                    issues: [
                        {
                            code: "invalid_value" as const,
                            path: "$",
                            message:
                                error instanceof Error
                                    ? error.message
                                    : "Invalid action parameter combination",
                        },
                    ],
                };
            }
        },
    });
}

const createPost = defineAction(
    {
        id: "social.create_post.v1",
        version: 1,
        legacyAction: "create_post",
        requiredCapability: CAP_POST_PUBLISH,
        riskTier: "1B",
        inputSchema: objectSchema(["content"], {
            content: NON_EMPTY_STRING,
            ...POST_OPTION_PROPERTIES,
            accessKind: ACCESS_KIND,
            subscriptionServiceId: NON_EMPTY_STRING,
            linkedMydataId: NON_EMPTY_STRING,
            subscriptionMinTierLevel: NON_NEGATIVE_INTEGER,
        }),
        idempotency: IDEMPOTENCY_POLICY,
        buildTransaction: buildCreatePostTx,
    },
    resolveCreatePostAccess,
);

const createComment = defineAction({
    id: "social.create_comment.v1",
    version: 1,
    legacyAction: "create_comment",
    requiredCapability: CAP_COMMENT,
    riskTier: "1B",
    inputSchema: objectSchema(["postId", "content"], {
        postId: NON_EMPTY_STRING,
        content: NON_EMPTY_STRING,
        parentCommentId: NON_EMPTY_STRING,
        mediaUrls: STRING_ARRAY,
        mentions: STRING_ARRAY,
        metadataJson: OPTIONAL_STRING,
    }),
    idempotency: IDEMPOTENCY_POLICY,
    buildTransaction: buildCreateCommentTx,
});

const reactToPost = defineAction({
    id: "social.react_to_post.v1",
    version: 1,
    legacyAction: "react_to_post",
    requiredCapability: CAP_REACT,
    riskTier: "1A",
    inputSchema: objectSchema(["postId", "reaction"], {
        postId: NON_EMPTY_STRING,
        reaction: NON_EMPTY_STRING,
        platformObjectId: NON_EMPTY_STRING,
    }),
    idempotency: IDEMPOTENCY_POLICY,
    buildTransaction: buildReactToPostTx,
});

const reactToComment = defineAction({
    id: "social.react_to_comment.v1",
    version: 1,
    legacyAction: "react_to_comment",
    requiredCapability: CAP_REACT,
    riskTier: "1A",
    inputSchema: objectSchema(["commentId", "reaction"], {
        commentId: NON_EMPTY_STRING,
        reaction: NON_EMPTY_STRING,
        platformObjectId: NON_EMPTY_STRING,
    }),
    idempotency: IDEMPOTENCY_POLICY,
    buildTransaction: buildReactToCommentTx,
});

const createRepost = defineAction({
    id: "social.create_repost.v1",
    version: 1,
    legacyAction: "create_repost",
    requiredCapability: CAP_POST_PUBLISH,
    riskTier: "1B",
    inputSchema: objectSchema(["originalPostId"], {
        originalPostId: NON_EMPTY_STRING,
        content: OPTIONAL_STRING,
        ...POST_OPTION_PROPERTIES,
    }),
    idempotency: IDEMPOTENCY_POLICY,
    buildTransaction: buildCreateRepostTx,
});

const removePostReaction = defineAction({
    id: "social.remove_post_reaction.v1",
    version: 1,
    legacyAction: "remove_post_reaction",
    requiredCapability: CAP_REACT,
    riskTier: "1A",
    inputSchema: objectSchema(["postId"], {
        postId: NON_EMPTY_STRING,
        platformObjectId: NON_EMPTY_STRING,
    }),
    idempotency: IDEMPOTENCY_POLICY,
    buildTransaction: buildRemovePostReactionTx,
});

const removeCommentReaction = defineAction({
    id: "social.remove_comment_reaction.v1",
    version: 1,
    legacyAction: "remove_comment_reaction",
    requiredCapability: CAP_REACT,
    riskTier: "1A",
    inputSchema: objectSchema(["commentId"], {
        commentId: NON_EMPTY_STRING,
        platformObjectId: NON_EMPTY_STRING,
    }),
    idempotency: IDEMPOTENCY_POLICY,
    buildTransaction: buildRemoveCommentReactionTx,
});

const editPost = defineAction({
    id: "social.edit_post.v1",
    version: 1,
    legacyAction: "edit_post",
    requiredCapability: CAP_POST_PUBLISH,
    riskTier: "1B",
    inputSchema: objectSchema(["postId", "content"], {
        postId: NON_EMPTY_STRING,
        content: NON_EMPTY_STRING,
        mediaUrls: STRING_ARRAY,
        mentions: STRING_ARRAY,
        metadataJson: OPTIONAL_STRING,
        platformObjectId: NON_EMPTY_STRING,
    }),
    idempotency: IDEMPOTENCY_POLICY,
    buildTransaction: buildEditPostTx,
});

const editComment = defineAction({
    id: "social.edit_comment.v1",
    version: 1,
    legacyAction: "edit_comment",
    requiredCapability: CAP_COMMENT,
    riskTier: "1B",
    inputSchema: objectSchema(["commentId", "content"], {
        commentId: NON_EMPTY_STRING,
        content: NON_EMPTY_STRING,
        mentions: STRING_ARRAY,
        platformObjectId: NON_EMPTY_STRING,
    }),
    idempotency: IDEMPOTENCY_POLICY,
    buildTransaction: buildEditCommentTx,
});

const removeRepost = defineAction({
    id: "social.remove_repost.v1",
    version: 1,
    legacyAction: "remove_repost",
    requiredCapability: CAP_POST_PUBLISH,
    riskTier: "1B",
    inputSchema: objectSchema(["originalPostId", "repostId"], {
        originalPostId: NON_EMPTY_STRING,
        repostId: NON_EMPTY_STRING,
        platformObjectId: NON_EMPTY_STRING,
    }),
    idempotency: IDEMPOTENCY_POLICY,
    buildTransaction: buildRemoveRepostTx,
});

type ProfileRelationActionId =
    | "social.follow_profile.v1"
    | "social.unfollow_profile.v1"
    | "social.block_profile.v1"
    | "social.unblock_profile.v1";

function profileRelationAction<TId extends ProfileRelationActionId>(
    id: TId,
    legacyAction: "follow_profile" | "unfollow_profile" | "block_profile" | "unblock_profile",
    buildTransaction: typeof buildFollowProfileTx,
) : SocialActionDescriptor<TId> {
    return defineAction<TId>({
        id,
        version: 1,
        legacyAction,
        requiredCapability: CAP_SOCIAL_GRAPH,
        riskTier: "1A",
        inputSchema: objectSchema(["targetOwner"], {
            targetOwner: NON_EMPTY_STRING,
            platformObjectId: NON_EMPTY_STRING,
        }),
        idempotency: IDEMPOTENCY_POLICY,
        buildTransaction: buildTransaction as SocialActionDescriptor<TId>["buildTransaction"],
    });
}

const followProfile = profileRelationAction("social.follow_profile.v1", "follow_profile", buildFollowProfileTx);
const unfollowProfile = profileRelationAction("social.unfollow_profile.v1", "unfollow_profile", buildUnfollowProfileTx);
const blockProfile = profileRelationAction("social.block_profile.v1", "block_profile", buildBlockProfileTx);
const unblockProfile = profileRelationAction("social.unblock_profile.v1", "unblock_profile", buildUnblockProfileTx);

const sendMessage = defineAction(
    {
        id: "messaging.send_message.v1",
        version: 1,
        legacyAction: "send_message",
        requiredCapability: CAP_MESSAGE_SEND,
        riskTier: "1B",
        inputSchema: objectSchema(
            ["groupId", "messageLogId", "recipient", "contentDigestHex", "contentUri", "dedupeKey", "nonce"],
            {
                groupId: NON_EMPTY_STRING,
                messageLogId: NON_EMPTY_STRING,
                recipient: NON_EMPTY_STRING,
                contentDigestHex: NON_EMPTY_STRING,
                contentUri: NON_EMPTY_STRING,
                dedupeKey: NON_EMPTY_STRING,
                nonce: NON_EMPTY_STRING,
                platformObjectId: NON_EMPTY_STRING,
            },
        ),
        idempotency: IDEMPOTENCY_POLICY,
        buildTransaction: buildSendMessageTx,
    },
    validateSendMessageParams,
);

const createMessagingGroup = defineAction({
    id: "messaging.create_group.v1",
    version: 1,
    legacyAction: "create_messaging_group",
    requiredCapability: CAP_MESSAGE_SEND,
    riskTier: "1B",
    inputSchema: objectSchema(["name", "uuid", "encryptedDekHex", "initialMembers"], {
        name: NON_EMPTY_STRING,
        uuid: NON_EMPTY_STRING,
        encryptedDekHex: NON_EMPTY_STRING,
        initialMembers: MAX_32_STRINGS,
        crossPrincipalPeerAccountId: NON_EMPTY_STRING,
        platformObjectId: NON_EMPTY_STRING,
    }),
    idempotency: IDEMPOTENCY_POLICY,
    buildTransaction: buildCreateMessagingGroupTx,
});

const createOrganization = defineAction({
    id: "organization.create.v1",
    version: 1,
    legacyAction: "create_organization",
    requiredCapability: CAP_AGENT_REGISTER,
    riskTier: "3",
    inputSchema: objectSchema(["orgType"], {
        orgType: ORG_TYPE,
        name: OPTIONAL_STRING,
        description: OPTIONAL_STRING,
    }),
    idempotency: IDEMPOTENCY_POLICY,
    buildTransaction: buildCreateOrganizationTx,
});

const updateOrganizationMetadata = defineAction({
    id: "organization.update_metadata.v1",
    version: 1,
    legacyAction: "update_organization_metadata",
    requiredCapability: CAP_AGENT_UPDATE,
    riskTier: "3",
    inputSchema: objectSchema(["organizationId"], {
        organizationId: NON_EMPTY_STRING,
        name: OPTIONAL_STRING,
        description: OPTIONAL_STRING,
    }),
    idempotency: IDEMPOTENCY_POLICY,
    buildTransaction: buildUpdateOrganizationMetadataTx,
});

const updateOrganizationCategory = defineAction({
    id: "organization.update_category.v1",
    version: 1,
    legacyAction: "update_organization_category",
    requiredCapability: CAP_AGENT_UPDATE,
    riskTier: "3",
    inputSchema: objectSchema(["organizationId", "orgType"], {
        organizationId: NON_EMPTY_STRING,
        orgType: ORG_TYPE,
    }),
    idempotency: IDEMPOTENCY_POLICY,
    buildTransaction: buildUpdateOrganizationCategoryTx,
});

function organizationObjectAction<TId extends "organization.deactivate.v1" | "organization.ensure_memory_group.v1">(
    id: TId,
    legacyAction: "deactivate_organization" | "ensure_organization_memory_group",
    buildTransaction: typeof buildDeactivateOrganizationTx,
): SocialActionDescriptor<TId> {
    return defineAction<TId>({
        id,
        version: 1,
        legacyAction,
        requiredCapability: CAP_AGENT_UPDATE,
        riskTier: "3",
        inputSchema: objectSchema(["organizationId"], { organizationId: NON_EMPTY_STRING }),
        idempotency: IDEMPOTENCY_POLICY,
        buildTransaction: buildTransaction as SocialActionDescriptor<TId>["buildTransaction"],
    });
}

const deactivateOrganization = organizationObjectAction(
    "organization.deactivate.v1",
    "deactivate_organization",
    buildDeactivateOrganizationTx,
);
const ensureOrganizationMemoryGroup = organizationObjectAction(
    "organization.ensure_memory_group.v1",
    "ensure_organization_memory_group",
    buildEnsureOrganizationMemoryGroupTx,
);

const defineOrganizationRole = defineAction({
    id: "organization.define_role.v1",
    version: 1,
    legacyAction: "define_organization_role",
    requiredCapability: CAP_AGENT_UPDATE,
    riskTier: "3",
    inputSchema: objectSchema(["organizationId", "orgMemoryGroupId", "roleName", "permissionsMask"], {
        organizationId: NON_EMPTY_STRING,
        orgMemoryGroupId: NON_EMPTY_STRING,
        roleName: NON_EMPTY_STRING,
        permissionsMask: NON_EMPTY_STRING,
    }),
    idempotency: IDEMPOTENCY_POLICY,
    buildTransaction: buildDefineOrganizationRoleTx,
});

function organizationRoleAction<TId extends "organization.assign_role.v1" | "organization.revoke_role.v1">(
    id: TId,
    legacyAction: "assign_organization_role" | "revoke_organization_role",
    buildTransaction: typeof buildAssignOrganizationRoleTx,
): SocialActionDescriptor<TId> {
    return defineAction<TId>({
        id,
        version: 1,
        legacyAction,
        requiredCapability: CAP_AGENT_UPDATE,
        riskTier: "3",
        inputSchema: objectSchema(["organizationId", "orgMemoryGroupId", "memberAddress", "roleName"], {
            organizationId: NON_EMPTY_STRING,
            orgMemoryGroupId: NON_EMPTY_STRING,
            memberAddress: NON_EMPTY_STRING,
            roleName: NON_EMPTY_STRING,
        }),
        idempotency: IDEMPOTENCY_POLICY,
        buildTransaction: buildTransaction as SocialActionDescriptor<TId>["buildTransaction"],
    });
}

const assignOrganizationRole = organizationRoleAction(
    "organization.assign_role.v1",
    "assign_organization_role",
    buildAssignOrganizationRoleTx,
);
const revokeOrganizationRole = organizationRoleAction(
    "organization.revoke_role.v1",
    "revoke_organization_role",
    buildRevokeOrganizationRoleTx,
);

const createOrganizationInvitation = defineAction(
    {
        id: "organization.create_invitation.v1",
        version: 1,
        legacyAction: "create_organization_invitation",
        requiredCapability: CAP_AGENT_UPDATE,
        riskTier: "3",
        inputSchema: objectSchema(["organizationId", "orgMemoryGroupId", "invitee", "permissionsMask"], {
            organizationId: NON_EMPTY_STRING,
            orgMemoryGroupId: NON_EMPTY_STRING,
            invitee: NON_EMPTY_STRING,
            roleName: OPTIONAL_STRING,
            permissionsMask: NON_EMPTY_STRING,
            expiresAtMs: NON_EMPTY_STRING,
        }),
        idempotency: IDEMPOTENCY_POLICY,
        buildTransaction: buildCreateOrganizationInvitationTx,
    },
    (input) => {
        if (!input.roleName && input.permissionsMask === "0") {
            throw new TypeError("An invitation requires a roleName or non-zero permissionsMask");
        }
    },
);

function invitationDecisionAction<TId extends "organization.accept_invitation.v1" | "organization.decline_invitation.v1">(
    id: TId,
    legacyAction: "accept_organization_invitation" | "decline_organization_invitation",
    buildTransaction: typeof buildAcceptOrganizationInvitationTx,
): SocialActionDescriptor<TId> {
    return defineAction<TId>({
        id,
        version: 1,
        legacyAction,
        requiredCapability: CAP_MEMORY_READ,
        riskTier: "1B",
        inputSchema: objectSchema(
            id === "organization.accept_invitation.v1"
                ? ["organizationAccountId", "organizationId", "orgMemoryGroupId", "invitee"]
                : ["organizationAccountId", "organizationId", "invitee"],
            {
                organizationAccountId: NON_EMPTY_STRING,
                organizationId: NON_EMPTY_STRING,
                orgMemoryGroupId: NON_EMPTY_STRING,
                invitee: NON_EMPTY_STRING,
            },
        ),
        idempotency: IDEMPOTENCY_POLICY,
        buildTransaction: buildTransaction as SocialActionDescriptor<TId>["buildTransaction"],
    });
}

const acceptOrganizationInvitation = invitationDecisionAction(
    "organization.accept_invitation.v1",
    "accept_organization_invitation",
    buildAcceptOrganizationInvitationTx,
);
const declineOrganizationInvitation = invitationDecisionAction(
    "organization.decline_invitation.v1",
    "decline_organization_invitation",
    buildDeclineOrganizationInvitationTx,
);

const registerRootAgent = defineAction(
    {
        id: "agent.register_agent.v1",
        version: 1,
        legacyAction: "register_root_agent",
        requiredCapability: CAP_AGENT_REGISTER,
        riskTier: "3",
        inputSchema: objectSchema(["organizationId", "publicKeyHex", "derivedAddress", "label"], {
            organizationId: NON_EMPTY_STRING,
            ...AGENT_POLICY_PROPERTIES,
        }),
        idempotency: IDEMPOTENCY_POLICY,
        buildTransaction: buildRegisterRootAgentTx,
    },
    validateAgentPolicy,
);

const registerChildAgent = defineAction(
    {
        id: "agent.register_child.v1",
        version: 1,
        legacyAction: "register_child_agent",
        requiredCapability: CAP_AGENT_REGISTER,
        riskTier: "1B",
        inputSchema: objectSchema(
            ["parentAgentObjectId", "registerRelation", "publicKeyHex", "derivedAddress", "label"],
            {
                parentAgentObjectId: NON_EMPTY_STRING,
                registerRelation: U8,
                ...AGENT_POLICY_PROPERTIES,
            },
        ),
        idempotency: IDEMPOTENCY_POLICY,
        buildTransaction: buildRegisterChildAgentTx,
    },
    validateAgentPolicy,
);

const updateManagedAgent = defineAction({
    id: "agent.update_child.v1",
    version: 1,
    legacyAction: "update_managed_agent",
    requiredCapability: CAP_AGENT_UPDATE,
    riskTier: "1B",
    inputSchema: objectSchema(
        ["agentObjectId", "identityClass", "roleTags", "capabilities", "delegatableCaps", "registerScope", "approvalRequiredCaps"],
        {
            agentObjectId: NON_EMPTY_STRING,
            identityClass: U8,
            roleTags: NON_EMPTY_STRING,
            capabilities: NON_EMPTY_STRING,
            delegatableCaps: NON_EMPTY_STRING,
            registerScope: U8,
            approvalRequiredCaps: NON_EMPTY_STRING,
            maxActionSpendMist: NON_EMPTY_STRING,
            platformScope: NON_EMPTY_STRING,
            expiresAtMs: NON_EMPTY_STRING,
        },
    ),
    idempotency: IDEMPOTENCY_POLICY,
    buildTransaction: buildUpdateManagedAgentTx,
});

function managedAgentAction<TId extends "agent.deactivate_child.v1" | "agent.revoke_child.v1">(
    id: TId,
    legacyAction: "deactivate_managed_agent" | "revoke_managed_agent",
    buildTransaction: typeof buildDeactivateManagedAgentTx,
): SocialActionDescriptor<TId> {
    return defineAction<TId>({
        id,
        version: 1,
        legacyAction,
        requiredCapability: CAP_AGENT_REVOKE,
        riskTier: "1B",
        inputSchema: objectSchema(["agentObjectId"], { agentObjectId: NON_EMPTY_STRING }),
        idempotency: IDEMPOTENCY_POLICY,
        buildTransaction: buildTransaction as SocialActionDescriptor<TId>["buildTransaction"],
    });
}

const deactivateManagedAgent = managedAgentAction(
    "agent.deactivate_child.v1",
    "deactivate_managed_agent",
    buildDeactivateManagedAgentTx,
);
const revokeManagedAgent = managedAgentAction(
    "agent.revoke_child.v1",
    "revoke_managed_agent",
    buildRevokeManagedAgentTx,
);

const deletePost = defineAction({
    id: "social.delete_post.v1",
    version: 1,
    legacyAction: "delete_post",
    requiredCapability: CAP_POST_PUBLISH,
    riskTier: "3",
    inputSchema: objectSchema(["postId"], { postId: NON_EMPTY_STRING }),
    idempotency: IDEMPOTENCY_POLICY,
    buildTransaction: (context, input) =>
        buildDeletePostTx(context.chain, input.postId, context.Transaction),
});

const deleteComment = defineAction({
    id: "social.delete_comment.v1",
    version: 1,
    legacyAction: "delete_comment",
    requiredCapability: CAP_COMMENT,
    riskTier: "3",
    inputSchema: objectSchema(["postId", "commentId"], {
        postId: NON_EMPTY_STRING,
        commentId: NON_EMPTY_STRING,
    }),
    idempotency: IDEMPOTENCY_POLICY,
    buildTransaction: (context, input) =>
        buildDeleteCommentTx(
            context.chain,
            input.postId,
            input.commentId,
            context.Transaction,
        ),
});

export const SOCIAL_ACTION_REGISTRY: SocialActionRegistry = Object.freeze({
    "social.react_to_post.v1": reactToPost,
    "social.remove_post_reaction.v1": removePostReaction,
    "social.react_to_comment.v1": reactToComment,
    "social.remove_comment_reaction.v1": removeCommentReaction,
    "social.create_post.v1": createPost,
    "social.edit_post.v1": editPost,
    "social.create_comment.v1": createComment,
    "social.edit_comment.v1": editComment,
    "social.create_repost.v1": createRepost,
    "social.remove_repost.v1": removeRepost,
    "social.follow_profile.v1": followProfile,
    "social.unfollow_profile.v1": unfollowProfile,
    "social.block_profile.v1": blockProfile,
    "social.unblock_profile.v1": unblockProfile,
    "messaging.send_message.v1": sendMessage,
    "messaging.create_group.v1": createMessagingGroup,
    "organization.create.v1": createOrganization,
    "organization.update_metadata.v1": updateOrganizationMetadata,
    "organization.update_category.v1": updateOrganizationCategory,
    "organization.deactivate.v1": deactivateOrganization,
    "organization.ensure_memory_group.v1": ensureOrganizationMemoryGroup,
    "organization.define_role.v1": defineOrganizationRole,
    "organization.assign_role.v1": assignOrganizationRole,
    "organization.revoke_role.v1": revokeOrganizationRole,
    "organization.create_invitation.v1": createOrganizationInvitation,
    "organization.accept_invitation.v1": acceptOrganizationInvitation,
    "organization.decline_invitation.v1": declineOrganizationInvitation,
    "agent.register_agent.v1": registerRootAgent,
    "agent.register_child.v1": registerChildAgent,
    "agent.update_child.v1": updateManagedAgent,
    "agent.deactivate_child.v1": deactivateManagedAgent,
    "agent.revoke_child.v1": revokeManagedAgent,
    "social.delete_post.v1": deletePost,
    "social.delete_comment.v1": deleteComment,
});

const SOCIAL_ACTION_ID_SET: ReadonlySet<string> = new Set(SOCIAL_ACTION_IDS);

export class UnsupportedSocialActionError extends Error {
    readonly code = "unsupported_social_action";

    constructor(readonly actionId: string) {
        super(`Unsupported social action: ${actionId}`);
        this.name = "UnsupportedSocialActionError";
    }
}

export class InvalidSocialActionInputError extends Error {
    readonly code = "invalid_social_action_input";

    constructor(
        readonly actionId: SocialActionId,
        readonly issues: readonly SocialActionValidationIssue[],
    ) {
        super(
            `Invalid input for ${actionId}: ${issues
                .map((issue) => `${issue.path} ${issue.message}`)
                .join("; ")}`,
        );
        this.name = "InvalidSocialActionInputError";
    }
}

export function isSocialActionId(value: string): value is SocialActionId {
    return SOCIAL_ACTION_ID_SET.has(value);
}

export function getSocialActionDescriptor<TId extends SocialActionId>(
    actionId: TId,
): SocialActionRegistry[TId];
export function getSocialActionDescriptor(actionId: string): AnySocialActionDescriptor;
export function getSocialActionDescriptor(
    actionId: string,
): AnySocialActionDescriptor {
    if (!isSocialActionId(actionId)) {
        throw new UnsupportedSocialActionError(actionId);
    }
    return SOCIAL_ACTION_REGISTRY[actionId] as AnySocialActionDescriptor;
}

/** Builds only registered actions; arbitrary Move targets and caller-supplied PTBs are impossible. */
export function buildRegisteredSocialAction(
    actionId: string,
    context: BuildTxContext,
    input: unknown,
): any {
    const descriptor = getSocialActionDescriptor(actionId);
    const validation = descriptor.validate(input as never);
    if (!validation.success) {
        throw new InvalidSocialActionInputError(descriptor.id, validation.issues);
    }
    return descriptor.buildTransaction(context, validation.value as never);
}

export async function createSocialActionRequestMetadata<TId extends SocialActionId>(
    actionId: TId,
    input: unknown,
    idempotencyKey: string,
): Promise<SocialActionRequestMetadata<TId>>;
export async function createSocialActionRequestMetadata(
    actionId: string,
    input: unknown,
    idempotencyKey: string,
): Promise<SocialActionRequestMetadata>;
export async function createSocialActionRequestMetadata(
    actionId: string,
    input: unknown,
    idempotencyKey: string,
): Promise<SocialActionRequestMetadata> {
    const descriptor = getSocialActionDescriptor(actionId);
    const validation = descriptor.validate(input as never);
    if (!validation.success) {
        throw new InvalidSocialActionInputError(descriptor.id, validation.issues);
    }
    if (idempotencyKey.trim().length === 0) {
        throw new TypeError("idempotencyKey must not be empty");
    }
    const parameterHash = await hashActionParameters(validation.value);

    return Object.freeze({
        registryAction: descriptor.id,
        registryVersion: SOCIAL_ACTION_REGISTRY_VERSION,
        actionVersion: descriptor.version,
        legacyAction: descriptor.legacyAction,
        requiredCapability: descriptor.requiredCapability,
        riskTier: descriptor.riskTier,
        parameterHash,
        idempotency: Object.freeze({
            key: idempotencyKey,
            scope: descriptor.idempotency.scope,
            replayBehavior: descriptor.idempotency.replayBehavior,
        }),
    });
}

export function finalizeSocialActionPreparation<TId extends SocialActionId>(
    request: SocialActionRequestMetadata<TId>,
    options: FinalizeSocialActionPreparationOptions,
): PreparedSocialActionMetadata<TId> {
    if (
        options.actionId.trim().length === 0 ||
        options.packageId.trim().length === 0 ||
        options.packageVersion.trim().length === 0
    ) {
        throw new TypeError("actionId, packageId, and packageVersion are required");
    }
    if (!isSha256Digest(options.transactionBytesHash)) {
        throw new TypeError("transactionBytesHash must be a sha256 digest");
    }
    if (
        !Number.isSafeInteger(options.preparedAtMs) ||
        !Number.isSafeInteger(options.expiresAtMs) ||
        options.expiresAtMs <= options.preparedAtMs
    ) {
        throw new TypeError("expiresAtMs must be a safe integer after preparedAtMs");
    }

    return Object.freeze({ ...request, ...options });
}
