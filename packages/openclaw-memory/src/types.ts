/**
 * Shared types for the Memory OpenClaw plugin.
 */

export interface PluginConfig {
  /** Ed25519 sub-agent private key (hex). */
  privateKey: string;
  /** MemoryAccount object ID on MySo. */
  accountId: string;
  /** Memory server URL. */
  serverUrl: string;
  /** Platform object ID when sub-agent has platform_scope. */
  platformId?: string;
  /** @deprecated Use subLabel. Kept for config backward compatibility. */
  defaultNamespace?: string;
  /** Optional tag within the authenticated agent vault. */
  subLabel?: string;
  autoRecall: boolean;
  autoCapture: boolean;
  maxRecallResults: number;
  minRelevance: number;
  captureMaxMessages: number;
  /** Enable on-chain social feed tools (post, comment, react, repost). */
  socialEnabled?: boolean;
  /** Owner Ed25519 key for delete co-sign + chain tx (optional). */
  ownerCoSignKey?: string;
}
