import type { BuildTxContext } from "./post.js";

const ADDRESS = /^0x[0-9a-fA-F]{1,64}$/;

export interface OwnerRotationContext extends BuildTxContext {
    memoryRegistryId: string;
}

export interface ProposeOwnerRotationParams {
    profileId: string;
    newOwner: string;
    agentObjectIds: string[];
    organizationObjectIds: string[];
}

export interface OwnerRotationReferencesParams {
    agentObjectIds: string[];
    organizationObjectIds: string[];
}

export type OwnerRotationActionParams =
    | (ProposeOwnerRotationParams & { stage?: "propose" })
    | (OwnerRotationReferencesParams & { stage: "accept"; profileId: string; newOwner: string; finalize: boolean })
    | (OwnerRotationReferencesParams & { stage: "rollback"; newOwner: string })
    | { stage: "cancel" };

export const OWNER_ROTATION_MAX_REFERENCES_PER_TRANSACTION = 6;

function address(value: string, label: string): string {
    if (!ADDRESS.test(value)) throw new TypeError(`${label} must be a MySo address`);
    return value;
}

function assertDistinctIds(values: string[], label: string): void {
    const seen = new Set<string>();
    for (const value of values) {
        const id = address(value, label).replace(/^0x/i, "").toLowerCase().padStart(64, "0");
        if (seen.has(id)) throw new TypeError(`${label} must not contain duplicates`);
        seen.add(id);
    }
}

function idVector(tx: any, ids: string[]): unknown {
    // Move's object::ID is a one-address wrapper, so vector<address> has identical BCS bytes.
    return tx.pure("vector<address>", ids.map((id) => address(id, "object ID")));
}

function clock(ctx: OwnerRotationContext): string {
    return ctx.chain.clockId ?? "0x6";
}

export function buildProposeOwnerRotationTx(
    ctx: OwnerRotationContext,
    params: ProposeOwnerRotationParams,
): any {
    address(ctx.memoryRegistryId, "memoryRegistryId");
    address(ctx.memoryAccountId, "memoryAccountId");
    address(ctx.chain.usernameRegistryId, "usernameRegistryId");
    address(params.profileId, "profileId");
    address(params.newOwner, "newOwner");
    assertDistinctIds(params.agentObjectIds, "agentObjectIds");
    assertDistinctIds(params.organizationObjectIds, "organizationObjectIds");

    const tx = new ctx.Transaction();
    tx.moveCall({
        target: `${ctx.chain.packageId}::profile::propose_owner_rotation`,
        arguments: [
            tx.object(ctx.chain.usernameRegistryId),
            tx.object(ctx.memoryRegistryId),
            tx.object(ctx.memoryAccountId),
            tx.object(params.profileId),
            tx.pure("address", params.newOwner),
            idVector(tx, params.agentObjectIds),
            idVector(tx, params.organizationObjectIds),
            tx.object(clock(ctx)),
        ],
    });
    return tx;
}

export function buildAcceptOwnerRotationTx(
    ctx: OwnerRotationContext,
    params: OwnerRotationReferencesParams & { profileId: string },
): any {
    return buildAcceptOwnerRotationBatchTx(ctx, { ...params, finalize: true });
}

