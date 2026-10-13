import assert from "node:assert/strict";
import { test } from "node:test";
import {
    CAP_AGENT_REGISTER,
    CAP_AGENT_REVOKE,
    CAP_AGENT_UPDATE,
    CAP_COMMENT,
    CAP_JURY,
    CAP_JURY_KEEPER,
    CAP_MEMORY_READ,
    CAP_MESSAGE_SEND,
    CAP_POST_PUBLISH,
    CAP_REACT,
    CAP_SOCIAL_GRAPH,
    CAP_TASK_TRADE,
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
    taskConfigId: "0xf",
    juryConfigId: "0xf1",
    jurorRosterId: "0xf2",
    ecosystemTreasuryId: "0xf3",
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
            ["task.create.v1", CAP_TASK_TRADE, "1B"],
            ["task.accept.v1", CAP_TASK_TRADE, "1B"],
            ["task.decline.v1", CAP_TASK_TRADE, "1B"],
            ["task.cancel_offer.v1", CAP_TASK_TRADE, "1B"],
            ["task.deliver.v1", CAP_TASK_TRADE, "1B"],
            ["task.settle.v1", CAP_TASK_TRADE, "1B"],
            ["task.refund.v1", CAP_TASK_TRADE, "1B"],
            ["task.release.v1", CAP_TASK_TRADE, "1B"],
            ["task.expire_offer.v1", CAP_TASK_TRADE, "1B"],
            ["task.propose_refund.v1", CAP_TASK_TRADE, "1B"],
            ["task.accept_refund.v1", CAP_TASK_TRADE, "1B"],
            ["task.reject_refund.v1", CAP_TASK_TRADE, "1B"],
            ["task.withdraw_refund.v1", CAP_TASK_TRADE, "1B"],
            ["task.review.v1", CAP_TASK_TRADE, "1B"],
            ["task.open_dispute.v1", CAP_TASK_TRADE, "1B"],
            ["task.respond_dispute.v1", CAP_TASK_TRADE, "1B"],
            ["task.submit_evidence.v1", CAP_TASK_TRADE, "1B"],
            ["task.appeal.v1", CAP_TASK_TRADE, "1B"],
            ["task.cancel_dispute.v1", CAP_TASK_TRADE, "1B"],
            ["task.propose_dispute_settlement.v1", CAP_TASK_TRADE, "1B"],
            ["task.accept_dispute_settlement.v1", CAP_TASK_TRADE, "1B"],
            ["task.clear_dispute_settlement.v1", CAP_TASK_TRADE, "1B"],
            ["jury.accept.v1", CAP_JURY, "1B"],
            ["jury.commit_vote.v1", CAP_JURY, "1B"],
            ["jury.reveal_vote.v1", CAP_JURY, "1B"],
            ["jury.claim_fee.v1", CAP_JURY, "1B"],
            ["jury.select_jury.v1", CAP_JURY_KEEPER, "1B"],
            ["jury.replace_no_shows.v1", CAP_JURY_KEEPER, "1B"],
            ["jury.finalize_round.v1", CAP_JURY_KEEPER, "1B"],
            ["jury.finalize_case.v1", CAP_JURY_KEEPER, "1B"],
            ["jury.execute_task_verdict.v1", CAP_JURY_KEEPER, "1B"],
            ["jury.start_neutral_resolution.v1", CAP_JURY_KEEPER, "1B"],
            ["jury.execute_neutral_resolution.v1", CAP_JURY_KEEPER, "1B"],
            ["jury.settle_dispute_fees.v1", CAP_JURY_KEEPER, "1B"],
            ["jury.escalate_proposal.v1", CAP_JURY_KEEPER, "1B"],
            ["jury.finalize_proposal.v1", CAP_JURY_KEEPER, "1B"],
            ["jury.apply_proposal_decision.v1", CAP_JURY_KEEPER, "1B"],
            ["jury.sweep_case.v1", CAP_JURY_KEEPER, "1B"],
            ["jury.refresh_roster_entry.v1", CAP_JURY_KEEPER, "1B"],
            ["jury.evict_ineligible.v1", CAP_JURY_KEEPER, "1B"],
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
                // 12 inputs + roomKind + roomTaskId + clock.
                assert.equal(args.length, 16);
                assertObjectArgument(args[1], "0xb");
            },
        },
        {
            id: "messaging.create_group.v1",
            input: {
                name: "task room",
                uuid: "room-0001",
                encryptedDekHex: "ab".repeat(32),
                initialMembers: ["0x123"],
                roomKind: 1,
                roomTaskId: "0x7a5c",
            },
            target: "0xe110::messaging::create_agent_and_share_group",
            check(args: unknown[]) { assert.equal(args.length, 16); },
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
    assert.equal(request.registryVersion, "1.5.0");
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

test("messaging room parameters reject an unmapped kind and an unbound task id", () => {
    const base = {
        name: "task room",
        uuid: "room-0002",
        encryptedDekHex: "ab".repeat(32),
        initialMembers: ["0x123"],
    };
    assert.throws(
        () => buildRegisteredSocialAction("messaging.create_group.v1", CONTEXT, { ...base, roomKind: 2 }),
        /roomKind must be 1/,
    );
    assert.throws(
        () =>
            buildRegisteredSocialAction("messaging.create_group.v1", CONTEXT, {
                ...base,
                roomTaskId: "0x7a5c",
            }),
        /roomTaskId requires roomKind/,
    );
});

const DIGEST_HEX = "ab".repeat(32);
const DIGEST_BYTES = Array.from({ length: 32 }, () => 0xab);

function buildTask(id: string, input: unknown): { target: string; arguments: unknown[] } {
    const tx = buildRegisteredSocialAction(id, CONTEXT, input) as MockTx;
    assert.equal(tx.calls.length, 1);
    return tx.calls[0]!;
}

test("task builders mirror the Move entrypoint argument order", () => {
    const create = buildTask("task.create.v1", {
        sellerAccountId: "0xsa",
        sellerAgentId: "0xsag",
        amountMist: "5000000000",
        scopeDigestHex: DIGEST_HEX,
        title: "Translate",
        acceptWindowMs: "3600000",
        deliveryWindowMs: "86400000",
        settleWindowMs: "86400000",
        paymentCoinId: "0xcoin",
        roomGroupId: "0xroom",
    });
    assert.equal(create.target, "0x50c1::agent_task::create_task");
    assert.equal(create.arguments.length, 15);
    assertObjectArgument(create.arguments[0], "0xf");
    assertObjectArgument(create.arguments[1], "0x7");
    assertObjectArgument(create.arguments[2], "0xmemory");
    assertObjectArgument(create.arguments[3], "0xsa");
    assertObjectArgument(create.arguments[4], "0xsag");
    assertObjectArgument(create.arguments[5], "0xcoin");
    assert.deepEqual(create.arguments[6], { kind: "pure", type: "u64", value: "5000000000" });
    assert.deepEqual(create.arguments[7], { kind: "pure", type: "vector<u8>", value: DIGEST_BYTES });
    assert.deepEqual(create.arguments[12], { kind: "pure", type: "option<address>", value: "0xroom" });
    assert.deepEqual(create.arguments[13], { kind: "pure", type: "option<address>", value: null });

    const accept = buildTask("task.accept.v1", {
        taskId: "0xtask",
        sellerAgentId: "0xsag",
        termsDigestHex: DIGEST_HEX,
    });
    assert.equal(accept.target, "0x50c1::agent_task::accept_task");
    assert.equal(accept.arguments.length, 7);
    assertObjectArgument(accept.arguments[1], "0xtask");
    assertObjectArgument(accept.arguments[3], "0xmemory");
    assertObjectArgument(accept.arguments[4], "0xsag");

    const decline = buildTask("task.decline.v1", { taskId: "0xtask", sellerAgentId: "0xsag" });
    assert.equal(decline.target, "0x50c1::agent_task::decline_task");
    assert.equal(decline.arguments.length, 5);

    const cancel = buildTask("task.cancel_offer.v1", { taskId: "0xtask" });
    assert.equal(cancel.target, "0x50c1::agent_task::cancel_offer");
    assert.equal(cancel.arguments.length, 4);
    assertObjectArgument(cancel.arguments[2], "0xmemory");

    const deliver = buildTask("task.deliver.v1", {
        taskId: "0xtask",
        sellerAgentId: "0xsag",
        digestHex: DIGEST_HEX,
        uri: "wal://deliverable",
    });
    assert.equal(deliver.target, "0x50c1::agent_task::mark_delivered");
    assert.equal(deliver.arguments.length, 6);
    assertPureArgument(deliver.arguments[4], "wal://deliverable");

    const settle = buildTask("task.settle.v1", { taskId: "0xtask", sellerAccountId: "0xsa" });
    assert.equal(settle.target, "0x50c1::agent_task::settle_task");
    assert.equal(settle.arguments.length, 7);
    assertObjectArgument(settle.arguments[3], "0xmemory");
    assertObjectArgument(settle.arguments[4], "0xsa");
    assertObjectArgument(settle.arguments[5], "0x3");

    const release = buildTask("task.release.v1", {
        taskId: "0xtask",
        buyerAccountId: "0xba",
        sellerAccountId: "0xsa",
        platformObjectId: "0xplat",
    });
    assert.equal(release.target, "0x50c1::agent_task::release_task");
    assert.equal(release.arguments.length, 6);
    assertObjectArgument(release.arguments[4], "0xplat");

    for (const [id, fn] of [
        ["task.refund.v1", "refund_task"],
        ["task.expire_offer.v1", "expire_offer"],
    ] as const) {
        const call = buildTask(id, { taskId: "0xtask" });
        assert.equal(call.target, `0x50c1::agent_task::${fn}`);
        assert.equal(call.arguments.length, 2);
    }

    for (const [id, fn] of [
        ["task.propose_refund.v1", "propose_refund"],
        ["task.accept_refund.v1", "accept_refund"],
        ["task.reject_refund.v1", "reject_refund"],
        ["task.withdraw_refund.v1", "withdraw_refund"],
    ] as const) {
        const call = buildTask(id, { taskId: "0xtask", buyerAccountId: "0xba", sellerAgentId: "0xsag" });
        assert.equal(call.target, `0x50c1::agent_task::${fn}`);
        assert.equal(call.arguments.length, 5);
        assertObjectArgument(call.arguments[2], "0xba");
        assertObjectArgument(call.arguments[3], "0xsag");
    }
});

test("task.review picks the Move entrypoint from the rater role and buyer shape", () => {
    const base = { taskId: "0xtask", stars: 5, buyerAccountId: "0xba", sellerAgentId: "0xsag" };

    const seller = buildTask("task.review.v1", { ...base, raterRole: "buyer", sellerAccountId: "0xsa" });
    assert.equal(seller.target, "0x50c1::agent_task::review_seller");
    assert.equal(seller.arguments.length, 8);
    assertObjectArgument(seller.arguments[4], "0xsa");
    assert.deepEqual(seller.arguments[6], { kind: "pure", type: "u8", value: 5 });

    const agent = buildTask("task.review.v1", { ...base, raterRole: "seller", buyerAgentId: "0xbag" });
    assert.equal(agent.target, "0x50c1::agent_task::review_buyer_agent");
    assert.equal(agent.arguments.length, 7);
    assertObjectArgument(agent.arguments[3], "0xbag");

    const principal = buildTask("task.review.v1", { ...base, raterRole: "seller" });
    assert.equal(principal.target, "0x50c1::agent_task::review_buyer_principal");
    assert.equal(principal.arguments.length, 6);
});

test("task action validation rejects bad digests, stars, roles and a missing task config", () => {
    const create = getSocialActionDescriptor("task.create.v1");
    const valid = {
        sellerAccountId: "0xsa",
        sellerAgentId: "0xsag",
        amountMist: "1",
        scopeDigestHex: DIGEST_HEX,
        title: "t",
        acceptWindowMs: "1",
        deliveryWindowMs: "1",
        settleWindowMs: "1",
        paymentCoinId: "0xcoin",
    };
    assert.equal(create.validate(valid).success, true);
    assert.equal(create.validate({ ...valid, moveTarget: "0x1::x::y" }).success, false);
    assert.throws(() => buildTask("task.create.v1", { ...valid, scopeDigestHex: "zz" }), /scopeDigestHex/);
    assert.throws(() => buildTask("task.create.v1", { ...valid, amountMist: "0" }), /greater than zero/);
    assert.throws(() => buildTask("task.create.v1", { ...valid, amountMist: "-1" }), /u64/);
    assert.throws(
        () => buildTask("task.create.v1", { ...valid, amountMist: "18446744073709551616" }),
        /u64/,
    );

    const review = getSocialActionDescriptor("task.review.v1");
    const base = { taskId: "0xt", buyerAccountId: "0xba", sellerAgentId: "0xsag" };
    assert.equal(review.validate({ ...base, raterRole: "buyer", stars: 0, sellerAccountId: "0xsa" }).success, false);
    assert.equal(review.validate({ ...base, raterRole: "buyer", stars: 6, sellerAccountId: "0xsa" }).success, false);
    assert.equal(review.validate({ ...base, raterRole: "admin", stars: 3 }).success, false);
    assert.equal(review.validate({ ...base, raterRole: "buyer", stars: 3 }).success, false);
    assert.equal(review.validate({ ...base, raterRole: "seller", stars: 3 }).success, true);

    const noConfig = { ...CONTEXT, chain: { ...CHAIN, taskConfigId: undefined } };
    assert.throws(
        () => buildRegisteredSocialAction("task.accept.v1", noConfig, {
            taskId: "0xtask",
            sellerAgentId: "0xsag",
            termsDigestHex: DIGEST_HEX,
        }),
        /taskConfigId/,
    );
});
