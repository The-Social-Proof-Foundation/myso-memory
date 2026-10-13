import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SIGNATURE_WINDOW_MS, checkSignature, signatureFor } from "./signature.js";

const SECRET = "a-webhook-secret-of-16+";
const NOW = 1_800_000_000_000;
const TS = Math.floor(NOW / 1000);
const BODY = Buffer.from('{"delivery_id":"d1"}');

describe("webhook signature", () => {
    it("accepts a request the engine signed", () => {
        assert.equal(checkSignature(SECRET, String(TS), signatureFor(SECRET, TS, BODY), BODY, NOW), null);
    });

    it("rejects a different body, secret or timestamp", () => {
        const signature = signatureFor(SECRET, TS, BODY);
        assert.equal(checkSignature(SECRET, String(TS), signature, Buffer.from('{"delivery_id":"d2"}'), NOW), "mismatch");
        assert.equal(checkSignature("another-secret-of-16+", String(TS), signature, BODY, NOW), "mismatch");
        // A captured signature does not carry over to a new timestamp.
        assert.equal(checkSignature(SECRET, String(TS + 1), signature, BODY, NOW), "mismatch");
    });

    it("rejects a missing, malformed or stale request", () => {
        const signature = signatureFor(SECRET, TS, BODY);
        assert.equal(checkSignature(SECRET, undefined, signature, BODY, NOW), "missing");
        assert.equal(checkSignature(SECRET, String(TS), undefined, BODY, NOW), "missing");
        assert.equal(checkSignature(SECRET, "yesterday", signature, BODY, NOW), "malformed");
        assert.equal(checkSignature(SECRET, String(TS), "v2=abc", BODY, NOW), "malformed");
        assert.equal(checkSignature(SECRET, String(TS), signature.toUpperCase(), BODY, NOW), "malformed");
        const old = TS - SIGNATURE_WINDOW_MS / 1000 - 1;
        assert.equal(checkSignature(SECRET, String(old), signatureFor(SECRET, old, BODY), BODY, NOW), "stale");
        const future = TS + SIGNATURE_WINDOW_MS / 1000 + 1;
        assert.equal(checkSignature(SECRET, String(future), signatureFor(SECRET, future, BODY), BODY, NOW), "stale");
    });

    it("does not reject a repeat of the same delivery: the engine retries it", () => {
        const signature = signatureFor(SECRET, TS, BODY);
        assert.equal(checkSignature(SECRET, String(TS), signature, BODY, NOW), null);
        assert.equal(checkSignature(SECRET, String(TS), signature, BODY, NOW + 1_000), null);
    });
});
