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

const CHAIN: SocialChainConfig = {
    packageId: "0x50c1",
    usernameRegistryId: "0x1",
    platformRegistryId: "0x2",
    platformObjectId: "0x3",
    blockListRegistryId: "0x4",
    postConfigId: "0x5",
    mydataRegistryId: "0x6",
};

class MockTx {
    calls: Array<{ target: string; arguments: unknown[] }> = [];

    moveCall(cmd: { target: string; arguments: unknown[] }) {
        this.calls.push(cmd);
    }

    object(id: string) {
        return { kind: "object", id };
    }

    pure(_type: string, value: unknown) {
        return { kind: "pure", value };
    }
}

function ctx(memoryAccountId = "0xmem") {
    return {
        Transaction: MockTx,
        chain: CHAIN,
        memoryAccountId,
    };
}

function target(tx: MockTx): string {
    assert.equal(tx.calls.length, 1);
    return tx.calls[0]!.target;
}

test("buildCreatePostTx targets post::create_post", () => {
    const tx = buildCreatePostTx(ctx(), { content: "hello" }) as MockTx;
    assert.equal(target(tx), "0x50c1::post::create_post");
    assert.equal((tx.calls[0]!.arguments[5] as { value: string }).value, "hello");
});

test("buildCreateCommentTx targets post::create_comment", () => {
    const tx = buildCreateCommentTx(ctx(), {
        postId: "0xpost",
        content: "reply",
    }) as MockTx;
    assert.equal(target(tx), "0x50c1::post::create_comment");
});

test("buildReactToPostTx targets post::react_to_post", () => {
    const tx = buildReactToPostTx(ctx(), {
        postId: "0xpost",
        reaction: "like",
    }) as MockTx;
    assert.equal(target(tx), "0x50c1::post::react_to_post");
});

test("buildReactToCommentTx targets post::react_to_comment", () => {
    const tx = buildReactToCommentTx(ctx(), {
        commentId: "0xcmt",
        reaction: "like",
    }) as MockTx;
    assert.equal(target(tx), "0x50c1::post::react_to_comment");
});

test("buildCreateRepostTx targets post::create_repost", () => {
    const tx = buildCreateRepostTx(ctx(), {
        originalPostId: "0xorig",
        content: "quote",
    }) as MockTx;
    assert.equal(target(tx), "0x50c1::post::create_repost");
});

test("buildDeletePostTx targets post::delete_post", () => {
    const tx = buildDeletePostTx(CHAIN, "0xpost", MockTx) as MockTx;
    assert.equal(target(tx), "0x50c1::post::delete_post");
});

test("buildDeleteCommentTx targets post::delete_comment", () => {
    const tx = buildDeleteCommentTx(CHAIN, "0xpost", "0xcmt", MockTx) as MockTx;
    assert.equal(target(tx), "0x50c1::post::delete_comment");
});
