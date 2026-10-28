import assert from "node:assert/strict";
import test from "node:test";
import { getSocialActionDescriptor } from "../action-registry/registry.js";
import { isSupportedSocialRegistryVersion } from "../action-registry/types.js";
import { buildShareMyDataTx, buildRevokeMyDataShareTx } from "./mydata-owner.js";
import type { BuildTxContext } from "./post.js";
const grant=getSocialActionDescriptor("access.share_mydata.v1");
const revoke=getSocialActionDescriptor("access.revoke_mydata_share.v1");
test("sharing is owner-approved and subscription periods are explicit u64 values",()=>{
    assert.equal(grant.riskTier,"2");assert.equal(revoke.riskTier,"2");
    const base={mydataId:"0x1",recipient:"0x2",accessType:1,subscriptionDays:"730"};
    assert.equal(grant.validate(base).success,true);
    for(const changed of [{accessType:2},{subscriptionDays:undefined},{subscriptionDays:"0"},{subscriptionDays:30},{subscriptionDays:"18446744073709551616"},{buyerAccountId:"0x3"},{privateKey:"never"},{resale:true}])assert.equal(grant.validate({...base,...changed}).success,false);
    assert.equal(grant.validate({...base,accessType:0}).success,false);
    assert.equal(grant.validate({mydataId:"0x1",recipient:"0x2",accessType:0}).success,true);
    assert.equal(revoke.validate({mydataId:"0x1",recipient:"0x2",accessType:2}).success,true);
});
test("owner access changes cannot be negotiated under older registries",()=>{
    for(const version of ["1.5.0","1.6.0"]){assert.equal(isSupportedSocialRegistryVersion(version,grant.id),false);assert.equal(isSupportedSocialRegistryVersion(version,revoke.id),false);}
    assert.equal(isSupportedSocialRegistryVersion("1.7.0",grant.id),true);
    assert.equal(isSupportedSocialRegistryVersion("1.6.0","access.purchase_mydata_access.v1"),true);
});
test("builders call only the existing native listing-owner ABI",()=>{
    class Tx{commands:any[]=[];object(id:string){return {object:id};}pure(type:string,value:unknown){return {type,value};}moveCall(call:unknown){this.commands.push(call);}}
    const ctx={Transaction:Tx,chain:{packageId:"0x50c1",mydataConfigId:"0x3",clockId:"0x6"}} as unknown as BuildTxContext;
    const tx=buildShareMyDataTx(ctx,{mydataId:"0x1",recipient:"0x2",accessType:1,subscriptionDays:"9007199254740993"}) as Tx;
    assert.deepEqual(tx.commands,[{target:"0x50c1::mydata::grant_access",arguments:[{object:"0x3"},{object:"0x1"},{type:"address",value:"0x2"},{type:"u8",value:1},{type:"option<u64>",value:"9007199254740993"},{object:"0x6"}]}]);
    const stopped=buildRevokeMyDataShareTx(ctx,{mydataId:"0x1",recipient:"0x2",accessType:2}) as Tx;
    assert.equal(stopped.commands[0].target,"0x50c1::mydata::revoke_access");assert.equal(stopped.commands[0].arguments.length,4);
});
