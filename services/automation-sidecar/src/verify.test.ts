/**
 * Delegate verification tests: the policy a delegate must satisfy before the
 * bridge will sign as it, and the shape of the signed context request.
 */

import assert from "node:assert/strict";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { describe, it } from "node:test";

import { BridgeError } from "./bridge-error.js";
import {
    CAP_MEMORY_READ,
    CAP_MEMORY_WRITE,
    CAP_MYDATA_READ,
    DelegateVerifier,
    NEEDS_RECALL,
    NEEDS_REMEMBER,
    assertDelegateAllowed,
    type AgentContext,
} from "./verify.js";

const NOW = 1_800_000_000_000;
const TARGET = { accountId: "0xacct", agentObjectId: "0xagent", needs: NEEDS_RECALL };

function ctx(overrides: Partial<AgentContext> = {}): AgentContext {
    return {
        memoryAccountId: "0xacct",
        agentObjectId: "0xagent",
        capabilities: CAP_MEMORY_READ | CAP_MEMORY_WRITE | CAP_MYDATA_READ,
        maxActionSpendMist: 1_000_000,
        expiresAtMs: NOW + 86_400_000,
        ...overrides,
    };
}

function refusal(c: AgentContext, target = TARGET): string {
    try {
        assertDelegateAllowed(c, target, NOW);
    } catch (e) {
        assert.ok(e instanceof BridgeError);
        assert.equal(e.status, 403);
        return e.code;
    }
    return "allowed";
}

describe("assertDelegateAllowed", () => {
    it("allows a memory-only, capped, expiring delegate", () => {
        assert.equal(refusal(ctx()), "allowed");
        assert.equal(refusal(ctx(), { ...TARGET, needs: NEEDS_REMEMBER }), "allowed");
    });

    it("refuses a delegate under a different account", () => {
        assert.equal(refusal(ctx({ memoryAccountId: "0xsomeone" })), "delegate_wrong_account");
    });

    it("refuses a key that is not the registered agent", () => {
        assert.equal(refusal(ctx({ agentObjectId: "0xother" })), "delegate_mismatch");
    });

    it("refuses any capability beyond memory read/write", () => {
        // 16 = post publish, 256 = trade execute, 16384 = AI spend.
        for (const extra of [16, 64, 256, 8192, 16384]) {
            assert.equal(
                refusal(ctx({ capabilities: CAP_MEMORY_READ | CAP_MYDATA_READ | extra })),
                "delegate_overscoped",
                `extra capability ${extra}`,
            );
        }
    });

    it("refuses a delegate missing what the operation needs", () => {
        assert.equal(refusal(ctx({ capabilities: CAP_MEMORY_READ })), "delegate_missing_capability");
        assert.equal(
            refusal(ctx({ capabilities: CAP_MEMORY_READ | CAP_MYDATA_READ }), {
                ...TARGET,
                needs: NEEDS_REMEMBER,
            }),
            "delegate_missing_capability",
        );
    });

    it("refuses a delegate with no spending limit", () => {
        assert.equal(refusal(ctx({ maxActionSpendMist: null })), "delegate_no_spend_limit");
    });

    it("refuses a delegate that never expires", () => {
        assert.equal(refusal(ctx({ expiresAtMs: null })), "delegate_no_expiry");
    });

    it("refuses an expired delegate, including one expiring right now", () => {
        assert.equal(refusal(ctx({ expiresAtMs: NOW - 1 })), "delegate_expired");
        assert.equal(refusal(ctx({ expiresAtMs: NOW })), "delegate_expired");
    });
});

