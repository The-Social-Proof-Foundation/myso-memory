/**
 * Counters and gauges in the Prometheus text format, for the things an operator has to be told about
 * before a juror's absence turns into a failed case: judgments that fail or abstain, how long
 * thinking takes, delegates close to expiry, and crank and rationale work that is not getting done.
 * No dependency: the registry is a few maps and `render()` writes the exposition format.
 */

export type Labels = Record<string, string>;

type Kind = "counter" | "gauge";

const DEFINITIONS: Record<string, { kind: Kind; help: string }> = {
    jury_runner_judgments_started_total: { kind: "counter", help: "Judgments begun, one per juror seat." },
    jury_runner_judgments_completed_total: { kind: "counter", help: "Judgments finished and stored." },
    jury_runner_judgments_abstained_total: {
        kind: "counter",
        help: "Judgments that fell back to abstaining because no valid verdict could be produced.",
    },
    jury_runner_judgments_failed_total: { kind: "counter", help: "Judgments that failed and will be retried on the next poll." },
    jury_runner_judgment_seconds_sum: { kind: "counter", help: "Total time spent judging, in seconds." },
    jury_runner_judgment_seconds_count: { kind: "counter", help: "Judgments timed." },
    jury_runner_directives_total: { kind: "counter", help: "Directives the engine was told to run, by action." },
    jury_runner_webhooks_rejected_total: { kind: "counter", help: "Webhooks refused for a bad signature, size or shape." },
    jury_runner_inference_amount_mist_total: { kind: "counter", help: "AI credit spent on judging, in MIST." },
    jury_runner_rationales_total: { kind: "counter", help: "Rationale publications, by outcome." },
    jury_runner_crank_runs_total: { kind: "counter", help: "Cranks the reconciler tried, by outcome." },
    jury_runner_delegate_active: { kind: "gauge", help: "1 while a monitored delegate can act, 0 once it cannot." },
    jury_runner_delegate_expires_in_seconds: {
        kind: "gauge",
        help: "Seconds until a monitored delegate expires; absent if it never does or cannot be read.",
    },
    jury_runner_delegate_check_failures_total: { kind: "counter", help: "Delegate status checks that could not be completed." },
};

function labelKey(labels: Labels): string {
    const entries = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return entries.map(([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`).join(",");
}

export class Metrics {
    private readonly values = new Map<string, Map<string, number>>();

    inc(name: string, labels: Labels = {}, by = 1): void {
        this.require(name);
        const series = this.series(name);
        const key = labelKey(labels);
        series.set(key, (series.get(key) ?? 0) + by);
    }

    set(name: string, labels: Labels, value: number): void {
        this.require(name);
        this.series(name).set(labelKey(labels), value);
    }

    /** Forgets a series, so a gauge for something that went away stops being reported. */
    clear(name: string, labels: Labels): void {
        this.series(name).delete(labelKey(labels));
    }

    /** Records one timed event as a sum and a count, from which a scraper derives the average. */
    observeSeconds(prefix: "jury_runner_judgment", seconds: number): void {
        this.inc(`${prefix}_seconds_sum`, {}, seconds);
        this.inc(`${prefix}_seconds_count`);
    }

    /** The current value of a series; for tests and the health summary. */
    get(name: string, labels: Labels = {}): number {
        return this.values.get(name)?.get(labelKey(labels)) ?? 0;
    }

    render(): string {
        const lines: string[] = [];
        for (const [name, definition] of Object.entries(DEFINITIONS)) {
            lines.push(`# HELP ${name} ${definition.help}`, `# TYPE ${name} ${definition.kind}`);
            const series = this.values.get(name);
            if (!series || series.size === 0) {
                // A counter that has not happened yet is a real zero; a gauge with no series says nothing.
                if (definition.kind === "counter") lines.push(`${name} 0`);
                continue;
            }
            for (const [key, value] of series) lines.push(key ? `${name}{${key}} ${value}` : `${name} ${value}`);
        }
        return `${lines.join("\n")}\n`;
    }

    private series(name: string): Map<string, number> {
        let series = this.values.get(name);
        if (!series) {
            series = new Map();
            this.values.set(name, series);
        }
        return series;
    }

    private require(name: string): void {
        if (!DEFINITIONS[name]) throw new Error(`unknown metric ${name}`);
    }
}
