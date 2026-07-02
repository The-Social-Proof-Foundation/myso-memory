import { Memory } from "@socialproof/memory";

const THINKING_SUFFIX_REGEX = /-thinking$/;

/**
 * Post-hoc AI credit metering for chatbot `streamText` inference.
 * Signed via the user's memory delegate key (same auth as remember/recall).
 */
export async function recordChatInferenceUsage(opts: {
  memoryKey: string;
  memoryAccountId: string;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
}): Promise<void> {
  if (opts.promptTokens === 0 && opts.completionTokens === 0) {
    return;
  }

  const serverUrl = process.env.MEMORY_SERVER_URL || "http://localhost:8000";
  const billingModelId = opts.modelId.replace(THINKING_SUFFIX_REGEX, "");

  const memory = Memory.create({
    key: opts.memoryKey,
    accountId: opts.memoryAccountId,
    serverUrl,
  });

  try {
    await memory.recordInferenceUsage({
      modelId: billingModelId,
      tokensIn: opts.promptTokens,
      tokensOut: opts.completionTokens,
    });
  } catch (error) {
    console.error("[AI Credit] recordInferenceUsage failed:", error);
  } finally {
    memory.destroy();
  }
}
