/**
 * Bridge behaviour tests.
 *
 * `createClient` is injected so these exercise the mapping layer — response
 * shaping, error classification, event emission, client reuse — without a live
 * MySo fullnode. The SDK's own `buildMyDataSession()` creates an on-chain
 * SessionKey, so a real round trip needs localnet + MYDATA key servers and
 * cannot run in a unit test.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BridgeError, MemoryBridge, normalizeObjectId } from "./bridge.js";
import type { AgentKeyEntry, AgentKeyStore, ResolvedAgentKey } from "./keys.js";

const SERVER_URL = "http://127.0.0.1:8000";

/** Minimal store double: resolves one ref, throws for anything else. */
function fakeStore(entry?: Partial<AgentKeyEntry>): AgentKeyStore & { rotate(key: string): void } {
    const resolved: ResolvedAgentKey = {
        key: "a".repeat(64),
        accountId: "0xacct",
        serverUrl: SERVER_URL,
        namespace: "chat-app",
        ...entry,
    };
    return {
        rotate(key: string) {
            resolved.key = key;
        },
        resolve(keyRef: string) {
            if (keyRef !== "agent-a") {
                throw new Error(`unknown agent key ref ${keyRef}`);
            }
            return { ...resolved };
        },
        size: () => 1,
        listRefs: () => ["agent-a"],
    } as unknown as AgentKeyStore & { rotate(key: string): void };
}

interface FakeClientOptions {
    recall?: (query: string, opts: unknown) => Promise<unknown>;
    remember?: (text: string, opts: unknown) => Promise<unknown>;
    rememberAndWait?: (text: string, subLabel: string, opts: unknown) => Promise<unknown>;
    health?: () => Promise<unknown>;
}

/** Build a bridge over a fake SDK client, recording every call. */
function bridgeWith(client: FakeClientOptions, options: { eventsUrl?: string; fetchImpl?: typeof fetch } = {}) {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    let created = 0;
    let destroyed = 0;

    const fake = {
        recall: async (query: string, opts: unknown) => {
            calls.push({ method: "recall", args: [query, opts] });
            return client.recall
                ? client.recall(query, opts)
                : { results: [], total: 0 };
        },
        remember: async (text: string, opts: unknown) => {
            calls.push({ method: "remember", args: [text, opts] });
            return client.remember
                ? client.remember(text, opts)
                : { job_id: "job-1", status: "queued" };
        },
        rememberAndWait: async (text: string, subLabel: string, opts: unknown) => {
            calls.push({ method: "rememberAndWait", args: [text, subLabel, opts] });
            return client.rememberAndWait
                ? client.rememberAndWait(text, subLabel, opts)
                : { job_id: "job-1", status: "done", blob_id: "blob-1" };
        },
        health: async () => {
            calls.push({ method: "health", args: [] });
            return client.health ? client.health() : { status: "ok", version: "1.2.3" };
        },
        destroy: () => {
            destroyed += 1;
        },
    };

    const store = fakeStore();
    const bridge = new MemoryBridge({
        store,
        requestTimeoutMs: 5_000,
        eventsUrl: options.eventsUrl,
        eventsSecret: "events-secret",
        fetchImpl: options.fetchImpl,
        createClient: () => {
            created += 1;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return fake as any;
        },
    });

    return { bridge, calls, store, stats: () => ({ created, destroyed }) };
}

