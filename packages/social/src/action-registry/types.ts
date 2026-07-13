import type {
    CreateCommentParams,
    CreatePostParams,
    CreateRepostParams,
    DeleteCommentParams,
    DeletePostParams,
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
    SocialExecuteAction,
} from "../types.js";
import type { BuildTxContext } from "../ptb/post.js";

export const SOCIAL_ACTION_REGISTRY_VERSION = "1.3.0" as const;

export const SOCIAL_ACTION_IDS = Object.freeze([
    "social.react_to_post.v1",
    "social.remove_post_reaction.v1",
    "social.react_to_comment.v1",
    "social.remove_comment_reaction.v1",
    "social.create_post.v1",
    "social.edit_post.v1",
    "social.create_comment.v1",
    "social.edit_comment.v1",
    "social.create_repost.v1",
    "social.remove_repost.v1",
    "social.follow_profile.v1",
    "social.unfollow_profile.v1",
    "social.block_profile.v1",
    "social.unblock_profile.v1",
    "messaging.send_message.v1",
    "messaging.create_group.v1",
    "organization.create.v1",
    "organization.update_metadata.v1",
    "organization.update_category.v1",
    "organization.deactivate.v1",
    "organization.ensure_memory_group.v1",
    "organization.define_role.v1",
    "organization.assign_role.v1",
    "organization.revoke_role.v1",
    "organization.create_invitation.v1",
    "organization.accept_invitation.v1",
    "organization.decline_invitation.v1",
    "agent.register_agent.v1",
    "agent.register_child.v1",
    "agent.update_child.v1",
    "agent.deactivate_child.v1",
    "agent.revoke_child.v1",
    "social.delete_post.v1",
    "social.delete_comment.v1",
] as const);

export type SocialActionId = (typeof SOCIAL_ACTION_IDS)[number];

export interface SocialActionInputMap {
    "social.create_post.v1": CreatePostParams;
    "social.edit_post.v1": EditPostParams;
    "social.create_comment.v1": CreateCommentParams;
    "social.edit_comment.v1": EditCommentParams;
    "social.react_to_post.v1": ReactToPostParams;
    "social.remove_post_reaction.v1": RemovePostReactionParams;
    "social.react_to_comment.v1": ReactToCommentParams;
    "social.remove_comment_reaction.v1": RemoveCommentReactionParams;
    "social.create_repost.v1": CreateRepostParams;
    "social.remove_repost.v1": RemoveRepostParams;
    "social.follow_profile.v1": ProfileRelationParams;
    "social.unfollow_profile.v1": ProfileRelationParams;
    "social.block_profile.v1": ProfileRelationParams;
    "social.unblock_profile.v1": ProfileRelationParams;
    "messaging.send_message.v1": SendMessageParams;
    "messaging.create_group.v1": CreateMessagingGroupParams;
    "organization.create.v1": CreateOrganizationParams;
    "organization.update_metadata.v1": UpdateOrganizationMetadataParams;
    "organization.update_category.v1": UpdateOrganizationCategoryParams;
    "organization.deactivate.v1": OrganizationObjectParams;
    "organization.ensure_memory_group.v1": OrganizationObjectParams;
    "organization.define_role.v1": DefineOrganizationRoleParams;
    "organization.assign_role.v1": OrganizationRoleParams;
    "organization.revoke_role.v1": OrganizationRoleParams;
    "organization.create_invitation.v1": CreateOrganizationInvitationParams;
    "organization.accept_invitation.v1": OrganizationInvitationDecisionParams;
    "organization.decline_invitation.v1": OrganizationInvitationDecisionParams;
    "agent.register_agent.v1": RegisterRootAgentParams;
    "agent.register_child.v1": RegisterChildAgentParams;
    "agent.update_child.v1": UpdateManagedAgentParams;
    "agent.deactivate_child.v1": ManagedAgentParams;
    "agent.revoke_child.v1": ManagedAgentParams;
    "social.delete_post.v1": DeletePostParams;
    "social.delete_comment.v1": DeleteCommentParams;
}

export type SocialActionInput<TId extends SocialActionId> =
    SocialActionInputMap[TId];

export type SocialActionRiskTier = "0" | "1A" | "1B" | "2" | "3";

