import type {
    OwnerAgentIdentityParams,OwnerChangeCapabilityParams,OwnerRaiseSpendingLimitParams,OwnerLowerSpendingLimitParams, OwnerRotationActionParams,
    SendTokenParams, TipPostParams, ClaimCreatorVaultParams, AcceptBeneficiaryTransferParams, ClaimSpotPayoutParams, PlaceSpotBetParams, CreateSpotMarketParams, BurnZeroCoinParams,
    DexSwapParams, SptBuyParams, SptSellParams,
    SubscribeToPlanParams, RenewSubscriptionParams, CancelSubscriptionParams, SubscriptionRenewalPreferenceParams, ChangeServicePaymentRecipientParams,
    PurchaseMyDataAccessParams, PurchasePostAccessParams, PublishMyDataGraphParams, ShareMyDataParams, RevokeMyDataShareParams, GovernanceVoteParams, GovernanceDelegateVoteParams, TransferOwnedObjectParams,
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
    BindAgentRoomToTaskParams,
    CreateOrganizationParams,
    UpdateOrganizationMetadataParams,
    UpdateOrganizationCategoryParams,
    OrganizationObjectParams,
    DefineOrganizationRoleParams,
    OrganizationRoleParams,
    CreateOrganizationInvitationParams,
    OrganizationInvitationDecisionParams,
    OrganizationTreasuryAccessParams,
    OrganizationTreasuryFundParams,
    OrganizationTreasuryWithdrawParams,
    PlatformDeveloperTransferParams,
    PlatformFeeRecipientUpdateParams,
    RegisterRootAgentParams,
    RegisterChildAgentParams,
    UpdateManagedAgentParams,
    ManagedAgentParams,
    TaskAcceptParams,
    TaskCancelOfferParams,
    JuryAcceptParams,
    JuryApplyDecisionParams,
    JuryCaseParams,
    JurySweepVoteRefundsParams,
    JuryClaimFeeParams,
    JuryCommitVoteParams,
    JuryEscalateProposalParams,
    JuryEvictParams,
    JuryExecuteNeutralParams,
    JuryFinalizeProposalParams,
    JuryRefreshRosterParams,
    JuryRevealVoteParams,
    JurySettleFeesParams,
    JuryStartNeutralParams,
    JuryTaskVerdictParams,
    TaskAcceptDisputeSettlementParams,
    TaskCancelDisputeParams,
    TaskClearDisputeSettlementParams,
    TaskDisputeEvidenceParams,
    TaskDisputeFeeParams,
    TaskOpenDisputeParams,
    TaskProposeDisputeSettlementParams,

    TaskCreateParams,
    TaskDeliverParams,
    TaskPermissionlessParams,
    TaskRefundProposalParams,
    TaskReleaseParams,
    TaskReviewParams,
    TaskSellerParams,
    TaskSettleParams,
    SocialExecuteAction,
} from "../types.js";
import type { BuildTxContext } from "../ptb/post.js";

