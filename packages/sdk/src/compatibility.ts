import type { RelayerVersionMetadata } from "./types.js";

export const MEMORY_TYPESCRIPT_COMPATIBILITY_VERSION = "0.6.0";
export const SUPPORTED_RELAYER_API_MAJOR = 1;

export class MemoryCompatibilityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MemoryCompatibilityError";
    }
}

export function assertCompatibleRelayer(
    metadata: Partial<RelayerVersionMetadata>,
    serverUrl: string,
): asserts metadata is RelayerVersionMetadata {
    if (
        !metadata.apiVersion ||
        !metadata.relayerVersion ||
        !metadata.minSupportedSdk ||
        typeof metadata.minSupportedSdk !== "object"
    ) {
        throw new MemoryCompatibilityError(
            `Memory relayer at ${serverUrl} does not expose compatibility metadata. ` +
                "Upgrade the relayer to a version that serves GET /version, or use an older SDK.",
        );
    }

    const apiMajor = semverMajor(metadata.apiVersion);
    if (apiMajor === null) {
        throw new MemoryCompatibilityError(
            `Memory relayer at ${serverUrl} returned invalid apiVersion "${metadata.apiVersion}".`,
        );
    }

    if (apiMajor !== SUPPORTED_RELAYER_API_MAJOR) {
        throw new MemoryCompatibilityError(
            `This Memory TypeScript SDK supports relayer API ${SUPPORTED_RELAYER_API_MAJOR}.x, ` +
                `but ${serverUrl} reports apiVersion ${metadata.apiVersion}. ` +
                "Upgrade or downgrade the SDK/relayer pair.",
        );
    }

    const minSdk = metadata.minSupportedSdk.typescript;
    if (!minSdk) {
        throw new MemoryCompatibilityError(
            `Memory relayer at ${serverUrl} did not report minSupportedSdk.typescript.`,
        );
    }
    if (compareSemver(MEMORY_TYPESCRIPT_COMPATIBILITY_VERSION, minSdk) < 0) {
        throw new MemoryCompatibilityError(
            `Memory relayer at ${serverUrl} requires TypeScript SDK >= ${minSdk}, ` +
                `but this SDK supports the ${MEMORY_TYPESCRIPT_COMPATIBILITY_VERSION} ` +
                "compatibility baseline. Upgrade @socialproof/memory or use an older compatible relayer.",
        );
    }
}

export function compatibilityErrorFromStatus(
    status: number,
    body: string,
): MemoryCompatibilityError | null {
    if (status !== 426) return null;

    return new MemoryCompatibilityError(
        "Memory relayer rejected this SDK as unsupported (HTTP 426 Upgrade Required). " +
            `SDK compatibility baseline: ${MEMORY_TYPESCRIPT_COMPATIBILITY_VERSION}. ` +
            `Relayer response: ${body.slice(0, 300) || "upgrade required"}`,
    );
}

function semverMajor(version: string): number | null {
    const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
    return match ? Number(match[1]) : null;
}

function compareSemver(a: string, b: string): number {
    const left = parseSemver(a);
    const right = parseSemver(b);
    if (!left || !right) {
        throw new Error(`invalid semver comparison: ${a} vs ${b}`);
    }

    for (let idx = 0; idx < 3; idx += 1) {
        if (left[idx] !== right[idx]) return left[idx] - right[idx];
    }
    return 0;
}

function parseSemver(version: string): [number, number, number] | null {
    const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}
