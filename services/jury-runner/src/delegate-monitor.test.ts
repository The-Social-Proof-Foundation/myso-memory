import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DelegateMonitor, parseMonitoredDelegates, type DelegateMonitorConfig } from "./delegate-monitor.js";
import { Metrics } from "./metrics.js";

const DAY = 86_400_000;

const config: DelegateMonitorConfig = {
    bridgeUrl: "http://bridge.test",
    bridgeSecret: "secret",
    delegates: [{ keyRef: "delegate:keeper", accountId: "0xacct" }],
    intervalMs: 600_000,
    warnWithinMs: 14 * DAY,
};

function monitor(answer: () => Response | Error) {
    const metrics = new Metrics();
    const logs: Array<{ message: string; detail?: unknown }> = [];
    const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const instance = new DelegateMonitor({
        config,
        metrics,
        fetch: (async (url: string, init?: RequestInit) => {
            calls.push({ url, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
            const next = answer();
            if (next instanceof Error) throw next;
            return next;
        }) as unknown as typeof fetch,
        log: (message, detail) => logs.push({ message, detail }),
    });
    return { instance, metrics, logs, calls };
}

const body = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
const labels = { delegate: "delegate:keeper", account: "0xacct" };

describe("parseMonitoredDelegates", () => {
    it("reads delegate:<name>@<account> entries and refuses anything else", () => {
        assert.deepEqual(parseMonitoredDelegates("delegate:keeper@0xab, delegate:j1@0xcd"), [
            { keyRef: "delegate:keeper", accountId: "0xab" },
            { keyRef: "delegate:j1", accountId: "0xcd" },
        ]);
        assert.throws(() => parseMonitoredDelegates("keeper@0xab"), /delegate:<name>@0x/);
        assert.throws(() => parseMonitoredDelegates("delegate:keeper"), /delegate:<name>@0x/);
    });
});

describe("DelegateMonitor", () => {
    it("publishes the time left and stays quiet while there is plenty", async () => {
        const { instance, metrics, logs, calls } = monitor(() => body({ status: "active", expires_in_ms: 60 * DAY }));
        await instance.tick();
        assert.equal(calls[0]?.url, "http://bridge.test/internal/chain/delegate-status");
        assert.equal(calls[0]?.headers["x-internal-sync-secret"], "secret");
        assert.deepEqual(calls[0]?.body, { key_ref: "delegate:keeper", account_id: "0xacct" });
        assert.equal(metrics.get("jury_runner_delegate_active", labels), 1);
        assert.equal(metrics.get("jury_runner_delegate_expires_in_seconds", labels), 60 * 86_400);
        assert.equal(logs.length, 0);
    });

    it("warns inside the warning window and says how many days are left", async () => {
        const { instance, logs } = monitor(() => body({ status: "active", expires_in_ms: 5 * DAY + 1000 }));
        await instance.tick();
        assert.match(logs[0]?.message ?? "", /expires soon/);
        assert.equal((logs[0]?.detail as { days: number }).days, 5);
    });

    it("marks a revoked or expired delegate inactive and tells the operator to replace it", async () => {
        const { instance, metrics, logs } = monitor(() => body({ status: "inactive", reason: "revoked" }));
        await instance.tick();
        assert.equal(metrics.get("jury_runner_delegate_active", labels), 0);
        assert.match(logs[0]?.message ?? "", /replace it/);
    });

    it("counts a check it could not make instead of guessing", async () => {
        const down = monitor(() => new Error("connection refused"));
        await down.instance.tick();
        assert.equal(down.metrics.get("jury_runner_delegate_check_failures_total"), 1);
        const bad = monitor(() => new Response("{}", { status: 502 }));
        await bad.instance.tick();
        assert.equal(bad.metrics.get("jury_runner_delegate_check_failures_total"), 1);
        assert.equal(bad.metrics.get("jury_runner_delegate_active", labels), 0);
    });
});
