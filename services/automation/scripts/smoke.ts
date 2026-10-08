#!/usr/bin/env -S npx tsx
/**
 * Automation stack smoke test.
 *
 * Boots the real automation engine (Rust) and the real memory bridge, plus a
 * stub AI-credit oracle, then drives a job through its full lifecycle.
 *
 * What this proves:
 *   - the shared secret is enforced on every non-public route, both services
 *   - the bridge resolves a `target_agent_key_ref` and refuses unknown ones
 *   - the engine reaches the bridge for a memory action rather than nudging
 *     messaging, which is what `MemoryRelayerCall` used to do
 *   - `max_mist_per_run` actually skips an over-budget run
 *   - a run that cannot complete is recorded `failed` with a reason, never left
 *     `running`
 *
 * What this deliberately does NOT prove: a real recall/remember round trip. The
 * SDK's `buildMyDataSession()` creates an on-chain SessionKey, so that needs
 * localnet plus MYDATA key servers and a registered MemoryAccount. Here the
 * relayer origin points at a stub, so the memory call is expected to fail — and
 * the assertion is that it fails *cleanly*, at the right layer, with a recorded
 * reason.
 *
 * Usage:
 *   pnpm smoke:automation
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const ENGINE_DIR = resolve(REPO_ROOT, "services/automation");
const BRIDGE_DIR = resolve(REPO_ROOT, "services/automation-sidecar");

const SECRET = "smoke-test-secret";
const ENGINE_PORT = 18_010;
const BRIDGE_PORT = 18_011;
const ORACLE_PORT = 18_095;
const ORACLE_SECRET = "smoke-oracle-secret";
/** Owner wallet the engine must preflight against (not the MemoryAccount id). */
const SMOKE_OWNER = "0xsmokeowner";
const RELAYER_PORT = 18_000;

const ENGINE_URL = `http://127.0.0.1:${ENGINE_PORT}`;
const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;

/** Oracle estimate returned to the engine. Overridden per phase. */
let oracleEstimatedMist = 10;
let oracleAllowed = true;

type Status = "pass" | "fail";
const results: Array<{ name: string; status: Status; detail?: string }> = [];