describe("recall", () => {
    it("maps results and reports a full page as truncated", async () => {
        const { bridge, calls } = bridgeWith({
            recall: async () => ({
                results: [
                    { text: "likes dark mode", distance: 0.12, blob_id: "b1" },
                    { text: "uses TypeScript", distance: 0.4, blob_id: "b2", score: 0.9 },
                ],
                total: 5,
                degraded_scope: false,
            }),
        });

        const result = await bridge.recall({ key_ref: "agent-a", account_id: "0xacct", query: "prefs", limit: 2 });

        assert.equal(result.results.length, 2);
        assert.equal(result.total, 5);
        // A page exactly filling `limit` means the relayer may have dropped the
        // rest silently, so the caller must be told.
        assert.equal(result.truncated, true);
        assert.equal(result.degraded_scope, false);
        assert.equal(result.namespace, "chat-app");
        assert.deepEqual(calls[0], {
            method: "recall",
            args: ["prefs", { limit: 2, subLabel: "chat-app" }],
        });
    });

    it("is not truncated when the page is short", async () => {
        const { bridge } = bridgeWith({
            recall: async () => ({ results: [{ text: "a", distance: 1, blob_id: "b" }], total: 1 }),
        });
        const result = await bridge.recall({ key_ref: "agent-a", account_id: "0xacct", query: "q", limit: 10 });
        assert.equal(result.truncated, false);
    });

    it("defaults the limit to 10", async () => {
        const { bridge, calls } = bridgeWith({});
        await bridge.recall({ key_ref: "agent-a", account_id: "0xacct", query: "q" });
        assert.deepEqual((calls[0]?.args[1] as { limit: number }).limit, 10);
    });

    it("rejects a blank query without calling the client", async () => {
        const { bridge, calls } = bridgeWith({});
        await assert.rejects(
            () => bridge.recall({ key_ref: "agent-a", account_id: "0xacct", query: "   " }),
            (err: unknown) => err instanceof BridgeError && err.status === 400,
        );
        assert.equal(calls.length, 0);
    });

    it("rejects an out-of-range limit", async () => {
        const { bridge } = bridgeWith({});
        for (const limit of [0, -1, 101, 1.5]) {
            await assert.rejects(
                () => bridge.recall({ key_ref: "agent-a", account_id: "0xacct", query: "q", limit }),
                (err: unknown) => err instanceof BridgeError && err.status === 400,
                `limit ${limit} should be rejected`,
            );
        }
    });

    it("honours a namespace override", async () => {
        const { bridge, calls } = bridgeWith({});
        await bridge.recall({ key_ref: "agent-a", account_id: "0xacct", query: "q", namespace: "other" });
        assert.equal((calls[0]?.args[1] as { subLabel: string }).subLabel, "other");
    });

    it("propagates an unknown key ref", async () => {
        const { bridge } = bridgeWith({});
        await assert.rejects(() => bridge.recall({ key_ref: "nope", account_id: "0xacct", query: "q" }));
    });
});

describe("remember", () => {
    it("waits by default and reports durability", async () => {
        const { bridge, calls } = bridgeWith({});
        const result = await bridge.remember({ key_ref: "agent-a", account_id: "0xacct", text: "  a fact  " });
        assert.equal(result.status, "done");
        assert.equal(result.blob_id, "blob-1");
        assert.equal(calls[0]?.method, "rememberAndWait");
        assert.equal(calls[0]?.args[1], "chat-app");
    });

    it("returns the queued job when wait is false", async () => {
        const { bridge, calls } = bridgeWith({});
        const result = await bridge.remember({ key_ref: "agent-a", account_id: "0xacct", text: "a fact", wait: false });
        assert.equal(result.job_id, "job-1");
        assert.equal(result.status, "queued");
        assert.equal(calls[0]?.method, "remember");
    });

    it("rejects blank text without calling the client", async () => {
        const { bridge, calls } = bridgeWith({});
        await assert.rejects(
            () => bridge.remember({ key_ref: "agent-a", account_id: "0xacct", text: "  " }),
            (err: unknown) => err instanceof BridgeError && err.status === 400,
        );
        assert.equal(calls.length, 0);
    });

    it("does not treat an empty first recall as a saved memory", async () => {
        // `done` is durability, not read-after-write consistency — surfaced via
        // the status so a caller does not assume the write is recallable.
        const { bridge } = bridgeWith({
            rememberAndWait: async () => ({ job_id: "j", status: "done" }),
        });
        const result = await bridge.remember({ key_ref: "agent-a", account_id: "0xacct", text: "x" });
        assert.equal(result.blob_id, undefined);
        assert.equal(result.status, "done");
    });
});

describe("probe", () => {
    it("returns relayer health and version", async () => {
        const { bridge } = bridgeWith({});
        const result = await bridge.probe({ key_ref: "agent-a", account_id: "0xacct" });
        assert.equal(result.status, "ok");
        assert.equal(result.version, "1.2.3");
    });
});

