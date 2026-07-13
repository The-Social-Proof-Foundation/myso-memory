import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { MCP_PACKAGE_VERSION, MCP_SERVER_NAME } from "./version.js";
import { createToolCatalog, executeTool, type ToolDependencies } from "./tools.js";

export function createMemoryMcpServer(dependencies: ToolDependencies): Server {
    const socialToolNames = dependencies.social?.supportedToolNames ?? [];
    const server = new Server(
        { name: MCP_SERVER_NAME, version: MCP_PACKAGE_VERSION },
        {
            capabilities: { tools: {} },
            instructions:
                "Use memory tools for encrypted recall and registered social tools for agent-authorized actions. Tool annotations are descriptive; server and chain policy remain authoritative.",
        },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: createToolCatalog(socialToolNames, dependencies.oauthScopes),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
        const name = request.params.name;
        const args = (request.params.arguments ?? {}) as Record<string, unknown>;
        const envelope = await executeTool(name, args, dependencies);
        const summary = envelope.ok
            ? `${name} completed successfully.`
            : `${envelope.error.code}: ${envelope.error.message}`;
        return {
            content: [{ type: "text", text: summary }],
            structuredContent: envelope as unknown as Record<string, unknown>,
            ...(envelope.ok ? {} : { isError: true }),
        };
    });

    return server;
}
