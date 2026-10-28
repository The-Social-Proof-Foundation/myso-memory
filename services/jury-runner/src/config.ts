/**
 * Runner configuration. Everything comes from the environment. A real deployment refuses to start
 * with a short secret, because the webhook secret is the only thing that stops anyone on the
 * internet from asking the runner to commit a vote, and the salt secret is the only thing that
 * keeps a sealed vote from being guessed.
 */

import {
    DEFAULT_WARN_WITHIN_MS,
    parseMonitoredDelegates,
    type DelegateMonitorConfig,
} from "./delegate-monitor.js";
import type { ReconcilerConfig } from "./reconciler.js";

export interface RunnerConfig {
    host: string;
    port: number;
    /** Shared with each job's `secret`; signs every webhook from the engine. */
    webhookSecret: string;
    /** Derives each vote's salt. Separate from the webhook secret on purpose. */
    saltSecret: string;
    /** Social server origin: cases, tasks, proposals. Public data. */
    socialServerUrl: string;
    inference: InferenceConfig;
    storePath: string;
    /** Hosts evidence may be fetched from. Empty means any public host. */
    evidenceAllowedHosts: string[];
    /** Where `ipfs://` evidence is fetched from. */
    ipfsGateway: string;
    maxBodyBytes: number;
    /**
     * Publishing each revealed vote's reason to the social server, so it outlives this runner.
     * `null` when `INTERNAL_SYNC_SECRET` is not set, in which case rationales stay on the runner.
     */
    rationalePublisher: { secret: string; intervalMs: number } | null;
    /** Bearer token for `GET /metrics`. `null` leaves the route off. */
    metricsToken: string | null;
    /** Bearer token for the verified case bundle read used by the MySo Agents juror UI. */
    bundleReadToken: string | null;
    /** Watches delegates for expiry; `null` unless `MONITOR_DELEGATES` names some. */
    delegateMonitor: DelegateMonitorConfig | null;
    /** The crank recovery loop; `null` unless `RECONCILER_ENABLED` is set. */
    reconciler: ReconcilerConfig | null;
    production: boolean;
}

/**
 * Where a juror's thinking comes from. `openai`: the operator's own OpenAI-compatible provider.
 * `gateway`: billed to an inference agent's AI-credit balance through the relayer, which reserves
 * the funds on chain before it calls the model.
 */
export type InferenceConfig =
    | {
          kind: "openai";
          /** OpenAI-compatible base URL, e.g. `https://api.example.com/v1`. */
          url: string;
          apiKey: string;
          model: string;
          timeoutMs: number;
      }
    | {
          kind: "gateway";
          /** The relayer's origin. */
          serverUrl: string;
          /** The inference agent's Ed25519 seed (hex). It needs the AI-spend capability and never votes. */
          agentKey: string;
          /** The inference agent's MemoryAccount. */
          accountId: string;
          modelId: string;
          maxTokens: number;
      };

export class ConfigError extends Error {}

function required(env: Record<string, string | undefined>, name: string): string {
    const value = env[name]?.trim();
    if (!value) throw new ConfigError(`${name} must be set`);
    return value;
}

function positiveInt(env: Record<string, string | undefined>, name: string, fallback: number): number {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) throw new ConfigError(`${name} must be a positive integer`);
    return value;
}

function loadInference(env: Record<string, string | undefined>, production: boolean): InferenceConfig {
    const provider = (env.INFERENCE_PROVIDER?.trim() || "openai").toLowerCase();
    if (provider === "gateway") {
        const serverUrl = required(env, "GATEWAY_SERVER_URL").replace(/\/+$/, "");
        if (production && !serverUrl.startsWith("https://")) {
            throw new ConfigError("GATEWAY_SERVER_URL must be https in production");
        }
        const agentKey = required(env, "GATEWAY_AGENT_KEY").replace(/^0x/, "");
        if (!/^[0-9a-fA-F]{64}$/.test(agentKey)) {
            throw new ConfigError("GATEWAY_AGENT_KEY must be a 32-byte hex seed");
        }
        return {
            kind: "gateway",
            serverUrl,
            agentKey,
            accountId: required(env, "GATEWAY_ACCOUNT_ID"),
            modelId: required(env, "GATEWAY_MODEL_ID"),
            maxTokens: positiveInt(env, "GATEWAY_MAX_TOKENS", 2048),
        };
    }
    if (provider !== "openai") throw new ConfigError('INFERENCE_PROVIDER must be "openai" or "gateway"');
    const url = required(env, "INFERENCE_URL").replace(/\/+$/, "");
    if (production && !url.startsWith("https://")) {
        throw new ConfigError("INFERENCE_URL must be https in production");
    }
    return {
        kind: "openai",
        url,
        apiKey: required(env, "INFERENCE_API_KEY"),
        model: required(env, "INFERENCE_MODEL"),
        timeoutMs: positiveInt(env, "INFERENCE_TIMEOUT_MS", 120_000),
    };
}

