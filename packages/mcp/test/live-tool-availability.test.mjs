import assert from "node:assert/strict";
import test from "node:test";
import { SponsoredSocialGateway, connectionToolCatalog, executeTool } from "../dist/index.js";

const memory = {
    async rememberAndWait() { throw new Error("unexpected memory write"); },
    async recall() { return []; },
    async health() { return { status: "ok" }; },
};

test("legacy aliases and task actions follow the same live registry catalog", async () => {
    const gateway = new SponsoredSocialGateway({
        accountId: "0x1", serverUrl: "http://127.0.0.1:8000", signer: {},
    });
    // Exercise the real name mapping without any chain, signer or network operations.
    gateway.listActions = async () => ({ actions: [
        { id: "social.react_to_post.v1", permitted: true },
        { id: "social.react_to_comment.v1", permitted: false },
        { id: "social.create_post.v1", permitted: false },
        { id: "messaging.send_message.v1", permitted: false },
        { id: "task.create.v1", permitted: true },
        { id: "task.settle.v1", permitted: false },
        { id: "agent.register_agent.v1", permitted: false },
    ] });
    const names = await gateway.availableToolNames();
    assert.ok(names.includes("social_react_post"));
    assert.ok(names.includes("task_create"));
    for (const name of ["social_react_comment", "social_create_post", "messaging_send_message", "task_settle", "agent_register_root"]) {
        assert.ok(!names.includes(name), `${name} must not bypass live registry availability`);
    }
});

test("revocation between discovery and invocation prevents dispatch", async () => {
    let permitted = true;
    let dispatched = false;
    const social = {
        supportedToolNames: ["social_create_post"],
        async availableToolNames() { return permitted ? this.supportedToolNames : []; },
        async createPost() { dispatched = true; return { digest: "unexpected" }; },
    };
    const dependencies = { memory, social };
    assert.ok((await connectionToolCatalog(dependencies)).some(tool => tool.name === "social_create_post"));
    permitted = false;
    const result = await executeTool("social_create_post", { content: "hello", idempotencyKey: "example:operation" }, dependencies);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "UNKNOWN_TOOL");
    assert.equal(dispatched, false);
});

test("missing provisioner is hidden from discovery and rejected before execution", async () => {
    const dependencies = { memory, social: { supportedToolNames: ["agent_provision_signer"] } };
    assert.ok(!(await connectionToolCatalog(dependencies)).some(tool => tool.name === "agent_provision_signer"));
    assert.equal((await executeTool("agent_provision_signer", { label: "helper" }, dependencies)).ok, false);
});

test("memory-only requests do not depend on the social service", async () => {
    const dependencies = {
        memory,
        social: { supportedToolNames: ["social_create_post"], async availableToolNames() { throw new Error("social unavailable"); } },
        oauthScopes: new Set(["memory:read"]),
    };
    assert.equal((await executeTool("memory_health", {}, dependencies)).ok, true);
});

test("bounded MyData purchase requires explicit deployment advertisement", async () => {
    let advertised;
    const gateway = new SponsoredSocialGateway({
        accountId: "0x1", serverUrl: "http://127.0.0.1:8000", platformId: "0x3",
        signer: { async sign() { return new Uint8Array(64); }, async getPublicKey() { return new Uint8Array(32); }, async getMySoAddress() { return "0x4"; } },
        fetch: async () => Response.json({
            memoryAccountId: "0x1", agentObjectId: "0x2", derivedAddress: "0x4", capabilities: 4,
            approvalRequiredCapabilities: 0, network: "localnet", rpcUrl: "http://127.0.0.1:9000", packageId: "0x50c1",
            permittedRegistryActions: advertised,
            socialChain: { packageId: "0x50c1", usernameRegistryId: "0x1", platformRegistryId: "0x2", platformObjectId: "0x3",
                blockListRegistryId: "0x4", postConfigId: "0x5", memoryConfigId: "0x6", mydataRegistryId: "0x7", mydataConfigId: "0x8", ecosystemTreasuryId: "0x9" },
        }),
    });
    let names = await gateway.availableToolNames();
    assert.ok(names.includes("mydata_get_purchase_quote"));
    assert.ok(!names.includes("access_purchase_mydata_access"));
    advertised = ["access.purchase_mydata_access.v1"];
    names = await gateway.availableToolNames();
    assert.ok(names.includes("access_purchase_mydata_access"));
    advertised = [];
    assert.ok(!(await gateway.availableToolNames()).includes("access_purchase_mydata_access"));
});

