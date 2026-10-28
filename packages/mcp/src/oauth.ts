import type { IncomingMessage } from "node:http";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { McpRuntimeError } from "./errors.js";

export interface OAuthIntrospectionVerifierOptions {
    introspectionUrl: string;
    clientId: string;
    clientSecret: string;
    resourceUrl: string;
    fetch?: typeof globalThis.fetch;
}

/** RFC 7662 verifier. Introspection on every MCP request makes token revocation immediate. */
export class OAuthIntrospectionVerifier implements OAuthTokenVerifier {
    private readonly fetchImpl: typeof globalThis.fetch;
    private readonly resource: URL;

    constructor(private readonly options: OAuthIntrospectionVerifierOptions) {
        if (!options.introspectionUrl.startsWith("https://") && !options.introspectionUrl.startsWith("http://localhost")) {
            throw new McpRuntimeError("INVALID_CONFIGURATION", "OAuth introspection must use HTTPS.");
        }
        if (!options.clientId || !options.clientSecret) {
            throw new McpRuntimeError("INVALID_CONFIGURATION", "OAuth introspection client credentials are required.");
        }
        this.fetchImpl = options.fetch ?? globalThis.fetch;
        this.resource = new URL(options.resourceUrl);
    }

    async verifyAccessToken(token: string): Promise<AuthInfo> {
        const form = new URLSearchParams({ token, token_type_hint: "access_token" });
        const basic = Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString("base64");
        const response = await this.fetchImpl(this.options.introspectionUrl, {
            method: "POST",
            headers: {
                authorization: `Basic ${basic}`,
                "content-type": "application/x-www-form-urlencoded",
                accept: "application/json",
            },
            body: form,
        });
        if (!response.ok) {
            throw new McpRuntimeError("AUTHENTICATION_FAILED", "OAuth token introspection failed.");
        }
        const result = await response.json() as Record<string, unknown>;
        if (result.active !== true) {
            throw new McpRuntimeError("AUTHENTICATION_FAILED", "OAuth token is inactive or revoked.");
        }
        const walletAddress = typeof result.wallet_address === "string" ? result.wallet_address : "";
        const audience = Array.isArray(result.aud) ? result.aud : [result.aud];
        const expected = normalizeResource(this.resource);
        const audienceMatches = audience.some((value) => typeof value === "string" && safeNormalizedResource(value) === expected);
        if (!audienceMatches && !walletAddress) {
            throw new McpRuntimeError("AUTHENTICATION_FAILED", "OAuth token audience is invalid.");
        }
        const scopes = typeof result.scope === "string" ? result.scope.split(/\s+/).filter(Boolean) : [];
        const clientId = typeof result.client_id === "string" ? result.client_id : "";
        if (!clientId) {
            throw new McpRuntimeError("AUTHENTICATION_FAILED", "OAuth token client_id is missing.");
        }
        return {
            token,
            clientId,
            scopes: scopes.length > 0 ? scopes : walletAddress ? ["mcp:connect", "agent:read"] : scopes,
            expiresAt: typeof result.exp === "number" ? result.exp : undefined,
            resource: this.resource,
            extra: {
                accountId: result.account_id,
                agentObjectId: result.agent_object_id,
                signerSessionId: result.signer_session_id,
                ...(walletAddress ? { walletAddress } : {}),
                ...(typeof result.key_id === "string" ? { keyId: result.key_id } : {}),
                ...(typeof result.expected_address === "string"
                    ? { expectedAddress: result.expected_address }
                    : typeof result.derived_address === "string"
                        ? { expectedAddress: result.derived_address }
                        : {}),
            },
        };
    }
}

function safeNormalizedResource(value: string): string {
    try {
        return normalizeResource(new URL(value));
    } catch {
        return "";
    }
}

export interface HostedMcpPrincipal {
    auth: AuthInfo;
    accountId: string;
    agentObjectId: string;
    signerSessionId: string;
    /** Ephemeral MyData session supplied by the client vault; forwarded only for work_run_* tools. */
    myDataSession?: string;
    /** Narrow service-issued identity for one unattended action-worker run. */
    workerRun?: {
        credential: string;
        runId: string;
        workerAgentObjectId: string;
        workerCapabilities: number;
        workerMaxActionSpend: string;
        delegateRef: string;
        allowedActionIds: readonly string[];
        expiresAt: string;
        taskId: string | null;
        allowPrivateGraph: boolean;
        allowRoomHistory: boolean;
        allowPrivateTaskArtifacts: boolean;
        allowPrivateContentSharing: boolean;
    };
}

