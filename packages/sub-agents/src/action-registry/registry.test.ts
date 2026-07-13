import assert from "node:assert/strict";
import { test } from "node:test";
import {
    CAP_AGENT_REGISTER,
    CAP_AGENT_REVOKE,
    CAP_AGENT_UPDATE,
    CAP_COMMENT,
    CAP_MEMORY_READ,
    CAP_MESSAGE_SEND,
    CAP_POST_PUBLISH,
    CAP_REACT,
    CAP_SOCIAL_GRAPH,
} from "../contract.js";
import { deriveAgentAddress } from "../ptb/organization.js";
import type { SocialChainConfig } from "../types.js";
import {
    SOCIAL_ACTION_IDS,
    SOCIAL_ACTION_REGISTRY,
    UnsupportedSocialActionError,
    buildRegisteredSocialAction,
    canonicalizeActionParameters,
    createSocialActionRequestMetadata,
    finalizeSocialActionPreparation,
    getSocialActionDescriptor,
    hashActionParameters,
    isSocialActionId,
} from "./index.js";

const CHAIN: SocialChainConfig = {
    packageId: "0x50c1",
    usernameRegistryId: "0x1",
    platformRegistryId: "0x2",
    platformObjectId: "0x3",
    blockListRegistryId: "0x4",
    postConfigId: "0x5",
    mydataRegistryId: "0x6",
    memoryConfigId: "0x7",
    socialGraphId: "0x8",
    messagingPackageId: "0xe110",
    messagingVersionId: "0x9",
    messagingConfigId: "0xa",
    messagingNamespaceId: "0xb",
    messagingGroupManagerId: "0xc",
    messagingGroupLeaverId: "0xd",
};

class MockTx {
    calls: Array<{ target: string; arguments: unknown[] }> = [];

    moveCall(command: { target: string; arguments: unknown[] }) {
        this.calls.push(command);
    }

    object(id: string) {
        return { kind: "object", id };
    }

    pure(type: string, value: unknown) {
        return { kind: "pure", type, value };
    }
}

const CONTEXT = {
    Transaction: MockTx,
    chain: CHAIN,
    memoryAccountId: "0xmemory",
};

function assertObjectArgument(value: unknown, id: string): void {
    assert.deepEqual(value, { kind: "object", id });
}

function assertPureArgument(value: unknown, expected: string): void {
    assert.deepEqual(value, { kind: "pure", type: "string", value: expected });
}

test("registry contains only the explicit versioned social action IDs", () => {
    assert.deepEqual(Object.keys(SOCIAL_ACTION_REGISTRY), [...SOCIAL_ACTION_IDS]);
    assert.equal(isSocialActionId("social.react_to_post.v1"), true);
    assert.equal(isSocialActionId("0x50c1::post::react_to_post"), false);
    assert.equal(isSocialActionId("social.arbitrary_move_call.v1"), false);
    assert.throws(
        () => getSocialActionDescriptor("0x50c1::post::react_to_post"),
        UnsupportedSocialActionError,
    );
});

