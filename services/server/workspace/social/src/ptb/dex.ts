import type { DexSwapParams } from "../types.js";
import type { BuildTxContext } from "./post.js";
import { MYSO_CLOCK } from "./helpers.js";

const U64_MAX = (1n << 64n) - 1n;
function id(value: string, label: string): void {
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(value)) throw new TypeError(`${label} must be a MySo address or object ID`);
}
function amount(value: string, label: string): void {
    if (!/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) > U64_MAX) throw new TypeError(`${label} must be a positive u64 decimal string`);
}
function coinType(value: string, label: string): void {
    if (value.length > 512 || !/^0x[0-9a-fA-F]{1,64}::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*(?:<.*>)?$/.test(value)) throw new TypeError(`${label} must be a complete Move coin type`);
}

export function validateDexSwap(params: DexSwapParams): void {
    id(params.poolId, "poolId"); id(params.orderbookPackageId, "orderbookPackageId");
    id(params.inputCoinId, "inputCoinId"); id(params.recipientAddress, "recipientAddress");
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(params.poolName)) throw new TypeError("poolName is invalid");
    coinType(params.baseAssetType, "baseAssetType"); coinType(params.quoteAssetType, "quoteAssetType");
    if (params.direction !== "sell_base" && params.direction !== "buy_base") throw new TypeError("direction must be sell_base or buy_base");
    amount(params.amountInBaseUnits, "amountInBaseUnits"); amount(params.minAmountOutBaseUnits, "minAmountOutBaseUnits");
}

/** Fixed Orderbook v3 exact-input swap through the existing published pool entry points. */
export function buildDexSwapTx(ctx: BuildTxContext, params: DexSwapParams): any {
    validateDexSwap(params);
    const tx = new ctx.Transaction();
    const input = tx.splitCoins(tx.object(params.inputCoinId), [tx.pure("u64", params.amountInBaseUnits)])[0];
    const zeroBase = tx.moveCall({ target: "0x2::coin::zero", typeArguments: [params.baseAssetType], arguments: [] });
    const zeroQuote = tx.moveCall({ target: "0x2::coin::zero", typeArguments: [params.quoteAssetType], arguments: [] });
    const zeroMySo = tx.moveCall({ target: "0x2::coin::zero", typeArguments: ["0x2::myso::MYSO"], arguments: [] });
    const baseIn = params.direction === "sell_base" ? input : zeroBase;
    const quoteIn = params.direction === "buy_base" ? input : zeroQuote;
    const [baseOut, quoteOut, mySoOut] = tx.moveCall({
        target: `${params.orderbookPackageId}::pool::swap_exact_quantity`,
        typeArguments: [params.baseAssetType, params.quoteAssetType],
        arguments: [tx.object(params.poolId), baseIn, quoteIn, zeroMySo,
            tx.pure("u64", params.minAmountOutBaseUnits), tx.object(ctx.chain.clockId ?? MYSO_CLOCK)],
    });
    tx.transferObjects([baseOut, quoteOut, mySoOut], tx.pure("address", params.recipientAddress));
    return tx;
}
