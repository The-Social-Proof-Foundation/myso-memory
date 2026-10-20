import {
    CAP_AGENT_REGISTER,
    CAP_AGENT_REVOKE,
    CAP_AGENT_UPDATE,
    CAP_COMMENT,
    CAP_JURY,
    CAP_NONE,
    CAP_MEMORY_READ,
    CAP_MESSAGE_SEND,
    CAP_POST_PUBLISH,
    CAP_REACT,
    CAP_SOCIAL_GRAPH,
    CAP_TASK_TRADE,
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
import {
    buildAcceptRefundTx,
    buildAcceptTaskTx,
    buildCancelOfferTx,
    buildCreateTaskTx,
    buildDeclineTaskTx,
    buildDeliverTaskTx,
    buildExpireOfferTx,
    buildProposeRefundTx,
    buildRefundTaskTx,
    buildRejectRefundTx,
    buildReleaseTaskTx,
    buildReviewTaskTx,
    buildSettleTaskTx,
    buildWithdrawRefundTx,
} from "../ptb/task.js";
import {
    buildJuryAcceptTx,
    buildJuryApplyDecisionTx,
    buildJuryClaimFeeTx,
    buildJuryCommitVoteTx,
    buildJuryEscalateProposalTx,
    buildJuryEvictTx,
    buildJuryExecuteNeutralTx,
    buildJuryExecuteTaskVerdictTx,
    buildJuryFinalizeCaseTx,
    buildJuryFinalizeProposalTx,
    buildJuryFinalizeRoundTx,
    buildJuryRefreshRosterTx,
    buildJuryReplaceNoShowsTx,
    buildJuryRevealVoteTx,
    buildJurySelectTx,
    buildJurySettleFeesTx,
    buildJuryStartNeutralTx,
    buildJurySweepCaseTx,
    buildJurySweepVoteRefundsTx,
    buildTaskAcceptDisputeSettlementTx,
    buildTaskAppealDisputeTx,
    buildTaskCancelDisputeTx,
    buildTaskClearDisputeSettlementTx,
    buildTaskDisputeEvidenceTx,
    buildTaskOpenDisputeTx,
    buildTaskProposeDisputeSettlementTx,
    buildTaskRespondDisputeTx,
} from "../ptb/jury.js";
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
        roomKind: U8,
        roomTaskId: NON_EMPTY_STRING,
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

const TASK_ID_PROPERTY = Object.freeze({ taskId: NON_EMPTY_STRING } as const);
const U64_STRING = NON_EMPTY_STRING;
const HEX_DIGEST = NON_EMPTY_STRING;
const STARS = Object.freeze({ type: "integer", minimum: 1, maximum: 5 } as const);

const taskCreate = defineAction({
    id: "task.create.v1",
    version: 1,
    legacyAction: "task_create",
    requiredCapability: CAP_TASK_TRADE,
    riskTier: "1B",
    inputSchema: objectSchema(
        [
            "sellerAccountId",
            "sellerAgentId",
            "amountMist",
            "scopeDigestHex",
            "title",
            "acceptWindowMs",
            "deliveryWindowMs",
            "settleWindowMs",
            "paymentCoinId",
        ],
        {
            sellerAccountId: NON_EMPTY_STRING,
            sellerAgentId: NON_EMPTY_STRING,
            amountMist: U64_STRING,
            scopeDigestHex: HEX_DIGEST,
            title: NON_EMPTY_STRING,
            acceptWindowMs: U64_STRING,
            deliveryWindowMs: U64_STRING,
            settleWindowMs: U64_STRING,
            paymentCoinId: NON_EMPTY_STRING,
            roomGroupId: NON_EMPTY_STRING,
            platformId: NON_EMPTY_STRING,
        },
    ),
    idempotency: IDEMPOTENCY_POLICY,
    buildTransaction: buildCreateTaskTx,
});

const taskAccept = defineAction({
    id: "task.accept.v1",
    version: 1,
    legacyAction: "task_accept",
    requiredCapability: CAP_TASK_TRADE,
    riskTier: "1B",
    inputSchema: objectSchema(["taskId", "sellerAgentId", "termsDigestHex"], {
        ...TASK_ID_PROPERTY,
        sellerAgentId: NON_EMPTY_STRING,
        termsDigestHex: HEX_DIGEST,
    }),
    idempotency: IDEMPOTENCY_POLICY,
    buildTransaction: buildAcceptTaskTx,
});

const taskDecline = defineAction({
    id: "task.decline.v1",
    version: 1,
    legacyAction: "task_decline",
    requiredCapability: CAP_TASK_TRADE,
    riskTier: "1B",
    inputSchema: objectSchema(["taskId", "sellerAgentId"], {
        ...TASK_ID_PROPERTY,
        sellerAgentId: NON_EMPTY_STRING,
    }),
    idempotency: IDEMPOTENCY_POLICY,
    buildTransaction: buildDeclineTaskTx,
});

const taskCancelOffer = defineAction({
    id: "task.cancel_offer.v1",
    version: 1,
    legacyAction: "task_cancel_offer",
    requiredCapability: CAP_TASK_TRADE,
    riskTier: "1B",
    inputSchema: objectSchema(["taskId"], TASK_ID_PROPERTY),
    idempotency: IDEMPOTENCY_POLICY,
    buildTransaction: buildCancelOfferTx,
});

const taskDeliver = defineAction({
    id: "task.deliver.v1",
    version: 1,
    legacyAction: "task_deliver",
    requiredCapability: CAP_TASK_TRADE,
    riskTier: "1B",
    inputSchema: objectSchema(["taskId", "sellerAgentId", "digestHex", "uri"], {
        ...TASK_ID_PROPERTY,
        sellerAgentId: NON_EMPTY_STRING,
        digestHex: HEX_DIGEST,
        uri: NON_EMPTY_STRING,
    }),
    idempotency: IDEMPOTENCY_POLICY,
    buildTransaction: buildDeliverTaskTx,
});

const taskSettle = defineAction({
    id: "task.settle.v1",
    version: 1,
    legacyAction: "task_settle",
    requiredCapability: CAP_TASK_TRADE,
    riskTier: "1B",
    inputSchema: objectSchema(["taskId", "sellerAccountId"], {
        ...TASK_ID_PROPERTY,
        sellerAccountId: NON_EMPTY_STRING,
        platformObjectId: NON_EMPTY_STRING,
    }),
    idempotency: IDEMPOTENCY_POLICY,
    buildTransaction: buildSettleTaskTx,
});

const taskRefund = defineAction({
    id: "task.refund.v1",
    version: 1,
    legacyAction: "task_refund",
    requiredCapability: CAP_TASK_TRADE,
    riskTier: "1B",
    inputSchema: objectSchema(["taskId"], TASK_ID_PROPERTY),
    idempotency: IDEMPOTENCY_POLICY,
    buildTransaction: buildRefundTaskTx,
});

const taskRelease = defineAction({
    id: "task.release.v1",
    version: 1,
    legacyAction: "task_release",
    requiredCapability: CAP_TASK_TRADE,
    riskTier: "1B",
    inputSchema: objectSchema(["taskId", "buyerAccountId", "sellerAccountId"], {
        ...TASK_ID_PROPERTY,
        buyerAccountId: NON_EMPTY_STRING,
        sellerAccountId: NON_EMPTY_STRING,
        platformObjectId: NON_EMPTY_STRING,
    }),
    idempotency: IDEMPOTENCY_POLICY,
    buildTransaction: buildReleaseTaskTx,
});

const taskExpireOffer = defineAction({
    id: "task.expire_offer.v1",
    version: 1,
    legacyAction: "task_expire_offer",
    requiredCapability: CAP_TASK_TRADE,
    riskTier: "1B",
    inputSchema: objectSchema(["taskId"], TASK_ID_PROPERTY),
    idempotency: IDEMPOTENCY_POLICY,
    buildTransaction: buildExpireOfferTx,
});

function refundProposalAction<
    TId extends
        | "task.propose_refund.v1"
        | "task.accept_refund.v1"
        | "task.reject_refund.v1"
        | "task.withdraw_refund.v1",
>(
    id: TId,
    legacyAction: SocialActionDescriptor<TId>["legacyAction"],
    buildTransaction: typeof buildProposeRefundTx,
): SocialActionDescriptor<TId> {
    return defineAction<TId>({
        id,
        version: 1,
        legacyAction,
        requiredCapability: CAP_TASK_TRADE,
        riskTier: "1B",
        inputSchema: objectSchema(["taskId", "buyerAccountId", "sellerAgentId"], {
            ...TASK_ID_PROPERTY,
            buyerAccountId: NON_EMPTY_STRING,
            sellerAgentId: NON_EMPTY_STRING,
        }),
        idempotency: IDEMPOTENCY_POLICY,
        buildTransaction: buildTransaction as SocialActionDescriptor<TId>["buildTransaction"],
    });
}

const taskProposeRefund = refundProposalAction("task.propose_refund.v1", "task_propose_refund", buildProposeRefundTx);
const taskAcceptRefund = refundProposalAction("task.accept_refund.v1", "task_accept_refund", buildAcceptRefundTx);
const taskRejectRefund = refundProposalAction("task.reject_refund.v1", "task_reject_refund", buildRejectRefundTx);
const taskWithdrawRefund = refundProposalAction("task.withdraw_refund.v1", "task_withdraw_refund", buildWithdrawRefundTx);

const taskReview = defineAction(
    {
        id: "task.review.v1",
        version: 1,
        legacyAction: "task_review",
        requiredCapability: CAP_TASK_TRADE,
        riskTier: "1B",
        inputSchema: objectSchema(["taskId", "raterRole", "stars", "buyerAccountId", "sellerAgentId"], {
            ...TASK_ID_PROPERTY,
            raterRole: NON_EMPTY_STRING,
            stars: STARS,
            buyerAccountId: NON_EMPTY_STRING,
            sellerAgentId: NON_EMPTY_STRING,
            sellerAccountId: NON_EMPTY_STRING,
            buyerAgentId: NON_EMPTY_STRING,
        }),
        idempotency: IDEMPOTENCY_POLICY,
        buildTransaction: buildReviewTaskTx,
    },
    (input) => {
        if (input.raterRole !== "buyer" && input.raterRole !== "seller") {
            throw new TypeError("raterRole must be \"buyer\" or \"seller\"");
        }
        if (input.raterRole === "buyer" && !input.sellerAccountId) {
            throw new TypeError("sellerAccountId is required when the buyer rates the seller");
        }
    },
);


const CASE_ID_PROPERTY = Object.freeze({ caseId: NON_EMPTY_STRING } as const);
const EVIDENCE_REFS = Object.freeze({
    type: "array",
    items: NON_EMPTY_STRING,
    maxItems: 64,
} as const);
const SETTLEMENT_OUTCOME = Object.freeze({
    type: "integer",
    enum: Object.freeze([0, 1, 2]),
} as const);
const JURY_STAGE = Object.freeze({
    type: "integer",
    enum: Object.freeze([1, 2]),
} as const);

/**
 * One action whose whole definition is its capability, its required and optional fields, and the
 * builder. Every jury and dispute action is a single Move call, so none needs a refinement.
 */
function simpleAction<TId extends SocialActionId>(
    id: TId,
    legacyAction: SocialActionDescriptor<TId>["legacyAction"],
    requiredCapability: number,
    required: readonly string[],
    properties: SocialActionInputSchema["properties"],
    buildTransaction: (context: BuildTxContext, input: any) => any,
): SocialActionDescriptor<TId> {
    return defineAction<TId>({
        id,
        version: 1,
        legacyAction,
        requiredCapability,
        riskTier: "1B",
        inputSchema: objectSchema(required, properties),
        idempotency: IDEMPOTENCY_POLICY,
        buildTransaction: buildTransaction as SocialActionDescriptor<TId>["buildTransaction"],
    });
}

const PARTY = { buyerAccountId: NON_EMPTY_STRING, sellerAgentId: NON_EMPTY_STRING } as const;
const PLATFORM_OBJECT = { platformObjectId: NON_EMPTY_STRING } as const;

// A party's steps in a dispute: the acting side resolves to buyer or seller on chain.
const taskOpenDispute = simpleAction(
    "task.open_dispute.v1", "task_open_dispute", CAP_TASK_TRADE,
    ["taskId", "buyerAccountId", "sellerAccountId", "sellerAgentId", "feeCoinId"],
    { ...TASK_ID_PROPERTY, ...PARTY, sellerAccountId: NON_EMPTY_STRING, feeCoinId: NON_EMPTY_STRING },
    buildTaskOpenDisputeTx,
);
const taskRespondDispute = simpleAction(
    "task.respond_dispute.v1", "task_respond_dispute", CAP_TASK_TRADE,
    ["taskId", "caseId", "buyerAccountId", "sellerAgentId", "feeCoinId"],
    { ...TASK_ID_PROPERTY, ...CASE_ID_PROPERTY, ...PARTY, feeCoinId: NON_EMPTY_STRING },
    buildTaskRespondDisputeTx,
);
const taskSubmitEvidence = simpleAction(
    "task.submit_evidence.v1", "task_dispute_evidence", CAP_TASK_TRADE,
    ["taskId", "caseId", "buyerAccountId", "sellerAgentId", "digestHex", "uri"],
    { ...TASK_ID_PROPERTY, ...CASE_ID_PROPERTY, ...PARTY, digestHex: HEX_DIGEST, uri: NON_EMPTY_STRING },
    buildTaskDisputeEvidenceTx,
);
const taskAppeal = simpleAction(
    "task.appeal.v1", "task_appeal_dispute", CAP_TASK_TRADE,
    ["taskId", "caseId", "buyerAccountId", "sellerAgentId", "feeCoinId"],
    { ...TASK_ID_PROPERTY, ...CASE_ID_PROPERTY, ...PARTY, feeCoinId: NON_EMPTY_STRING },
    buildTaskAppealDisputeTx,
);
const taskCancelDispute = simpleAction(
    "task.cancel_dispute.v1", "task_cancel_dispute", CAP_TASK_TRADE,
    ["taskId", "caseId", "buyerAccountId", "sellerAgentId"],
    { ...TASK_ID_PROPERTY, ...CASE_ID_PROPERTY, ...PARTY },
    buildTaskCancelDisputeTx,
);
const taskProposeDisputeSettlement = simpleAction(
    "task.propose_dispute_settlement.v1", "task_propose_dispute_settlement", CAP_TASK_TRADE,
    ["taskId", "buyerAccountId", "sellerAgentId", "outcome"],
    { ...TASK_ID_PROPERTY, ...PARTY, outcome: SETTLEMENT_OUTCOME },
    buildTaskProposeDisputeSettlementTx,
);
const taskAcceptDisputeSettlement = simpleAction(
    "task.accept_dispute_settlement.v1", "task_accept_dispute_settlement", CAP_TASK_TRADE,
    ["taskId", "buyerAccountId", "sellerAccountId", "sellerAgentId"],
    { ...TASK_ID_PROPERTY, ...PARTY, sellerAccountId: NON_EMPTY_STRING, ...PLATFORM_OBJECT },
    buildTaskAcceptDisputeSettlementTx,
);
const taskClearDisputeSettlement = simpleAction(
    "task.clear_dispute_settlement.v1", "task_clear_dispute_settlement", CAP_TASK_TRADE,
    ["taskId", "buyerAccountId", "sellerAgentId"],
    { ...TASK_ID_PROPERTY, ...PARTY },
    buildTaskClearDisputeSettlementTx,
);

// A juror's own steps. The juror agent holds CAP_JURY, which spends nothing.
const juryAccept = simpleAction(
    "jury.accept.v1", "jury_accept", CAP_JURY, ["caseId", "agentId"],
    { ...CASE_ID_PROPERTY, agentId: NON_EMPTY_STRING }, buildJuryAcceptTx,
);
const juryCommitVote = simpleAction(
    "jury.commit_vote.v1", "jury_commit_vote", CAP_JURY, ["caseId", "agentId", "commitmentHex"],
    { ...CASE_ID_PROPERTY, agentId: NON_EMPTY_STRING, commitmentHex: HEX_DIGEST }, buildJuryCommitVoteTx,
);
const juryRevealVote = simpleAction(
    "jury.reveal_vote.v1", "jury_reveal_vote", CAP_JURY,
    ["caseId", "agentId", "outcome", "rationaleDigestHex", "evidenceRefs", "bundleDigestHex", "saltHex"],
    {
        ...CASE_ID_PROPERTY,
        agentId: NON_EMPTY_STRING,
        outcome: U8,
        rationaleDigestHex: HEX_DIGEST,
        evidenceRefs: EVIDENCE_REFS,
        bundleDigestHex: HEX_DIGEST,
        saltHex: NON_EMPTY_STRING,
    },
    buildJuryRevealVoteTx,
);
const juryClaimFee = simpleAction(
    "jury.claim_fee.v1", "jury_claim_fee", CAP_JURY, ["caseId", "agentId"],
    { ...CASE_ID_PROPERTY, agentId: NON_EMPTY_STRING }, buildJuryClaimFeeTx,
);

// Cranks: permissionless on chain. Anyone's agent may drive them through the sponsored-gas path;
// the platform's default operator does, and any other operator can.
function juryCase<
    TId extends
        | "jury.select_jury.v1"
        | "jury.replace_no_shows.v1"
        | "jury.finalize_round.v1"
        | "jury.finalize_case.v1"
        | "jury.sweep_case.v1",
>(
    id: TId,
    legacy: SocialActionDescriptor<TId>["legacyAction"],
    build: (context: BuildTxContext, input: any) => any,
): SocialActionDescriptor<TId> {
    return simpleAction(id, legacy, CAP_NONE, ["caseId"], CASE_ID_PROPERTY, build);
}

const jurySelect = juryCase("jury.select_jury.v1", "jury_select", buildJurySelectTx);
const juryReplaceNoShows = juryCase("jury.replace_no_shows.v1", "jury_replace_no_shows", buildJuryReplaceNoShowsTx);
const juryFinalizeRound = juryCase("jury.finalize_round.v1", "jury_finalize_round", buildJuryFinalizeRoundTx);
const juryFinalizeCase = juryCase("jury.finalize_case.v1", "jury_finalize_case", buildJuryFinalizeCaseTx);
const jurySweepCase = juryCase("jury.sweep_case.v1", "jury_sweep_case", buildJurySweepCaseTx);

const juryExecuteTaskVerdict = simpleAction(
    "jury.execute_task_verdict.v1", "jury_execute_task_verdict", CAP_NONE,
    ["taskId", "caseId", "buyerAccountId", "sellerAccountId"],
    { ...TASK_ID_PROPERTY, ...CASE_ID_PROPERTY, buyerAccountId: NON_EMPTY_STRING, sellerAccountId: NON_EMPTY_STRING, ...PLATFORM_OBJECT },
    buildJuryExecuteTaskVerdictTx,
);
const juryStartNeutral = simpleAction(
    "jury.start_neutral_resolution.v1", "jury_start_neutral_resolution", CAP_NONE,
    ["taskId", "caseId"], { ...TASK_ID_PROPERTY, ...CASE_ID_PROPERTY }, buildJuryStartNeutralTx,
);
const juryExecuteNeutral = simpleAction(
    "jury.execute_neutral_resolution.v1", "jury_execute_neutral_resolution", CAP_NONE,
    ["taskId", "buyerAccountId", "sellerAccountId"],
    { ...TASK_ID_PROPERTY, buyerAccountId: NON_EMPTY_STRING, sellerAccountId: NON_EMPTY_STRING, ...PLATFORM_OBJECT },
    buildJuryExecuteNeutralTx,
);
const jurySettleFees = simpleAction(
    "jury.settle_dispute_fees.v1", "jury_settle_dispute_fees", CAP_NONE,
    ["taskId", "caseId"], { ...TASK_ID_PROPERTY, ...CASE_ID_PROPERTY, closeCaseFirst: OPTIONAL_BOOLEAN },
    buildJurySettleFeesTx,
);
const juryEscalateProposal = simpleAction(
    "jury.escalate_proposal.v1", "jury_escalate_proposal", CAP_NONE,
    ["registryId", "proposalId", "stage"],
    { registryId: NON_EMPTY_STRING, proposalId: NON_EMPTY_STRING, stage: JURY_STAGE, platformId: NON_EMPTY_STRING },
    buildJuryEscalateProposalTx,
);
const jurySweepVoteRefunds = simpleAction(
    "jury.sweep_vote_refunds.v1", "jury_sweep_vote_refunds", CAP_NONE,
    ["registryId", "proposalId"],
    { registryId: NON_EMPTY_STRING, proposalId: NON_EMPTY_STRING, platformId: NON_EMPTY_STRING },
    buildJurySweepVoteRefundsTx,
);
const juryFinalizeProposal = simpleAction(
    "jury.finalize_proposal.v1", "jury_finalize_proposal", CAP_NONE,
    ["registryId", "proposalId"],
    { registryId: NON_EMPTY_STRING, proposalId: NON_EMPTY_STRING, platformId: NON_EMPTY_STRING },
    buildJuryFinalizeProposalTx,
);
const juryApplyDecision = simpleAction(
    "jury.apply_proposal_decision.v1", "jury_apply_proposal_decision", CAP_NONE,
    ["registryId", "proposalId", "caseId"],
    { registryId: NON_EMPTY_STRING, proposalId: NON_EMPTY_STRING, ...CASE_ID_PROPERTY, platformId: NON_EMPTY_STRING },
    buildJuryApplyDecisionTx,
);
const juryRefreshRoster = simpleAction(
    "jury.refresh_roster_entry.v1", "jury_refresh_roster_entry", CAP_NONE,
    ["accountId", "agentId"], { accountId: NON_EMPTY_STRING, agentId: NON_EMPTY_STRING },
    buildJuryRefreshRosterTx,
);
const juryEvict = simpleAction(
    "jury.evict_ineligible.v1", "jury_evict_ineligible", CAP_NONE,
    ["agentId"], { agentId: NON_EMPTY_STRING }, buildJuryEvictTx,
);

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
    "task.create.v1": taskCreate,
    "task.accept.v1": taskAccept,
    "task.decline.v1": taskDecline,
    "task.cancel_offer.v1": taskCancelOffer,
    "task.deliver.v1": taskDeliver,
    "task.settle.v1": taskSettle,
    "task.refund.v1": taskRefund,
    "task.release.v1": taskRelease,
    "task.expire_offer.v1": taskExpireOffer,
    "task.propose_refund.v1": taskProposeRefund,
    "task.accept_refund.v1": taskAcceptRefund,
    "task.reject_refund.v1": taskRejectRefund,
    "task.withdraw_refund.v1": taskWithdrawRefund,
    "task.review.v1": taskReview,
    "task.open_dispute.v1": taskOpenDispute,
    "task.respond_dispute.v1": taskRespondDispute,
    "task.submit_evidence.v1": taskSubmitEvidence,
    "task.appeal.v1": taskAppeal,
    "task.cancel_dispute.v1": taskCancelDispute,
    "task.propose_dispute_settlement.v1": taskProposeDisputeSettlement,
    "task.accept_dispute_settlement.v1": taskAcceptDisputeSettlement,
    "task.clear_dispute_settlement.v1": taskClearDisputeSettlement,
    "jury.accept.v1": juryAccept,
    "jury.commit_vote.v1": juryCommitVote,
    "jury.reveal_vote.v1": juryRevealVote,
    "jury.claim_fee.v1": juryClaimFee,
    "jury.select_jury.v1": jurySelect,
    "jury.replace_no_shows.v1": juryReplaceNoShows,
    "jury.finalize_round.v1": juryFinalizeRound,
    "jury.finalize_case.v1": juryFinalizeCase,
    "jury.execute_task_verdict.v1": juryExecuteTaskVerdict,
    "jury.start_neutral_resolution.v1": juryStartNeutral,
    "jury.execute_neutral_resolution.v1": juryExecuteNeutral,
    "jury.settle_dispute_fees.v1": jurySettleFees,
    "jury.escalate_proposal.v1": juryEscalateProposal,
    "jury.finalize_proposal.v1": juryFinalizeProposal,
    "jury.apply_proposal_decision.v1": juryApplyDecision,
    "jury.sweep_case.v1": jurySweepCase,
    "jury.sweep_vote_refunds.v1": jurySweepVoteRefunds,
    "jury.refresh_roster_entry.v1": juryRefreshRoster,
    "jury.evict_ineligible.v1": juryEvict,
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
