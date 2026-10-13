import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Metrics } from "./metrics.js";

describe("Metrics", () => {
    it("counts, labels and renders in the Prometheus text format", () => {
        const metrics = new Metrics();
        metrics.inc("jury_runner_directives_total", { action: "jury.commit_vote.v1" });
        metrics.inc("jury_runner_directives_total", { action: "jury.commit_vote.v1" });
        metrics.inc("jury_runner_directives_total", { action: "jury.reveal_vote.v1" });
        assert.equal(metrics.get("jury_runner_directives_total", { action: "jury.commit_vote.v1" }), 2);
        const text = metrics.render();
        assert.match(text, /# TYPE jury_runner_directives_total counter/);
        assert.match(text, /jury_runner_directives_total\{action="jury\.commit_vote\.v1"\} 2/);
        assert.match(text, /jury_runner_directives_total\{action="jury\.reveal_vote\.v1"\} 1/);
    });

    it("reports a counter that has not happened as zero and an unread gauge as nothing", () => {
        const text = new Metrics().render();
        assert.match(text, /^jury_runner_judgments_failed_total 0$/m);
        assert.doesNotMatch(text, /^jury_runner_delegate_expires_in_seconds\{/m);
    });

    it("derives an average from a time sum and count, and drops a gauge that went away", () => {
        const metrics = new Metrics();
        metrics.observeSeconds("jury_runner_judgment", 4);
        metrics.observeSeconds("jury_runner_judgment", 6);
        assert.equal(metrics.get("jury_runner_judgment_seconds_sum"), 10);
        assert.equal(metrics.get("jury_runner_judgment_seconds_count"), 2);
        const labels = { delegate: "delegate:k", account: "0x1" };
        metrics.set("jury_runner_delegate_expires_in_seconds", labels, 99);
        assert.match(metrics.render(), /jury_runner_delegate_expires_in_seconds\{account="0x1",delegate="delegate:k"\} 99/);
        metrics.clear("jury_runner_delegate_expires_in_seconds", labels);
        assert.doesNotMatch(metrics.render(), /^jury_runner_delegate_expires_in_seconds\{/m);
    });

    it("escapes label values and refuses a metric it does not know", () => {
        const metrics = new Metrics();
        metrics.inc("jury_runner_directives_total", { action: 'a"b\\c' });
        assert.match(metrics.render(), /action="a\\"b\\\\c"/);
        assert.throws(() => metrics.inc("not_a_metric"), /unknown metric/);
    });
});