function extraString(auth: AuthInfo, name: string): string {
    const value = auth.extra?.[name];
    if (typeof value !== "string" || !value.trim()) {
        throw new McpRuntimeError("AUTHENTICATION_FAILED", `OAuth token is missing ${name}.`);
    }
    return value;
}

export interface WalletPrincipalBinding {
    accountId: string;
    agentObjectId: string;
    signerSessionId: string;
}

export async function authenticateHostedRequest(
    request: IncomingMessage,
    verifier: OAuthTokenVerifier,
    resource: URL,
    resolveWalletPrincipal?: (walletAddress: string, boundAgentId?: string) => Promise<WalletPrincipalBinding | null>,
): Promise<HostedMcpPrincipal> {
    const header = request.headers.authorization;
    const match = typeof header === "string" ? /^Bearer ([A-Za-z0-9._~+\/-]+=*)$/.exec(header) : null;
    if (!match) {
        throw new McpRuntimeError("AUTHENTICATION_FAILED", "A Bearer access token is required.");
    }
    const auth = await verifier.verifyAccessToken(match[1]);
    const boundHeader = request.headers["x-myso-bound-agent"];
    if (Array.isArray(boundHeader)) throw new McpRuntimeError("INVALID_ARGUMENT", "Only one bound agent may be supplied.");
    const boundAgentId = typeof boundHeader === "string" && boundHeader.length > 0 ? boundHeader : undefined;
    if (boundAgentId && !/^0x[0-9a-f]{1,64}$/i.test(boundAgentId)) {
        throw new McpRuntimeError("AUTHENTICATION_FAILED", "The bound agent id is invalid.");
    }
    const walletAddress = typeof auth.extra?.walletAddress === "string" ? auth.extra.walletAddress : "";
    const alreadyBound = ["accountId", "agentObjectId", "signerSessionId"].every((name) => typeof auth.extra?.[name] === "string" && String(auth.extra?.[name]).trim());
    if ((!alreadyBound || boundAgentId) && walletAddress && resolveWalletPrincipal) {
        const resolved = await resolveWalletPrincipal(walletAddress, boundAgentId);
        if (resolved) {
            auth.extra = { ...auth.extra, accountId: resolved.accountId, agentObjectId: resolved.agentObjectId, signerSessionId: resolved.signerSessionId };
        }
    } else if (boundAgentId && !walletAddress) {
        throw new McpRuntimeError("AUTHENTICATION_FAILED", "A bound agent requires a verified wallet session.");
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (auth.expiresAt !== undefined && auth.expiresAt <= nowSeconds) {
        throw new McpRuntimeError("AUTHENTICATION_FAILED", "The OAuth access token expired.");
    }
    if (!auth.scopes.includes("mcp:connect")) {
        throw new McpRuntimeError("CAPABILITY_DENIED", "The OAuth token lacks mcp:connect.");
    }
    if (!auth.resource || normalizeResource(auth.resource) !== normalizeResource(resource)) {
        throw new McpRuntimeError("AUTHENTICATION_FAILED", "The OAuth token audience does not match this MCP resource.");
    }
    const myDataSessionHeader = request.headers["x-mydata-session"];
    if (Array.isArray(myDataSessionHeader)) {
        throw new McpRuntimeError("INVALID_ARGUMENT", "Only one MyData session may be supplied.");
    }
    const myDataSession = typeof myDataSessionHeader === "string" ? myDataSessionHeader : undefined;
    if (myDataSession !== undefined && (!/^[A-Za-z0-9+/]+={0,2}$/.test(myDataSession) || myDataSession.length > 32_768)) {
        throw new McpRuntimeError("INVALID_ARGUMENT", "The MyData session is malformed or exceeds the size limit.");
    }
    return {
        auth,
        accountId: extraString(auth, "accountId"),
        agentObjectId: extraString(auth, "agentObjectId"),
        signerSessionId: extraString(auth, "signerSessionId"),
        ...(myDataSession ? { myDataSession } : {}),
    };
}

function normalizeResource(value: URL): string {
    const copy = new URL(value);
    copy.hash = "";
    return copy.toString().replace(/\/$/, "");
}
