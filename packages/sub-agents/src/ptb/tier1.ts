import type {
    EditCommentParams,
    EditPostParams,
    ProfileRelationParams,
    RemoveCommentReactionParams,
    RemovePostReactionParams,
    RemoveRepostParams,
    SendMessageParams,
    SocialChainConfig,
} from "../types.js";
import type { BuildTxContext } from "./post.js";
import {
    MYSO_CLOCK,
    optAddressVec,
    optString,
    optStringVec,
    postModuleTarget,
    resolvePlatformObjectId,
} from "./helpers.js";

function requiredChainField(
    chain: SocialChainConfig,
    field: keyof SocialChainConfig,
): string {
    const value = chain[field];
    if (typeof value !== "string" || !value.trim()) {
        throw new TypeError(`${String(field)} is required for this action`);
    }
    return value;
}

function socialActorObjects(ctx: BuildTxContext, tx: any, platformOverride?: string) {
    return {
        registry: tx.object(ctx.chain.usernameRegistryId),
        platform: tx.object(resolvePlatformObjectId(ctx.chain, platformOverride)),
        blockList: tx.object(ctx.chain.blockListRegistryId),
        postConfig: tx.object(ctx.chain.postConfigId),
        memoryConfig: tx.object(ctx.chain.memoryConfigId),
        memoryAccount: tx.object(ctx.memoryAccountId),
        clock: tx.object(ctx.chain.clockId ?? MYSO_CLOCK),
    };
}

export function buildRemovePostReactionTx(
    ctx: BuildTxContext,
    params: RemovePostReactionParams,
): any {
    const tx = new ctx.Transaction();
    const o = socialActorObjects(ctx, tx, params.platformObjectId);
    tx.moveCall({
        target: postModuleTarget(ctx.chain, "remove_post_reaction"),
        arguments: [
            o.registry,
            tx.object(params.postId),
            o.platform,
            o.blockList,
            o.memoryConfig,
            o.memoryAccount,
            o.clock,
        ],
    });
    return tx;
}

export function buildRemoveCommentReactionTx(
    ctx: BuildTxContext,
    params: RemoveCommentReactionParams,
): any {
    const tx = new ctx.Transaction();
    const o = socialActorObjects(ctx, tx, params.platformObjectId);
    tx.moveCall({
        target: postModuleTarget(ctx.chain, "remove_comment_reaction"),
        arguments: [
            o.registry,
            tx.object(params.commentId),
            o.platform,
            o.blockList,
            o.memoryConfig,
            o.memoryAccount,
            o.clock,
        ],
    });
    return tx;
}

export function buildEditPostTx(ctx: BuildTxContext, params: EditPostParams): any {
    const tx = new ctx.Transaction();
    const o = socialActorObjects(ctx, tx, params.platformObjectId);
    tx.moveCall({
        target: postModuleTarget(ctx.chain, "edit_post"),
        arguments: [
            o.registry,
            o.platform,
            o.blockList,
            o.postConfig,
            o.memoryConfig,
            o.memoryAccount,
            tx.object(params.postId),
            tx.pure("string", params.content),
            optStringVec(tx, params.mediaUrls),
            optAddressVec(tx, params.mentions),
            optString(tx, params.metadataJson),
            o.clock,
        ],
    });
    return tx;
}

export function buildEditCommentTx(
    ctx: BuildTxContext,
    params: EditCommentParams,
): any {
    const tx = new ctx.Transaction();
    const o = socialActorObjects(ctx, tx, params.platformObjectId);
    tx.moveCall({
        target: postModuleTarget(ctx.chain, "edit_comment"),
        arguments: [
            o.registry,
            o.platform,
            o.blockList,
            o.postConfig,
            o.memoryConfig,
            o.memoryAccount,
            tx.object(params.commentId),
            tx.pure("string", params.content),
            optAddressVec(tx, params.mentions),
            o.clock,
        ],
    });
    return tx;
}

export function buildRemoveRepostTx(
    ctx: BuildTxContext,
    params: RemoveRepostParams,
): any {
    const tx = new ctx.Transaction();
    const o = socialActorObjects(ctx, tx, params.platformObjectId);
    tx.moveCall({
        target: postModuleTarget(ctx.chain, "remove_repost"),
        arguments: [
            o.registry,
            o.platform,
            o.blockList,
            o.memoryConfig,
            o.memoryAccount,
            tx.object(params.originalPostId),
            tx.object(params.repostId),
            o.clock,
        ],
    });
    return tx;
}

