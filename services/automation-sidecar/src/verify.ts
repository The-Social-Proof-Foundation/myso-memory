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
 *   - capabilities within the delegate's class (no social, spend or register, ever);
 *   - a spending limit set (and for a jury class, set to exactly zero);
 *   - an expiry set, and in the future (and within 90 days for any chain-acting class).
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
export const CAP_TASK_TRADE = 131072;
/** Serve on a jury: accept, commit, reveal, claim. Spends nothing. */
export const CAP_JURY = 262144;
/** The most a `memory` delegate may hold. Anything else on the key disqualifies it. */
export const DELEGATE_ALLOWED_CAPS = CAP_MEMORY_READ | CAP_MEMORY_WRITE | CAP_MYDATA_READ;

/**
 * A delegate's class fixes the most capability it may hold. `task_worker` adds only the task
 * market; `juror` adds only jury service. None can ever
 * carry posting, trading, spending or agent-management capability.
 */
export type DelegateClass = "memory" | "task_worker" | "juror";
export const DELEGATE_CLASS_CAPS: Readonly<Record<DelegateClass, number>> = Object.freeze({
    memory: DELEGATE_ALLOWED_CAPS,
    task_worker: DELEGATE_ALLOWED_CAPS | CAP_TASK_TRADE,
    juror: DELEGATE_ALLOWED_CAPS | CAP_JURY,
});

/** The classes that sign chain transactions; each must be short-lived. */
export function actsOnChain(delegateClass: DelegateClass): boolean {
    return delegateClass !== "memory";
}

/** A juror moves no funds, so its spending limit must be exactly zero. */
export function isZeroSpendClass(delegateClass: DelegateClass): boolean {
    return delegateClass === "juror";
}

/** A chain-acting delegate must expire within this window, so a leaked key has a short life. */
export const MAX_CHAIN_DELEGATE_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
/** @deprecated Use {@link MAX_CHAIN_DELEGATE_LIFETIME_MS}; the rule now covers every chain class. */
export const MAX_TASK_WORKER_LIFETIME_MS = MAX_CHAIN_DELEGATE_LIFETIME_MS;

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
    /** The address the delegate signs from; where its coins live. Absent on an old relayer. */
    derivedAddress?: string | null;
    /** The fullnode the relayer reads from. Absent on an old relayer. */
    rpcUrl?: string | null;
}

export interface VerifyTarget {
    seedHex: string;
    serverUrl: string;
    accountId: string;
    /** The agent object the stored key claims to be. */
    agentObjectId: string;
    /** Capability bits this operation needs. */
    needs: number;
    /** Defaults to `memory`. */
    delegateClass?: DelegateClass;
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
    target: Pick<VerifyTarget, "accountId" | "agentObjectId" | "needs" | "delegateClass">,
    nowMs: number,
): void {
    const delegateClass = target.delegateClass ?? "memory";
    if (normalizeObjectId(ctx.memoryAccountId) !== normalizeObjectId(target.accountId)) {
        refuse("the delegate is not registered under this account", "delegate_wrong_account");
    }
    if (normalizeObjectId(ctx.agentObjectId) !== normalizeObjectId(target.agentObjectId)) {
        refuse("the stored key is not the registered delegate", "delegate_mismatch");
    }
    if ((ctx.capabilities & ~DELEGATE_CLASS_CAPS[delegateClass]) !== 0) {
        refuse(
            {
                memory: "the delegate holds capabilities beyond memory read/write; register a narrower one",
                task_worker: "the delegate holds capabilities beyond memory and the task market; register a narrower one",
                juror: "the delegate holds capabilities beyond memory and jury service; register a narrower one",
            }[delegateClass],
            "delegate_overscoped",
        );
    }
    if ((ctx.capabilities & target.needs) !== target.needs) {
        refuse("the delegate lacks a capability this operation needs", "delegate_missing_capability");
    }
    if (ctx.maxActionSpendMist === null) {
        refuse("the delegate has no spending limit", "delegate_no_spend_limit");
    }
    if (isZeroSpendClass(delegateClass) && ctx.maxActionSpendMist !== 0) {
        refuse("a jury delegate must have a spending limit of exactly zero", "delegate_spend_not_zero");
    }
    if (ctx.expiresAtMs === null) {
        refuse("the delegate never expires; register one with an expiry", "delegate_no_expiry");
    }
    if (ctx.expiresAtMs <= nowMs) {
        refuse("the delegate has expired", "delegate_expired");
    }
    if (actsOnChain(delegateClass) && ctx.expiresAtMs - nowMs > MAX_CHAIN_DELEGATE_LIFETIME_MS) {
        refuse(
            "a delegate that signs chain transactions must expire within 90 days; register one with a nearer expiry",
            "delegate_expiry_too_far",
        );
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

    /**
     * What the chain says about a delegate, without judging it. For monitoring: an operator needs to
     * see a delegate approaching its expiry before it stops working, which `verify` would only
     * report once it was too late. A revoked or expired delegate still fails with `delegate_rejected`.
     */
    async inspect(target: Pick<VerifyTarget, "seedHex" | "serverUrl" | "accountId">): Promise<AgentContext> {
        return this.fetchContext(target as VerifyTarget);
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
            derivedAddress: typeof body.derivedAddress === "string" ? body.derivedAddress : null,
            rpcUrl: typeof body.rpcUrl === "string" ? body.rpcUrl : null,
        };
    }
}
