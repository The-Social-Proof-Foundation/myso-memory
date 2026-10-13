import assert from "node:assert/strict";
import test from "node:test";
import {
    PRODUCTION_ACTION_CATALOG,
    PRODUCTION_ACTION_IDS,
    TIER_1_ACTION_IDS,
    TIER_2_ACTION_IDS,
    TIER_3_ACTION_IDS,
    getProductionActionDescriptor,
} from "./production-catalog.js";
import { CAP_JURY, CAP_JURY_KEEPER, CAP_TASK_TRADE } from "../contract.js";
import { isSocialActionId } from "./registry.js";

test("production catalog contains the exact unique organization-control release set", () => {
    assert.equal(TIER_1_ACTION_IDS.length, 62);
    assert.equal(TIER_2_ACTION_IDS.length, 20);
    assert.equal(TIER_3_ACTION_IDS.length, 27);
    assert.equal(PRODUCTION_ACTION_IDS.length, 109);
    assert.equal(new Set(PRODUCTION_ACTION_IDS).size, 109);
    assert.equal(PRODUCTION_ACTION_CATALOG.length, 109);
});

test("only implemented registry actions are reported as enabled", () => {
    const enabled = PRODUCTION_ACTION_CATALOG.filter(
        (action) => action.availability === "enabled",
    );
    assert.deepEqual(
        enabled.map((action) => action.id),
        [
            ...TIER_1_ACTION_IDS,
            "organization.create.v1",
            "organization.update_metadata.v1",
            "organization.update_category.v1",
            "organization.deactivate.v1",
            "organization.ensure_memory_group.v1",
            "organization.define_role.v1",
            "organization.assign_role.v1",
            "organization.revoke_role.v1",
            "organization.create_invitation.v1",
            "agent.register_agent.v1",
        ],
    );
    assert.ok(enabled.every((action) => isSocialActionId(action.id)));
});

test("unimplemented actions carry an explicit production blocker", () => {
    for (const action of PRODUCTION_ACTION_CATALOG) {
        if (action.availability !== "enabled") {
            assert.ok(action.blocker, `${action.id} is missing a blocker`);
        }
    }
    assert.equal(getProductionActionDescriptor("social.edit_post.v1")?.availability, "enabled");
    assert.equal(getProductionActionDescriptor("social.mute_profile.v1"), undefined);
    assert.equal(getProductionActionDescriptor("arbitrary.move.call.v1"), undefined);
});

test("approval modes are tier-authoritative", () => {
    for (const action of PRODUCTION_ACTION_CATALOG) {
        if (action.tier === "1") assert.equal(action.approval, "agent-capability");
        if (action.tier === "2") assert.equal(action.approval, "owner-wallet");
        if (action.tier === "3") assert.equal(action.approval, "owner-wallet-and-cosign");
    }
});

test("every task action is a tier-1 agent-capability action gated by the task-trade cap", () => {
    const taskIds = TIER_1_ACTION_IDS.filter((id) => id.startsWith("task."));
    assert.equal(taskIds.length, 22);
    for (const id of taskIds) {
        const action = getProductionActionDescriptor(id);
        assert.equal(action?.tier, "1", id);
        assert.equal(action?.approval, "agent-capability", id);
        assert.equal(action?.requiredCapability, CAP_TASK_TRADE, id);
        assert.equal(action?.availability, "enabled", id);
    }
});

test("jury actions are tier-1 and gated by a zero-spend jury capability, never by the trade capability", () => {
    const juryIds = TIER_1_ACTION_IDS.filter((id) => id.startsWith("jury."));
    assert.equal(juryIds.length, 18);
    const juror = ["accept", "commit_vote", "reveal_vote", "claim_fee"].map((n) => `jury.${n}.v1`);
    for (const id of juryIds) {
        const action = getProductionActionDescriptor(id);
        assert.equal(action?.tier, "1", id);
        assert.equal(action?.approval, "agent-capability", id);
        assert.equal(action?.availability, "enabled", id);
        assert.equal(
            action?.requiredCapability,
            (juror as readonly string[]).includes(id) ? CAP_JURY : CAP_JURY_KEEPER,
            id,
        );
        assert.notEqual(action?.requiredCapability, CAP_TASK_TRADE, id);
    }
});

test("a juror's actions and a keeper's actions never overlap, and a keeper fits one delegate", () => {
    const juror = new Set(["jury.accept.v1", "jury.commit_vote.v1", "jury.reveal_vote.v1", "jury.claim_fee.v1"]);
    const keeper = TIER_1_ACTION_IDS.filter(
        (id) => id.startsWith("jury.") && getProductionActionDescriptor(id)?.requiredCapability === CAP_JURY_KEEPER,
    );
    assert.equal(keeper.length, 14);
    assert.ok(keeper.every((id) => !juror.has(id)));
    // A delegate may allowlist at most sixteen actions.
    assert.ok(keeper.length <= 16);
});
