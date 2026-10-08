/**
 * Delegate source tests: fetching a encrypted row from the engine and opening it.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import { BridgeError } from "./bridge-error.js";
import { EngineDelegateSource } from "./delegates.js";
import { MyDataKeyRing, generateMyDataKeyPair, delegateAad, encryptSeed } from "./delegate-crypto.js";

const pair = generateMyDataKeyPair();
const keyring = MyDataKeyRing.parse(`k1:${pair.privateKey.toString("base64url")}`);
const SECRET = "engine-secret";

function sourceWith(respond: (url: string, init: RequestInit) => Response) {
    const calls: Array<{ url: string; secret?: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({
            url: String(url),
            secret: (init.headers as Record<string, string>)["x-internal-sync-secret"],
        });
        return respond(String(url), init);
    }) as unknown as typeof fetch;
    return {
        source: new EngineDelegateSource({
            engineUrl: "http://engine.internal:8010/",
            secret: SECRET,
            keyring,
            fetchImpl,
        }),
        calls,
    };
}

function row(seed: Buffer, account: string, ref: string, agent: string, keyId = "k1") {
    return {
        agent_object_id: agent,
        mydata_key_id: keyId,
        encrypted_key: encryptSeed(seed, pair.publicKey, delegateAad(account, ref, agent)),
    };
}

describe("EngineDelegateSource", () => {
    it("fetches the encrypted row and opens it", async () => {
        const seed = randomBytes(32);
        const { source, calls } = sourceWith(() => Response.json(row(seed, "0xacct", "nightly", "0xAGENT")));
        const opened = await source.open("0xacct", "nightly");

        assert.equal(opened.seedHex, seed.toString("hex"));
        assert.equal(opened.agentObjectId, "agent");
        assert.equal(calls[0]?.secret, SECRET);
        assert.equal(
            calls[0]?.url,
            "http://engine.internal:8010/v1/automation/delegates/key?account_id=0xacct&delegate_ref=nightly",
        );
    });

    it("hits the engine on every open, so a deleted row stops working at once", async () => {
        let hits = 0;
        const seed = randomBytes(32);
        const { source } = sourceWith(() => {
            hits += 1;
            return Response.json(row(seed, "0xacct", "n", "0xagent"));
        });
        await source.open("0xacct", "n");
        await source.open("0xacct", "n");
        assert.equal(hits, 2);
    });

    it("reports a missing row exactly like an unknown ref", async () => {
        const { source } = sourceWith(() => new Response("", { status: 404 }));
        const err = await source.open("0xacct", "ghost").catch((e: unknown) => e as BridgeError);
        assert.ok(err instanceof BridgeError);
        assert.equal(err.status, 404);
        assert.equal(err.code, "key_store:unknown_ref");
    });

    it("refuses a row encrypted for a different account", async () => {
        // A ciphertext copied into someone else's row must not open there.
        const seed = randomBytes(32);
        const { source } = sourceWith(() => Response.json(row(seed, "0xvictim", "n", "0xagent")));
        const err = await source.open("0xattacker", "n").catch((e: unknown) => e as BridgeError);
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, "delegate_unreadable");
    });

    it("refuses a row encrypted to an unknown key id", async () => {
        const seed = randomBytes(32);
        const { source } = sourceWith(() => Response.json(row(seed, "0xacct", "n", "0xagent", "retired")));
        const err = await source.open("0xacct", "n").catch((e: unknown) => e as BridgeError);
        assert.equal((err as BridgeError).code, "delegate_unreadable");
    });

    it("never leaks the seed or the envelope in an error", async () => {
        const seed = randomBytes(32);
        const encryptedRow = row(seed, "0xvictim", "n", "0xagent");
        const { source } = sourceWith(() => Response.json(encryptedRow));
        const err = await source.open("0xattacker", "n").catch((e: unknown) => e as BridgeError);
        const text = `${(err as BridgeError).message} ${(err as BridgeError).code}`;
        assert.equal(text.includes(seed.toString("hex")), false);
        assert.equal(text.includes(encryptedRow.encrypted_key), false);
    });

    it("maps an engine outage to a retryable 502", async () => {
        const down = sourceWith(() => {
            throw new Error("refused");
        });
        let err = await down.source.open("0xacct", "n").catch((e: unknown) => e as BridgeError);
        assert.equal((err as BridgeError).status, 502);

        const broken = sourceWith(() => new Response("x", { status: 500 }));
        err = await broken.source.open("0xacct", "n").catch((e: unknown) => e as BridgeError);
        assert.equal((err as BridgeError).status, 502);

        const malformed = sourceWith(() => Response.json({ nope: true }));
        err = await malformed.source.open("0xacct", "n").catch((e: unknown) => e as BridgeError);
        assert.equal((err as BridgeError).status, 502);
    });
});
