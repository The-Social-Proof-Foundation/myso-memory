import type { SocialClient } from "@socialproof/social";
import type { PluginConfig } from "../types.js";

export function registerSocialTools(
    api: any,
    social: SocialClient,
    config: PluginConfig,
): void {
    if (!config.socialEnabled) return;

    api.registerTool({
        name: "social_create_post",
        description:
            `Publish a post on MySocial platform ${config.platformId ?? "(default)"}. Requires CAP_POST_PUBLISH.`,
        parameters: {
            type: "object",
            properties: {
                content: { type: "string", description: "Post body text" },
            },
            required: ["content"],
        },
        async execute(_id: string, params: { content: string }) {
            const result = await social.createPost({ content: params.content });
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        },
    });

    api.registerTool({
        name: "social_create_comment",
        description: "Comment on a post. Requires CAP_COMMENT.",
        parameters: {
            type: "object",
            properties: {
                postId: { type: "string" },
                content: { type: "string" },
                parentCommentId: { type: "string" },
            },
            required: ["postId", "content"],
        },
        async execute(
            _id: string,
            params: { postId: string; content: string; parentCommentId?: string },
        ) {
            const result = await social.createComment({
                postId: params.postId,
                content: params.content,
                parentCommentId: params.parentCommentId,
            });
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        },
    });

    api.registerTool({
        name: "social_react_post",
        description: "React to a post (toggle). Requires CAP_REACT.",
        parameters: {
            type: "object",
            properties: {
                postId: { type: "string" },
                reaction: { type: "string" },
            },
            required: ["postId", "reaction"],
        },
        async execute(_id: string, params: { postId: string; reaction: string }) {
            const result = await social.reactToPost({
                postId: params.postId,
                reaction: params.reaction,
            });
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        },
    });

    api.registerTool({
        name: "social_react_comment",
        description: "React to a comment. Requires CAP_REACT.",
        parameters: {
            type: "object",
            properties: {
                commentId: { type: "string" },
                reaction: { type: "string" },
            },
            required: ["commentId", "reaction"],
        },
        async execute(_id: string, params: { commentId: string; reaction: string }) {
            const result = await social.reactToComment({
                commentId: params.commentId,
                reaction: params.reaction,
            });
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        },
    });

    api.registerTool({
        name: "social_create_repost",
        description: "Repost or quote-repost. Requires CAP_POST_PUBLISH.",
        parameters: {
            type: "object",
            properties: {
                originalPostId: { type: "string" },
                content: { type: "string", description: "Quote text (omit for standard repost)" },
            },
            required: ["originalPostId"],
        },
        async execute(
            _id: string,
            params: { originalPostId: string; content?: string },
        ) {
            const result = await social.createRepost({
                originalPostId: params.originalPostId,
                content: params.content,
            });
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        },
    });

    if (config.ownerCoSignKey) {
        api.registerTool({
            name: "social_delete_post",
            description:
                "Delete a post (human owner co-sign required). On-chain sender is the principal owner.",
            parameters: {
                type: "object",
                properties: { postId: { type: "string" } },
                required: ["postId"],
            },
            async execute(_id: string, params: { postId: string }) {
                const result = await social.deletePost(params.postId);
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
            },
        });

        api.registerTool({
            name: "social_delete_comment",
            description:
                "Delete a comment (human owner co-sign required). On-chain sender is the principal owner.",
            parameters: {
                type: "object",
                properties: {
                    postId: { type: "string" },
                    commentId: { type: "string" },
                },
                required: ["postId", "commentId"],
            },
            async execute(
                _id: string,
                params: { postId: string; commentId: string },
            ) {
                const result = await social.deleteComment({
                    postId: params.postId,
                    commentId: params.commentId,
                });
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
            },
        });
    }
}