test("registry assigns capability and risk policy to every current action", () => {
    assert.deepEqual(
        SOCIAL_ACTION_IDS.map((id) => {
            const descriptor = getSocialActionDescriptor(id);
            return [id, descriptor.requiredCapability, descriptor.riskTier];
        }),
        [
            ["social.react_to_post.v1", CAP_REACT, "1A"],
            ["social.remove_post_reaction.v1", CAP_REACT, "1A"],
            ["social.react_to_comment.v1", CAP_REACT, "1A"],
            ["social.remove_comment_reaction.v1", CAP_REACT, "1A"],
            ["social.create_post.v1", CAP_POST_PUBLISH, "1B"],
            ["social.edit_post.v1", CAP_POST_PUBLISH, "1B"],
            ["social.create_comment.v1", CAP_COMMENT, "1B"],
            ["social.edit_comment.v1", CAP_COMMENT, "1B"],
            ["social.create_repost.v1", CAP_POST_PUBLISH, "1B"],
            ["social.remove_repost.v1", CAP_POST_PUBLISH, "1B"],
            ["social.follow_profile.v1", CAP_SOCIAL_GRAPH, "1A"],
            ["social.unfollow_profile.v1", CAP_SOCIAL_GRAPH, "1A"],
            ["social.block_profile.v1", CAP_SOCIAL_GRAPH, "1A"],
            ["social.unblock_profile.v1", CAP_SOCIAL_GRAPH, "1A"],
            ["messaging.send_message.v1", CAP_MESSAGE_SEND, "1B"],
            ["messaging.create_group.v1", CAP_MESSAGE_SEND, "1B"],
            ["organization.create.v1", CAP_AGENT_REGISTER, "3"],
            ["organization.update_metadata.v1", CAP_AGENT_UPDATE, "3"],
            ["organization.update_category.v1", CAP_AGENT_UPDATE, "3"],
            ["organization.deactivate.v1", CAP_AGENT_UPDATE, "3"],
            ["organization.ensure_memory_group.v1", CAP_AGENT_UPDATE, "3"],
            ["organization.define_role.v1", CAP_AGENT_UPDATE, "3"],
            ["organization.assign_role.v1", CAP_AGENT_UPDATE, "3"],
            ["organization.revoke_role.v1", CAP_AGENT_UPDATE, "3"],
            ["organization.create_invitation.v1", CAP_AGENT_UPDATE, "3"],
            ["organization.accept_invitation.v1", CAP_MEMORY_READ, "1B"],
            ["organization.decline_invitation.v1", CAP_MEMORY_READ, "1B"],
            ["agent.register_agent.v1", CAP_AGENT_REGISTER, "3"],
            ["agent.register_child.v1", CAP_AGENT_REGISTER, "1B"],
            ["agent.update_child.v1", CAP_AGENT_UPDATE, "1B"],
            ["agent.deactivate_child.v1", CAP_AGENT_REVOKE, "1B"],
            ["agent.revoke_child.v1", CAP_AGENT_REVOKE, "1B"],
            ["social.delete_post.v1", CAP_POST_PUBLISH, "3"],
            ["social.delete_comment.v1", CAP_COMMENT, "3"],
        ],
    );
});

