/** Owner-wallet SPT trades with explicit, same-PTB creator-vault settlement. */
import type { BuildTxContext } from "./post.js";
import type { SptBeneficiaryVault, SptBuyParams, SptSellParams } from "../types.js";
import { MYSO_CLOCK } from "./helpers.js";

const U64_MAX = (1n << 64n) - 1n;
function objectId(value: string, label: string): void {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) throw new TypeError(`${label} must be a chain object ID`);
}
function positiveU64(value: string, label: string): void {
    if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) > U64_MAX) throw new TypeError(`${label} must be a positive u64 decimal string`);
}
function validateVaults(vaults: SptBeneficiaryVault[]): void {
    if (!Array.isArray(vaults) || vaults.length > 32) throw new TypeError("beneficiaryVaults must contain at most 32 verified vaults");
    const ids = new Set<string>();
    for (const vault of vaults) {
        objectId(vault.vaultId, "beneficiary vault ID");
        positiveU64(vault.minDepositBaseUnits, "minimum vault deposit");
        const key = vault.vaultId.toLowerCase();
        if (ids.has(key)) throw new TypeError("beneficiaryVaults cannot repeat a vault ID");
        ids.add(key);
    }
}
function validateCommon(ctx: BuildTxContext, poolId: string, vaults: SptBeneficiaryVault[]): { registryId: string; configId: string; treasuryId: string } {
    objectId(poolId, "poolId");
    validateVaults(vaults);
    const registryId = ctx.chain.sptRegistryId;
    const configId = ctx.chain.sptConfigId;
    const treasuryId = ctx.chain.ecosystemTreasuryId;
    if (!registryId || !configId || !treasuryId) throw new TypeError("SPT registry, SPT config and ecosystem treasury must be configured");
    objectId(registryId, "sptRegistryId");
    objectId(configId, "sptConfigId");
    objectId(treasuryId, "ecosystemTreasuryId");
    return { registryId, configId, treasuryId };
}
function settleAndFinish(tx: any, packageId: string, settlement: any, vaults: SptBeneficiaryVault[], clockId: string): void {
    for (const { vaultId, minDepositBaseUnits } of vaults) {
        tx.moveCall({
            target: `${packageId}::social_proof_tokens::settle_creator_fee_vault_public`,
            arguments: [settlement, tx.pure("u64", minDepositBaseUnits), tx.object(vaultId), tx.object(clockId)],
        });
    }
    tx.moveCall({
        target: `${packageId}::social_proof_tokens::finish_creator_fee_settlement`,
        arguments: [settlement],
    });
}

export function validateSptBuy(p: SptBuyParams): void {
    objectId(p.paymentCoinId, "paymentCoinId");
    positiveU64(p.paymentAmountBaseUnits, "payment amount");
    if (typeof p.minTokensBaseUnits !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(p.minTokensBaseUnits) || BigInt(p.minTokensBaseUnits) > U64_MAX) throw new TypeError("minimum token amount must be a u64 decimal string");
    validateVaults(p.beneficiaryVaults);
}

export function buildSptBuyTx(ctx: BuildTxContext, p: SptBuyParams): any {
    validateSptBuy(p);
    const { registryId, configId, treasuryId } = validateCommon(ctx, p.poolId, p.beneficiaryVaults);
    const tx = new ctx.Transaction();
    // All buy funding and all creator-vault obligations are pinned to this PTB.
    const [payment] = tx.splitCoins(tx.object(p.paymentCoinId), [tx.pure("u64", p.paymentAmountBaseUnits)]);
    const settlement = tx.moveCall({
        target: `${ctx.chain.packageId}::social_proof_tokens::buy_tokens_with_vault_routing`,
        arguments: [tx.object(registryId), tx.object(p.poolId), tx.object(configId), tx.object(treasuryId), tx.object(ctx.chain.usernameRegistryId), tx.object(ctx.chain.blockListRegistryId), payment, tx.pure("u64", p.minTokensBaseUnits)],
    });
    settleAndFinish(tx, ctx.chain.packageId, settlement, p.beneficiaryVaults, ctx.chain.clockId ?? MYSO_CLOCK);
    return tx;
}

export function validateSptSell(p: SptSellParams): void {
    objectId(p.tokenObjectId, "tokenObjectId");
    positiveU64(p.amountBaseUnits, "sell amount");
    if (typeof p.minReceiveBaseUnits !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(p.minReceiveBaseUnits) || BigInt(p.minReceiveBaseUnits) > U64_MAX) throw new TypeError("minimum received amount must be a u64 decimal string");
    validateVaults(p.beneficiaryVaults);
}

export function buildSptSellTx(ctx: BuildTxContext, p: SptSellParams): any {
    validateSptSell(p);
    const { registryId, configId, treasuryId } = validateCommon(ctx, p.poolId, p.beneficiaryVaults);
    const tx = new ctx.Transaction();
    const settlement = tx.moveCall({
        target: `${ctx.chain.packageId}::social_proof_tokens::sell_tokens_with_vault_routing_min`,
        arguments: [tx.object(registryId), tx.object(p.poolId), tx.object(configId), tx.object(treasuryId), tx.object(ctx.chain.usernameRegistryId), tx.object(ctx.chain.blockListRegistryId), tx.object(p.tokenObjectId), tx.pure("u64", p.amountBaseUnits), tx.pure("u64", p.minReceiveBaseUnits)],
    });
    settleAndFinish(tx, ctx.chain.packageId, settlement, p.beneficiaryVaults, ctx.chain.clockId ?? MYSO_CLOCK);
    return tx;
}
