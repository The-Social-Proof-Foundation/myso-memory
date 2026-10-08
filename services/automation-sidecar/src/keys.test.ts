/**
 * Key resolution tests — the boundary where a job's `target_agent_key_ref`
 * becomes real credentials, so the rejection cases matter as much as the happy
 * path.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
    AgentKeyStore,
    KeyStoreError,
    normalizeSeed,
    parseAgentKeyFile,
} from "./keys.js";

const SEED = "a".repeat(64);
const OTHER_SEED = "b".repeat(64);
const ACCOUNT = "0xabc123";

const tempDirs: string[] = [];
function keyFile(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), "automation-sidecar-keys-"));
    tempDirs.push(dir);
    const file = join(dir, "agents.json");
    writeFileSync(file, contents, "utf8");
    return file;
}

after(() => {
    // Temp files are cheap; leaving them avoids an fs-race on Windows and CI.
});

describe("normalizeSeed", () => {
    it("accepts a bare 64-digit seed and lowercases it", () => {
        assert.equal(normalizeSeed("A".repeat(64), "t"), SEED);
    });

    it("accepts a 0x-prefixed seed", () => {
        assert.equal(normalizeSeed(`0x${SEED}`, "t"), SEED);
    });

    it("rejects a 32-byte-looking short key", () => {
        assert.throws(
            () => normalizeSeed("a".repeat(63), "t"),
            (err: unknown) => err instanceof KeyStoreError && err.code === "invalid_entry",
        );
    });

    it("rejects a 64-byte expanded key", () => {
        assert.throws(() => normalizeSeed("a".repeat(128), "t"), KeyStoreError);
    });

    it("rejects non-hex characters", () => {
        assert.throws(() => normalizeSeed("z".repeat(64), "t"), KeyStoreError);
    });

    it("rejects non-strings", () => {
        assert.throws(() => normalizeSeed(12345, "t"), KeyStoreError);
    });
});

describe("parseAgentKeyFile", () => {
    it("parses a bare ref map", () => {
        const entries = parseAgentKeyFile(
            JSON.stringify({ "agent-1": { key: SEED, accountId: ACCOUNT } }),
            "test",
        );
        assert.equal(entries.size, 1);
        assert.equal(entries.get("agent-1")?.accountId, ACCOUNT);
    });

    it("parses the {agents: {...}} wrapper", () => {
        const entries = parseAgentKeyFile(
            JSON.stringify({
                version: 1,
                agents: { "agent-1": { key: SEED, accountId: ACCOUNT } },
            }),
            "test",
        );
        assert.deepEqual([...entries.keys()], ["agent-1"]);
    });

    it("rejects an entry with no accountId", () => {
        assert.throws(
            () =>
                parseAgentKeyFile(
                    JSON.stringify({ "agent-1": { key: SEED } }),
                    "test",
                ),
            (err: unknown) =>
                err instanceof KeyStoreError &&
                err.code === "invalid_entry" &&
                err.message.includes("accountId"),
        );
    });

    it("rejects an empty ref map", () => {
        assert.throws(() => parseAgentKeyFile("{}", "test"), KeyStoreError);
    });

    it("rejects malformed JSON", () => {
        assert.throws(
            () => parseAgentKeyFile("{not json", "test"),
            (err: unknown) => err instanceof KeyStoreError && err.code === "file_invalid",
        );
    });

    it("rejects an array", () => {
        assert.throws(() => parseAgentKeyFile("[]", "test"), KeyStoreError);
    });
});

describe("AgentKeyStore", () => {
    const missingServerUrlConfig = {
        defaultNamespace: "chat-app",
    };

    it("applies the namespace default when the entry omits one", () => {
        const file = keyFile(JSON.stringify({ "a": { key: SEED, accountId: ACCOUNT } }));
        const store = new AgentKeyStore({
            file,
            defaultServerUrl: "http://127.0.0.1:8000",
            defaultNamespace: "chat-app",
        });
        store.reload();
        const resolved = store.resolve("a");
        assert.equal(resolved.namespace, "chat-app");
        assert.equal(resolved.serverUrl, "http://127.0.0.1:8000");
        assert.equal(resolved.key, SEED);
    });

    it("lets an entry override namespace and serverUrl", () => {
        const file = keyFile(
            JSON.stringify({
                a: {
                    key: SEED,
                    accountId: ACCOUNT,
                    namespace: "private-org",
                    serverUrl: "https://memory.example.com",
                },
            }),
        );
        const store = new AgentKeyStore({
            file,
            defaultServerUrl: "http://127.0.0.1:8000",
            defaultNamespace: "chat-app",
        });
        store.reload();
        const resolved = store.resolve("a");
        assert.equal(resolved.namespace, "private-org");
        assert.equal(resolved.serverUrl, "https://memory.example.com");
    });

    it("rejects an unknown ref without listing what is registered", () => {
        const file = keyFile(
            JSON.stringify({
                a: { key: SEED, accountId: ACCOUNT },
                b: { key: OTHER_SEED, accountId: ACCOUNT },
            }),
        );
        const store = new AgentKeyStore({
            file,
            defaultServerUrl: "http://127.0.0.1:8000",
            defaultNamespace: "chat-app",
        });
        store.reload();
        assert.throws(
            () => store.resolve("nope"),
            (err: unknown) =>
                err instanceof KeyStoreError &&
                err.code === "unknown_ref" &&
                err.message.includes("nope") &&
                // Enumerating refs would leak other tenants' agent names.
                !err.message.includes("a, b"),
        );
    });

    it("reports no_server_url when neither the entry nor the default provides one", () => {
        const file = keyFile(JSON.stringify({ a: { key: SEED, accountId: ACCOUNT } }));
        const store = new AgentKeyStore({ file, ...missingServerUrlConfig });
        store.reload();
        assert.throws(
            () => store.resolve("a"),
            (err: unknown) => err instanceof KeyStoreError && err.code === "no_server_url",
        );
    });

    it("fails with file_missing for a path that does not exist", () => {
        const store = new AgentKeyStore({
            file: "/nonexistent/definitely/not/here.json",
            defaultServerUrl: "http://127.0.0.1:8000",
            defaultNamespace: "chat-app",
        });
        assert.throws(
            () => store.reload(),
            (err: unknown) => err instanceof KeyStoreError && err.code === "file_missing",
        );
    });

    it("never exposes key material through listRefs", () => {
        const file = keyFile(JSON.stringify({ a: { key: SEED, accountId: ACCOUNT } }));
        const store = new AgentKeyStore({
            file,
            defaultServerUrl: "http://127.0.0.1:8000",
            defaultNamespace: "chat-app",
        });
        store.reload();
        assert.deepEqual(store.listRefs(), ["a"]);
        assert.ok(!JSON.stringify(store.listRefs()).includes(SEED));
    });
});

describe("inline key source", () => {
    const INLINE = JSON.stringify({ agents: { a: { key: SEED, accountId: ACCOUNT } } });

    it("resolves from inline JSON with no file on disk", () => {
        const store = new AgentKeyStore({
            inlineJson: INLINE,
            defaultServerUrl: "http://127.0.0.1:8000",
            defaultNamespace: "chat-app",
        });
        store.reload();
        assert.equal(store.isInline, true);
        assert.deepEqual(store.listRefs(), ["a"]);
        assert.equal(store.resolve("a").accountId, ACCOUNT);
    });

    it("does not touch the filesystem when keys are inline", () => {
        // A path that cannot exist: if the inline branch ever stat()s it, this
        // test fails rather than passing by accident on a machine that has it.
        const store = new AgentKeyStore({
            file: "/nonexistent/definitely/not/here.json",
            inlineJson: INLINE,
            defaultServerUrl: "http://127.0.0.1:8000",
            defaultNamespace: "chat-app",
        });
        store.reload();
        assert.equal(store.size(), 1);
        assert.equal(store.resolve("a").namespace, "chat-app");
    });

    it("still rejects an unknown ref", () => {
        const store = new AgentKeyStore({
            inlineJson: INLINE,
            defaultServerUrl: "http://127.0.0.1:8000",
            defaultNamespace: "chat-app",
        });
        store.reload();
        assert.throws(
            () => store.resolve("ghost"),
            (err: unknown) => err instanceof KeyStoreError && err.code === "unknown_ref",
        );
    });

    it("rejects a malformed inline value on reload", () => {
        const store = new AgentKeyStore({
            inlineJson: "{not json",
            defaultServerUrl: "http://127.0.0.1:8000",
            defaultNamespace: "chat-app",
        });
        assert.throws(() => store.reload(), KeyStoreError);
    });

    it("refuses to construct with no key source at all", () => {
        // Guarantees a misconfigured deploy fails at boot rather than serving a
        // bridge that can resolve nothing.
        assert.throws(
            () => new AgentKeyStore({ defaultNamespace: "chat-app" }),
            (err: unknown) => err instanceof KeyStoreError && err.code === "file_missing",
        );
    });

    it("reports the env var name, not a path, when inline keys are malformed", () => {
        const store = new AgentKeyStore({
            inlineJson: "{oops",
            defaultNamespace: "chat-app",
        });
        assert.throws(
            () => store.reload(),
            (err: unknown) =>
                err instanceof KeyStoreError && err.message.includes("AUTOMATION_AGENT_KEYS_JSON"),
        );
    });
});