describe("DelegateVerifier", () => {
    const seedHex = randomBytes(32).toString("hex");

    function verifierWith(
        respond: (url: string, init: RequestInit) => Response | Promise<Response>,
    ) {
        const seen: Array<{ url: string; headers: Record<string, string> }> = [];
        const fetchImpl = (async (url: string, init: RequestInit) => {
            seen.push({ url: String(url), headers: init.headers as Record<string, string> });
            return respond(String(url), init);
        }) as unknown as typeof fetch;
        return { verifier: new DelegateVerifier({ fetchImpl, now: () => NOW }), seen };
    }

    const target = {
        seedHex,
        serverUrl: "http://relayer.internal:8000/",
        accountId: "0xacct",
        agentObjectId: "0xagent",
        needs: NEEDS_RECALL,
    };

    const okBody = {
        memoryAccountId: "0xacct",
        agentObjectId: "0xagent",
        capabilities: 7,
        maxActionSpendMist: 1000,
        expiresAtMs: NOW + 1000,
    };

    it("signs the context request the way the relayer verifies it", async () => {
        const { verifier, seen } = verifierWith(() => Response.json(okBody));
        await verifier.verify(target);

        assert.equal(seen[0]?.url, "http://relayer.internal:8000/api/agent/context");
        const h = seen[0]!.headers;
        const bodyHash = createHash("sha256").update("").digest("hex");
        const message = `${h["x-timestamp"]}.GET./api/agent/context.${bodyHash}.${h["x-nonce"]}.0xacct`;
        const spki = Buffer.concat([
            Buffer.from("302a300506032b6570032100", "hex"),
            Buffer.from(h["x-public-key"]!, "hex"),
        ]);
        const ok = verify(
            null,
            Buffer.from(message),
            createPublicKey({ key: spki, format: "der", type: "spki" }),
            Buffer.from(h["x-signature"]!, "hex"),
        );
        assert.equal(ok, true);
        assert.equal(h["x-account-id"], "0xacct");
    });

    it("uses a fresh nonce on every request", async () => {
        const { verifier, seen } = verifierWith(() => Response.json(okBody));
        await verifier.verify(target);
        await verifier.verify(target);
        assert.notEqual(seen[0]!.headers["x-nonce"], seen[1]!.headers["x-nonce"]);
    });

    it("hits the relayer on every call, with no cache to outlast a revocation", async () => {
        let calls = 0;
        const { verifier } = verifierWith(() => {
            calls += 1;
            return Response.json(okBody);
        });
        await verifier.verify(target);
        await verifier.verify(target);
        await verifier.verify(target);
        assert.equal(calls, 3);
    });

    it("maps a relayer refusal to a non-retryable 403", async () => {
        for (const status of [401, 403]) {
            const { verifier } = verifierWith(() => new Response("no", { status }));
            const err = await verifier.verify(target).catch((e: unknown) => e as BridgeError);
            assert.ok(err instanceof BridgeError);
            assert.equal(err.status, 403);
            assert.equal(err.code, "delegate_rejected");
        }
    });

    it("treats an outage as a retryable 502, not a verdict", async () => {
        const down = verifierWith(() => {
            throw new Error("connection refused");
        });
        let err = await down.verifier.verify(target).catch((e: unknown) => e as BridgeError);
        assert.equal((err as BridgeError).status, 502);

        const broken = verifierWith(() => new Response("oops", { status: 500 }));
        err = await broken.verifier.verify(target).catch((e: unknown) => e as BridgeError);
        assert.equal((err as BridgeError).status, 502);
    });

    it("fails closed on a relayer that does not report expiry", async () => {
        const { expiresAtMs: _omit, ...legacy } = okBody;
        const { verifier } = verifierWith(() => Response.json(legacy));
        const err = await verifier.verify(target).catch((e: unknown) => e as BridgeError);
        assert.equal((err as BridgeError).code, "delegate_no_expiry");
    });

    it("rejects a malformed context", async () => {
        const { verifier } = verifierWith(() => Response.json({ hello: "world" }));
        const err = await verifier.verify(target).catch((e: unknown) => e as BridgeError);
        assert.equal((err as BridgeError).status, 502);
    });

    it("never puts the seed in a request or an error", async () => {
        const { verifier, seen } = verifierWith(() => new Response("no", { status: 403 }));
        const err = await verifier.verify(target).catch((e: unknown) => e as BridgeError);
        assert.equal(JSON.stringify(seen).includes(seedHex), false);
        assert.equal((err as BridgeError).message.includes(seedHex), false);
    });
});
