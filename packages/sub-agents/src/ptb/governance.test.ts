import assert from "node:assert/strict";
import test from "node:test";
import type { BuildTxContext } from "./post.js";
import type { GovernanceDelegateVoteParams } from "../types.js";
import { buildGovernanceDelegateVoteTx, validateGovernanceDelegateVote } from "./governance.js";
import { getSocialActionDescriptor, isSupportedSocialRegistryVersion } from "../action-registry/index.js";

class MockTx {
    calls: Array<{ target: string; arguments: unknown[] }> = [];
    moveCall(call: { target: string; arguments: unknown[] }) { this.calls.push(call); }
    object(id: string) { return { kind: "object", id }; }
    pure(type: string, value: unknown) { return { kind: "pure", type, value }; }
}

const base: GovernanceDelegateVoteParams = { registryId: "0x1", proposalId: "0x2", route: "ecosystem", approve: false, reason: "Not supported" };
const context = (extra: Record<string, unknown> = {}) => ({
    Transaction: MockTx,
    chain: { packageId: "0x50", clockId: "0x6", ecosystemTreasuryId: "0x7", platformObjectId: "0x8", ...extra },
}) as unknown as BuildTxContext;

test("delegate vote selects only the fixed ecosystem or platform entrypoint", () => {
    const ecosystem = buildGovernanceDelegateVoteTx(context(), base) as MockTx;
    assert.equal(ecosystem.calls[0].target, "0x50::governance::delegate_vote_on_proposal");
    assert.deepEqual(ecosystem.calls[0].arguments.map((arg: any) => arg?.id ?? arg), ["0x1", "0x2", "0x7", { kind: "pure", type: "bool", value: false }, { kind: "pure", type: "option<string>", value: "Not supported" }, "0x6"]);

    const platform = buildGovernanceDelegateVoteTx(context(), { ...base, route: "platform" }) as MockTx;
    assert.equal(platform.calls[0].target, "0x50::platform::delegate_vote_on_platform_governance_proposal");
    assert.deepEqual(platform.calls[0].arguments.slice(0, 3).map((arg: any) => arg.id), ["0x8", "0x1", "0x2"]);
});

test("delegate votes require exact route, identities and a bounded optional reason", () => {
    for (const change of [{ route: "arbitrary" }, { approve: "false" }, { proposalId: "0x" }, { reason: "x".repeat(1001) }]) {
        assert.throws(() => validateGovernanceDelegateVote({ ...base, ...change } as GovernanceDelegateVoteParams));
    }
    assert.throws(() => buildGovernanceDelegateVoteTx(context({ ecosystemTreasuryId: undefined }), base));
    assert.equal(getSocialActionDescriptor("governance.delegate_vote.v1").validate({ ...base, route: "platform", recipient: "0x9" }).success, false);
    assert.equal(isSupportedSocialRegistryVersion("1.18.0", "governance.delegate_vote.v1"), false);
    assert.equal(isSupportedSocialRegistryVersion("1.19.0", "governance.delegate_vote.v1"), true);
});