describe("error classification", () => {
    it("passes a 4xx through as non-retryable", async () => {
        const { bridge } = bridgeWith({
            recall: async () => {
                throw Object.assign(new Error("agent not registered"), { status: 403 });
            },
        });
        const err = await bridge
            .recall({ key_ref: "agent-a", account_id: "0xacct", query: "q" })
            .then(() => null)
            .catch((e: unknown) => e as BridgeError);

        assert.ok(err instanceof BridgeError);
        assert.equal(err.status, 403);
        assert.equal(err.code, "relayer_rejected");
        assert.match(err.message, /agent not registered/);
    });

    it("maps a network failure to a retryable 502", async () => {
        const { bridge } = bridgeWith({
            recall: async () => {
                throw new Error("fetch failed");
            },
        });
        const err = await bridge
            .recall({ key_ref: "agent-a", account_id: "0xacct", query: "q" })
            .then(() => null)
            .catch((e: unknown) => e as BridgeError);

        assert.equal(err?.status, 502);
        assert.equal(err?.code, "relayer_unavailable");
    });

    it("maps a 5xx to a retryable 502 rather than passing it through", async () => {
        const { bridge } = bridgeWith({
            recall: async () => {
                throw Object.assign(new Error("boom"), { status: 503 });
            },
        });
        const err = await bridge
            .recall({ key_ref: "agent-a", account_id: "0xacct", query: "q" })
            .then(() => null)
            .catch((e: unknown) => e as BridgeError);
        assert.equal(err?.status, 502);
    });
});

describe("client reuse", () => {
    it("reuses one client per key/server/namespace", async () => {
        const { bridge, stats } = bridgeWith({});
        await bridge.recall({ key_ref: "agent-a", account_id: "0xacct", query: "one" });
        await bridge.recall({ key_ref: "agent-a", account_id: "0xacct", query: "two" });
        // Reuse matters: the SDK caches a MYDATA session per instance, and
        // rebuilding one per tick would mean an on-chain call per run.
        assert.equal(stats().created, 1);
    });

    it("creates a separate client for a different namespace", async () => {
        const { bridge, stats } = bridgeWith({});
        await bridge.recall({ key_ref: "agent-a", account_id: "0xacct", query: "one" });
        await bridge.recall({ key_ref: "agent-a", account_id: "0xacct", query: "two", namespace: "other" });
        assert.equal(stats().created, 2);
    });

    it("destroys every cached client on dispose", async () => {
        const { bridge, stats } = bridgeWith({});
        await bridge.recall({ key_ref: "agent-a", account_id: "0xacct", query: "one" });
        await bridge.recall({ key_ref: "agent-a", account_id: "0xacct", query: "two", namespace: "other" });
        bridge.dispose();
        assert.equal(stats().destroyed, 2);
    });
});

describe("account binding", () => {
    it("refuses a ref that belongs to a different account", async () => {
        const { bridge, calls, stats } = bridgeWith({});
        const err = await bridge
            .recall({ key_ref: "agent-a", account_id: "0xsomeoneelse", query: "q" })
            .then(() => null)
            .catch((e: unknown) => e as BridgeError);
        assert.ok(err instanceof BridgeError);
        // Indistinguishable from an unknown ref, so it cannot probe for refs.
        assert.equal(err.status, 404);
        assert.equal(err.code, "key_store:unknown_ref");
        // No client was built, so no key was ever used to sign.
        assert.equal(stats().created, 0);
        assert.equal(calls.length, 0);
    });

    it("applies to remember and probe as well", async () => {
        const { bridge, calls } = bridgeWith({});
        await assert.rejects(
            () => bridge.remember({ key_ref: "agent-a", account_id: "0xother", text: "x" }),
            (err: unknown) => err instanceof BridgeError && err.status === 404,
        );
        await assert.rejects(
            () => bridge.probe({ key_ref: "agent-a", account_id: "0xother" }),
            (err: unknown) => err instanceof BridgeError && err.status === 404,
        );
        assert.equal(calls.length, 0);
    });

    it("compares account ids case-insensitively and ignoring zero padding", async () => {
        const { bridge } = bridgeWith({});
        const result = await bridge.recall({
            key_ref: "agent-a",
            account_id: "0x000000ACCT",
            query: "q",
        });
        assert.equal(result.namespace, "chat-app");
        assert.equal(normalizeObjectId("0x00AbC"), normalizeObjectId("0xabc"));
        assert.notEqual(normalizeObjectId("0xabc"), normalizeObjectId("0xabd"));
    });
});

