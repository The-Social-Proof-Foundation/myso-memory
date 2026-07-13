import { sha256hex } from "../signing.js";
import type { Sha256Digest } from "./types.js";

function canonicalize(value: unknown, ancestors: Set<object>): string {
    if (value === null) return "null";
    if (typeof value === "string" || typeof value === "boolean") {
        return JSON.stringify(value);
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new TypeError("Canonical JSON does not support non-finite numbers");
        }
        return JSON.stringify(value);
    }

    if (typeof value !== "object") {
        throw new TypeError(`Canonical JSON does not support ${typeof value}`);
    }
    if (ancestors.has(value)) {
        throw new TypeError("Canonical JSON does not support cyclic values");
    }

    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            return `[${value.map((item) => canonicalize(item, ancestors)).join(",")}]`;
        }

        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError("Canonical JSON only supports plain objects");
        }

        const record = value as Record<string, unknown>;
        const entries = Object.keys(record)
            .sort()
            .map(
                (key) =>
                    `${JSON.stringify(key)}:${canonicalize(record[key], ancestors)}`,
            );
        return `{${entries.join(",")}}`;
    } finally {
        ancestors.delete(value);
    }
}

/** Canonical JSON with recursively sorted object keys and strict JSON values. */
export function canonicalizeActionParameters(value: unknown): string {
    return canonicalize(value, new Set());
}

export async function hashActionParameters(value: unknown): Promise<Sha256Digest> {
    const hash = await sha256hex(canonicalizeActionParameters(value));
    return `sha256:${hash}`;
}

export function isSha256Digest(value: string): value is Sha256Digest {
    return /^sha256:[a-f0-9]{64}$/.test(value);
}
