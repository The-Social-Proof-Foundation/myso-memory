#!/usr/bin/env -S npx tsx
/**
 * Live stack check. Unlike `smoke.ts` (which boots its own engine and bridge against a stub memory
 * server), this talks to the services you already have running: memory server, automation engine,
 * bridge, localnet and the MyData key server. It proves the wiring between them.
 *
 * The last mile (a delegate registered on chain and a job running as it) needs a human wallet to
 * sign, so it is done once in the chat-app's Automation panel.
 *
 * Usage:  pnpm smoke:live
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../..");

function readEnv(path: string): Record<string, string> {
    const out: Record<string, string> = {};
    try {
        for (const line of readFileSync(resolve(ROOT, path), "utf8").split("\n")) {
            const m = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line);
            if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
        }
    } catch {
        /* missing file: reported by the checks below */
    }
    return out;
}

const engineEnv = readEnv("services/automation/.env");
const bridgeEnv = readEnv("services/automation-sidecar/.env");
const memoryEnv = readEnv("services/server/.env");
const chatEnv = readEnv("../myso-messaging-stack/chat-app/.env");

const MEMORY = "http://127.0.0.1:8000";
const ENGINE = "http://127.0.0.1:8010";
const BRIDGE = "http://127.0.0.1:8011";
const RPC = "http://127.0.0.1:9000";
const secret = engineEnv.INTERNAL_SYNC_SECRET ?? "";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
    if (!ok) failed++;
    console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function call(url: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
    try {
        const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
        const text = await res.text();
        let body: any = text;
        try { body = JSON.parse(text); } catch { /* not json */ }
        return { status: res.status, body };
    } catch (err) {
        return { status: 0, body: String((err as Error).message) };
    }
}

const post = (url: string, body: unknown, s?: string) =>
    call(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(s ? { "x-internal-sync-secret": s } : {}) },
        body: JSON.stringify(body),
    });

console.log("Live automation stack check\n===========================");

// Secrets must be one value across the stack.
check("one shared secret across engine, bridge and memory server",
    Boolean(secret) && secret === bridgeEnv.INTERNAL_SYNC_SECRET && secret === memoryEnv.INTERNAL_SYNC_SECRET);

const mem = await call(`${MEMORY}/health`);
check("memory server is up", mem.status === 200 && mem.body?.status === "ok", mem.status ? `social=${mem.body?.social_server} sidecar=${mem.body?.sidecar}` : "not reachable");
const cfg = await call(`${MEMORY}/config`);
check("memory server serves /config (the call the bridge makes before every recall)", cfg.status === 200, `HTTP ${cfg.status}`);

const eng = await call(`${ENGINE}/health`);
check("engine is up", eng.status === 200);
check("engine is using Postgres (needed for delegate keys)", engineEnv.DATABASE_URL !== undefined,
    engineEnv.DATABASE_URL ? "DATABASE_URL set in services/automation/.env; run the engine from that folder" : "DATABASE_URL missing");

const br = await call(`${BRIDGE}/health`);
check("bridge is up with delegate keys enabled", br.status === 200 && br.body?.delegates === true,
    br.status ? `agents=${br.body?.agents}` : "not reachable");

const keys = await call(`${BRIDGE}/mydata-keys`);
const bridgeKeyIds: string[] = (keys.body?.keys ?? []).map((k: any) => (typeof k === "string" ? k.split(":")[0] : k.id));
const chatKeyId = (chatEnv.VITE_AUTOMATION_MYDATA_KEY ?? "").split(":")[0];
check("chat-app encrypts to a key the bridge actually holds", Boolean(chatKeyId) && bridgeKeyIds.includes(chatKeyId),
    `chat-app=${chatKeyId || "none"} bridge=[${bridgeKeyIds.join(",")}]`);

const noSecret = await post(`${BRIDGE}/internal/memory/probe`, { key_ref: "x", account_id: "0x1" });
check("bridge rejects a request with no secret", noSecret.status === 401, `HTTP ${noSecret.status}`);
const withSecret = await post(`${BRIDGE}/internal/memory/probe`, { key_ref: "nonexistent", account_id: "0x1" }, secret);
check("bridge accepts the shared secret and reaches the key lookup (and the engine behind it)",
    withSecret.status === 404, `HTTP ${withSecret.status} ${JSON.stringify(withSecret.body).slice(0, 80)}`);

const jobs = await call(`${ENGINE}/v1/automation/jobs?account_id=0x1`, { headers: { "x-internal-sync-secret": secret } });
check("engine accepts the shared secret", jobs.status !== 401 && jobs.status !== 0, `HTTP ${jobs.status}`);

const keyServer = (memoryEnv.MYDATA_KEY_SERVERS ?? "").split(",")[0]?.trim();
const obj = await call(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "myso_getObject", params: [keyServer, {}] }),
});
check("MyData key server object exists on localnet", Boolean(obj.body?.result?.data), keyServer ? keyServer.slice(0, 12) + "…" : "MYDATA_KEY_SERVERS not set");

console.log(failed ? `\n${failed} check(s) failed` : "\nAll wiring checks passed.");
if (!failed) {
    console.log("\nLast mile (needs your wallet to sign), in the chat-app:");
    console.log("  1. Open an agent, then Automation, then create a delegate (24h, small spend cap).");
    console.log("  2. Create a job that recalls memory. Watch the engine log for a run that succeeds.");
}
process.exit(failed ? 1 : 0);
