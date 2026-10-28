import assert from "node:assert/strict";
import test from "node:test";
import { Transaction } from "@socialproof/myso/transactions";
import { buildSendTokenTx, validateSendToken } from "./payments.js";
import type { BuildTxContext } from "./post.js";
import type { SendTokenParams } from "../types.js";
import { getSocialActionDescriptor, isSupportedSocialRegistryVersion } from "../action-registry/index.js";

const parameters: SendTokenParams={paymentCoinId:"0x1",recipient:"0x2",coinType:"0x3::coin::USD",amountBaseUnits:"9007199254740993"};
test("owner transfer uses exact BCS amount and a new split coin, without generic Move calls",()=>{
    const tx=buildSendTokenTx({Transaction} as unknown as BuildTxContext,parameters) as Transaction;
    const data=tx.getData();
    assert.equal(data.commands.length,2);
    assert.ok(data.commands[0].SplitCoins);
    assert.ok(data.commands[1].TransferObjects);
    const pure=data.inputs[1].Pure;
    assert.ok(pure);
    assert.equal(Buffer.from(pure.bytes,"base64").readBigUInt64LE(),9007199254740993n);
    const transferred=data.commands[1].TransferObjects?.objects[0];
    assert.ok(transferred?.$kind==="NestedResult");
    assert.deepEqual(transferred.NestedResult,[0,0]);
});
test("transfer inputs reject rounded, overflowing and target-injection payloads",()=>{
    for(const amountBaseUnits of ["0","01","1.1","-1","18446744073709551616",9007199254740993]){
        assert.throws(()=>validateSendToken({...parameters,amountBaseUnits} as SendTokenParams));
    }
    assert.throws(()=>validateSendToken({...parameters,coinType:"0x2::coin::USD;transfer"}));
    assert.equal(getSocialActionDescriptor("payments.send_token.v1").validate({...parameters,target:"arbitrary::call"}).success,false);
    assert.equal(getSocialActionDescriptor("payments.send_token.v1").riskTier,"2");
    assert.equal(isSupportedSocialRegistryVersion("1.8.0","payments.send_token.v1"),false);
    assert.equal(isSupportedSocialRegistryVersion("1.9.0","payments.send_token.v1"),true);
    assert.equal(isSupportedSocialRegistryVersion("1.8.0","subscription.renew_subscription.v1"),true);
});
