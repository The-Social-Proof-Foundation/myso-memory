import assert from "node:assert/strict";
import { test } from "node:test";
import type { SocialChainConfig } from "../types.js";
import {
    buildCreateCommentTx,
    buildCreatePostTx,
    buildCreateRepostTx,
    buildDeleteCommentTx,
    buildDeletePostTx,
    buildReactToCommentTx,
    buildReactToPostTx,
} from "./post.js";
import { MYSO_CLOCK } from "./helpers.js";

const CHAIN: SocialChainConfig = {
    packageId: "0x50c1",
    usernameRegistryId: "0x1",
    platformRegistryId: "0x2",
    platformObjectId: "0x3",
    blockListRegistryId: "0x4",
    postConfigId: "0x5",
    mydataRegistryId: "0x6",
    memoryConfigId: "0x7",
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

const object = (id: string) => ({ kind: "object", id });
const pure = (type: string, value: unknown) => ({ kind: "pure", type, value });

function ctx(memoryAccountId = "0xmem") {
    return { Transaction: MockTx, chain: CHAIN, memoryAccountId };
}

function call(tx: MockTx): { target: string; arguments: unknown[] } {
    assert.equal(tx.calls.length, 1);
    return tx.calls[0]!;
}

test("buildCreatePostTx matches the current create_post ABI with public defaults", () => {
    const result = call(buildCreatePostTx(ctx(), { content: "hello" }) as MockTx);
    assert.equal(result.target, "0x50c1::post::create_post");
    assert.deepEqual(result.arguments, [
        object("0x1"),
        object("0x2"),
        object("0x3"),
        object("0x4"),
        object("0x5"),
        object("0x7"),
        pure("string", "hello"),
        pure("option<vector<string>>", null),
        pure("option<vector<address>>", null),
        pure("option<string>", null),
        pure("option<bool>", null),
        pure("option<bool>", null),
        pure("option<bool>", null),
        pure("option<bool>", null),
        pure("option<bool>", null),
        pure("option<bool>", null),
        pure("option<bool>", null),
        pure("u8", 1),
        pure("option<address>", null),
        pure("option<address>", null),
        pure("option<u64>", null),
        object("0x6"),
        object("0xmem"),
        object(MYSO_CLOCK),
    ]);
});

test("buildCreatePostTx encodes profile-subscription access fields", () => {
    const result = call(
        buildCreatePostTx(ctx(), {
            content: "members",
            accessKind: 2,
            subscriptionServiceId: "0xservice",
            linkedMydataId: "0xmydata",
            subscriptionMinTierLevel: 3,
        }) as MockTx,
    );
    assert.deepEqual(result.arguments.slice(17, 21), [
        pure("u8", 2),
        pure("option<address>", "0xservice"),
        pure("option<address>", "0xmydata"),
        pure("option<u64>", 3),
    ]);
});

test("buildCreatePostTx rejects access combinations Move cannot interpret safely", () => {
    assert.throws(
        () =>
            buildCreatePostTx(ctx(), {
                content: "ambiguous",
                linkedMydataId: "0xmydata",
            }),
        /accessKind is required/,
    );
    assert.throws(
        () => buildCreatePostTx(ctx(), { content: "members", accessKind: 2 }),
        /subscriptionServiceId is required/,
    );
    assert.throws(
        () => buildCreatePostTx(ctx(), { content: "market", accessKind: 3 }),
        /linkedMydataId is required/,
    );
});

test("buildCreateCommentTx matches the current create_comment ABI", () => {
    const result = call(
        buildCreateCommentTx(ctx(), {
            postId: "0xpost",
            content: "reply",
        }) as MockTx,
    );
    assert.equal(result.target, "0x50c1::post::create_comment");
    assert.deepEqual(result.arguments, [
        object("0x1"),
        object("0x2"),
        object("0x3"),
        object("0x4"),
        object("0x5"),
        object("0x7"),
        object("0xmem"),
        object("0xpost"),
        pure("option<address>", null),
        pure("string", "reply"),
        pure("option<vector<string>>", null),
        pure("option<vector<address>>", null),
        pure("option<string>", null),
        object(MYSO_CLOCK),
    ]);
});

test("reaction builders match the current post and comment ABIs", () => {
    for (const [tx, target, targetId] of [
        [
            buildReactToPostTx(ctx(), { postId: "0xpost", reaction: "like" }),
            "0x50c1::post::react_to_post",
            "0xpost",
        ],
        [
            buildReactToCommentTx(ctx(), {
                commentId: "0xcomment",
                reaction: "like",
            }),
            "0x50c1::post::react_to_comment",
            "0xcomment",
        ],
    ] as const) {
        const result = call(tx as MockTx);
        assert.equal(result.target, target);
        assert.deepEqual(result.arguments, [
            object("0x1"),
            object(targetId),
            object("0x2"),
            object("0x3"),
            object("0x4"),
            object("0x5"),
            object("0x7"),
            object("0xmem"),
            pure("string", "like"),
            object(MYSO_CLOCK),
        ]);
    }
});

test("buildCreateRepostTx matches the current create_repost ABI", () => {
    const result = call(
        buildCreateRepostTx(ctx(), {
            originalPostId: "0xoriginal",
            content: "quote",
        }) as MockTx,
    );
    assert.equal(result.target, "0x50c1::post::create_repost");
    assert.deepEqual(result.arguments, [
        object("0x1"),
        object("0x2"),
        object("0x3"),
        object("0x4"),
        object("0x5"),
        object("0x7"),
        object("0xoriginal"),
        pure("option<string>", "quote"),
        pure("option<vector<string>>", null),
        pure("option<vector<address>>", null),
        pure("option<string>", null),
        pure("option<bool>", null),
        pure("option<bool>", null),
        pure("option<bool>", null),
        pure("option<bool>", null),
        pure("option<bool>", null),
        pure("option<bool>", null),
        pure("option<bool>", null),
        object("0xmem"),
        object(MYSO_CLOCK),
    ]);
});

test("delete builders include the Clock required by the current ABI", () => {
    const deletePost = call(
        buildDeletePostTx(CHAIN, "0xpost", MockTx) as MockTx,
    );
    assert.equal(deletePost.target, "0x50c1::post::delete_post");
    assert.deepEqual(deletePost.arguments, [
        object("0xpost"),
        object(MYSO_CLOCK),
    ]);

    const deleteComment = call(
        buildDeleteCommentTx(CHAIN, "0xpost", "0xcomment", MockTx) as MockTx,
    );
    assert.equal(deleteComment.target, "0x50c1::post::delete_comment");
    assert.deepEqual(deleteComment.arguments, [
        object("0xpost"),
        object("0xcomment"),
        object(MYSO_CLOCK),
    ]);
});
