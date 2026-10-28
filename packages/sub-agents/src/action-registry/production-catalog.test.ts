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
import { CAP_JURY, CAP_NONE, CAP_TASK_TRADE } from "../contract.js";
import { isSocialActionId } from "./registry.js";

test("production catalog contains the exact unique organization-control release set", () => {
    assert.equal(TIER_1_ACTION_IDS.length, 67);
    assert.equal(TIER_2_ACTION_IDS.length, 15);
    assert.equal(TIER_3_ACTION_IDS.length, 31);
    assert.equal(PRODUCTION_ACTION_IDS.length, 113);
    assert.equal(new Set(PRODUCTION_ACTION_IDS).size, 113);
    assert.equal(PRODUCTION_ACTION_CATALOG.length, 113);
    assert.equal(getProductionActionDescriptor("storage.purchase_capacity.v1"), undefined);
});

test("only implemented registry actions are reported as enabled", () => {
    const enabled = PRODUCTION_ACTION_CATALOG.filter(
        (action) => action.availability === "enabled",
    );
    assert.deepEqual(
        enabled.map((action) => action.id),
        [
            ...TIER_1_ACTION_IDS,
            "payments.tip_post.v1",
            "payments.send_token.v1",
            "subscription.subscribe_to_plan.v1",
            "subscription.renew_subscription.v1",
            "subscription.cancel_subscription.v1",
            "subscription.enable_auto_renew.v1",
            "subscription.disable_auto_renew.v1",
            "access.share_mydata.v1",
            "access.revoke_mydata_share.v1",
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
            "social.delete_post.v1",
            "social.delete_comment.v1",
            "poc.claim_creator_vault.v1",
            "spot.claim_payout.v1",
            "spot.place_bet.v1",
            "spot.create_market.v1",
            "governance.delegate_vote.v1",
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
    assert.equal(juryIds.length, 19);
    const juror = ["accept", "commit_vote", "reveal_vote", "claim_fee"].map((n) => `jury.${n}.v1`);
    for (const id of juryIds) {
        const action = getProductionActionDescriptor(id);
        assert.equal(action?.tier, "1", id);
        assert.equal(action?.approval, "agent-capability", id);
        assert.equal(action?.availability, "enabled", id);
        assert.equal(
            action?.requiredCapability,
            (juror as readonly string[]).includes(id) ? CAP_JURY : CAP_NONE,
            id,
        );
        assert.notEqual(action?.requiredCapability, CAP_TASK_TRADE, id);
    }
});

test("a juror's actions and the permissionless cranks never overlap", () => {
    const juror = new Set(["jury.accept.v1", "jury.commit_vote.v1", "jury.reveal_vote.v1", "jury.claim_fee.v1"]);
    const cranks = TIER_1_ACTION_IDS.filter(
        (id) => id.startsWith("jury.") && getProductionActionDescriptor(id)?.requiredCapability === CAP_NONE,
    );
    assert.equal(cranks.length, 15);
    assert.ok(cranks.every((id) => !juror.has(id)));
});
