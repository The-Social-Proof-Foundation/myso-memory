import assert from "node:assert/strict";
import { test } from "node:test";
import type { SocialChainConfig } from "../types.js";
import { buildRegisteredSocialAction } from "../action-registry/index.js";
import { MYSO_RANDOM } from "./helpers.js";

const CHAIN: SocialChainConfig = {
    packageId: "0x50c1",
    usernameRegistryId: "0x1",
    platformRegistryId: "0x2",
    platformObjectId: "0x3",
    blockListRegistryId: "0x4",
    postConfigId: "0x5",
    mydataRegistryId: "0x6",
    memoryConfigId: "0x7",
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

const CONTEXT = { Transaction: MockTx, chain: CHAIN, memoryAccountId: "0xmemory" };
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";
const HEX32 = "ab".repeat(32);
const BYTES32 = Array.from({ length: 32 }, () => 0xab);

const obj = (id: string) => ({ kind: "object", id });
const pure = (type: string, value: unknown) => ({ kind: "pure", type, value });

function build(id: string, input: unknown, chain: SocialChainConfig = CHAIN) {
    const tx = buildRegisteredSocialAction(id, { ...CONTEXT, chain }, input) as MockTx;
    return tx.calls;
}

function single(id: string, input: unknown) {
    const calls = build(id, input);
    assert.equal(calls.length, 1);
    return calls[0]!;
}

test("a juror's steps pass the owner account and the juror's own agent", () => {
    const accept = single("jury.accept.v1", { caseId: "0xcase", agentId: "0xagent" });
    assert.equal(accept.target, "0x50c1::jury::accept_assignment");
    assert.deepEqual(accept.arguments, [
        obj("0xf1"), obj("0xcase"), obj("0x7"), obj("0xmemory"), obj("0xagent"), obj(CLOCK),
    ]);

    const commit = single("jury.commit_vote.v1", { caseId: "0xcase", agentId: "0xagent", commitmentHex: HEX32 });
    assert.equal(commit.target, "0x50c1::jury::commit_vote");
    assert.deepEqual(commit.arguments, [
        obj("0xcase"), obj("0x7"), obj("0xmemory"), obj("0xagent"), pure("vector<u8>", BYTES32), obj(CLOCK),
    ]);

    const reveal = single("jury.reveal_vote.v1", {
        caseId: "0xcase",
        agentId: "0xagent",
        outcome: 1,
        rationaleDigestHex: HEX32,
        evidenceRefs: ["0", "2"],
        bundleDigestHex: HEX32,
        saltHex: "cd".repeat(16),
    });
    assert.equal(reveal.target, "0x50c1::jury::reveal_vote");
    assert.equal(reveal.arguments.length, 10);
    assert.deepEqual(reveal.arguments[4], pure("u8", 1));
    assert.deepEqual(reveal.arguments[6], pure("vector<u64>", ["0", "2"]));
    assert.deepEqual(reveal.arguments[8], pure("vector<u8>", Array.from({ length: 16 }, () => 0xcd)));
});

test("claiming a fee names the case and the agent and takes no money argument", () => {
    const claim = single("jury.claim_fee.v1", { caseId: "0xcase", agentId: "0xagent" });
    assert.equal(claim.target, "0x50c1::jury::claim_juror_fee");
    assert.deepEqual(claim.arguments, [obj("0xcase"), pure("address", "0xagent")]);
});

test("a draw reads the shared Random object, which is fixed and never a parameter", () => {
    for (const [id, fn] of [
        ["jury.select_jury.v1", "select_jury"],
        ["jury.replace_no_shows.v1", "replace_no_shows"],
    ] as const) {
        const call = single(id, { caseId: "0xcase" });
        assert.equal(call.target, `0x50c1::jury::${fn}`);
        assert.deepEqual(call.arguments, [obj("0xf1"), obj("0xf2"), obj("0xcase"), obj(MYSO_RANDOM), obj(CLOCK)]);
    }
    assert.equal(MYSO_RANDOM, "0x0000000000000000000000000000000000000000000000000000000000000008");
    assert.throws(() => build("jury.select_jury.v1", { caseId: "0xcase", random: "0xdead" }));
});

test("finalizing a round or a case takes the config, the roster and the case", () => {
    for (const [id, fn] of [
        ["jury.finalize_round.v1", "finalize_round"],
        ["jury.finalize_case.v1", "finalize_case"],
    ] as const) {
        const call = single(id, { caseId: "0xcase" });
        assert.equal(call.target, `0x50c1::jury::${fn}`);
        assert.deepEqual(call.arguments, [obj("0xf1"), obj("0xf2"), obj("0xcase"), obj(CLOCK)]);
    }
});

test("roster upkeep cranks", () => {
    const refresh = single("jury.refresh_roster_entry.v1", { accountId: "0xacct", agentId: "0xagent" });
    assert.equal(refresh.target, "0x50c1::jury::refresh_roster_entry");
    assert.deepEqual(refresh.arguments, [
        obj("0xf1"), obj("0xf2"), obj("0x7"), obj("0xacct"), obj("0xagent"), obj(CLOCK),
    ]);
    const evict = single("jury.evict_ineligible.v1", { agentId: "0xagent" });
    assert.equal(evict.target, "0x50c1::jury::evict_ineligible");
    assert.deepEqual(evict.arguments, [obj("0xf1"), obj("0xf2"), pure("address", "0xagent"), obj(CLOCK)]);
    const sweep = single("jury.sweep_case.v1", { caseId: "0xcase" });
    assert.equal(sweep.target, "0x50c1::governance::sweep_jury_case");
    assert.deepEqual(sweep.arguments, [obj("0xcase")]);
});

test("a task verdict and the neutral split mirror the Move entrypoints, defaulting the platform", () => {
    const verdict = single("jury.execute_task_verdict.v1", {
        taskId: "0xtask", caseId: "0xcase", buyerAccountId: "0xb", sellerAccountId: "0xs",
    });
    assert.equal(verdict.target, "0x50c1::agent_task::execute_verdict");
    assert.deepEqual(verdict.arguments, [
        obj("0xf"), obj("0xtask"), obj("0xcase"), obj("0xb"), obj("0xs"), obj("0x3"), obj(CLOCK),
    ]);
    const start = single("jury.start_neutral_resolution.v1", { taskId: "0xtask", caseId: "0xcase" });
    assert.equal(start.target, "0x50c1::agent_task::start_neutral_resolution");
    assert.deepEqual(start.arguments, [obj("0xf1"), obj("0xtask"), obj("0xcase"), obj(CLOCK)]);
    const neutral = single("jury.execute_neutral_resolution.v1", {
        taskId: "0xtask", buyerAccountId: "0xb", sellerAccountId: "0xs", platformObjectId: "0xplat",
    });
    assert.equal(neutral.target, "0x50c1::agent_task::execute_neutral_resolution");
    assert.deepEqual(neutral.arguments, [
        obj("0xf"), obj("0xtask"), obj("0xb"), obj("0xs"), obj("0xplat"), obj(CLOCK),
    ]);
});

test("settling dispute fees closes a still-open case first, in the same transaction", () => {
    const open = build("jury.settle_dispute_fees.v1", { taskId: "0xtask", caseId: "0xcase", closeCaseFirst: true });
    assert.deepEqual(open.map((c) => c.target), [
        "0x50c1::agent_task::close_case_after_resolution",
        "0x50c1::agent_task::settle_dispute_fees",
    ]);
    assert.deepEqual(open[0]!.arguments, [obj("0xf1"), obj("0xf2"), obj("0xtask"), obj("0xcase"), obj(CLOCK)]);
    const done = build("jury.settle_dispute_fees.v1", { taskId: "0xtask", caseId: "0xcase" });
    assert.deepEqual(done.map((c) => c.target), ["0x50c1::agent_task::settle_dispute_fees"]);
    assert.deepEqual(done[0]!.arguments, [obj("0xtask"), obj("0xcase"), obj(CLOCK)]);
});

test("a party opens a dispute with a fee coin and the contract resolves which side it is", () => {
    const open = single("task.open_dispute.v1", {
        taskId: "0xtask", buyerAccountId: "0xb", sellerAccountId: "0xs", sellerAgentId: "0xsa", feeCoinId: "0xcoin",
    });
    assert.equal(open.target, "0x50c1::agent_task::open_dispute");
    assert.deepEqual(open.arguments, [
        obj("0xf"), obj("0xf1"), obj("0xf2"), obj("0xtask"), obj("0x7"),
        obj("0xb"), obj("0xs"), obj("0xsa"), obj("0xcoin"), obj(CLOCK),
    ]);
    for (const [id, fn] of [
        ["task.respond_dispute.v1", "respond_dispute"],
        ["task.appeal.v1", "appeal_dispute"],
    ] as const) {
        const call = single(id, {
            taskId: "0xtask", caseId: "0xcase", buyerAccountId: "0xb", sellerAgentId: "0xsa", feeCoinId: "0xcoin",
        });
        assert.equal(call.target, `0x50c1::agent_task::${fn}`);
        assert.deepEqual(call.arguments, [
            obj("0xtask"), obj("0xcase"), obj("0x7"), obj("0xb"), obj("0xsa"), obj("0xcoin"), obj(CLOCK),
        ]);
    }
});

test("evidence carries a 32-byte digest and the link as bytes", () => {
    const call = single("task.submit_evidence.v1", {
        taskId: "0xtask", caseId: "0xcase", buyerAccountId: "0xb", sellerAgentId: "0xsa",
        digestHex: HEX32, uri: "ipfs://e",
    });
    assert.equal(call.target, "0x50c1::agent_task::submit_dispute_evidence");
    assert.deepEqual(call.arguments[0], obj("0xf1"));
    assert.deepEqual(call.arguments[6], pure("vector<u8>", BYTES32));
    assert.deepEqual(call.arguments[7], pure("vector<u8>", Array.from(new TextEncoder().encode("ipfs://e"))));
    assert.throws(() =>
        build("task.submit_evidence.v1", {
            taskId: "0xtask", caseId: "0xcase", buyerAccountId: "0xb", sellerAgentId: "0xsa",
            digestHex: "short", uri: "x",
        }),
    );
});

test("settlement agreement steps and withdrawing before a draw", () => {
    const propose = single("task.propose_dispute_settlement.v1", {
        taskId: "0xtask", buyerAccountId: "0xb", sellerAgentId: "0xsa", outcome: 2,
    });
    assert.equal(propose.target, "0x50c1::agent_task::propose_dispute_settlement");
    assert.deepEqual(propose.arguments[4], pure("u8", 2));
    assert.throws(() =>
        build("task.propose_dispute_settlement.v1", {
            taskId: "0xtask", buyerAccountId: "0xb", sellerAgentId: "0xsa", outcome: 3,
        }),
    );
    const accept = single("task.accept_dispute_settlement.v1", {
        taskId: "0xtask", buyerAccountId: "0xb", sellerAccountId: "0xs", sellerAgentId: "0xsa",
    });
    assert.equal(accept.target, "0x50c1::agent_task::accept_dispute_settlement");
    assert.equal(accept.arguments.length, 8);
    assert.deepEqual(accept.arguments[6], obj("0x3"));
    const clear = single("task.clear_dispute_settlement.v1", {
        taskId: "0xtask", buyerAccountId: "0xb", sellerAgentId: "0xsa",
    });
    assert.equal(clear.target, "0x50c1::agent_task::clear_dispute_settlement");
    const cancel = single("task.cancel_dispute.v1", {
        taskId: "0xtask", caseId: "0xcase", buyerAccountId: "0xb", sellerAgentId: "0xsa",
    });
    assert.equal(cancel.target, "0x50c1::agent_task::cancel_dispute_before_draw");
});

test("governance cranks pick the global or the platform entrypoint", () => {
    const global = single("jury.escalate_proposal.v1", { registryId: "0xreg", proposalId: "0xprop", stage: 2 });
    assert.equal(global.target, "0x50c1::governance::escalate_to_jury");
    assert.deepEqual(global.arguments, [
        obj("0xreg"), obj("0xprop"), obj("0xf1"), obj("0xf2"), obj("0xf3"), pure("u8", 2), obj(CLOCK),
    ]);
    const platform = single("jury.escalate_proposal.v1", {
        registryId: "0xreg", proposalId: "0xprop", stage: 1, platformId: "0xplat",
    });
    assert.equal(platform.target, "0x50c1::platform::escalate_platform_proposal_to_jury");
    assert.deepEqual(platform.arguments, [
        obj("0xplat"), obj("0xreg"), obj("0xprop"), obj("0xf1"), obj("0xf2"), pure("u8", 1), obj(CLOCK),
    ]);
    const sweep = single("jury.sweep_vote_refunds.v1", { registryId: "0xreg", proposalId: "0xprop" });
    assert.equal(sweep.target, "0x50c1::governance::sweep_vote_refunds");
    assert.deepEqual(sweep.arguments, [obj("0xreg"), obj("0xprop"), obj("0xf3"), obj(CLOCK)]);
    const platformSweep = single("jury.sweep_vote_refunds.v1", {
        registryId: "0xreg", proposalId: "0xprop", platformId: "0xplat",
    });
    assert.equal(platformSweep.target, "0x50c1::platform::sweep_platform_vote_refunds");
    assert.deepEqual(platformSweep.arguments, [obj("0xplat"), obj("0xreg"), obj("0xprop"), obj(CLOCK)]);
    assert.throws(() => build("jury.escalate_proposal.v1", { registryId: "0xreg", proposalId: "0xprop", stage: 3 }));

    assert.equal(single("jury.finalize_proposal.v1", { registryId: "0xreg", proposalId: "0xprop" }).target,
        "0x50c1::governance::finalize_proposal");
    assert.equal(
        single("jury.finalize_proposal.v1", { registryId: "0xreg", proposalId: "0xprop", platformId: "0xplat" }).target,
        "0x50c1::platform::finalize_platform_governance_proposal",
    );
    const apply = single("jury.apply_proposal_decision.v1", {
        registryId: "0xreg", proposalId: "0xprop", caseId: "0xcase",
    });
    assert.equal(apply.target, "0x50c1::governance::apply_jury_decision");
    assert.deepEqual(apply.arguments, [obj("0xreg"), obj("0xprop"), obj("0xcase"), obj("0xf3"), obj(CLOCK)]);
    assert.equal(
        single("jury.apply_proposal_decision.v1", {
            registryId: "0xreg", proposalId: "0xprop", caseId: "0xcase", platformId: "0xplat",
        }).target,
        "0x50c1::platform::apply_platform_jury_decision",
    );
});

test("a deployment without the jury objects refuses jury actions instead of guessing", () => {
    const bare: SocialChainConfig = { ...CHAIN, juryConfigId: undefined, jurorRosterId: undefined };
    assert.throws(() => build("jury.accept.v1", { caseId: "0xc", agentId: "0xa" }, bare), /juryConfigId/);
    assert.throws(() => build("jury.select_jury.v1", { caseId: "0xc" }, bare), /juryConfigId/);
    const noRoster: SocialChainConfig = { ...CHAIN, jurorRosterId: undefined };
    assert.throws(() => build("jury.select_jury.v1", { caseId: "0xc" }, noRoster), /jurorRosterId/);
    const noTreasury: SocialChainConfig = { ...CHAIN, ecosystemTreasuryId: undefined };
    assert.throws(
        () => build("jury.apply_proposal_decision.v1", { registryId: "0xr", proposalId: "0xp", caseId: "0xc" }, noTreasury),
        /ecosystemTreasuryId/,
    );
});

test("hex and u8 inputs are validated before a transaction is built", () => {
    assert.throws(() => build("jury.commit_vote.v1", { caseId: "0xc", agentId: "0xa", commitmentHex: "zz" }));
    assert.throws(() =>
        build("jury.reveal_vote.v1", {
            caseId: "0xc", agentId: "0xa", outcome: 256, rationaleDigestHex: HEX32,
            evidenceRefs: [], bundleDigestHex: HEX32, saltHex: "cd".repeat(16),
        }),
    );
    assert.throws(() =>
        build("jury.reveal_vote.v1", {
            caseId: "0xc", agentId: "0xa", outcome: 1, rationaleDigestHex: HEX32,
            evidenceRefs: ["-1"], bundleDigestHex: HEX32, saltHex: "cd".repeat(16),
        }),
    );
});
