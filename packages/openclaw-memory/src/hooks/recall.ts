/**
 * Auto-recall hook — before_prompt_build.
 *
 * Searches Memory for memories relevant to the user's prompt and injects
 * them into the LLM context. Scope is automatic via sub-agent authentication.
 */

import type { Memory } from "@socialproof/memory";
import { resolveAgent } from "../config.js";
import { looksLikeInjection } from "../capture.js";
import { formatMemoriesForPrompt } from "../format.js";
import type { PluginConfig } from "../types.js";
import { MIN_PROMPT_LENGTH } from "../constants.js";

/** Register the before_prompt_build hook for auto-recall. */
export function registerRecallHook(api: any, client: Memory, config: PluginConfig): void {
  api.on("before_prompt_build", async (event: any, ctx: any) => {
    if (!event.prompt || event.prompt.length < MIN_PROMPT_LENGTH) return;

    const { subLabel, agentName } = resolveAgent(config, ctx?.sessionKey);

    try {
      const result = await client.recall(
        event.prompt,
        config.maxRecallResults,
        subLabel,
      );

      if (!result.results?.length) return;

      const relevant = result.results.filter(
        (r: any) =>
          (1 - r.distance) >= config.minRelevance &&
          !looksLikeInjection(r.text),
      );

      if (!relevant.length) return;

      api.logger.info(
        `memory: auto-recall injected ${relevant.length} memories (agent: ${agentName})`,
      );

      return {
        prependContext: formatMemoriesForPrompt(
          relevant.map((r: any) => ({ text: r.text })),
        ),
      };
    } catch (err) {
      api.logger.warn(`memory: auto-recall failed: ${String(err)}`);
    }
  });
}
