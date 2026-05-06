/**
 * CLI commands — openclaw memory <command>
 *
 * Agent scoping via --agent flag → namespace.
 */

import type { Memory } from "@socialproof/memory";
import { registerSearchCommand } from "./search.js";
import { registerStatsCommand } from "./stats.js";
import type { PluginConfig } from "../types.js";

/** Register `openclaw memory` CLI commands. */
export function registerCli(api: any, client: Memory, config: PluginConfig): void {
  api.registerCli(
    ({ program }: any) => {
      const cmd = program
        .command("memory")
        .description("Memory memory plugin commands");

      registerSearchCommand(cmd, client, config);
      registerStatsCommand(cmd, client, config);
    },
    { commands: ["memory"] },
  );
}
