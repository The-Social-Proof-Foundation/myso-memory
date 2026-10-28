import { blake2b } from "@noble/hashes/blake2.js";
import type {
    AgentPolicyParams,
    BindAgentRoomToTaskParams,
    CreateMessagingGroupParams,
    CreateOrganizationInvitationParams,
    CreateOrganizationParams,
    DefineOrganizationRoleParams,
    ManagedAgentParams,
    OrganizationInvitationDecisionParams,
    OrganizationObjectParams,
    OrganizationRoleParams,
    OrganizationTreasuryAccessParams,
    OrganizationTreasuryFundParams,
    OrganizationTreasuryWithdrawParams,
    RegisterChildAgentParams,
    RegisterRootAgentParams,
    SocialChainConfig,
    UpdateManagedAgentParams,
    UpdateOrganizationCategoryParams,
    UpdateOrganizationMetadataParams,
} from "../types.js";
import type { BuildTxContext } from "./post.js";
import { MYSO_CLOCK, optAddress, optString, optU8 } from "./helpers.js";
import { canonicalCoinType } from "./coin-type.js";

/** `messaging::room_kind_agent_room()`; the only room kind defined on-chain. */
const AGENT_ROOM_KIND = 1;

const MAX_U64 = (1n << 64n) - 1n;
const ADDRESS = /^0x[0-9a-fA-F]{1,64}$/;

function requiredChainField(chain: SocialChainConfig, field: keyof SocialChainConfig): string {
    const value = chain[field];
    if (typeof value !== "string" || !value.trim()) {
        throw new TypeError(`${String(field)} is required for this action`);
    }
    return value;
}

function memoryTarget(ctx: BuildTxContext, fn: string): string {
    return `${ctx.chain.packageId}::memory::${fn}`;
}

function hexBytes(value: string, label: string, exactBytes?: number): number[] {
    if (!/^[0-9a-f]+$/.test(value) || value.length % 2 !== 0) {
        throw new TypeError(`${label} must be lowercase even-length hex`);
    }
    if (exactBytes !== undefined && value.length !== exactBytes * 2) {
        throw new TypeError(`${label} must contain exactly ${exactBytes} bytes`);
    }
    return Array.from({ length: value.length / 2 }, (_, index) =>
        Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
    );
}

function u64(value: string | undefined, fallback: string, label: string): string {
    const selected = value ?? fallback;
    if (!/^(0|[1-9][0-9]{0,19})$/.test(selected) || BigInt(selected) > MAX_U64) {
        throw new TypeError(`${label} must be an unsigned u64 decimal string`);
    }
    return selected;
}

function optU64String(tx: any, value: string | undefined, label: string): unknown {
    return tx.pure("option<u64>", value === undefined ? null : u64(value, "0", label));
}

function optAddressString(tx: any, value: string | undefined, label: string): unknown {
    if (value !== undefined && !ADDRESS.test(value)) throw new TypeError(`${label} must be an address`);
    return tx.pure("option<address>", value ?? null);
}

function normalizeAddress(value: string): string {
    const raw = value.replace(/^0x/, "").toLowerCase();
    return `0x${raw.padStart(64, "0")}`;
}

/** Canonical `memory::org_memory_group_address`: matches the derived object ID
 * claimed from AgenticOrganization by `OrgMemoryGroupTag`. */