function check(name: string, status: Status, detail?: string): void {
    results.push({ name, status, detail });
    const glyph = status === "pass" ? "✓" : "✗";
    console.log(`  ${glyph} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function expect(
    name: string,
    fn: () => Promise<string | void>,
): Promise<void> {
    try {
        const detail = await fn();
        check(name, "pass", detail ?? undefined);
    } catch (err) {
        check(name, "fail", err instanceof Error ? err.message : String(err));
    }
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

async function waitForHealth(url: string, label: string, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = "no attempt";
    while (Date.now() < deadline) {
        try {
            const res = await fetch(url);
            if (res.ok) return;
            lastError = `status ${res.status}`;
        } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
        }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`${label} did not become healthy at ${url}: ${lastError}`);
}

/** Stub AI-credit oracle: allows or rejects, and reports a fixed estimate. */
function startStubOracle(): Server {
    const server = createServer((req, res) => {
        if (req.url === "/health") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ status: "ok" }));
            return;
        }
        if (req.url === "/v1/ai-credit/preflight") {
            // Enforce the real oracle's contract (PreflightRequest in
            // myso-ai-credit-oracle): it requires `operation`, rejects a missing
            // or wrong secret with a bodyless 401, and a malformed body with 422.
            // A permissive stub previously hid the engine sending neither.
            if (req.headers["x-ai-credit-oracle-secret"] !== ORACLE_SECRET) {
                res.writeHead(401).end();
                return;
            }
            let raw = "";
            req.on("data", (chunk) => (raw += chunk));
            req.on("end", () => {
                let body: Record<string, unknown> = {};
                try {
                    body = JSON.parse(raw);
                } catch {
                    /* falls through to 422 */
                }
                const valid =
                    body.owner === SMOKE_OWNER &&
                    typeof body.agent_object_id === "string" &&
                    typeof body.operation === "string" &&
                    typeof body.estimated_tokens_in === "number" &&
                    typeof body.estimated_tokens_out === "number";
                if (!valid) {
                    res.writeHead(422).end();
                    return;
                }
                res.writeHead(200, { "content-type": "application/json" });
                res.end(
                    JSON.stringify({
                        allowed: oracleAllowed,
                        approval_required: false,
                        estimated_mist: oracleEstimatedMist,
                        reason: oracleAllowed ? null : "insufficient credits (stub)",
                    }),
                );
            });
            return;
        }
        res.writeHead(404).end();
    });
    server.listen(ORACLE_PORT, "127.0.0.1");
    return server;
}

/**
 * Stub memory relayer.
 *
 * Serves only `GET /version`, with metadata the SDK's compatibility gate
 * accepts. Everything past that needs a chain, which is the point: the bridge is
 * expected to classify the follow-on failure rather than mask it.
 */
function startStubRelayer(): Server {
    const server = createServer((req, res) => {
        if (req.url === "/version") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
                JSON.stringify({
                    apiVersion: "1.0.0",
                    relayerVersion: "0.0.6",
                    minSupportedSdk: { typescript: "0.0.1" },
                    featureFlags: {},
                }),
            );
            return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found in stub relayer" }));
    });
    server.listen(RELAYER_PORT, "127.0.0.1");
    return server;
}

function spawnProcess(
    label: string,
    command: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
): ChildProcess {
    const child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (b: Buffer) => process.stdout.write(`[${label}] ${b}`));
    child.stderr?.on("data", (b: Buffer) => process.stderr.write(`[${label}] ${b}`));
    child.on("exit", (code) => {
        if (code !== 0 && code !== null) {
            console.error(`[${label}] exited with code ${code}`);
        }
    });
    return child;
}

function authHeaders(secret = SECRET): Record<string, string> {
    return { "content-type": "application/json", "x-internal-sync-secret": secret };
}

async function json<T>(res: Response): Promise<T> {
    return (await res.json()) as T;
}

/** Poll a job's runs until one reaches a terminal status. */
async function waitForRun(
    jobId: string,
    timeoutMs = 20_000,
): Promise<{ status: string; error?: string; attempt: number; cost_mist?: number }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const res = await fetch(`${ENGINE_URL}/v1/automation/jobs/${jobId}/runs`, {
            headers: authHeaders(),
        });
        if (res.ok) {
            const runs = await json<Array<{ status: string; error?: string; attempt: number; cost_mist?: number }>>(res);
            const settled = runs.find((r) => r.status !== "running");
            if (settled) return settled;
        }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`no terminal run for job ${jobId} within ${timeoutMs}ms`);
}

async function createJob(body: Record<string, unknown>): Promise<string> {
    const res = await fetch(`${ENGINE_URL}/v1/automation/jobs`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
    });
    if (res.status !== 200) {
        // Read the body only on failure: a template literal would evaluate the
        // await eagerly and consume the body on the success path too.
        throw new Error(`create job returned ${res.status}: ${await res.text()}`);
    }
    return (await json<{ id: string }>(res)).id;
}

/** An interval trigger that is immediately due, since no run has succeeded yet. */
function intervalTriggerSet() {
    return {
        match_mode: "any",
        evaluation_window_ms: 0,
        triggers: [
            {
                kind: "interval",
                interval_ms: 1000,
                event_family: "automation",
                event_type: "tick",
            },
        ],
    };
}

const children: ChildProcess[] = [];
const servers: Server[] = [];

async function main(): Promise<void> {
    console.log("Automation stack smoke test\n===========================");

    const workDir = mkdtempSync(join(tmpdir(), "automation-smoke-"));
    const agentsFile = join(workDir, "agents.json");
    writeFileSync(
        agentsFile,
        JSON.stringify({
            agents: {
                "smoke-agent": {
                    key: "1".repeat(64),
                    accountId: "0xsmokeaccount",
                    serverUrl: `http://127.0.0.1:${RELAYER_PORT}`,
                    namespace: "chat-app",
                },
            },
        }),
        "utf8",
    );

    servers.push(startStubOracle(), startStubRelayer());

    children.push(
        spawnProcess("bridge", "npx", ["tsx", "src/server.ts"], BRIDGE_DIR, {
            PORT: String(BRIDGE_PORT),
            HOST: "127.0.0.1",
            INTERNAL_SYNC_SECRET: SECRET,
            MEMORY_SERVER_URL: `http://127.0.0.1:${RELAYER_PORT}`,
            AUTOMATION_AGENT_KEYS_FILE: agentsFile,
            AUTOMATION_DEFAULT_NAMESPACE: "chat-app",
        }),
    );

    children.push(
        spawnProcess(
            "engine",
            "cargo",
            ["run", "--quiet", "--locked"],
            ENGINE_DIR,
            {
                PORT: String(ENGINE_PORT),
                INTERNAL_SYNC_SECRET: SECRET,
                AI_CREDIT_ORACLE_URL: `http://127.0.0.1:${ORACLE_PORT}`,
                AI_CREDIT_ORACLE_API_SECRET: ORACLE_SECRET,
                AUTOMATION_MEMORY_BRIDGE_URL: BRIDGE_URL,
                AUTOMATION_TICK_INTERVAL_SECS: "1",
                AUTOMATION_ENABLED: "true",
                RUST_LOG: "myso_automation=warn",
                // Explicitly blank DATABASE_URL so the engine uses the in-memory
                // store and the smoke test leaves no database behind.
                DATABASE_URL: "",
            },
        ),
    );

    await waitForHealth(`${BRIDGE_URL}/health`, "bridge");
    check("bridge boots and answers /health", "pass");
    await waitForHealth(`${ENGINE_URL}/health`, "engine");
    check("engine boots and answers /health", "pass");

    await expect("bridge /health reports a count without ref names or key material", async () => {
        const body = await json<{ agents: number; agent_refs?: string[] }>(
            await fetch(`${BRIDGE_URL}/health`),
        );
        assert(body.agents === 1, `expected 1 agent, got ${body.agents}`);
        assert(body.agent_refs === undefined, "ref names leaked from public /health");
        const raw = JSON.stringify(body);
        assert(!raw.includes("1".repeat(64)), "key material leaked from /health");
        return `${body.agents} agent`;
    });

    await expect("bridge rejects a missing secret", async () => {
        const res = await fetch(`${BRIDGE_URL}/internal/memory/recall`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ key_ref: "smoke-agent", account_id: "0xsmokeaccount", query: "q" }),
        });
        assert(res.status === 401, `expected 401, got ${res.status}`);
        return "401";
    });

    await expect("bridge rejects a wrong secret", async () => {
        const res = await fetch(`${BRIDGE_URL}/internal/memory/recall`, {
            method: "POST",
            headers: authHeaders("not-the-secret"),
            body: JSON.stringify({ key_ref: "smoke-agent", account_id: "0xsmokeaccount", query: "q" }),
        });
        assert(res.status === 401, `expected 401, got ${res.status}`);
        return "401";
    });

    await expect("bridge rejects an unknown key ref as 404", async () => {
        const res = await fetch(`${BRIDGE_URL}/internal/memory/recall`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ key_ref: "ghost", account_id: "0xsmokeaccount", query: "q" }),
        });
        assert(res.status === 404, `expected 404, got ${res.status}`);
        const body = await json<{ code: string }>(res);
        assert(
            body.code === "key_store:unknown_ref",
            `unexpected code ${body.code}`,
        );
        return body.code;
    });

    await expect("bridge refuses a real ref presented for a different account", async () => {
        const res = await fetch(`${BRIDGE_URL}/internal/memory/recall`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ key_ref: "smoke-agent", account_id: "0xnobody", query: "q" }),
        });
        assert(res.status === 404, `expected 404, got ${res.status}`);
        const body = await json<{ code: string; error: string }>(res);
        assert(body.code === "key_store:unknown_ref", `unexpected code ${body.code}`);
        return body.code;
    });

    await expect("engine rejects an unauthenticated job read", async () => {
        const res = await fetch(`${ENGINE_URL}/v1/automation/jobs?account_id=0xsmokeaccount`);
        assert(res.status === 401, `expected 401, got ${res.status}`);
        return "401";
    });

    await expect("engine rejects an unauthenticated job create", async () => {
        const res = await fetch(`${ENGINE_URL}/v1/automation/jobs`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
        });
        assert(res.status === 401, `expected 401, got ${res.status}`);
        return "401";
    });

    await expect("engine refuses an unscoped job listing", async () => {
        const res = await fetch(`${ENGINE_URL}/v1/automation/jobs`, {
            headers: authHeaders(),
        });
        assert(res.status === 400, `expected 400, got ${res.status}`);
        return "400";
    });

    // ---- budget cap: oracle says 5000 mist, job allows 100 ----------------
    oracleEstimatedMist = 5000;
    const budgetJobId = await createJob({
        organization_id: "0xsmokeorg",
        account_id: "0xsmokeaccount",
        owner_address: SMOKE_OWNER,
        name: "smoke: over budget",
        trigger_set: intervalTriggerSet(),
        target_agent_object_id: "0xsmokeagent",
        target_agent_key_ref: "smoke-agent",
        action: { kind: "memory_relayer_call", config: { operation: "recall", query: "prefs" } },
        memory_scope: "chat-app",
        max_mist_per_run: 100,
    });

    await expect("a run over max_mist_per_run is skipped, not executed", async () => {
        const run = await waitForRun(budgetJobId);
        assert(
            run.status === "skipped",
            `expected skipped, got ${run.status} (${run.error ?? "no error"})`,
        );
        assert(
            run.error?.includes("max_mist_per_run") ?? false,
            `expected a budget reason, got ${run.error}`,
        );
        return run.error;
    });

    // ---- in budget: the engine must reach the bridge ----------------------
    oracleEstimatedMist = 10;
    const wiredJobId = await createJob({
        organization_id: "0xsmokeorg",
        account_id: "0xsmokeaccount",
        owner_address: SMOKE_OWNER,
        name: "smoke: reaches the bridge",
        trigger_set: intervalTriggerSet(),
        target_agent_object_id: "0xsmokeagent",
        target_agent_key_ref: "smoke-agent",
        action: {
            kind: "memory_relayer_call",
            config: { operation: "recall", query: "what does the user prefer" },
        },
        memory_scope: "chat-app",
        max_mist_per_run: 1000,
        retry_policy: { max_attempts: 2, jitter_ms: 0 },
    });

    // The stub relayer cannot complete an on-chain SessionKey, so the memory
    // call is expected to fail. The assertion is that it fails at the bridge
    // with a recorded reason, which proves the engine wired the bridge instead
    // of the old messaging nudge.
    await expect("engine routes MemoryRelayerCall through the bridge", async () => {
        const run = await waitForRun(wiredJobId);
        assert(
            run.status === "failed",
            `expected failed at the (chain-less) relayer boundary, got ${run.status}` +
                (run.error ? `: ${run.error}` : ""),
        );
        assert(
            run.error !== undefined && run.error.length > 0,
            "a failed run must record a reason",
        );
        assert(
            run.error?.includes("recall rejected by memory relayer") ||
                run.error?.includes("recall failed"),
            `expected a bridge-originated error, got: ${run.error}`,
        );
        return run.error?.slice(0, 140);
    });

    await expect("a failed run records its attempt count", async () => {
        const res = await fetch(`${ENGINE_URL}/v1/automation/jobs/${wiredJobId}/runs`, {
            headers: authHeaders(),
        });
        const runs = await json<Array<{ attempt: number; status: string }>>(res);
        const settled = runs.find((r) => r.status === "failed");
        assert(settled !== undefined, "no failed run found");
        assert(
            settled.attempt === 2,
            `retry_policy.max_attempts=2 should record attempt=2, got ${settled.attempt}`,
        );
        return `attempt=${settled.attempt}`;
    });

    await expect("job listing is scoped to its account", async () => {
        const mine = await json<unknown[]>(
            await fetch(`${ENGINE_URL}/v1/automation/jobs?account_id=0xsmokeaccount`, {
                headers: authHeaders(),
            }),
        );
        assert(mine.length === 2, `expected 2 jobs, got ${mine.length}`);

        const other = await json<unknown[]>(
            await fetch(`${ENGINE_URL}/v1/automation/jobs?account_id=0xnobody`, {
                headers: authHeaders(),
            }),
        );
        assert(other.length === 0, `expected 0 jobs for another account, got ${other.length}`);
        return "2 mine, 0 for another account";
    });

    await expect("runs for an unknown job are 404, not an empty list", async () => {
        const res = await fetch(
            `${ENGINE_URL}/v1/automation/jobs/00000000-0000-0000-0000-000000000000/runs`,
            { headers: authHeaders() },
        );
        assert(res.status === 404, `expected 404, got ${res.status}`);
        return "404";
    });

    // ---- AUTOMATION_ENABLED=false keeps the API but stops execution -------
    await expect("live engine is executing (runs settle without help)", async () => {
        const run = await waitForRun(budgetJobId);
        assert(run.status !== "running", "runs are not settling");
        return "tick loop active";
    });

    const failed = results.filter((r) => r.status === "fail").length;
    console.log(
        `\n${results.length - failed}/${results.length} checks passed`,
    );
    if (failed > 0) {
        console.log(`${failed} check(s) failed.`);
        process.exitCode = 1;
    }
}

async function cleanup(): Promise<void> {
    for (const child of children) {
        if (!child.killed) child.kill("SIGTERM");
    }
    await new Promise((r) => setTimeout(r, 300));
    for (const child of children) {
        if (!child.killed) child.kill("SIGKILL");
    }
    for (const server of servers) {
        server.close();
    }
}

main()
    .catch((err: unknown) => {
        console.error(
            "\nsmoke test aborted:",
            err instanceof Error ? err.message : err,
        );
        process.exitCode = 1;
    })
    .finally(() => {
        void cleanup();
    });
