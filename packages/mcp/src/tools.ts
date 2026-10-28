import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType, JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";
import { MARKET_ACTION_TOOLS, MARKET_ACTION_BY_TOOL, MARKET_TOOL_SCOPES } from "./registry-tools.js";
import { PLATFORM_TOOLS, PLATFORM_TOOL_BY_NAME, PLATFORM_TOOL_SCOPES } from "./platform-tools.js";
import { CAP_MEMORY_READ, CAP_MEMORY_WRITE, CAP_MYDATA_READ, PROFILE_SUBSCRIPTION_ACTION_IDS, getSocialActionDescriptor, ptb } from "@socialproof/sub-agents";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { SOCIAL_ACTION_IDS } from "@socialproof/sub-agents";
import { McpRuntimeError, toStructuredMcpError } from "./errors.js";
import type { SocialGateway } from "./social-gateway.js";
import type { AgentSignerProvisioner } from "./provisioning.js";
import { configureMySoMultisig } from "./multisig.js";

export interface MemoryClient {
    rememberAndWait(text: string, subLabel?: string): Promise<unknown>;
    recall(query: string, limit?: number): Promise<unknown>;
    health(): Promise<unknown>;
    /** Live signed service identity. Required for hosted memory disclosure/write. */
    getAgentContext?(): Promise<unknown>;
    destroy?(): void;
}

export interface ToolDependencies {
    memory: MemoryClient;
    social?: SocialGateway;
    agentProvisioner?: AgentSignerProvisioner;
    /** Omit for trusted local stdio. Hosted runtimes must supply verified OAuth scopes. */
    oauthScopes?: ReadonlySet<string>;
    /** Installed only from verified OAuth claims by the hosted transport. */
    principal?: { readonly accountId: string; readonly agentObjectId: string; readonly workerRun?: boolean };
}

export const TOOL_OAUTH_SCOPES: Readonly<Record<string, string>> = Object.freeze({
    ...Object.fromEntries(PROFILE_SUBSCRIPTION_ACTION_IDS.map(id=>[id.replace(/\.v1$/,"").replaceAll(".","_"),"subscription:write"])),
    subscription_change_service_payment_recipient: "subscription:write",
    ...MARKET_TOOL_SCOPES,
    ...PLATFORM_TOOL_SCOPES,
    payments_send_token: "payments:write",
    poc_claim_creator_vault: "payments:write",
    poc_accept_beneficiary_transfer: "payments:write",
    spot_claim_payout: "payments:write",
    spot_place_bet: "payments:write",
    spot_create_market: "payments:write",
    governance_vote: "payments:write",
    governance_delegate_vote: "payments:write",
    assets_transfer_object: "payments:write",
    assets_burn_object: "payments:write",
    account_configure_multisig: "agent:read",
    account_admin_propose_owner_rotation: "social:write",
    account_admin_accept_owner_rotation_batch: "social:write",
    account_admin_rollback_owner_rotation_batch: "social:write",
    account_admin_cancel_owner_rotation: "social:write",
    organization_grant_treasury_access: "payments:write",
    organization_withdraw_treasury: "payments:write",
    organization_fund_treasury: "payments:write",
    platform_transfer_developer: "organization:admin",
    platform_update_fee_recipient: "organization:admin",
    organization_get_treasury_balance: "payments:read",
    organization_get_treasury_access: "payments:read",
    poc_get_claim_receipt: "payments:read",
    poc_get_beneficiary_transfer_receipt: "payments:read",
    spot_get_claim_receipt: "payments:read",
    spot_get_bet_receipt: "payments:read",
    spot_get_market_receipt: "payments:read",
    dex_get_swap_receipt: "payments:read",
    payments_tip_post: "payments:write",
    access_share_mydata: "mydata:share",
    access_revoke_mydata_share: "mydata:share",
    memory_remember: "memory:write",
    memory_recall: "memory:read",
    memory_health: "memory:read",
    chain_get_action_status: "chain:read",
    chain_list_actions: "chain:read",
    social_create_post: "social:publish",
    social_create_comment: "social:publish",
    social_react_post: "social:write",
    social_react_comment: "social:write",
    social_create_repost: "social:publish",
    social_remove_post_reaction: "social:write",
    social_remove_comment_reaction: "social:write",
    social_edit_post: "social:publish",
    social_edit_comment: "social:publish",
    social_remove_repost: "social:publish",
    social_follow_profile: "social:write",
    social_unfollow_profile: "social:write",
    social_block_profile: "social:write",
    social_unblock_profile: "social:write",
    messaging_send_message: "social:write",
    messaging_create_group: "social:write",
    messaging_bind_room_to_task: "social:write",
    messaging_list_inbox: "messaging:read",
    messaging_list_rooms: "messaging:read",
    messaging_list_room_members: "messaging:read",
    messaging_wait_for_message: "messaging:read",
    messaging_get_room_history: "messaging:read",
    messaging_get_room_attachment: "messaging:read",
    messaging_send_room_message: "messaging:write",
    messaging_list_reactions: "messaging:read",
    messaging_get_room_receipts: "messaging:read",
    messaging_update_room_receipts: "messaging:write",
    messaging_edit_message: "messaging:write",
    messaging_delete_message: "messaging:write",
    messaging_remove_members_rotate_key: "messaging:write",
    messaging_revoke_member_from_all_rooms: "messaging:write",
    messaging_add_room_members: "messaging:write",
    messaging_leave_group: "messaging:write",
    messaging_set_room_name: "messaging:write",
    messaging_archive_group: "messaging:write",
    messaging_get_read_state: "messaging:read",
    messaging_update_read_state: "messaging:write",
    messaging_get_unread_counts: "messaging:read",
    messaging_add_reaction: "messaging:write",
    messaging_remove_reaction: "messaging:write",
    organization_get_control: "organization:read",
    organization_create: "organization:admin",
    organization_update_metadata: "organization:admin",
    organization_update_category: "organization:admin",
    organization_deactivate: "organization:admin",
    organization_ensure_memory_group: "organization:admin",
    organization_define_role: "organization:admin",
    organization_assign_role: "organization:admin",
    organization_revoke_role: "organization:admin",
    organization_create_invitation: "organization:admin",
    organization_accept_invitation: "agent:read",
    organization_decline_invitation: "agent:read",
    agent_provision_signer: "agent:provision",
    agent_admin_list: "agent:read",
    agent_admin_owner_rotation_manifest: "agent:read",
    agent_admin_owner_rotation_status: "agent:read",
    agent_admin_owner_rotation_progress: "agent:read",
    agent_admin_owner_rotation_receipt: "agent:read",
    agent_admin_get_quote: "agent:read",
    agent_admin_get_receipt: "agent:read",
    agent_admin_request_revoke: "organization:admin",
    agent_admin_request_grant_capability: "organization:admin",
    agent_admin_request_revoke_capability: "organization:admin",
    agent_admin_request_raise_spending_limit: "organization:admin",
    agent_admin_request_lower_spending_limit: "organization:admin",
    agent_register_root: "organization:admin",
    agent_register_child: "organization:admin",
    agent_update_child: "organization:admin",
    agent_deactivate_child: "organization:admin",
    agent_revoke_child: "organization:admin",
    social_delete_post: "social:destructive",
    social_delete_comment: "social:destructive",
    chain_request_action_approval: "social:write",
    chain_approve_action: "social:approve",
    chain_prepare_approved_action: "social:approve",
    chain_submit_approved_action: "social:approve",
});

export interface ToolSuccessEnvelope {
    ok: true;
    data: unknown;
}

export interface ToolErrorEnvelope {
    ok: false;
    error: ReturnType<typeof toStructuredMcpError>;
}

export type ToolEnvelope = ToolSuccessEnvelope | ToolErrorEnvelope;

const OUTPUT_SCHEMA: NonNullable<Tool["outputSchema"]> = {
    type: "object",
    properties: {
        ok: { type: "boolean" },
        data: {},
        error: {
            type: "object",
            properties: {
                code: { type: "string" },
                message: { type: "string" },
                retryable: { type: "boolean" },
                approvalRequired: { type: "boolean" },
                actionId: { type: "string" },
                digest: { type: "string" },
            },
            required: ["code", "message", "retryable", "approvalRequired"],
        },
    },
    required: ["ok"],
};

function annotations(
    title: string,
    options: {
        readOnly: boolean;
        destructive: boolean;
        idempotent: boolean;
        openWorld?: boolean;
    },
): NonNullable<Tool["annotations"]> {
    return {
        title,
        readOnlyHint: options.readOnly,
        destructiveHint: options.destructive,
        idempotentHint: options.idempotent,
        openWorldHint: options.openWorld ?? true,
    };
}

const MEMORY_TOOLS: Tool[] = [
    {
        name: "memory_remember",
        description: "Store text in encrypted agent memory and wait for the asynchronous job to finish.",
        inputSchema: {
            type: "object",
            properties: {
                text: { type: "string", minLength: 1 },
                subLabel: { type: "string", minLength: 1 },
            },
            required: ["text"],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Remember encrypted text", {
            readOnly: false,
            destructive: false,
            idempotent: false,
        }),
    },
    {
        name: "memory_recall",
        description: "Run semantic recall against the authenticated agent's encrypted memory.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", minLength: 1 },
                limit: { type: "integer", minimum: 1, maximum: 100 },
            },
            required: ["query"],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Recall encrypted memory", {
            readOnly: true,
            destructive: false,
            idempotent: true,
        }),
    },
    {
        name: "memory_health",
        description: "Check memory relayer health.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Check memory health", {
            readOnly: true,
            destructive: false,
            idempotent: true,
        }),
    },
];

const ID_KEY = { type: "string", minLength: 8, maxLength: 128 } as const;
const ID_STRING = { type: "string", minLength: 1 } as const;
const DECIMAL_STRING = { type: "string", pattern: "^(0|[1-9][0-9]{0,19})$" } as const;
const U8_INTEGER = { type: "integer", minimum: 0, maximum: 255 } as const;
const ORG_TYPE_INTEGER = { type: "integer", minimum: 0, maximum: 13 } as const;

const AGENT_POLICY_TOOL_PROPERTIES = {
    publicKeyHex: { type: "string", pattern: "^[0-9a-f]{64}$" },
    derivedAddress: ID_STRING,
    label: ID_STRING,
    identityClass: U8_INTEGER,
    roleTags: DECIMAL_STRING,
    capabilities: DECIMAL_STRING,
    delegatableCaps: DECIMAL_STRING,
    registerScope: U8_INTEGER,
    approvalRequiredCaps: DECIMAL_STRING,
    maxActionSpendMist: DECIMAL_STRING,
    platformScope: ID_STRING,
    expiresAtMs: DECIMAL_STRING,
} as const;

