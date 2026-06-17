/**
 * memory_store tool — explicit save (agent-scoped via sub-agent auth).
 */

import type { Memory } from "@socialproof/memory";
import { Type } from "@sinclair/typebox";
import { looksLikeInjection } from "../capture.js";
import { toolError } from "../format.js";
import type { PluginConfig } from "../types.js";
import { MIN_STORE_TEXT_LENGTH, MAX_FACT_PREVIEW_COUNT, MAX_TEXT_PREVIEW_LENGTH } from "../constants.js";

export function registerStoreTool(api: any, client: Memory, config: PluginConfig): void {
  api.registerTool(
    {
      name: "memory_store",
      label: "Memory Store",
      description:
        "Save important information to encrypted long-term memory. " +
        "Use when the user asks to remember something or when you " +
        "identify important facts worth preserving. Scope is automatic via sub-agent auth.",
      parameters: Type.Object({
        text: Type.String({
          description: "Information to store in memory",
        }),
        subLabel: Type.Optional(
          Type.String({
            description: "Optional tag within the agent vault (advanced)",
          }),
        ),
      }),
      async execute(_id: string, params: any) {
        const { text, subLabel } = params;
        const label = subLabel ?? config.subLabel;

        if (looksLikeInjection(text)) {
          return {
            content: [
              {
                type: "text",
                text: "Cannot store text containing disallowed patterns.",
              },
            ],
            details: { error: "injection_rejected" },
          };
        }

        if (!text || text.trim().length < MIN_STORE_TEXT_LENGTH) {
          return {
            content: [
              {
                type: "text",
                text: "Cannot store empty or very short text.",
              },
            ],
            details: { error: "text_too_short" },
          };
        }

        try {
          const result = await client.analyze(text.trim(), label);

          const factCount = result.facts?.length ?? 0;
          const preview = result.facts
            ?.map((f: any) => f.text)
            .slice(0, MAX_FACT_PREVIEW_COUNT)
            .join("; ") ?? text.slice(0, MAX_TEXT_PREVIEW_LENGTH);

          return {
            content: [
              {
                type: "text",
                text: factCount > 0
                  ? `Stored ${factCount} fact${factCount === 1 ? "" : "s"}: ${preview}`
                  : `No memorable facts extracted from the input.`,
              },
            ],
            details: {
              action: "created",
              factCount,
              facts: result.facts,
            },
          };
        } catch (err) {
          return toolError("Failed to store memory", err);
        }
      },
    },
    { name: "memory_store" },
  );
}
