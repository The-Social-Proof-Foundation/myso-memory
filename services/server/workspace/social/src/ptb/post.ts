import type { SocialChainConfig } from "../types.js";
import type {
    CreateCommentParams,
    CreatePostParams,
    CreateRepostParams,
    ReactToCommentParams,
    ReactToPostParams,
} from "../types.js";
import {
    MYSO_CLOCK,
    optAddress,
    optAddressVec,
    optBool,
    optString,
    optStringVec,
    postModuleTarget,
    resolvePlatformObjectId,
} from "./helpers.js";

export interface BuildTxContext {
    Transaction: new () => any;
    chain: SocialChainConfig;
    memoryAccountId: string;
}

function sharedObjects(
    tx: any,
    chain: SocialChainConfig,
    platformObjectId: string,
    memoryAccountId: string,
) {
    return {
        registry: tx.object(chain.usernameRegistryId),
        platformRegistry: tx.object(chain.platformRegistryId),
        platform: tx.object(platformObjectId),
        blockList: tx.object(chain.blockListRegistryId),
        postConfig: tx.object(chain.postConfigId),
        mydataRegistry: tx.object(chain.mydataRegistryId),
        memoryAccount: tx.object(memoryAccountId),
        clock: tx.object(chain.clockId ?? MYSO_CLOCK),
    };
}

export function buildCreatePostTx(
    ctx: BuildTxContext & { memoryAccountId: string },
    params: CreatePostParams,
): any {
    const { Transaction, chain, memoryAccountId } = ctx;
    const tx = new Transaction();
    const platformId = resolvePlatformObjectId(chain, params.platformObjectId);
    const objs = sharedObjects(tx, chain, platformId, memoryAccountId);

    tx.moveCall({
        target: postModuleTarget(chain, "create_post"),
        arguments: [
            objs.registry,
            objs.platformRegistry,
            objs.platform,
            objs.blockList,
            objs.postConfig,
            tx.pure("string", params.content),
            optStringVec(tx, params.mediaUrls),
            optAddressVec(tx, params.mentions),
            optString(tx, params.metadataJson),
            optBool(tx, params.allowComments),
            optBool(tx, params.allowReactions),
            optBool(tx, params.allowReposts),
            optBool(tx, params.allowQuotes),
            optBool(tx, params.allowTips),
            optBool(tx, params.enableSpt),
            optBool(tx, params.enablePoc),
            optBool(tx, params.enableSpot),
            optAddress(tx, params.mydataId),
            objs.mydataRegistry,
            objs.memoryAccount,
            objs.clock,
        ],
    });
    return tx;
}

export function buildCreateCommentTx(
    ctx: BuildTxContext,
    params: CreateCommentParams,
    platformObjectId?: string,
): any {
    const { Transaction, chain, memoryAccountId } = ctx;
    const tx = new Transaction();
    const platformId = resolvePlatformObjectId(chain, platformObjectId);
    const objs = sharedObjects(tx, chain, platformId, memoryAccountId);

    tx.moveCall({
        target: postModuleTarget(chain, "create_comment"),
        arguments: [
            objs.registry,
            objs.platformRegistry,
            objs.platform,
            objs.blockList,
            objs.postConfig,
            tx.object(params.postId),
            optAddress(tx, params.parentCommentId),
            tx.pure("string", params.content),
            optStringVec(tx, params.mediaUrls),
            optAddressVec(tx, params.mentions),
            optString(tx, params.metadataJson),
            objs.memoryAccount,
            objs.clock,
        ],
    });
    return tx;
}

export function buildReactToPostTx(
    ctx: BuildTxContext,
    params: ReactToPostParams,
): any {
    const { Transaction, chain, memoryAccountId } = ctx;
    const tx = new Transaction();
    const platformId = resolvePlatformObjectId(chain, params.platformObjectId);
    const objs = sharedObjects(tx, chain, platformId, memoryAccountId);

    tx.moveCall({
        target: postModuleTarget(chain, "react_to_post"),
        arguments: [
            objs.registry,
            tx.object(params.postId),
            objs.platformRegistry,
            objs.platform,
            objs.blockList,
            objs.postConfig,
            objs.memoryAccount,
            tx.pure("string", params.reaction),
            objs.clock,
        ],
    });
    return tx;
}

export function buildReactToCommentTx(
    ctx: BuildTxContext,
    params: ReactToCommentParams,
): any {
    const { Transaction, chain, memoryAccountId } = ctx;
    const tx = new Transaction();
    const platformId = resolvePlatformObjectId(chain, params.platformObjectId);
    const objs = sharedObjects(tx, chain, platformId, memoryAccountId);

    tx.moveCall({
        target: postModuleTarget(chain, "react_to_comment"),
        arguments: [
            objs.registry,
            tx.object(params.commentId),
            objs.platformRegistry,
            objs.platform,
            objs.blockList,
            objs.postConfig,
            objs.memoryAccount,
            tx.pure("string", params.reaction),
            objs.clock,
        ],
    });
    return tx;
}

export function buildCreateRepostTx(
    ctx: BuildTxContext,
    params: CreateRepostParams,
): any {
    const { Transaction, chain, memoryAccountId } = ctx;
    const tx = new Transaction();
    const platformId = resolvePlatformObjectId(chain, params.platformObjectId);
    const objs = sharedObjects(tx, chain, platformId, memoryAccountId);

    tx.moveCall({
        target: postModuleTarget(chain, "create_repost"),
        arguments: [
            objs.registry,
            objs.platformRegistry,
            objs.platform,
            objs.blockList,
            objs.postConfig,
            tx.object(params.originalPostId),
            optString(tx, params.content),
            optStringVec(tx, params.mediaUrls),
            optAddressVec(tx, params.mentions),
            optString(tx, params.metadataJson),
            optBool(tx, params.allowComments),
            optBool(tx, params.allowReactions),
            optBool(tx, params.allowReposts),
            optBool(tx, params.allowQuotes),
            optBool(tx, params.allowTips),
            optBool(tx, params.enableSpt),
            optBool(tx, params.enablePoc),
            optBool(tx, params.enableSpot),
            objs.memoryAccount,
            objs.clock,
        ],
    });
    return tx;
}

export function buildDeletePostTx(
    chain: SocialChainConfig,
    postId: string,
    Transaction: new () => any,
): any {
    const tx = new Transaction();
    tx.moveCall({
        target: postModuleTarget(chain, "delete_post"),
        arguments: [tx.object(postId)],
    });
    return tx;
}

export function buildDeleteCommentTx(
    chain: SocialChainConfig,
    postId: string,
    commentId: string,
    Transaction: new () => any,
): any {
    const tx = new Transaction();
    tx.moveCall({
        target: postModuleTarget(chain, "delete_comment"),
        arguments: [tx.object(postId), tx.object(commentId)],
    });
    return tx;
}
