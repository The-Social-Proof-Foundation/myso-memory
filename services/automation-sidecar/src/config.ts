/**
 * Configuration for the automation memory bridge.
 *
 * All values come from the environment so the bridge can run as a Railway
 * service, a docker-compose container, or a plain local process without code
 * changes. Nothing here is optional in a real deployment: the bridge refuses
 * to start without a shared secret, because an unauthenticated bridge is a
 * memory read/write proxy for every agent key it holds.
 */

/** Where agent keys are resolved from. */
export interface AgentKeySource {
    /** Directory + filename of the JSON key file. */
    file: string;
}

export interface SidecarConfig {
    host: string;
    port: number;
    /**
     * Shared secret required on every non-public route, sent as
     * `x-internal-sync-secret`.
     *
     * The rest of the stack already uses this header name but under two
     * different variable names — the memory relayer reads `INTERNAL_SYNC_SECRET`
     * while the automation engine reads `AUTOMATION_INTERNAL_SYNC_SECRET`. We
     * accept either, preferring `INTERNAL_SYNC_SECRET`, so a single value can be
     * shared across every service.
     */
    internalSyncSecret: string;
    /** Memory relayer origin used when a key entry does not pin its own. */
    defaultServerUrl?: string;
    /**
     * Namespace applied when a key entry does not pin its own.
     *
     * Defaults to `chat-app` so that memories written by a scheduled job are
     * recallable by the chat-app, which scopes its own recall to that same
     * namespace. This shared namespace is what makes the pairing observable —
     * change it only if you deliberately want the two clients isolated.
     */
    defaultNamespace: string;
    /** Per-request ceiling for a memory relayer round trip. */
    requestTimeoutMs: number;
    /** Cap on an inbound request body, so a bad caller cannot exhaust memory. */
    maxBodyBytes: number;
    /** Optional automation engine event sink (`POST /internal/automation/events`). */
    eventsUrl?: string;
    /** Secret used when posting to {@link eventsUrl}. Falls back to the shared secret. */
    eventsSecret?: string;
    /**
     * Path to the JSON agent key file.
     *
     * Exactly one of `agentKeysFile` / `agentKeysJson` is set. The file form is
     * for local development; the inline form is for platforms where mounting a
     * file is awkward.
     */
    agentKeysFile: string | null;
    /**
     * Inline agent key JSON (or base64 of it), read from
     * `AUTOMATION_AGENT_KEYS_JSON`.
     *
     * Preferred in a container: a Railway volume needs a mount path and
     * permissions, whereas a service variable is set once and is encrypted at
     * rest. Base64 is accepted because a dashboard's env-var field handles a
     * single long line far better than multi-line JSON.
     *
     * Whichever form is used, the value is a plaintext Ed25519 seed store. On a
     * hosted platform, dashboard access becomes a key-custody boundary.
     */
    agentKeysJson: string | null;
    /**
     * True outside production. Static keys are plaintext seeds, which is exactly
     * the custody this bridge must not have in a real deployment, so production
     * accepts only sealed, capability-scoped delegates.
     */
    allowStaticKeys: boolean;
    /** Automation engine origin, where sealed delegate keys are stored. */
    engineUrl?: string;
    /** `id:base64url` seal private keys. Present means delegates are enabled. */
    sealPrivateKeys?: string;
}

/** Value shipped in `.env.example`; public, so never valid in production. */
const PLACEHOLDER_SECRET = "dev-automation-secret";
const DEFAULT_PORT = 8011;
const DEFAULT_NAMESPACE = "chat-app";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

/** Default key-file location, resolved relative to this module. */
function defaultAgentKeysFile(): string {
    return new URL("../agents.json", import.meta.url).pathname;
}

type Env = Record<string, string | undefined>;

/** Read a non-blank trimmed string, treating blank as unset. */
function readString(env: Env, name: string): string | undefined {
    const raw = env[name];
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function readInt(env: Env, name: string, fallback: number): number {
    const raw = readString(env, name);
    if (raw === undefined) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
    }
    return parsed;
}

/**
 * Decode `AUTOMATION_AGENT_KEYS_JSON`, which may be raw JSON or base64 of it.
 *
 * A value that is neither is rejected here rather than at the first job, so a
 * misconfigured deploy fails its healthcheck instead of silently serving a
 * bridge that cannot resolve any agent.
 */
export function decodeInlineAgentKeys(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) return trimmed;

    // Not JSON, so it must be base64. `Buffer.from` is lenient and silently
    // drops invalid characters, so decode-then-reparse is the real validation.
    const decoded = Buffer.from(trimmed, "base64").toString("utf8").trim();
    if (!decoded.startsWith("{")) {
        throw new Error(
            "AUTOMATION_AGENT_KEYS_JSON must be agent-key JSON, or base64 of it " +
                `(decoded value starts with ${JSON.stringify(decoded.slice(0, 12))}, expected "{")`,
        );
    }
    return decoded;
}

