/**
 * memory_search tool — semantic recall (agent-scoped via sub-agent auth).
 */

import type { Memory } from "@socialproof/memory";
import { Type } from "@sinclair/typebox";
import { looksLikeInjection } from "../capture.js";
import { escapeForPrompt, toolError } from "../format.js";
import type { PluginConfig } from "../types.js";
import { DEFAULT_SEARCH_LIMIT } from "../constants.js";

export function registerSearchTool(api: any, client: Memory, config: PluginConfig): void {
  api.registerTool(
    {
      name: "memory_search",
      label: "Memory Search",
      description:
        "Search long-term memory for relevant past information, facts, " +
        "preferences, and decisions. Returns memories ranked by relevance. " +
        "Scope is automatic via the configured sub-agent.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
        limit: Type.Optional(
          Type.Number({ description: "Max results (default: 5)" }),
        ),
        subLabel: Type.Optional(
          Type.String({
            description: "Optional tag within the agent vault (advanced)",
          }),
        ),
      }),
      async execute(_id: string, params: any) {
        const { query, limit = DEFAULT_SEARCH_LIMIT, subLabel } = params;
        const label = subLabel ?? config.subLabel;

        try {
          const result = await client.recall(query, limit, label);

          if (!result.results?.length) {
            return {
              content: [{ type: "text", text: "No relevant memories found." }],
              details: { count: 0 },
            };
          }

          const safe = result.results.filter(
            (r: any) => !looksLikeInjection(r.text),
          );

          if (!safe.length) {
            return {
              content: [{ type: "text", text: "No relevant memories found." }],
              details: { count: 0 },
            };
          }

          const formatted = safe
            .map((r: any, i: number) => {
              const relevance = Math.round((1 - r.distance) * 100);
              return `${i + 1}. ${escapeForPrompt(r.text)} (${relevance}% relevance)`;
            })
            .join("\n");

          return {
            content: [
              {
                type: "text",
                text: `Found ${safe.length} memories:\n\n${formatted}`,
              },
            ],
            details: {
              count: safe.length,
              memories: safe.map((r: any) => ({
                text: r.text,
                blob_id: r.blob_id,
                relevance: Math.round((1 - r.distance) * 100) / 100,
              })),
            },
          };
        } catch (err) {
          return toolError("Memory search failed", err);
        }
      },
    },
    { name: "memory_search" },
  );
}
