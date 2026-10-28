/** Subscription PTBs for the exact-input owner-wallet flow. Requires the native
 * plan guard/toggle deployment and explicit server opt-in for registry 1.8 writes. */
import type { BuildTxContext } from "./post.js";
import type { SubscribeToPlanParams, RenewSubscriptionParams, CancelSubscriptionParams, SubscriptionRenewalPreferenceParams, SubscriptionPlanTerms, ChangeServicePaymentRecipientParams } from "../types.js";
import { canonicalCoinType } from "./coin-type.js";
import { MYSO_CLOCK, resolvePlatformObjectId } from "./helpers.js";
const MAX_U64=(1n<<64n)-1n;
function id(value:string){if(!/^0x[0-9a-fA-F]{1,64}$/.test(value))throw new TypeError("Invalid subscription object/address ID");}
function number(value:string,positive=false):bigint{
    if(typeof value!=="string"||!/^(0|[1-9][0-9]{0,19})$/.test(value))throw new TypeError("Subscription quantities must be decimal u64 strings");
    const result=BigInt(value);if(result>MAX_U64||(positive&&result===0n))throw new TypeError("Invalid subscription quantity");return result;
}
export function validateSubscriptionPlanTerms(p:SubscriptionPlanTerms):void{
    id(p.planId);id(p.expectedProfileOwner);canonicalCoinType(p.coinType);number(p.priceBaseUnits,true);number(p.durationMs,true);
    if(p.tierLevel!==undefined)number(p.tierLevel);if(p.planPlatformId!==undefined)id(p.planPlatformId);
}
export function validateSubscribeToPlan(p:SubscribeToPlanParams):void{
    id(p.serviceId);id(p.paymentCoinId);validateSubscriptionPlanTerms(p.terms);
    if(p.platformObjectId!==undefined)id(p.platformObjectId);
    if(typeof p.autoRenew!=="boolean")throw new TypeError("autoRenew must be explicit");
    const periods=number(p.renewalPeriods);if(!p.autoRenew&&periods!==0n)throw new TypeError("A non-renewing subscription cannot pre-fund renewal periods");
    if(number(p.terms.priceBaseUnits,true)*(1n+periods)>MAX_U64)throw new TypeError("Subscription total exceeds u64");
}
export function validateRenewSubscription(p:RenewSubscriptionParams):void{
    id(p.serviceId);id(p.subscriptionId);id(p.paymentCoinId);validateSubscriptionPlanTerms(p.terms);if(p.platformObjectId!==undefined)id(p.platformObjectId);
}
export function validateCancelSubscription(p:CancelSubscriptionParams):void{id(p.serviceId);id(p.subscriptionId);canonicalCoinType(p.coinType);}
export function validateSubscriptionRenewalPreference(p:SubscriptionRenewalPreferenceParams):void{id(p.serviceId);id(p.subscriptionId);}
export function validateChangeServicePaymentRecipient(p:ChangeServicePaymentRecipientParams):void{
    id(p.serviceId);id(p.newRecipient);
    if(/^0x0+$/.test(p.newRecipient))throw new TypeError("A subscription payment recipient cannot be the zero address");
}
function objects(ctx:BuildTxContext,p:{platformObjectId?:string}){
    if(!ctx.chain.subscriptionConfigId||!ctx.chain.ecosystemTreasuryId)throw new TypeError("Subscription config and ecosystem treasury are required");
    return {config:ctx.chain.subscriptionConfigId,treasury:ctx.chain.ecosystemTreasuryId,platform:resolvePlatformObjectId(ctx.chain,p.platformObjectId)};
}
function guard(tx:any,ctx:BuildTxContext,serviceId:string,p:SubscriptionPlanTerms,newSubscription:boolean){
    tx.moveCall({target:`${ctx.chain.packageId}::subscription::assert_plan_terms`,typeArguments:[canonicalCoinType(p.coinType)],arguments:[tx.object(serviceId),tx.pure("address",p.planId),tx.pure("address",p.expectedProfileOwner),tx.pure("u64",p.priceBaseUnits),tx.pure("u64",p.durationMs),tx.pure("option<u64>",p.tierLevel??null),tx.pure("option<address>",p.planPlatformId??null),tx.pure("bool",newSubscription)]});
}
export function buildSubscribeToPlanTx(ctx:BuildTxContext,p:SubscribeToPlanParams):any{
    validateSubscribeToPlan(p);const required=objects(ctx,p);const tx=new ctx.Transaction();const type=canonicalCoinType(p.terms.coinType);
    guard(tx,ctx,p.serviceId,p.terms,true);
    const total=(number(p.terms.priceBaseUnits,true)*(1n+number(p.renewalPeriods))).toString();
    const [payment]=tx.splitCoins(tx.object(p.paymentCoinId),[tx.pure("u64",total)]);
    tx.moveCall({target:`${ctx.chain.packageId}::subscription::subscribe_to_profile_with_platform`,typeArguments:[type],arguments:[tx.object(ctx.chain.blockListRegistryId),tx.object(required.config),tx.object(p.serviceId),tx.pure("address",p.terms.planId),tx.object(required.treasury),tx.object(required.platform),payment,tx.pure("bool",p.autoRenew),tx.pure("u64",p.renewalPeriods),tx.object(ctx.chain.clockId??MYSO_CLOCK)]});
    // Exactly the initial and prepaid periods were split; the borrowed coin is now zero.
    tx.moveCall({target:"0x2::coin::destroy_zero",typeArguments:[type],arguments:[payment]});return tx;
}
export function buildRenewSubscriptionTx(ctx:BuildTxContext,p:RenewSubscriptionParams):any{
    validateRenewSubscription(p);const required=objects(ctx,p);const tx=new ctx.Transaction();
    tx.moveCall({target:`${ctx.chain.packageId}::subscription::assert_subscription_terms`,typeArguments:[canonicalCoinType(p.terms.coinType)],arguments:[tx.object(p.serviceId),tx.object(p.subscriptionId),tx.pure("address",p.terms.planId),tx.pure("address",p.terms.expectedProfileOwner),tx.pure("u64",p.terms.priceBaseUnits),tx.pure("u64",p.terms.durationMs),tx.pure("option<u64>",p.terms.tierLevel??null),tx.pure("option<address>",p.terms.planPlatformId??null)]});
    // Native renewal distributes the entire passed coin. Never pass the original coin.
    const [payment]=tx.splitCoins(tx.object(p.paymentCoinId),[tx.pure("u64",p.terms.priceBaseUnits)]);
    tx.moveCall({target:`${ctx.chain.packageId}::subscription::renew_subscription_with_platform`,typeArguments:[canonicalCoinType(p.terms.coinType)],arguments:[tx.object(ctx.chain.blockListRegistryId),tx.object(required.config),tx.object(p.serviceId),tx.object(p.subscriptionId),tx.object(required.treasury),tx.object(required.platform),payment,tx.object(ctx.chain.clockId??MYSO_CLOCK)]});return tx;
}
export function buildCancelSubscriptionTx(ctx:BuildTxContext,p:CancelSubscriptionParams):any{
    validateCancelSubscription(p);const tx=new ctx.Transaction();tx.moveCall({target:`${ctx.chain.packageId}::subscription::cancel_subscription`,typeArguments:[canonicalCoinType(p.coinType)],arguments:[tx.object(p.serviceId),tx.object(p.subscriptionId)]});return tx;
}
function preference(ctx:BuildTxContext,p:SubscriptionRenewalPreferenceParams,enabled:boolean):any{
    validateSubscriptionRenewalPreference(p);const tx=new ctx.Transaction();tx.moveCall({target:`${ctx.chain.packageId}::subscription::set_auto_renew`,arguments:[tx.object(ctx.chain.blockListRegistryId),tx.object(p.serviceId),tx.object(p.subscriptionId),tx.pure("bool",enabled),tx.object(ctx.chain.clockId??MYSO_CLOCK)]});return tx;
}
export const buildEnableAutoRenewTx=(ctx:BuildTxContext,p:SubscriptionRenewalPreferenceParams):any=>preference(ctx,p,true);
export const buildDisableAutoRenewTx=(ctx:BuildTxContext,p:SubscriptionRenewalPreferenceParams):any=>preference(ctx,p,false);
export function buildChangeServicePaymentRecipientTx(ctx:BuildTxContext,p:ChangeServicePaymentRecipientParams):any{
    validateChangeServicePaymentRecipient(p);const tx=new ctx.Transaction();
    tx.moveCall({target:`${ctx.chain.packageId}::subscription::change_service_payment_recipient`,arguments:[tx.object(p.serviceId),tx.pure("address",p.newRecipient),tx.object(ctx.chain.clockId??MYSO_CLOCK)]});
    return tx;
}
