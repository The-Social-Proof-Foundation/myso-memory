import type { BuildTxContext } from "./post.js";
import type { PlatformDeveloperTransferParams, PlatformFeeRecipientUpdateParams } from "../types.js";

const ADDRESS=/^0x[0-9a-fA-F]{1,64}$/;
function address(value:string,label:string){if(!ADDRESS.test(value))throw new TypeError(`${label} must be a MySo address`);return value;}
function same(a:string,b:string){return a.replace(/^0x/i,"").toLowerCase().padStart(64,"0")===b.replace(/^0x/i,"").toLowerCase().padStart(64,"0");}
function clock(ctx:BuildTxContext){return ctx.chain.clockId??"0x6";}
export function buildPlatformDeveloperTransferTx(ctx:BuildTxContext,params:PlatformDeveloperTransferParams):any{
    address(params.platformId,"platformId");address(params.platformAdminCapId,"platformAdminCapId");address(params.newDeveloper,"newDeveloper");
    if(!same(params.platformId,ctx.chain.platformObjectId))throw new TypeError("platformId must match the configured platform object");
    if(same(params.newDeveloper,"0x0"))throw new TypeError("newDeveloper cannot be the zero address");
    const tx=new ctx.Transaction();tx.moveCall({target:`${ctx.chain.packageId}::platform::transfer_platform`,arguments:[tx.object(params.platformId),tx.object(params.platformAdminCapId),tx.pure("address",params.newDeveloper),tx.object(clock(ctx))]});return tx;
}
export function buildPlatformFeeRecipientUpdateTx(ctx:BuildTxContext,params:PlatformFeeRecipientUpdateParams):any{
    address(params.platformAdminCapId,"platformAdminCapId");address(params.newRecipient,"newRecipient");
    if(same(params.newRecipient,"0x0"))throw new TypeError("newRecipient cannot be the zero address");
    if(!ctx.chain.taskConfigId)throw new TypeError("taskConfigId is required for the platform fee-recipient action");
    const tx=new ctx.Transaction();tx.moveCall({target:`${ctx.chain.packageId}::agent_task::update_fee_recipient`,arguments:[tx.object(params.platformAdminCapId),tx.object(ctx.chain.taskConfigId),tx.pure("address",params.newRecipient),tx.object(clock(ctx))]});return tx;
}
