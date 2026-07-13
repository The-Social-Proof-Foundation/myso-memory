import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { SOCIAL_ACTION_IDS } from "@socialproof/social";
import { McpRuntimeError, toStructuredMcpError } from "./errors.js";
import type { SocialGateway } from "./social-gateway.js";
import type { AgentSignerProvisioner } from "./provisioning.js";

export interface MemoryClient {
    rememberAndWait(text: string, subLabel?: string): Promise<unknown>;
    recall(query: string, limit?: number): Promise<unknown>;
    health(): Promise<unknown>;
    destroy?(): void;
}

export interface ToolDependencies {
    memory: MemoryClient;
    social?: SocialGateway;
    agentProvisioner?: AgentSignerProvisioner;
    /** Omit for trusted local stdio. Hosted runtimes must supply verified OAuth scopes. */
    oauthScopes?: ReadonlySet<string>;
}

export const TOOL_OAUTH_SCOPES: Readonly<Record<string, string>> = Object.freeze({
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
    messaging_list_inbox: "messaging:read",
    messaging_wait_for_message: "messaging:read",
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
    organization_accept_invitation: "organization:admin",
    organization_decline_invitation: "organization:admin",
    agent_provision_signer: "agent:provision",
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
    destructive?: boolean;
}

const OWNER_APPROVAL_TOOL_DEFINITIONS: readonly OwnerApprovalToolDefinition[] = [
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
        required: ["organizationId", "orgMemoryGroupId", "roleName", "permissionsMask"],
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
        required: ["organizationId", "orgMemoryGroupId", "memberAddress", "roleName"],
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
        required: ["organizationId", "orgMemoryGroupId", "memberAddress", "roleName"],
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
        required: ["organizationId", "orgMemoryGroupId", "invitee", "permissionsMask"],
    },
    {
        toolName: "agent_register_root",
        title: "Register organization root agent",
        registryAction: "agent.register_agent.v1",
        properties: { organizationId: ID_STRING, ...AGENT_POLICY_TOOL_PROPERTIES },
        required: ["organizationId", "publicKeyHex", "derivedAddress", "label"],
    },
] as const;

const OWNER_APPROVAL_ACTION_BY_TOOL = new Map(
    OWNER_APPROVAL_TOOL_DEFINITIONS.map((definition) => [definition.toolName, definition]),
);

const OWNER_APPROVAL_TOOLS: Tool[] = OWNER_APPROVAL_TOOL_DEFINITIONS.map((definition) => ({
    name: definition.toolName,
    description: `${definition.title}. Returns an exact-input approval intent that the account owner must sign before preparation and submission.`,
    inputSchema: {
        type: "object",
        properties: {
            ...definition.properties,
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
            required: name === "organization_accept_invitation"
                ? ["organizationAccountId", "organizationId", "orgMemoryGroupId", "invitee", "idempotencyKey"]
                : ["organizationAccountId", "organizationId", "invitee", "idempotencyKey"],
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
    ...ADDITIONAL_TIER_1_TOOLS,
    ...OWNER_APPROVAL_TOOLS,
    ...ORGANIZATION_AND_MESSAGING_TOOLS,
    {
        name: "chain_request_action_approval",
        description: "Create an exact-input owner approval request for a registered action.",
        inputSchema: {
            type: "object",
            properties: {
                registryAction: { type: "string", enum: [...SOCIAL_ACTION_IDS] },
                parameters: { type: "object" },
                idempotencyKey: { type: "string", minLength: 8, maxLength: 128 },
                expiresInSeconds: { type: "integer", minimum: 60, maximum: 900 },
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
        description: "Submit an owner wallet signature over a previously returned approval intent.",
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
        description: "Prepare, sponsor, and simulate an owner-approved registry action; returns bytes for wallet signing.",
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
        description: "Submit the owner wallet signature for the exact sponsored transaction returned by preparation.",
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
    {
        name: "social_delete_post",
        description: "Request post deletion. Disabled until the owner approval and wallet-signing flow is available.",
        inputSchema: {
            type: "object",
            properties: { postId: { type: "string", minLength: 1 } },
            required: ["postId"],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Delete social post", {
            readOnly: false,
            destructive: true,
            idempotent: false,
        }),
    },
    {
        name: "social_delete_comment",
        description: "Request comment deletion. Disabled until the owner approval and wallet-signing flow is available.",
        inputSchema: {
            type: "object",
            properties: {
                postId: { type: "string", minLength: 1 },
                commentId: { type: "string", minLength: 1 },
            },
            required: ["postId", "commentId"],
            additionalProperties: false,
        },
        outputSchema: OUTPUT_SCHEMA,
        annotations: annotations("Delete social comment", {
            readOnly: false,
            destructive: true,
            idempotent: false,
        }),
    },
];

export function createToolCatalog(
    socialToolNames: readonly string[] = [],
    oauthScopes?: ReadonlySet<string>,
): Tool[] {
    const allowed = new Set(socialToolNames);
    const scoped = (tool: Tool) => !oauthScopes || oauthScopes.has(TOOL_OAUTH_SCOPES[tool.name]);
    return [
        ...MEMORY_TOOLS.filter(scoped),
        ...SOCIAL_TOOLS.filter((tool) => allowed.has(tool.name) && scoped(tool)),
    ];
}

function requireString(args: Record<string, unknown>, name: string): string {
    const value = args[name];
    if (typeof value !== "string" || !value.trim()) {
        throw new McpRuntimeError("INVALID_ARGUMENT", `${name} must be a non-empty string.`);
    }
    return value;
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
    const value = args[name];
    if (value === undefined) return undefined;
    return requireString(args, name);
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
        let result: unknown;
        const ownerDefinition = OWNER_APPROVAL_ACTION_BY_TOOL.get(name);
        if (ownerDefinition) {
            const parameters = Object.fromEntries(
                Object.keys(ownerDefinition.properties)
                    .filter((key) => args[key] !== undefined)
                    .map((key) => [key, args[key]]),
            );
            result = await requireSocial(dependencies).requestActionApproval({
                registryAction: ownerDefinition.registryAction,
                parameters,
                idempotencyKey: requireString(args, "idempotencyKey"),
                expiresInSeconds: optionalInteger(args, "expiresInSeconds"),
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
            case "social_delete_post":
                result = await requireSocial(dependencies).deletePost(requireString(args, "postId"));
                break;
            case "social_delete_comment":
                result = await requireSocial(dependencies).deleteComment({
                    postId: requireString(args, "postId"),
                    commentId: requireString(args, "commentId"),
                });
                break;
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
