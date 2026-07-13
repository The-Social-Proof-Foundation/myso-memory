import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
    MCP_PACKAGE_VERSION,
    SponsoredSocialGateway,
    LocalEd25519Signer,
    createCliSigner,
    createMemoryMcpServer,
    parseCredentials,
} from "../dist/index.js";

const packageRoot = path.resolve(import.meta.dirname, "..");

test("package binary and runtime version match package metadata", () => {
    const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    assert.equal(MCP_PACKAGE_VERSION, metadata.version);
    assert.equal(metadata.bin["memory-mcp"], "./dist/bin/memory-mcp.js");
    const binary = fs.readFileSync(path.join(packageRoot, "dist/bin/memory-mcp.js"), "utf8");
    assert.match(binary, /^#!\/usr\/bin\/env node/);
});

test("credentials reject legacy raw keys and validate signer references", () => {
    assert.throws(
        () => parseCredentials({ accountId: "0x1", key: "ab".repeat(32) }),
        (error) => error.code === "UNSAFE_LEGACY_CREDENTIALS",
    );
    const credentials = parseCredentials({
        accountId: "0x1",
        serverUrl: "http://127.0.0.1:8000/",
        signer: {
            type: "keychain",
            service: "network.mysocial.memory-mcp",
            account: "test-agent",
        },
    });
    assert.equal(credentials.serverUrl, "http://127.0.0.1:8000");
    assert.equal(credentials.socialEnabled, false);
    const discovered = parseCredentials({
        accountId: "0x1",
        serverUrl: "http://127.0.0.1:8000",
        socialEnabled: true,
        signer: credentials.signer,
    });
    assert.equal(discovered.socialEnabled, true);
    assert.equal(discovered.social.network, undefined);
    assert.equal(discovered.social.chain, undefined);
});

test("development-file signer requires opt-in and private file permissions", { concurrency: false }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mcp-signer-"));
    const secretPath = path.join(directory, "agent.key");
    fs.writeFileSync(secretPath, "01".repeat(32), { mode: 0o600 });
    const previous = process.env.MEMORY_MCP_ALLOW_INSECURE_DEV_FILE;
    try {
        delete process.env.MEMORY_MCP_ALLOW_INSECURE_DEV_FILE;
        assert.throws(
            () => createCliSigner({ type: "development-file", path: secretPath }),
            /Development-file signing is disabled/,
        );
        process.env.MEMORY_MCP_ALLOW_INSECURE_DEV_FILE = "1";
        const signer = createCliSigner({ type: "development-file", path: secretPath });
        assert.equal((await signer.getPublicKey()).byteLength, 32);
        assert.equal((await signer.sign(new TextEncoder().encode("test"))).byteLength, 64);
        signer.destroy();
        await assert.rejects(() => signer.sign(new Uint8Array()), /destroyed/);

        fs.chmodSync(secretPath, 0o644);
        assert.throws(
            () => createCliSigner({ type: "development-file", path: secretPath }),
            /mode 0600/,
        );
    } finally {
        if (previous === undefined) delete process.env.MEMORY_MCP_ALLOW_INSECURE_DEV_FILE;
        else process.env.MEMORY_MCP_ALLOW_INSECURE_DEV_FILE = previous;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("registered Tier 1 actions build, sponsor, locally sign, and execute without raw key headers", async () => {
    const signer = new LocalEd25519Signer(
        "development-file",
        "test-key",
        Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    );
    const sender = await signer.getMySoAddress();
    const digest = "1".repeat(43);
    const requests = [];
    const builtActions = [];
    const builtParameters = [];
    const gateway = new SponsoredSocialGateway({
        signer,
        accountId: "0xabc",
        serverUrl: "http://127.0.0.1:8000",
        network: "localnet",
        rpcUrl: "http://127.0.0.1:9000",
        chain: {
            packageId: "0x50c1",
            usernameRegistryId: "0x1",
            platformRegistryId: "0x2",
            platformObjectId: "0x3",
            blockListRegistryId: "0x4",
            postConfigId: "0x5",
            memoryConfigId: "0x6",
            mydataRegistryId: "0x7",
        },
        fetch: async (url, init) => {
            requests.push({ url: String(url), init });
            if (String(url).endsWith("/config")) {
                return new Response(JSON.stringify({
                    network: "localnet",
                    mysoRpcUrl: "http://127.0.0.1:9000",
                    socialChain: {
                        packageId: "0x50c1",
                        usernameRegistryId: "0x1",
                        platformRegistryId: "0x2",
                        platformObjectId: "0x3",
                        blockListRegistryId: "0x4",
                        postConfigId: "0x5",
                        memoryConfigId: "0x6",
                        mydataRegistryId: "0x7",
                        clockId: "0x6",
                    },
                }), { status: 200 });
            }
            if (String(url).endsWith("/api/agent/context")) {
                return new Response(JSON.stringify({
                    memoryAccountId: "0xabc",
                    agentObjectId: "0xagent",
                    derivedAddress: sender,
                    capabilities: 16 | 64 | 512 | 1024 | 65536,
                    approvalRequiredCapabilities: 0,
                    platformScope: null,
                    network: "localnet",
                    rpcUrl: "http://127.0.0.1:9000",
                    packageId: "0x50c1",
                    permittedRegistryActions: [
                        "social.create_post.v1",
                        "social.create_comment.v1",
                        "social.react_to_post.v1",
                        "social.react_to_comment.v1",
                        "social.create_repost.v1",
                        "social.remove_post_reaction.v1",
                        "social.remove_comment_reaction.v1",
                        "social.edit_post.v1",
                        "social.edit_comment.v1",
                        "social.remove_repost.v1",
                        "social.follow_profile.v1",
                        "social.unfollow_profile.v1",
                        "social.block_profile.v1",
                        "social.unblock_profile.v1",
                        "messaging.send_message.v1",
                    ],
                    socialChain: {
                        packageId: "0x50c1",
                        usernameRegistryId: "0x1",
                        platformRegistryId: "0x2",
                        platformObjectId: "0x3",
                        blockListRegistryId: "0x4",
                        postConfigId: "0x5",
                        memoryConfigId: "0x6",
                        mydataRegistryId: "0x7",
                        clockId: "0x6",
                    },
                }), { status: 200 });
            }
            if (String(url).endsWith("/api/chain/actions/prepare")) {
                const body = JSON.parse(init.body);
                builtActions.push(body.registryAction);
                builtParameters.push(body.parameters);
                return new Response(JSON.stringify({
                    bytes: Buffer.from(Uint8Array.from({ length: 48 }, (_, index) => index + 2)).toString("base64"),
                    digest,
                    registryAction: body.registryAction,
                    registryVersion: "1.3.0",
                    idempotencyKey: body.idempotencyKey,
                    parameterHash: `sha256:${"1".repeat(64)}`,
                    transactionKindHash: `sha256:${"2".repeat(64)}`,
                    packageId: "0x50c1",
                    packageVersion: "1",
                    status: "sponsored",
                    expiresAtMs: Date.now() + 300_000,
                }), { status: 200 });
            }
            if (String(url).endsWith(`/api/chain/actions/${digest}`)) {
                return new Response(JSON.stringify({
                    chain: { status: "finalized", digest },
                    indexer: { status: "unavailable" },
                }), { status: 200 });
            }
            return new Response(JSON.stringify({ digest }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        },
    });
    for (const tool of [
        "social_remove_post_reaction", "social_remove_comment_reaction",
        "social_edit_post", "social_edit_comment", "social_remove_repost",
        "social_follow_profile", "social_unfollow_profile",
        "social_block_profile", "social_unblock_profile", "messaging_send_message",
    ]) {
        assert.ok(gateway.supportedToolNames.includes(tool));
    }
    const result = await gateway.reactToPost({
        postId: "0xpost",
        reaction: "like",
        idempotencyKey: "reaction-0001",
    });
    assert.equal(result.digest, digest);
    assert.equal(result.registryAction, "social.react_to_post.v1");
    assert.equal(builtActions[0], "social.react_to_post.v1");
    assert.deepEqual(builtParameters[0], { postId: "0xpost", reaction: "like" });
    assert.deepEqual(
        requests.map((request) => new URL(request.url).pathname),
        [
            "/config",
            "/api/agent/context",
            "/api/chain/actions/prepare",
            "/api/chain/actions/submit",
        ],
    );
    assert.match(requests[1].init.headers["x-public-key"], /^[0-9a-f]{64}$/);
    assert.match(requests[1].init.headers["x-signature"], /^[0-9a-f]{128}$/);
    const sponsorBody = JSON.parse(requests[2].init.body);
    assert.equal(sponsorBody.registryAction, "social.react_to_post.v1");
    assert.equal(sponsorBody.idempotencyKey, "reaction-0001");
    const executeBody = JSON.parse(requests[3].init.body);
    assert.equal(executeBody.registryAction, "social.react_to_post.v1");
    assert.ok(executeBody.signature);
    const status = await gateway.getActionStatus(digest);
    assert.equal(status.chain.status, "finalized");
    assert.equal(new URL(requests[4].url).pathname, `/api/chain/actions/${digest}`);
    await gateway.createPost({ content: "hello", idempotencyKey: "post-0001" });
    await gateway.createComment({
        postId: "0xpost",
        content: "comment",
        idempotencyKey: "comment-0001",
    });
    await gateway.reactToComment({
        commentId: "0xcomment",
        reaction: "like",
        idempotencyKey: "comment-reaction-0001",
    });
    await gateway.createRepost({
        originalPostId: "0xpost",
        content: "quote",
        idempotencyKey: "repost-0001",
    });
    await gateway.removePostReaction({ postId: "0xpost", idempotencyKey: "remove-reaction-0001" });
    await gateway.removeCommentReaction({ commentId: "0xcomment", idempotencyKey: "remove-comment-reaction-0001" });
    await gateway.editPost({ postId: "0xpost", content: "edited", idempotencyKey: "edit-post-0001" });
    await gateway.editComment({ commentId: "0xcomment", content: "edited", idempotencyKey: "edit-comment-0001" });
    await gateway.removeRepost({ originalPostId: "0xpost", repostId: "0xrepost", idempotencyKey: "remove-repost-0001" });
    await gateway.followProfile({ targetOwner: "0xtarget", idempotencyKey: "follow-profile-0001" });
    await gateway.unfollowProfile({ targetOwner: "0xtarget", idempotencyKey: "unfollow-profile-0001" });
    await gateway.blockProfile({ targetOwner: "0xtarget", idempotencyKey: "block-profile-0001" });
    await gateway.unblockProfile({ targetOwner: "0xtarget", idempotencyKey: "unblock-profile-0001" });
    await gateway.sendMessage({
        groupId: "0xgroup",
        messageLogId: "0xlog",
        recipient: "0xrecipient",
        contentDigestHex: "ab".repeat(32),
        contentUri: "wal://encrypted-message",
        dedupeKey: "message-0001",
        nonce: "1",
        idempotencyKey: "send-message-0001",
    });
    assert.deepEqual(builtActions, [
        "social.react_to_post.v1",
        "social.create_post.v1",
        "social.create_comment.v1",
        "social.react_to_comment.v1",
        "social.create_repost.v1",
        "social.remove_post_reaction.v1",
        "social.remove_comment_reaction.v1",
        "social.edit_post.v1",
        "social.edit_comment.v1",
        "social.remove_repost.v1",
        "social.follow_profile.v1",
        "social.unfollow_profile.v1",
        "social.block_profile.v1",
        "social.unblock_profile.v1",
        "messaging.send_message.v1",
    ]);
    for (const request of requests) {
        assert.equal(request.init.headers["x-delegate-key"], undefined);
        assert.equal(request.init.headers["x-owner-delegate-key"], undefined);
    }
    await assert.rejects(
        () => gateway.deletePost("0xpost"),
        (error) => error.code === "APPROVAL_FLOW_NOT_AVAILABLE",
    );
    const catalog = await gateway.listActions();
    assert.equal(catalog.catalogVersion, "1.3.0");
    assert.equal(catalog.actions.length, 69);
    assert.equal(
        catalog.actions.find((action) => action.id === "social.create_post.v1").permitted,
        true,
    );
    assert.equal(
        catalog.actions.find((action) => action.id === "dex.swap.v1").permitted,
        false,
    );
    signer.destroy();
});

test("approved organization submission does not require resending parameters", async () => {
    const signer = new LocalEd25519Signer(
        "development-file",
        "approval-test",
        new Uint8Array(32).fill(7),
    );
    const sender = await signer.getMySoAddress();
    const digest = "3".repeat(43);
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
    const gateway = new SponsoredSocialGateway({
        signer,
        accountId: "0xabc",
        serverUrl: "http://127.0.0.1:8000",
        fetch: async (url) => {
            const path = new URL(String(url)).pathname;
            if (path === "/config") {
                return new Response(JSON.stringify({
                    network: "localnet",
                    mysoRpcUrl: "http://127.0.0.1:9000",
                    socialChain: chain,
                }));
            }
            if (path === "/api/agent/context") {
                return new Response(JSON.stringify({
                    memoryAccountId: "0xabc",
                    agentObjectId: "0xagent",
                    derivedAddress: sender,
                    capabilities: 8192,
                    approvalRequiredCapabilities: 0,
                    platformScope: null,
                    network: "localnet",
                    rpcUrl: "http://127.0.0.1:9000",
                    packageId: "0x50c1",
                    socialChain: chain,
                    permittedRegistryActions: ["organization.create.v1"],
                }));
            }
            return new Response(JSON.stringify({ digest }));
        },
    });
    const result = await gateway.submitApprovedAction({
        registryAction: "organization.create.v1",
        idempotencyKey: "create-org-0001",
        approvalId: "11111111-1111-4111-8111-111111111111",
        digest,
        walletSignature: "wallet-transaction-signature",
    });
    assert.equal(result.digest, digest);
    signer.destroy();
});

test("MCP protocol advertises schemas and returns structured success and errors", async () => {
    const memory = {
        async rememberAndWait(text, subLabel) {
            return { status: "complete", text, subLabel };
        },
        async recall(query, limit) {
            return { query, limit, memories: [] };
        },
        async health() {
            return { status: "ok" };
        },
    };
    const social = {
        supportedToolNames: [
            "chain_list_actions",
            "social_create_post",
            "social_create_comment",
            "social_react_post",
            "social_react_comment",
            "social_create_repost",
            "chain_get_action_status",
            "organization_create",
            "organization_get_control",
            "messaging_list_inbox",
            "messaging_wait_for_message",
            "agent_register_child",
            "agent_provision_signer",
        ],
        async listActions() {
            return { catalogVersion: "1.0.0", actions: [] };
        },
        async createPost(input) {
            return { digest: "post-digest", input };
        },
        async createComment(input) {
            return { digest: "comment-digest", input };
        },
        async reactToPost(input) {
            return { digest: "reaction-digest", input };
        },
        async reactToComment(input) {
            return { digest: "comment-reaction-digest", input };
        },
        async createRepost(input) {
            return { digest: "repost-digest", input };
        },
        async deletePost() {
            throw new Error("not exposed in test catalog");
        },
        async deleteComment() {
            throw new Error("not exposed in test catalog");
        },
        async getActionStatus(digest) {
            return { chain: { status: "finalized", digest }, indexer: { status: "unavailable" } };
        },
        async requestActionApproval(input) {
            return { approvalId: "approval-1", input };
        },
        async getOrganizationControl(organizationId) {
            return { organization: { organizationId }, agents: [] };
        },
        async listInbox(input) {
            return { messages: [], input };
        },
        async waitForMessage(input) {
            return { timedOut: true, messages: [], input };
        },
        async registerChildAgent(input) {
            return { digest: "child-digest", input };
        },
    };
    const agentProvisioner = {
        async provision(label) {
            return {
                publicKeyHex: "11".repeat(32),
                derivedAddress: "0x123",
                signer: { type: "kms-session", keyId: `kms:${label}` },
            };
        },
    };
    const server = createMemoryMcpServer({ memory, social, agentProvisioner });
    const client = new Client({ name: "memory-mcp-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
        const listed = await client.listTools();
        assert.deepEqual(
            listed.tools.map((tool) => tool.name),
            [
                "memory_remember",
                "memory_recall",
                "memory_health",
                "chain_list_actions",
                "organization_create",
                "organization_get_control",
                "agent_provision_signer",
                "messaging_list_inbox",
                "messaging_wait_for_message",
                "agent_register_child",
                "chain_get_action_status",
                "social_create_post",
                "social_create_comment",
                "social_react_post",
                "social_react_comment",
                "social_create_repost",
            ],
        );
        for (const tool of listed.tools) {
            assert.equal(tool.outputSchema.type, "object");
            assert.equal(typeof tool.annotations.readOnlyHint, "boolean");
            assert.equal(typeof tool.annotations.destructiveHint, "boolean");
            assert.equal(typeof tool.annotations.idempotentHint, "boolean");
        }

        const health = await client.callTool({ name: "memory_health", arguments: {} });
        assert.equal(health.isError, undefined);
        assert.deepEqual(health.structuredContent, {
            ok: true,
            data: { status: "ok" },
        });

        const actions = await client.callTool({ name: "chain_list_actions", arguments: {} });
        assert.deepEqual(actions.structuredContent, {
            ok: true,
            data: { catalogVersion: "1.0.0", actions: [] },
        });

        const reaction = await client.callTool({
            name: "social_react_post",
            arguments: {
                postId: "0xpost",
                reaction: "like",
                idempotencyKey: "reaction-0001",
            },
        });
        assert.deepEqual(reaction.structuredContent, {
            ok: true,
            data: {
                digest: "reaction-digest",
                input: {
                    postId: "0xpost",
                    reaction: "like",
                    idempotencyKey: "reaction-0001",
                },
            },
        });

        const organization = await client.callTool({
            name: "organization_create",
            arguments: { orgType: 1, name: "Acme", idempotencyKey: "create-org-0001" },
        });
        assert.equal(organization.structuredContent.data.approvalId, "approval-1");
        assert.equal(
            organization.structuredContent.data.input.registryAction,
            "organization.create.v1",
        );

        const provisioned = await client.callTool({
            name: "agent_provision_signer",
            arguments: { label: "researcher" },
        });
        assert.equal(provisioned.structuredContent.data.signer.keyId, "kms:researcher");
        assert.equal("privateKey" in provisioned.structuredContent.data, false);

        const inbox = await client.callTool({
            name: "messaging_wait_for_message",
            arguments: { timeoutMs: 250 },
        });
        assert.equal(inbox.structuredContent.data.timedOut, true);

        const invalid = await client.callTool({
            name: "memory_recall",
            arguments: { query: "", limit: 5 },
        });
        assert.equal(invalid.isError, true);
        assert.equal(invalid.structuredContent.ok, false);
        assert.equal(invalid.structuredContent.error.code, "INVALID_ARGUMENT");
    } finally {
        await client.close();
        await server.close().catch(() => undefined);
    }
});