describe("key rotation", () => {
    it("builds a fresh client and destroys the old one when the seed changes", async () => {
        const { bridge, store, stats } = bridgeWith({});
        await bridge.recall({ key_ref: "agent-a", account_id: "0xacct", query: "one" });
        assert.equal(stats().created, 1);

        store.rotate("b".repeat(64));
        await bridge.recall({ key_ref: "agent-a", account_id: "0xacct", query: "two" });

        // A cached client would keep signing with the revoked seed.
        assert.equal(stats().created, 2);
        assert.equal(stats().destroyed, 1);
    });
});

describe("memory.created emission", () => {
    it("posts a normalized event after a successful wait", async () => {
        const posts: Array<{ url: string; body: unknown; secret: string | undefined }> = [];
        const fetchImpl = (async (url: string, init: RequestInit) => {
            posts.push({
                url: String(url),
                body: JSON.parse(String(init.body)),
                secret: (init.headers as Record<string, string>)["x-internal-sync-secret"],
            });
            return new Response("{}", { status: 202 });
        }) as unknown as typeof fetch;

        const { bridge } = bridgeWith(
            {
                rememberAndWait: async () => ({
                    job_id: "job-9",
                    status: "done",
                    blob_id: "blob-9",
                    agent_object_id: "0xagent",
                }),
            },
            { eventsUrl: "http://127.0.0.1:8010/", fetchImpl },
        );

        await bridge.remember({ key_ref: "agent-a", account_id: "0xacct", text: "a fact" });

        assert.equal(posts.length, 1);
        assert.equal(posts[0]?.url, "http://127.0.0.1:8010/internal/automation/events");
        assert.equal(posts[0]?.secret, "events-secret");
        const body = posts[0]?.body as Record<string, unknown>;
        assert.equal(body.event_family, "memory");
        assert.equal(body.event_type, "created");
        assert.equal(body.account_id, "0xacct");
        assert.equal(body.deduplication_key, "memory:created:job-9");
        assert.equal(body.event_version, 1);
    });

    it("does not emit when no event sink is configured", async () => {
        let called = 0;
        const fetchImpl = (async () => {
            called += 1;
            return new Response("{}");
        }) as unknown as typeof fetch;

        const { bridge } = bridgeWith(
            { rememberAndWait: async () => ({ job_id: "j", status: "done" }) },
            { fetchImpl },
        );
        await bridge.remember({ key_ref: "agent-a", account_id: "0xacct", text: "a fact" });
        assert.equal(called, 0);
    });

    it("never fails the write when the event sink is down", async () => {
        const fetchImpl = (async () => {
            throw new Error("event sink unreachable");
        }) as unknown as typeof fetch;

        const { bridge } = bridgeWith(
            { rememberAndWait: async () => ({ job_id: "j", status: "done", blob_id: "b" }) },
            { eventsUrl: "http://127.0.0.1:8010", fetchImpl },
        );

        // The memory is already durable; a notification failure must not
        // surface as a failed write.
        const result = await bridge.remember({ key_ref: "agent-a", account_id: "0xacct", text: "a fact" });
        assert.equal(result.status, "done");
    });

    it("does not emit for a queued (non-waiting) remember", async () => {
        let called = 0;
        const fetchImpl = (async () => {
            called += 1;
            return new Response("{}");
        }) as unknown as typeof fetch;

        const { bridge } = bridgeWith({}, { eventsUrl: "http://127.0.0.1:8010", fetchImpl });
        await bridge.remember({ key_ref: "agent-a", account_id: "0xacct", text: "a fact", wait: false });
        assert.equal(called, 0);
    });
});