const ADDITIONAL_TIER_1_TOOLS: Tool[] = [
    ["social_remove_post_reaction", "Remove post reaction", { postId: ID_STRING }],
    ["social_remove_comment_reaction", "Remove comment reaction", { commentId: ID_STRING }],
    ["social_edit_post", "Edit social post", {
        postId: ID_STRING,
        content: ID_STRING,
        mediaUrls: { type: "array", items: ID_STRING },
        mentions: { type: "array", items: ID_STRING },
        metadataJson: { type: "string" },
    }],
    ["social_edit_comment", "Edit social comment", {
        commentId: ID_STRING,
        content: ID_STRING,
        mentions: { type: "array", items: ID_STRING },
    }],
    ["social_remove_repost", "Remove social repost", {
        originalPostId: ID_STRING,
        repostId: ID_STRING,
    }],
    ["social_follow_profile", "Follow profile", { targetOwner: ID_STRING }],
    ["social_unfollow_profile", "Unfollow profile", { targetOwner: ID_STRING }],
    ["social_block_profile", "Block profile", { targetOwner: ID_STRING }],
    ["social_unblock_profile", "Unblock profile", { targetOwner: ID_STRING }],
    ["messaging_send_message", "Send encrypted message", {
        groupId: ID_STRING,
        messageLogId: ID_STRING,
        recipient: ID_STRING,
        contentDigestHex: ID_STRING,
        contentUri: ID_STRING,
        dedupeKey: ID_STRING,
        nonce: ID_STRING,
    }],
].map(([name, title, actionProperties]) => {
    const properties = { ...(actionProperties as Record<string, object>), idempotencyKey: ID_KEY };
    return {
        name: name as string,
        description: `${title as string} through the capability-authorized production registry.`,
        inputSchema: {
            type: "object" as const,
            properties,
            required: [...Object.keys(actionProperties as object).filter((key) =>
                !["mediaUrls", "mentions", "metadataJson"].includes(key)), "idempotencyKey"],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations(title as string, {
            readOnly: false,
            destructive: false,
            idempotent: true,
        }),
    };
});

interface OwnerApprovalToolDefinition {
    toolName: string;
    title: string;
    registryAction: (typeof SOCIAL_ACTION_IDS)[number];
    properties: Record<string, object>;
    required: string[];
    signerAddress?: boolean;
    destructive?: boolean;
    details?: string;
}

const SUBSCRIPTION_TOOL_COPY = {
    "subscription.subscribe_to_plan.v1":{title:"Subscribe to a profile plan",details:"Use the named plan quote. Commits the first period and the explicit prepaid renewal count in that plan's coin type."},
    "subscription.renew_subscription.v1":{title:"Renew a profile subscription",details:"Use subscription_get_renewal_quote. Adds one period while retaining the subscription's original access tier and platform."},
    "subscription.cancel_subscription.v1":{title:"Cancel a profile subscription",details:"Deletes the owned subscription and refunds its unused prepaid balance in its stored coin type."},
    "subscription.enable_auto_renew.v1":{title:"Enable prepaid renewals",details:"Allows the existing prepaid bag to fund future renewals at the native live-plan terms. Adds no new wallet funding or per-period price guard."},
    "subscription.disable_auto_renew.v1":{title:"Pause prepaid renewals",details:"Stops future prepaid renewals without changing the current expiry or refunding funds. Use cancellation for a refund."},
    "subscription.change_service_payment_recipient.v1":{title:"Change subscription payout destination",details:"Changes where future subscription payments and renewals are sent. Existing subscribers switch automatically. Past transfers and prepaid balances are unchanged; the profile owner remains the service administrator."},
} as const;

const OWNER_APPROVAL_TOOL_DEFINITIONS: readonly OwnerApprovalToolDefinition[] = [
    {toolName:"account_admin_propose_owner_rotation",title:"Propose a two-wallet owner migration",details:"Requests the current owner's signature for a migration proposal. First read both owner-rotation manifest pages until complete and submit the exact unique agent and organization IDs; the server and Move recheck the live complete manifest. The recipient must differ from the current owner. This only requests approval; the current owner must sign and submit the prepared transaction.",registryAction:"account.rotate_owner_key.v1",properties:{stage:{const:"propose"},profileId:ID_STRING,newOwner:ID_STRING,agentObjectIds:{type:"array",maxItems:512,items:ID_STRING},organizationObjectIds:{type:"array",maxItems:512,items:ID_STRING}},required:["stage","profileId","newOwner","agentObjectIds","organizationObjectIds"],destructive:true},
    {toolName:"account_admin_accept_owner_rotation_batch",title:"Accept an owner migration batch",details:"Requests the new owner's signature to update up to six explicitly selected registered agent/organization references from the pending immutable manifest. Read live status and progress first; only submit currently pending manifest IDs. Set finalize=true only for the last batch or an empty finalization after all references are updated. This approval must be signed by the proposed new owner wallet.",registryAction:"account.rotate_owner_key.v1",properties:{stage:{const:"accept"},profileId:ID_STRING,newOwner:ID_STRING,agentObjectIds:{type:"array",maxItems:6,items:ID_STRING},organizationObjectIds:{type:"array",maxItems:6,items:ID_STRING},finalize:{type:"boolean"}},required:["stage","profileId","newOwner","agentObjectIds","organizationObjectIds","finalize","signerAddress"],signerAddress:true,destructive:true},
    {toolName:"account_admin_rollback_owner_rotation_batch",title:"Roll back an owner migration batch",details:"Requests an authorized migration party's signature to roll back one to six references that were already updated in the pending migration. Read live progress first and submit only IDs confirmed as updated. The signerAddress must be the old or proposed new owner wallet; this request does not execute the rollback.",registryAction:"account.rotate_owner_key.v1",properties:{stage:{const:"rollback"},newOwner:ID_STRING,agentObjectIds:{type:"array",maxItems:6,items:ID_STRING},organizationObjectIds:{type:"array",maxItems:6,items:ID_STRING}},required:["stage","newOwner","agentObjectIds","organizationObjectIds","signerAddress"],signerAddress:true,destructive:true},
    {toolName:"account_admin_cancel_owner_rotation",title:"Cancel an unstarted owner migration",details:"Requests the current owner's signature to cancel a pending migration only after no references have been updated. If any reference changed, roll back those exact references first. This request does not execute the cancellation.",registryAction:"account.rotate_owner_key.v1",properties:{stage:{const:"cancel"}},required:["stage"],destructive:true},
    {toolName:"payments_send_token",title:"Send an exact amount of tokens",details:"Use payments_get_transfer_quote. Splits exactly amountBaseUnits from the approving wallet coin and sends a new coin to the named recipient. Requires owner approval and does not grant an agent a wallet allowance.",registryAction:"payments.send_token.v1",properties:{paymentCoinId:ID_STRING,recipient:ID_STRING,coinType:{type:"string",minLength:1,maxLength:512},amountBaseUnits:DECIMAL_STRING},required:["paymentCoinId","recipient","coinType","amountBaseUnits"],destructive:true},
    {toolName:"governance_vote",title:"Cast a community governance vote",details:"Requests an exact owner-wallet vote on one proposal. The native registry validates proposal phase, voter profile, vote count and quadratic payment cost; the supplied MYSO coin remains under owner-wallet control and requires owner signature.",registryAction:"governance.vote.v1",properties:{registryId:ID_STRING,proposalId:ID_STRING,paymentCoinId:ID_STRING,voteCount:DECIMAL_STRING,approve:{type:"boolean"}},required:["registryId","proposalId","paymentCoinId","voteCount","approve"],destructive:true},
    {toolName:"governance_delegate_vote",title:"Request an owner-approved delegate-council vote",details:"Submits an exact owner-wallet approval request for the authenticated owner to vote as a registered governance delegate. Choose ecosystem for ecosystem/creator-governance registries or platform for the linked platform registry. Core enforces delegate membership, review phase, duplicate voting, jury jurisdiction and treasury route; rejection may forfeit the proposal reward pool under the native route.",registryAction:"governance.delegate_vote.v1",properties:{registryId:ID_STRING,proposalId:ID_STRING,route:{type:"string",enum:["ecosystem","platform"]},approve:{type:"boolean"},reason:{type:"string",maxLength:1000}},required:["registryId","proposalId","route","approve"],destructive:true},
    {toolName:"assets_transfer_object",title:"Request owner approval to transfer an object",details:"Creates an exact-input owner approval request for one directly owner-held chain object and one recipient. Shared, immutable and object-owned items are rejected. The owner must sign; the receipt verifies the historical object-change record.",registryAction:"assets.transfer_object.v1",properties:{objectId:ID_STRING,recipient:ID_STRING,objectType:{type:"string",minLength:1,maxLength:512}},required:["objectId","recipient","objectType"],destructive:true},
    {toolName:"assets_burn_object",title:"Request owner approval to burn an empty coin object",details:"Requests destruction of exactly one directly owner-held framework Coin<T> whose live on-chain balance is zero. Nonzero coins and all non-Coin objects are rejected. Requires the owner wallet signature and an exact finalized deletion receipt.",registryAction:"assets.burn_object.v1",properties:{coinObjectId:ID_STRING,coinType:{type:"string",minLength:1,maxLength:512}},required:["coinObjectId","coinType"],destructive:true},
    {toolName:"organization_grant_treasury_access",title:"Grant or revoke organization treasury access",details:"Requests an exact action signed by the organization owner or a live permission-group administrator. The server verifies the selected signer against the canonical organization group, and Move rechecks administrator authority when executed.",registryAction:"organization.grant_treasury_access.v1",properties:{organizationId:ID_STRING,recipient:ID_STRING,hasAccess:{type:"boolean"}},required:["organizationId","recipient","hasAccess"],destructive:true},
    {toolName:"organization_withdraw_treasury",title:"Withdraw from an organization treasury",details:"Requests an exact withdrawal signed by the organization owner or a live permission-group administrator. The server checks the current treasury balance and signer role; Move rechecks the balance, administrator role and that the signing admin is explicitly allowlisted. No agent automatic-spend cap is used.",registryAction:"organization.withdraw_treasury.v1",properties:{organizationId:ID_STRING,recipient:ID_STRING,amountBaseUnits:DECIMAL_STRING,coinType:{type:"string",minLength:1,maxLength:512}},required:["organizationId","recipient","amountBaseUnits","coinType"],destructive:true},
    {toolName:"organization_fund_treasury",title:"Fund an organization treasury",details:"Requests an exact owner-wallet deposit from one directly owned coin object. The server checks the coin type, owner and live balance before the owner signs; the Move entry records the exact contribution and updated treasury balance.",registryAction:"organization.fund_treasury.v1",properties:{organizationId:ID_STRING,paymentCoinId:ID_STRING,amountBaseUnits:DECIMAL_STRING,coinType:{type:"string",minLength:1,maxLength:512}},required:["organizationId","paymentCoinId","amountBaseUnits","coinType"],destructive:true},
    {toolName:"platform_transfer_developer",title:"Transfer platform developer control",details:"Requests an exact owner-wallet transaction using a directly owned PlatformAdminCap. The shared platform remains in place; only its developer wallet changes. Review the new wallet carefully before signing.",registryAction:"platform.transfer_platform.v1",properties:{platformId:ID_STRING,platformAdminCapId:ID_STRING,newDeveloper:ID_STRING},required:["platformId","platformAdminCapId","newDeveloper"],destructive:true},
    {toolName:"platform_update_fee_recipient",title:"Change future task fee recipient",details:"Requests a PlatformAdminCap-authorized update of the task market's ecosystem fee recipient. New task offers use the new recipient; already-created tasks keep their snapshotted recipient and terms.",registryAction:"platform.update_fee_recipient.v1",properties:{platformAdminCapId:ID_STRING,newRecipient:ID_STRING},required:["platformAdminCapId","newRecipient"],destructive:true},
    {toolName:"payments_tip_post",title:"Tip a MySo post",details:"Requires owner-wallet approval. Choose simple mode only when current post revenue terms do not require escrow. Beneficiary-vault mode must use the creator's current vault and an approved minimum deposit. The Move contract checks that tips are enabled, the caller is not the creator, the post is eligible and the MemoryAccount spend limit is respected.",registryAction:"payments.tip_post.v1",properties:{postId:ID_STRING,paymentCoinId:ID_STRING,coinType:{type:"string",minLength:1,maxLength:512},amountBaseUnits:DECIMAL_STRING,mode:{type:"string",minLength:1},beneficiaryVaultId:ID_STRING,minVaultDepositAmount:DECIMAL_STRING},required:["postId","paymentCoinId","coinType","amountBaseUnits","mode"],destructive:true},
    {toolName:"poc_claim_creator_vault",title:"Claim creator vault revenue",details:"Requests an exact owner-wallet transaction to claim the entire balance for one coin type from a PoC beneficiary vault. The service checks that the vault type and beneficiary match the authenticated owner; the native contract rechecks ownership, applies the configured treasury fee, and returns the net coin to that beneficiary. No referrer is included. This drains that coin-type balance and requires owner signature.",registryAction:"poc.claim_creator_vault.v1",properties:{vaultId:ID_STRING,coinType:{type:"string",minLength:1,maxLength:512}},required:["vaultId","coinType"],destructive:true},
    {toolName:"poc_accept_beneficiary_transfer",title:"Accept a verified beneficiary transfer",details:"Requests an exact owner-wallet transaction for the proposed recipient to accept the identity-verified transfer of one active, unclaimed creator beneficiary. The proposal recipient must be this signing wallet; the contract checks that match and prevents a claim until acceptance. Review the proposed beneficiary and transfer details before signing.",registryAction:"poc.accept_beneficiary_transfer.v1",properties:{beneficiaryId:ID_STRING},required:["beneficiaryId"],destructive:true},
    {toolName:"spot_claim_payout",title:"Claim a resolved spot payout",details:"Requests an exact owner-wallet transaction to claim the authenticated owner's pending payout from a resolved market. The service checks the market, its post, the pending amount and owner; the native contract rechecks eligibility and transfers the payout. Requires owner signature.",registryAction:"spot.claim_payout.v1",properties:{marketId:ID_STRING,postId:ID_STRING},required:["marketId","postId"],destructive:true},
    {toolName:"spot_place_bet",title:"Place a spot market bet",details:"Requests an exact owner-wallet transaction to place one MYSO bet on an open market linked to a completed post analysis. The amount, option, market, post and funding coin are fixed before approval; the service checks coin ownership and available balance, and the native contract checks market eligibility. Requires owner signature.",registryAction:"spot.place_bet.v1",properties:{marketId:ID_STRING,postId:ID_STRING,paymentCoinId:ID_STRING,amountBaseUnits:DECIMAL_STRING,optionId:{type:"integer",minimum:0,maximum:255},referrerPostId:ID_STRING},required:["marketId","postId","paymentCoinId","amountBaseUnits","optionId"],destructive:true},
    {toolName:"spot_create_market",title:"Create a spot market",details:"Requests an owner-wallet transaction to create and finalize a spot market for one post. Requires the approving wallet to own a SpotOracleAdminCap and fixes the claim, market and resolution hashes, betting options and resolution time before approval. The deployed native contract rechecks uniqueness, limits and post state.",registryAction:"spot.create_market.v1",properties:{postId:ID_STRING,spotOracleAdminCapId:ID_STRING,semanticClaimHashHex:{type:"string",pattern:"^0x[0-9a-fA-F]{64}$"},marketKeyHashHex:{type:"string",pattern:"^0x[0-9a-fA-F]{64}$"},resolutionPolicyHashHex:{type:"string",pattern:"^0x[0-9a-fA-F]{64}$"},bettingOptions:{type:"array",minItems:2,maxItems:16,items:{type:"string",minLength:1,maxLength:128}},resolutionAtMs:DECIMAL_STRING,maxResolutionWindowMs:DECIMAL_STRING},required:["postId","spotOracleAdminCapId","semanticClaimHashHex","marketKeyHashHex","resolutionPolicyHashHex","bettingOptions","resolutionAtMs"],destructive:true},
    {toolName:"social_delete_post",title:"Request owner approval to delete a post",details:"This request does not delete the post. The account owner must sign the exact-input approval before the transaction can be prepared and submitted. The Move contract requires the signing address to own the post.",registryAction:"social.delete_post.v1",properties:{postId:ID_STRING},required:["postId"],destructive:true},
    {toolName:"social_delete_comment",title:"Request owner approval to delete a comment",details:"This request does not delete the comment. The account owner must sign the exact-input approval before the transaction can be prepared and submitted. The Move contract requires the signing address to own the comment and validates its parent post.",registryAction:"social.delete_comment.v1",properties:{postId:ID_STRING,commentId:ID_STRING},required:["postId","commentId"],destructive:true},
    ...PROFILE_SUBSCRIPTION_ACTION_IDS.map((id):OwnerApprovalToolDefinition=>{const descriptor=getSocialActionDescriptor(id);return {toolName:id.replace(/\.v1$/,"").replaceAll(".","_"),title:SUBSCRIPTION_TOOL_COPY[id].title,details:SUBSCRIPTION_TOOL_COPY[id].details,registryAction:id,properties:JSON.parse(JSON.stringify(descriptor.inputSchema.properties)),required:[...descriptor.inputSchema.required],destructive:id!=="subscription.subscribe_to_plan.v1"};}),
    {toolName:"subscription_change_service_payment_recipient",title:SUBSCRIPTION_TOOL_COPY["subscription.change_service_payment_recipient.v1"].title,details:SUBSCRIPTION_TOOL_COPY["subscription.change_service_payment_recipient.v1"].details,registryAction:"subscription.change_service_payment_recipient.v1",properties:JSON.parse(JSON.stringify(getSocialActionDescriptor("subscription.change_service_payment_recipient.v1").inputSchema.properties)),required:[...getSocialActionDescriptor("subscription.change_service_payment_recipient.v1").inputSchema.required],destructive:true},
    {toolName:"access_share_mydata",title:"Grant access to your own MyData listing",registryAction:"access.share_mydata.v1",properties:{mydataId:ID_STRING,recipient:ID_STRING,accessType:{type:"integer",enum:[0,1]},subscriptionDays:DECIMAL_STRING},required:["mydataId","recipient","accessType"]},
    {toolName:"access_revoke_mydata_share",title:"Revoke access to your own MyData listing",registryAction:"access.revoke_mydata_share.v1",properties:{mydataId:ID_STRING,recipient:ID_STRING,accessType:{type:"integer",enum:[0,1,2]}},required:["mydataId","recipient","accessType"],destructive:true},
    {
        toolName: "organization_create",
        title: "Create organization",
        registryAction: "organization.create.v1",
        properties: { orgType: ORG_TYPE_INTEGER, name: { type: "string" }, description: { type: "string" } },
        required: ["orgType"],
    },
    {
        toolName: "organization_update_metadata",
        title: "Update organization metadata",
        registryAction: "organization.update_metadata.v1",
        properties: { organizationId: ID_STRING, name: { type: "string" }, description: { type: "string" } },
        required: ["organizationId"],
    },
    {
        toolName: "organization_update_category",
        title: "Update organization category",
        registryAction: "organization.update_category.v1",
        properties: { organizationId: ID_STRING, orgType: ORG_TYPE_INTEGER },
        required: ["organizationId", "orgType"],
    },
    {
        toolName: "organization_deactivate",
        title: "Deactivate organization",
        registryAction: "organization.deactivate.v1",
        properties: { organizationId: ID_STRING },
        required: ["organizationId"],
        destructive: true,
    },
    {
        toolName: "organization_ensure_memory_group",
        title: "Create organization memory group",
        registryAction: "organization.ensure_memory_group.v1",
        properties: { organizationId: ID_STRING },
        required: ["organizationId"],
    },
    {
        toolName: "organization_define_role",
        title: "Define organization role",
        registryAction: "organization.define_role.v1",
        properties: {
            organizationId: ID_STRING,
            orgMemoryGroupId: ID_STRING,
            roleName: ID_STRING,
            permissionsMask: DECIMAL_STRING,
        },
        required: ["organizationId", "roleName", "permissionsMask"],
    },
    {
        toolName: "organization_assign_role",
        title: "Assign organization role",
        registryAction: "organization.assign_role.v1",
        properties: {
            organizationId: ID_STRING,
            orgMemoryGroupId: ID_STRING,
            memberAddress: ID_STRING,
            roleName: ID_STRING,
        },
        required: ["organizationId", "memberAddress", "roleName"],
    },
    {
        toolName: "organization_revoke_role",
        title: "Revoke organization role",
        registryAction: "organization.revoke_role.v1",
        properties: {
            organizationId: ID_STRING,
            orgMemoryGroupId: ID_STRING,
            memberAddress: ID_STRING,
            roleName: ID_STRING,
        },
        required: ["organizationId", "memberAddress", "roleName"],
        destructive: true,
    },
    {
        toolName: "organization_create_invitation",
        title: "Create organization invitation",
        registryAction: "organization.create_invitation.v1",
        properties: {
            organizationId: ID_STRING,
            orgMemoryGroupId: ID_STRING,
            invitee: ID_STRING,
            roleName: { type: "string" },
            permissionsMask: DECIMAL_STRING,
            expiresAtMs: DECIMAL_STRING,
        },
        required: ["organizationId", "invitee", "permissionsMask"],
    },
    {
        toolName: "agent_register_root",
        title: "Register organization root agent",
        registryAction: "agent.register_agent.v1",
        properties: { organizationId: ID_STRING, ...AGENT_POLICY_TOOL_PROPERTIES },
        required: ["organizationId", "publicKeyHex", "derivedAddress", "label"],
    },
    {
        toolName: "agent_admin_request_revoke",
        title: "Request owner approval to revoke an agent",
        details: "Pins the target object, derived address and platform scope. The target is irreversibly removed on chain after the owner signs the approval and submits the prepared transaction.",
        registryAction: "agent.revoke_agent.v1",
        properties: { agentObjectId: ID_STRING, expectedDerivedAddress: ID_STRING, expectedPlatformScope: { type: "string", minLength: 1, maxLength: 80 } },
        required: ["agentObjectId", "expectedDerivedAddress", "expectedPlatformScope"],
        destructive: true,
    },
    {
        toolName: "agent_admin_request_grant_capability",
        title: "Request owner approval to grant agent capabilities",
        details: "Uses an exact expected capability bitmap and mask. The server and native entry point recheck that the policy changed as quoted.",
        registryAction: "agent.grant_capability.v1",
        properties: { agentObjectId: ID_STRING, expectedDerivedAddress: ID_STRING, expectedPlatformScope: { type: "string", minLength: 1, maxLength: 80 }, expectedCapabilities: DECIMAL_STRING, capabilityMask: DECIMAL_STRING },
        required: ["agentObjectId", "expectedDerivedAddress", "expectedPlatformScope", "expectedCapabilities", "capabilityMask"],
    },
    {
        toolName: "agent_admin_request_revoke_capability",
        title: "Request owner approval to remove agent capabilities",
        details: "Uses an exact expected capability bitmap and mask. The server and native entry point recheck that the policy changed as quoted.",
        registryAction: "agent.revoke_capability.v1",
        properties: { agentObjectId: ID_STRING, expectedDerivedAddress: ID_STRING, expectedPlatformScope: { type: "string", minLength: 1, maxLength: 80 }, expectedCapabilities: DECIMAL_STRING, capabilityMask: DECIMAL_STRING },
        required: ["agentObjectId", "expectedDerivedAddress", "expectedPlatformScope", "expectedCapabilities", "capabilityMask"],
    },
    {
        toolName: "agent_admin_request_raise_spending_limit",
        title: "Request owner approval to raise an agent spending limit",
        details: "Pins the current finite per-action ceiling and the requested higher ceiling. `unlimited` is accepted only as an explicit next ceiling and still requires an owner signature.",
        registryAction: "agent.raise_spending_limit.v1",
        properties: { agentObjectId: ID_STRING, expectedDerivedAddress: ID_STRING, expectedPlatformScope: { type: "string", minLength: 1, maxLength: 80 }, expectedLimitMist: DECIMAL_STRING, newLimitMist: { anyOf: [DECIMAL_STRING, { type: "string", const: "unlimited" }] } },
        required: ["agentObjectId", "expectedDerivedAddress", "expectedPlatformScope", "expectedLimitMist", "newLimitMist"],
    },
    {
        toolName: "agent_admin_request_lower_spending_limit",
        title: "Request owner approval to lower an agent spending limit",
        details: "Pins the exact current per-action ceiling, including unlimited, and requires the new finite ceiling to be lower. The owner signs the exact policy change.",
        registryAction: "agent.lower_spending_limit.v1",
        properties: { agentObjectId: ID_STRING, expectedDerivedAddress: ID_STRING, expectedPlatformScope: { type: "string", minLength: 1, maxLength: 80 }, expectedLimitMist: { anyOf: [DECIMAL_STRING, { type: "string", const: "unlimited" }] }, newLimitMist: DECIMAL_STRING },
        required: ["agentObjectId", "expectedDerivedAddress", "expectedPlatformScope", "expectedLimitMist", "newLimitMist"],
    },
] as const;

const OWNER_APPROVAL_ACTION_BY_TOOL = new Map(
    OWNER_APPROVAL_TOOL_DEFINITIONS.map((definition) => [definition.toolName, definition]),
);

const OWNER_APPROVAL_TOOLS: Tool[] = OWNER_APPROVAL_TOOL_DEFINITIONS.map((definition) => ({
    name: definition.toolName,
    description: `${definition.title}. ${definition.details??""} Returns an exact-input approval intent for the account owner or, for organization treasury administration, the selected authorized organization signer.`,
    inputSchema: {
        type: "object",
        properties: {
            ...definition.properties,
            ...(definition.registryAction === "organization.grant_treasury_access.v1" || definition.registryAction === "organization.withdraw_treasury.v1"
                ? { signerAddress: ID_STRING }
                : {}),
            ...(definition.signerAddress ? { signerAddress: ID_STRING } : {}),
            idempotencyKey: ID_KEY,
            expiresInSeconds: { type: "integer", minimum: 60, maximum: 900 },
        },
        required: [...definition.required, "idempotencyKey"],
        additionalProperties: false,
    },
    outputSchema: OUTPUT_SCHEMA,
    annotations: annotations(definition.title, {
        readOnly: false,
        destructive: definition.destructive ?? false,
        idempotent: true,
    }),
}));

const ORGANIZATION_AND_MESSAGING_TOOLS: Tool[] = [
    {
        name: "organization_get_control",
        description: "Read the indexed organization, agents, roles, assignments, invitations, and messaging groups for the authenticated principal.",
        inputSchema: {
            type: "object",
            properties: { organizationId: ID_STRING },
            required: ["organizationId"],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Read organization control state", {
            readOnly: true, destructive: false, idempotent: true,
        }),
    },
    {
        name: "agent_provision_signer",
        description: "Generate a new agent Ed25519 signer in the configured Keychain or KMS without returning private key material.",
        inputSchema: {
            type: "object",
            properties: { label: { type: "string", minLength: 1, maxLength: 64 } },
            required: ["label"],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Provision agent signer", {
            readOnly: false, destructive: false, idempotent: false,
        }),
    },
    {
        name: "messaging_create_group",
        description: "Create an encrypted messaging group for the authenticated agent and human or agent peers.",
        inputSchema: {
            type: "object",
            properties: {
                name: ID_STRING,
                uuid: ID_STRING,
                encryptedDekHex: ID_STRING,
                initialMembers: { type: "array", items: ID_STRING, minItems: 1, maxItems: 32 },
                crossPrincipalPeerAccountId: ID_STRING,
                roomKind: { type: "integer", enum: [1], description: "Set to 1 to create an agent room." },
                roomTaskId: { ...ID_STRING, description: "Task object ID for this agent room; requires roomKind 1." },
                idempotencyKey: ID_KEY,
            },
            required: ["name", "uuid", "encryptedDekHex", "initialMembers", "idempotencyKey"],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Create messaging group", {
            readOnly: false, destructive: false, idempotent: true,
        }),
    },
    {
        name: "messaging_bind_room_to_task",
        description: "Bind an existing agent room to a task that already names that exact room. The authenticated task party must have room metadata permission, and both task principals must be room readers.",
        inputSchema: {
            type: "object",
            properties: {
                groupId: ID_STRING,
                taskId: ID_STRING,
                idempotencyKey: ID_KEY,
            },
            required: ["groupId", "taskId", "idempotencyKey"],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Bind room to task", {
            readOnly: false, destructive: false, idempotent: true,
        }),
    },
    {
        name: "messaging_list_inbox",
        description: "List incoming encrypted message pointers for the authenticated agent.",
        inputSchema: {
            type: "object",
            properties: {
                limit: { type: "integer", minimum: 1, maximum: 100 },
                offset: { type: "integer", minimum: 0 },
                groupId: ID_STRING,
                afterCreatedAtMs: { type: "integer", minimum: 0 },
                afterSeq: { type: "integer", minimum: 0 },
            },
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("List agent inbox", {
            readOnly: true, destructive: false, idempotent: true,
        }),
    },
    {
        name: "messaging_list_rooms",
        description: "List rooms indexed for the authenticated agent as a member. The relayer index supplies a bounded page; each room must pass live fullnode MessagingReader checks before and after fresh fullnode metadata is read. Results include canonical on-chain name, UUID and creator when available, plus a stable afterGroupId cursor for continuing across membership changes; nextAfterGroupId is based on the raw index page so permission-filtered rows do not cause skips. Offset remains available for compatibility. The index can lag recent membership changes; room content still requires a separate history read and explicit owner consent before hosted inference.",
        inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 100 }, offset: { type: "integer", minimum: 0 }, afterGroupId: ID_STRING }, not: { required: ["offset", "afterGroupId"] }, additionalProperties: false },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("List agent rooms", { readOnly: true, destructive: false, idempotent: true }),
    },
    {
        name: "messaging_get_room_history",
        description: "Read one bounded page of encrypted room history through the authenticated agent MessagingReader session. The SDK checks live room permission and verifies each ciphertext signature before decrypting. Verified messages include text, v2-signed agent attribution when present, and attachment metadata/storage handles only when both the attachment references and encrypted metadata verify; unverified legacy attachments never receive verified handles. Attachment bytes remain encrypted in private Cloudflare R2, and the separate download tool returns ciphertext only. Calling this tool discloses verified text and metadata to this MCP caller/model. Room IDs, ordering, system/deletion state and pagination remain relayer metadata; this is not a complete-history, room-role, or task-truth proof. MySo Agents requires explicit consent for interactive turns and an automation-specific consent for unattended runs before admitting room history.",
        inputSchema: {
            type: "object",
            properties: {
                groupId: ID_STRING,
                encryptionHistoryId: ID_STRING,
                uuid: { type: "string", minLength: 1, maxLength: 128 },
                afterOrder: { type: "integer", minimum: 0, maximum: 9007199254740991 },
                beforeOrder: { type: "integer", minimum: 0, maximum: 9007199254740991 },
                limit: { type: "integer", minimum: 1, maximum: 50 },
            },
            oneOf: [
                { required: ["uuid"] },
                { required: ["groupId", "encryptionHistoryId"] },
            ],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Read verified encrypted room history", {
            readOnly: true, destructive: false, idempotent: true,
        }),
    },
    {
        name: "messaging_get_room_attachment",
        description: "Decrypt one explicitly selected room attachment through the authenticated agent session. The exact message must be undeleted and sender-signature verified, the attachment reference and encrypted metadata must be v2-signature verified, and live fullnode MessagingReader permission is checked before download and again after decryption. The caller must first read verified room history and supply the exact storageId from that message. Plaintext is limited to 5 MiB and returned as base64 with its SHA-256 digest. This discloses private attachment plaintext to this MCP caller/model; MySo Agents requires explicit per-run room-content consent for interactive and unattended runs.",
        inputSchema: {
            type: "object",
            properties: { groupId: ID_STRING, encryptionHistoryId: ID_STRING, uuid: { type: "string", minLength: 1, maxLength: 128 }, messageId: { type: "string", minLength: 1, maxLength: 256 }, storageId: { type: "string", minLength: 1, maxLength: 512 } },
            required: ["messageId", "storageId"],
            oneOf: [{ required: ["uuid"] }, { required: ["groupId", "encryptionHistoryId"] }],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Decrypt verified room attachment", { readOnly: true, destructive: false, idempotent: true }),
    },
    {
        name: "messaging_send_room_message",
        description: "Send text and/or files to a MySo room using the authenticated agent signer. Text and each file are encrypted locally with the current room key before transmission; encrypted file bytes are stored in private Cloudflare R2 through the authenticated Memory service. New messages with attachments use signature v2, which binds the ordered attachment storage references, encryption nonces, and encrypted metadata; readback requires verified sender and attachment signatures. Legacy v1 messages with attachments remain text-verifiable but their attachments are not downloaded or presented as verified. Live fullnode MessagingSender permission is checked before sending and after readback. Supply a new UUID v4 idempotencyKey per message and reuse it only to reconcile a lost response.",
        inputSchema: {
            type: "object",
            properties: {
                groupId: ID_STRING,
                encryptionHistoryId: ID_STRING,
                uuid: { type: "string", minLength: 1, maxLength: 128 },
                text: { type: "string", maxLength: 65536 },
                files: { type: "array", minItems: 1, maxItems: 10, items: { type: "object", properties: { fileName: { type: "string", minLength: 1, maxLength: 255 }, mimeType: { type: "string", minLength: 1, maxLength: 128 }, contentBase64: { type: "string", minLength: 4, maxLength: 6990488, pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$" } }, required: ["fileName", "mimeType", "contentBase64"], additionalProperties: false } },
                idempotencyKey: { type: "string", format: "uuid", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$" },
            },
            required: ["idempotencyKey"],
            anyOf: [{ required: ["text"] }, { required: ["files"] }],
            oneOf: [
                { required: ["uuid"] },
                { required: ["groupId", "encryptionHistoryId"] },
            ],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Send encrypted room message", { readOnly: false, destructive: false, idempotent: true }),
    },
    {
        name: "messaging_wait_for_message",
        description: "Wait up to 20 seconds for a new incoming encrypted message pointer; use repeatedly for an agent response loop.",
        inputSchema: {
            type: "object",
            properties: {
                timeoutMs: { type: "integer", minimum: 250, maximum: 20000 },
                groupId: ID_STRING,
                afterCreatedAtMs: { type: "integer", minimum: 0 },
                afterSeq: { type: "integer", minimum: 0 },
            },
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Wait for agent message", {
            readOnly: true, destructive: false, idempotent: true,
        }),
    },
    {
        name: "messaging_list_reactions",
        description: "List bounded reaction state for one message in a room. The authenticated agent must have live MessagingReader permission; reaction state is relayer metadata, not chain evidence.",
        inputSchema: {
            type: "object",
            properties: { groupId: ID_STRING, encryptionHistoryId: ID_STRING, uuid: { type: "string", minLength: 1, maxLength: 128 }, order: { type: "integer", minimum: 0, maximum: 9007199254740991 } },
            required: ["order"],
            oneOf: [{ required: ["uuid"] }, { required: ["groupId", "encryptionHistoryId"] }],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("List message reactions", { readOnly: true, destructive: false, idempotent: true }),
    },
    ...["messaging_add_reaction", "messaging_remove_reaction"].map((name) => ({
        name,
        description: `${name === "messaging_add_reaction" ? "Add" : "Remove"} the authenticated agent's reaction on one room message. Live MessagingSender permission is checked before the relayer operation. The result includes a caller-bound readback receipt confirming the requested reaction state; this is relayer metadata, not chain evidence.`,
        inputSchema: {
            type: "object" as const,
            properties: { groupId: ID_STRING, encryptionHistoryId: ID_STRING, uuid: { type: "string", minLength: 1, maxLength: 128 }, order: { type: "integer", minimum: 0, maximum: 9007199254740991 }, emoji: { type: "string", minLength: 1, maxLength: 32 } },
            required: ["order", "emoji"],
            oneOf: [{ required: ["uuid"] }, { required: ["groupId", "encryptionHistoryId"] }],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations(name === "messaging_add_reaction" ? "Add message reaction" : "Remove message reaction", { readOnly: false, destructive: false, idempotent: true }),
    })),
    {
        name: "messaging_get_room_receipts",
        description: "Read peer-visible delivery/read watermarks for a room. Requires live MessagingReader permission; receipts are relayer metadata.",
        inputSchema: { type: "object", properties: { groupId: ID_STRING, encryptionHistoryId: ID_STRING, uuid: { type: "string", minLength: 1, maxLength: 128 } }, oneOf: [{ required: ["uuid"] }, { required: ["groupId", "encryptionHistoryId"] }], additionalProperties: false },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Get room read receipts", { readOnly: true, destructive: false, idempotent: true }),
    },
    {
        name: "messaging_update_room_receipts",
        description: "Advance the authenticated agent's delivery/read watermark for a room. Watermarks are monotonic, peer-visible relayer metadata and require live MessagingReader permission.",
        inputSchema: {
            type: "object",
            properties: { groupId: ID_STRING, encryptionHistoryId: ID_STRING, uuid: { type: "string", minLength: 1, maxLength: 128 }, deliveredUpto: { type: "integer", minimum: 0, maximum: 9007199254740991 }, readUpto: { type: "integer", minimum: 0, maximum: 9007199254740991 } },
            oneOf: [{ required: ["uuid"] }, { required: ["groupId", "encryptionHistoryId"] }],
            anyOf: [{ required: ["deliveredUpto"] }, { required: ["readUpto"] }],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Update room read receipts", { readOnly: false, destructive: false, idempotent: true }),
    },
    {
        name: "messaging_edit_message",
        description: "Edit one message authored by the authenticated agent. The SDK requires live MessagingSender permission, verifies the current sender signature and owner address, encrypts and signs the replacement text, then refetches and verifies the updated message. Existing attachments are preserved. The result is relayer evidence, not an on-chain receipt.",
        inputSchema: {
            type: "object",
            properties: { groupId: ID_STRING, encryptionHistoryId: ID_STRING, uuid: { type: "string", minLength: 1, maxLength: 128 }, messageId: { type: "string", minLength: 1, maxLength: 256 }, text: { type: "string", minLength: 1, maxLength: 8000 } },
            required: ["messageId", "text"],
            oneOf: [{ required: ["uuid"] }, { required: ["groupId", "encryptionHistoryId"] }],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Edit own room message", { readOnly: false, destructive: false, idempotent: false }),
    },
    {
        name: "messaging_delete_message",
        description: "Soft-delete one message authored by the authenticated agent. Requires live MessagingSender permission and a verified current sender signature; the SDK refetches the matching sender-owned tombstone before reporting success. This does not erase ciphertext already copied or stored by other room members.",
        inputSchema: {
            type: "object",
            properties: { groupId: ID_STRING, encryptionHistoryId: ID_STRING, uuid: { type: "string", minLength: 1, maxLength: 128 }, messageId: { type: "string", minLength: 1, maxLength: 256 } },
            required: ["messageId"],
            oneOf: [{ required: ["uuid"] }, { required: ["groupId", "encryptionHistoryId"] }],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Soft-delete own room message", { readOnly: false, destructive: true, idempotent: false }),
    },
    {
        name: "messaging_remove_members_rotate_key",
        description: "Atomically remove 1–50 current room readers and rotate the room encryption key so they cannot decrypt future messages after rotation. Past access and plaintext already copied or exported cannot be recalled. Requires the authenticated agent to hold live MessagingReader, PermissionsAdmin, and EncryptionKeyRotator permissions. The acting agent cannot remove itself; success is reported only after fullnode membership and key-version checks.",
        inputSchema: { type: "object", properties: { groupId: ID_STRING, encryptionHistoryId: ID_STRING, uuid: { type: "string", minLength: 1, maxLength: 128 }, members: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: { type: "string", pattern: "^(0x)?[0-9a-fA-F]{1,64}$" } } }, required: ["members"], oneOf: [{ required: ["uuid"] }, { required: ["groupId", "encryptionHistoryId"] }], additionalProperties: false },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Remove members and rotate room key", { readOnly: false, destructive: true, idempotent: false }),
    },
    {
        name: "messaging_revoke_member_from_all_rooms",
        description: "Two-step room-member revocation. First call operation=preview to enumerate every room visible through the authenticated agent's membership index where the target currently has MessagingReader. Then call operation=execute with confirmed=true and the exact confirmedGroupIds returned by that preview. The service repeats the complete bounded scan and refuses all writes if the room set changed or any page is incomplete. It then removes the target one room at a time, rotates each room key, and verifies each finalized membership/key-version result. Partial or uncertain results stop the batch and include completed receipts; never blindly repeat an uncertain room. Past messages or copied plaintext cannot be recalled, and the membership index may lag.",
        inputSchema: {
            type: "object",
            properties: {
                operation: { enum: ["preview", "execute"] },
                member: { type: "string", pattern: "^(0x)?[0-9a-fA-F]{1,64}$" },
                confirmed: { const: true },
                confirmedGroupIds: { type: "array", minItems: 0, maxItems: 500, uniqueItems: true, items: ID_STRING },
            },
            required: ["operation", "member"],
            oneOf: [
                { properties: { operation: { const: "preview" } }, not: { anyOf: [{ required: ["confirmed"] }, { required: ["confirmedGroupIds"] }] } },
                { properties: { operation: { const: "execute" } }, required: ["confirmed", "confirmedGroupIds"] },
            ],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Revoke one member from all indexed rooms", { readOnly: false, destructive: true, idempotent: false }),
    },
    {
        name: "messaging_add_room_members",
        description: "Invite 1–50 wallets to one encrypted room by granting MessagingReader and MessagingSender. This gives each new reader access to existing and future messages and attachments; previously decrypted or exported plaintext cannot be recalled. The caller must explicitly set acknowledgeHistoryAccess=true after obtaining room-owner/admin consent. Requires the authenticated agent to hold live MessagingReader and ExtensionPermissionsAdmin on this exact room. The finalized fullnode membership permissions are verified before success is reported.",
        inputSchema: { type: "object", properties: { groupId: ID_STRING, encryptionHistoryId: ID_STRING, uuid: { type: "string", minLength: 1, maxLength: 128 }, members: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: { type: "string", pattern: "^(0x)?[0-9a-fA-F]{1,64}$" } }, acknowledgeHistoryAccess: { const: true } }, required: ["members", "acknowledgeHistoryAccess"], oneOf: [{ required: ["uuid"] }, { required: ["groupId", "encryptionHistoryId"] }], additionalProperties: false },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Invite room members (shares history)", { readOnly: false, destructive: false, idempotent: true }),
    },
    {
        name: "messaging_leave_group",
        description: "Remove the authenticated agent from one room. This stops future access to room messages. The agent must be a current member and must not hold PermissionsAdmin; admins require an authorized administrator removal. Success is reported only after the configured fullnode confirms the agent is no longer a member. This action is excluded from hosted work runs.",
        inputSchema: { type: "object", properties: { groupId: ID_STRING, encryptionHistoryId: ID_STRING, uuid: { type: "string", minLength: 1, maxLength: 128 } }, oneOf: [{ required: ["uuid"] }, { required: ["groupId", "encryptionHistoryId"] }], additionalProperties: false },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Leave encrypted room", { readOnly: false, destructive: true, idempotent: true }),
    },
    {
        name: "messaging_set_room_name",
        description: "Set one room's visible name. Requires live MetadataAdmin permission, and reports success only after the configured fullnode returns the exact updated metadata.",
        inputSchema: { type: "object", properties: { groupId: ID_STRING, encryptionHistoryId: ID_STRING, uuid: { type: "string", minLength: 1, maxLength: 128 }, name: { type: "string", minLength: 1, maxLength: 128 } }, required: ["name"], oneOf: [{ required: ["uuid"] }, { required: ["groupId", "encryptionHistoryId"] }], additionalProperties: false },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Rename room", { readOnly: false, destructive: false, idempotent: true }),
    },
    {
        name: "messaging_archive_group",
        description: "Permanently archive one encrypted room. This pauses the room and permanently consumes the unpause capability, so the action cannot be reversed. Requires live PermissionsAdmin on that exact room and a fresh owner-wallet signature bound to this exact room and agent. Never use this tool in unattended work runs.",
        inputSchema: { type: "object", properties: { groupId: ID_STRING, encryptionHistoryId: ID_STRING, uuid: { type: "string", minLength: 1, maxLength: 128 }, ownerConfirmation: { type: "object", properties: { owner: ID_STRING, agentObjectId: ID_STRING, groupId: ID_STRING, expiresAtMs: { type: "integer", minimum: 0, maximum: 9007199254740991 }, nonce: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" }, signature: { type: "string", minLength: 40, maxLength: 4096 } }, required: ["owner", "agentObjectId", "groupId", "expiresAtMs", "nonce", "signature"], additionalProperties: false } }, required: ["ownerConfirmation"], oneOf: [{ required: ["uuid"] }, { required: ["groupId", "encryptionHistoryId"] }], additionalProperties: false },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Permanently archive room", { readOnly: false, destructive: true, idempotent: false }),
    },
    {
        name: "messaging_get_read_state",
        description: "Read the authenticated agent wallet's encrypted private room read markers. This is personal sync state, distinct from peer-visible room receipts.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Get private read state", { readOnly: true, destructive: false, idempotent: true }),
    },
    {
        name: "messaging_update_read_state",
        description: "Advance the authenticated agent wallet's private encrypted read marker for one room. Requires live MessagingReader permission; does not publish a peer-visible receipt.",
        inputSchema: { type: "object", properties: { groupId: ID_STRING, readUpto: { type: "integer", minimum: 0, maximum: 9007199254740991 } }, required: ["groupId", "readUpto"], additionalProperties: false },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Advance private read marker", { readOnly: false, destructive: false, idempotent: true }),
    },
    {
        name: "messaging_get_unread_counts",
        description: "Read exact unread counts for 1–50 rooms. Requires live MessagingReader permission for every listed room; results are relayer metadata.",
        inputSchema: { type: "object", properties: { groupIds: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: ID_STRING } }, required: ["groupIds"], additionalProperties: false },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Get unread counts", { readOnly: true, destructive: false, idempotent: true }),
    },
    ...[
        ["organization_accept_invitation", "Accept organization invitation"],
        ["organization_decline_invitation", "Decline organization invitation"],
    ].map(([name, title]) => ({
        name,
        description: `${title} addressed to the authenticated agent.`,
        inputSchema: {
            type: "object" as const,
            properties: {
                organizationAccountId: ID_STRING,
                organizationId: ID_STRING,
                orgMemoryGroupId: ID_STRING,
                invitee: ID_STRING,
                idempotencyKey: ID_KEY,
            },
            required: ["organizationAccountId", "organizationId", "invitee", "idempotencyKey"],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations(title, {
            readOnly: false, destructive: name === "organization_decline_invitation", idempotent: true,
        }),
    })),
    {
        name: "agent_register_child",
        description: "Register a bounded child or peer agent beneath the authenticated agent.",
        inputSchema: {
            type: "object",
            properties: {
                registerRelation: U8_INTEGER,
                ...AGENT_POLICY_TOOL_PROPERTIES,
                idempotencyKey: ID_KEY,
            },
            required: ["registerRelation", "publicKeyHex", "derivedAddress", "label", "idempotencyKey"],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Register child agent", {
            readOnly: false, destructive: false, idempotent: true,
        }),
    },
    {
        name: "agent_update_child",
        description: "Update a managed descendant agent within on-chain non-escalation constraints.",
        inputSchema: {
            type: "object",
            properties: {
                agentObjectId: ID_STRING,
                identityClass: U8_INTEGER,
                roleTags: DECIMAL_STRING,
                capabilities: DECIMAL_STRING,
                delegatableCaps: DECIMAL_STRING,
                registerScope: U8_INTEGER,
                approvalRequiredCaps: DECIMAL_STRING,
                maxActionSpendMist: DECIMAL_STRING,
                platformScope: ID_STRING,
                expiresAtMs: DECIMAL_STRING,
                idempotencyKey: ID_KEY,
            },
            required: ["agentObjectId", "identityClass", "roleTags", "capabilities", "delegatableCaps", "registerScope", "approvalRequiredCaps", "idempotencyKey"],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Update child agent", {
            readOnly: false, destructive: false, idempotent: true,
        }),
    },
    ...[
        ["agent_deactivate_child", "Deactivate child agent"],
        ["agent_revoke_child", "Revoke child agent"],
    ].map(([name, title]) => ({
        name,
        description: `${title} within the authenticated agent's on-chain management scope.`,
        inputSchema: {
            type: "object" as const,
            properties: { agentObjectId: ID_STRING, idempotencyKey: ID_KEY },
            required: ["agentObjectId", "idempotencyKey"],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations(title, {
            readOnly: false, destructive: true, idempotent: true,
        }),
    })),
];

const SOCIAL_TOOLS: Tool[] = [
    {
        name: "chain_list_actions",
        description: "List the versioned production action catalog with tier, approval policy, implementation status, blockers, and permissions for this authenticated agent.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("List available blockchain actions", {
            readOnly: true,
            destructive: false,
            idempotent: true,
        }),
    },
    {
        name: "account_configure_multisig",
        description: "Validate public wallet keys and prepare a native MySo multisig descriptor. This does not change chain state or store signer policy; use the returned address in the owner-migration flow, then have the configured wallets sign the recipient transactions.",
        inputSchema: {
            type: "object",
            properties: {
                threshold: { type: "integer", minimum: 1, maximum: 2550 },
                members: {
                    type: "array", minItems: 2, maxItems: 10,
                    items: { type: "object", properties: {
                        address: { type: "string", pattern: "^0x[0-9a-fA-F]{1,64}$" },
                        publicKeyBase64: { type: "string", minLength: 16, maxLength: 128, pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$" },
                        weight: { type: "integer", minimum: 1, maximum: 255 },
                    }, required: ["address", "publicKeyBase64", "weight"], additionalProperties: false },
                },
            },
            required: ["threshold", "members"], additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Prepare native MySo multisig descriptor", {
            readOnly: true, destructive: false, idempotent: true,
        }),
    },
    ...ADDITIONAL_TIER_1_TOOLS,
    ...OWNER_APPROVAL_TOOLS,
    ...ORGANIZATION_AND_MESSAGING_TOOLS,
    {
        name: "chain_request_action_approval",
        description: "Create an exact-input, short-lived owner approval intent for a registered action. This only stores a pending request; it does not build or submit a transaction. Present the exact action and parameters to the owner. The owner must sign the returned approvalIntent with the bound wallet, then call chain_approve_action, chain_prepare_approved_action, review and sign the returned transaction bytes, and call chain_submit_approved_action.",
        inputSchema: {
            type: "object",
            properties: {
                registryAction: { type: "string", enum: [...SOCIAL_ACTION_IDS] },
                parameters: { type: "object" },
                idempotencyKey: { type: "string", minLength: 8, maxLength: 128 },
                expiresInSeconds: { type: "integer", minimum: 60, maximum: 900 },
                signerAddress: ID_STRING,
            },
            required: ["registryAction", "parameters", "idempotencyKey"],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Request owner action approval", {
            readOnly: false, destructive: false, idempotent: true,
        }),
    },
    {
        name: "chain_approve_action",
        description: "Submit the human owner's wallet signature over the exact approvalIntent returned by chain_request_action_approval. The server verifies the signature against the signer bound to that request and current account/organization authority. This records approval only; it does not submit a transaction.",
        inputSchema: {
            type: "object",
            properties: {
                approvalId: { type: "string", minLength: 36, maxLength: 36 },
                walletSignature: { type: "string", minLength: 80, maxLength: 4096 },
            },
            required: ["approvalId", "walletSignature"],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Approve registered action", {
            readOnly: false, destructive: false, idempotent: true,
        }),
    },
    {
        name: "chain_prepare_approved_action",
        description: "Prepare and simulate only the exact action and parameters bound to an approved request. Returns sponsored transaction bytes and digest for the human owner to inspect and sign in their wallet. Preparation does not execute the transaction; submit the matching owner signature with chain_submit_approved_action.",
        inputSchema: {
            type: "object",
            properties: {
                registryAction: { type: "string", enum: [...SOCIAL_ACTION_IDS] },
                parameters: { type: "object" },
                idempotencyKey: { type: "string", minLength: 8, maxLength: 128 },
                approvalId: { type: "string", minLength: 36, maxLength: 36 },
            },
            required: ["registryAction", "parameters", "idempotencyKey", "approvalId"],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Prepare owner-approved action", {
            readOnly: false, destructive: true, idempotent: true,
        }),
    },
    {
        name: "chain_submit_approved_action",
        description: "Submit the human owner's wallet signature for the exact sponsored transaction returned by chain_prepare_approved_action. The server rechecks the approval, idempotency key, action, digest, signer and transaction binding before broadcast; it never accepts an agent signature as owner consent.",
        inputSchema: {
            type: "object",
            properties: {
                registryAction: { type: "string", enum: [...SOCIAL_ACTION_IDS] },
                idempotencyKey: { type: "string", minLength: 8, maxLength: 128 },
                approvalId: { type: "string", minLength: 36, maxLength: 36 },
                digest: { type: "string", minLength: 43, maxLength: 44 },
                walletSignature: { type: "string", minLength: 1 },
            },
            required: ["registryAction", "idempotencyKey", "approvalId", "digest", "walletSignature"],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Submit owner-approved action", {
            readOnly: false, destructive: true, idempotent: true,
        }),
    },
    {
        name: "chain_get_action_status",
        description: "Read transaction finality from chain RPC and optional indexed enrichment.",
        inputSchema: {
            type: "object",
            properties: { digest: { type: "string", minLength: 43, maxLength: 44 } },
            required: ["digest"],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Get blockchain action status", {
            readOnly: true,
            destructive: false,
            idempotent: true,
        }),
    },
    {
        name: "social_create_post",
        description: "Publish a post on MySocial. Requires CAP_POST_PUBLISH and platform scope.",
        inputSchema: {
            type: "object",
            properties: {
                content: { type: "string", minLength: 1 },
                idempotencyKey: { type: "string", minLength: 8, maxLength: 128 },
            },
            required: ["content", "idempotencyKey"],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Publish social post", {
            readOnly: false,
            destructive: false,
            idempotent: true,
        }),
    },
    {
        name: "social_create_comment",
        description: "Comment on a post. Requires CAP_COMMENT and platform scope.",
        inputSchema: {
            type: "object",
            properties: {
                postId: { type: "string", minLength: 1 },
                content: { type: "string", minLength: 1 },
                parentCommentId: { type: "string", minLength: 1 },
                idempotencyKey: { type: "string", minLength: 8, maxLength: 128 },
            },
            required: ["postId", "content", "idempotencyKey"],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Create social comment", {
            readOnly: false,
            destructive: false,
            idempotent: true,
        }),
    },
    {
        name: "social_react_post",
        description: "React to a post. Requires CAP_REACT and platform scope.",
        inputSchema: {
            type: "object",
            properties: {
                postId: { type: "string", minLength: 1 },
                reaction: { type: "string", minLength: 1 },
                idempotencyKey: { type: "string", minLength: 8, maxLength: 128 },
            },
            required: ["postId", "reaction", "idempotencyKey"],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("React to social post", {
            readOnly: false,
            destructive: false,
            idempotent: true,
        }),
    },
    {
        name: "social_react_comment",
        description: "React to a comment. Requires CAP_REACT and platform scope.",
        inputSchema: {
            type: "object",
            properties: {
                commentId: { type: "string", minLength: 1 },
                reaction: { type: "string", minLength: 1 },
                idempotencyKey: { type: "string", minLength: 8, maxLength: 128 },
            },
            required: ["commentId", "reaction", "idempotencyKey"],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("React to social comment", {
            readOnly: false,
            destructive: false,
            idempotent: true,
        }),
    },
    {
        name: "social_create_repost",
        description: "Repost or quote-repost. Requires CAP_POST_PUBLISH and platform scope.",
        inputSchema: {
            type: "object",
            properties: {
                originalPostId: { type: "string", minLength: 1 },
                content: { type: "string", minLength: 1 },
                idempotencyKey: { type: "string", minLength: 8, maxLength: 128 },
            },
            required: ["originalPostId", "idempotencyKey"],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Create social repost", {
            readOnly: false,
            destructive: false,
            idempotent: true,
        }),
    },
];

export function createToolCatalog(
    socialToolNames: readonly string[] = [],
    oauthScopes?: ReadonlySet<string>,
): Tool[] {
    const allowed = new Set(socialToolNames);
    const scoped = (tool: Tool) => !oauthScopes || (tool.name === "messaging_revoke_member_from_all_rooms"
        ? oauthScopes.has("messaging:read") && oauthScopes.has("messaging:write")
        : oauthScopes.has(TOOL_OAUTH_SCOPES[tool.name]));
    return [
        ...MEMORY_TOOLS.filter(scoped),
        ...SOCIAL_TOOLS.filter((tool) => allowed.has(tool.name) && scoped(tool)),
        ...MARKET_ACTION_TOOLS.map((entry) => entry.tool).filter((tool) => allowed.has(tool.name) && scoped(tool)),
        ...PLATFORM_TOOLS.map((entry) => entry.tool).filter((tool) => allowed.has(tool.name) && scoped(tool)),
    ];
}

/** Resolve live availability for both discovery and invocation. A static supported
 * name only states adapter implementation; it is never current execution policy. */
function policyContext(value: unknown, principal?: ToolDependencies["principal"]): { capabilities: bigint } {
    const record=value as {memoryAccountId?:unknown;agentObjectId?:unknown;capabilities?:unknown};
    const normalize=(id:unknown)=>typeof id === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(id) ? id.slice(2).toLowerCase().padStart(64,"0") : undefined;
    if(!record || typeof record!=="object" || !normalize(record.memoryAccountId) || !normalize(record.agentObjectId)
        || typeof record.capabilities!=="number" || !Number.isSafeInteger(record.capabilities) || record.capabilities<0) {
        throw new McpRuntimeError("AUTHENTICATION_FAILED","The service did not return a verified execution identity.");
    }
    if(principal && (normalize(principal.accountId)!==normalize(record.memoryAccountId) || normalize(principal.agentObjectId)!==normalize(record.agentObjectId))) {
        throw new McpRuntimeError("AUTHENTICATION_FAILED","The service client does not match the verified OAuth principal.");
    }
    return {capabilities:BigInt(record.capabilities)};
}

export async function connectionToolCatalog(dependencies: ToolDependencies, requestedName?: string): Promise<Tool[]> {
    const supported = dependencies.social?.supportedToolNames ?? [];
    const needsLiveSocial = requestedName === undefined || supported.includes(requestedName);
    let names: readonly string[] = supported;
    if(needsLiveSocial){
        if(dependencies.principal){
            if(!dependencies.social?.getExecutionContext) names=[];
            else policyContext(await dependencies.social.getExecutionContext(),dependencies.principal);
        }
        if(!dependencies.principal || dependencies.social?.getExecutionContext) names=await dependencies.social?.availableToolNames?.() ?? supported;
    }
    let memoryNames: ReadonlySet<string>|undefined;
    const needsMemory=requestedName===undefined || ["memory_recall","memory_remember"].includes(requestedName);
    if(needsMemory){
        if(dependencies.memory.getAgentContext){
            const context=policyContext(await dependencies.memory.getAgentContext(),dependencies.principal);
            const has=(required:number)=>(context.capabilities&BigInt(required))===BigInt(required);
            memoryNames=new Set(["memory_health",...(!dependencies.principal?.workerRun&&has(CAP_MYDATA_READ)&&has(CAP_MEMORY_READ)?["memory_recall"]:[]),...(!dependencies.principal?.workerRun&&has(CAP_MYDATA_READ)&&has(CAP_MEMORY_WRITE)?["memory_remember"]:[])]);
        }else if(dependencies.principal){
            // Diagnostic health is public service metadata; private data requires identity proof.
            memoryNames=new Set(["memory_health"]);
        }
    }
    return createToolCatalog(names, dependencies.oauthScopes)
        .filter((tool) => (!tool.name.startsWith("memory_") || !memoryNames || memoryNames.has(tool.name))
            && (tool.name !== "agent_provision_signer" || !!dependencies.agentProvisioner)
            && (tool.name !== "messaging_revoke_member_from_all_rooms" || !dependencies.principal?.workerRun));
}

function requireString(args: Record<string, unknown>, name: string): string {
    const value = args[name];
    if (typeof value !== "string" || !value.trim()) {
        throw new McpRuntimeError("INVALID_ARGUMENT", `${name} must be a non-empty string.`);
    }
    return value;
}

const BULK_ROOM_SCAN_LIMIT = 500;
const BULK_ROOM_PAGE_SIZE = 100;
const BULK_ROOM_MEMBER_PAGE_SIZE = 100;
const BULK_ROOM_MEMBER_PAGE_LIMIT = 20;

function canonicalRoomAddress(value: unknown, label: string): string {
    if (typeof value !== "string" || !/^(0x)?[0-9a-fA-F]{1,64}$/.test(value)) throw new McpRuntimeError("INVALID_ARGUMENT", `${label} must be a MySo address.`);
    return `0x${value.replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `${label} returned an invalid response.`);
    return value as Record<string, unknown>;
}

async function roomMemberIsReader(gateway: SocialGateway, groupId: string, target: string): Promise<boolean> {
    if (!gateway.callPlatformTool) throw new McpRuntimeError("SOCIAL_GATEWAY_UNAVAILABLE", "Current room membership reads are unavailable.");
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (let pageIndex = 0; pageIndex < BULK_ROOM_MEMBER_PAGE_LIMIT; pageIndex++) {
        const page = asObject(await gateway.callPlatformTool("messaging_list_room_members", {
            id: groupId, limit: BULK_ROOM_MEMBER_PAGE_SIZE, ...(cursor ? { cursor } : {}),
        }), "Room membership reader");
        const members = page.members;
        if (canonicalRoomAddress(page.groupId, "Room membership group ID") !== groupId
            || !Array.isArray(members) || members.length > BULK_ROOM_MEMBER_PAGE_SIZE
            || typeof page.hasNextPage !== "boolean"
            || (page.nextCursor !== null && typeof page.nextCursor !== "string")
            || page.hasNextPage !== (page.nextCursor !== null)) {
            throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "A room membership page did not match the requested room or cursor contract.");
        }
        for (const rawMember of members) {
            const row = asObject(rawMember, "Room member row");
            if (!Array.isArray(row.permissions) || row.permissions.some((permission) => typeof permission !== "string")) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "A room member row has invalid permissions.");
            if (canonicalRoomAddress(row.address, "Room member address") === target && (row.permissions as string[]).some((permission) => permission.endsWith("::MessagingReader"))) return true;
        }
        if (!page.hasNextPage) return false;
        const nextCursor = canonicalRoomAddress(page.nextCursor, "Room member cursor");
        if (nextCursor === cursor || seenCursors.has(nextCursor)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Room membership pagination repeated a cursor.");
        if (pageIndex === BULK_ROOM_MEMBER_PAGE_LIMIT - 1) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Room membership exceeded the complete-scan page limit.");
        seenCursors.add(nextCursor);
        cursor = nextCursor;
    }
    throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Room membership could not be completely scanned.");
}

async function scanRoomsForMember(gateway: SocialGateway, target: string): Promise<Array<{ groupId: string; uuid: string; name: string }>> {
    if (!gateway.listRoomConversations || !gateway.callPlatformTool) throw new McpRuntimeError("SOCIAL_GATEWAY_UNAVAILABLE", "Complete room discovery and membership reads are required for this operation.");
    const rooms = new Map<string, { groupId: string; uuid: string; name: string }>();
    const scannedIds = new Set<string>();
    const seenCursors = new Set<string>();
    let afterGroupId: string | undefined;
    for (let pageIndex = 0; pageIndex < BULK_ROOM_SCAN_LIMIT / BULK_ROOM_PAGE_SIZE; pageIndex++) {
        const page = asObject(await gateway.listRoomConversations({ limit: BULK_ROOM_PAGE_SIZE, ...(afterGroupId ? { afterGroupId } : {}) }), "Room discovery");
        if (!Array.isArray(page.conversations) || page.conversations.length > BULK_ROOM_PAGE_SIZE || typeof page.hasMore !== "boolean") throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Room discovery returned an invalid page.");
        for (const rawRoom of page.conversations) {
            const row = asObject(rawRoom, "Room discovery row");
            const groupId = canonicalRoomAddress(row.groupId, "Room ID");
            if (scannedIds.has(groupId)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Room discovery repeated a room ID; no rooms were changed.");
            scannedIds.add(groupId);
            if (await roomMemberIsReader(gateway, groupId, target)) {
                if (typeof row.groupUuid !== "string" || !row.groupUuid.trim()) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `Room ${groupId} lacks a verified UUID required for removal; no rooms were changed.`);
                rooms.set(groupId, { groupId, uuid: row.groupUuid, name: typeof row.groupName === "string" && row.groupName ? row.groupName : "Work room" });
                if (rooms.size > BULK_ROOM_SCAN_LIMIT) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The target appears in more rooms than this bounded operation can safely cover; no rooms were changed.");
            }
        }
        if (!page.hasMore) return [...rooms.values()].sort((a, b) => a.groupId.localeCompare(b.groupId));
        const next = canonicalRoomAddress(page.nextAfterGroupId, "Room continuation cursor");
        if (next === afterGroupId || seenCursors.has(next)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Room discovery repeated its continuation cursor; no rooms were changed.");
        if (pageIndex === BULK_ROOM_SCAN_LIMIT / BULK_ROOM_PAGE_SIZE - 1) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", `Room discovery exceeded ${BULK_ROOM_SCAN_LIMIT} rooms; no rooms were changed.`);
        seenCursors.add(next);
        afterGroupId = next;
    }
    throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "Room discovery could not be completely scanned.");
}

async function revokeMemberFromIndexedRooms(args: Record<string, unknown>, gateway: SocialGateway): Promise<unknown> {
    const member = canonicalRoomAddress(args.member, "Target member");
    if (!gateway.getExecutionContext) throw new McpRuntimeError("AUTHENTICATION_FAILED", "A live authenticated agent identity is required for cross-room revocation.");
    const context = asObject(await gateway.getExecutionContext(), "Authenticated agent context");
    if (canonicalRoomAddress(context.derivedAddress, "Authenticated agent address") === member) throw new McpRuntimeError("INVALID_ARGUMENT", "The authenticated agent cannot remove itself from rooms through this operation.");
    const rooms = await scanRoomsForMember(gateway, member);
    const groupIds = rooms.map((room) => room.groupId);
    if (args.operation === "preview") {
        return { status: "preview", member, rooms, confirmedGroupIds: groupIds, roomCount: rooms.length, membershipSource: "authenticated_reverse_membership_index_plus_live_fullnode_reader_check", sourceLimit: BULK_ROOM_SCAN_LIMIT };
    }
    if (args.operation !== "execute" || args.confirmed !== true || !Array.isArray(args.confirmedGroupIds)) throw new McpRuntimeError("INVALID_ARGUMENT", "Execution requires confirmed=true and the exact group IDs from a complete preview.");
    const confirmedIds = (args.confirmedGroupIds as unknown[]).map((value) => canonicalRoomAddress(value, "Confirmed room ID")).sort();
    if (new Set(confirmedIds).size !== confirmedIds.length || confirmedIds.join(",") !== [...groupIds].sort().join(",")) throw new McpRuntimeError("INVALID_ARGUMENT", "The fresh complete room set differs from the confirmed preview. Run preview again; no rooms were changed.");
    if (!groupIds.length) return { status: "complete", member, roomCount: 0, results: [], membershipSource: "authenticated_reverse_membership_index_plus_live_fullnode_reader_check" };
    if (!gateway.removeRoomMembersAndRotateKey) throw new McpRuntimeError("SOCIAL_GATEWAY_UNAVAILABLE", "Room removal and key rotation are unavailable.");
    const results: Array<Record<string, unknown>> = [];
    for (const room of rooms) {
        try {
            if (!await roomMemberIsReader(gateway, room.groupId, member)) {
                results.push({ groupId: room.groupId, status: "already_absent", verification: "live_fullnode_membership_snapshot" });
                continue;
            }
            const receipt = asObject(await gateway.removeRoomMembersAndRotateKey({ groupRef: { uuid: room.uuid }, members: [member] }), "Room removal");
            const removed = receipt.removedMembers;
            const before = typeof receipt.keyVersionBefore === "string" ? receipt.keyVersionBefore : "";
            const after = typeof receipt.keyVersionAfter === "string" ? receipt.keyVersionAfter : "";
            if (canonicalRoomAddress(receipt.groupId, "Removal receipt group ID") !== room.groupId
                || !Array.isArray(removed) || removed.length !== 1 || canonicalRoomAddress(removed[0], "Removed member") !== member
                || typeof receipt.digest !== "string" || !receipt.digest
                || !/^(0|[1-9][0-9]*)$/.test(before) || !/^(0|[1-9][0-9]*)$/.test(after) || BigInt(after) <= BigInt(before)
                || receipt.verification !== "finalized_membership_and_key_version" || receipt.source !== "myso_fullnode") {
                throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The room removal did not return its exact finalized key-rotation receipt.");
            }
            results.push({ groupId: room.groupId, status: "removed", digest: receipt.digest, keyVersionBefore: before, keyVersionAfter: after, verification: receipt.verification });
        } catch (error) {
            results.push({
                groupId: room.groupId,
                status: "uncertain_or_failed",
                ...(error instanceof McpRuntimeError ? { errorCode: error.code, ...(error.digest ? { digest: error.digest } : {}) } : {}),
                reason: error instanceof Error ? error.message.slice(0, 500) : "Room removal failed without a verifiable result",
            });
            return { status: "partial_reconciliation_required", member, roomCount: rooms.length, completedCount: results.filter((result) => result.status === "removed" || result.status === "already_absent").length, results, stoppedAtGroupId: room.groupId, retryPolicy: "do_not_retry_uncertain_room_before_reconciliation" };
        }
    }
    return { status: "complete", member, roomCount: rooms.length, completedCount: results.length, results };
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
    const value = args[name];
    if (value === undefined) return undefined;
    return requireString(args, name);
}

function roomGroupRef(args: Record<string, unknown>): { groupId: string; encryptionHistoryId: string } | { uuid: string } {
    const uuid = optionalString(args, "uuid");
    if (uuid) return { uuid };
    const groupId = optionalString(args, "groupId");
    const encryptionHistoryId = optionalString(args, "encryptionHistoryId");
    if (!groupId || !encryptionHistoryId) throw new McpRuntimeError("INVALID_ARGUMENT", "Provide either uuid or both groupId and encryptionHistoryId.");
    return { groupId, encryptionHistoryId };
}

function optionalStringArray(args: Record<string, unknown>, name: string): string[] | undefined {
    const value = args[name];
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
        throw new McpRuntimeError("INVALID_ARGUMENT", `${name} must be an array of non-empty strings.`);
    }
    return value as string[];
}

function requireObject(args: Record<string, unknown>, name: string): Record<string, unknown> {
    const value = args[name];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new McpRuntimeError("INVALID_ARGUMENT", `${name} must be an object.`);
    }
    return value as Record<string, unknown>;
}

function optionalInteger(args: Record<string, unknown>, name: string): number | undefined {
    const value = args[name];
    if (value === undefined) return undefined;
    if (!Number.isSafeInteger(value)) {
        throw new McpRuntimeError("INVALID_ARGUMENT", `${name} must be a safe integer.`);
    }
    return value as number;
}

function requireInteger(args: Record<string, unknown>, name: string): number {
    const value = optionalInteger(args, name);
    if (value === undefined) {
        throw new McpRuntimeError("INVALID_ARGUMENT", `${name} must be an integer.`);
    }
    return value;
}

function recallLimit(args: Record<string, unknown>): number {
    const value = args.limit ?? 5;
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 100) {
        throw new McpRuntimeError("INVALID_ARGUMENT", "limit must be an integer between 1 and 100.");
    }
    return value as number;
}

function requireSocial(dependencies: ToolDependencies): SocialGateway {
    if (!dependencies.social) {
        throw new McpRuntimeError(
            "SOCIAL_GATEWAY_UNAVAILABLE",
            "Social tools are disabled for this MCP server.",
        );
    }
    return dependencies.social;
}

function toStructuredValue(value: unknown): unknown {
    if (value === undefined) return null;
    return JSON.parse(
        JSON.stringify(value, (_key, nested) =>
            typeof nested === "bigint" ? nested.toString() : nested,
        ),
    ) as unknown;
}

const inputValidator = new AjvJsonSchemaValidator();
const inputValidators = new Map<string, JsonSchemaValidator<Record<string, unknown>>>();

export async function executeTool(
    name: string,
    args: Record<string, unknown>,
    dependencies: ToolDependencies,
): Promise<ToolEnvelope> {
    try {
        const requiredScope = TOOL_OAUTH_SCOPES[name];
        if (dependencies.oauthScopes && (!requiredScope || !dependencies.oauthScopes.has(requiredScope))) {
            throw new McpRuntimeError(
                "CAPABILITY_DENIED",
                `The OAuth token does not grant ${requiredScope ?? "this tool"}.`,
            );
        }
        if (name === "messaging_revoke_member_from_all_rooms" && dependencies.oauthScopes && !dependencies.oauthScopes.has("messaging:read")) {
            throw new McpRuntimeError("CAPABILITY_DENIED", "The OAuth token must grant both messaging:read and messaging:write for this cross-room operation.");
        }
        // Invocation must respect the same availability boundary as tools/list.
        const available = (await connectionToolCatalog(dependencies, name)).find((tool) => tool.name === name);
        if (!available) {
            throw new McpRuntimeError("UNKNOWN_TOOL", `Tool is unavailable for this connection: ${name}`);
        }
        let validateInput = inputValidators.get(name);
        if (!validateInput) {
            validateInput = inputValidator.getValidator<Record<string, unknown>>(available.inputSchema as unknown as JsonSchemaType);
            inputValidators.set(name, validateInput);
        }
        const checked = validateInput(args);
        if (!checked.valid) throw new McpRuntimeError("INVALID_ARGUMENT", checked.errorMessage);
        const market = MARKET_ACTION_BY_TOOL.get(name);
        if (market) {
            const { idempotencyKey, ...parameters } = args;
            const validation = getSocialActionDescriptor(market.actionId).validate(parameters as never);
            if (!validation.success) throw new McpRuntimeError("INVALID_ARGUMENT", validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
            const gateway = requireSocial(dependencies);
            if (!gateway.executeAction) throw new McpRuntimeError("SOCIAL_GATEWAY_UNAVAILABLE", "Registered action execution is unavailable.");
            const data = await gateway.executeAction(market.actionId, validation.value, requireString(args, "idempotencyKey"));
            return { ok: true, data: toStructuredValue(data) };
        }
        if (PLATFORM_TOOL_BY_NAME.has(name)) {
            const gateway = requireSocial(dependencies);
            if (!gateway.callPlatformTool) throw new McpRuntimeError("SOCIAL_GATEWAY_UNAVAILABLE", "Platform service access is unavailable.");
            return { ok: true, data: toStructuredValue(await gateway.callPlatformTool(name, args)) };
        }
        let result: unknown;
        const ownerDefinition = OWNER_APPROVAL_ACTION_BY_TOOL.get(name);
        if (ownerDefinition) {
            const parameters = Object.fromEntries(
                Object.keys(ownerDefinition.properties)
                    .filter((key) => args[key] !== undefined)
                    .map((key) => [key, args[key]]),
            );
            if ([
                "organization.grant_treasury_access.v1",
                "organization.withdraw_treasury.v1",
                "organization.define_role.v1",
                "organization.assign_role.v1",
                "organization.revoke_role.v1",
                "organization.create_invitation.v1",
            ].includes(ownerDefinition.registryAction)) {
                const executionContext = await requireSocial(dependencies).getExecutionContext?.();
                if (!executionContext || typeof executionContext !== "object" || Array.isArray(executionContext)) {
                    throw new McpRuntimeError("AUTHENTICATION_FAILED", "The live social execution context is required to derive the organization permission group.");
                }
                const chain = (executionContext as Record<string, unknown>).chain;
                if (!chain || typeof chain !== "object" || Array.isArray(chain)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The authenticated social chain configuration is unavailable.");
                const packageId = requireString(chain as Record<string, unknown>, "packageId");
                const groupId = ptb.deriveOrgMemoryGroupId(packageId, requireString(parameters, "organizationId"));
                parameters.orgMemoryGroupId = groupId;
            }
            result = await requireSocial(dependencies).requestActionApproval({
                registryAction: ownerDefinition.registryAction,
                parameters,
                idempotencyKey: requireString(args, "idempotencyKey"),
                expiresInSeconds: optionalInteger(args, "expiresInSeconds"),
                signerAddress: optionalString(args, "signerAddress"),
            });
            return { ok: true, data: toStructuredValue(result) };
        }
        switch (name) {
            case "memory_remember":
                result = await dependencies.memory.rememberAndWait(
                    requireString(args, "text"),
                    optionalString(args, "subLabel"),
                );
                break;
            case "memory_recall":
                result = await dependencies.memory.recall(
                    requireString(args, "query"),
                    recallLimit(args),
                );
                break;
            case "memory_health":
                result = await dependencies.memory.health();
                break;
            case "chain_list_actions":
                result = await requireSocial(dependencies).listActions();
                break;
            case "account_configure_multisig": {
                const rawMembers = args.members;
                if (!Array.isArray(rawMembers)) throw new McpRuntimeError("INVALID_ARGUMENT", "members must be an array.");
                const members = rawMembers.map((raw, index) => {
                    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new McpRuntimeError("INVALID_ARGUMENT", `members[${index}] must be an object.`);
                    const member = raw as Record<string, unknown>;
                    return {
                        address: requireString(member, "address"),
                        publicKeyBase64: requireString(member, "publicKeyBase64"),
                        weight: requireInteger(member, "weight"),
                    };
                });
                try {
                    result = configureMySoMultisig(requireInteger(args, "threshold"), members);
                } catch (error) {
                    throw new McpRuntimeError("INVALID_ARGUMENT", error instanceof Error ? error.message : "Invalid multisig configuration.");
                }
                break;
            }
            case "social_create_post":
                result = await requireSocial(dependencies).createPost({
                    content: requireString(args, "content"),
                    idempotencyKey: requireString(args, "idempotencyKey"),
                });
                break;
            case "social_create_comment":
                result = await requireSocial(dependencies).createComment({
                    postId: requireString(args, "postId"),
                    content: requireString(args, "content"),
                    parentCommentId: optionalString(args, "parentCommentId"),
                    idempotencyKey: requireString(args, "idempotencyKey"),
                });
                break;
            case "social_react_post":
                result = await requireSocial(dependencies).reactToPost({
                    postId: requireString(args, "postId"),
                    reaction: requireString(args, "reaction"),
                    idempotencyKey: requireString(args, "idempotencyKey"),
                });
                break;
            case "social_react_comment":
                result = await requireSocial(dependencies).reactToComment({
                    commentId: requireString(args, "commentId"),
                    reaction: requireString(args, "reaction"),
                    idempotencyKey: requireString(args, "idempotencyKey"),
                });
                break;
            case "social_create_repost":
                result = await requireSocial(dependencies).createRepost({
                    originalPostId: requireString(args, "originalPostId"),
                    content: optionalString(args, "content"),
                    idempotencyKey: requireString(args, "idempotencyKey"),
                });
                break;
            case "social_remove_post_reaction":
                result = await requireSocial(dependencies).removePostReaction({
                    postId: requireString(args, "postId"),
                    idempotencyKey: requireString(args, "idempotencyKey"),
                });
                break;
            case "social_remove_comment_reaction":
                result = await requireSocial(dependencies).removeCommentReaction({
                    commentId: requireString(args, "commentId"),
                    idempotencyKey: requireString(args, "idempotencyKey"),
                });
                break;
            case "social_edit_post":
                result = await requireSocial(dependencies).editPost({
                    postId: requireString(args, "postId"),
                    content: requireString(args, "content"),
                    mediaUrls: optionalStringArray(args, "mediaUrls"),
                    mentions: optionalStringArray(args, "mentions"),
                    metadataJson: optionalString(args, "metadataJson"),
                    idempotencyKey: requireString(args, "idempotencyKey"),
                });
                break;
            case "social_edit_comment":
                result = await requireSocial(dependencies).editComment({
                    commentId: requireString(args, "commentId"),
                    content: requireString(args, "content"),
                    mentions: optionalStringArray(args, "mentions"),
                    idempotencyKey: requireString(args, "idempotencyKey"),
                });
                break;
            case "social_remove_repost":
                result = await requireSocial(dependencies).removeRepost({
                    originalPostId: requireString(args, "originalPostId"),
                    repostId: requireString(args, "repostId"),
                    idempotencyKey: requireString(args, "idempotencyKey"),
                });
                break;
            case "social_follow_profile":
            case "social_unfollow_profile":
            case "social_block_profile":
            case "social_unblock_profile": {
                const input = {
                    targetOwner: requireString(args, "targetOwner"),
                    idempotencyKey: requireString(args, "idempotencyKey"),
                };
                const social = requireSocial(dependencies);
                result = name === "social_follow_profile"
                    ? await social.followProfile(input)
                    : name === "social_unfollow_profile"
                        ? await social.unfollowProfile(input)
                        : name === "social_block_profile"
                            ? await social.blockProfile(input)
                            : await social.unblockProfile(input);
                break;
            }
            case "messaging_send_message":
                result = await requireSocial(dependencies).sendMessage({
                    groupId: requireString(args, "groupId"),
                    messageLogId: requireString(args, "messageLogId"),
                    recipient: requireString(args, "recipient"),
                    contentDigestHex: requireString(args, "contentDigestHex"),
                    contentUri: requireString(args, "contentUri"),
                    dedupeKey: requireString(args, "dedupeKey"),
                    nonce: requireString(args, "nonce"),
                    idempotencyKey: requireString(args, "idempotencyKey"),
                });
                break;
            case "messaging_create_group":
                result = await requireSocial(dependencies).createMessagingGroup({
                    name: requireString(args, "name"),
                    uuid: requireString(args, "uuid"),
                    encryptedDekHex: requireString(args, "encryptedDekHex"),
                    initialMembers: optionalStringArray(args, "initialMembers") ?? [],
                    crossPrincipalPeerAccountId: optionalString(args, "crossPrincipalPeerAccountId"),
                    roomKind: optionalInteger(args, "roomKind"),
                    roomTaskId: optionalString(args, "roomTaskId"),
                    idempotencyKey: requireString(args, "idempotencyKey"),
                });
                break;
            case "messaging_bind_room_to_task":
                result = await requireSocial(dependencies).bindAgentRoomToTask({
                    groupId: requireString(args, "groupId"),
                    taskId: requireString(args, "taskId"),
                    idempotencyKey: requireString(args, "idempotencyKey"),
                });
                break;
            case "messaging_list_inbox":
                result = await requireSocial(dependencies).listInbox({
                    limit: optionalInteger(args, "limit"),
                    offset: optionalInteger(args, "offset"),
                    groupId: optionalString(args, "groupId"),
                    afterCreatedAtMs: optionalInteger(args, "afterCreatedAtMs"),
                    afterSeq: optionalInteger(args, "afterSeq"),
                });
                break;
            case "messaging_get_room_history": {
                const social = requireSocial(dependencies);
                if (!social.getRoomHistory) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "A caller-bound encrypted room history client is required.");
                result = await social.getRoomHistory({
                    groupRef: roomGroupRef(args),
                    afterOrder: optionalInteger(args, "afterOrder"),
                    beforeOrder: optionalInteger(args, "beforeOrder"),
                    limit: optionalInteger(args, "limit"),
                });
                break;
            }
            case "messaging_get_room_attachment": {
                const social = requireSocial(dependencies);
                if (!social.getRoomAttachment) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "A caller-bound encrypted room attachment client is required.");
                result = await social.getRoomAttachment({ groupRef: roomGroupRef(args), messageId: requireString(args, "messageId"), storageId: requireString(args, "storageId") });
                break;
            }
            case "messaging_send_room_message": {
                const social = requireSocial(dependencies);
                if (!social.sendRoomMessage) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "A caller-bound encrypted room sender is required.");
                const filesValue = args.files;
                if (filesValue !== undefined && (!Array.isArray(filesValue) || filesValue.length > 10)) throw new McpRuntimeError("INVALID_ARGUMENT", "files must be an array containing at most 10 attachments.");
                const files = Array.isArray(filesValue) ? filesValue.map((value) => {
                    if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpRuntimeError("INVALID_ARGUMENT", "Each attachment must be an object.");
                    const file = value as Record<string, unknown>;
                    if (Object.keys(file).sort().join(",") !== "contentBase64,fileName,mimeType" || typeof file.fileName !== "string" || typeof file.mimeType !== "string" || typeof file.contentBase64 !== "string") throw new McpRuntimeError("INVALID_ARGUMENT", "Each attachment requires only fileName, mimeType and contentBase64.");
                    return { fileName: file.fileName, mimeType: file.mimeType, contentBase64: file.contentBase64 };
                }) : undefined;
                result = await social.sendRoomMessage({ groupRef: roomGroupRef(args), text: optionalString(args, "text"), files, idempotencyKey: requireString(args, "idempotencyKey") });
                break;
            }
            case "messaging_list_rooms": {
                const social = requireSocial(dependencies);
                if (!social.listRoomConversations) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "A caller-bound room discovery client is required.");
                result = await social.listRoomConversations({ limit: optionalInteger(args, "limit"), offset: optionalInteger(args, "offset"), afterGroupId: optionalString(args, "afterGroupId") });
                break;
            }
            case "messaging_edit_message": {
                const social = requireSocial(dependencies);
                if (!social.editRoomMessage) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "A caller-bound room message editor is required.");
                result = await social.editRoomMessage({ groupRef: roomGroupRef(args), messageId: requireString(args, "messageId"), text: requireString(args, "text") });
                break;
            }
            case "messaging_delete_message": {
                const social = requireSocial(dependencies);
                if (!social.deleteRoomMessage) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "A caller-bound room message deleter is required.");
                result = await social.deleteRoomMessage({ groupRef: roomGroupRef(args), messageId: requireString(args, "messageId") });
                break;
            }
            case "messaging_remove_members_rotate_key": {
                const social = requireSocial(dependencies);
                if (!social.removeRoomMembersAndRotateKey) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "A caller-bound room administration signer is required.");
                const rawMembers = args.members;
                if (!Array.isArray(rawMembers) || rawMembers.some((member) => typeof member !== "string")) throw new McpRuntimeError("INVALID_ARGUMENT", "members must be an array of MySo addresses.");
                result = await social.removeRoomMembersAndRotateKey({ groupRef: roomGroupRef(args), members: rawMembers as string[] });
                break;
            }
            case "messaging_revoke_member_from_all_rooms": {
                const social = requireSocial(dependencies);
                result = await revokeMemberFromIndexedRooms(args, social);
                break;
            }
            case "messaging_add_room_members": {
                const social = requireSocial(dependencies);
                if (args.acknowledgeHistoryAccess !== true) throw new McpRuntimeError("INVALID_ARGUMENT", "Explicitly acknowledge that every invited wallet can access existing and future room history.");
                if (!social.addRoomMembers) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "A caller-bound room invitation signer is required.");
                const rawMembers = args.members;
                if (!Array.isArray(rawMembers) || rawMembers.some((member) => typeof member !== "string")) throw new McpRuntimeError("INVALID_ARGUMENT", "members must be an array of MySo addresses.");
                result = await social.addRoomMembers({ groupRef: roomGroupRef(args), members: rawMembers as string[], acknowledgeHistoryAccess: true });
                break;
            }
            case "messaging_leave_group": {
                const social = requireSocial(dependencies);
                if (!social.leaveRoom) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "A caller-bound room self-removal signer is required.");
                result = await social.leaveRoom({ groupRef: roomGroupRef(args) });
                break;
            }
            case "messaging_set_room_name": {
                const social = requireSocial(dependencies);
                if (!social.setRoomName) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "A caller-bound room administration signer is required.");
                result = await social.setRoomName({ groupRef: roomGroupRef(args), name: requireString(args, "name") });
                break;
            }
            case "messaging_archive_group": {
                const social = requireSocial(dependencies);
                if (!social.archiveRoom) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "A caller-bound room archive signer is required.");
                result = await social.archiveRoom({ groupRef: roomGroupRef(args), ownerConfirmation: requireObject(args, "ownerConfirmation") as never });
                break;
            }
            case "messaging_list_reactions": {
                const social = requireSocial(dependencies);
                if (!social.listRoomReactions) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "A caller-bound room reaction client is required.");
                result = await social.listRoomReactions({ groupRef: roomGroupRef(args), order: requireInteger(args, "order") });
                break;
            }
            case "messaging_add_reaction":
            case "messaging_remove_reaction": {
                const social = requireSocial(dependencies);
                if (!social.changeRoomReaction) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "A caller-bound room reaction client is required.");
                result = await social.changeRoomReaction({ groupRef: roomGroupRef(args), order: requireInteger(args, "order"), emoji: requireString(args, "emoji"), add: name === "messaging_add_reaction" });
                break;
            }
            case "messaging_get_room_receipts": {
                const social = requireSocial(dependencies);
                if (!social.getRoomReceipts) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "A caller-bound room receipt client is required.");
                result = await social.getRoomReceipts({ groupRef: roomGroupRef(args) });
                break;
            }
            case "messaging_update_room_receipts": {
                const social = requireSocial(dependencies);
                if (!social.updateRoomReceipts) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "A caller-bound room receipt client is required.");
                result = await social.updateRoomReceipts({ groupRef: roomGroupRef(args), deliveredUpto: optionalInteger(args, "deliveredUpto"), readUpto: optionalInteger(args, "readUpto") });
                break;
            }
            case "messaging_get_read_state": {
                const social = requireSocial(dependencies);
                if (!social.getRoomReadState) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "A caller-bound private room read-state client is required.");
                result = await social.getRoomReadState();
                break;
            }
            case "messaging_update_read_state": {
                const social = requireSocial(dependencies);
                if (!social.updateRoomReadState) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "A caller-bound private room read-state client is required.");
                result = await social.updateRoomReadState({ groupId: requireString(args, "groupId"), readUpto: requireInteger(args, "readUpto") });
                break;
            }
            case "messaging_get_unread_counts": {
                const social = requireSocial(dependencies);
                if (!social.getRoomUnreadCounts) throw new McpRuntimeError("SIGNER_UNAVAILABLE", "A caller-bound unread-count client is required.");
                const groupIds = args.groupIds;
                if (!Array.isArray(groupIds) || groupIds.length < 1 || groupIds.length > 50 || groupIds.some((id) => typeof id !== "string")) throw new McpRuntimeError("INVALID_ARGUMENT", "groupIds must contain 1–50 room IDs.");
                result = await social.getRoomUnreadCounts({ groupIds: groupIds as string[] });
                break;
            }
            case "messaging_wait_for_message":
                result = await requireSocial(dependencies).waitForMessage({
                    timeoutMs: optionalInteger(args, "timeoutMs"),
                    groupId: optionalString(args, "groupId"),
                    afterCreatedAtMs: optionalInteger(args, "afterCreatedAtMs"),
                    afterSeq: optionalInteger(args, "afterSeq"),
                });
                break;
            case "organization_get_control":
                result = await requireSocial(dependencies).getOrganizationControl(
                    requireString(args, "organizationId"),
                );
                break;
            case "agent_provision_signer":
                if (!dependencies.agentProvisioner) {
                    throw new McpRuntimeError(
                        "SIGNER_UNAVAILABLE",
                        "This MCP runtime does not have a Keychain or KMS agent provisioner.",
                    );
                }
                result = await dependencies.agentProvisioner.provision(requireString(args, "label"));
                break;
            case "organization_accept_invitation":
            case "organization_decline_invitation": {
                const input = {
                    organizationAccountId: requireString(args, "organizationAccountId"),
                    organizationId: requireString(args, "organizationId"),
                    orgMemoryGroupId: optionalString(args, "orgMemoryGroupId"),
                    invitee: requireString(args, "invitee"),
                    idempotencyKey: requireString(args, "idempotencyKey"),
                };
                const social = requireSocial(dependencies);
                if (name === "organization_accept_invitation" && !input.orgMemoryGroupId) {
                    const executionContext = await social.getExecutionContext?.();
                    if (!executionContext || typeof executionContext !== "object" || Array.isArray(executionContext)) {
                        throw new McpRuntimeError("AUTHENTICATION_FAILED", "The live social execution context is required to derive the organization permission group.");
                    }
                    const chain = (executionContext as Record<string, unknown>).chain;
                    if (!chain || typeof chain !== "object" || Array.isArray(chain)) throw new McpRuntimeError("UPSTREAM_UNAVAILABLE", "The authenticated social chain configuration is unavailable.");
                    const packageId = requireString(chain as Record<string, unknown>, "packageId");
                    input.orgMemoryGroupId = ptb.deriveOrgMemoryGroupId(packageId, input.organizationId);
                }
                result = name === "organization_accept_invitation"
                    ? await social.acceptOrganizationInvitation(input)
                    : await social.declineOrganizationInvitation(input);
                break;
            }
            case "agent_register_child":
                result = await requireSocial(dependencies).registerChildAgent({
                    parentAgentObjectId: optionalString(args, "parentAgentObjectId"),
                    registerRelation: requireInteger(args, "registerRelation"),
                    publicKeyHex: requireString(args, "publicKeyHex"),
                    derivedAddress: requireString(args, "derivedAddress"),
                    label: requireString(args, "label"),
                    identityClass: optionalInteger(args, "identityClass"),
                    roleTags: optionalString(args, "roleTags"),
                    capabilities: optionalString(args, "capabilities"),
                    delegatableCaps: optionalString(args, "delegatableCaps"),
                    registerScope: optionalInteger(args, "registerScope"),
                    approvalRequiredCaps: optionalString(args, "approvalRequiredCaps"),
                    maxActionSpendMist: optionalString(args, "maxActionSpendMist"),
                    platformScope: optionalString(args, "platformScope"),
                    expiresAtMs: optionalString(args, "expiresAtMs"),
                    idempotencyKey: requireString(args, "idempotencyKey"),
                });
                break;
            case "agent_update_child":
                result = await requireSocial(dependencies).updateChildAgent({
                    agentObjectId: requireString(args, "agentObjectId"),
                    identityClass: requireInteger(args, "identityClass"),
                    roleTags: requireString(args, "roleTags"),
                    capabilities: requireString(args, "capabilities"),
                    delegatableCaps: requireString(args, "delegatableCaps"),
                    registerScope: requireInteger(args, "registerScope"),
                    approvalRequiredCaps: requireString(args, "approvalRequiredCaps"),
                    maxActionSpendMist: optionalString(args, "maxActionSpendMist"),
                    platformScope: optionalString(args, "platformScope"),
                    expiresAtMs: optionalString(args, "expiresAtMs"),
                    idempotencyKey: requireString(args, "idempotencyKey"),
                });
                break;
            case "agent_deactivate_child":
            case "agent_revoke_child": {
                const input = {
                    agentObjectId: requireString(args, "agentObjectId"),
                    idempotencyKey: requireString(args, "idempotencyKey"),
                };
                const social = requireSocial(dependencies);
                result = name === "agent_deactivate_child"
                    ? await social.deactivateChildAgent(input)
                    : await social.revokeChildAgent(input);
                break;
            }
            case "chain_get_action_status":
                result = await requireSocial(dependencies).getActionStatus(
                    requireString(args, "digest"),
                );
                break;
            case "chain_request_action_approval":
                result = await requireSocial(dependencies).requestActionApproval({
                    registryAction: requireString(args, "registryAction") as never,
                    parameters: requireObject(args, "parameters"),
                    idempotencyKey: requireString(args, "idempotencyKey"),
                expiresInSeconds: optionalInteger(args, "expiresInSeconds"),
                signerAddress: optionalString(args, "signerAddress"),
                });
                break;
            case "chain_approve_action":
                result = await requireSocial(dependencies).approveAction({
                    approvalId: requireString(args, "approvalId"),
                    walletSignature: requireString(args, "walletSignature"),
                });
                break;
            case "chain_prepare_approved_action":
                result = await requireSocial(dependencies).prepareApprovedAction({
                    registryAction: requireString(args, "registryAction") as never,
                    parameters: requireObject(args, "parameters"),
                    idempotencyKey: requireString(args, "idempotencyKey"),
                    approvalId: requireString(args, "approvalId"),
                });
                break;
            case "chain_submit_approved_action":
                result = await requireSocial(dependencies).submitApprovedAction({
                    registryAction: requireString(args, "registryAction") as never,
                    idempotencyKey: requireString(args, "idempotencyKey"),
                    approvalId: requireString(args, "approvalId"),
                    digest: requireString(args, "digest"),
                    walletSignature: requireString(args, "walletSignature"),
                });
                break;
            default:
                throw new McpRuntimeError("UNKNOWN_TOOL", `Unknown tool: ${name}`);
        }
        return { ok: true, data: toStructuredValue(result) };
    } catch (error) {
        return { ok: false, error: toStructuredMcpError(error) };
    }
}
