import { streamObject } from "ai";
import { z } from "zod";
import { ARTIFACT_MODEL_ID } from "@/lib/ai/catalog";
import { recordChatInferenceUsage } from "@/lib/ai/record-inference-usage";
import { codePrompt, updateDocumentPrompt } from "@/lib/ai/prompts";
import { getArtifactModel } from "@/lib/ai/providers";
import { createDocumentHandler } from "@/lib/artifacts/server";

async function recordArtifactUsage(
  billing: { memoryKey: string; memoryAccountId: string } | undefined,
  usage: Awaited<ReturnType<typeof streamObject>["usage"]>,
) {
  if (!billing) {
    return;
  }
  const resolved = await usage;
  if (!resolved) {
    return;
  }
  await recordChatInferenceUsage({
    memoryKey: billing.memoryKey,
    memoryAccountId: billing.memoryAccountId,
    modelId: ARTIFACT_MODEL_ID,
    promptTokens: resolved.inputTokens?.total ?? 0,
    completionTokens: resolved.outputTokens?.total ?? 0,
  });
}

export const codeDocumentHandler = createDocumentHandler<"code">({
  kind: "code",
  onCreateDocument: async ({ title, dataStream, billing }) => {
    let draftContent = "";

    const result = streamObject({
      model: getArtifactModel(),
      system: codePrompt,
      prompt: title,
      schema: z.object({
        code: z.string(),
      }),
    });

    for await (const delta of result.fullStream) {
      const { type } = delta;

      if (type === "object") {
        const { object } = delta;
        const { code } = object;

        if (code) {
          dataStream.write({
            type: "data-codeDelta",
            data: code ?? "",
            transient: true,
          });

          draftContent = code;
        }
      }
    }

    await recordArtifactUsage(billing, result.usage);

    return draftContent;
  },
  onUpdateDocument: async ({ document, description, dataStream, billing }) => {
    let draftContent = "";

    const result = streamObject({
      model: getArtifactModel(),
      system: updateDocumentPrompt(document.content, "code"),
      prompt: description,
      schema: z.object({
        code: z.string(),
      }),
    });

    for await (const delta of result.fullStream) {
      const { type } = delta;

      if (type === "object") {
        const { object } = delta;
        const { code } = object;

        if (code) {
          dataStream.write({
            type: "data-codeDelta",
            data: code ?? "",
            transient: true,
          });

          draftContent = code;
        }
      }
    }

    await recordArtifactUsage(billing, result.usage);

    return draftContent;
  },
});
