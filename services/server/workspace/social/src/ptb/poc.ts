/** Owner-wallet programmable transaction builders for proof-of-creativity revenue. */
import type { BuildTxContext } from "./post.js";
import type { AcceptBeneficiaryTransferParams, ClaimCreatorVaultParams } from "../types.js";
import { canonicalCoinType } from "./coin-type.js";
import { MYSO_CLOCK } from "./helpers.js";

function objectId(value: string, label: string): void {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) {
        throw new TypeError(`${label} must be a chain object ID`);
    }
}

export function validateClaimCreatorVault(p: ClaimCreatorVaultParams): void {
    objectId(p.vaultId, "vaultId");
    canonicalCoinType(p.coinType);
}

export function buildClaimCreatorVaultTx(ctx: BuildTxContext, p: ClaimCreatorVaultParams): any {
    validateClaimCreatorVault(p);
    const configId = ctx.chain.pocConfigId;
    const treasuryId = ctx.chain.ecosystemTreasuryId;
    if (!configId || !treasuryId) throw new TypeError("PoC configuration and ecosystem treasury must be configured");
    objectId(configId, "pocConfigId");
    objectId(treasuryId, "ecosystemTreasuryId");
    const tx = new ctx.Transaction();
    tx.moveCall({
        target: `${ctx.chain.packageId}::proof_of_creativity::claim_beneficiary_vault_balance`,
        typeArguments: [canonicalCoinType(p.coinType)],
        arguments: [
            tx.object(configId),
            tx.object(treasuryId),
            tx.object(p.vaultId),
            tx.pure("option<address>", null),
            tx.object(ctx.chain.clockId ?? MYSO_CLOCK),
        ],
    });
    return tx;
}

export function validateAcceptBeneficiaryTransfer(p: AcceptBeneficiaryTransferParams): void {
    objectId(p.beneficiaryId, "beneficiaryId");
}

export function buildAcceptBeneficiaryTransferTx(
    ctx: BuildTxContext,
    p: AcceptBeneficiaryTransferParams,
): any {
    validateAcceptBeneficiaryTransfer(p);
    const tx = new ctx.Transaction();
    tx.moveCall({
        target: `${ctx.chain.packageId}::proof_of_creativity::accept_username_beneficiary_transfer`,
        arguments: [tx.object(p.beneficiaryId), tx.object(ctx.chain.clockId ?? MYSO_CLOCK)],
    });
    return tx;
}
