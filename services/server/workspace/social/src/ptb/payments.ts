/** Exact owner-wallet coin transfers. No generic Move target or coin merge. */
import type { BuildTxContext } from "./post.js";
import type { SendTokenParams } from "../types.js";
import type { TipPostParams } from "../types.js";
import { canonicalCoinType } from "./coin-type.js";
import { MYSO_CLOCK } from "./helpers.js";
export function validateSendToken(p:SendTokenParams):void {
    for(const value of [p.paymentCoinId,p.recipient]) if(typeof value!=="string"||!/^0x[0-9a-fA-F]{1,64}$/.test(value))throw new TypeError("Invalid transfer coin or recipient");
    if(typeof p.amountBaseUnits!=="string"||!/^[1-9][0-9]{0,19}$/.test(p.amountBaseUnits)||BigInt(p.amountBaseUnits)>((1n<<64n)-1n))throw new TypeError("Transfer amount must be an exact positive u64 string");
    canonicalCoinType(p.coinType);
}
export function buildSendTokenTx(ctx:BuildTxContext,p:SendTokenParams):any {
    validateSendToken(p);
    const tx=new ctx.Transaction();
    const [payment]=tx.splitCoins(tx.object(p.paymentCoinId),[tx.pure("u64",p.amountBaseUnits)]);
    tx.transferObjects([payment],tx.pure("address",p.recipient));
    return tx;
}

function objectId(value:string):void {
    if(typeof value!=="string"||!/^0x[0-9a-fA-F]{1,64}$/.test(value))throw new TypeError("Invalid object ID");
}
function positiveU64(value:string,label:string):void {
    if(typeof value!=="string"||!/^[1-9][0-9]{0,19}$/.test(value)||BigInt(value)>((1n<<64n)-1n))throw new TypeError(`${label} must be a positive u64 decimal string`);
}
export function validateTipPost(p:TipPostParams):void {
    objectId(p.postId);objectId(p.paymentCoinId);canonicalCoinType(p.coinType);positiveU64(p.amountBaseUnits,"Tip amount");
    if(p.mode==="simple"){
        if(p.beneficiaryVaultId!==undefined||p.minVaultDepositAmount!==undefined)throw new TypeError("Simple tip mode cannot include beneficiary-vault parameters");
        return;
    }
    if(p.mode!=="beneficiary-vault")throw new TypeError("Tip mode must be simple or beneficiary-vault");
    if(!p.beneficiaryVaultId||!p.minVaultDepositAmount)throw new TypeError("Beneficiary-vault mode requires a vault ID and minimum deposit amount");
    objectId(p.beneficiaryVaultId);positiveU64(p.minVaultDepositAmount,"Minimum vault deposit");
}
export function buildTipPostTx(ctx:BuildTxContext,p:TipPostParams):any {
    validateTipPost(p);
    const tx=new ctx.Transaction();
    const target=`${ctx.chain.packageId}::post::${p.mode==="simple"?"tip_post_simple":"tip_post"}`;
    const argumentsList=p.mode==="simple"
        ?[tx.object(p.postId),tx.object(p.paymentCoinId),tx.pure("u64",p.amountBaseUnits),tx.object(ctx.memoryAccountId)]
        :[tx.object(p.postId),tx.object(p.beneficiaryVaultId!),tx.object(p.paymentCoinId),tx.pure("u64",p.amountBaseUnits),tx.pure("u64",p.minVaultDepositAmount!),tx.object(ctx.memoryAccountId),tx.object(ctx.chain.clockId??MYSO_CLOCK)];
    tx.moveCall({target,typeArguments:[canonicalCoinType(p.coinType)],arguments:argumentsList});
    return tx;
}
