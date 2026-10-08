/**
 * Agent key resolution for the automation memory bridge.
 *
 * A job carries only a `target_agent_key_ref` string. The bridge turns that
 * reference into the three fields the headless memory client actually needs —
 * key, account id, server URL — and never hands the key material back to the
 * caller. The automation engine therefore stays free of key custody, which is
 * the split the chat-app documents for headless agents.
 *
 * This file-backed store is a development and single-tenant-deployment
 * primitive. A production deployment replaces it with a real custody vault
 * (passkeys, KMS, or the relayer's own agent-key backup tiers) behind the same
 * `AgentKeyStore` interface.
 */

import { readFileSync, statSync } from "node:fs";

/** A single resolvable agent identity. */
export interface AgentKeyEntry {
    /** Ed25519 seed as 64 hex digits (a leading `0x` is accepted). Never logged. */
    key: string;
    /** `MemoryAccount` object id the agent is registered under. */
    accountId: string;
    /** Memory relayer origin. Falls back to the config default. */
    serverUrl?: string;
    /** Namespace scoping recall and writes. Falls back to the config default. */
    namespace?: string;
    /** Platform object id, sent when the sub-agent has `platform_scope`. */
    platformId?: string;
}

/** How a key resolved, with every optional field made concrete. */
export interface ResolvedAgentKey extends AgentKeyEntry {
    serverUrl: string;
    namespace: string;
}

export class KeyStoreError extends Error {
    constructor(
        message: string,
        readonly code:
            | "file_missing"
            | "file_invalid"
            | "unknown_ref"
            | "invalid_entry"
            | "no_server_url",
    ) {
        super(message);
        this.name = "KeyStoreError";
    }
}

const HEX_SEED_BYTES = 32;
const HEX_SEED_DIGITS = HEX_SEED_BYTES * 2;

/**
 * Normalize and validate an Ed25519 seed.
 *
 * Matches the chat-app's `createHeadlessAgentMemoryClient`, which rejects
 * anything that is not a 32-byte seed — so a key that works here works there.
 */
export function normalizeSeed(raw: unknown, where: string): string {
    if (typeof raw !== "string") {
        throw new KeyStoreError(`${where}: "key" must be a hex string`, "invalid_entry");
    }
    const clean = raw.trim().replace(/^0x/i, "");
    if (clean.length !== HEX_SEED_DIGITS) {
        throw new KeyStoreError(
            `${where}: "key" must be a ${HEX_SEED_BYTES}-byte Ed25519 seed ` +
                `(${HEX_SEED_DIGITS} hex digits), got ${clean.length} digits`,
            "invalid_entry",
        );
    }
    if (!/^[0-9a-fA-F]+$/.test(clean)) {
        throw new KeyStoreError(`${where}: "key" contains non-hex characters`, "invalid_entry");
    }
    return clean.toLowerCase();
}

/** Parse and validate the whole key file. Exported for tests. */
export function parseAgentKeyFile(
    raw: string,
    sourceLabel: string,
): Map<string, AgentKeyEntry> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new KeyStoreError(
            `${sourceLabel}: not valid JSON (${(err as Error).message})`,
            "file_invalid",
        );
    }

    const agents =
        parsed && typeof parsed === "object" && "agents" in (parsed as Record<string, unknown>)
            ? (parsed as { agents: unknown }).agents
            : parsed;

    if (!agents || typeof agents !== "object" || Array.isArray(agents)) {
        throw new KeyStoreError(
            `${sourceLabel}: expected an object mapping key_ref to agent entries` +
                ` (optionally wrapped as {"agents": {...}})`,
            "file_invalid",
        );
    }

    const out = new Map<string, AgentKeyEntry>();
    for (const [ref, value] of Object.entries(agents as Record<string, unknown>)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new KeyStoreError(`${sourceLabel}: entry "${ref}" must be an object`, "invalid_entry");
        }
        const entry = value as Record<string, unknown>;
        if (typeof entry.accountId !== "string" || entry.accountId.trim().length === 0) {
            throw new KeyStoreError(
                `${sourceLabel}: entry "${ref}" is missing "accountId"`,
                "invalid_entry",
            );
        }
        out.set(ref, {
            key: normalizeSeed(entry.key, `${sourceLabel}: entry "${ref}"`),
            accountId: entry.accountId.trim(),
            serverUrl:
                typeof entry.serverUrl === "string" && entry.serverUrl.trim().length > 0
                    ? entry.serverUrl.trim()
                    : undefined,
            namespace:
                typeof entry.namespace === "string" && entry.namespace.trim().length > 0
                    ? entry.namespace.trim()
                    : undefined,
            platformId:
                typeof entry.platformId === "string" && entry.platformId.trim().length > 0
                    ? entry.platformId.trim()
                    : undefined,
        });
    }

    if (out.size === 0) {
        throw new KeyStoreError(`${sourceLabel}: contains no agent entries`, "file_invalid");
    }
    return out;
}