test("registered builders preserve exact Move targets and important arguments", () => {
    const agentPublicKey = "11".repeat(32);
    const agentAddress = deriveAgentAddress(agentPublicKey);
    const cases = [
        {
            id: "social.remove_post_reaction.v1",
            input: { postId: "0xpost" },
            target: "0x50c1::post::remove_post_reaction",
            check(args: unknown[]) { assertObjectArgument(args[1], "0xpost"); },
        },
        {
            id: "social.remove_comment_reaction.v1",
            input: { commentId: "0xcomment" },
            target: "0x50c1::post::remove_comment_reaction",
            check(args: unknown[]) { assertObjectArgument(args[1], "0xcomment"); },
        },
        {
            id: "social.edit_post.v1",
            input: { postId: "0xpost", content: "edited" },
            target: "0x50c1::post::edit_post",
            check(args: unknown[]) { assertObjectArgument(args[6], "0xpost"); },
        },
        {
            id: "social.edit_comment.v1",
            input: { commentId: "0xcomment", content: "edited" },
            target: "0x50c1::post::edit_comment",
            check(args: unknown[]) { assertObjectArgument(args[6], "0xcomment"); },
        },
        {
            id: "social.remove_repost.v1",
            input: { originalPostId: "0xpost", repostId: "0xrepost" },
            target: "0x50c1::post::remove_repost",
            check(args: unknown[]) { assertObjectArgument(args[6], "0xrepost"); },
        },
        ...(["follow", "unfollow", "block", "unblock"] as const).map((verb) => ({
            id: `social.${verb}_profile.v1` as const,
            input: { targetOwner: "0xtarget" },
            target: `0x50c1::social_graph::${verb}_profile`,
            check(args: unknown[]) {
                assert.ok(args.some((arg) => JSON.stringify(arg).includes("0xtarget")));
            },
        })),
        {
            id: "messaging.send_message.v1",
            input: {
                groupId: "0xgroup",
                messageLogId: "0xlog",
                recipient: "0xrecipient",
                contentDigestHex: "ab".repeat(32),
                contentUri: "wal://encrypted-message",
                dedupeKey: "message-0001",
                nonce: "1",
            },
            target: "0xe110::messaging::send_agent_message_digest",
            check(args: unknown[]) { assert.equal(args.length, 14); },
        },
        {
            id: "messaging.create_group.v1",
            input: {
                name: "ops",
                uuid: "ops-0001",
                encryptedDekHex: "ab".repeat(32),
                initialMembers: ["0x123"],
            },
            target: "0xe110::messaging::create_agent_and_share_group",
            check(args: unknown[]) {
                assert.equal(args.length, 14);
                assertObjectArgument(args[1], "0xb");
            },
        },
        {
            id: "organization.create.v1",
            input: { orgType: 1, name: "Acme", description: "agent org" },
            target: "0x50c1::memory::create_agentic_organization",
            check(args: unknown[]) {
                assert.equal(args.length, 6);
                assertObjectArgument(args[0], "0x7");
                assertObjectArgument(args[1], "0xmemory");
            },
        },
        {
            id: "agent.register_agent.v1",
            input: {
                organizationId: "0xorg",
                publicKeyHex: agentPublicKey,
                derivedAddress: agentAddress,
                label: "root",
                capabilities: "8193",
                delegatableCaps: "8193",
            },
            target: "0x50c1::memory::register_sub_agent",
            check(args: unknown[]) {
                assert.equal(args.length, 16);
                assertObjectArgument(args[0], "0x7");
                assertObjectArgument(args[2], "0xorg");
            },
        },
        {
            id: "agent.register_child.v1",
            input: {
                parentAgentObjectId: "0xparent",
                registerRelation: 0,
                publicKeyHex: agentPublicKey,
                derivedAddress: agentAddress,
                label: "child",
            },
            target: "0x50c1::memory::register_sub_agent_delegated",
            check(args: unknown[]) {
                assert.equal(args.length, 17);
                assertObjectArgument(args[2], "0xparent");
            },
        },
        {
            id: "social.create_post.v1",
            input: { content: "hello" },
            target: "0x50c1::post::create_post",
            check(args: unknown[]) {
                assert.equal(args.length, 24);
                assertObjectArgument(args[5], "0x7");
                assertPureArgument(args[6], "hello");
                assert.deepEqual(args[17], { kind: "pure", type: "u8", value: 1 });
            },
        },
        {
            id: "social.create_comment.v1",
            input: { postId: "0xpost", content: "reply" },
            target: "0x50c1::post::create_comment",
            check(args: unknown[]) {
                assert.equal(args.length, 14);
                assertObjectArgument(args[5], "0x7");
                assertObjectArgument(args[6], "0xmemory");
                assertObjectArgument(args[7], "0xpost");
                assertPureArgument(args[9], "reply");
            },
        },
        {
            id: "social.react_to_post.v1",
            input: { postId: "0xpost", reaction: "like" },
            target: "0x50c1::post::react_to_post",
            check(args: unknown[]) {
                assert.equal(args.length, 10);
                assertObjectArgument(args[1], "0xpost");
                assertObjectArgument(args[6], "0x7");
                assertPureArgument(args[8], "like");
            },
        },
        {
            id: "social.react_to_comment.v1",
            input: { commentId: "0xcomment", reaction: "like" },
            target: "0x50c1::post::react_to_comment",
            check(args: unknown[]) {
                assert.equal(args.length, 10);
                assertObjectArgument(args[1], "0xcomment");
                assertObjectArgument(args[6], "0x7");
                assertPureArgument(args[8], "like");
            },
        },
        {
            id: "social.create_repost.v1",
            input: { originalPostId: "0xoriginal", content: "quote" },
            target: "0x50c1::post::create_repost",
            check(args: unknown[]) {
                assert.equal(args.length, 20);
                assertObjectArgument(args[5], "0x7");
                assertObjectArgument(args[6], "0xoriginal");
                assert.deepEqual(args[7], {
                    kind: "pure",
                    type: "option<string>",
                    value: "quote",
                });
            },
        },
        {
            id: "social.delete_post.v1",
            input: { postId: "0xpost" },
            target: "0x50c1::post::delete_post",
            check(args: unknown[]) {
                assert.equal(args.length, 2);
                assertObjectArgument(args[0], "0xpost");
            },
        },
        {
            id: "social.delete_comment.v1",
            input: { postId: "0xpost", commentId: "0xcomment" },
            target: "0x50c1::post::delete_comment",
            check(args: unknown[]) {
                assert.equal(args.length, 3);
                assertObjectArgument(args[0], "0xpost");
                assertObjectArgument(args[1], "0xcomment");
            },
        },
    ] as const;

    for (const action of cases) {
        const tx = buildRegisteredSocialAction(
            action.id,
            CONTEXT,
            action.input,
        ) as MockTx;
        assert.equal(tx.calls.length, 1);
        assert.equal(tx.calls[0]!.target, action.target);
        action.check(tx.calls[0]!.arguments);
    }
});

