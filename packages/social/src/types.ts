export interface SocialChainConfig {
    packageId: string;
    usernameRegistryId: string;
    platformRegistryId: string;
    platformObjectId: string;
    blockListRegistryId: string;
    postConfigId: string;
    mydataRegistryId: string;
    clockId?: string;
}

export interface SocialClientConfig {
    key: string | Uint8Array;
    accountId: string;
    serverUrl?: string;
    platformId?: string;
    /** Required for delete_post / delete_comment (signs HTTP co-sign + on-chain tx). */
    ownerCoSignKey?: string | Uint8Array;
}

export interface CreatePostParams {
    content: string;
    platformObjectId?: string;
    mediaUrls?: string[];
    mentions?: string[];
    metadataJson?: string;
    allowComments?: boolean;
    allowReactions?: boolean;
    allowReposts?: boolean;
    allowQuotes?: boolean;
    allowTips?: boolean;
    enableSpt?: boolean;
    enablePoc?: boolean;
    enableSpot?: boolean;
    mydataId?: string;
}

export interface CreateCommentParams {
    postId: string;
    content: string;
    parentCommentId?: string;
    mediaUrls?: string[];
    mentions?: string[];
    metadataJson?: string;
}

export interface ReactToPostParams {
    postId: string;
    reaction: string;
    platformObjectId?: string;
}

export interface ReactToCommentParams {
    commentId: string;
    reaction: string;
    platformObjectId?: string;
}

export interface CreateRepostParams {
    originalPostId: string;
    content?: string;
    platformObjectId?: string;
    mediaUrls?: string[];
    mentions?: string[];
    metadataJson?: string;
    allowComments?: boolean;
    allowReactions?: boolean;
    allowReposts?: boolean;
    allowQuotes?: boolean;
    allowTips?: boolean;
    enableSpt?: boolean;
    enablePoc?: boolean;
    enableSpot?: boolean;
}

export interface DeleteCommentParams {
    postId: string;
    commentId: string;
}

export interface SocialActionResult {
    digest: string;
    postId?: string;
    commentId?: string;
    repostId?: string;
    deleted?: boolean;
}

export type SocialExecuteAction =
    | "create_post"
    | "create_comment"
    | "react_to_post"
    | "react_to_comment"
    | "create_repost"
    | "delete_post"
    | "delete_comment";