export interface AgentKeyStoreOptions {
    /** Path to the JSON key file. Mutually exclusive with `inlineJson`. */
    file?: string | null;
    /**
     * The key JSON itself, already decoded. Mutually exclusive with `file`.
     *
     * Used when keys come from a service variable rather than a mounted file.
     * There is nothing to re-read, so the mtime check is skipped.
     */
    inlineJson?: string | null;
    defaultServerUrl?: string;
    defaultNamespace: string;
}

/**
 * JSON key source: either a file re-read when its mtime changes, or an inline
 * value fixed for the process lifetime.
 *
 * File reloading keeps local development honest — registering a new agent does
 * not require a restart, and a malformed edit surfaces as a request error rather
 * than as a stale-but-working process. Inline values cannot change without a
 * redeploy, which is the point of putting them in a service variable.
 */
export class AgentKeyStore {
    private entries = new Map<string, AgentKeyEntry>();
    private loadedMtimeMs = -1;

    constructor(private readonly opts: AgentKeyStoreOptions) {
        if (!opts.inlineJson && !opts.file) {
            throw new KeyStoreError(
                "no agent key source: set AUTOMATION_AGENT_KEYS_JSON (inline) or " +
                    "AUTOMATION_AGENT_KEYS_FILE (path)",
                "file_missing",
            );
        }
    }

    /** True when keys came from a service variable rather than a file. */
    get isInline(): boolean {
        return Boolean(this.opts.inlineJson);
    }

    /** Force a fresh read. */
    reload(): void {
        if (this.opts.inlineJson) {
            this.entries = parseAgentKeyFile(
                this.opts.inlineJson,
                "AUTOMATION_AGENT_KEYS_JSON",
            );
            return;
        }

        const file = this.opts.file as string;
        let raw: string;
        let mtimeMs: number;
        try {
            const stat = statSync(file);
            mtimeMs = stat.mtimeMs;
            raw = readFileSync(file, "utf8");
        } catch (err) {
            throw new KeyStoreError(
                `cannot read agent key file ${file}: ${(err as Error).message}`,
                "file_missing",
            );
        }
        this.entries = parseAgentKeyFile(raw, file);
        this.loadedMtimeMs = mtimeMs;
    }

    private ensureFresh(): void {
        // An inline value cannot change underneath us.
        if (this.opts.inlineJson) return;

        const file = this.opts.file as string;
        let mtimeMs: number;
        try {
            mtimeMs = statSync(file).mtimeMs;
        } catch (err) {
            throw new KeyStoreError(
                `cannot read agent key file ${file}: ${(err as Error).message}`,
                "file_missing",
            );
        }
        if (mtimeMs !== this.loadedMtimeMs) {
            this.reload();
        }
    }

    /** Number of registered refs. Triggers a freshness check. */
    size(): number {
        this.ensureFresh();
        return this.entries.size;
    }

    /** Registered refs only — never key material. */
    listRefs(): string[] {
        this.ensureFresh();
        return [...this.entries.keys()].sort();
    }

    /** Resolve a `target_agent_key_ref` into concrete connection fields. */
    resolve(keyRef: string): ResolvedAgentKey {
        this.ensureFresh();
        const entry = this.entries.get(keyRef);
        if (!entry) {
            // Deliberately does not list the registered refs. This message is
            // stored on the run row and the relayer proxy returns run history to
            // the job's owner, so enumerating refs here would hand any tenant the
            // names of every other tenant's agents.
            throw new KeyStoreError(
                `unknown agent key ref ${JSON.stringify(keyRef)}`,
                "unknown_ref",
            );
        }
        const serverUrl = entry.serverUrl ?? this.opts.defaultServerUrl;
        if (!serverUrl) {
            throw new KeyStoreError(
                `agent key ref ${JSON.stringify(keyRef)} has no serverUrl and MEMORY_SERVER_URL is unset`,
                "no_server_url",
            );
        }
        return {
            ...entry,
            serverUrl,
            namespace: entry.namespace ?? this.opts.defaultNamespace,
        };
    }
}
