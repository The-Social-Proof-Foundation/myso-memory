#!/usr/bin/env npx tsx
/**
 * Localnet end-to-end walkthrough:
 * profile → sub-agent registration → remember → recall
 *
 * Prerequisites: myso localnet + social indexer + memory-server running.
 *
 * Usage:
 *   MEMORY_SERVER_URL=http://127.0.0.1:8000 npx tsx scripts/localnet-walkthrough.ts
 */

import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dir, ".localnet-walkthrough-state.json");

const PACKAGE_ID = process.env.MEMORY_PACKAGE_ID ?? "0x50c1";
const USERNAME_REGISTRY =
    process.env.USERNAME_REGISTRY_ID ??
    "0x93b5179d87c744160265ff0ea96a003a81dd3271f9d5349a7458aa8794ea9fc1";
const MEMORY_REGISTRY =
    process.env.MEMORY_REGISTRY_ID ??
    "0xee405b83143252de2356095a3e35306d193ee7d440e8f481bd682b00ef07b157";
const CLOCK_ID = process.env.CLOCK_ID ?? "0x6";
const SERVER_URL = process.env.MEMORY_SERVER_URL ?? "http://127.0.0.1:8000";
const SOCIAL_URL = process.env.SOCIAL_SERVER_URL ?? "http://127.0.0.1:9126";
const RPC_URL = process.env.MYSO_RPC_URL ?? "http://127.0.0.1:9000";
const GAS = process.env.GAS_BUDGET ?? "1000000000";

interface WalkthroughState {
    accountId: string;
    agentObjectId: string;
    subAgentPrivateKey: string;
    derivedAddress: string;
}

function loadState(): WalkthroughState | null {
    if (!existsSync(STATE_FILE)) return null;
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as WalkthroughState;
}