export const SOCIAL_ACTION_REGISTRY_VERSION = "1.33.0" as const;
/** Task-room binding requires v1.26; organization-audience MyData purchases require v1.21; post-bound MyData purchase v1.20; delegate voting v1.19; object transfer v1.18; governance voting v1.17; creator-vault claims v1.13; post/comment deletion v1.12; post tipping v1.11; owner-agent policies v1.10; token transfers v1.9+; subscriptions v1.8+; owner access v1.7+; purchases v1.6+. */
export function isSupportedSocialRegistryVersion(version: string, action: string): boolean {
    if (action === "account.rotate_owner_key.v1" && version !== "1.32.0" && version !== "1.33.0") return false;
    if (action === "agent.lower_spending_limit.v1" && version !== "1.33.0") return false;
    if (["organization.grant_treasury_access.v1", "organization.withdraw_treasury.v1", "organization.fund_treasury.v1"].includes(action) && !["1.29.0", "1.30.0"].includes(version)) return false;
    if (["platform.transfer_platform.v1", "platform.update_fee_recipient.v1"].includes(action) && version !== "1.30.0") return false;
    if(version===SOCIAL_ACTION_REGISTRY_VERSION)return true;
    if(action==="spt.buy.v1" || action==="spt.sell.v1")return false;
    if(action==="poc.accept_beneficiary_transfer.v1" && version!=="1.28.0")return false;
    if(action==="subscription.change_service_payment_recipient.v1")return false;
    if(action==="access.publish_mydata_graph.v1")return false;
    if(action==="access.purchase_post_access.v1" && !["1.20.0","1.21.0"].includes(version))return false;
    if(action==="spot.create_market.v1")return false;
    if(action==="governance.vote.v1")return false;
    if(action==="assets.transfer_object.v1")return false;
    if(action==="assets.burn_object.v1")return false;
    if(action==="governance.delegate_vote.v1")return false;
    if(action==="messaging.bind_room_to_task.v1")return false;
    const introducedAfter:Record<string,readonly string[]>={
    "1.18.0":["governance.delegate_vote.v1"],
        "1.15.0":[],
        "1.14.0":["spot.place_bet.v1"],
        "1.13.0":["spot.claim_payout.v1","spot.place_bet.v1"],
        "1.12.0":["poc.claim_creator_vault.v1","spot.claim_payout.v1","spot.place_bet.v1"],
        "1.11.0":["social.delete_post.v1","social.delete_comment.v1","poc.claim_creator_vault.v1","spot.claim_payout.v1","spot.place_bet.v1"],
        "1.10.0":["payments.tip_post.v1","social.delete_post.v1","social.delete_comment.v1","poc.claim_creator_vault.v1","spot.claim_payout.v1","spot.place_bet.v1"],
        "1.9.0":[...OWNER_AGENT_ACTION_IDS,"payments.tip_post.v1","social.delete_post.v1","social.delete_comment.v1","poc.claim_creator_vault.v1","spot.claim_payout.v1","spot.place_bet.v1"],
        "1.8.0":["payments.send_token.v1",...OWNER_AGENT_ACTION_IDS,"payments.tip_post.v1","social.delete_post.v1","social.delete_comment.v1","poc.claim_creator_vault.v1","spot.claim_payout.v1","spot.place_bet.v1"],
        "1.7.0":[...PROFILE_SUBSCRIPTION_ACTION_IDS,"payments.send_token.v1",...OWNER_AGENT_ACTION_IDS,"payments.tip_post.v1","social.delete_post.v1","social.delete_comment.v1","poc.claim_creator_vault.v1","spot.claim_payout.v1","spot.place_bet.v1"],
        "1.6.0":["access.share_mydata.v1","access.revoke_mydata_share.v1",...PROFILE_SUBSCRIPTION_ACTION_IDS,"payments.send_token.v1",...OWNER_AGENT_ACTION_IDS,"payments.tip_post.v1","social.delete_post.v1","social.delete_comment.v1","poc.claim_creator_vault.v1","spot.claim_payout.v1","spot.place_bet.v1"],
        "1.5.0":["access.purchase_mydata_access.v1","access.share_mydata.v1","access.revoke_mydata_share.v1",...PROFILE_SUBSCRIPTION_ACTION_IDS,"payments.send_token.v1",...OWNER_AGENT_ACTION_IDS,"payments.tip_post.v1","social.delete_post.v1","social.delete_comment.v1","poc.claim_creator_vault.v1","spot.claim_payout.v1","spot.place_bet.v1"],
    };
    return introducedAfter[version]?.includes(action)===false;
}

export const PROFILE_SUBSCRIPTION_ACTION_IDS = ["subscription.subscribe_to_plan.v1","subscription.renew_subscription.v1","subscription.cancel_subscription.v1","subscription.enable_auto_renew.v1","subscription.disable_auto_renew.v1"] as const;

export const OWNER_AGENT_ACTION_IDS=["agent.revoke_agent.v1","agent.grant_capability.v1","agent.revoke_capability.v1","agent.raise_spending_limit.v1","agent.lower_spending_limit.v1"] as const;

