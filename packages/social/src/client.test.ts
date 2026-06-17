import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { SocialClient } from "./client.js";

/** RFC 8032 test vector private keys (32-byte hex). */
const SUB_AGENT_KEY = "9d61b45de2660bce5d053bd15f8fb0f31c39d45b9b877ebb3d59bb39845de173";
const OWNER_KEY = "c5b174fb4639c391193a396f8968ae67c08cc90396a40366ed25128cc2fc932c";

let capturedHeaders: Record<string, string> | null = null;
const originalFetch = globalThis.fetch;

beforeEach(() => {
    capturedHeaders = null;
    globalThis.fetch = (async (_input, init) => {
        capturedHeaders = Object.fromEntries(
            Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
        );
        return new Response(JSON.stringify({ digest: "0xtest" }), { status: 200 });
    }) as typeof fetch;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

function clientWithOwner(): SocialClient {
    return SocialClient.create({
        key: SUB_AGENT_KEY,
        accountId: "0xaccount",
        serverUrl: "http://127.0.0.1:8000",
        ownerCoSignKey: OWNER_KEY,
    });
}

test("createPost does not attach owner co-sign headers when ownerCoSignKey is set", async () => {
    const social = clientWithOwner();
    await social.createPost({ content: "hello" });

    assert.ok(capturedHeaders);
    assert.equal(capturedHeaders["x-owner-public-key"], undefined);
    assert.equal(capturedHeaders["x-owner-signature"], undefined);
    assert.equal(capturedHeaders["x-owner-delegate-key"], undefined);
});

test("deletePost attaches owner co-sign headers", async () => {
    const social = clientWithOwner();
    await social.deletePost("0xpost");

    assert.ok(capturedHeaders);
    assert.ok(capturedHeaders["x-owner-public-key"]);
    assert.ok(capturedHeaders["x-owner-signature"]);
    assert.ok(capturedHeaders["x-owner-delegate-key"]);
});