function listingContext(overrides = {}) {
    return {
        memoryAccountId: "0x1", agentObjectId: "0x2", derivedAddress: "0x4", capabilities: 4,
        approvalRequiredCapabilities: 0, network: "localnet", rpcUrl: "http://127.0.0.1:9000", packageId: "0x50c1",
        permittedRegistryActions: ["mydata.read_content.v1"],
        socialChain: { packageId: "0x50c1", usernameRegistryId: "0x1", platformRegistryId: "0x2", platformObjectId: "0x3",
            blockListRegistryId: "0x4", postConfigId: "0x5", memoryConfigId: "0x6" }, ...overrides,
    };
}
function listingGateway(privateData, overrides = {}) {
    return new SponsoredSocialGateway({
        accountId: "0x1", serverUrl: "http://127.0.0.1:8000", platformId: "0x3", privateData,
        signer: { async sign() { return new Uint8Array(64); }, async getPublicKey() { return new Uint8Array(32); }, async getMySoAddress() { return "0x4"; } },
        fetch: async () => Response.json(listingContext(overrides)),
    });
}
test("private content requires a session client, live read flag, capability and OAuth disclosure scope", async () => {
    assert.ok(!listingGateway().supportedToolNames.includes("mydata_read_content"));
    const privateData = {async getAgentContext() { return listingContext(); }, async readMyDataContent() { throw new Error("not called"); }};
    assert.ok((await listingGateway(privateData).availableToolNames()).includes("mydata_read_content"));
    for (const change of [{permittedRegistryActions:[]},{capabilities:0}]) {
        assert.ok(!(await listingGateway(privateData,change).availableToolNames()).includes("mydata_read_content"));
    }
    const dependencies = {memory, social:listingGateway(privateData), oauthScopes:new Set(["mydata:read"])};
    assert.ok(!(await connectionToolCatalog(dependencies)).some(tool => tool.name === "mydata_read_content"));
    assert.equal((await executeTool("mydata_read_content", {request:{mydataId:"0x9",encryptedDataDigestHex:"a".repeat(64),format:"utf8",offset:0,limit:10}},dependencies)).ok,false);
});
test("a private-data SDK for another identity or network cannot disclose content", async () => {
    let calls=0;
    for (const change of [{memoryAccountId:"0x8"},{agentObjectId:"0x8"},{agentObjectId:"invalid"},{derivedAddress:"0x8"},
        {network:"testnet"},{rpcUrl:"http://127.0.0.1:9001"},{platformScope:"0x8"}]) {
        const gateway=listingGateway({async getAgentContext(){return listingContext(change);},async readMyDataContent(){calls++;return {};}});
        await assert.rejects(gateway.callPlatformTool("mydata_read_content",{request:{mydataId:"0x9",encryptedDataDigestHex:"a".repeat(64),format:"utf8",offset:0,limit:10}}));
    }
    assert.equal(calls,0);
});