export const SOCIAL_ACTION_IDS = Object.freeze([
    "account.rotate_owner_key.v1",
    ...OWNER_AGENT_ACTION_IDS,
    "payments.tip_post.v1",
    "payments.send_token.v1",
    ...PROFILE_SUBSCRIPTION_ACTION_IDS,
    "subscription.change_service_payment_recipient.v1",
    "poc.claim_creator_vault.v1",
    "poc.accept_beneficiary_transfer.v1",
    "spot.claim_payout.v1",
    "spot.place_bet.v1",
    "spot.create_market.v1",
    "dex.swap.v1",
    "spt.buy.v1",
    "spt.sell.v1",
    "governance.vote.v1",
    "governance.delegate_vote.v1",
    "assets.transfer_object.v1",
    "assets.burn_object.v1",
    "organization.grant_treasury_access.v1",
    "organization.withdraw_treasury.v1",
    "organization.fund_treasury.v1",
    "platform.transfer_platform.v1",
    "platform.update_fee_recipient.v1",
    "access.purchase_mydata_access.v1",
    "access.publish_mydata_graph.v1",
    "access.purchase_post_access.v1",
    "access.share_mydata.v1",
    "access.revoke_mydata_share.v1",
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
    "messaging.bind_room_to_task.v1",
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
    "task.create.v1",
    "task.accept.v1",
    "task.decline.v1",
    "task.cancel_offer.v1",
    "task.deliver.v1",
    "task.settle.v1",
    "task.refund.v1",
    "task.release.v1",
    "task.expire_offer.v1",
    "task.propose_refund.v1",
    "task.accept_refund.v1",
    "task.reject_refund.v1",
    "task.withdraw_refund.v1",
    "task.review.v1",
    "task.open_dispute.v1",
    "task.respond_dispute.v1",
    "task.submit_evidence.v1",
    "task.appeal.v1",
    "task.cancel_dispute.v1",
    "task.propose_dispute_settlement.v1",
    "task.accept_dispute_settlement.v1",
    "task.clear_dispute_settlement.v1",
    "jury.accept.v1",
    "jury.commit_vote.v1",
    "jury.reveal_vote.v1",
    "jury.claim_fee.v1",
    "jury.select_jury.v1",
    "jury.replace_no_shows.v1",
    "jury.finalize_round.v1",
    "jury.finalize_case.v1",
    "jury.execute_task_verdict.v1",
    "jury.start_neutral_resolution.v1",
    "jury.execute_neutral_resolution.v1",
    "jury.settle_dispute_fees.v1",
    "jury.escalate_proposal.v1",
    "jury.finalize_proposal.v1",
    "jury.apply_proposal_decision.v1",
    "jury.sweep_case.v1",
    "jury.sweep_vote_refunds.v1",
    "jury.refresh_roster_entry.v1",
    "jury.evict_ineligible.v1",
] as const);

export type SocialActionId = (typeof SOCIAL_ACTION_IDS)[number];

