import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConfigError, loadConfig } from "./config.js";

const GOOD = {
    JUROR_WEBHOOK_SECRET: "w".repeat(16),
    JUROR_SALT_SECRET: "s".repeat(32),
    SOCIAL_SERVER_URL: "https://social.example.com/",
    INFERENCE_URL: "https://llm.example.com/v1/",
    INFERENCE_API_KEY: "key",
    INFERENCE_MODEL: "judge-1",
};

describe("loadConfig", () => {
    it("reads a complete environment and applies defaults", () => {
        const config = loadConfig(GOOD);
        assert.equal(config.port, 8012);
        assert.equal(config.socialServerUrl, "https://social.example.com");
        assert.equal(config.inference.kind === "openai" && config.inference.url, "https://llm.example.com/v1");
        assert.deepEqual(config.evidenceAllowedHosts, []);
        assert.equal(config.ipfsGateway, "https://ipfs.io/ipfs/");
        assert.equal(config.production, false);
    });

    it("refuses a missing or short secret", () => {
        for (const [name, value] of [
            ["JUROR_WEBHOOK_SECRET", undefined],
            ["JUROR_WEBHOOK_SECRET", "short"],
            ["JUROR_SALT_SECRET", undefined],
            ["JUROR_SALT_SECRET", "s".repeat(31)],
        ] as const) {
            assert.throws(() => loadConfig({ ...GOOD, [name]: value }), ConfigError, `${name}=${value}`);
        }
    });

    it("keeps the salt secret apart from the webhook secret", () => {
        const same = "x".repeat(40);
        assert.throws(() => loadConfig({ ...GOOD, JUROR_WEBHOOK_SECRET: same, JUROR_SALT_SECRET: same }), /differ/);
    });

    it("insists on https in production only", () => {
        assert.doesNotThrow(() => loadConfig({ ...GOOD, SOCIAL_SERVER_URL: "http://localhost:3000" }));
        assert.throws(() => loadConfig({ ...GOOD, NODE_ENV: "production", SOCIAL_SERVER_URL: "http://social" }));
        assert.throws(() => loadConfig({ ...GOOD, NODE_ENV: "production", INFERENCE_URL: "http://llm" }));
    });

    it("parses lists and bounds numbers", () => {
        const config = loadConfig({ ...GOOD, EVIDENCE_ALLOWED_HOSTS: " A.example.com, ,b.example.com ", PORT: "9000" });
        assert.deepEqual(config.evidenceAllowedHosts, ["a.example.com", "b.example.com"]);
        assert.equal(config.port, 9000);
        assert.throws(() => loadConfig({ ...GOOD, PORT: "0" }), ConfigError);
        assert.throws(() => loadConfig({ ...GOOD, PORT: "abc" }), ConfigError);
    });

    it("bills a juror to an inference agent's AI credit when asked", () => {
        const gateway = {
            ...GOOD,
            INFERENCE_PROVIDER: "gateway",
            GATEWAY_SERVER_URL: "https://relayer.example.com/",
            GATEWAY_AGENT_KEY: "ab".repeat(32),
            GATEWAY_ACCOUNT_ID: "0xacct",
            GATEWAY_MODEL_ID: "anthropic/claude-sonnet",
        };
        const { INFERENCE_URL: _u, INFERENCE_API_KEY: _k, INFERENCE_MODEL: _m, ...onlyGateway } = gateway;
        const loaded = loadConfig(onlyGateway).inference;
        assert.equal(loaded.kind, "gateway");
        assert.equal(loaded.kind === "gateway" && loaded.serverUrl, "https://relayer.example.com");
        assert.equal(loaded.kind === "gateway" && loaded.maxTokens, 2048);
        assert.throws(() => loadConfig({ ...onlyGateway, GATEWAY_AGENT_KEY: "short" }), /32-byte hex/);
        assert.throws(() => loadConfig({ ...onlyGateway, INFERENCE_PROVIDER: "nonsense" }), /openai/);
        assert.throws(() => loadConfig({ ...onlyGateway, NODE_ENV: "production", GATEWAY_SERVER_URL: "http://x.test" }), /https/);
    });
});
