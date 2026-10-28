/** Owner-wallet payout claims for resolved spot markets. */
import type { BuildTxContext } from "./post.js";
import type { ClaimSpotPayoutParams, PlaceSpotBetParams, CreateSpotMarketParams } from "../types.js";
import { MYSO_CLOCK } from "./helpers.js";

function objectId(value: string, label: string): void {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) throw new TypeError(`${label} must be a chain object ID`);
}

export function validateClaimSpotPayout(p: ClaimSpotPayoutParams): void {
    objectId(p.marketId, "marketId");
    objectId(p.postId, "postId");
}

export function buildClaimSpotPayoutTx(ctx: BuildTxContext, p: ClaimSpotPayoutParams): any {
    validateClaimSpotPayout(p);
    const configId = ctx.chain.spotConfigId;
    if (!configId) throw new TypeError("Spot configuration must be configured");
    objectId(configId, "spotConfigId");
    const tx = new ctx.Transaction();
    tx.moveCall({
        target: `${ctx.chain.packageId}::social_proof_of_truth::claim_payout`,
        arguments: [tx.object(configId), tx.object(p.marketId), tx.object(p.postId), tx.object(ctx.chain.clockId ?? MYSO_CLOCK)],
    });
    return tx;
}

export function validatePlaceSpotBet(p: PlaceSpotBetParams): void {
    for (const [value,label] of [[p.marketId,"marketId"],[p.postId,"postId"],[p.paymentCoinId,"paymentCoinId"],[...(p.referrerPostId?[[p.referrerPostId,"referrerPostId"]]:[])] ] as string[][]) {
        if(typeof value!=="string"||!/^0x[0-9a-fA-F]{1,64}$/.test(value)) throw new TypeError(`${label} must be a chain object ID`);
    }
    if(!Number.isInteger(p.optionId)||p.optionId<0||p.optionId>255) throw new TypeError("optionId must be an integer from 0 to 255");
    if(typeof p.amountBaseUnits!=="string"||!/^[1-9][0-9]{0,19}$/.test(p.amountBaseUnits)||BigInt(p.amountBaseUnits)>((1n<<64n)-1n)) throw new TypeError("amountBaseUnits must be a positive u64 decimal string");
}

export function buildPlaceSpotBetTx(ctx: BuildTxContext, p: PlaceSpotBetParams): any {
    validatePlaceSpotBet(p);
    const configId=ctx.chain.spotConfigId,registryId=ctx.chain.spotClaimRegistryId;
    if(!configId||!registryId) throw new TypeError("Spot configuration and claim registry must be configured");
    objectId(configId,"spotConfigId");objectId(registryId,"spotClaimRegistryId");
    const tx=new ctx.Transaction();
    tx.moveCall({target:`${ctx.chain.packageId}::social_proof_of_truth::place_spot_bet_for_post`,arguments:[
        tx.object(configId),tx.object(registryId),tx.object(p.marketId),tx.object(p.postId),tx.object(p.paymentCoinId),
        tx.pure("u8",p.optionId),tx.pure("u64",p.amountBaseUnits),tx.pure("option<address>",p.referrerPostId??null),
        tx.object(ctx.chain.clockId??MYSO_CLOCK),
    ]});
    return tx;
}

function hashBytes(value:string,label:string):number[]{
    if(typeof value!=="string"||!/^0x[0-9a-fA-F]{64}$/.test(value))throw new TypeError(`${label} must be a 32-byte hex digest`);
    return Array.from({length:32},(_,i)=>parseInt(value.slice(2+i*2,4+i*2),16));
}
function u64(value:string,label:string):void{if(typeof value!=="string"||!/^(0|[1-9][0-9]{0,19})$/.test(value)||BigInt(value)>((1n<<64n)-1n))throw new TypeError(`${label} must be a decimal u64 string`);}
export function validateCreateSpotMarket(p:CreateSpotMarketParams):void{
    for(const [value,label] of [[p.postId,"postId"],[p.spotOracleAdminCapId,"spotOracleAdminCapId"]] as const)objectId(value,label);
    hashBytes(p.semanticClaimHashHex,"semanticClaimHashHex");hashBytes(p.marketKeyHashHex,"marketKeyHashHex");hashBytes(p.resolutionPolicyHashHex,"resolutionPolicyHashHex");
    u64(p.resolutionAtMs,"resolutionAtMs");if(p.maxResolutionWindowMs!==undefined)u64(p.maxResolutionWindowMs,"maxResolutionWindowMs");
    if(!Array.isArray(p.bettingOptions)||p.bettingOptions.length<2||p.bettingOptions.length>16||p.bettingOptions.some(x=>typeof x!=="string"||x.length===0||x.length>128)||new Set(p.bettingOptions).size!==p.bettingOptions.length)throw new TypeError("bettingOptions must contain 2–16 unique non-empty labels of at most 128 characters");
}
export function buildCreateSpotMarketTx(ctx:BuildTxContext,p:CreateSpotMarketParams):any{
    validateCreateSpotMarket(p);const configId=ctx.chain.spotConfigId,registryId=ctx.chain.spotClaimRegistryId;
    if(!configId||!registryId)throw new TypeError("Spot configuration and claim registry must be configured");objectId(configId,"spotConfigId");objectId(registryId,"spotClaimRegistryId");
    const tx=new ctx.Transaction();tx.moveCall({target:`${ctx.chain.packageId}::social_proof_of_truth::create_and_finalize_spot_market_for_post`,arguments:[
        tx.object(p.spotOracleAdminCapId),tx.object(configId),tx.object(registryId),tx.object(p.postId),
        tx.pure("vector<u8>",hashBytes(p.semanticClaimHashHex,"semanticClaimHashHex")),tx.pure("vector<u8>",hashBytes(p.marketKeyHashHex,"marketKeyHashHex")),
        tx.pure("vector<u8>",hashBytes(p.resolutionPolicyHashHex,"resolutionPolicyHashHex")),tx.pure("vector<string>",p.bettingOptions),
        tx.pure("u64",p.resolutionAtMs),tx.pure("option<u64>",p.maxResolutionWindowMs??null),tx.object(ctx.chain.clockId??MYSO_CLOCK),
    ]});return tx;
}
