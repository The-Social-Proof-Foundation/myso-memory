/**
 * CLI command — openclaw memory stats
 */

import type { Memory } from "@socialproof/memory";
import { resolveAgent, keyPreview } from "../config.js";
import type { PluginConfig } from "../types.js";

export function registerStatsCommand(cmd: any, client: Memory, config: PluginConfig): void {
  cmd
    .command("stats")
    .description("Show memory status")
    .option("--agent <name>", "Show stats for a specific agent session sub-label")
    .action(async (opts: any) => {
      const { subLabel, agentName } = resolveAgent(
        config,
        opts.agent ? `agent:${opts.agent}:cli` : undefined,
      );

      try {
        const health = await client.health();

        console.log(`Server:      ${config.serverUrl}`);
        console.log(`Status:      ${health.status}`);
        console.log(`Version:     ${health.version}`);
        console.log(`Key:         ${keyPreview(config.privateKey)}`);
        console.log(`Account:     ${config.accountId.slice(0, 10)}...`);
        console.log(`Agent:       ${agentName}`);
        if (subLabel) console.log(`Sub-label:   ${subLabel}`);
        if (config.platformId) console.log(`Platform:    ${config.platformId}`);
        console.log(`Auto-recall:   ${config.autoRecall}`);
        console.log(`Auto-capture:  ${config.autoCapture}`);
      } catch (err) {
        console.error(`Stats failed: ${String(err)}`);
      }
    });
}
