/**
 * Per-request delegate verification.
 *
 * Before the bridge signs anything as a delegate it asks the memory relayer, as
 * that delegate, for the delegate's own context (`GET /api/agent/context`). The
 * relayer verifies the signing key against the on-chain `SubAgent` on every
 * call: a revoked, deactivated or expired delegate is refused there, so a
 * revocation takes effect on the next request with no cache to wait out. The
 * response is then checked here against what a delegate is allowed to be:
 *
 *   - registered under the account the job belongs to, as the agent we stored;
 *   - capabilities within memory read/write (no social, trade, spend, register);
 *   - a spending limit set;
 *   - an expiry set, and in the future.
 *
 * A delegate that fails any of these is refused even if the relayer would have
 * accepted it, so an over-scoped or never-expiring key is not usable by the
 * bridge no matter how it came to be registered.
 */

import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";

import { MEMORY_TYPESCRIPT_COMPATIBILITY_VERSION } from "@socialproof/memory";

import { BridgeError } from "./bridge-error.js";
import { normalizeObjectId } from "./ids.js";

export const CAP_MEMORY_READ = 1;
export const CAP_MEMORY_WRITE = 2;
export const CAP_MYDATA_READ = 4;
/** The most a delegate may hold. Anything else on the key disqualifies it. */
export const DELEGATE_ALLOWED_CAPS = CAP_MEMORY_READ | CAP_MEMORY_WRITE | CAP_MYDATA_READ;

/** Recall and remember both decrypt through MYDATA, so both need it. */
export const NEEDS_RECALL = CAP_MEMORY_READ | CAP_MYDATA_READ;
export const NEEDS_REMEMBER = CAP_MEMORY_WRITE | CAP_MYDATA_READ;

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface AgentContext {
    memoryAccountId: string;
    agentObjectId: string;
    capabilities: number;
    maxActionSpendMist: number | null;
    expiresAtMs: number | null;
}

export interface VerifyTarget {
    seedHex: string;
    serverUrl: string;
    accountId: string;
    /** The agent object the stored key claims to be. */
    agentObjectId: string;
    /** Capability bits this operation needs. */
    needs: number;
}

export interface DelegateVerifierOptions {
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    now?: () => number;
}

function refuse(message: string, code: string): never {
    throw new BridgeError(message, 403, code);
}

/** Pure policy check over a fetched context. Exported for tests. */
export function assertDelegateAllowed(
    ctx: AgentContext,
    target: Pick<VerifyTarget, "accountId" | "agentObjectId" | "needs">,
    nowMs: number,
): void {
    if (normalizeObjectId(ctx.memoryAccountId) !== normalizeObjectId(target.accountId)) {
        refuse("the delegate is not registered under this account", "delegate_wrong_account");
    }
    if (normalizeObjectId(ctx.agentObjectId) !== normalizeObjectId(target.agentObjectId)) {
        refuse("the stored key is not the registered delegate", "delegate_mismatch");
    }
    if ((ctx.capabilities & ~DELEGATE_ALLOWED_CAPS) !== 0) {
        refuse(
            "the delegate holds capabilities beyond memory read/write; register a narrower one",
            "delegate_overscoped",
        );
    }
    if ((ctx.capabilities & target.needs) !== target.needs) {
        refuse("the delegate lacks a capability this operation needs", "delegate_missing_capability");
    }
    if (ctx.maxActionSpendMist === null) {
        refuse("the delegate has no spending limit", "delegate_no_spend_limit");
    }
    if (ctx.expiresAtMs === null) {
        refuse("the delegate never expires; register one with an expiry", "delegate_no_expiry");
    }
    if (ctx.expiresAtMs <= nowMs) {
        refuse("the delegate has expired", "delegate_expired");
    }
}

export class DelegateVerifier {
    private readonly fetchImpl: typeof fetch;
    private readonly now: () => number;

    constructor(private readonly opts: DelegateVerifierOptions = {}) {
        this.fetchImpl = opts.fetchImpl ?? fetch;
        this.now = opts.now ?? Date.now;
    }

    async verify(target: VerifyTarget): Promise<AgentContext> {
        const ctx = await this.fetchContext(target);
        assertDelegateAllowed(ctx, target, this.now());
        return ctx;
    }

    private async fetchContext(target: VerifyTarget): Promise<AgentContext> {
        const path = "/api/agent/context";
        const privateKey = createPrivateKey({
            key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(target.seedHex, "hex")]),
            format: "der",
            type: "pkcs8",
        });
        const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
        const publicKeyHex = Buffer.from(spki.subarray(spki.length - 32)).toString("hex");

        const timestamp = Math.floor(this.now() / 1000).toString();
        const nonce = randomUUID();
        const bodyHash = createHash("sha256").update("").digest("hex");
        const message = `${timestamp}.GET.${path}.${bodyHash}.${nonce}.${target.accountId}`;
        const signature = sign(null, Buffer.from(message, "utf8"), privateKey).toString("hex");

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 10_000);
        let res: Response;
        try {
            res = await this.fetchImpl(`${target.serverUrl.replace(/\/+$/, "")}${path}`, {
                headers: {
                    "x-public-key": publicKeyHex,
                    "x-signature": signature,
                    "x-timestamp": timestamp,
                    "x-nonce": nonce,
                    "x-account-id": target.accountId,
                    "x-sdk-compatibility": MEMORY_TYPESCRIPT_COMPATIBILITY_VERSION,
                },
                signal: controller.signal,
            });
        } catch {
            throw new BridgeError("memory relayer unreachable", 502, "relayer_unavailable");
        } finally {
            clearTimeout(timer);
        }

        if (res.status === 401 || res.status === 403) {
            // Revoked, deactivated, expired or never registered: the relayer
            // refuses all of them identically, and none can be fixed by retrying.
            throw new BridgeError(
                "the delegate is revoked, expired, inactive or not registered",
                403,
                "delegate_rejected",
            );
        }
        if (!res.ok) {
            throw new BridgeError(`memory relayer returned ${res.status}`, 502, "relayer_unavailable");
        }
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (
            !body ||
            typeof body.memoryAccountId !== "string" ||
            typeof body.agentObjectId !== "string" ||
            typeof body.capabilities !== "number"
        ) {
            throw new BridgeError("memory relayer returned a malformed context", 502, "relayer_unavailable");
        }
        // `null` and "absent" both mean "none": an old relayer without
        // `expiresAtMs` therefore fails closed instead of passing.
        const nullableNumber = (v: unknown) => (typeof v === "number" ? v : null);
        return {
            memoryAccountId: body.memoryAccountId,
            agentObjectId: body.agentObjectId,
            capabilities: body.capabilities,
            maxActionSpendMist: nullableNumber(body.maxActionSpendMist),
            expiresAtMs: nullableNumber(body.expiresAtMs),
        };
    }
}
