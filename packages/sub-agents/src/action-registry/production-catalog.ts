import {
    CAP_AGENT_REGISTER,
    CAP_AGENT_REVOKE,
    CAP_AGENT_UPDATE,
    CAP_BUDGET_MANAGE,
    CAP_COMMENT,
    CAP_MESSAGE_SEND,
    CAP_MEMORY_READ,
    CAP_MYDATA_READ,
    CAP_POST_PUBLISH,
    CAP_REACT,
    CAP_SOCIAL_GRAPH,
    CAP_TRADE_EXECUTE,
} from "../contract.js";

export const PRODUCTION_ACTION_CATALOG_VERSION = "1.3.0" as const;

export const TIER_1_ACTION_IDS = Object.freeze([
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
    "organization.accept_invitation.v1",
    "organization.decline_invitation.v1",
    "agent.register_child.v1",
    "agent.update_child.v1",
    "agent.deactivate_child.v1",
    "agent.revoke_child.v1",
] as const);

export const TIER_2_ACTION_IDS = Object.freeze([
    "payments.tip_profile.v1",
    "payments.tip_post.v1",
    "payments.send_token.v1",
    "subscription.subscribe_to_plan.v1",
    "subscription.renew_subscription.v1",
    "subscription.cancel_subscription.v1",
    "subscription.enable_auto_renew.v1",
    "subscription.disable_auto_renew.v1",
    "access.purchase_post_access.v1",
    "access.purchase_mydata_access.v1",
    "access.share_mydata.v1",
    "access.revoke_mydata_share.v1",
    "spt.buy.v1",
    "spt.sell.v1",
    "spot.create_market.v1",
    "spot.place_bet.v1",
    "spot.claim_payout.v1",
    "storage.purchase_capacity.v1",
    "dex.swap.v1",
    "bridge.initiate_transfer.v1",
] as const);

export const TIER_3_ACTION_IDS = Object.freeze([
    "organization.create.v1",
    "organization.update_metadata.v1",
    "organization.update_category.v1",
    "organization.deactivate.v1",
    "organization.ensure_memory_group.v1",
    "organization.define_role.v1",
    "organization.assign_role.v1",
    "organization.revoke_role.v1",
    "organization.create_invitation.v1",
    "agent.register_agent.v1",
    "agent.revoke_agent.v1",
    "agent.grant_capability.v1",
    "agent.revoke_capability.v1",
    "agent.raise_spending_limit.v1",
    "account.rotate_owner_key.v1",
    "account.configure_multisig.v1",
    "poc.claim_creator_vault.v1",
    "poc.transfer_beneficiary_rights.v1",
    "governance.vote.v1",
    "governance.delegate_vote.v1",
    "assets.transfer_object.v1",
    "assets.burn_object.v1",
    "platform.transfer_platform.v1",
    "platform.update_fee_recipient.v1",
    "organization.grant_treasury_access.v1",
    "organization.withdraw_treasury.v1",
    "subscription.change_service_payment_recipient.v1",
] as const);

export const PRODUCTION_ACTION_IDS = Object.freeze([
    ...TIER_1_ACTION_IDS,
    ...TIER_2_ACTION_IDS,
    ...TIER_3_ACTION_IDS,
] as const);

export type ProductionActionId = (typeof PRODUCTION_ACTION_IDS)[number];
export type ProductionActionTier = "1" | "2" | "3";
export type ProductionActionApproval =
    | "agent-capability"
    | "owner-wallet"
    | "owner-wallet-and-cosign";
export type ProductionActionAvailability =
    | "enabled"
    | "contract-change-required"
    | "transaction-builder-required"
    | "protocol-adapter-required";

export interface ProductionActionDescriptor {
    readonly id: ProductionActionId;
    readonly tier: ProductionActionTier;
    readonly approval: ProductionActionApproval;
    readonly requiredCapability: number | null;
    readonly availability: ProductionActionAvailability;
    readonly blocker?: string;
}

const enabled = new Set<string>([
    ...TIER_1_ACTION_IDS,
    "organization.create.v1",
    "organization.update_metadata.v1",
    "organization.update_category.v1",
    "organization.deactivate.v1",
    "organization.ensure_memory_group.v1",
    "organization.define_role.v1",
    "organization.assign_role.v1",
    "organization.revoke_role.v1",
    "organization.create_invitation.v1",
    "agent.register_agent.v1",
]);

const tierOneCapabilities: Readonly<Record<string, number>> = Object.freeze({
    "social.react_to_post.v1": CAP_REACT,
    "social.remove_post_reaction.v1": CAP_REACT,
    "social.react_to_comment.v1": CAP_REACT,
    "social.remove_comment_reaction.v1": CAP_REACT,
    "social.create_post.v1": CAP_POST_PUBLISH,
    "social.edit_post.v1": CAP_POST_PUBLISH,
    "social.create_comment.v1": CAP_COMMENT,
    "social.edit_comment.v1": CAP_COMMENT,
    "social.create_repost.v1": CAP_POST_PUBLISH,
    "social.remove_repost.v1": CAP_POST_PUBLISH,
    "social.follow_profile.v1": CAP_SOCIAL_GRAPH,
    "social.unfollow_profile.v1": CAP_SOCIAL_GRAPH,
    "social.block_profile.v1": CAP_SOCIAL_GRAPH,
    "social.unblock_profile.v1": CAP_SOCIAL_GRAPH,
    "messaging.send_message.v1": CAP_MESSAGE_SEND,
    "messaging.create_group.v1": CAP_MESSAGE_SEND,
    "organization.accept_invitation.v1": CAP_MEMORY_READ,
    "organization.decline_invitation.v1": CAP_MEMORY_READ,
    "agent.register_child.v1": CAP_AGENT_REGISTER,
    "agent.update_child.v1": CAP_AGENT_UPDATE,
    "agent.deactivate_child.v1": CAP_AGENT_REVOKE,
    "agent.revoke_child.v1": CAP_AGENT_REVOKE,
});

