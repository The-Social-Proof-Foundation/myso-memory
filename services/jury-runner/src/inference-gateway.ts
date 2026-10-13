/**
 * Inference paid from an agent's AI-credit balance, through the relayer's reserve-before-provider
 * gateway. This is how a first-party juror is billed to the platform instead of bringing its own
 * provider: the relayer reserves the funds on chain before it calls the model, so a juror can never
 * spend more than its balance, and the same idempotency key is never charged twice.
 *
 * The signing agent is an operator's inference agent (it needs the AI-spend capability) and is kept
 * apart from the zero-spend juror delegate that votes: the vote key can never spend, and the key that
 * pays for thinking can never vote.
 */

import { InferenceError, type InferenceClient, type InferenceRequest, type UsageRecord } from "./inference.js";
import { sha256Hex } from "./commitment.js";

/** The slice of `Memory.gatewayInference` this client uses. */
export interface GatewayCaller {
    gatewayInference(params: {
        modelId: string;
        prompt: string;
        systemPrompt?: string;
        maxTokens?: number;
        idempotencyKey?: string;
    }): Promise<{
        content: string;
        tokensIn: number;
        tokensOut: number;
        amountMist: number;
        billingState: string;
        reserveDigest: string | null;
        captureDigest: string | null;
        providerGenerationId: string | null;
    }>;
}

export interface GatewayInferenceOptions {
    caller: GatewayCaller;
    modelId: string;
    maxTokens: number;
}

/** Longest idempotency key the wire carries; a case id, round, agent id and stage are longer. */
const WIRE_KEY_HEX = 48;

export class GatewayInferenceClient implements InferenceClient {
    private usage: UsageRecord[] = [];

    constructor(private readonly options: GatewayInferenceOptions) {}

    async completeJson(request: InferenceRequest): Promise<string> {
        const key = request.key ?? `anonymous:${Date.now()}:${Math.random()}`;
        let result: Awaited<ReturnType<GatewayCaller["gatewayInference"]>>;
        try {
            result = await this.options.caller.gatewayInference({
                modelId: this.options.modelId,
                systemPrompt: request.system,
                prompt: request.user,
                maxTokens: this.options.maxTokens,
                // Hashed, so any length of key becomes a short, stable one.
                idempotencyKey: `jury-${sha256Hex(key).slice(0, WIRE_KEY_HEX)}`,
            });
        } catch (error) {
            throw new InferenceError(`gateway inference failed: ${(error as Error).message}`);
        }
        if (typeof result.content !== "string" || result.content.trim() === "") {
            throw new InferenceError("gateway inference returned no content");
        }
        this.usage.push({
            key,
            modelId: this.options.modelId,
            tokensIn: result.tokensIn,
            tokensOut: result.tokensOut,
            amountMist: result.amountMist,
            billingState: result.billingState,
            reserveDigest: result.reserveDigest,
            captureDigest: result.captureDigest,
            providerGenerationId: result.providerGenerationId,
        });
        return result.content;
    }

    takeUsage(prefix: string): UsageRecord[] {
        const mine = this.usage.filter((record) => record.key.startsWith(prefix));
        this.usage = this.usage.filter((record) => !record.key.startsWith(prefix));
        return mine;
    }
}

export interface GatewayAgentConfig {
    serverUrl: string;
    agentKey: string;
    accountId: string;
}

/**
 * The signing client. Loaded on demand so a runner that brings its own provider never needs the
 * SDK, and so this file typechecks without the SDK being built.
 */
export async function createGatewayCaller(config: GatewayAgentConfig): Promise<GatewayCaller> {
    const specifier = "@socialproof/memory";
    const sdk = (await import(specifier)) as {
        Memory: {
            create(config: { key: string; accountId: string; serverUrl: string }): GatewayCaller | Promise<GatewayCaller>;
        };
    };
    return await sdk.Memory.create({
        key: config.agentKey,
        accountId: config.accountId,
        serverUrl: config.serverUrl,
    });
}
