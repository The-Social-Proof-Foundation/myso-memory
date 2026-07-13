import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpRuntimeError, toStructuredMcpError } from "./errors.js";
import { authenticateHostedRequest, type HostedMcpPrincipal } from "./oauth.js";
import { createMemoryMcpServer } from "./server.js";
import type { ToolDependencies } from "./tools.js";

export interface HostedMcpOptions {
    verifier: OAuthTokenVerifier;
    resourceUrl: string;
    authorizationServerUrl: string;
    allowedHosts: readonly string[];
    allowedOrigins?: readonly string[];
    maxContentLength?: number;
    createDependencies(principal: HostedMcpPrincipal): Promise<ToolDependencies>;
    destroyDependencies?(dependencies: ToolDependencies): void | Promise<void>;
}

export function createHostedMcpHttpServer(options: HostedMcpOptions): Server {
    const resource = new URL(options.resourceUrl);
    if (resource.protocol !== "https:" && resource.hostname !== "localhost") {
        throw new McpRuntimeError("INVALID_CONFIGURATION", "Hosted MCP resourceUrl must use HTTPS.");
    }
    if (options.allowedHosts.length === 0) {
        throw new McpRuntimeError("INVALID_CONFIGURATION", "Hosted MCP allowedHosts must not be empty.");
    }
    return createServer((request, response) => {
        void handleHostedRequest(request, response, options, resource);
    });
}

async function handleHostedRequest(
    request: IncomingMessage,
    response: ServerResponse,
    options: HostedMcpOptions,
    resource: URL,
): Promise<void> {
    try {
        applySecurityHeaders(response);
        const url = new URL(request.url ?? "/", resource);
        if (url.pathname === "/.well-known/oauth-protected-resource") {
            if (request.method !== "GET") return methodNotAllowed(response, "GET");
            return json(response, 200, {
                resource: resource.toString().replace(/\/$/, ""),
                authorization_servers: [options.authorizationServerUrl],
                scopes_supported: [
                    "mcp:connect", "memory:read", "memory:write", "chain:read",
                    "social:write", "social:publish", "social:approve", "social:destructive", "ai:spend",
                    "messaging:read", "organization:read", "organization:admin", "agent:provision",
                ],
            });
        }
        if (url.pathname !== "/mcp") return json(response, 404, { error: "not_found" });
        assertHostAndOrigin(request, options);
        const length = Number(request.headers["content-length"] ?? 0);
        if (!Number.isFinite(length) || length < 0 || length > (options.maxContentLength ?? 1_048_576)) {
            return json(response, 413, { error: "request_too_large" });
        }
        const principal = await authenticateHostedRequest(request, options.verifier, resource);
        const dependencies = await options.createDependencies(principal);
        const scopedDependencies: ToolDependencies = {
            ...dependencies,
            oauthScopes: new Set(principal.auth.scopes),
        };
        const server = createMemoryMcpServer(scopedDependencies);
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
        });
        (request as IncomingMessage & { auth?: typeof principal.auth }).auth = principal.auth;
        try {
            await server.connect(transport);
            await transport.handleRequest(request, response);
        } finally {
            await server.close();
            await options.destroyDependencies?.(dependencies);
        }
    } catch (error) {
        if (response.headersSent) {
            response.destroy();
            return;
        }
        const structured = toStructuredMcpError(error);
        const status = structured.code === "AUTHENTICATION_FAILED" ? 401
            : structured.code === "CAPABILITY_DENIED" ? 403 : 400;
        if (status === 401) {
            response.setHeader(
                "WWW-Authenticate",
                `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource", resource).toString()}"`,
            );
        }
        json(response, status, { error: structured });
    }
}

function assertHostAndOrigin(request: IncomingMessage, options: HostedMcpOptions): void {
    let host = "";
    try {
        host = new URL(`http://${request.headers.host ?? ""}`).hostname.toLowerCase();
    } catch {
        throw new McpRuntimeError("AUTHENTICATION_FAILED", "Host is invalid.");
    }
    if (!options.allowedHosts.map((value) => value.toLowerCase()).includes(host)) {
        throw new McpRuntimeError("AUTHENTICATION_FAILED", "Host is not allowed.");
    }
    const origin = request.headers.origin;
    if (origin && !(options.allowedOrigins ?? []).includes(origin)) {
        throw new McpRuntimeError("AUTHENTICATION_FAILED", "Origin is not allowed.");
    }
}

function applySecurityHeaders(response: ServerResponse): void {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
}

function methodNotAllowed(response: ServerResponse, allow: string): void {
    response.setHeader("Allow", allow);
    json(response, 405, { error: "method_not_allowed" });
}

function json(response: ServerResponse, status: number, body: unknown): void {
    response.statusCode = status;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify(body));
}
