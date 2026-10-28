import assert from "node:assert/strict";
import test from "node:test";
import { createHostedDependencies, loadHostedMcpConfig, startHostedMcpServer } from "../dist/index.js";

const baseEnv = {
    MCP_RESOURCE_URL: "http://localhost/mcp",
    MCP_AUTHORIZATION_SERVER_URL: "http://localhost",
    MCP_OAUTH_INTROSPECTION_URL: "http://localhost/introspect",
    MCP_OAUTH_CLIENT_ID: "mcp",
    MCP_OAUTH_CLIENT_SECRET: "secret",
    MEMORY_SERVER_URL: "http://127.0.0.1:9",
    AUTOMATION_BRIDGE_URL: "http://127.0.0.1:8011",
    AUTOMATION_ENGINE_URL: "http://127.0.0.1:8010",
    INTERNAL_SYNC_SECRET: "sync-secret",
    MCP_ALLOWED_HOSTS: "127.0.0.1",
    PORT: "0",
};

test("hosted config refuses to boot without the memory service and bridge", () => {
    assert.throws(() => loadHostedMcpConfig({}), /MCP_RESOURCE_URL is required/);
    assert.throws(() => loadHostedMcpConfig({ ...baseEnv, MCP_RESOURCE_URL: "https://mcp.example" }), /public \/mcp URL/);
    assert.throws(() => loadHostedMcpConfig({ ...baseEnv, AUTOMATION_BRIDGE_URL: "" }), /AUTOMATION_BRIDGE_URL is required/);
    assert.throws(() => loadHostedMcpConfig({ ...baseEnv, MEMORY_SERVER_URL: "" }), /MEMORY_SERVER_URL is required/);
    assert.throws(() => loadHostedMcpConfig({ ...baseEnv, INTERNAL_SYNC_SECRET: "" }), /INTERNAL_SYNC_SECRET is required/);
    const withoutLogin = { ...baseEnv };
    delete withoutLogin.MCP_AUTHORIZATION_SERVER_URL;
    delete withoutLogin.MCP_OAUTH_INTROSPECTION_URL;
    delete withoutLogin.MCP_OAUTH_CLIENT_ID;
    delete withoutLogin.MCP_OAUTH_CLIENT_SECRET;
    assert.equal(loadHostedMcpConfig(withoutLogin).authorizationServerUrl, "https://auth.testnet.mysocial.network/");
});

test("hosted HTTP answers health and rejects an anonymous MCP call", async () => {
    const server = startHostedMcpServer(loadHostedMcpConfig(baseEnv));
    await new Promise((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
    });
    try {
        const address = server.address();
        assert.equal(typeof address, "object");
        const base = `http://127.0.0.1:${address.port}`;
        const health = await fetch(`${base}/health`);
        assert.equal(health.status, 200);
        assert.equal((await health.json()).status, "ok");
        const rejected = await fetch(`${base}/mcp`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
        });
        assert.equal(rejected.status, 401);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test("a verified login builds dependencies without a delegate key", () => {
    const config = loadHostedMcpConfig(baseEnv);
    const dependencies = createHostedDependencies(config, {
        auth: { token: "t", clientId: "c", scopes: ["mcp:connect", "agent:read"], expiresAt: Math.floor(Date.now() / 1000) + 60, extra: {} },
        accountId: "0x1",
        agentObjectId: "0x2",
        signerSessionId: "session",
    });
    assert.equal(typeof dependencies.memory.getAgentContext, "function");
    assert.equal(dependencies.social?.supportedToolNames.includes("agent_get_context"), true);
});