export interface JsonStringSchema {
    readonly type: "string";
    readonly minLength?: number;
}

export interface JsonBooleanSchema {
    readonly type: "boolean";
}

export interface JsonIntegerSchema {
    readonly type: "integer";
    readonly minimum?: number;
    readonly maximum?: number;
    readonly enum?: readonly number[];
}

export interface JsonStringArraySchema {
    readonly type: "array";
    readonly items: JsonStringSchema;
    readonly maxItems?: number;
}

export type JsonPropertySchema =
    | JsonStringSchema
    | JsonBooleanSchema
    | JsonIntegerSchema
    | JsonStringArraySchema;

/** A deliberately small, serializable JSON Schema subset used by current actions. */
export interface SocialActionInputSchema {
    readonly $schema: "https://json-schema.org/draft/2020-12/schema";
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly string[];
    readonly properties: Readonly<Record<string, JsonPropertySchema>>;
}

export type SocialActionValidationIssueCode =
    | "invalid_object"
    | "required"
    | "additional_property"
    | "invalid_type"
    | "min_length"
    | "max_items"
    | "invalid_value";

export interface SocialActionValidationIssue {
    readonly code: SocialActionValidationIssueCode;
    readonly path: string;
    readonly message: string;
}

export type SocialActionValidationResult<T> =
    | { readonly success: true; readonly value: T }
    | {
          readonly success: false;
          readonly issues: readonly SocialActionValidationIssue[];
      };

export interface SocialActionIdempotencyPolicy {
    readonly required: true;
    /** The gateway must additionally bind this scope to account and agent identity. */
    readonly scope: "account-agent-action";
    readonly parameterHashAlgorithm: "sha256-canonical-json-v1";
    readonly replayBehavior: "return-existing-result";
}

export interface SocialActionDescriptor<TId extends SocialActionId> {
    readonly id: TId;
    readonly version: 1;
    readonly legacyAction: SocialExecuteAction;
    readonly requiredCapability: number;
    readonly riskTier: SocialActionRiskTier;
    readonly inputSchema: SocialActionInputSchema;
    readonly idempotency: SocialActionIdempotencyPolicy;
    readonly validate: (
        input: unknown,
    ) => SocialActionValidationResult<SocialActionInput<TId>>;
    readonly buildTransaction: (
        context: BuildTxContext,
        input: SocialActionInput<TId>,
    ) => any;
}

export type SocialActionRegistry = {
    readonly [TId in SocialActionId]: SocialActionDescriptor<TId>;
};

export type AnySocialActionDescriptor = {
    [TId in SocialActionId]: SocialActionDescriptor<TId>;
}[SocialActionId];

export type Sha256Digest = `sha256:${string}`;

export interface SocialActionIdempotencyMetadata {
    readonly key: string;
    readonly scope: SocialActionIdempotencyPolicy["scope"];
    readonly replayBehavior: SocialActionIdempotencyPolicy["replayBehavior"];
}

/** Metadata produced before transaction construction and signing. */
export interface SocialActionRequestMetadata<
    TId extends SocialActionId = SocialActionId,
> {
    readonly registryAction: TId;
    readonly registryVersion: typeof SOCIAL_ACTION_REGISTRY_VERSION;
    readonly actionVersion: 1;
    readonly legacyAction: SocialExecuteAction;
    readonly requiredCapability: number;
    readonly riskTier: SocialActionRiskTier;
    readonly parameterHash: Sha256Digest;
    readonly idempotency: SocialActionIdempotencyMetadata;
}

/** Metadata that pins an executable action to exact code and transaction bytes. */
export interface PreparedSocialActionMetadata<
    TId extends SocialActionId = SocialActionId,
> extends SocialActionRequestMetadata<TId> {
    readonly actionId: string;
    readonly packageId: string;
    readonly packageVersion: string;
    readonly transactionBytesHash: Sha256Digest;
    readonly preparedAtMs: number;
    readonly expiresAtMs: number;
}

export interface FinalizeSocialActionPreparationOptions {
    readonly actionId: string;
    readonly packageId: string;
    readonly packageVersion: string;
    readonly transactionBytesHash: Sha256Digest;
    readonly preparedAtMs: number;
    readonly expiresAtMs: number;
}
