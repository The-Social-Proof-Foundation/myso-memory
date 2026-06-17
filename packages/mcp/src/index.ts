/**
 * @socialproof/memory-mcp — stdio MCP bridge to Memory relayer.
 *
 * Credentials: ~/.memory/credentials.json
 *   { "key": "<sub-agent-private-key-hex>", "accountId": "<memory-account-id>", "serverUrl": "..." }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Memory } from "@socialproof/memory";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CRED_PATH = path.join(os.homedir(), ".memory", "credentials.json");

function loadClient(): Memory {
    const raw = fs.readFileSync(CRED_PATH, "utf8");
    const creds = JSON.parse(raw) as {
        key: string;
        accountId: string;
        serverUrl?: string;
    };
    return Memory.create({
        key: creds.key,
        accountId: creds.accountId,
        serverUrl: creds.serverUrl,
    });
}

async function main() {
    const client = loadClient();
    const server = new Server(
        { name: "memory-mcp", version: "0.1.0" },
        { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
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
        ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const name = req.params.name;
        const args = (req.params.arguments ?? {}) as Record<string, unknown>;

        if (name === "memory_remember") {
            const text = String(args.text ?? "");
            const subLabel = args.subLabel ? String(args.subLabel) : undefined;
            const result = await client.rememberAndWait(text, subLabel);
            return {
                content: [{ type: "text", text: JSON.stringify(result) }],
            };
        }
        if (name === "memory_recall") {
            const query = String(args.query ?? "");
            const limit = typeof args.limit === "number" ? args.limit : 5;
            const result = await client.recall(query, limit);
            return {
                content: [{ type: "text", text: JSON.stringify(result) }],
            };
        }
        if (name === "memory_health") {
            const health = await client.health();
            return {
                content: [{ type: "text", text: JSON.stringify(health) }],
            };
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