/**
 * Resolve the shared secret from either variable name.
 *
 * Returns an empty string when neither is set so the caller can decide how
 * loudly to fail — {@link loadConfig} refuses to start, but tests import the
 * resolution rule directly.
 */
export function resolveInternalSyncSecret(
    env: Record<string, string | undefined> = process.env,
): string {
    const preferred = env.INTERNAL_SYNC_SECRET?.trim();
    if (preferred) return preferred;
    return env.AUTOMATION_INTERNAL_SYNC_SECRET?.trim() ?? "";
}

export function loadConfig(
    env: Record<string, string | undefined> = process.env,
): SidecarConfig {
    const internalSyncSecret = resolveInternalSyncSecret(env);

    if (!internalSyncSecret) {
        throw new Error(
            "Refusing to start: no shared secret. Set INTERNAL_SYNC_SECRET (preferred) or " +
                "AUTOMATION_INTERNAL_SYNC_SECRET to the same value the memory relayer and the " +
                "automation engine use for x-internal-sync-secret.",
        );
    }

    // The placeholder ships in .env.example and in the README, so it is public.
    // The Dockerfile sets NODE_ENV=production, which makes a copied example file
    // fail here rather than run a key-signing proxy behind a known password.
    if (internalSyncSecret === PLACEHOLDER_SECRET && env.NODE_ENV === "production") {
        throw new Error(
            "Refusing to start: INTERNAL_SYNC_SECRET is the public placeholder " +
                `"${PLACEHOLDER_SECRET}". Set a long random value shared with the engine ` +
                "and the memory relayer.",
        );
    }

    const production = env.NODE_ENV === "production";
    const sealPrivateKeys = readString(env, "AUTOMATION_SEAL_PRIVATE_KEYS");
    const eventsUrl = readString(env, "AUTOMATION_EVENTS_URL");
    const engineUrl = readString(env, "AUTOMATION_ENGINE_URL") ?? eventsUrl;
    const rawInlineKeys = readString(env, "AUTOMATION_AGENT_KEYS_JSON");
    const explicitKeysFile = readString(env, "AUTOMATION_AGENT_KEYS_FILE");

    if (production) {
        // A key file or variable is a store of plaintext agent seeds. In a
        // deployment that makes the operator a custodian, so it is refused
        // outright rather than warned about.
        if (rawInlineKeys || explicitKeysFile) {
            throw new Error(
                "Refusing to start: AUTOMATION_AGENT_KEYS_JSON / AUTOMATION_AGENT_KEYS_FILE " +
                    "hold plaintext agent seeds and are not allowed in production. Remove them; " +
                    "jobs use sealed delegate keys the account owner registers instead.",
            );
        }
        if (!sealPrivateKeys || !engineUrl || !readString(env, "MEMORY_SERVER_URL")) {
            throw new Error(
                "Refusing to start: production needs AUTOMATION_SEAL_PRIVATE_KEYS, " +
                    "AUTOMATION_ENGINE_URL and MEMORY_SERVER_URL to resolve delegate keys.",
            );
        }
    }

    // Inline JSON wins when both are set: an operator who has moved keys into a
    // service variable should not silently keep reading a stale file on disk.
    //
    // Decode here and carry the decoded JSON, not the raw value: validating one
    // form and handing the store another is how base64 input ends up parsed as
    // JSON at startup.
    const agentKeysJson = rawInlineKeys ? decodeInlineAgentKeys(rawInlineKeys) : null;
    const agentKeysFile = production
        ? null
        : agentKeysJson
          ? null
          : explicitKeysFile ?? defaultAgentKeysFile();

    return {
        // Loopback by default: this process signs with agent keys, so exposing it
        // to a network has to be a deliberate choice. A container must set
        // HOST=0.0.0.0, because most platforms do not set HOST and a
        // loopback-bound server never passes its own healthcheck.
        host: readString(env, "HOST") ?? "127.0.0.1",
        port: readInt(env, "PORT", DEFAULT_PORT),
        internalSyncSecret,
        defaultServerUrl: readString(env, "MEMORY_SERVER_URL"),
        defaultNamespace:
            readString(env, "AUTOMATION_DEFAULT_NAMESPACE") ?? DEFAULT_NAMESPACE,
        requestTimeoutMs: readInt(
            env,
            "AUTOMATION_REQUEST_TIMEOUT_MS",
            DEFAULT_REQUEST_TIMEOUT_MS,
        ),
        maxBodyBytes: readInt(env, "AUTOMATION_MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES),
        eventsUrl,
        eventsSecret: readString(env, "AUTOMATION_EVENTS_SECRET"),
        agentKeysFile,
        agentKeysJson,
        allowStaticKeys: !production,
        engineUrl,
        sealPrivateKeys,
    };
}
