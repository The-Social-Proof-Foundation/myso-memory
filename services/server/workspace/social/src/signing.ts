export function hexToBytes(hex: string): Uint8Array {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    if (clean.length % 2 !== 0) {
        throw new Error("Invalid hex string");
    }
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}

export function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

export async function sha256hex(data: string): Promise<string> {
    const bytes = new TextEncoder().encode(data);
    if (typeof globalThis.crypto?.subtle?.digest === "function") {
        const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", bytes);
        return Array.from(new Uint8Array(hashBuf))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
    }
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(bytes).digest("hex");
}

export function normalizeServerUrl(url: string): string {
    return url.endsWith("/") ? url : `${url}/`;
}
