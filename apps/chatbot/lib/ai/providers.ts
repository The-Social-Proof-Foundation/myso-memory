import { createOpenAI } from "@ai-sdk/openai";
import {
  customProvider,
  extractReasoningMiddleware,
  wrapLanguageModel,
} from "ai";
import { withMemory } from "@socialproof/memory/ai";
import { isTestEnvironment } from "../constants";

const THINKING_SUFFIX_REGEX = /-thinking$/;

// OpenRouter provider (OpenAI-compatible)
const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY || "",
});

export const myProvider = isTestEnvironment
  ? (() => {
    const {
      artifactModel,
      chatModel,
      reasoningModel,
      titleModel,
    } = require("./models.mock");
    return customProvider({
      languageModels: {
        "chat-model": chatModel,
        "chat-model-reasoning": reasoningModel,
        "title-model": titleModel,
        "artifact-model": artifactModel,
      },
    });
  })()
  : null;

export function getLanguageModel(modelId: string) {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel(modelId);
  }

  const isReasoningModel =
    modelId.endsWith("-thinking") ||
    (modelId.includes("reasoning") && !modelId.includes("non-reasoning"));

  if (isReasoningModel) {
    const gatewayModelId = modelId.replace(THINKING_SUFFIX_REGEX, "");

    return wrapLanguageModel({
      model: openrouter.chat(gatewayModelId),
      middleware: extractReasoningMiddleware({ tagName: "thinking" }),
    });
  }

  return openrouter.chat(modelId);
}

export function getTitleModel() {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel("title-model");
  }
  return openrouter.chat("google/gemini-2.0-flash-001");
}

export function getArtifactModel() {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel("artifact-model");
  }
  return openrouter.chat("anthropic/claude-3.5-haiku");
}

/**
 * Wrap a language model with Memory memory layer.
 * Requires MEMORY_KEY env var. Falls back to base model if not configured.
 */
export function getMemoryModel(modelId: string, memoryKey?: string, memoryAccountId?: string) {
  const baseModel = getLanguageModel(modelId);

  const key = memoryKey || process.env.MEMORY_KEY;
  const memoryServerUrl = process.env.MEMORY_SERVER_URL;
  const accountId = memoryAccountId || process.env.MEMORY_ACCOUNT_ID;

  if (!key) {
    console.warn("[Memory] MEMORY_KEY not set — memory layer disabled");
    return baseModel;
  }

  if (!accountId) {
    console.warn("[Memory] MEMORY_ACCOUNT_ID not set — memory layer disabled");
    return baseModel;
  }

  return withMemory(baseModel, {
    key,
    accountId,
    serverUrl: memoryServerUrl || "http://localhost:8000",
    maxMemories: 5,
    autoSave: true,
    minRelevance: 0,
    debug: true,
  });
}