test("live memory capabilities and hosted identity apply to discovery and invocation",async()=>{
    let capabilities=5, recalled=false;
    const dependencies={memory:{...memory,async getAgentContext(){return {memoryAccountId:"0x1",agentObjectId:"0x2",capabilities};},async recall(){recalled=true;return [];}},principal:{accountId:"0x1",agentObjectId:"0x2"},oauthScopes:new Set(["memory:read","memory:write"])};
    let names=(await connectionToolCatalog(dependencies)).map(tool=>tool.name);
    assert.ok(names.includes("memory_recall"));assert.ok(!names.includes("memory_remember"));
    capabilities=3; // Memory permissions alone do not release MYDATA keys.
    names=(await connectionToolCatalog(dependencies)).map(tool=>tool.name);
    assert.deepEqual(names,["memory_health"]);
    assert.equal((await executeTool("memory_recall",{query:"private"},dependencies)).ok,false);
    assert.equal(recalled,false);
    capabilities=7;
    dependencies.principal={accountId:"0x9",agentObjectId:"0x2"};
    assert.equal((await executeTool("memory_recall",{query:"private"},dependencies)).error.code,"AUTHENTICATION_FAILED");
    assert.equal(recalled,false);
});
test("hosted factories without live identity adapters cannot expose private or social tools",async()=>{
    const dependencies={memory,social:{supportedToolNames:["social_create_post"]},principal:{accountId:"0x1",agentObjectId:"0x2"}};
    assert.deepEqual((await connectionToolCatalog(dependencies)).map(tool=>tool.name),["memory_health"]);
});
test("hosted social adapter must match OAuth before dispatch",async()=>{
    let called=false;
    const dependencies={memory,principal:{accountId:"0x1",agentObjectId:"0x2"},social:{supportedToolNames:["social_create_post"],async getExecutionContext(){return {memoryAccountId:"0x1",agentObjectId:"0x9",capabilities:16};},async createPost(){called=true;}}};
    assert.equal((await executeTool("social_create_post",{content:"hello",idempotencyKey:"example:wrong-principal"},dependencies)).error.code,"AUTHENTICATION_FAILED");
    assert.equal(called,false);
});
test("room, work, AI and automation discovery follows live policy and configuration",async()=>{
    let context=listingContext({capabilities:0,permittedRegistryActions:[]});
    const gateway=listingGateway(undefined);
    gateway.listActions=async()=>({...context,actions:[]});
    gateway.supportedToolNames=[...gateway.supportedToolNames,"work_run_get","work_run_create"];
    let names=await gateway.availableToolNames();
    for(const name of ["room_list","organization_list_rooms","messaging_list_inbox","messaging_wait_for_message","work_run_get","work_run_create","ai_chat","automation_health","automation_list_jobs"]){assert.ok(!names.includes(name),name);}
    context=listingContext({capabilities:16423,organizationId:"0x8",permittedRegistryActions:["ai.run_inference.v1","automation.access.v1"]});
    names=await gateway.availableToolNames();
    for(const name of ["room_list","organization_list_rooms","messaging_list_inbox","work_run_get","work_run_create","ai_chat","automation_list_jobs"]){assert.ok(names.includes(name),name);}
    context.organizationId=undefined;
    assert.ok(!(await gateway.availableToolNames()).includes("organization_list_rooms"));
});
test("work journal identity mismatch is rejected before context disclosure or operation dispatch",async()=>{
    let calls=0;
    const gateway=new SponsoredSocialGateway({accountId:"0x1",serverUrl:"http://127.0.0.1:8000",platformId:"0x3",
        signer:{async sign(){return new Uint8Array(64);},async getPublicKey(){return new Uint8Array(32);},async getMySoAddress(){return "0x4";}},fetch:async()=>Response.json(listingContext()),
        workJournal:{async getAgentContext(){return listingContext({agentObjectId:"0x9"});},async listWorkRuns(){calls++;return [];}}});
    await assert.rejects(gateway.callPlatformTool("agent_get_context",{}));
    await assert.rejects(gateway.callPlatformTool("work_run_list",{}));
    assert.equal(calls,0);
});

test("owner MyData tools request exact-input approval without an automatic dispatch",async()=>{
    let requested,executed=false;
    const dependencies={memory,oauthScopes:new Set(["mydata:share"]),social:{supportedToolNames:["access_share_mydata","access_revoke_mydata_share"],async requestActionApproval(input){requested=input;return {approvalId:"owner-signature-needed"};},async executeAction(){executed=true;}}};
    const result=await executeTool("access_share_mydata",{mydataId:"0x1",recipient:"0x2",accessType:1,subscriptionDays:"730",idempotencyKey:"example:owner-grant"},dependencies);
    assert.equal(result.ok,true);assert.equal(requested.registryAction,"access.share_mydata.v1");assert.deepEqual(requested.parameters,{mydataId:"0x1",recipient:"0x2",accessType:1,subscriptionDays:"730"});assert.equal(executed,false);
    dependencies.oauthScopes=new Set(["mydata:read"]);
    assert.equal((await executeTool("access_share_mydata",{mydataId:"0x1",recipient:"0x2",accessType:0,idempotencyKey:"example:owner-grant"},dependencies)).ok,false);
});

