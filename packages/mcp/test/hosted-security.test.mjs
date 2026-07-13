import assert from "node:assert/strict";
import test from "node:test";
import {
    KmsSessionAgentSigner,
    OAuthIntrospectionVerifier,
    authenticateHostedRequest,
    createHostedMcpHttpServer,
    createToolCatalog,
} from "../dist/index.js";

const resource = new URL("https://mcp.mysocial.network/mcp");

test("hosted OAuth binds audience, scopes, account, agent, and signer session", async () => {
    const verifier = {
        async verifyAccessToken(token) {
            assert.equal(token, "access-token");
            return {
                token,
                clientId: "agent-runtime",
                scopes: ["mcp:connect", "memory:read"],
                expiresAt: Math.floor(Date.now() / 1000) + 60,
                resource,
                extra: { accountId: "0x1", agentObjectId: "0x2", signerSessionId: "session-1" },
            };
        },
    };
    const principal = await authenticateHostedRequest(
        { headers: { authorization: "Bearer access-token" } },
        verifier,
        resource,
    );
    assert.equal(principal.accountId, "0x1");
    assert.equal(principal.agentObjectId, "0x2");
    assert.equal(principal.signerSessionId, "session-1");
    const tools = createToolCatalog([], new Set(principal.auth.scopes));
    assert.deepEqual(tools.map((tool) => tool.name), ["memory_recall", "memory_health"]);
});

test("OAuth introspection preserves scoped identity and observes revocation", async () => {
    let active = true;
    const verifier = new OAuthIntrospectionVerifier({
        introspectionUrl: "https://identity.mysocial.network/introspect",
        clientId: "mcp-resource",
        clientSecret: "test-secret",
        resourceUrl: resource.toString(),
        fetch: async (_url, init) => {
            assert.match(init.headers.authorization, /^Basic /);
            return new Response(JSON.stringify({
                active,
                client_id: "agent-client",
                scope: "mcp:connect social:write",
                exp: Math.floor(Date.now() / 1000) + 60,
                aud: resource.toString(),
                account_id: "0x1",
                agent_object_id: "0x2",
                signer_session_id: "session-1",
            }));
        },
    });
    assert.deepEqual((await verifier.verifyAccessToken("token")).scopes, ["mcp:connect", "social:write"]);
    active = false;
    await assert.rejects(() => verifier.verifyAccessToken("token"), /inactive or revoked/);
});

test("KMS session signer reauthorizes immediately before every signature", async () => {
    const operations = [];
    let active = true;
    const signer = new KmsSessionAgentSigner(
        {
            sessionId: "session-1",
            keyId: "kms-key-1",
            accountId: "0x1",
            agentObjectId: "0x2",
            expectedAddress: "0x3",
            expiresAtMs: Date.now() + 60_000,
        },
        {
            async getPublicKey() { return new Uint8Array(32); },
            async signEd25519() { return new Uint8Array(64); },
            async signTransaction() { return "serialized-transaction-signature"; },
        },
        {
            async assertActive(_policy, operation) {
                operations.push(operation);
                if (!active) throw new Error("revoked");
            },
        },
    );
    await signer.sign(new Uint8Array([1]));
    await signer.signTransaction(new Uint8Array([2]));
    assert.deepEqual(operations, ["http-auth", "transaction"]);
    active = false;
    await assert.rejects(() => signer.signTransaction(new Uint8Array([3])), /revoked/);
    signer.destroy();
});

test("Streamable HTTP publishes resource metadata and rejects unauthenticated MCP calls", async () => {
    const server = createHostedMcpHttpServer({
        verifier: { async verifyAccessToken() { throw new Error("not called without token"); } },
        resourceUrl: "http://localhost/mcp",
        authorizationServerUrl: "https://identity.mysocial.network",
        allowedHosts: ["127.0.0.1"],
        async createDependencies() { throw new Error("must not create dependencies"); },
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const address = server.address();
        const base = `http://127.0.0.1:${address.port}`;
        const metadata = await fetch(`${base}/.well-known/oauth-protected-resource`);
        assert.equal(metadata.status, 200);
        assert.equal((await metadata.json()).authorization_servers[0], "https://identity.mysocial.network");
        const rejected = await fetch(`${base}/mcp`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        });
        assert.equal(rejected.status, 401);
        assert.match(rejected.headers.get("www-authenticate"), /oauth-protected-resource/);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test("authorized Streamable HTTP completes MCP initialization", async () => {
    const hostedResource = new URL("http://localhost/mcp");
    const server = createHostedMcpHttpServer({
        verifier: {
            async verifyAccessToken(token) {
                return {
                    token, clientId: "client", scopes: ["mcp:connect", "memory:read"],
                    expiresAt: Math.floor(Date.now() / 1000) + 60, resource: hostedResource,
                    extra: { accountId: "0x1", agentObjectId: "0x2", signerSessionId: "session-1" },
                };
            },
        },
        resourceUrl: hostedResource.toString(),
        authorizationServerUrl: "https://identity.mysocial.network",
        allowedHosts: ["127.0.0.1"],
        async createDependencies() {
            return {
                memory: {
                    async rememberAndWait() { return {}; },
                    async recall() { return {}; },
                    async health() { return { status: "ok" }; },
                },
            };
        },
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const address = server.address();
        const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
            method: "POST",
            headers: {
                authorization: "Bearer access-token",
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
                jsonrpc: "2.0", id: 1, method: "initialize",
                params: {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    clientInfo: { name: "hosted-test", version: "1.0.0" },
                },
            }),
        });
        const responseText = await response.text();
        assert.equal(response.status, 200, responseText);
        const body = JSON.parse(responseText);
        assert.equal(body.result.serverInfo.name, "memory-mcp");
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});
