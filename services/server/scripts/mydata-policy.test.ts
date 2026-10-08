import assert from "node:assert/strict";
import test from "node:test";
import { Transaction } from "@socialproof/myso/transactions";
import { MySoJsonRpcClient } from "@socialproof/myso/jsonRpc";
import { addApproveKeyPolicyCall } from "./mydata-policy.js";

test("key approval refuses a missing MemoryConfig rather than building an invalid call", () => {
    assert.throws(() => addApproveKeyPolicyCall(new Transaction(), "0x50c1", "", [1], "0x1", null), /MEMORY_CONFIG_ID/);
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