test("subscription actions require live deployment advertisement and owner approval",async()=>{
    const gateway=listingGateway(undefined);let advertised=[];
    gateway.listActions=async()=>({capabilities:256,permittedRegistryActions:advertised,actions:[{id:"subscription.subscribe_to_plan.v1",permitted:advertised.includes("subscription.subscribe_to_plan.v1")}]});
    let names=await gateway.availableToolNames();assert.ok(!names.includes("subscription_subscribe_to_plan"));assert.ok(!names.includes("subscription_get_plan_quote"));
    advertised=["subscription.read.v1"];names=await gateway.availableToolNames();assert.ok(names.includes("subscription_get_plan_quote"));assert.ok(!names.includes("subscription_subscribe_to_plan"));
    advertised.push("subscription.subscribe_to_plan.v1");assert.ok((await gateway.availableToolNames()).includes("subscription_subscribe_to_plan"));
    let approved,dispatched=false;
    const social={supportedToolNames:["subscription_subscribe_to_plan"],async requestActionApproval(input){approved=input;return {status:"requested"};},async executeAction(){dispatched=true;}};
    const params={serviceId:"0x1",paymentCoinId:"0x2",terms:{planId:"0x3",expectedProfileOwner:"0x4",coinType:"0x2::myso::MYSO",priceBaseUnits:"9007199254740993",durationMs:"2592000000"},autoRenew:false,renewalPeriods:"0",idempotencyKey:"example:subscription"};
    let result=await executeTool("subscription_subscribe_to_plan",params,{memory,social,oauthScopes:new Set(["subscription:write"])});assert.equal(result.ok,true);assert.equal(approved.registryAction,"subscription.subscribe_to_plan.v1");assert.equal(approved.parameters.terms.priceBaseUnits,"9007199254740993");assert.equal(dispatched,false);
    approved=undefined;
    result=await executeTool("subscription_subscribe_to_plan",{...params,terms:{...params.terms,moveTarget:"0x2::evil::pay"}},{memory,social,oauthScopes:new Set(["subscription:write"])});assert.equal(result.ok,false);assert.equal(approved,undefined);
    result=await executeTool("subscription_subscribe_to_plan",params,{memory,social,oauthScopes:new Set(["subscription:read"])});assert.equal(result.ok,false);
});


test("token transfers require an advertised deployment and exact-input owner approval",async()=>{
    const gateway=listingGateway(undefined);let advertised=[];
    gateway.listActions=async()=>({capabilities:256,permittedRegistryActions:advertised,actions:[{id:"payments.send_token.v1",permitted:advertised.includes("payments.send_token.v1")}]});
    assert.ok(!(await gateway.availableToolNames()).includes("payments_send_token"));
    assert.ok(!(await gateway.availableToolNames()).includes("payments_get_transfer_quote"));
    advertised=["payments.read.v1"];
    assert.ok((await gateway.availableToolNames()).includes("payments_get_transfer_quote"));
    assert.ok(!(await gateway.availableToolNames()).includes("payments_send_token"));
    advertised.push("payments.send_token.v1");assert.ok((await gateway.availableToolNames()).includes("payments_send_token"));
    let approval,dispatched=false;
    const social={supportedToolNames:["payments_send_token"],async requestActionApproval(input){approval=input;return {status:"requested"};},async executeAction(){dispatched=true;}};
    const params={paymentCoinId:"0x1",recipient:"0x2",coinType:"0x3::coin::USD",amountBaseUnits:"9007199254740993",idempotencyKey:"example:coin-transfer"};
    const dependencies={memory,social,oauthScopes:new Set(["payments:write"])};
    assert.equal((await executeTool("payments_send_token",params,dependencies)).ok,true);
    assert.equal(approval.registryAction,"payments.send_token.v1");assert.equal(approval.parameters.amountBaseUnits,"9007199254740993");assert.equal(dispatched,false);
    approval=undefined;
    assert.equal((await executeTool("payments_send_token",{...params,target:"arbitrary::call"},dependencies)).ok,false);assert.equal(approval,undefined);
    assert.equal((await executeTool("payments_send_token",params,{...dependencies,oauthScopes:new Set(["payments:read"])})).ok,false);
});
