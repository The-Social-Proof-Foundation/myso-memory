/**
 * The engine signs every webhook: `x-myso-signature: v1=<hex>` is HMAC-SHA256 over
 * `"<x-myso-timestamp>.<raw body>"` with the job's secret. The runner verifies the raw bytes (never
 * a re-serialized body), compares in constant time, and refuses a timestamp outside a short
 * window. The engine retries one delivery under the same `delivery_id`, so replay protection is the
 * directive cache's job, not a reason to reject a repeat here.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

export type SignatureFailure = "missing" | "malformed" | "stale" | "mismatch";

export function signatureFor(secret: string, timestampSeconds: number, rawBody: Uint8Array): string {
    const mac = createHmac("sha256", secret);
    mac.update(`${timestampSeconds}.`);
    mac.update(rawBody);
    return `v1=${mac.digest("hex")}`;
}

/** `null` when the request is authentic, else why it is not. */
export function checkSignature(
    secret: string,
    timestampHeader: string | undefined,
    signatureHeader: string | undefined,
    rawBody: Uint8Array,
    nowMs: number,
    windowMs = SIGNATURE_WINDOW_MS,
): SignatureFailure | null {
    if (!timestampHeader || !signatureHeader) return "missing";
    if (!/^[0-9]{1,12}$/.test(timestampHeader) || !/^v1=[0-9a-f]{64}$/.test(signatureHeader)) {
        return "malformed";
    }
    const timestamp = Number(timestampHeader);
    if (Math.abs(nowMs - timestamp * 1000) > windowMs) return "stale";
    const expected = Buffer.from(signatureFor(secret, timestamp, rawBody));
    const provided = Buffer.from(signatureHeader);
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return "mismatch";
    return null;
}
