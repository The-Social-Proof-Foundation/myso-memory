/**
 * The model behind a juror. One small interface so the judging pipeline never knows which provider
 * answers, and a client for any OpenAI-compatible chat endpoint. The runner holds no tools here:
 * the model reads text and returns JSON, and nothing it says is executed. A hostile case file can
 * at worst change what it writes back, and `judge.ts` validates that.
 */

export interface InferenceRequest {
    system: string;
    user: string;
    /**
     * Names this call so billing is idempotent: a client that bills per call treats a repeat of the
     * same key as the same call, and the runner can look the call's cost up afterwards.
     */
    key?: string;
}

/** What one billed completion cost and where the provider says it came from. */
export interface UsageRecord {
    key: string;
    modelId: string;
    tokensIn: number;
    tokensOut: number;
    amountMist: number;
    billingState: string;
    reserveDigest: string | null;
    captureDigest: string | null;
    providerGenerationId: string | null;
}

export interface InferenceClient {
    /** One completion that must be a single JSON object. */
    completeJson(request: InferenceRequest): Promise<string>;
    /**
     * Billing records of the calls whose key starts with `prefix`, handed over once. Only a client
     * that bills per call has any; the others leave this out.
     */
    takeUsage?(prefix: string): UsageRecord[];
}

export interface OpenAiCompatibleOptions {
    url: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
    fetchImpl?: typeof fetch;
}

export class InferenceError extends Error {}

export class OpenAiCompatibleClient implements InferenceClient {
    constructor(private readonly options: OpenAiCompatibleOptions) {}

    async completeJson(request: InferenceRequest): Promise<string> {
        const fetchImpl = this.options.fetchImpl ?? fetch;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
        let response: Response;
        try {
            response = await fetchImpl(`${this.options.url}/chat/completions`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${this.options.apiKey}`,
                },
                body: JSON.stringify({
                    model: this.options.model,
                    temperature: 0,
                    response_format: { type: "json_object" },
                    messages: [
                        { role: "system", content: request.system },
                        { role: "user", content: request.user },
                    ],
                }),
                signal: controller.signal,
            });
        } catch (error) {
            throw new InferenceError(`inference request failed: ${(error as Error).message}`);
        } finally {
            clearTimeout(timer);
        }
        if (!response.ok) throw new InferenceError(`inference answered ${response.status}`);
        const body = (await response.json().catch(() => null)) as {
            choices?: Array<{ message?: { content?: unknown } }>;
        } | null;
        const content = body?.choices?.[0]?.message?.content;
        if (typeof content !== "string" || content.trim() === "") {
            throw new InferenceError("inference returned no content");
        }
        return content;
    }
}