function saveState(state: WalkthroughState): void {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function run(cmd: string): string {
    return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

function activeAddress(): string {
    return run("myso client active-address").trim();
}

async function importSdk() {
    const sdkRoot = join(__dir, "../../../packages/sdk/dist/index.js");
    const accountRoot = join(__dir, "../../../packages/sdk/dist/account-entry.js");
    const memoryMod = await import(sdkRoot);
    const accountMod = await import(accountRoot);
    return { Memory: memoryMod.Memory, ...accountMod };
}

function extractCreatedId(output: string, typeFragment: string): string {
    const jsonStart = output.indexOf("{");
    if (jsonStart === -1) return "";
    try {
        const parsed = JSON.parse(output.slice(jsonStart));
        for (const change of parsed.objectChanges ?? []) {
            if (change.type === "created" && change.objectType?.includes(typeFragment)) {
                return change.objectId;
            }
        }
        for (const change of parsed.changed_objects ?? []) {
            if (
                change.idOperation === "CREATED" &&
                change.objectType?.includes(typeFragment)
            ) {
                return change.objectId;
            }
        }
    } catch {
        /* fall through */
    }
    return "";
}

async function waitForSocialIndexer(derivedAddress: string): Promise<void> {
    for (let i = 0; i < 45; i++) {
        try {
            const resp = await fetch(`${SOCIAL_URL}/sub-agents/${derivedAddress}`);
            if (resp.ok) {
                console.log(`[setup] sub-agent indexed (attempt ${i + 1})`);
                return;
            }
        } catch {
            /* retry */
        }
        await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`Sub-agent ${derivedAddress} not indexed after 45s`);
}

async function main(): Promise<void> {
    const mods = await importSdk();
    let state = loadState();

    if (!state) {
        const owner = activeAddress();
        run(`myso client faucet --address ${owner}`);

        let accountId = process.env.WALKTHROUGH_ACCOUNT_ID ?? "";
        if (!accountId) {
            const suffix = Date.now().toString(36);
            console.log(`[setup] owner=${owner}`);

            try {
                const profileOut = run(
                    `myso client call --package ${PACKAGE_ID} --module profile --function create_profile ` +
                        `--args ${USERNAME_REGISTRY} ${MEMORY_REGISTRY} '"Walkthrough User"' '"walk${suffix}"' '"memory walkthrough"' '""' '""' ${CLOCK_ID} ` +
                        `--gas-budget ${GAS} --json`,
                );
                accountId = extractCreatedId(profileOut, "::memory::MemoryAccount");
            } catch (err) {
                const msg = String(err);
                if (!msg.includes("Abort Code: 0")) throw err;
                console.log("[setup] profile already exists — set WALKTHROUGH_ACCOUNT_ID to reuse");
                throw new Error(
                    "Owner already has a profile. Export MEMORY_ACCOUNT_ID from your profile " +
                        "and re-run with WALKTHROUGH_ACCOUNT_ID=<id>",
                );
            }
        } else {
            console.log(`[setup] using WALKTHROUGH_ACCOUNT_ID=${accountId}`);
        }

        if (!accountId) {
            throw new Error("Failed to resolve MemoryAccount object ID");
        }

        const agent = await mods.generateSubAgentKey();
        const keyJson = JSON.parse(
            run(`myso keytool export --key-identity ${owner} --json`),
        );
        const mysoPrivateKey = keyJson.exportedPrivateKey as string;

        const { MySoJsonRpcClient } = await import("@socialproof/myso/jsonRpc");
        const mysoClient = new MySoJsonRpcClient({ url: RPC_URL });

        const reg = await mods.registerSubAgent({
            packageId: PACKAGE_ID,
            accountId,
            publicKey: agent.publicKey,
            label: "walkthrough-agent",
            capabilities:
                mods.CAP_MEMORY_READ |
                mods.CAP_MEMORY_WRITE |
                mods.CAP_POST_PUBLISH |
                mods.CAP_COMMENT |
                mods.CAP_REACT,
            mysoPrivateKey,
            mysoClient,
        });

        if (!reg.agentObjectId) {
            throw new Error(`registerSubAgent did not return agentObjectId: ${JSON.stringify(reg)}`);
        }

        state = {
            accountId,
            agentObjectId: reg.agentObjectId,
            subAgentPrivateKey: agent.privateKey,
            derivedAddress: agent.derivedAddress,
        };
        saveState(state);
        console.log(`[setup] registered agent=${reg.agentObjectId}`);
        await waitForSocialIndexer(agent.derivedAddress);
    } else {
        console.log(`[setup] reusing cached state account=${state.accountId}`);
    }

    const memory = mods.Memory.create({
        key: state.subAgentPrivateKey,
        accountId: state.accountId,
        serverUrl: SERVER_URL,
    });

    console.log("[test] health...");
    const health = await memory.health();
    console.log(`  status=${health.status} version=${(health as { version?: string }).version ?? "?"}`);

    // Mock 1536-dim vector (server has no /api/embed route; matches mock embedding dim).
    const vector = Array.from({ length: 1536 }, (_, i) => ((i * 17) % 1000) / 1000);
    const blobId = `localnet-walkthrough-${Date.now()}`;
    console.log("[test] rememberManual (agent-scoped vector registration)...");
    const remembered = await memory.rememberManual({ blobId, vector });
    console.log(`  id=${remembered.id} namespace=${remembered.namespace}`);

    console.log("[test] recallManual...");
    const recalled = await memory.recallManual({ vector, limit: 5 });
    const hit = recalled.results.find((r) => r.blob_id === blobId);
    if (!hit) {
        throw new Error(
            `Manual recall missed blob. Results: ${JSON.stringify(recalled.results)}`,
        );
    }
    console.log(`  recalled blob=${hit.blob_id} distance=${hit.distance}`);

    if (process.env.FULL_E2E === "1") {
        const fact = `Walkthrough fact: favorite color is ultramarine (${Date.now()})`;
        console.log("[test] remember (full relayer + File Storage, async job)...");
        const accepted = await memory.remember(fact);
        console.log(`  job_id=${accepted.job_id} status=${accepted.status}`);
        const full = await memory.waitForRememberJob(accepted.job_id);
        console.log(`  done blob_id=${full.blob_id} agent=${full.agent_object_id}`);

        console.log("[test] recall (full decrypt path)...");
        const fullRecall = await memory.recall("favorite color ultramarine", 5);
        const fullHit = fullRecall.results.find((r) => r.text.includes("ultramarine"));
        if (!fullHit) {
            throw new Error(`Full recall missed fact: ${JSON.stringify(fullRecall.results)}`);
        }
        console.log(`  recalled: "${fullHit.text.slice(0, 80)}..."`);
    } else {
        console.log("[test] skipping full relayer path (set FULL_E2E=1 when File Storage is configured)");
    }

    if (process.env.SOCIAL_WALKTHROUGH === "1") {
        const { SocialClient } = await import("@socialproof/social");
        const platformId = process.env.PLATFORM_OBJECT_ID;
        if (!platformId) {
            console.log("[test] skipping social walkthrough (set PLATFORM_OBJECT_ID + bootstrap env on server)");
        } else {
            const social = SocialClient.create({
                key: state.subAgentPrivateKey,
                accountId: state.accountId,
                serverUrl: SERVER_URL,
                platformId,
            });
            const content = `Walkthrough social post ${Date.now()}`;
            console.log("[test] social createPost...");
            const posted = await social.createPost({ content });
            console.log(`  digest=${posted.digest} postId=${posted.postId ?? "?"}`);
            if (posted.postId) {
                console.log("[test] social reactToPost...");
                const reacted = await social.reactToPost({
                    postId: posted.postId,
                    reaction: "👍",
                });
                console.log(`  digest=${reacted.digest}`);
            }
        }
    } else {
        console.log("[test] skipping social (set SOCIAL_WALKTHROUGH=1 with server bootstrap env)");
    }

    console.log("\n✅ Localnet walkthrough passed");
}

main().catch((err) => {
    console.error("❌ Walkthrough failed:", err);
    process.exit(1);
});
