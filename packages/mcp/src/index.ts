/**
 * @socialproof/memory-mcp — stdio MCP bridge to Memory relayer + social actions.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Memory } from "@socialproof/memory";
import { SocialClient } from "@socialproof/social";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CRED_PATH = path.join(os.homedir(), ".memory", "credentials.json");

interface Credentials {
    key: string;
    accountId: string;
    serverUrl?: string;
    platformId?: string;
    ownerCoSignKey?: string;
    socialEnabled?: boolean;
}

function loadCredentials(): Credentials {
    const raw = fs.readFileSync(CRED_PATH, "utf8");
    return JSON.parse(raw) as Credentials;
}

function loadClients() {
    const creds = loadCredentials();
    const memory = Memory.create({
        key: creds.key,
        accountId: creds.accountId,
        serverUrl: creds.serverUrl,
        platformId: creds.platformId,
    });
    const social =
        creds.socialEnabled !== false
            ? SocialClient.create({
                  key: creds.key,
                  accountId: creds.accountId,
                  serverUrl: creds.serverUrl,
                  platformId: creds.platformId,
                  ownerCoSignKey: creds.ownerCoSignKey,
              })
            : null;
    return { memory, social, creds };
}

async function main() {
    const { memory, social } = loadClients();
    const server = new Server(
        { name: "memory-mcp", version: "0.2.0" },
        { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        const tools: Tool[] = [
            {
                name: "memory_remember",
                description: "Store text in encrypted agent memory (async job + wait)",
                inputSchema: {
                    type: "object",
                    properties: {
                        text: { type: "string" },
                        subLabel: { type: "string" },
                    },
                    required: ["text"],
                },
            },
            {
                name: "memory_recall",
                description: "Semantic recall from agent memory",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: { type: "string" },
                        limit: { type: "number" },
                    },
                    required: ["query"],
                },
            },
            {
                name: "memory_health",
                description: "Check memory relayer health",
                inputSchema: { type: "object", properties: {} },
            },
        ];

        if (social) {
            tools.push(
                {
                    name: "social_create_post",
                    description: "Publish a post on MySocial (requires CAP_POST_PUBLISH)",
                    inputSchema: {
                        type: "object",
                        properties: { content: { type: "string" } },
                        required: ["content"],
                    },
                },
                {
                    name: "social_create_comment",
                    description: "Comment on a post (requires CAP_COMMENT)",
                    inputSchema: {
                        type: "object",
                        properties: {
                            postId: { type: "string" },
                            content: { type: "string" },
                            parentCommentId: { type: "string" },
                        },
                        required: ["postId", "content"],
                    },
                },
                {
                    name: "social_react_post",
                    description: "React to a post (requires CAP_REACT)",
                    inputSchema: {
                        type: "object",
                        properties: {
                            postId: { type: "string" },
                            reaction: { type: "string" },
                        },
                        required: ["postId", "reaction"],
                    },
                },
                {
                    name: "social_react_comment",
                    description: "React to a comment (requires CAP_REACT)",
                    inputSchema: {
                        type: "object",
                        properties: {
                            commentId: { type: "string" },
                            reaction: { type: "string" },
                        },
                        required: ["commentId", "reaction"],
                    },
                },
                {
                    name: "social_create_repost",
                    description: "Repost or quote-repost (requires CAP_POST_PUBLISH)",
                    inputSchema: {
                        type: "object",
                        properties: {
                            originalPostId: { type: "string" },
                            content: { type: "string" },
                        },
                        required: ["originalPostId"],
                    },
                },
                {
                    name: "social_delete_post",
                    description:
                        "Delete a post — REQUIRES ownerCoSignKey in credentials and human approval",
                    inputSchema: {
                        type: "object",
                        properties: { postId: { type: "string" } },
                        required: ["postId"],
                    },
                },
                {
                    name: "social_delete_comment",
                    description:
                        "Delete a comment — REQUIRES ownerCoSignKey in credentials and human approval",
                    inputSchema: {
                        type: "object",
                        properties: {
                            postId: { type: "string" },
                            commentId: { type: "string" },
                        },
                        required: ["postId", "commentId"],
                    },
                },
            );
        }

        return { tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const name = req.params.name;
        const args = (req.params.arguments ?? {}) as Record<string, unknown>;

        if (name === "memory_remember") {
            const text = String(args.text ?? "");
            const subLabel = args.subLabel ? String(args.subLabel) : undefined;
            const result = await memory.rememberAndWait(text, subLabel);
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
        if (name === "memory_recall") {
            const query = String(args.query ?? "");
            const limit = typeof args.limit === "number" ? args.limit : 5;
            const result = await memory.recall(query, limit);
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
        if (name === "memory_health") {
            const health = await memory.health();
            return { content: [{ type: "text", text: JSON.stringify(health) }] };
        }

        if (!social) {
            throw new Error(`Unknown tool: ${name}`);
        }

        if (name === "social_create_post") {
            const result = await social.createPost({
                content: String(args.content ?? ""),
            });
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
        if (name === "social_create_comment") {
            const result = await social.createComment({
                postId: String(args.postId ?? ""),
                content: String(args.content ?? ""),
                parentCommentId: args.parentCommentId
                    ? String(args.parentCommentId)
                    : undefined,
            });
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
        if (name === "social_react_post") {
            const result = await social.reactToPost({
                postId: String(args.postId ?? ""),
                reaction: String(args.reaction ?? ""),
            });
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
        if (name === "social_react_comment") {
            const result = await social.reactToComment({
                commentId: String(args.commentId ?? ""),
                reaction: String(args.reaction ?? ""),
            });
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
        if (name === "social_create_repost") {
            const result = await social.createRepost({
                originalPostId: String(args.originalPostId ?? ""),
                content: args.content ? String(args.content) : undefined,
            });
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
        if (name === "social_delete_post") {
            const result = await social.deletePost(String(args.postId ?? ""));
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
        if (name === "social_delete_comment") {
            const result = await social.deleteComment({
                postId: String(args.postId ?? ""),
                commentId: String(args.commentId ?? ""),
            });
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }

        throw new Error(`Unknown tool: ${name}`);
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