test("validation rejects missing, mistyped, and arbitrary parameters", () => {
    const descriptor = getSocialActionDescriptor("social.react_to_post.v1");
    const result = descriptor.validate({
        postId: "0xpost",
        reaction: "like",
        moveTarget: "0x50c1::admin::take_over",
    });
    assert.equal(result.success, false);
    if (!result.success) {
        assert.ok(result.issues.some((issue) => issue.code === "additional_property"));
    }

    const invalidAccess = getSocialActionDescriptor(
        "social.create_post.v1",
    ).validate({
        content: "ambiguous gated post",
        linkedMydataId: "0xmydata",
    });
    assert.equal(invalidAccess.success, false);
    if (!invalidAccess.success) {
        assert.ok(invalidAccess.issues.some((issue) => issue.code === "invalid_value"));
    }

    assert.throws(
        () =>
            buildRegisteredSocialAction(
                "social.arbitrary_move_call.v1",
                CONTEXT,
                { target: "0x50c1::admin::take_over" },
            ),
        UnsupportedSocialActionError,
    );
});

test("parameter hashing is deterministic across object key order", async () => {
    const left = { reaction: "like", postId: "0xpost" };
    const right = { postId: "0xpost", reaction: "like" };
    assert.equal(
        canonicalizeActionParameters(left),
        canonicalizeActionParameters(right),
    );
    assert.equal(await hashActionParameters(left), await hashActionParameters(right));
});

test("request and preparation metadata pin idempotency, registry, package, and bytes", async () => {
    const request = await createSocialActionRequestMetadata(
        "social.react_to_post.v1",
        { postId: "0xpost", reaction: "like" },
        "request-123",
    );
    assert.equal(request.registryVersion, "1.3.0");
    assert.equal(request.idempotency.scope, "account-agent-action");
    assert.match(request.parameterHash, /^sha256:[a-f0-9]{64}$/);

    const prepared = finalizeSocialActionPreparation(request, {
        actionId: "action-123",
        packageId: CHAIN.packageId,
        packageVersion: "1",
        transactionBytesHash:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        preparedAtMs: 1_000,
        expiresAtMs: 2_000,
    });
    assert.equal(prepared.registryAction, "social.react_to_post.v1");
    assert.equal(prepared.transactionBytesHash.slice(0, 7), "sha256:");
});