function buildProfileRelationTx(
    functionName: "follow_profile" | "unfollow_profile" | "block_profile" | "unblock_profile",
    ctx: BuildTxContext,
    params: ProfileRelationParams,
): any {
    const tx = new ctx.Transaction();
    const o = socialActorObjects(ctx, tx, params.platformObjectId);
    const graph = tx.object(requiredChainField(ctx.chain, "socialGraphId"));
    const common = [o.memoryConfig, o.memoryAccount, o.platform, o.blockList];
    tx.moveCall({
        target: `${ctx.chain.packageId}::social_graph::${functionName}`,
        arguments:
            functionName === "block_profile" || functionName === "follow_profile" || functionName === "unfollow_profile"
                ? [...common, graph, tx.pure("address", params.targetOwner), o.clock]
                : [...common, tx.pure("address", params.targetOwner), o.clock],
    });
    return tx;
}

export const buildFollowProfileTx = (ctx: BuildTxContext, params: ProfileRelationParams) =>
    buildProfileRelationTx("follow_profile", ctx, params);
export const buildUnfollowProfileTx = (ctx: BuildTxContext, params: ProfileRelationParams) =>
    buildProfileRelationTx("unfollow_profile", ctx, params);
export const buildBlockProfileTx = (ctx: BuildTxContext, params: ProfileRelationParams) =>
    buildProfileRelationTx("block_profile", ctx, params);
export const buildUnblockProfileTx = (ctx: BuildTxContext, params: ProfileRelationParams) =>
    buildProfileRelationTx("unblock_profile", ctx, params);

function hexBytes(value: string): number[] {
    if (!/^[0-9a-f]{64}$/.test(value)) {
        throw new TypeError("contentDigestHex must be 64 lowercase hex characters");
    }
    return Array.from({ length: 32 }, (_, index) =>
        Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
    );
}

export function validateSendMessageParams(params: SendMessageParams): void {
    hexBytes(params.contentDigestHex);
    if (params.contentUri.length > 2048) throw new TypeError("contentUri exceeds 2048 characters");
    if (!params.contentUri.startsWith("wal://")) {
        let parsed: URL;
        try {
            parsed = new URL(params.contentUri);
        } catch {
            throw new TypeError("contentUri must be a wal:// or https:// URI");
        }
        if (parsed.protocol !== "https:") {
            throw new TypeError("contentUri must be a wal:// or https:// URI");
        }
    }
    if (new TextEncoder().encode(params.dedupeKey).length > 256) {
        throw new TypeError("dedupeKey exceeds 256 bytes");
    }
    if (!/^(0|[1-9][0-9]{0,38})$/.test(params.nonce)) {
        throw new TypeError("nonce must be an unsigned u128 decimal string");
    }
    if (BigInt(params.nonce) > ((1n << 128n) - 1n)) {
        throw new TypeError("nonce exceeds u128");
    }
}

export function buildSendMessageTx(ctx: BuildTxContext, params: SendMessageParams): any {
    validateSendMessageParams(params);
    const tx = new ctx.Transaction();
    const o = socialActorObjects(ctx, tx, params.platformObjectId);
    const packageId = requiredChainField(ctx.chain, "messagingPackageId");
    tx.moveCall({
        target: `${packageId}::messaging::send_agent_message_digest`,
        arguments: [
            tx.object(requiredChainField(ctx.chain, "messagingVersionId")),
            tx.object(requiredChainField(ctx.chain, "messagingConfigId")),
            tx.object(params.groupId),
            tx.object(params.messageLogId),
            o.blockList,
            o.platform,
            o.memoryConfig,
            o.memoryAccount,
            tx.pure("address", params.recipient),
            tx.pure("vector<u8>", hexBytes(params.contentDigestHex)),
            tx.pure("string", params.contentUri),
            tx.pure("vector<u8>", Array.from(new TextEncoder().encode(params.dedupeKey))),
            tx.pure("u128", params.nonce),
            o.clock,
        ],
    });
    return tx;
}
