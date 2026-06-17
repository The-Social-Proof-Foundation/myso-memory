/**
 * OpenClaw Memory Plugin — Memory
 *
 * Encrypted, decentralized long-term memory via Memory + File Storage.
 *
 * Components:
 *   hooks/     — before_prompt_build (auto-recall), agent_end (auto-capture)
 *   tools/     — memory_search, memory_store
 *   cli/       — openclaw memory search/stats
 *   config.ts  — Config parsing, namespace resolution
 *   format.ts  — Memory formatting, tag injection/stripping, prompt safety
 *   capture.ts — Capture filtering, injection detection
 *   types.ts   — Shared TypeScript types
 *
 * Per-agent isolation via namespaces:
 *   Each OpenClaw agent gets its own namespace derived from ctx.sessionKey.
 *   Same key, same account — isolation scoped at the server level.
 */

import { Memory } from "@socialproof/memory";
import { SocialClient } from "@socialproof/social";
import { parseConfig, keyPreview } from "./config.js";
import { registerHooks } from "./hooks/index.js";
import { registerTools, registerSocialTools } from "./tools/index.js";
import { registerCli } from "./cli/index.js";

export default {
  id: "memory",
  name: "Memory (Memory)",
  description: "Encrypted, decentralized long-term memory via Memory + File Storage",
  kind: "memory" as const,

  /** Initialize Memory client and register all plugin components. */
  register(api: any) {
    const config = parseConfig(api.pluginConfig);

    const client = Memory.create({
      key: config.privateKey,
      accountId: config.accountId,
      serverUrl: config.serverUrl,
      platformId: config.platformId,
      subLabel: config.subLabel,
    });

    api.logger.info(
      `memory: registered (server: ${config.serverUrl}, ` +
      `key: ${keyPreview(config.privateKey)})`,
    );

    registerHooks(api, client, config);
    registerTools(api, client, config);

    if (config.socialEnabled) {
      if (!config.platformId) {
        api.logger.warn(
          "memory: social.enabled is true but platformId is missing — social tools need x-platform-id",
        );
      }
      const social = SocialClient.create({
        key: config.privateKey,
        accountId: config.accountId,
        serverUrl: config.serverUrl,
        platformId: config.platformId,
        ownerCoSignKey: config.ownerCoSignKey,
      });
      registerSocialTools(api, social, config);
      api.logger.info("memory: social feed tools registered");
    }

    registerCli(api, client, config);

    // Health check service
    api.registerService({
      id: "memory",
      async start() {
        try {
          const health = await client.health();
          api.logger.info(
            `memory: connected (status: ${health.status}, version: ${health.version})`,
          );
        } catch (err) {
          api.logger.warn(
            `memory: health check failed: ${String(err)}`,
          );
        }
      },
      stop() {
        api.logger.info("memory: stopped");
      },
    });
  },
};
