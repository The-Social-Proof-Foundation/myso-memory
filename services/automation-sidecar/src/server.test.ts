/**
 * HTTP surface tests.
 *
 * These run against a real listening socket rather than a mocked router, so the
 * auth check, body limit, and status codes are exercised the way a caller
 * experiences them.
 */

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import type { MemoryBridge } from "./bridge.js";
import type { SidecarConfig } from "./config.js";
import { createBridgeServer } from "./server.js";

const SECRET = "test-secret-value";

/** Records what the bridge was asked to do so route wiring can be asserted. */
const calls: Array<{ op: string; args: unknown }> = [];

const fakeBridge = {
    async recall(args: unknown) {
        calls.push({ op: "recall", args });
        return {
            results: [{ text: "user prefers dark mode", distance: 0.12, blob_id: "blob-1" }],
            total: 1,
            truncated: false,
            namespace: "chat-app",
        };
    },
    async remember(args: unknown) {
        calls.push({ op: "remember", args });
        return { job_id: "job-1", status: "done", blob_id: "blob-2", namespace: "chat-app" };
    },
    async probe(args: unknown) {
        calls.push({ op: "probe", args });
        return { status: "ok", version: "0.0.6", namespace: "chat-app" };
    },
} satisfies Pick<MemoryBridge, "recall" | "remember" | "probe">;

const config: SidecarConfig = {
    host: "127.0.0.1",
    port: 0,
    internalSyncSecret: SECRET,
    defaultServerUrl: "http://127.0.0.1:8000",
    defaultNamespace: "chat-app",
    requestTimeoutMs: 5_000,
    maxBodyBytes: 512,
};

let baseUrl = "";
let server: ReturnType<typeof createBridgeServer>;
const store = {
    size: () => 2,
};

before(async () => {
    server = createBridgeServer({ config, bridge: fakeBridge, store });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

function post(path: string, body: unknown, secret?: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...(secret === undefined ? {} : { "x-internal-sync-secret": secret }),
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
    });
}

describe("GET /health", () => {
    it("is public and reports a count without ref names or key material", async () => {
        const res = await fetch(`${baseUrl}/health`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(body.status, "ok");
        assert.equal(body.service, "automation-memory-bridge");
        assert.equal(body.agents, 2);
        // Ref names identify tenants' agents; the public route must not list them.
        assert.equal("agent_refs" in body, false);
    });

    it("tolerates a trailing slash", async () => {
        const res = await fetch(`${baseUrl}/health/`);
        assert.equal(res.status, 200);
    });
});

describe("auth", () => {
    it("rejects an internal route with no secret", async () => {
        const res = await post("/internal/memory/recall", {
            key_ref: "a", account_id: "0xacct",
            query: "q",
        });
        assert.equal(res.status, 401);
        assert.equal(((await res.json()) as { code: string }).code, "unauthorized");
    });

    it("rejects a wrong secret", async () => {
        const res = await post(
            "/internal/memory/recall",
            { key_ref: "a", account_id: "0xacct", query: "q" },
            "wrong-secret",
        );
        assert.equal(res.status, 401);
    });

    it("rejects a secret of a different length without throwing", async () => {
        const res = await post(
            "/internal/memory/recall",
            { key_ref: "a", account_id: "0xacct", query: "q" },
            "x",
        );
        assert.equal(res.status, 401);
    });

    it("accepts the correct secret", async () => {
        const res = await post(
            "/internal/memory/recall",
            { key_ref: "a", account_id: "0xacct", query: "q" },
            SECRET,
        );
        assert.equal(res.status, 200);
    });

    it("does not require a secret for /health", async () => {
        const res = await fetch(`${baseUrl}/health`);
        assert.equal(res.status, 200);
    });
});

describe("routing", () => {
    it("404s an unknown path", async () => {
        const res = await post("/internal/memory/nope", {}, SECRET);
        assert.equal(res.status, 404);
    });

    it("404s a non-internal path", async () => {
        const res = await post("/v1/automation/jobs", {}, SECRET);
        assert.equal(res.status, 404);
    });

    it("405s a GET on an internal route", async () => {
        const res = await fetch(`${baseUrl}/internal/memory/recall`, {
            headers: { "x-internal-sync-secret": SECRET },
        });
        assert.equal(res.status, 405);
    });
});

describe("request validation", () => {
    it("400s a missing key_ref", async () => {
        const res = await post("/internal/memory/recall", { query: "q" }, SECRET);
        assert.equal(res.status, 400);
        assert.match(((await res.json()) as { error: string }).error, /key_ref/);
    });

    it("400s a missing account_id", async () => {
        const res = await post("/internal/memory/recall", { key_ref: "a", query: "q" }, SECRET);
        assert.equal(res.status, 400);
        assert.match(((await res.json()) as { error: string }).error, /account_id/);
    });

    it("400s a missing query", async () => {
        const res = await post("/internal/memory/recall", { key_ref: "a", account_id: "0xacct" }, SECRET);
        assert.equal(res.status, 400);
        assert.match(((await res.json()) as { error: string }).error, /query/);
    });

    it("400s a non-positive limit", async () => {
        const res = await post(
            "/internal/memory/recall",
            { key_ref: "a", account_id: "0xacct", query: "q", limit: 0 },
            SECRET,
        );
        assert.equal(res.status, 400);
    });

    it("400s invalid JSON", async () => {
        const res = await post("/internal/memory/remember", "{nope", SECRET);
        assert.equal(res.status, 400);
        assert.equal(((await res.json()) as { code: string }).code, "invalid_json");
    });

    it("400s a JSON array body", async () => {
        const res = await post("/internal/memory/remember", "[]", SECRET);
        assert.equal(res.status, 400);
    });

    it("413s a body over the cap", async () => {
        const res = await post(
            "/internal/memory/remember",
            { key_ref: "a", account_id: "0xacct", text: "x".repeat(1000) },
            SECRET,
        );
        assert.equal(res.status, 413);
    });
});

describe("route wiring", () => {
    it("forwards recall args, omitting absent optionals", async () => {
        calls.length = 0;
        await post("/internal/memory/recall", { key_ref: "a", account_id: "0xacct", query: "q", limit: 5 }, SECRET);
        assert.deepEqual(calls, [
            { op: "recall", args: { key_ref: "a", account_id: "0xacct", query: "q", limit: 5, namespace: undefined } },
        ]);
    });

    it("treats an absent wait as undefined rather than false", async () => {
        calls.length = 0;
        await post("/internal/memory/remember", { key_ref: "a", account_id: "0xacct", text: "hello" }, SECRET);
        assert.deepEqual(calls, [
            { op: "remember", args: { key_ref: "a", account_id: "0xacct", text: "hello", wait: undefined, namespace: undefined } },
        ]);
    });

    it("preserves wait:false", async () => {
        calls.length = 0;
        await post(
            "/internal/memory/remember",
            { key_ref: "a", account_id: "0xacct", text: "hello", wait: false },
            SECRET,
        );
        assert.equal((calls[0]?.args as { wait: boolean }).wait, false);
    });

    it("passes a namespace override through", async () => {
        calls.length = 0;
        await post(
            "/internal/memory/recall",
            { key_ref: "a", account_id: "0xacct", query: "q", namespace: "other" },
            SECRET,
        );
        assert.equal((calls[0]?.args as { namespace: string }).namespace, "other");
    });

    it("serves probe", async () => {
        const res = await post("/internal/memory/probe", { key_ref: "a", account_id: "0xacct" }, SECRET);
        assert.equal(res.status, 200);
        assert.equal(((await res.json()) as { version: string }).version, "0.0.6");
    });
});
