/**
 * Fetching evidence a party named. The link is attacker-controlled input, so this is where the
 * runner would turn into a way to reach internal services if it were careless: https only, the
 * default port, no credentials in the URL, no redirects, a size cap and a timeout, and the
 * connection pinned to an address that was checked after DNS resolution (so a name cannot answer
 * with a public address to the check and an internal one to the connection).
 */

import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";

export const MAX_EVIDENCE_BYTES = 256 * 1024;
export const EVIDENCE_TIMEOUT_MS = 8_000;

/** True for loopback, private, link-local (cloud metadata), CGNAT, test and reserved addresses. */
export function isBlockedAddress(address: string): boolean {
    const family = isIP(address);
    if (family === 4) {
        const [a, b, c] = address.split(".").map(Number) as [number, number, number, number];
        return (
            a === 0 ||
            a === 10 ||
            a === 127 ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 0 && (c === 0 || c === 2)) ||
            (a === 192 && b === 168) ||
            (a === 198 && (b === 18 || b === 19)) ||
            (a === 198 && b === 51 && c === 100) ||
            (a === 203 && b === 0 && c === 113) ||
            a >= 224
        );
    }
    if (family === 6) {
        const lower = address.toLowerCase();
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
        if (mapped) return isBlockedAddress(mapped[1]!);
        return (
            lower === "::" ||
            lower === "::1" ||
            lower.startsWith("fe8") ||
            lower.startsWith("fe9") ||
            lower.startsWith("fea") ||
            lower.startsWith("feb") ||
            lower.startsWith("fc") ||
            lower.startsWith("fd") ||
            lower.startsWith("ff") ||
            lower.startsWith("2001:db8")
        );
    }
    // Not an IP literal at all: not an address this function can judge.
    return true;
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

export function checkEvidenceUrl(raw: string, allowedHosts: readonly string[], ipfsGateway: string): UrlCheck {
    let text = raw.trim();
    if (text.startsWith("ipfs://")) {
        const path = text.slice("ipfs://".length);
        if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(path) || path.includes("..")) {
            return { ok: false, reason: "malformed ipfs link" };
        }
        text = `${ipfsGateway}${path}`;
    }
    let url: URL;
    try {
        url = new URL(text);
    } catch {
        return { ok: false, reason: "not a url" };
    }
    if (url.protocol !== "https:") return { ok: false, reason: "only https links are fetched" };
    if (url.username || url.password) return { ok: false, reason: "links with credentials are refused" };
    if (url.port && url.port !== "443") return { ok: false, reason: "only the default https port is used" };
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
        return { ok: false, reason: "internal host names are refused" };
    }
    if (isIP(host) && isBlockedAddress(host)) return { ok: false, reason: "address is private or reserved" };
    if (allowedHosts.length > 0 && !allowedHosts.includes(host)) {
        return { ok: false, reason: "host is not on the evidence allowlist" };
    }
    return { ok: true, url };
}

export type EvidenceResult = { ok: true; bytes: Buffer } | { ok: false; reason: string };

export interface EvidenceFetchDeps {
    allowedHosts: readonly string[];
    ipfsGateway: string;
    resolve?: (host: string) => Promise<Array<{ address: string; family: number }>>;
    transport?: (url: URL, address: { address: string; family: number }) => Promise<Buffer>;
    maxBytes?: number;
    timeoutMs?: number;
}

export async function fetchEvidence(raw: string, deps: EvidenceFetchDeps): Promise<EvidenceResult> {
    const checked = checkEvidenceUrl(raw, deps.allowedHosts, deps.ipfsGateway);
    if (!checked.ok) return checked;
    const { url } = checked;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    try {
        const resolve =
            deps.resolve ?? (async (name: string) => (await dnsLookup(name, { all: true })) as LookupAddress[]);
        const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host);
        if (addresses.length === 0) return { ok: false, reason: "host did not resolve" };
        // One blocked answer rejects the host: a name may return a public and an internal address.
        if (addresses.some((entry) => isBlockedAddress(entry.address))) {
            return { ok: false, reason: "host resolves to a private or reserved address" };
        }
        const transport =
            deps.transport ??
            ((target: URL, address: { address: string; family: number }) =>
                httpsGet(target, address, deps.maxBytes ?? MAX_EVIDENCE_BYTES, deps.timeoutMs ?? EVIDENCE_TIMEOUT_MS));
        const bytes = await transport(url, addresses[0]!);
        if (bytes.length > (deps.maxBytes ?? MAX_EVIDENCE_BYTES)) return { ok: false, reason: "evidence is too large" };
        return { ok: true, bytes };
    } catch (error) {
        return { ok: false, reason: `fetch failed: ${(error as Error).message}` };
    }
}

function httpsGet(
    url: URL,
    address: { address: string; family: number },
    maxBytes: number,
    timeoutMs: number,
): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const req = request(
            {
                protocol: "https:",
                host: url.hostname.replace(/^\[|\]$/g, ""),
                port: 443,
                path: `${url.pathname}${url.search}`,
                method: "GET",
                servername: url.hostname.replace(/^\[|\]$/g, ""),
                timeout: timeoutMs,
                headers: { accept: "*/*", "user-agent": "myso-jury-runner/1" },
                // Connect to the address that was checked, not to whatever the name says now.
                lookup: (_host, options, callback) => {
                    const entry = { address: address.address, family: address.family };
                    if ((options as { all?: boolean }).all) {
                        (callback as unknown as (e: null, a: unknown) => void)(null, [entry]);
                    } else {
                        callback(null, entry.address, entry.family);
                    }
                },
            },
            (res) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    reject(new Error(`status ${res.statusCode ?? "unknown"}`));
                    return;
                }
                const chunks: Buffer[] = [];
                let size = 0;
                res.on("data", (chunk: Buffer) => {
                    size += chunk.length;
                    if (size > maxBytes) {
                        req.destroy(new Error("evidence is too large"));
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on("end", () => resolve(Buffer.concat(chunks)));
                res.on("error", reject);
            },
        );
        req.on("timeout", () => req.destroy(new Error("timed out")));
        req.on("error", reject);
        req.end();
    });
}
