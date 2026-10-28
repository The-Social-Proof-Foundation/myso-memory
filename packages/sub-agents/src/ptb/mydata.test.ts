import assert from "node:assert/strict";
import { test } from "node:test";
import { getSocialActionDescriptor } from "../action-registry/registry.js";
import { isSupportedSocialRegistryVersion } from "../action-registry/types.js";
import type { PurchaseMyDataAccessParams } from "../types.js";

const descriptor = getSocialActionDescriptor("access.purchase_mydata_access.v1");
const terms: PurchaseMyDataAccessParams = {
    mydataId: "0x1", paymentCoinId: "0x2", expectedSeller: "0x3", accessKind: 2, audienceKind: "agent",
    priceMist: "9007199254740993", durationDays: "0", encryptionIdHex: "aabb", encryptedDataDigestHex: "cd".repeat(32),
};
test("purchase terms preserve large exact amounts and reject rounded numeric input", () => {
    assert.equal(descriptor.validate(terms).success, true);
    assert.equal(descriptor.validate({ ...terms, priceMist: Number(terms.priceMist) }).success, false);
    assert.equal(descriptor.validate({ ...terms, priceMist: "18446744073709551616" }).success, false);
});
test("only the contract's fixed access kinds and valid periods are accepted", () => {
    for (const change of [{ accessKind: 1 }, { durationDays: "30" }, { accessKind: 3, durationDays: "0" }]) {
        assert.equal(descriptor.validate({ ...terms, ...change }).success, false);
    }
    assert.equal(descriptor.validate({ ...terms, accessKind: 3, durationDays: "730" }).success, true);
});
test("a purchase cannot carry an alternate buyer, account, Move target or unbound data", () => {
    for (const change of [{ buyer: "0x4" }, { accountId: "0x4" }, { moveTarget: "0x4::evil::pay" }, { encryptedDataDigestHex: "ab" }, { encryptionIdHex: "" }]) {
        assert.equal(descriptor.validate({ ...terms, ...change }).success, false);
    }
});

test("rolling compatibility never exposes the new purchase under the old registry", () => {
    assert.equal(isSupportedSocialRegistryVersion("1.5.0", "social.create_post.v1"), true);
    assert.equal(isSupportedSocialRegistryVersion("1.5.0", "access.purchase_mydata_access.v1"), false);
    assert.equal(isSupportedSocialRegistryVersion("1.6.0", "access.purchase_mydata_access.v1"), true);
    assert.equal(isSupportedSocialRegistryVersion("unknown", "access.purchase_mydata_access.v1"), false);
});
