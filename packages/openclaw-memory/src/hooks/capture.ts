/**
 * Auto-capture hook — agent_end.
 *
 * After the LLM finishes a turn, extracts conversation text and sends to
 * Memory's analyze() endpoint for server-side fact extraction.
 * Scope is automatic via sub-agent authentication.
 */

import type { Memory } from "@socialproof/memory";
import { resolveAgent } from "../config.js";
import { shouldCapture } from "../capture.js";
import { extractMessageTexts, withRetry } from "../format.js";
import type { PluginConfig } from "../types.js";

/** Register the agent_end hook for auto-capture. */
export function registerCaptureHook(api: any, client: Memory, config: PluginConfig): void {
  api.on("agent_end", async (event: any, ctx: any) => {
    if (!event.success || !event.messages?.length) return;

    const { subLabel, agentName } = resolveAgent(config, ctx?.sessionKey);

    try {
      const texts = extractMessageTexts(
        event.messages,
        config.captureMaxMessages,
      );

      if (!texts.length) return;

      const capturable = texts.filter((t) => shouldCapture(t));
      if (!capturable.length) {
        api.logger.debug?.(
          `memory: auto-capture skipped — no capturable content ` +
          `(agent: ${agentName}, ${texts.length} messages checked)`,
        );
        return;
      }

      const conversation = capturable
        .map((t, i) => `${i + 1}. ${t}`)
        .join("\n\n");

      const result = await withRetry(() => client.analyze(conversation, subLabel));

      if (result.facts?.length) {
        api.logger.info(
          `memory: auto-captured ${result.facts.length} facts (agent: ${agentName})`,
        );
      }
    } catch (err) {
      api.logger.warn(`memory: auto-capture failed: ${String(err)}`);
    }
  });
}