export function deriveOrgMemoryGroupId(packageId: string, organizationId: string): string {
    const addressBytes = (value: string, label: string): Uint8Array => {
        if (!/^0x[0-9a-fA-F]{1,64}$/.test(value)) throw new TypeError(`${label} must be a MySo address`);
        const hex = value.slice(2).toLowerCase().padStart(64, "0");
        return Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
    };
    const identifier = (value: string): number[] => [value.length, ...Array.from(new TextEncoder().encode(value))];
    const packageBytes = addressBytes(packageId, "packageId");
    const parentBytes = addressBytes(organizationId, "organizationId");
    const orgTag = [7, ...packageBytes, ...identifier("memory"), ...identifier("OrgMemoryGroupTag"), 0];
    const derivedObjectKey = [7, ...new Uint8Array(31), 2, ...identifier("derived_object"), ...identifier("DerivedObjectKey"), 1, ...orgTag];
    const preimage = new Uint8Array(1 + 32 + 8 + 1 + derivedObjectKey.length);
    preimage[0] = 0xf0; preimage.set(parentBytes, 1);
    preimage[33] = 1; // BCS u64 little-endian key length (one byte)
    preimage[41] = 0; // BCS DerivedObjectKey(false)
    preimage.set(derivedObjectKey, 42);
    return `0x${Array.from(blake2b(preimage, { dkLen: 32 })).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function deriveAgentAddress(publicKeyHex: string): string {
    const publicKey = Uint8Array.from(hexBytes(publicKeyHex, "publicKeyHex", 32));
    const input = new Uint8Array(33);
    input[0] = 0;
    input.set(publicKey, 1);
    return `0x${Array.from(blake2b(input, { dkLen: 32 }))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")}`;
}

export function validateAgentPolicy(params: AgentPolicyParams): void {
    const expected = deriveAgentAddress(params.publicKeyHex);
    if (!ADDRESS.test(params.derivedAddress) || normalizeAddress(params.derivedAddress) !== expected) {
        throw new TypeError("derivedAddress does not match publicKeyHex");
    }
    u64(params.roleTags, "0", "roleTags");
    u64(params.capabilities, "3", "capabilities");
    u64(params.delegatableCaps, "0", "delegatableCaps");
    u64(params.approvalRequiredCaps, "0", "approvalRequiredCaps");
    if (params.maxActionSpendMist !== undefined) u64(params.maxActionSpendMist, "0", "maxActionSpendMist");
    if (params.expiresAtMs !== undefined) u64(params.expiresAtMs, "0", "expiresAtMs");
    if (params.platformScope !== undefined && !ADDRESS.test(params.platformScope)) {
        throw new TypeError("platformScope must be an address");
    }
}

function agentPolicyArguments(tx: any, params: AgentPolicyParams): unknown[] {
    validateAgentPolicy(params);
    return [
        tx.pure("vector<u8>", hexBytes(params.publicKeyHex, "publicKeyHex", 32)),
        tx.pure("address", params.derivedAddress),
        tx.pure("string", params.label),
        tx.pure("u8", params.identityClass ?? 1),
        tx.pure("u64", u64(params.roleTags, "0", "roleTags")),
        tx.pure("u64", u64(params.capabilities, "3", "capabilities")),
        tx.pure("u64", u64(params.delegatableCaps, "0", "delegatableCaps")),
        tx.pure("u8", params.registerScope ?? 3),
        tx.pure("u64", u64(params.approvalRequiredCaps, "0", "approvalRequiredCaps")),
        optU64String(tx, params.maxActionSpendMist, "maxActionSpendMist"),
        optAddressString(tx, params.platformScope, "platformScope"),
        optU64String(tx, params.expiresAtMs, "expiresAtMs"),
    ];
}

export function buildCreateOrganizationTx(ctx: BuildTxContext, params: CreateOrganizationParams): any {
    const tx = new ctx.Transaction();
    tx.moveCall({
        target: memoryTarget(ctx, "create_agentic_organization"),
        arguments: [
            tx.object(ctx.chain.memoryConfigId),
            tx.object(ctx.memoryAccountId),
            tx.pure("u8", params.orgType),
            optString(tx, params.name),
            optString(tx, params.description),
            tx.object(ctx.chain.clockId ?? MYSO_CLOCK),
        ],
    });
    return tx;
}

export function buildUpdateOrganizationMetadataTx(ctx: BuildTxContext, params: UpdateOrganizationMetadataParams): any {
    const tx = new ctx.Transaction();
    tx.moveCall({
        target: memoryTarget(ctx, "update_agentic_organization_metadata"),
        arguments: [
            tx.object(ctx.chain.memoryConfigId),
            tx.object(ctx.memoryAccountId),
            tx.object(params.organizationId),
            optString(tx, params.name),
            optString(tx, params.description),
        ],
    });
    return tx;
}

export function buildUpdateOrganizationCategoryTx(ctx: BuildTxContext, params: UpdateOrganizationCategoryParams): any {
    const tx = new ctx.Transaction();
    tx.moveCall({
        target: memoryTarget(ctx, "update_agentic_organization_category"),
        arguments: [
            tx.object(ctx.chain.memoryConfigId),
            tx.object(ctx.memoryAccountId),
            tx.object(params.organizationId),
            tx.pure("u8", params.orgType),
            tx.object(ctx.chain.clockId ?? MYSO_CLOCK),
        ],
    });
    return tx;
}

function organizationObjectAction(fn: "deactivate_agentic_organization" | "ensure_org_memory_group") {
    return (ctx: BuildTxContext, params: OrganizationObjectParams): any => {
        const tx = new ctx.Transaction();
        tx.moveCall({
            target: memoryTarget(ctx, fn),
            arguments: [
                tx.object(ctx.memoryAccountId),
                tx.object(params.organizationId),
                tx.object(ctx.chain.clockId ?? MYSO_CLOCK),
            ],
        });
        return tx;
    };
}

export const buildDeactivateOrganizationTx = organizationObjectAction("deactivate_agentic_organization");
export const buildEnsureOrganizationMemoryGroupTx = organizationObjectAction("ensure_org_memory_group");

function organizationTreasuryCoinType(value: string): string {
    const normalized = canonicalCoinType(value);
    if (normalized !== value) throw new TypeError("coinType must use its canonical fully-qualified form");
    return normalized;
}

export function buildGrantOrganizationTreasuryAccessTx(ctx: BuildTxContext, params: OrganizationTreasuryAccessParams): any {
    if (!ADDRESS.test(params.recipient)) throw new TypeError("recipient must be a MySo address");
    const tx = new ctx.Transaction();
    tx.moveCall({
        target: memoryTarget(ctx, "grant_org_treasury_access"),
        arguments: [
            tx.object(ctx.memoryAccountId),
            tx.object(params.organizationId),
            tx.object(params.orgMemoryGroupId),
            tx.pure("address", params.recipient),
            tx.pure("bool", params.hasAccess),
            tx.object(ctx.chain.clockId ?? MYSO_CLOCK),
        ],
    });
    return tx;
}

export function buildWithdrawOrganizationTreasuryTx(ctx: BuildTxContext, params: OrganizationTreasuryWithdrawParams): any {
    if (!ADDRESS.test(params.recipient)) throw new TypeError("recipient must be a MySo address");
    if (!/^[1-9][0-9]{0,19}$/.test(params.amountBaseUnits) || BigInt(params.amountBaseUnits) > MAX_U64) throw new TypeError("amountBaseUnits must be a positive u64 decimal string");
    const tx = new ctx.Transaction();
    tx.moveCall({
        target: memoryTarget(ctx, "withdraw_from_org_treasury"),
        typeArguments: [organizationTreasuryCoinType(params.coinType)],
        arguments: [
            tx.object(ctx.memoryAccountId),
            tx.object(params.organizationId),
            tx.object(params.orgMemoryGroupId),
            tx.pure("address", params.recipient),
            tx.pure("u64", params.amountBaseUnits),
            tx.object(ctx.chain.clockId ?? MYSO_CLOCK),
        ],
    });
    return tx;
}

export function buildFundOrganizationTreasuryTx(ctx: BuildTxContext, params: OrganizationTreasuryFundParams): any {
    if (!/^[1-9][0-9]{0,19}$/.test(params.amountBaseUnits) || BigInt(params.amountBaseUnits) > MAX_U64) throw new TypeError("amountBaseUnits must be a positive u64 decimal string");
    const tx = new ctx.Transaction();
    tx.moveCall({
        target: memoryTarget(ctx, "fund_org_treasury"),
        typeArguments: [organizationTreasuryCoinType(params.coinType)],
        arguments: [
            tx.object(params.organizationId),
            tx.object(params.paymentCoinId),
            tx.pure("u64", params.amountBaseUnits),
            tx.object(ctx.chain.clockId ?? MYSO_CLOCK),
        ],
    });
    return tx;
}

export function buildDefineOrganizationRoleTx(ctx: BuildTxContext, params: DefineOrganizationRoleParams): any {
    const tx = new ctx.Transaction();
    tx.moveCall({
        target: memoryTarget(ctx, "define_custom_org_role"),
        arguments: [
            tx.object(ctx.chain.memoryConfigId),
            tx.object(ctx.memoryAccountId),
            tx.object(params.organizationId),
            tx.object(params.orgMemoryGroupId),
            tx.pure("string", params.roleName),
            tx.pure("u64", u64(params.permissionsMask, "0", "permissionsMask")),
            tx.object(ctx.chain.clockId ?? MYSO_CLOCK),
        ],
    });
    return tx;
}

function organizationRoleAction(fn: "assign_org_role" | "revoke_org_role") {
    return (ctx: BuildTxContext, params: OrganizationRoleParams): any => {
        const tx = new ctx.Transaction();
        tx.moveCall({
            target: memoryTarget(ctx, fn),
            arguments: [
                tx.object(ctx.memoryAccountId),
                tx.object(params.organizationId),
                tx.object(params.orgMemoryGroupId),
                tx.pure("address", params.memberAddress),
                tx.pure("string", params.roleName),
                tx.object(ctx.chain.clockId ?? MYSO_CLOCK),
            ],
        });
        return tx;
    };
}

export const buildAssignOrganizationRoleTx = organizationRoleAction("assign_org_role");
export const buildRevokeOrganizationRoleTx = organizationRoleAction("revoke_org_role");

export function buildCreateOrganizationInvitationTx(ctx: BuildTxContext, params: CreateOrganizationInvitationParams): any {
    const tx = new ctx.Transaction();
    tx.moveCall({
        target: memoryTarget(ctx, "create_org_invitation"),
        arguments: [
            tx.object(ctx.memoryAccountId),
            tx.object(params.organizationId),
            tx.object(params.orgMemoryGroupId),
            tx.pure("address", params.invitee),
            optString(tx, params.roleName),
            tx.pure("u64", u64(params.permissionsMask, "0", "permissionsMask")),
            optU64String(tx, params.expiresAtMs, "expiresAtMs"),
            tx.object(ctx.chain.clockId ?? MYSO_CLOCK),
        ],
    });
    return tx;
}

export function buildAcceptOrganizationInvitationTx(ctx: BuildTxContext, params: OrganizationInvitationDecisionParams): any {
    if (!params.orgMemoryGroupId) throw new TypeError("orgMemoryGroupId is required to accept an invitation");
    const tx = new ctx.Transaction();
    tx.moveCall({
        target: memoryTarget(ctx, "accept_org_invitation"),
        arguments: [
            tx.object(params.organizationAccountId),
            tx.object(params.organizationId),
            tx.object(params.orgMemoryGroupId),
            tx.pure("address", params.invitee),
            tx.object(ctx.chain.clockId ?? MYSO_CLOCK),
        ],
    });
    return tx;
}

export function buildDeclineOrganizationInvitationTx(ctx: BuildTxContext, params: OrganizationInvitationDecisionParams): any {
    const tx = new ctx.Transaction();
    tx.moveCall({
        target: memoryTarget(ctx, "decline_org_invitation"),
        arguments: [
            tx.object(params.organizationAccountId),
            tx.object(params.organizationId),
            tx.pure("address", params.invitee),
            tx.object(ctx.chain.clockId ?? MYSO_CLOCK),
        ],
    });
    return tx;
}

export function buildRegisterRootAgentTx(ctx: BuildTxContext, params: RegisterRootAgentParams): any {
    const tx = new ctx.Transaction();
    tx.moveCall({
        target: memoryTarget(ctx, "register_sub_agent"),
        arguments: [
            tx.object(ctx.chain.memoryConfigId),
            tx.object(ctx.memoryAccountId),
            tx.object(params.organizationId),
            ...agentPolicyArguments(tx, params),
            tx.object(ctx.chain.clockId ?? MYSO_CLOCK),
        ],
    });
    return tx;
}

export function buildRegisterChildAgentTx(ctx: BuildTxContext, params: RegisterChildAgentParams): any {
    const tx = new ctx.Transaction();
    tx.moveCall({
        target: memoryTarget(ctx, "register_sub_agent_delegated"),
        arguments: [
            tx.object(ctx.chain.memoryConfigId),
            tx.object(ctx.memoryAccountId),
            tx.object(params.parentAgentObjectId),
            ...agentPolicyArguments(tx, params),
            tx.pure("u8", params.registerRelation),
            tx.object(ctx.chain.clockId ?? MYSO_CLOCK),
        ],
    });
    return tx;
}

export function buildUpdateManagedAgentTx(ctx: BuildTxContext, params: UpdateManagedAgentParams): any {
    const tx = new ctx.Transaction();
    tx.moveCall({
        target: memoryTarget(ctx, "update_sub_agent"),
        arguments: [
            tx.object(ctx.memoryAccountId),
            tx.object(params.agentObjectId),
            tx.pure("u8", params.identityClass),
            tx.pure("u64", u64(params.roleTags, "0", "roleTags")),
            tx.pure("u64", u64(params.capabilities, "0", "capabilities")),
            tx.pure("u64", u64(params.delegatableCaps, "0", "delegatableCaps")),
            tx.pure("u8", params.registerScope),
            tx.pure("u64", u64(params.approvalRequiredCaps, "0", "approvalRequiredCaps")),
            optU64String(tx, params.maxActionSpendMist, "maxActionSpendMist"),
            optAddressString(tx, params.platformScope, "platformScope"),
            optU64String(tx, params.expiresAtMs, "expiresAtMs"),
            tx.object(ctx.chain.clockId ?? MYSO_CLOCK),
        ],
    });
    return tx;
}

function managedAgentAction(fn: "deactivate_sub_agent" | "revoke_sub_agent") {
    return (ctx: BuildTxContext, params: ManagedAgentParams): any => {
        const tx = new ctx.Transaction();
        tx.moveCall({
            target: memoryTarget(ctx, fn),
            arguments: [
                tx.object(ctx.memoryAccountId),
                tx.object(params.agentObjectId),
                tx.object(ctx.chain.clockId ?? MYSO_CLOCK),
            ],
        });
        return tx;
    };
}

export const buildDeactivateManagedAgentTx = managedAgentAction("deactivate_sub_agent");
export const buildRevokeManagedAgentTx = managedAgentAction("revoke_sub_agent");

export function buildCreateMessagingGroupTx(ctx: BuildTxContext, params: CreateMessagingGroupParams): any {
    if (params.initialMembers.length === 0 || params.initialMembers.length > 32) {
        throw new TypeError("initialMembers must contain between 1 and 32 addresses");
    }
    if (!params.initialMembers.every((member) => ADDRESS.test(member))) {
        throw new TypeError("initialMembers must contain only addresses");
    }
    const encryptedDek = hexBytes(params.encryptedDekHex, "encryptedDekHex");
    if (encryptedDek.length === 0 || encryptedDek.length > 4096) {
        throw new TypeError("encryptedDekHex must contain between 1 and 4096 bytes");
    }
    if (params.roomKind !== undefined && params.roomKind !== AGENT_ROOM_KIND) {
        throw new TypeError("roomKind must be 1 (agent room)");
    }
    if (params.roomTaskId !== undefined) {
        if (params.roomKind === undefined) {
            throw new TypeError("roomTaskId requires roomKind");
        }
        if (!ADDRESS.test(params.roomTaskId)) {
            throw new TypeError("roomTaskId must be an object id");
        }
    }
    const tx = new ctx.Transaction();
    const packageId = requiredChainField(ctx.chain, "messagingPackageId");
    tx.moveCall({
        target: `${packageId}::messaging::create_agent_and_share_group`,
        arguments: [
            tx.object(requiredChainField(ctx.chain, "messagingVersionId")),
            tx.object(requiredChainField(ctx.chain, "messagingNamespaceId")),
            tx.object(requiredChainField(ctx.chain, "messagingGroupManagerId")),
            tx.object(requiredChainField(ctx.chain, "messagingGroupLeaverId")),
            tx.object(ctx.chain.blockListRegistryId),
            tx.object(params.platformObjectId ?? ctx.chain.platformObjectId),
            tx.object(ctx.chain.memoryConfigId),
            tx.object(ctx.memoryAccountId),
            tx.object(params.crossPrincipalPeerAccountId ?? ctx.memoryAccountId),
            tx.pure("string", params.name),
            tx.pure("string", params.uuid),
            tx.pure("vector<u8>", encryptedDek),
            tx.pure("vector<address>", params.initialMembers),
            optU8(tx, params.roomKind),
            // `ID` has the same BCS bytes as an address.
            optAddress(tx, params.roomTaskId),
            tx.object(ctx.chain.clockId ?? MYSO_CLOCK),
        ],
    });
    return tx;
}

export function buildBindAgentRoomToTaskTx(ctx: BuildTxContext, params: BindAgentRoomToTaskParams): any {
    if (!ADDRESS.test(params.groupId) || !ADDRESS.test(params.taskId)) {
        throw new TypeError("groupId and taskId must be MySo object ids");
    }
    const tx = new ctx.Transaction();
    const packageId = requiredChainField(ctx.chain, "messagingPackageId");
    tx.moveCall({
        target: `${packageId}::messaging::bind_agent_room_to_task`,
        arguments: [
            tx.object(requiredChainField(ctx.chain, "messagingVersionId")),
            tx.object(requiredChainField(ctx.chain, "messagingGroupManagerId")),
            tx.object(params.groupId),
            tx.object(params.taskId),
            tx.object(ctx.chain.blockListRegistryId),
            tx.object(params.platformObjectId ?? ctx.chain.platformObjectId),
            tx.object(ctx.chain.memoryConfigId),
            tx.object(ctx.memoryAccountId),
            tx.object(ctx.chain.clockId ?? MYSO_CLOCK),
        ],
    });
    return tx;
}