export function buildAcceptOwnerRotationBatchTx(
    ctx: OwnerRotationContext,
    params: OwnerRotationReferencesParams & { profileId: string; finalize: boolean },
): any {
    address(ctx.memoryRegistryId, "memoryRegistryId");
    address(ctx.memoryAccountId, "memoryAccountId");
    address(ctx.chain.usernameRegistryId, "usernameRegistryId");
    address(params.profileId, "profileId");
    assertDistinctIds(params.agentObjectIds, "agentObjectIds");
    assertDistinctIds(params.organizationObjectIds, "organizationObjectIds");
    if (typeof params.finalize !== "boolean"
        || params.agentObjectIds.length + params.organizationObjectIds.length > OWNER_ROTATION_MAX_REFERENCES_PER_TRANSACTION
        || (!params.finalize && params.agentObjectIds.length + params.organizationObjectIds.length === 0)) {
        throw new TypeError("Owner migration acceptance must update at most six references; an empty batch is allowed only for finalization");
    }

    const tx = new ctx.Transaction();
    const account = tx.object(ctx.memoryAccountId);
    for (const agentId of params.agentObjectIds) {
        tx.moveCall({
            target: `${ctx.chain.packageId}::memory::accept_agent_owner_rotation_reference`,
            arguments: [account, tx.object(address(agentId, "agentObjectId")), tx.object(clock(ctx))],
        });
    }
    for (const organizationId of params.organizationObjectIds) {
        tx.moveCall({
            target: `${ctx.chain.packageId}::memory::accept_organization_owner_rotation_reference`,
            arguments: [account, tx.object(address(organizationId, "organizationObjectId")), tx.object(clock(ctx))],
        });
    }
    if (params.finalize) {
        tx.moveCall({
            target: `${ctx.chain.packageId}::profile::accept_owner_rotation`,
            arguments: [
                tx.object(ctx.chain.usernameRegistryId),
                tx.object(ctx.memoryRegistryId),
                account,
                tx.object(params.profileId),
                tx.object(clock(ctx)),
            ],
        });
    }
    return tx;
}

export function buildRollbackOwnerRotationReferencesTx(
    ctx: OwnerRotationContext,
    params: OwnerRotationReferencesParams,
): any {
    address(ctx.memoryAccountId, "memoryAccountId");
    assertDistinctIds(params.agentObjectIds, "agentObjectIds");
    assertDistinctIds(params.organizationObjectIds, "organizationObjectIds");
    if (params.agentObjectIds.length + params.organizationObjectIds.length < 1
        || params.agentObjectIds.length + params.organizationObjectIds.length > OWNER_ROTATION_MAX_REFERENCES_PER_TRANSACTION) {
        throw new TypeError("Owner migration rollback must contain between one and six references");
    }

    const tx = new ctx.Transaction();
    const account = tx.object(ctx.memoryAccountId);
    for (const agentId of params.agentObjectIds) {
        tx.moveCall({
            target: `${ctx.chain.packageId}::memory::rollback_agent_owner_rotation_reference`,
            arguments: [account, tx.object(address(agentId, "agentObjectId")), tx.object(clock(ctx))],
        });
    }
    for (const organizationId of params.organizationObjectIds) {
        tx.moveCall({
            target: `${ctx.chain.packageId}::memory::rollback_organization_owner_rotation_reference`,
            arguments: [account, tx.object(address(organizationId, "organizationObjectId")), tx.object(clock(ctx))],
        });
    }
    return tx;
}

export function buildCancelOwnerRotationTx(ctx: OwnerRotationContext): any {
    address(ctx.memoryAccountId, "memoryAccountId");
    const tx = new ctx.Transaction();
    tx.moveCall({
        target: `${ctx.chain.packageId}::memory::cancel_owner_rotation`,
        arguments: [tx.object(ctx.memoryAccountId)],
    });
    return tx;
}

export function buildOwnerRotationActionTx(ctx: OwnerRotationContext, params: OwnerRotationActionParams): any {
    if (params.stage === undefined || params.stage === "propose") {
        if (!("profileId" in params) || !("newOwner" in params)) throw new TypeError("Owner migration proposal requires profileId and newOwner");
        return buildProposeOwnerRotationTx(ctx, params);
    }
    if (params.stage === "accept") return buildAcceptOwnerRotationBatchTx(ctx, params);
    if (params.stage === "rollback") return buildRollbackOwnerRotationReferencesTx(ctx, params);
    if (params.stage === "cancel") return buildCancelOwnerRotationTx(ctx);
    throw new TypeError("Unsupported owner migration stage");
}
