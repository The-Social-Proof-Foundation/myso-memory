import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GatewayInferenceClient, type GatewayCaller } from "./inference-gateway.js";
import { InferenceError } from "./inference.js";

function caller(overrides: Partial<Awaited<ReturnType<GatewayCaller["gatewayInference"]>>> = {}) {
    const calls: Array<Parameters<GatewayCaller["gatewayInference"]>[0]> = [];
    const fake: GatewayCaller = {
        async gatewayInference(params) {
            calls.push(params);
            return {
                content: '{"ok":true}',
                tokensIn: 10,
                tokensOut: 5,
                amountMist: 1_000,
                billingState: "captured",
                reserveDigest: "rd",
                captureDigest: "cd",
                providerGenerationId: "gen-1",
                ...overrides,
            };
        },
    };
    return { fake, calls };
}

describe("GatewayInferenceClient", () => {
    it("bills the model call to the inference agent and hashes the key for the wire", async () => {
        const { fake, calls } = caller();
        const client = new GatewayInferenceClient({ caller: fake, modelId: "m", maxTokens: 512 });
        const longKey = `0x${"c1".repeat(32)}:1:0x${"a1".repeat(32)}:judge:0`;
        assert.equal(await client.completeJson({ system: "s", user: "u", key: longKey }), '{"ok":true}');
        assert.equal(calls[0]?.modelId, "m");
        assert.equal(calls[0]?.systemPrompt, "s");
        assert.equal(calls[0]?.prompt, "u");
        assert.equal(calls[0]?.maxTokens, 512);
        assert.match(calls[0]?.idempotencyKey ?? "", /^jury-[0-9a-f]{48}$/);
        // The same key is the same call to the relayer, so a retried judgment is not charged twice.
        await client.completeJson({ system: "s", user: "u", key: longKey });
        assert.equal(calls[1]?.idempotencyKey, calls[0]?.idempotencyKey);
        await client.completeJson({ system: "s", user: "u", key: `${longKey}x` });
        assert.notEqual(calls[2]?.idempotencyKey, calls[0]?.idempotencyKey);
    });

    it("keeps each call's cost and provider generation, handed over once by key prefix", async () => {
        const { fake } = caller();
        const client = new GatewayInferenceClient({ caller: fake, modelId: "m", maxTokens: 512 });
        await client.completeJson({ system: "s", user: "u", key: "case:1:agent:reader" });
        await client.completeJson({ system: "s", user: "u", key: "case:1:agent:judge:0" });
        await client.completeJson({ system: "s", user: "u", key: "other:1:agent:judge:0" });
        const mine = client.takeUsage("case:1:agent");
        assert.equal(mine.length, 2);
        assert.deepEqual(mine[0], {
            key: "case:1:agent:reader",
            modelId: "m",
            tokensIn: 10,
            tokensOut: 5,
            amountMist: 1_000,
            billingState: "captured",
            reserveDigest: "rd",
            captureDigest: "cd",
            providerGenerationId: "gen-1",
        });
        assert.equal(client.takeUsage("case:1:agent").length, 0);
        assert.equal(client.takeUsage("other").length, 1);
    });

    it("turns a gateway failure or an empty answer into an inference error", async () => {
        const failing = new GatewayInferenceClient({
            caller: { gatewayInference: async () => { throw new Error("AI credit depleted"); } },
            modelId: "m",
            maxTokens: 1,
        });
        await assert.rejects(failing.completeJson({ system: "s", user: "u", key: "k" }), InferenceError);
        const { fake } = caller({ content: "  " });
        const empty = new GatewayInferenceClient({ caller: fake, modelId: "m", maxTokens: 1 });
        await assert.rejects(empty.completeJson({ system: "s", user: "u", key: "k" }), /no content/);
        assert.equal(empty.takeUsage("k").length, 0);
    });
});