function loadDelegateMonitor(env: Record<string, string | undefined>, production: boolean): DelegateMonitorConfig {
    const bridgeUrl = required(env, "BRIDGE_URL").replace(/\/+$/, "");
    if (production && !bridgeUrl.startsWith("https://")) throw new ConfigError("BRIDGE_URL must be https in production");
    let delegates;
    try {
        delegates = parseMonitoredDelegates(required(env, "MONITOR_DELEGATES"));
    } catch (error) {
        throw new ConfigError((error as Error).message);
    }
    return {
        bridgeUrl,
        bridgeSecret: required(env, "BRIDGE_SECRET"),
        delegates,
        intervalMs: positiveInt(env, "MONITOR_INTERVAL_MS", 10 * 60_000),
        warnWithinMs: positiveInt(env, "MONITOR_WARN_DAYS", DEFAULT_WARN_WITHIN_MS / 86_400_000) * 86_400_000,
    };
}

function loadReconciler(env: Record<string, string | undefined>, production: boolean): ReconcilerConfig {
    const bridgeUrl = required(env, "BRIDGE_URL").replace(/\/+$/, "");
    if (production && !bridgeUrl.startsWith("https://")) throw new ConfigError("BRIDGE_URL must be https in production");
    return {
        bridgeUrl,
        bridgeSecret: required(env, "BRIDGE_SECRET"),
        operatorAccountId: required(env, "JURY_CRANK_OPERATOR_ID"),
        intervalMs: positiveInt(env, "RECONCILER_INTERVAL_MS", 60_000),
        graceMs: positiveInt(env, "RECONCILER_GRACE_MS", 15 * 60_000),
        batch: positiveInt(env, "RECONCILER_BATCH", 20),
    };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): RunnerConfig {
    const production = env.NODE_ENV === "production";
    const webhookSecret = required(env, "JUROR_WEBHOOK_SECRET");
    const saltSecret = required(env, "JUROR_SALT_SECRET");
    if (webhookSecret.length < 16) throw new ConfigError("JUROR_WEBHOOK_SECRET must be at least 16 characters");
    if (saltSecret.length < 32) throw new ConfigError("JUROR_SALT_SECRET must be at least 32 characters");
    if (saltSecret === webhookSecret) {
        throw new ConfigError("JUROR_SALT_SECRET must differ from JUROR_WEBHOOK_SECRET");
    }
    const socialServerUrl = required(env, "SOCIAL_SERVER_URL").replace(/\/+$/, "");
    if (production && !socialServerUrl.startsWith("https://")) {
        throw new ConfigError("SOCIAL_SERVER_URL must be https in production");
    }
    const inference = loadInference(env, production);
    const metricsToken = env.METRICS_TOKEN?.trim() || null;
    if (metricsToken !== null && metricsToken.length < 16) {
        throw new ConfigError("METRICS_TOKEN must be at least 16 characters");
    }
    const bundleReadToken = env.BUNDLE_READ_TOKEN?.trim() || null;
    if (bundleReadToken !== null && bundleReadToken.length < 32) {
        throw new ConfigError("BUNDLE_READ_TOKEN must be at least 32 characters");
    }
    const delegateMonitor = env.MONITOR_DELEGATES?.trim() ? loadDelegateMonitor(env, production) : null;
    const reconciler = ["1", "true", "yes", "on"].includes((env.RECONCILER_ENABLED ?? "").trim().toLowerCase())
        ? loadReconciler(env, production)
        : null;
    return {
        host: env.HOST?.trim() || "0.0.0.0",
        port: positiveInt(env, "PORT", 8012),
        webhookSecret,
        saltSecret,
        socialServerUrl,
        inference,
        storePath: env.STORE_PATH?.trim() || "./data/judgments.json",
        evidenceAllowedHosts: (env.EVIDENCE_ALLOWED_HOSTS ?? "")
            .split(",")
            .map((host) => host.trim().toLowerCase())
            .filter(Boolean),
        ipfsGateway: (env.IPFS_GATEWAY?.trim() || "https://ipfs.io/ipfs/").replace(/\/*$/, "/"),
        maxBodyBytes: positiveInt(env, "MAX_BODY_BYTES", 256 * 1024),
        rationalePublisher: env.INTERNAL_SYNC_SECRET?.trim()
            ? {
                  secret: env.INTERNAL_SYNC_SECRET.trim(),
                  intervalMs: positiveInt(env, "RATIONALE_PUBLISH_INTERVAL_MS", 60_000),
              }
            : null,
        metricsToken,
        bundleReadToken,
        delegateMonitor,
        reconciler,
        production,
    };
}
