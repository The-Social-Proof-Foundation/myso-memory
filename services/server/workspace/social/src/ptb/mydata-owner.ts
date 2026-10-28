/** Existing MyData listing-owner rights. These calls always use the owner-wallet
 * approval path; CAP_MYDATA_READ alone never grants a buyer sharing authority. */
import type { BuildTxContext } from "./post.js";
import type { ShareMyDataParams, RevokeMyDataShareParams } from "../types.js";
import { MYSO_CLOCK } from "./helpers.js";
function id(value:string){if(!/^0x[0-9a-fA-F]{1,64}$/.test(value))throw new TypeError("Invalid MyData object or recipient address");}
export function validateShareMyData(p:ShareMyDataParams):void{
    id(p.mydataId);id(p.recipient);
    if(p.accessType!==0&&p.accessType!==1)throw new TypeError("accessType must be 0 (one-time) or 1 (subscription)");
    if(p.accessType===0&&p.subscriptionDays!==undefined)throw new TypeError("One-time access cannot carry a subscription period");
    if(p.accessType===1&&(typeof p.subscriptionDays!=="string"||!/^([1-9][0-9]{0,19})$/.test(p.subscriptionDays)||BigInt(p.subscriptionDays)>((1n<<64n)-1n)))throw new TypeError("Subscription grants require an exact positive u64 day count");
}
export function validateRevokeMyDataShare(p:RevokeMyDataShareParams):void{
    id(p.mydataId);id(p.recipient);if(![0,1,2].includes(p.accessType))throw new TypeError("accessType must be 0 (one-time), 1 (subscription), or 2 (both)");
}
export function buildShareMyDataTx(ctx:BuildTxContext,p:ShareMyDataParams):any{
    validateShareMyData(p);if(!ctx.chain.mydataConfigId)throw new TypeError("mydataConfigId is required for free grants");
    const tx=new ctx.Transaction();tx.moveCall({target:`${ctx.chain.packageId}::mydata::grant_access`,arguments:[tx.object(ctx.chain.mydataConfigId),tx.object(p.mydataId),tx.pure("address",p.recipient),tx.pure("u8",p.accessType),tx.pure("option<u64>",p.subscriptionDays??null),tx.object(ctx.chain.clockId??MYSO_CLOCK)]});return tx;
}
export function buildRevokeMyDataShareTx(ctx:BuildTxContext,p:RevokeMyDataShareParams):any{
    validateRevokeMyDataShare(p);const tx=new ctx.Transaction();tx.moveCall({target:`${ctx.chain.packageId}::mydata::revoke_access`,arguments:[tx.object(p.mydataId),tx.pure("address",p.recipient),tx.pure("u8",p.accessType),tx.object(ctx.chain.clockId??MYSO_CLOCK)]});return tx;
}
