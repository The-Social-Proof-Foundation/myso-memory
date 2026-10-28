import assert from "node:assert/strict";
import test from "node:test";
import { canonicalCoinType } from "./coin-type.js";
import { buildRenewSubscriptionTx, buildSubscribeToPlanTx, validateSubscribeToPlan, buildEnableAutoRenewTx, buildDisableAutoRenewTx } from "./subscription.js";
import type { BuildTxContext } from "./post.js";
import type { SubscribeToPlanParams } from "../types.js";
const terms={planId:"0x1",expectedProfileOwner:"0x2",coinType:"0x2::myso::MYSO",priceBaseUnits:"1000",durationMs:"2592000000"};
class Tx {
    calls:any[]=[];
    object(id:string){return {object:id};}pure(type:string,value:unknown){return {type,value};}
    moveCall(call:unknown){this.calls.push(call);}
    splitCoins(coin:unknown,amounts:unknown[]){this.calls.push({split:coin,amounts});return [{splitResult:true}];}
}
const ctx={Transaction:Tx,chain:{packageId:"0x50c1",subscriptionConfigId:"0x3",ecosystemTreasuryId:"0x4",platformObjectId:"0x5",blockListRegistryId:"0x6",clockId:"0x6"}} as unknown as BuildTxContext;
test("manual renewal guards the actual subscription and never passes the full input coin",()=>{
    const tx=buildRenewSubscriptionTx(ctx,{serviceId:"0x7",subscriptionId:"0x8",paymentCoinId:"0x9",terms}) as Tx;
    assert.equal(tx.calls[0].target,"0x50c1::subscription::assert_subscription_terms");
    assert.deepEqual(tx.calls[0].arguments.slice(0,3),[{object:"0x7"},{object:"0x8"},{type:"address",value:"0x1"}]);
    assert.deepEqual(tx.calls[1],{split:{object:"0x9"},amounts:[{type:"u64",value:"1000"}]});
    assert.equal(tx.calls[2].target,"0x50c1::subscription::renew_subscription_with_platform");
    assert.deepEqual(tx.calls[2].arguments[6],{splitResult:true});
});
test("new subscriptions split exactly the initial and authorized prepaid periods",()=>{
    const tx=buildSubscribeToPlanTx(ctx,{serviceId:"0x7",paymentCoinId:"0x9",terms,autoRenew:true,renewalPeriods:"2"}) as Tx;
    assert.equal(tx.calls[0].target,"0x50c1::subscription::assert_plan_terms");
    assert.deepEqual(tx.calls[1].amounts,[{type:"u64",value:"3000"}]);
    assert.equal(tx.calls[2].target,"0x50c1::subscription::subscribe_to_profile_with_platform");
    assert.equal(tx.calls[3].target,"0x2::coin::destroy_zero");
    assert.deepEqual(tx.calls[3].arguments,[{splitResult:true}]);
});
test("funding terms reject ignored periods, rounded prices and overflow",()=>{
    const p={serviceId:"0x7",paymentCoinId:"0x9",terms,autoRenew:false,renewalPeriods:"0"};
    validateSubscribeToPlan(p);
    for(const change of [{renewalPeriods:"1"},{autoRenew:true,renewalPeriods:"18446744073709551615"},{terms:{...terms,priceBaseUnits:1.1}},{terms:{...terms,durationMs:"0"}}]){
        assert.throws(()=>validateSubscribeToPlan({...p,...change} as unknown as SubscribeToPlanParams));
    }
});
test("coin types are complete bounded struct tags with explicit coin units",()=>{
    assert.equal(canonicalCoinType("0x2::myso::MYSO"),`0x${"2".padStart(64,"0")}::myso::MYSO`);
    assert.match(canonicalCoinType("0x2::wrapper::Coin<0x3::token::USD, vector<u8>>"),/::Coin<.*::USD,vector<u8>>$/);
    for(const invalid of ["u64","0x2::coin::Coin<u64>trailing","0x2::coin::Coin<>","0x2::myso::MYSO;evil()","https://example.com","0x2::coin::Coin<u64"]){assert.throws(()=>canonicalCoinType(invalid));}
});
test("renewal preference builders choose their fixed boolean without moving funds",()=>{
    const p={serviceId:"0x7",subscriptionId:"0x8"};
    for(const [builder,enabled] of [[buildEnableAutoRenewTx,true],[buildDisableAutoRenewTx,false]] as const){
        const tx=builder(ctx,p) as Tx;assert.equal(tx.calls.length,1);assert.equal(tx.calls[0].target,"0x50c1::subscription::set_auto_renew");assert.deepEqual(tx.calls[0].arguments[3],{type:"bool",value:enabled});
    }
});

test("registered subscription schemas reject unexpected nested terms and older versions",async()=>{
    const {getSocialActionDescriptor}=await import("../action-registry/registry.js");
    const {isSupportedSocialRegistryVersion}=await import("../action-registry/types.js");
    const descriptor=getSocialActionDescriptor("subscription.subscribe_to_plan.v1");
    const p={serviceId:"0x7",paymentCoinId:"0x9",terms,autoRenew:false,renewalPeriods:"0"};
    assert.equal(descriptor.validate(p).success,true);
    assert.equal(descriptor.validate({...p,terms:{...terms,moveTarget:"0x2::evil::pay"}}).success,false);
    assert.equal(descriptor.validate({...p,terms:{...terms,priceBaseUnits:1000}}).success,false);
    for(const version of ["1.5.0","1.6.0","1.7.0"]){assert.equal(isSupportedSocialRegistryVersion(version,descriptor.id),false);}
    assert.equal(isSupportedSocialRegistryVersion("1.8.0",descriptor.id),true);
});
