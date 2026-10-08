/**
 * Config resolution tests.
 *
 * These exist because a bug here is invisible until runtime: `loadConfig`
 * originally omitted `agentKeysFile` from its return value, which type-checked
 * only because the field was also missing from the interface. The smoke test
 * caught it; this suite is what should have.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeInlineAgentKeys, loadConfig, resolveInternalSyncSecret } from "./config.js";

const SECRET_ENV = { INTERNAL_SYNC_SECRET: "shared-secret" };

describe("resolveInternalSyncSecret", () => {
    it("prefers the shared name over the legacy one", () => {
        assert.equal(
            resolveInternalSyncSecret({
                INTERNAL_SYNC_SECRET: "shared",
                AUTOMATION_INTERNAL_SYNC_SECRET: "legacy",
            }),
            "shared",
        );
    });

    it("falls back to the legacy name", () => {
        assert.equal(
            resolveInternalSyncSecret({ AUTOMATION_INTERNAL_SYNC_SECRET: "legacy" }),
            "legacy",
        );
    });

    it("treats blank as unset", () => {
        assert.equal(
            resolveInternalSyncSecret({
                INTERNAL_SYNC_SECRET: "   ",
                AUTOMATION_INTERNAL_SYNC_SECRET: "legacy",
            }),
            "legacy",
        );
    });

    it("returns empty when neither is set", () => {
        assert.equal(resolveInternalSyncSecret({}), "");
    });
});

describe("placeholder secret", () => {
    it("is refused in production", () => {
        assert.throws(
            () =>
                loadConfig({
                    INTERNAL_SYNC_SECRET: "dev-automation-secret",
                    NODE_ENV: "production",
                    AUTOMATION_AGENT_KEYS_FILE: "/tmp/agents.json",
                }),
            /placeholder/,
        );
    });

    it("is still allowed for local development", () => {
        const config = loadConfig({
            INTERNAL_SYNC_SECRET: "dev-automation-secret",
            AUTOMATION_AGENT_KEYS_FILE: "/tmp/agents.json",
        });
        assert.equal(config.internalSyncSecret, "dev-automation-secret");
    });

    it("does not reject a real secret in production", () => {
        const config = loadConfig({ ...PRODUCTION_ENV, INTERNAL_SYNC_SECRET: "a-long-random-value" });
        assert.equal(config.internalSyncSecret, "a-long-random-value");
    });
});

const PRODUCTION_ENV = {
    INTERNAL_SYNC_SECRET: "a-long-random-value",
    NODE_ENV: "production",
    AUTOMATION_MYDATA_PRIVATE_KEYS: "k1:" + "A".repeat(43),
    AUTOMATION_ENGINE_URL: "http://engine.internal:8010",
    MEMORY_SERVER_URL: "http://memory.internal:8000",
};

describe("production custody rules", () => {
    it("accepts encrypted delegates and disables static keys", () => {
        const config = loadConfig(PRODUCTION_ENV);
        assert.equal(config.allowStaticKeys, false);
        assert.equal(config.agentKeysFile, null);
        assert.equal(config.agentKeysJson, null);
        assert.equal(config.engineUrl, "http://engine.internal:8010");
    });

    it("refuses an inline plaintext key variable", () => {
        assert.throws(
            () => loadConfig({ ...PRODUCTION_ENV, AUTOMATION_AGENT_KEYS_JSON: "{}" }),
            /plaintext agent seeds/,
        );
    });

    it("refuses a plaintext key file", () => {
        assert.throws(
            () => loadConfig({ ...PRODUCTION_ENV, AUTOMATION_AGENT_KEYS_FILE: "/app/agents.json" }),
            /plaintext agent seeds/,
        );
    });

    it("requires the pieces delegates need", () => {
        for (const missing of [
            "AUTOMATION_MYDATA_PRIVATE_KEYS",
            "AUTOMATION_ENGINE_URL",
            "MEMORY_SERVER_URL",
        ] as const) {
            const env: Record<string, string | undefined> = { ...PRODUCTION_ENV };
            delete env[missing];
            assert.throws(() => loadConfig(env), /production needs/, missing);
        }
    });

    it("falls back to the events origin for the engine", () => {
        const env: Record<string, string | undefined> = {
            ...PRODUCTION_ENV,
            AUTOMATION_EVENTS_URL: "http://events.internal:8010",
        };
        delete env.AUTOMATION_ENGINE_URL;
        assert.equal(loadConfig(env).engineUrl, "http://events.internal:8010");
    });

    it("keeps static keys available for local development", () => {
        const config = loadConfig({
            INTERNAL_SYNC_SECRET: "x",
            AUTOMATION_AGENT_KEYS_FILE: "/tmp/agents.json",
        });
        assert.equal(config.allowStaticKeys, true);
        assert.equal(config.agentKeysFile, "/tmp/agents.json");
    });
});

describe("loadConfig", () => {
    it("refuses to start without a shared secret", () => {
        assert.throws(
            () => loadConfig({}),
            (err: unknown) =>
                err instanceof Error && err.message.includes("Refusing to start"),
        );
    });

    it("always returns a concrete agent keys file path", () => {
        // The regression this suite exists for.
        const config = loadConfig({ ...SECRET_ENV });
        assert.equal(typeof config.agentKeysFile, "string");
        assert.ok(config.agentKeysFile.length > 0, "agentKeysFile was empty");
        assert.ok(
            config.agentKeysFile.endsWith("agents.json"),
            `unexpected default: ${config.agentKeysFile}`,
        );
    });

    it("honours AUTOMATION_AGENT_KEYS_FILE", () => {
        const config = loadConfig({
            ...SECRET_ENV,
            AUTOMATION_AGENT_KEYS_FILE: "/tmp/custom-agents.json",
        });
        assert.equal(config.agentKeysFile, "/tmp/custom-agents.json");
    });

    it("defaults to loopback and port 8011", () => {
        const config = loadConfig({ ...SECRET_ENV });
        // Loopback matters: this process signs with agent keys, so exposing it
        // to a network has to be a deliberate choice.
        assert.equal(config.host, "127.0.0.1");
        assert.equal(config.port, 8011);
    });

    it("reads the injected env for integers, not process.env", () => {
        const config = loadConfig({
            ...SECRET_ENV,
            PORT: "9999",
            AUTOMATION_REQUEST_TIMEOUT_MS: "1234",
            AUTOMATION_MAX_BODY_BYTES: "2048",
        });
        assert.equal(config.port, 9999);
        assert.equal(config.requestTimeoutMs, 1234);
        assert.equal(config.maxBodyBytes, 2048);
    });

    it("rejects a non-positive integer instead of silently defaulting", () => {
        assert.throws(
            () => loadConfig({ ...SECRET_ENV, PORT: "0" }),
            (err: unknown) => err instanceof Error && err.message.includes("PORT"),
        );
        assert.throws(() => loadConfig({ ...SECRET_ENV, PORT: "-1" }), Error);
    });

    it("defaults the namespace to chat-app so jobs and the chat-app share a scope", () => {
        assert.equal(loadConfig({ ...SECRET_ENV }).defaultNamespace, "chat-app");
        assert.equal(
            loadConfig({ ...SECRET_ENV, AUTOMATION_DEFAULT_NAMESPACE: "isolated" }).defaultNamespace,
            "isolated",
        );
    });

    it("treats a blank optional value as unset", () => {
        const config = loadConfig({
            ...SECRET_ENV,
            MEMORY_SERVER_URL: "  ",
            AUTOMATION_EVENTS_URL: "",
            AUTOMATION_EVENTS_SECRET: "",
        });
        assert.equal(config.defaultServerUrl, undefined);
        assert.equal(config.eventsUrl, undefined);
        assert.equal(config.eventsSecret, undefined);
    });

    it("carries the memory relayer origin and event sink through", () => {
        const config = loadConfig({
            ...SECRET_ENV,
            MEMORY_SERVER_URL: "http://127.0.0.1:8000",
            AUTOMATION_EVENTS_URL: "http://127.0.0.1:8010",
            AUTOMATION_EVENTS_SECRET: "events-secret",
        });
        assert.equal(config.defaultServerUrl, "http://127.0.0.1:8000");
        assert.equal(config.eventsUrl, "http://127.0.0.1:8010");
        assert.equal(config.eventsSecret, "events-secret");
    });
});

describe("decodeInlineAgentKeys", () => {
    const JSON_KEYS = JSON.stringify({ agents: { demo: { key: "a".repeat(64), accountId: "0x1" } } });

    it("accepts raw JSON", () => {
        assert.equal(decodeInlineAgentKeys(JSON_KEYS), JSON_KEYS);
    });

    it("accepts base64 of the JSON", () => {
        const encoded = Buffer.from(JSON_KEYS, "utf8").toString("base64");
        assert.equal(decodeInlineAgentKeys(encoded), JSON_KEYS);
    });

    it("tolerates surrounding whitespace", () => {
        assert.equal(decodeInlineAgentKeys(`  ${JSON_KEYS}  `), JSON_KEYS);
        const encoded = Buffer.from(JSON_KEYS, "utf8").toString("base64");
        assert.equal(decodeInlineAgentKeys(`\n${encoded}\n`), JSON_KEYS);
    });

    it("rejects a value that is neither, instead of silently decoding to nothing", () => {
        // Buffer.from is lenient and would happily return nonsense here, so the
        // real check is that the decoded text parses as JSON.
        assert.throws(
            () => decodeInlineAgentKeys("not keys at all"),
            (err: unknown) => err instanceof Error && err.message.includes("AUTOMATION_AGENT_KEYS_JSON"),
        );
        assert.throws(() => decodeInlineAgentKeys("[]"), Error);
    });
});

describe("key source selection", () => {
    it("carries the decoded JSON through, not the raw base64", () => {
        // Regression: validating the decoded form while handing the store the raw
        // value made base64 keys fail at startup with "not valid JSON".
        const json = JSON.stringify({ agents: { demo: { key: "a".repeat(64), accountId: "0x1" } } });
        const config = loadConfig({
            ...SECRET_ENV,
            AUTOMATION_AGENT_KEYS_JSON: Buffer.from(json, "utf8").toString("base64"),
        });
        assert.equal(config.agentKeysJson, json);
        // Decoded keys mean there is no file to read.
        assert.equal(config.agentKeysFile, null);
    });

    it("prefers inline keys over a file path", () => {
        const json = JSON.stringify({ agents: { demo: { key: "a".repeat(64), accountId: "0x1" } } });
        const config = loadConfig({
            ...SECRET_ENV,
            AUTOMATION_AGENT_KEYS_JSON: json,
            AUTOMATION_AGENT_KEYS_FILE: "/tmp/ignored.json",
        });
        assert.equal(config.agentKeysJson, json);
        assert.equal(config.agentKeysFile, null);
    });

    it("falls back to the file when no inline value is set", () => {
        const config = loadConfig({ ...SECRET_ENV, AUTOMATION_AGENT_KEYS_FILE: "/tmp/agents.json" });
        assert.equal(config.agentKeysJson, null);
        assert.equal(config.agentKeysFile, "/tmp/agents.json");
    });

    it("rejects a malformed inline value at load, so a bad deploy fails its healthcheck", () => {
        assert.throws(
            () => loadConfig({ ...SECRET_ENV, AUTOMATION_AGENT_KEYS_JSON: "garbage" }),
            Error,
        );
    });
});

describe("container bind address", () => {
    it("still defaults to loopback, which is right on a laptop", () => {
        assert.equal(loadConfig({ ...SECRET_ENV }).host, "127.0.0.1");
    });

    it("honours HOST so a container can bind all interfaces", () => {
        // Railway does not set HOST; the image sets 0.0.0.0. Without this a
        // loopback-bound server logs a healthy startup and fails its healthcheck.
        assert.equal(loadConfig({ ...SECRET_ENV, HOST: "0.0.0.0" }).host, "0.0.0.0");
    });
});
