import type { BurnZeroCoinParams, TransferOwnedObjectParams } from "../types.js";
import type { BuildTxContext } from "./post.js";
import { canonicalCoinType } from "./coin-type.js";

function objectId(value: string, label: string): void {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) {
        throw new TypeError(`${label} must be a chain object ID`);
    }
}

function address(value: string, label: string): void {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) {
        throw new TypeError(`${label} must be a chain address`);
    }
}

export function validateTransferOwnedObject(p: TransferOwnedObjectParams): void {
    objectId(p.objectId, "objectId");
    address(p.recipient, "recipient");
    if (typeof p.objectType !== "string" || p.objectType.length < 1 || p.objectType.length > 512) throw new TypeError("objectType must be the exact on-chain Move type");
}

/** Fixed framework transfer of one exact object to one exact recipient. */
export function buildTransferOwnedObjectTx(ctx: BuildTxContext, p: TransferOwnedObjectParams): any {
    validateTransferOwnedObject(p);
    const tx = new ctx.Transaction();
    tx.transferObjects([tx.object(p.objectId)], tx.pure("address", p.recipient));
    return tx;
}

export function validateBurnZeroCoin(p: BurnZeroCoinParams): void {
    objectId(p.coinObjectId, "coinObjectId");
    const type = canonicalCoinType(p.coinType);
    if (!type.startsWith("0x0000000000000000000000000000000000000000000000000000000000000002::coin::Coin<")) {
        throw new TypeError("Only framework Coin<T> objects can be burned");
    }
}

/** Framework burn of a zero-balance Coin<T>; the server rechecks ownership and balance. */
export function buildBurnZeroCoinTx(ctx: BuildTxContext, p: BurnZeroCoinParams): any {
    validateBurnZeroCoin(p);
    const tx = new ctx.Transaction();
    tx.moveCall({
        target: "0x2::coin::destroy_zero",
        typeArguments: [canonicalCoinType(p.coinType).slice(canonicalCoinType(p.coinType).indexOf("<") + 1, -1)],
        arguments: [tx.object(p.coinObjectId)],
    });
    return tx;
}
