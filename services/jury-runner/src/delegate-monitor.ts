/**
 * Watches the delegates a runner depends on. A juror or keeper delegate lives at most 90 days and
 * then silently stops: its jobs fail, cranks go unrun and seats go unfilled, and nothing says why.
 * This asks the bridge, on a timer, how long each one has left, publishes that as a gauge and logs
 * a warning once one is inside the warning window, so a rotation happens before the expiry.
 */

import type { Metrics } from "./metrics.js";

export interface MonitoredDelegate {
    /** `delegate:<name>` */
    keyRef: string;
    /** The MemoryAccount the delegate belongs to. */
    accountId: string;
}

export interface DelegateMonitorConfig {
    bridgeUrl: string;
    bridgeSecret: string;
    delegates: MonitoredDelegate[];
    intervalMs: number;
    /** Warn when a delegate has less than this left. */
    warnWithinMs: number;
}

export const DEFAULT_WARN_WITHIN_MS = 14 * 24 * 60 * 60 * 1000;

/** `delegate:keeper@0xacct, delegate:juror-1@0xacct` */
export function parseMonitoredDelegates(raw: string): MonitoredDelegate[] {
    const out: MonitoredDelegate[] = [];
    for (const piece of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
        const at = piece.lastIndexOf("@");
        const keyRef = at > 0 ? piece.slice(0, at) : "";
        const accountId = at > 0 ? piece.slice(at + 1) : "";
        if (!keyRef.startsWith("delegate:") || !/^0x[0-9a-fA-F]{1,64}$/.test(accountId)) {
            throw new Error(`MONITOR_DELEGATES entry "${piece}" must look like delegate:<name>@0x<account>`);
        }
        out.push({ keyRef, accountId });
    }
    return out;
}

export interface DelegateMonitorDeps {
    config: DelegateMonitorConfig;
    metrics: Metrics;
    fetch: typeof fetch;
    log: (message: string, detail?: unknown) => void;
}

interface BridgeStatus {
    status: "active" | "inactive";
    delegate_class?: string;
    expires_in_ms?: number | null;
    reason?: string;
}

export class DelegateMonitor {
    constructor(private readonly deps: DelegateMonitorDeps) {}

    async tick(): Promise<void> {
        for (const delegate of this.deps.config.delegates) await this.check(delegate);
    }

    private async check(delegate: MonitoredDelegate): Promise<void> {
        const { config, metrics, log } = this.deps;
        const labels = { delegate: delegate.keyRef, account: delegate.accountId };
        let status: BridgeStatus;
        try {
            const response = await this.deps.fetch(`${config.bridgeUrl}/internal/chain/delegate-status`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-internal-sync-secret": config.bridgeSecret },
                body: JSON.stringify({ key_ref: delegate.keyRef, account_id: delegate.accountId }),
            });
            if (!response.ok) throw new Error(`bridge answered ${response.status}`);
            status = (await response.json()) as BridgeStatus;
        } catch (error) {
            metrics.inc("jury_runner_delegate_check_failures_total");
            log("could not check a delegate", { delegate: delegate.keyRef, error: String(error) });
            return;
        }

        metrics.set("jury_runner_delegate_active", labels, status.status === "active" ? 1 : 0);
        if (typeof status.expires_in_ms === "number") {
            metrics.set("jury_runner_delegate_expires_in_seconds", labels, Math.max(0, Math.floor(status.expires_in_ms / 1000)));
        } else {
            metrics.clear("jury_runner_delegate_expires_in_seconds", labels);
        }
        if (status.status === "inactive") {
            log("a delegate can no longer act: replace it", { delegate: delegate.keyRef, reason: status.reason });
        } else if (typeof status.expires_in_ms === "number" && status.expires_in_ms < config.warnWithinMs) {
            log("a delegate expires soon: rotate it", {
                delegate: delegate.keyRef,
                days: Math.floor(status.expires_in_ms / 86_400_000),
            });
        }
    }
}