export interface SocialActionInputMap {
    "account.rotate_owner_key.v1": OwnerRotationActionParams;
    "agent.revoke_agent.v1":OwnerAgentIdentityParams;
    "agent.grant_capability.v1":OwnerChangeCapabilityParams;
    "agent.revoke_capability.v1":OwnerChangeCapabilityParams;
    "agent.raise_spending_limit.v1":OwnerRaiseSpendingLimitParams;
    "agent.lower_spending_limit.v1":OwnerLowerSpendingLimitParams;
    "payments.send_token.v1":SendTokenParams;
    "payments.tip_post.v1":TipPostParams;
    "subscription.subscribe_to_plan.v1":SubscribeToPlanParams;
    "subscription.renew_subscription.v1":RenewSubscriptionParams;
    "subscription.cancel_subscription.v1":CancelSubscriptionParams;
    "subscription.enable_auto_renew.v1":SubscriptionRenewalPreferenceParams;
    "subscription.disable_auto_renew.v1":SubscriptionRenewalPreferenceParams;
    "subscription.change_service_payment_recipient.v1":ChangeServicePaymentRecipientParams;
        "access.purchase_mydata_access.v1": PurchaseMyDataAccessParams;
        "access.publish_mydata_graph.v1": PublishMyDataGraphParams;
        "access.purchase_post_access.v1": PurchasePostAccessParams;
    "poc.claim_creator_vault.v1": ClaimCreatorVaultParams;
    "poc.accept_beneficiary_transfer.v1": AcceptBeneficiaryTransferParams;
    "spot.claim_payout.v1": ClaimSpotPayoutParams;
    "spot.place_bet.v1": PlaceSpotBetParams;
    "spot.create_market.v1": CreateSpotMarketParams;
    "dex.swap.v1": DexSwapParams;
    "spt.buy.v1": SptBuyParams;
    "spt.sell.v1": SptSellParams;
    "governance.vote.v1": GovernanceVoteParams;
    "governance.delegate_vote.v1": GovernanceDelegateVoteParams;
    "assets.transfer_object.v1": TransferOwnedObjectParams;
    "assets.burn_object.v1": BurnZeroCoinParams;
    "organization.grant_treasury_access.v1": OrganizationTreasuryAccessParams;
    "organization.withdraw_treasury.v1": OrganizationTreasuryWithdrawParams;
    "organization.fund_treasury.v1": OrganizationTreasuryFundParams;
    "platform.transfer_platform.v1": PlatformDeveloperTransferParams;
    "platform.update_fee_recipient.v1": PlatformFeeRecipientUpdateParams;
    "access.share_mydata.v1": ShareMyDataParams;
    "access.revoke_mydata_share.v1": RevokeMyDataShareParams;
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
    "messaging.bind_room_to_task.v1": BindAgentRoomToTaskParams;
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
    "task.create.v1": TaskCreateParams;
    "task.accept.v1": TaskAcceptParams;
    "task.decline.v1": TaskSellerParams;
    "task.cancel_offer.v1": TaskCancelOfferParams;
    "task.deliver.v1": TaskDeliverParams;
    "task.settle.v1": TaskSettleParams;
    "task.refund.v1": TaskPermissionlessParams;
    "task.release.v1": TaskReleaseParams;
    "task.expire_offer.v1": TaskPermissionlessParams;
    "task.propose_refund.v1": TaskRefundProposalParams;
    "task.accept_refund.v1": TaskRefundProposalParams;
    "task.reject_refund.v1": TaskRefundProposalParams;
    "task.withdraw_refund.v1": TaskRefundProposalParams;
    "task.review.v1": TaskReviewParams;
    "task.open_dispute.v1": TaskOpenDisputeParams;
    "task.respond_dispute.v1": TaskDisputeFeeParams;
    "task.submit_evidence.v1": TaskDisputeEvidenceParams;
    "task.appeal.v1": TaskDisputeFeeParams;
    "task.cancel_dispute.v1": TaskCancelDisputeParams;
    "task.propose_dispute_settlement.v1": TaskProposeDisputeSettlementParams;
    "task.accept_dispute_settlement.v1": TaskAcceptDisputeSettlementParams;
    "task.clear_dispute_settlement.v1": TaskClearDisputeSettlementParams;
    "jury.accept.v1": JuryAcceptParams;
    "jury.commit_vote.v1": JuryCommitVoteParams;
    "jury.reveal_vote.v1": JuryRevealVoteParams;
    "jury.claim_fee.v1": JuryClaimFeeParams;
    "jury.select_jury.v1": JuryCaseParams;
    "jury.replace_no_shows.v1": JuryCaseParams;
    "jury.finalize_round.v1": JuryCaseParams;
    "jury.finalize_case.v1": JuryCaseParams;
    "jury.execute_task_verdict.v1": JuryTaskVerdictParams;
    "jury.start_neutral_resolution.v1": JuryStartNeutralParams;
    "jury.execute_neutral_resolution.v1": JuryExecuteNeutralParams;
    "jury.settle_dispute_fees.v1": JurySettleFeesParams;
    "jury.escalate_proposal.v1": JuryEscalateProposalParams;
    "jury.finalize_proposal.v1": JuryFinalizeProposalParams;
    "jury.apply_proposal_decision.v1": JuryApplyDecisionParams;
    "jury.sweep_case.v1": JuryCaseParams;
    "jury.sweep_vote_refunds.v1": JurySweepVoteRefundsParams;
    "jury.refresh_roster_entry.v1": JuryRefreshRosterParams;
    "jury.evict_ineligible.v1": JuryEvictParams;
}

export type SocialActionInput<TId extends SocialActionId> =
    SocialActionInputMap[TId];

export type SocialActionRiskTier = "0" | "1A" | "1B" | "2" | "3";

export interface JsonStringSchema {
    readonly type: "string";
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly const?: string;
    readonly enum?: readonly string[];
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
    readonly minItems?: number;
    readonly maxItems?: number;
}
export interface JsonObjectArraySchema {
    readonly type: "array";
    readonly items: JsonObjectSchema;
    readonly minItems?: number;
    readonly maxItems?: number;
}

export interface JsonObjectSchema {
    readonly type:"object";
    readonly additionalProperties:false;
    readonly required:readonly string[];
    readonly properties:Readonly<Record<string,JsonPropertySchema>>;
}
export type JsonPropertySchema =
    | JsonObjectSchema
    | JsonStringSchema
    | JsonBooleanSchema
    | JsonIntegerSchema
    | JsonStringArraySchema
    | JsonObjectArraySchema;

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
