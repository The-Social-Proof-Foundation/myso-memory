import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { Transaction } from "@socialproof/myso/transactions";
import { addListingApproveCall, decryptListing, ListingAccessError, type ListingDecryptDependencies } from "./mydata-listing.js";

const request = {
    packageId: "0x50c1", accountId: "0x1", callerAddress: "0x2", mydataId: "0x3", encryptionIdHex: "abcd",
    data: "AQID", encryptedDataDigestHex: createHash("sha256").update(Buffer.from([1,2,3])).digest("hex"),
};
function dependencies() {
    let calls = 0;
    const deps: ListingDecryptDependencies = {
        packageId: request.packageId, memoryConfigId: "0x4", blockListId: "0x5",
        mysoClient: {} as ListingDecryptDependencies["mysoClient"],
        async createClient() { calls++; throw new Error("Key release must not be reached"); },
    };
    return { deps, count: () => calls };
}
test("listing approval builds only the native listing policy with its identity first", () => {
    const tx = new Transaction();
    addListingApproveCall(tx, "0x50c1", "0x4", "0x5", "0x1", "0x3", "abcd");
    const data = tx.getData();
    const call = data.commands[0].MoveCall!;
    assert.equal(call.module, "mydata");
    assert.equal(call.function, "mydata_approve");
    assert.equal(data.commands.length, 1);
    assert.deepEqual(call.arguments.map((arg: any) => data.inputs[arg.Input].$kind), ["Pure", ...Array(5).fill("UnresolvedObject")]);
    assert.throws(() => addListingApproveCall(new Transaction(), "0x50c1", "", "0x5", "0x1", "0x3", "abcd"), ListingAccessError);
});
test("missing, malformed, mismatched and alternate-package sessions never request keys", async () => {
    for (const session of [undefined, "bad json", Buffer.from(JSON.stringify({address:"0x9", packageId:"0x50c1", personalMessageSignature:"sig"})).toString("base64"),
        Buffer.from(JSON.stringify({address:"0x2", packageId:"0xdead", personalMessageSignature:"sig"})).toString("base64"),
        Buffer.from(JSON.stringify({address:"oops", packageId:"0x50c1", personalMessageSignature:"sig"})).toString("base64")]) {
        const {deps, count} = dependencies();
        await assert.rejects(decryptListing(request, session, deps), (error: unknown) => error instanceof ListingAccessError && error.status === 401);
        assert.equal(count(), 0);
    }
    const {deps, count} = dependencies();
    await assert.rejects(decryptListing({...request, packageId:"0xdead"}, undefined, deps), (error: unknown) => error instanceof ListingAccessError && error.status === 403);
    assert.equal(count(), 0);
});
test("request cannot substitute a generic approval target or caller key", async () => {
    const {deps,count} = dependencies();
    for (const extra of [{moveTarget:"0x50c1::memory::approve_key_policy"}, {privateKey:"never"}]) {
        await assert.rejects(decryptListing({...request,...extra}, undefined, deps), (error: unknown) => error instanceof ListingAccessError && error.status === 400);
    }
    assert.equal(count(),0);
});
