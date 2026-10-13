import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkEvidenceUrl, fetchEvidence, isBlockedAddress } from "./safe-fetch.js";

const GATEWAY = "https://ipfs.example.com/ipfs/";

describe("isBlockedAddress", () => {
    it("blocks private, loopback, link-local and reserved IPv4", () => {
        for (const ip of [
            "0.0.0.0", "10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
            "192.168.1.1", "100.64.0.1", "198.18.0.1", "203.0.113.9", "224.0.0.1", "255.255.255.255",
        ]) {
            assert.equal(isBlockedAddress(ip), true, ip);
        }
        for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.0.1", "100.63.0.1", "93.184.216.34"]) {
            assert.equal(isBlockedAddress(ip), false, ip);
        }
    });

    it("blocks the private and mapped forms of IPv6", () => {
        for (const ip of ["::1", "::", "fe80::1", "fd00::1", "fc00::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:169.254.169.254"]) {
            assert.equal(isBlockedAddress(ip), true, ip);
        }
        assert.equal(isBlockedAddress("2606:4700:4700::1111"), false);
        assert.equal(isBlockedAddress("::ffff:8.8.8.8"), false);
    });

    it("treats anything that is not an IP literal as unjudgeable, so blocked", () => {
        assert.equal(isBlockedAddress("example.com"), true);
        assert.equal(isBlockedAddress(""), true);
    });
});

describe("checkEvidenceUrl", () => {
    it("accepts an https link on a public host", () => {
        const result = checkEvidenceUrl("https://files.example.com/a/b.txt?x=1", [], GATEWAY);
        assert.equal(result.ok, true);
    });

    it("maps an ipfs link through the gateway", () => {
        const result = checkEvidenceUrl("ipfs://bafyabc/doc.txt", [], GATEWAY);
        assert.ok(result.ok && result.url.href === "https://ipfs.example.com/ipfs/bafyabc/doc.txt");
        assert.equal(checkEvidenceUrl("ipfs://../etc/passwd", [], GATEWAY).ok, false);
        assert.equal(checkEvidenceUrl("ipfs://", [], GATEWAY).ok, false);
    });

    it("refuses everything that could reach an internal service", () => {
        for (const link of [
            "http://example.com/a",
            "ftp://example.com/a",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://user:pass@example.com/a",
            "https://example.com:8443/a",
            "https://localhost/a",
            "https://app.localhost/a",
            "https://box.local/a",
            "https://svc.internal/a",
            "https://127.0.0.1/a",
            "https://169.254.169.254/latest/meta-data",
            "https://[::1]/a",
            "https://10.1.2.3/a",
            "not a url",
        ]) {
            assert.equal(checkEvidenceUrl(link, [], GATEWAY).ok, false, link);
        }
    });

    it("holds to an allowlist when one is set", () => {
        assert.equal(checkEvidenceUrl("https://files.example.com/a", ["files.example.com"], GATEWAY).ok, true);
        assert.equal(checkEvidenceUrl("https://evil.example.com/a", ["files.example.com"], GATEWAY).ok, false);
    });
});

describe("fetchEvidence", () => {
    const base = { allowedHosts: [], ipfsGateway: GATEWAY };

    it("fetches through the transport from a checked address", async () => {
        let seen: { address: string } | undefined;
        const result = await fetchEvidence("https://files.example.com/a", {
            ...base,
            resolve: async () => [{ address: "93.184.216.34", family: 4 }],
            transport: async (_url, address) => {
                seen = address;
                return Buffer.from("hello");
            },
        });
        assert.deepEqual(result.ok && result.bytes.toString(), "hello");
        assert.equal(seen?.address, "93.184.216.34");
    });

    it("rejects a host that resolves to an internal address, even alongside a public one", async () => {
        let called = false;
        const result = await fetchEvidence("https://files.example.com/a", {
            ...base,
            resolve: async () => [
                { address: "93.184.216.34", family: 4 },
                { address: "10.0.0.5", family: 4 },
            ],
            transport: async () => {
                called = true;
                return Buffer.alloc(0);
            },
        });
        assert.equal(result.ok, false);
        assert.equal(called, false);
    });

    it("rejects a host that does not resolve and one that is too large or fails", async () => {
        assert.equal((await fetchEvidence("https://x.example.com/a", { ...base, resolve: async () => [] })).ok, false);
        const big = await fetchEvidence("https://x.example.com/a", {
            ...base,
            maxBytes: 4,
            resolve: async () => [{ address: "93.184.216.34", family: 4 }],
            transport: async () => Buffer.alloc(10),
        });
        assert.deepEqual(big, { ok: false, reason: "evidence is too large" });
        const failing = await fetchEvidence("https://x.example.com/a", {
            ...base,
            resolve: async () => [{ address: "93.184.216.34", family: 4 }],
            transport: async () => {
                throw new Error("boom");
            },
        });
        assert.equal(failing.ok, false);
    });

    it("never resolves or connects when the link itself is refused", async () => {
        let resolved = false;
        const result = await fetchEvidence("http://files.example.com/a", {
            ...base,
            resolve: async () => {
                resolved = true;
                return [];
            },
        });
        assert.equal(result.ok, false);
        assert.equal(resolved, false);
    });
});