describe("delegate refs", () => {
    const SEED = "ab".repeat(32);

    function delegateBridge(
        options: {
            verify?: (target: unknown) => Promise<unknown>;
            open?: () => Promise<{ seedHex: string; agentObjectId: string }>;
            withStore?: boolean;
            withDelegates?: boolean;
        } = {},
    ) {
        const verified: unknown[] = [];
        const built: ResolvedAgentKey[] = [];
        const calls: string[] = [];
        const fake = {
            recall: async () => {
                calls.push("recall");
                return { results: [], total: 0 };
            },
            rememberAndWait: async () => {
                calls.push("remember");
                return { job_id: "j", status: "done" };
            },
            health: async () => ({ status: "ok", version: "1" }),
            destroy: () => {},
        };
        const bridge = new MemoryBridge({
            store: options.withStore ? fakeStore() : undefined,
            delegates:
                options.withDelegates === false
                    ? undefined
                    : {
                          open:
                              options.open ??
                              (async () => ({ seedHex: SEED, agentObjectId: "agent1" })),
                      },
            verifier:
                options.withDelegates === false
                    ? undefined
                    : {
                          verify: async (target: unknown) => {
                              verified.push(target);
                              return options.verify ? options.verify(target) : {};
                          },
                      } as never,
            delegateDefaults: { serverUrl: SERVER_URL, namespace: "chat-app" },
            requestTimeoutMs: 5_000,
            createClient: (agent) => {
                built.push(agent);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return fake as any;
            },
        });
        return { bridge, verified, built, calls };
    }

    it("verifies the delegate against the chain before it signs anything", async () => {
        const { bridge, verified, built, calls } = delegateBridge();
        await bridge.recall({ key_ref: "delegate:nightly", account_id: "0xacct", query: "q" });

        assert.equal(verified.length, 1);
        assert.deepEqual(verified[0], {
            seedHex: SEED,
            serverUrl: SERVER_URL,
            accountId: "0xacct",
            agentObjectId: "agent1",
            needs: 5, // memory read + MYDATA read
        });
        assert.equal(built[0]?.key, SEED);
        assert.equal(built[0]?.serverUrl, SERVER_URL);
        assert.equal(calls[0], "recall");
    });

    it("asks for write capability when remembering", async () => {
        const { bridge, verified } = delegateBridge();
        await bridge.remember({ key_ref: "delegate:nightly", account_id: "0xacct", text: "x" });
        assert.equal((verified[0] as { needs: number }).needs, 6); // memory write + MYDATA read
    });

    it("re-verifies on every request even though the client is reused", async () => {
        const { bridge, verified, built } = delegateBridge();
        for (let i = 0; i < 3; i += 1) {
            await bridge.recall({ key_ref: "delegate:nightly", account_id: "0xacct", query: `q${i}` });
        }
        // One client, three chain checks: a revocation lands on the next call.
        assert.equal(built.length, 1);
        assert.equal(verified.length, 3);
    });

    it("signs nothing when the delegate is revoked", async () => {
        const { bridge, built, calls } = delegateBridge({
            verify: async () => {
                throw new BridgeError("the delegate is revoked", 403, "delegate_rejected");
            },
        });
        const err = await bridge
            .recall({ key_ref: "delegate:nightly", account_id: "0xacct", query: "q" })
            .catch((e: unknown) => e as BridgeError);
        assert.equal((err as BridgeError).code, "delegate_rejected");
        assert.equal(calls.length, 0);
        assert.equal(built.length, 0);
    });

    it("propagates an unreadable or missing stored key", async () => {
        const { bridge } = delegateBridge({
            open: async () => {
                throw new BridgeError("unknown agent key ref", 404, "key_store:unknown_ref");
            },
        });
        const err = await bridge
            .recall({ key_ref: "delegate:ghost", account_id: "0xacct", query: "q" })
            .catch((e: unknown) => e as BridgeError);
        assert.equal((err as BridgeError).status, 404);
    });

    it("treats a delegate ref as unknown when delegates are not configured", async () => {
        const { bridge, built } = delegateBridge({ withDelegates: false, withStore: true });
        const err = await bridge
            .recall({ key_ref: "delegate:nightly", account_id: "0xacct", query: "q" })
            .catch((e: unknown) => e as BridgeError);
        assert.equal((err as BridgeError).code, "key_store:unknown_ref");
        assert.equal(built.length, 0);
    });

    it("has no static-key path at all when no store is configured (production)", async () => {
        const { bridge, built } = delegateBridge({ withStore: false });
        const err = await bridge
            .recall({ key_ref: "agent-a", account_id: "0xacct", query: "q" })
            .catch((e: unknown) => e as BridgeError);
        assert.equal((err as BridgeError).code, "key_store:unknown_ref");
        assert.equal(built.length, 0);
    });
});
