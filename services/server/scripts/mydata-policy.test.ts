import assert from "node:assert/strict";
import test from "node:test";
import { Transaction } from "@socialproof/myso/transactions";
import { MySoJsonRpcClient } from "@socialproof/myso/jsonRpc";
import { addApproveKeyPolicyCall, describeKeyMismatch } from "./mydata-policy.js";

test("key approval refuses a missing MemoryConfig rather than building an invalid call", () => {
    assert.throws(() => addApproveKeyPolicyCall(new Transaction(), "0x50c1", "", [1], "0x1", null), /MEMORY_CONFIG_ID/);
});

function argumentKinds(orgCtx: { organizationId: string; orgMemoryGroupId: string } | null) {
    const tx = new Transaction();
    addApproveKeyPolicyCall(tx, "0x50c1", "0x" + "ab".repeat(32), [1, 2, 3], "0x" + "cd".repeat(32), orgCtx);
    const data = tx.getData();
    const command = data.commands[0].MoveCall!;
    return command.arguments.map((arg: any) => (arg.Input === undefined ? "result" : data.inputs[arg.Input].$kind));
}

test("owner approval puts the key id first, as the key server requires", () => {
    // id, config, account, clock
    assert.deepEqual(argumentKinds(null), ["Pure", "UnresolvedObject", "UnresolvedObject", "UnresolvedObject"]);
});

test("organization approval puts the key id first, then config, account, org, group, clock", () => {
    const kinds = argumentKinds({ organizationId: "0x" + "ee".repeat(32), orgMemoryGroupId: "0x" + "ff".repeat(32) });
    assert.deepEqual(kinds, ["Pure", ...Array(5).fill("UnresolvedObject")]);
});

// Opt-in live ABI check: transaction-kind building resolves shared objects and
// argument types against the running fullnode, without signing or submitting.
const configId = process.env.TEST_MEMORY_CONFIG_ID;
const accountId = process.env.TEST_MEMORY_ACCOUNT_ID;
test("owner approval resolves against the deployed Move ABI", { skip: !configId || !accountId }, async () => {
    const client = new MySoJsonRpcClient({ url: process.env.MYSO_RPC_URL || "http://127.0.0.1:9000" });
    const tx = new Transaction();
    addApproveKeyPolicyCall(tx, process.env.MEMORY_PACKAGE_ID || "0x50c1", configId!, Array(32).fill(1), accountId!, null);
    const bytes = await tx.build({ client, onlyTransactionKind: true });
    assert.ok(bytes.byteLength > 0);
    const command = tx.getData().commands[0].MoveCall!;
    assert.equal(command.function, "approve_key_policy");
    assert.equal(command.arguments.length, 4);
});

test("organization approval resolves against the deployed Move ABI", {
    skip: !configId || !accountId || !process.env.TEST_ORGANIZATION_ID || !process.env.TEST_ORG_MEMORY_GROUP_ID,
}, async () => {
    const client = new MySoJsonRpcClient({ url: process.env.MYSO_RPC_URL || "http://127.0.0.1:9000" });
    const tx = new Transaction();
    addApproveKeyPolicyCall(tx, process.env.MEMORY_PACKAGE_ID || "0x50c1", configId!, Array(32).fill(1), accountId!, {
        organizationId: process.env.TEST_ORGANIZATION_ID!,
        orgMemoryGroupId: process.env.TEST_ORG_MEMORY_GROUP_ID!,
    });
    const bytes = await tx.build({ client, onlyTransactionKind: true });
    assert.ok(bytes.byteLength > 0);
    assert.equal(tx.getData().commands[0].MoveCall!.arguments.length, 6);
});

const SERVER = "0x" + "aa".repeat(32);
const PACKAGE = "0x" + "50c1".padStart(64, "0");

test("key mismatch is null when package and key servers line up", () => {
    assert.equal(describeKeyMismatch({ packageId: "0x50c1", services: [[SERVER, 0]], threshold: 1 }, PACKAGE, [SERVER]), null);
});

test("key mismatch names the package when the session key targets another one", () => {
    const msg = describeKeyMismatch({ packageId: PACKAGE, services: [[SERVER, 0]], threshold: 1 }, "0xda7a", [SERVER]);
    assert.match(msg ?? "", /encrypted for package .*50c1 but the session key is for .*da7a/);
});

test("key mismatch names the blob's key servers when none are configured", () => {
    const msg = describeKeyMismatch({ packageId: PACKAGE, services: [[SERVER, 0]], threshold: 1 }, PACKAGE, ["0x" + "bb".repeat(32)]);
    assert.match(msg ?? "", new RegExp(`needs 1 share\\(s\\) from key server\\(s\\) ${SERVER}`));
});
