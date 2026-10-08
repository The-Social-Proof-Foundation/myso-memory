/**
 * Sealed-box tests. These are the contract the browser implementation must
 * meet: anything the chat-app seals has to open here, and nothing sealed for
 * one row may open under another.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import {
    SealError,
    SealKeyRing,
    generateSealKeyPair,
    openSealed,
    publicKeyFor,
    sealAad,
    sealSeed,
} from "./seal.js";

const AAD = sealAad("0xAccount", "nightly", "0xAgent");

describe("seal / open", () => {
    it("round-trips a seed", () => {
        const { privateKey, publicKey } = generateSealKeyPair();
        const seed = randomBytes(32);
        const envelope = sealSeed(seed, publicKey, AAD);
        assert.deepEqual(openSealed(envelope, privateKey, AAD), seed);
    });

    it("derives the public key from the private key", () => {
        const { privateKey, publicKey } = generateSealKeyPair();
        assert.deepEqual(publicKeyFor(privateKey), publicKey);
    });

    it("never produces the same envelope twice", () => {
        const { publicKey } = generateSealKeyPair();
        const seed = randomBytes(32);
        assert.notEqual(sealSeed(seed, publicKey, AAD), sealSeed(seed, publicKey, AAD));
    });

    it("does not contain the seed in the envelope", () => {
        const { publicKey } = generateSealKeyPair();
        const seed = randomBytes(32);
        const raw = Buffer.from(sealSeed(seed, publicKey, AAD), "base64url");
        assert.equal(raw.includes(seed), false);
    });

    it("refuses another recipient's key", () => {
        const a = generateSealKeyPair();
        const b = generateSealKeyPair();
        const envelope = sealSeed(randomBytes(32), a.publicKey, AAD);
        assert.throws(() => openSealed(envelope, b.privateKey, AAD), SealError);
    });

    it("refuses a row it was not sealed for", () => {
        const { privateKey, publicKey } = generateSealKeyPair();
        const envelope = sealSeed(randomBytes(32), publicKey, AAD);
        // Copied under another account, name or agent: must not open.
        for (const other of [
            sealAad("0xOther", "nightly", "0xAgent"),
            sealAad("0xAccount", "weekly", "0xAgent"),
            sealAad("0xAccount", "nightly", "0xOtherAgent"),
        ]) {
            assert.throws(() => openSealed(envelope, privateKey, other), SealError);
        }
    });

    it("treats ids as equal across case and zero padding", () => {
        const { privateKey, publicKey } = generateSealKeyPair();
        const seed = randomBytes(32);
        const envelope = sealSeed(seed, publicKey, sealAad("0x00ABC", "n", "0x0DEF"));
        assert.deepEqual(openSealed(envelope, privateKey, sealAad("0xabc", "n", "0xdef")), seed);
    });

    it("detects tampering and truncation", () => {
        const { privateKey, publicKey } = generateSealKeyPair();
        const raw = Buffer.from(sealSeed(randomBytes(32), publicKey, AAD), "base64url");
        const flipped = Buffer.from(raw);
        flipped[flipped.length - 1] ^= 0x01;
        assert.throws(() => openSealed(flipped.toString("base64url"), privateKey, AAD), SealError);
        assert.throws(() => openSealed(raw.subarray(0, 40).toString("base64url"), privateKey, AAD), SealError);
        assert.throws(() => openSealed("", privateKey, AAD), SealError);
        assert.throws(() => openSealed("not base64 at all!!", privateKey, AAD), SealError);
    });

    it("rejects an unknown envelope version", () => {
        const { privateKey, publicKey } = generateSealKeyPair();
        const raw = Buffer.from(sealSeed(randomBytes(32), publicKey, AAD), "base64url");
        raw[0] = 9;
        assert.throws(() => openSealed(raw.toString("base64url"), privateKey, AAD), SealError);
    });

    it("fails with one generic message that reveals nothing", () => {
        const { privateKey, publicKey } = generateSealKeyPair();
        const envelope = sealSeed(randomBytes(32), publicKey, AAD);
        const messages = new Set<string>();
        for (const attempt of [
            () => openSealed(envelope, generateSealKeyPair().privateKey, AAD),
            () => openSealed(envelope, privateKey, sealAad("0x1", "x", "0x2")),
            () => openSealed("", privateKey, AAD),
        ]) {
            try {
                attempt();
            } catch (e) {
                messages.add((e as Error).message);
            }
        }
        assert.equal(messages.size, 1);
    });

    it("only seals 32-byte seeds", () => {
        const { publicKey } = generateSealKeyPair();
        assert.throws(() => sealSeed(randomBytes(31), publicKey, AAD), SealError);
    });
});

describe("SealKeyRing", () => {
    it("opens by key id and rotates across several keys", () => {
        const old = generateSealKeyPair();
        const next = generateSealKeyPair();
        const ring = SealKeyRing.parse(
            `old:${old.privateKey.toString("base64url")},new:${next.privateKey.toString("base64url")}`,
        );
        const seed = randomBytes(32);
        assert.deepEqual(ring.open("old", sealSeed(seed, old.publicKey, AAD), AAD), seed);
        assert.deepEqual(ring.open("new", sealSeed(seed, next.publicKey, AAD), AAD), seed);
        assert.throws(() => ring.open("missing", sealSeed(seed, next.publicKey, AAD), AAD), SealError);
        // The id must match the key it was sealed to.
        assert.throws(() => ring.open("old", sealSeed(seed, next.publicKey, AAD), AAD), SealError);
    });

    it("publishes public halves only", () => {
        const pair = generateSealKeyPair();
        const ring = SealKeyRing.parse(`k1:${pair.privateKey.toString("base64url")}`);
        const published = JSON.stringify(ring.publicKeys());
        assert.ok(published.includes(pair.publicKey.toString("base64url")));
        assert.equal(published.includes(pair.privateKey.toString("base64url")), false);
    });

    it("rejects malformed entries without echoing the key text", () => {
        for (const bad of ["", "nokey", ":abc", "k1:short", "bad id:" + "A".repeat(43)]) {
            try {
                SealKeyRing.parse(bad);
                assert.fail(`expected ${JSON.stringify(bad)} to be rejected`);
            } catch (e) {
                assert.ok(e instanceof SealError);
                assert.equal((e as Error).message.includes("A".repeat(20)), false);
            }
        }
    });
});
