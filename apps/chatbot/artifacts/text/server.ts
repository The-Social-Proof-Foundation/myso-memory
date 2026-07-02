import { smoothStream, streamText } from "ai";
import { ARTIFACT_MODEL_ID } from "@/lib/ai/catalog";
import { recordChatInferenceUsage } from "@/lib/ai/record-inference-usage";
import { updateDocumentPrompt } from "@/lib/ai/prompts";
import { getArtifactModel } from "@/lib/ai/providers";
import { createDocumentHandler } from "@/lib/artifacts/server";

export const textDocumentHandler = createDocumentHandler<"text">({
  kind: "text",
  onCreateDocument: async ({ title, dataStream, billing }) => {
    let draftContent = "";

    const result = streamText({
      model: getArtifactModel(),
      system:
        "Write about the given topic. Markdown is supported. Use headings wherever appropriate.",
      experimental_transform: smoothStream({ chunking: "word" }),
      prompt: title,
    });

    for await (const delta of result.fullStream) {
      const { type } = delta;

      if (type === "text-delta") {
        const { text } = delta;

        draftContent += text;

        dataStream.write({
          type: "data-textDelta",
          data: text,
          transient: true,
        });
      }
    }

    if (billing) {
      const usage = await result.usage;
      if (usage) {
        await recordChatInferenceUsage({
          memoryKey: billing.memoryKey,
          memoryAccountId: billing.memoryAccountId,
          modelId: ARTIFACT_MODEL_ID,
          promptTokens: usage.inputTokens?.total ?? 0,
          completionTokens: usage.outputTokens?.total ?? 0,
        });
      }
    }

    return draftContent;
  },
  onUpdateDocument: async ({ document, description, dataStream, billing }) => {
    let draftContent = "";

    const result = streamText({
      model: getArtifactModel(),
      system: updateDocumentPrompt(document.content, "text"),
      experimental_transform: smoothStream({ chunking: "word" }),
      prompt: description,
      providerOptions: {
        openai: {
          prediction: {
            type: "content",
            content: document.content,
          },
        },
      },
    });

    for await (const delta of result.fullStream) {
      const { type } = delta;

      if (type === "text-delta") {
        const { text } = delta;

        draftContent += text;

        dataStream.write({
          type: "data-textDelta",
          data: text,
          transient: true,
        });
      }
    }

    if (billing) {
      const usage = await result.usage;
      if (usage) {
        await recordChatInferenceUsage({
          memoryKey: billing.memoryKey,
          memoryAccountId: billing.memoryAccountId,
          modelId: ARTIFACT_MODEL_ID,
          promptTokens: usage.inputTokens?.total ?? 0,
          completionTokens: usage.outputTokens?.total ?? 0,
        });
      }
    }

    return draftContent;
  },
});
