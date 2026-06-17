/**
 * Config parsing, validation, and agent session resolution.
 *
 * Memory is scoped by the authenticated sub-agent (agent_object_id on-chain).
 * Namespace-based isolation is deprecated; optional subLabel tags within a vault.
 */

import { z } from "zod";
import type { PluginConfig } from "./types.js";

const ConfigSchema = z.object({
  privateKey: z.string()
    .min(1, "required")
    .regex(/^[0-9a-fA-F]{64}$/, "must be a 64-character hex string (sub-agent key)"),
  accountId: z.string()
    .min(1, "required")
    .regex(/^0x[0-9a-fA-F]{10,}$/, "must be a MySo object ID (0x...)"),
  serverUrl: z.string()
    .min(1, "required")
    .url("must be a valid URL"),
  platformId: z.string()
    .regex(/^0x[0-9a-fA-F]{10,}$/, "must be a MySo object ID (0x...)")
    .optional(),
  /** @deprecated Agent isolation is via sub-agent auth. Use subLabel for optional tags. */
  defaultNamespace: z.string().optional(),
  subLabel: z.string().optional(),
  autoRecall: z.boolean().default(true),
  autoCapture: z.boolean().default(true),
  maxRecallResults: z.number().min(1).max(20).default(5),
  minRelevance: z.number().min(0).max(1).default(0.3),
  captureMaxMessages: z.number().min(1).max(50).default(10),
  socialEnabled: z.boolean().default(false),
  ownerCoSignKey: z.string()
    .regex(/^[0-9a-fA-F]{64}$/, "must be a 64-character hex string")
    .optional(),
});

function resolveEnvVar(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => {
    const v = process.env[name];
    if (!v) throw new Error(`Environment variable ${name} is not set`);
    return v;
  });
}

function resolveEnvVars(raw: Record<string, unknown>): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    resolved[key] = typeof value === "string" ? resolveEnvVar(value) : value;
  }
  return resolved;
}

export function parseConfig(raw: unknown): PluginConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("memory: config is required");
  }

  const resolved = resolveEnvVars(raw as Record<string, unknown>);
  const result = ConfigSchema.safeParse(resolved);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`memory: invalid config:\n${issues}`);
  }

  const data = result.data;
  return {
    ...data,
    subLabel: data.subLabel ?? (data.defaultNamespace && data.defaultNamespace !== "default"
      ? data.defaultNamespace
      : undefined),
  };
}

export interface ResolvedAgent {
  subLabel?: string;
  agentName: string;
}

/**
 * Resolve optional sub-label from OpenClaw session key.
 * Primary isolation is the configured sub-agent credentials — not session name.
 */
export function resolveAgent(config: PluginConfig, sessionKey?: string): ResolvedAgent {
  if (!sessionKey) {
    return { subLabel: config.subLabel, agentName: "main" };
  }

  const match = sessionKey.match(/^agent:([^:]+):/);
  const name = match?.[1];

  if (!name || name === "main") {
    return { subLabel: config.subLabel, agentName: "main" };
  }

  // Per-agent sub-label when no global subLabel configured (legacy namespace mapping).
  return {
    subLabel: config.subLabel ?? name,
    agentName: name,
  };
}

export function keyPreview(key: string): string {
  return key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : "****";
}
