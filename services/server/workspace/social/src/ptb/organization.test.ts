import assert from "node:assert/strict";
import { test } from "node:test";

import { Transaction } from "@socialproof/myso/transactions";

import { buildCreateMessagingGroupTx } from "./organization.ts";

const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

const ctx = {
    Transaction,
    memoryAccountId: id(1),
    chain: {
        messagingPackageId: id(0xe110),
        messagingVersionId: id(2),
        messagingNamespaceId: id(3),
        messagingGroupManagerId: id(4),
        messagingGroupLeaverId: id(5),
        blockListRegistryId: id(6),
        platformObjectId: id(7),
        memoryConfigId: id(8),
        clockId: id(6),
    },
} as never;

test("messaging.create_group builds an MLS room: create with e2ee, then share all three", () => {
    const tx = buildCreateMessagingGroupTx(ctx, {
        name: "Agent room",
        uuid: "6f1c2d1e-1111-4a2b-9c3d-0123456789ab",
        encryptedDekHex: "aabbcc",
        initialMembers: [id(9)],
    } as never);
    const calls = tx.getData().commands.filter((c: any) => c.MoveCall).map((c: any) => c.MoveCall);
    const names = calls.map((c: any) => `${c.module}::${c.function}`);
    assert.deepEqual(names, [
        "vec_set::from_keys",
        "messaging::create_agent_group_with_e2ee",
        "transfer::public_share_object",
        "transfer::public_share_object",
        "transfer::public_share_object",
    ]);
    assert.ok(!names.includes("messaging::create_agent_and_share_group"));
    const shareTypes = calls.slice(2).map((c: any) => c.typeArguments[0]);
    assert.match(shareTypes[0], /permissioned_group::PermissionedGroup<.*::messaging::Messaging>$/);
    assert.match(shareTypes[1], /::encryption_history::EncryptionHistory$/);
    assert.match(shareTypes[2], /::message_log::MessageLog$/);
    // The `e2ee` argument is the pure string "mls1".
    const create = calls[1];
    const e2eeArg = create.arguments[15];
    const input = tx.getData().inputs[e2eeArg.Input];
    const bytes = Buffer.from(input.Pure.bytes, "base64");
    assert.equal(bytes.subarray(1).toString(), "mls1");
});
