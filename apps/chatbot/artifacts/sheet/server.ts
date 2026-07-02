import { streamObject } from "ai";
import { z } from "zod";
import { ARTIFACT_MODEL_ID } from "@/lib/ai/catalog";
import { recordChatInferenceUsage } from "@/lib/ai/record-inference-usage";
import { sheetPrompt, updateDocumentPrompt } from "@/lib/ai/prompts";
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

export const sheetDocumentHandler = createDocumentHandler<"sheet">({
  kind: "sheet",
  onCreateDocument: async ({ title, dataStream, billing }) => {
    let draftContent = "";

    const result = streamObject({
      model: getArtifactModel(),
      system: sheetPrompt,
      prompt: title,
      schema: z.object({
        csv: z.string().describe("CSV data"),
      }),
    });

    for await (const delta of result.fullStream) {
      const { type } = delta;

      if (type === "object") {
        const { object } = delta;
        const { csv } = object;

        if (csv) {
          dataStream.write({
            type: "data-sheetDelta",
            data: csv,
            transient: true,
          });

          draftContent = csv;
        }
      }
    }

    dataStream.write({
      type: "data-sheetDelta",
      data: draftContent,
      transient: true,
    });

    await recordArtifactUsage(billing, result.usage);

    return draftContent;
  },
  onUpdateDocument: async ({ document, description, dataStream, billing }) => {
    let draftContent = "";

    const result = streamObject({
      model: getArtifactModel(),
      system: updateDocumentPrompt(document.content, "sheet"),
      prompt: description,
      schema: z.object({
        csv: z.string(),
      }),
    });

    for await (const delta of result.fullStream) {
      const { type } = delta;

      if (type === "object") {
        const { object } = delta;
        const { csv } = object;

        if (csv) {
          dataStream.write({
            type: "data-sheetDelta",
            data: csv,
            transient: true,
          });

          draftContent = csv;
        }
      }
    }

    await recordArtifactUsage(billing, result.usage);

    return draftContent;
  },
});
