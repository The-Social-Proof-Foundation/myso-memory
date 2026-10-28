import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { TIER_1_ACTION_IDS, TIER_2_ACTION_IDS, PRODUCTION_ACTION_CATALOG, getSocialActionDescriptor, type SocialActionId } from "@socialproof/sub-agents";

/** The executable action registry owns both the input schema and transaction semantics. */
export const MARKET_ACTION_TOOLS = [...TIER_1_ACTION_IDS, ...TIER_2_ACTION_IDS]
    .filter((id) => id.startsWith("task.") || id.startsWith("jury.") || id === "access.purchase_mydata_access.v1" || id === "access.purchase_post_access.v1" || id === "dex.swap.v1" || id === "spt.buy.v1" || id === "spt.sell.v1")
    .map((id) => {
        const actionId = id as SocialActionId;
        const descriptor = getSocialActionDescriptor(actionId);
        const name = id.replace(/\.v\d+$/, "").replaceAll(".", "_");
        const juror = ["jury.accept.v1", "jury.commit_vote.v1", "jury.reveal_vote.v1", "jury.claim_fee.v1"].includes(id);
        const scope = id.startsWith("access.") ? "mydata:purchase" : id.startsWith("task.") ? "tasks:write" : id === "dex.swap.v1" || id.startsWith("spt.") ? "payments:write" : juror ? "jury:write" : "jury:operate";
        const schema = JSON.parse(JSON.stringify(descriptor.inputSchema)) as Tool["inputSchema"];
        delete schema.$schema;
        const tool: Tool = {
            name,
            description: id === "access.purchase_mydata_access.v1"
                ? "Buy the exact quoted MyData listing. Explicitly set audienceKind to agent or organization for every purchase; for organization, include that organization's organizationAudienceId, and for agent omit it. The automatic agent-funded path uses only a MYSO coin owned by this authenticated agent and is allowed when the live on-chain capability, approval policy and per-action max_action_spend cover the quoted MIST price; the native Move entry rechecks cap, audience and payment. Use mydata_list_agent_funding_coins to find an eligible agent-owned coin. If live on-chain policy requires owner approval or does not authorize the purchase, the owner must approve the exact inputs and use a MYSO coin owned by the connected owner wallet; it is never substituted silently. Reuse the same idempotencyKey when retrying the same operation."
                : id === "access.purchase_post_access.v1"
                    ? "Buy one-time access to the exact post-bound MyData listing. Use mydata_get_purchase_quote to inspect current listing terms; the native Move entry rechecks that this mydataId remains linked to postId and matches the seller, exact price, encryption identity and ciphertext digest. Automatic agent-funded purchase requires an agent-owned MYSO coin and live on-chain capability, approval policy and per-action max_action_spend covering priceMist; the purchase is agent-audience only. If live on-chain policy requires owner approval or does not authorize automatic execution, request approval for the exact inputs and use a MYSO coin owned by the connected owner wallet. This action is unavailable until MYDATA_POST_ACCESS_PURCHASE_ENABLED and the upgraded Move entry are deployed. Reuse the same idempotencyKey when retrying the same operation."
                : id === "dex.swap.v1"
                    ? "Request owner approval for an exact-input Orderbook v3 swap. Choose poolName from dex_list_markets, inspect dex_get_orderbook, provide the exact owned input coin, and set a protective minimum output. This returns a pending approval; the owner must approve, prepare and submit it with the chain approval tools. The server rechecks the live pool, catalog pair, coin ownership and limits."
                    : id === "spt.buy.v1"
                        ? "Buy SPT with the exact MYSO coin owned by this authenticated agent, within its live per-action MYSO cap. First call spt_get_trade_quote with this pool, kind=buy and the exact MYSO budget. For each requiredEscrowBeneficiary, call poc_get_vault_for_beneficiary and include the resolved vault ID with minDepositBaseUnits='1' (the lowest positive deposit floor). The quote is indicative, so set a protective minimum token amount. Missing or extra vaults abort the atomic transaction. If owner approval is required by policy or the live cap is insufficient, request owner approval with the chain approval tools."
                        : id === "spt.sell.v1"
                            ? "Sell an exact amount from an SPT object owned by this authenticated agent. First call spt_get_trade_quote with this pool, kind=sell and the exact nano-SPT amount. For each requiredEscrowBeneficiary, call poc_get_vault_for_beneficiary and include the resolved vault ID with minDepositBaseUnits='1' (the lowest positive deposit floor). The quote is indicative, so require a protective minimum MYSO output. Missing or extra vaults abort the atomic transaction. If owner approval is required by policy, use the chain approval tools."
                            : `Execute ${id} through the capability-authorized transaction registry. Chain policy, exact terms, deadlines, spend limits and required owner approvals remain authoritative. Reuse the same idempotencyKey when retrying the same operation.`,
            inputSchema: {
                ...schema,
                properties: {
                    ...schema.properties,
                    idempotencyKey: { type: "string", minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9._:/-]+$" },
                },
                required: [...(schema.required ?? []), "idempotencyKey"],
                additionalProperties: false,
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        };
        return { actionId, name, scope, tool };
    });

export const MARKET_ACTION_BY_TOOL = new Map(MARKET_ACTION_TOOLS.map((entry) => [entry.name, entry]));
export const MARKET_TOOL_SCOPES = Object.fromEntries(MARKET_ACTION_TOOLS.map((entry) => [entry.name, entry.scope]));

/** All dedicated executable conveniences share the production catalog's availability.
 * Most names are mechanical; retain the existing public aliases explicitly. */
export const ACTION_ID_BY_TOOL: ReadonlyMap<string, string> = new Map([
    ...PRODUCTION_ACTION_CATALOG.filter((entry) => entry.availability === "enabled")
        .map((entry): [string, string] => [entry.id.replace(/\.v\d+$/, "").replaceAll(".", "_"), entry.id]),
    ["social_react_post", "social.react_to_post.v1"],
    ["social_react_comment", "social.react_to_comment.v1"],
    ["agent_register_root", "agent.register_agent.v1"],
    ["agent_admin_request_revoke", "agent.revoke_agent.v1"],
    ["agent_admin_request_grant_capability", "agent.grant_capability.v1"],
    ["agent_admin_request_revoke_capability", "agent.revoke_capability.v1"],
    ["agent_admin_request_raise_spending_limit", "agent.raise_spending_limit.v1"],
    ["agent_admin_request_lower_spending_limit", "agent.lower_spending_limit.v1"],
]);
