import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { SocialClient } from "./client.js";

const SUB_AGENT_KEY = "9d61b45de2660bce5d053bd15f8fb0f31c39d45b9b877ebb3d59bb39845de173";
const OWNER_KEY = "c5b174fb4639c391193a396f8968ae67c08cc90396a40366ed25128cc2fc932c";
const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

function client(): SocialClient {
    return SocialClient.create({
        key: SUB_AGENT_KEY,
        accountId: "0xabc",
        serverUrl: "http://127.0.0.1:8000",
    });
}

test("legacy owner private-key configuration is rejected", () => {
    assert.throws(
        () =>
            SocialClient.create({
                key: SUB_AGENT_KEY,
                accountId: "0xabc",
                ownerCoSignKey: OWNER_KEY,
            }),
        /wallet approval flow/,
    );
});

test("signed HTTP authentication never forwards private keys", async () => {
    let headers: Record<string, string> = {};
    globalThis.fetch = (async (_input, init) => {
        headers = Object.fromEntries(
            Object.entries(init?.headers ?? {}).map(([key, value]) => [
                key.toLowerCase(),
                String(value),
            ]),
        );
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    await (client() as unknown as {
        signedRequest<T>(method: string, path: string, body: object): Promise<T>;
    }).signedRequest("GET", "/api/agent/context", {});

    assert.ok(headers["x-public-key"]);
    assert.ok(headers["x-signature"]);
    assert.equal(headers["x-delegate-key"], undefined);
    assert.equal(headers["x-owner-delegate-key"], undefined);
});

test("owner-only deletes fail closed without making a request", async () => {
    let called = false;
    globalThis.fetch = (async () => {
        called = true;
        return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await assert.rejects(client().deletePost("0xpost"), /wallet approval flow/);
    assert.equal(called, false);
});

test("registered action preparation is authenticated, idempotent, and locally signed", async () => {
    const { Ed25519Keypair } = await import("@socialproof/myso/keypairs/ed25519");
    const signer = Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(SUB_AGENT_KEY, "hex")));
    const sender = signer.toMySoAddress();
    const digest = "1".repeat(43);
    const requests: Array<{ path: string; headers: Record<string, string>; body?: string }> = [];
    const chain = {
        packageId: "0x50c1",
        usernameRegistryId: "0x1",
        platformRegistryId: "0x2",
        platformObjectId: "0x3",
        blockListRegistryId: "0x4",
        postConfigId: "0x5",
        memoryConfigId: "0x6",
        mydataRegistryId: "0x7",
        clockId: "0x6",
    };

    globalThis.fetch = (async (input, init) => {
        const path = new URL(String(input)).pathname;
        const headers = Object.fromEntries(
            Object.entries(init?.headers ?? {}).map(([key, value]) => [
                key.toLowerCase(),
                String(value),
            ]),
        );
        requests.push({ path, headers, body: init?.body as string | undefined });
        if (path === "/config") {
            return new Response(
                JSON.stringify({
                    network: "localnet",
                    mysoRpcUrl: "http://127.0.0.1:9000",
                    socialChain: chain,
                }),
                { status: 200 },
            );
        }
        if (path === "/api/agent/context") {
            return new Response(
                JSON.stringify({
                    memoryAccountId: "0xabc",
                    derivedAddress: sender,
                    capabilities: 1024,
                    approvalRequiredCapabilities: 0,
                    platformScope: null,
                    network: "localnet",
                    rpcUrl: "http://127.0.0.1:9000",
                    packageId: "0x50c1",
                    socialChain: chain,
                    permittedRegistryActions: ["social.react_to_post.v1"],
                }),
                { status: 200 },
            );
        }
        if (path === "/api/chain/actions/prepare") {
            const body = JSON.parse(String(init?.body));
            assert.equal(body.registryAction, "social.react_to_post.v1");
            assert.equal(body.idempotencyKey, "reaction-0001");
            return new Response(
                JSON.stringify({
                    registryAction: body.registryAction,
                    registryVersion: "1.3.0",
                    idempotencyKey: body.idempotencyKey,
                    bytes: Buffer.from(Uint8Array.from({ length: 48 }, (_, index) => index + 1)).toString("base64"),
                    digest,
                    expiresAtMs: Date.now() + 300_000,
                }),
                { status: 200 },
            );
        }
        if (path === "/api/chain/actions/submit") {
            const body = JSON.parse(String(init?.body));
            assert.equal(body.digest, digest);
            assert.equal(body.idempotencyKey, "reaction-0001");
            assert.equal(typeof body.signature, "string");
            return new Response(JSON.stringify({ digest }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await client().reactToPost(
        { postId: "0xpost", reaction: "like" },
        { idempotencyKey: "reaction-0001" },
    );
    assert.equal(result.digest, digest);
    assert.deepEqual(
        requests.map((request) => request.path),
        [
            "/config",
            "/api/agent/context",
            "/api/chain/actions/prepare",
            "/api/chain/actions/submit",
        ],
    );
    for (const request of requests) {
        assert.equal(request.headers["x-delegate-key"], undefined);
        assert.equal(request.headers["x-owner-delegate-key"], undefined);
    }
    assert.equal(requests[2].headers["x-platform-id"], "0x3");
    assert.equal(requests[3].headers["x-platform-id"], "0x3");
});

test("Tier 3 delete uses personal-message approval and owner wallet transaction signing", async () => {
    const digest = "2".repeat(43);
    const approvalId = "11111111-1111-4111-8111-111111111111";
    const owner = "0x999";
    const paths: string[] = [];
    const chain = {
        packageId: "0x50c1", usernameRegistryId: "0x1", platformRegistryId: "0x2",
        platformObjectId: "0x3", blockListRegistryId: "0x4", postConfigId: "0x5",
        memoryConfigId: "0x6", mydataRegistryId: "0x7", clockId: "0x6",
    };
    globalThis.fetch = (async (input, init) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        if (path === "/config") {
            return new Response(JSON.stringify({ network: "localnet", mysoRpcUrl: "http://127.0.0.1:9000", socialChain: chain }));
        }
        if (path === "/api/agent/context") {
            return new Response(JSON.stringify({
                owner, memoryAccountId: "0xabc", derivedAddress: "0x123", capabilities: 16,
                approvalRequiredCapabilities: 0, platformScope: null, network: "localnet",
                rpcUrl: "http://127.0.0.1:9000", packageId: "0x50c1", socialChain: chain,
                permittedRegistryActions: ["social.delete_post.v1"],
            }));
        }
        if (path === "/api/chain/approvals/request") {
            const body = JSON.parse(String(init?.body));
            return new Response(JSON.stringify({
                approvalId, registryAction: body.registryAction, registryVersion: "1.3.0",
                idempotencyKey: body.idempotencyKey, parameterHash: `sha256:${"3".repeat(64)}`,
                approvalIntent: `mysocial-action-approval-v1|${approvalId}|binding`, status: "pending",
                expiresAtMs: Date.now() + 600_000,
            }));
        }
        if (path.endsWith("/approve")) {
            assert.equal(JSON.parse(String(init?.body)).walletSignature, "wallet-personal-message-signature");
            return new Response(JSON.stringify({ status: "approved" }));
        }
        if (path === "/api/chain/actions/prepare") {
            const body = JSON.parse(String(init?.body));
            assert.equal(body.approvalId, approvalId);
            return new Response(JSON.stringify({
                registryAction: body.registryAction, registryVersion: "1.3.0",
                idempotencyKey: body.idempotencyKey,
                bytes: Buffer.from(new Uint8Array(48).fill(7)).toString("base64"),
                digest, expiresAtMs: Date.now() + 300_000,
            }));
        }
        if (path === "/api/chain/actions/submit") {
            const body = JSON.parse(String(init?.body));
            assert.equal(body.approvalId, approvalId);
            assert.equal(body.signature, "wallet-transaction-signature");
            return new Response(JSON.stringify({ digest }));
        }
        return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const social = SocialClient.create({
        key: SUB_AGENT_KEY,
        accountId: "0xabc",
        serverUrl: "http://127.0.0.1:8000",
        ownerWallet: {
            getAddress: () => owner,
            signPersonalMessage: async () => ({ signature: "wallet-personal-message-signature" }),
            signTransaction: async () => ({ signature: "wallet-transaction-signature" }),
        },
    });
    const result = await social.deletePost("0xpost", { idempotencyKey: "delete-post-0001" });
    assert.deepEqual(result, { digest, deleted: true });
    assert.deepEqual(paths, [
        "/config", "/api/agent/context", "/api/chain/approvals/request",
        `/api/chain/approvals/${approvalId}/approve`, "/api/chain/actions/prepare",
        "/api/chain/actions/submit",
    ]);
});
