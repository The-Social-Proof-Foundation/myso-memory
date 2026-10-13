/**
 * Entry point: reads the environment, wires the pieces and listens. See README.md.
 */

import { HttpSocialReader } from "./bundle.js";
import { loadConfig } from "./config.js";
import { DirectiveEngine, JudgmentService } from "./directives.js";
import { createGatewayCaller, GatewayInferenceClient } from "./inference-gateway.js";
import { OpenAiCompatibleClient, type InferenceClient } from "./inference.js";
import { DelegateMonitor } from "./delegate-monitor.js";
import { Metrics } from "./metrics.js";
import { RationalePublisher } from "./rationale-publisher.js";
import { Reconciler } from "./reconciler.js";
import { fetchEvidence } from "./safe-fetch.js";
import { createJurorServer } from "./server.js";
import { FileStore } from "./store.js";

const config = loadConfig();
const log = (message: string, detail?: unknown) =>
    console.error(JSON.stringify({ at: new Date().toISOString(), message, detail }));

const inference: InferenceClient =
    config.inference.kind === "gateway"
        ? new GatewayInferenceClient({
              caller: await createGatewayCaller(config.inference),
              modelId: config.inference.modelId,
              maxTokens: config.inference.maxTokens,
          })
        : new OpenAiCompatibleClient(config.inference);

const metrics = new Metrics();
const store = new FileStore(config.storePath);
const judgments = new JudgmentService({
    store,
    bundle: {
        social: new HttpSocialReader(config.socialServerUrl),
        fetchEvidence: (uri) =>
            fetchEvidence(uri, { allowedHosts: config.evidenceAllowedHosts, ipfsGateway: config.ipfsGateway }),
    },
    judge: { inference },
    saltSecret: config.saltSecret,
    now: Date.now,
    log,
    metrics,
});
const engine = new DirectiveEngine({ store, judgments, now: Date.now });
const server = createJurorServer({
    webhookSecret: config.webhookSecret,
    engine,
    store,
    maxBodyBytes: config.maxBodyBytes,
    metrics,
    metricsToken: config.metricsToken ?? undefined,
    log,
});

server.listen(config.port, config.host, () => {
    log("juror runner listening", { host: config.host, port: config.port });
});

if (config.rationalePublisher) {
    const publisher = new RationalePublisher({
        store,
        socialServerUrl: config.socialServerUrl,
        secret: config.rationalePublisher.secret,
        fetch,
        now: Date.now,
        log,
    });
    let publishing = false;
    const timer = setInterval(() => {
        if (publishing) return;
        publishing = true;
        publisher
            .tick()
            .then((result) => {
                metrics.inc("jury_runner_rationales_total", { outcome: "stored" }, result.stored);
                metrics.inc("jury_runner_rationales_total", { outcome: "refused" }, result.refused);
                metrics.inc("jury_runner_rationales_total", { outcome: "failed" }, result.failed);
                if (result.stored + result.refused + result.failed > 0) log("published rationales", result);
            })
            .catch((error: unknown) => log("rationale publishing failed", String(error)))
            .finally(() => {
                publishing = false;
            });
    }, config.rationalePublisher.intervalMs);
    timer.unref();
}

if (config.delegateMonitor) {
    const monitor = new DelegateMonitor({ config: config.delegateMonitor, metrics, fetch, log });
    const check = () =>
        monitor.tick().catch((error: unknown) => log("delegate check failed", String(error)));
    void check();
    setInterval(() => void check(), config.delegateMonitor.intervalMs).unref();
}

if (config.reconciler) {
    const reconciler = new Reconciler({
        config: config.reconciler,
        socialServerUrl: config.socialServerUrl,
        fetch,
        now: Date.now,
        log,
    });
    let running = false;
    const timer = setInterval(() => {
        // One pass at a time: a slow bridge must not stack passes on top of each other.
        if (running) return;
        running = true;
        reconciler
            .tick()
            .then((result) => {
                metrics.inc("jury_runner_crank_runs_total", { outcome: "ran" }, result.ran);
                metrics.inc("jury_runner_crank_runs_total", { outcome: "conflict" }, result.conflicts);
                metrics.inc("jury_runner_crank_runs_total", { outcome: "failed" }, result.failed);
                if (result.ran + result.conflicts + result.failed > 0) log("reconciled cranks", result);
            })
            .catch((error: unknown) => log("reconciler pass failed", String(error)))
            .finally(() => {
                running = false;
            });
    }, config.reconciler.intervalMs);
    timer.unref();
    log("keeper reconciler on", { intervalMs: config.reconciler.intervalMs, graceMs: config.reconciler.graceMs });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => server.close(() => process.exit(0)));
}
