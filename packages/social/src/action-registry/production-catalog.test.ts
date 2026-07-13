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
import { isSocialActionId } from "./registry.js";

test("production catalog contains the exact unique organization-control release set", () => {
    assert.equal(TIER_1_ACTION_IDS.length, 22);
    assert.equal(TIER_2_ACTION_IDS.length, 20);
    assert.equal(TIER_3_ACTION_IDS.length, 27);
    assert.equal(PRODUCTION_ACTION_IDS.length, 69);
    assert.equal(new Set(PRODUCTION_ACTION_IDS).size, 69);
    assert.equal(PRODUCTION_ACTION_CATALOG.length, 69);
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
