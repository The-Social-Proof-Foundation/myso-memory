/**
 * Encrypted-envelope tests. These are the contract the browser implementation must
 * meet: anything the chat-app encrypts has to open here, and nothing encrypted for
 * one row may open under another.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import {
    DelegateCryptoError,
    MyDataKeyRing,
    generateMyDataKeyPair,
    decryptSeed,
    publicKeyFor,
    delegateAad,
    encryptSeed,
} from "./delegate-crypto.js";

const AAD = delegateAad("0xAccount", "nightly", "0xAgent");

describe("encrypt / open", () => {
    it("round-trips a seed", () => {
        const { privateKey, publicKey } = generateMyDataKeyPair();
        const seed = randomBytes(32);
        const envelope = encryptSeed(seed, publicKey, AAD);
        assert.deepEqual(decryptSeed(envelope, privateKey, AAD), seed);
    });

    it("derives the public key from the private key", () => {
        const { privateKey, publicKey } = generateMyDataKeyPair();
        assert.deepEqual(publicKeyFor(privateKey), publicKey);
    });

    it("never produces the same envelope twice", () => {
        const { publicKey } = generateMyDataKeyPair();
        const seed = randomBytes(32);
        assert.notEqual(encryptSeed(seed, publicKey, AAD), encryptSeed(seed, publicKey, AAD));
    });

    it("does not contain the seed in the envelope", () => {
        const { publicKey } = generateMyDataKeyPair();
        const seed = randomBytes(32);
        const raw = Buffer.from(encryptSeed(seed, publicKey, AAD), "base64url");
        assert.equal(raw.includes(seed), false);
    });

    it("refuses another recipient's key", () => {
        const a = generateMyDataKeyPair();
        const b = generateMyDataKeyPair();
        const envelope = encryptSeed(randomBytes(32), a.publicKey, AAD);
        assert.throws(() => decryptSeed(envelope, b.privateKey, AAD), DelegateCryptoError);
    });

    it("refuses a row it was not encrypted for", () => {
        const { privateKey, publicKey } = generateMyDataKeyPair();
        const envelope = encryptSeed(randomBytes(32), publicKey, AAD);
        // Copied under another account, name or agent: must not open.
        for (const other of [
            delegateAad("0xOther", "nightly", "0xAgent"),
            delegateAad("0xAccount", "weekly", "0xAgent"),
            delegateAad("0xAccount", "nightly", "0xOtherAgent"),
        ]) {
            assert.throws(() => decryptSeed(envelope, privateKey, other), DelegateCryptoError);
        }
    });

    it("treats ids as equal across case and zero padding", () => {
        const { privateKey, publicKey } = generateMyDataKeyPair();
        const seed = randomBytes(32);
        const envelope = encryptSeed(seed, publicKey, delegateAad("0x00ABC", "n", "0x0DEF"));
        assert.deepEqual(decryptSeed(envelope, privateKey, delegateAad("0xabc", "n", "0xdef")), seed);
    });

    it("detects tampering and truncation", () => {
        const { privateKey, publicKey } = generateMyDataKeyPair();
        const raw = Buffer.from(encryptSeed(randomBytes(32), publicKey, AAD), "base64url");
        const flipped = Buffer.from(raw);
        flipped[flipped.length - 1] ^= 0x01;
        assert.throws(() => decryptSeed(flipped.toString("base64url"), privateKey, AAD), DelegateCryptoError);
        assert.throws(() => decryptSeed(raw.subarray(0, 40).toString("base64url"), privateKey, AAD), DelegateCryptoError);
        assert.throws(() => decryptSeed("", privateKey, AAD), DelegateCryptoError);
        assert.throws(() => decryptSeed("not base64 at all!!", privateKey, AAD), DelegateCryptoError);
    });

    it("rejects an unknown envelope version", () => {
        const { privateKey, publicKey } = generateMyDataKeyPair();
        const raw = Buffer.from(encryptSeed(randomBytes(32), publicKey, AAD), "base64url");
        raw[0] = 9;
        assert.throws(() => decryptSeed(raw.toString("base64url"), privateKey, AAD), DelegateCryptoError);
    });

    it("fails with one generic message that reveals nothing", () => {
        const { privateKey, publicKey } = generateMyDataKeyPair();
        const envelope = encryptSeed(randomBytes(32), publicKey, AAD);
        const messages = new Set<string>();
        for (const attempt of [
            () => decryptSeed(envelope, generateMyDataKeyPair().privateKey, AAD),
            () => decryptSeed(envelope, privateKey, delegateAad("0x1", "x", "0x2")),
            () => decryptSeed("", privateKey, AAD),
        ]) {
            try {
                attempt();
            } catch (e) {
                messages.add((e as Error).message);
            }
        }
        assert.equal(messages.size, 1);
    });

    it("only encrypts 32-byte seeds", () => {
        const { publicKey } = generateMyDataKeyPair();
        assert.throws(() => encryptSeed(randomBytes(31), publicKey, AAD), DelegateCryptoError);
    });
});

describe("MyDataKeyRing", () => {
    it("opens by key id and rotates across several keys", () => {
        const old = generateMyDataKeyPair();
        const next = generateMyDataKeyPair();
        const ring = MyDataKeyRing.parse(
            `old:${old.privateKey.toString("base64url")},new:${next.privateKey.toString("base64url")}`,
        );
        const seed = randomBytes(32);
        assert.deepEqual(ring.open("old", encryptSeed(seed, old.publicKey, AAD), AAD), seed);
        assert.deepEqual(ring.open("new", encryptSeed(seed, next.publicKey, AAD), AAD), seed);
        assert.throws(() => ring.open("missing", encryptSeed(seed, next.publicKey, AAD), AAD), DelegateCryptoError);
        // The id must match the key it was encrypted to.
        assert.throws(() => ring.open("old", encryptSeed(seed, next.publicKey, AAD), AAD), DelegateCryptoError);
    });

    it("publishes public halves only", () => {
        const pair = generateMyDataKeyPair();
        const ring = MyDataKeyRing.parse(`k1:${pair.privateKey.toString("base64url")}`);
        const published = JSON.stringify(ring.publicKeys());
        assert.ok(published.includes(pair.publicKey.toString("base64url")));
        assert.equal(published.includes(pair.privateKey.toString("base64url")), false);
    });

    it("rejects malformed entries without echoing the key text", () => {
        for (const bad of ["", "nokey", ":abc", "k1:short", "bad id:" + "A".repeat(43)]) {
            try {
                MyDataKeyRing.parse(bad);
                assert.fail(`expected ${JSON.stringify(bad)} to be rejected`);
            } catch (e) {
                assert.ok(e instanceof DelegateCryptoError);
                assert.equal((e as Error).message.includes("A".repeat(20)), false);
            }
        }
    });
});
