export interface ParsedTxEffects {
    digest: string;
    postId?: string;
    commentId?: string;
    repostId?: string;
    deleted?: boolean;
}

export function parseSocialTxEffects(
    digest: string,
    txResult: any,
): ParsedTxEffects {
    const out: ParsedTxEffects = { digest };
    const objectChanges = txResult?.objectChanges ?? txResult?.effects?.objectChanges ?? [];

    for (const change of objectChanges) {
        const type = change.objectType as string | undefined;
        if (!type) continue;
        if (change.type === "created") {
            if (type.includes("::post::Post") && !type.includes("Repost")) {
                out.postId = change.objectId;
            } else if (type.includes("::post::Comment")) {
                out.commentId = change.objectId;
            } else if (type.includes("::post::Repost")) {
                out.repostId = change.objectId;
            }
        }
        if (change.type === "deleted") {
            if (type.includes("::post::Post")) {
                out.deleted = true;
                out.postId = change.objectId;
            } else if (type.includes("::post::Comment")) {
                out.deleted = true;
                out.commentId = change.objectId;
            }
        }
    }

    const events = txResult?.events ?? txResult?.effects?.events ?? [];
    for (const event of events) {
        const type = event.type as string | undefined;
        const parsed = event.parsedJson ?? event.parsed_json;
        if (!type || !parsed) continue;
        if (type.includes("PostCreatedEvent") && parsed.post_id) {
            out.postId = parsed.post_id;
        }
        if (type.includes("CommentCreatedEvent") && parsed.comment_id) {
            out.commentId = parsed.comment_id;
        }
        if (type.includes("RepostEvent") && parsed.repost_id) {
            out.repostId = parsed.repost_id;
        }
        if (type.includes("PostDeletedEvent")) {
            out.deleted = true;
            if (parsed.post_id) out.postId = parsed.post_id;
        }
        if (type.includes("CommentDeletedEvent")) {
            out.deleted = true;
            if (parsed.comment_id) out.commentId = parsed.comment_id;
        }
    }

    return out;
}
