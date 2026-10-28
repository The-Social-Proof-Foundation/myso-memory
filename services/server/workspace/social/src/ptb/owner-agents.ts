/** Exact owner-wallet agent policy operations. The native guard preserves all unrelated policy. */
import type { BuildTxContext } from "./post.js";
import type { OwnerAgentIdentityParams,OwnerChangeCapabilityParams,OwnerRaiseSpendingLimitParams,OwnerLowerSpendingLimitParams } from "../types.js";
import { MYSO_CLOCK } from "./helpers.js";
export const SUPPORTED_AGENT_CAPABILITIES=524279n; // memory::supported_agent_capabilities, bits 0..18 excluding 3.
function id(value:string){if(typeof value!=="string"||!/^0x[0-9a-fA-F]{1,64}$/.test(value))throw new TypeError("Invalid agent policy address/object");}
function value(input:string):bigint{if(typeof input!=="string"||!/^(0|[1-9][0-9]{0,19})$/.test(input)||BigInt(input)>((1n<<64n)-1n))throw new TypeError("Agent policy values must be exact decimal u64 strings");return BigInt(input);}
export function validateOwnerAgentIdentity(p:OwnerAgentIdentityParams):void{id(p.agentObjectId);id(p.expectedDerivedAddress);if(p.expectedPlatformScope!=="global")id(p.expectedPlatformScope);}
export function validateOwnerCapability(p:OwnerChangeCapabilityParams,grant:boolean):void{
    validateOwnerAgentIdentity(p);const old=value(p.expectedCapabilities),mask=value(p.capabilityMask);
    if(mask===0n||(grant&&(mask&SUPPORTED_AGENT_CAPABILITIES)!==mask))throw new TypeError("Grant mask must contain supported nonzero execution capabilities");
    if(grant?(old|mask)===old:(old&mask)===0n)throw new TypeError("Capability operation must change the expected execution bitmap");
}
export function validateOwnerGrantCapability(p:OwnerChangeCapabilityParams):void{validateOwnerCapability(p,true);}
export function validateOwnerRevokeCapability(p:OwnerChangeCapabilityParams):void{validateOwnerCapability(p,false);}
export function validateOwnerRaiseLimit(p:OwnerRaiseSpendingLimitParams):void{
    validateOwnerAgentIdentity(p);const old=value(p.expectedLimitMist);
    if(p.newLimitMist!=="unlimited"&&value(p.newLimitMist)<=old)throw new TypeError("A finite new per-action ceiling must exceed the expected finite ceiling");
}
export function validateOwnerLowerLimit(p:OwnerLowerSpendingLimitParams):void{
    validateOwnerAgentIdentity(p);const next=value(p.newLimitMist);
    if(p.expectedLimitMist!=="unlimited"&&next>=value(p.expectedLimitMist))throw new TypeError("A lower per-action ceiling must be less than the expected current ceiling");
}
function scope(tx:any,p:OwnerAgentIdentityParams){return tx.pure("option<address>",p.expectedPlatformScope==="global"?null:p.expectedPlatformScope);}
function target(ctx:BuildTxContext,name:string){return `${ctx.chain.packageId}::memory::${name}`;}
function identity(tx:any,ctx:BuildTxContext,p:OwnerAgentIdentityParams){return [tx.object(ctx.memoryAccountId),tx.object(p.agentObjectId),tx.pure("address",p.expectedDerivedAddress),scope(tx,p)];}
export function buildOwnerRevokeAgentTx(ctx:BuildTxContext,p:OwnerAgentIdentityParams):any{
    validateOwnerAgentIdentity(p);const tx=new ctx.Transaction();
    tx.moveCall({target:target(ctx,"assert_owner_agent_identity"),arguments:identity(tx,ctx,p)});
    tx.moveCall({target:target(ctx,"revoke_sub_agent"),arguments:[tx.object(ctx.memoryAccountId),tx.object(p.agentObjectId),tx.object(ctx.chain.clockId??MYSO_CLOCK)]});return tx;
}
function capability(ctx:BuildTxContext,p:OwnerChangeCapabilityParams,grant:boolean):any{
    validateOwnerCapability(p,grant);const tx=new ctx.Transaction();
    tx.moveCall({target:target(ctx,grant?"owner_grant_sub_agent_capabilities":"owner_revoke_sub_agent_capabilities"),arguments:[...identity(tx,ctx,p),tx.pure("u64",p.expectedCapabilities),tx.pure("u64",p.capabilityMask),tx.object(ctx.chain.clockId??MYSO_CLOCK)]});return tx;
}
export function buildOwnerGrantCapabilityTx(ctx:BuildTxContext,p:OwnerChangeCapabilityParams):any{return capability(ctx,p,true);}
export function buildOwnerRevokeCapabilityTx(ctx:BuildTxContext,p:OwnerChangeCapabilityParams):any{return capability(ctx,p,false);}
export function buildOwnerRaiseSpendingLimitTx(ctx:BuildTxContext,p:OwnerRaiseSpendingLimitParams):any{
    validateOwnerRaiseLimit(p);const tx=new ctx.Transaction();tx.moveCall({target:target(ctx,"owner_raise_sub_agent_spending_limit"),arguments:[...identity(tx,ctx,p),tx.pure("u64",p.expectedLimitMist),tx.pure("option<u64>",p.newLimitMist==="unlimited"?null:p.newLimitMist),tx.object(ctx.chain.clockId??MYSO_CLOCK)]});return tx;
}
export function buildOwnerLowerSpendingLimitTx(ctx:BuildTxContext,p:OwnerLowerSpendingLimitParams):any{
    validateOwnerLowerLimit(p);const tx=new ctx.Transaction();tx.moveCall({target:target(ctx,"owner_lower_sub_agent_spending_limit"),arguments:[...identity(tx,ctx,p),tx.pure("option<u64>",p.expectedLimitMist==="unlimited"?null:p.expectedLimitMist),tx.pure("u64",p.newLimitMist),tx.object(ctx.chain.clockId??MYSO_CLOCK)]});return tx;
}
