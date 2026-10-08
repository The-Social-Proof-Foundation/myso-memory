/**
 * Delegate key source.
 *
 * A delegate is a capability-scoped, expiring, revocable on-chain sub-agent the
 * account owner registered for unattended memory work. This module fetches its
 * encrypted key from the automation engine's database and opens it with the
 * bridge's MyData private key. The bridge never holds a user's root key or any of
 * their other agents' keys, only keys the owner chose to delegate.
 *
 * Nothing here caches a decrypted key: every request fetches and opens afresh,
 * so deleting a row takes effect immediately. The opened seed exists only as the
 * value handed to the memory client; it is never logged and never returned from
 * an API.
 */

import { BridgeError } from "./bridge-error.js";
import { normalizeObjectId } from "./ids.js";
import { DelegateCryptoError, MyDataKeyRing, delegateAad } from "./delegate-crypto.js";

/** `delegate:<name>` in a job's `target_agent_key_ref` selects this path. */
export const DELEGATE_REF_PREFIX = "delegate:";

export interface OpenedDelegate {
    /** 64 hex digits. Handle like a password: no logging, no serialization. */
    seedHex: string;
    /** The on-chain SubAgent object this key is registered as. */
    agentObjectId: string;
}

export interface DelegateSource {
    open(accountId: string, delegateRef: string): Promise<OpenedDelegate>;
}

interface EncryptedRow {
    agent_object_id: string;
    mydata_key_id: string;
    encrypted_key: string;
}

export interface EngineDelegateSourceOptions {
    engineUrl: string;
    secret: string;
    keyring: MyDataKeyRing;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}

export class EngineDelegateSource implements DelegateSource {
    private readonly fetchImpl: typeof fetch;

    constructor(private readonly opts: EngineDelegateSourceOptions) {
        this.fetchImpl = opts.fetchImpl ?? fetch;
    }

    async open(accountId: string, delegateRef: string): Promise<OpenedDelegate> {
        const row = await this.fetchEncryptedRow(accountId, delegateRef);
        let seed: Buffer;
        try {
            seed = this.opts.keyring.open(
                row.mydata_key_id,
                row.encrypted_key,
                delegateAad(accountId, delegateRef, row.agent_object_id),
            );
        } catch (err) {
            // Deliberately generic: not which step failed, not any bytes.
            if (err instanceof DelegateCryptoError) {
                throw new BridgeError(
                    "the stored delegate key cannot be opened; register the delegate again",
                    409,
                    "delegate_unreadable",
                );
            }
            throw err;
        }
        return { seedHex: seed.toString("hex"), agentObjectId: normalizeObjectId(row.agent_object_id) };
    }

    private async fetchEncryptedRow(accountId: string, delegateRef: string): Promise<EncryptedRow> {
        const url =
            `${this.opts.engineUrl.replace(/\/+$/, "")}/v1/automation/delegates/key` +
            `?account_id=${encodeURIComponent(accountId)}&delegate_ref=${encodeURIComponent(delegateRef)}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 5_000);
        let res: Response;
        try {
            res = await this.fetchImpl(url, {
                headers: { "x-internal-sync-secret": this.opts.secret },
                signal: controller.signal,
            });
        } catch {
            throw new BridgeError("delegate store unreachable", 502, "delegate_store_unavailable");
        } finally {
            clearTimeout(timer);
        }
        if (res.status === 404) {
            // Same shape as an unknown static ref: no probing for which names exist.
            throw new BridgeError(
                `unknown agent key ref ${JSON.stringify(DELEGATE_REF_PREFIX + delegateRef)}`,
                404,
                "key_store:unknown_ref",
            );
        }
        if (!res.ok) {
            throw new BridgeError(
                `delegate store returned ${res.status}`,
                502,
                "delegate_store_unavailable",
            );
        }
        const body = (await res.json().catch(() => null)) as Partial<EncryptedRow> | null;
        if (
            !body ||
            typeof body.agent_object_id !== "string" ||
            typeof body.mydata_key_id !== "string" ||
            typeof body.encrypted_key !== "string"
        ) {
            throw new BridgeError("delegate store returned a malformed row", 502, "delegate_store_unavailable");
        }
        return body as EncryptedRow;
    }
}