const tierOneBlockers: Readonly<Record<string, string>> = Object.freeze({});

const tierTwoCapabilities: Readonly<Record<string, number>> = Object.freeze({
    "access.purchase_mydata_access.v1": CAP_MYDATA_READ,
    "access.share_mydata.v1": CAP_MYDATA_READ,
    "access.revoke_mydata_share.v1": CAP_MYDATA_READ,
});

const tierThreeCapabilities: Readonly<Record<string, number>> = Object.freeze({
    "organization.create.v1": CAP_AGENT_REGISTER,
    "organization.update_metadata.v1": CAP_AGENT_UPDATE,
    "organization.update_category.v1": CAP_AGENT_UPDATE,
    "organization.deactivate.v1": CAP_AGENT_UPDATE,
    "organization.ensure_memory_group.v1": CAP_AGENT_UPDATE,
    "organization.define_role.v1": CAP_AGENT_UPDATE,
    "organization.assign_role.v1": CAP_AGENT_UPDATE,
    "organization.revoke_role.v1": CAP_AGENT_UPDATE,
    "organization.create_invitation.v1": CAP_AGENT_UPDATE,
    "agent.register_agent.v1": CAP_AGENT_REGISTER,
    "agent.revoke_agent.v1": CAP_AGENT_REVOKE,
    "agent.grant_capability.v1": CAP_AGENT_UPDATE,
    "agent.revoke_capability.v1": CAP_AGENT_UPDATE,
    "agent.raise_spending_limit.v1": CAP_BUDGET_MANAGE,
});

const protocolAdapters = new Set<string>([
    "payments.send_token.v1",
    "storage.purchase_capacity.v1",
    "dex.swap.v1",
    "bridge.initiate_transfer.v1",
    "assets.transfer_object.v1",
    "assets.burn_object.v1",
    "account.rotate_owner_key.v1",
    "account.configure_multisig.v1",
]);

function descriptor(
    id: ProductionActionId,
    tier: ProductionActionTier,
): ProductionActionDescriptor {
    if (tier === "1") {
        const isEnabled = enabled.has(id);
        return Object.freeze({
            id,
            tier,
            approval: "agent-capability" as const,
            requiredCapability: tierOneCapabilities[id] ?? null,
            availability: isEnabled ? "enabled" as const : "contract-change-required" as const,
            ...(isEnabled ? {} : { blocker: tierOneBlockers[id] ?? "A bounded agent-aware Move entry point is required." }),
        });
    }
    if (tier === "2") {
        return Object.freeze({
            id,
            tier,
            approval: "owner-wallet" as const,
            requiredCapability: tierTwoCapabilities[id] ?? CAP_TRADE_EXECUTE,
            availability: protocolAdapters.has(id)
                ? "protocol-adapter-required" as const
                : "transaction-builder-required" as const,
            blocker: protocolAdapters.has(id)
                ? "A protocol-specific allowlisted adapter, resolver, limits, and simulation policy are required."
                : "A validated registry schema, deterministic PTB builder, object resolver, and event parser are required.",
        });
    }
    const isEnabled = enabled.has(id);
    return Object.freeze({
        id,
        tier,
        approval: "owner-wallet-and-cosign" as const,
        requiredCapability: tierThreeCapabilities[id] ?? null,
        availability: isEnabled
            ? "enabled" as const
            : protocolAdapters.has(id)
            ? "protocol-adapter-required" as const
            : "transaction-builder-required" as const,
        ...(isEnabled ? {} : {
            blocker: protocolAdapters.has(id)
                ? "This operation requires a narrowly allowlisted owner-controlled protocol adapter; arbitrary objects or calls are forbidden."
                : "An exact-input owner co-sign flow and deterministic registry PTB builder are required.",
        }),
    });
}

export const PRODUCTION_ACTION_CATALOG: readonly ProductionActionDescriptor[] = Object.freeze([
    ...TIER_1_ACTION_IDS.map((id) => descriptor(id, "1")),
    ...TIER_2_ACTION_IDS.map((id) => descriptor(id, "2")),
    ...TIER_3_ACTION_IDS.map((id) => descriptor(id, "3")),
]);

const catalogById = new Map(PRODUCTION_ACTION_CATALOG.map((action) => [action.id, action]));

export function getProductionActionDescriptor(id: string): ProductionActionDescriptor | undefined {
    return catalogById.get(id as ProductionActionId);
}
