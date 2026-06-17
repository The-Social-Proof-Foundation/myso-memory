import type { SocialChainConfig } from "../types.js";

export const MYSO_CLOCK =
    "0x0000000000000000000000000000000000000000000000000000000000000006";

export function postModuleTarget(
    config: SocialChainConfig,
    fn: string,
): string {
    return `${config.packageId}::post::${fn}`;
}

export function resolvePlatformObjectId(
    config: SocialChainConfig,
    override?: string,
): string {
    return override ?? config.platformObjectId;
}

export function optBool(tx: any, value: boolean | undefined): unknown {
    return value === undefined ? null : value;
}

export function optString(tx: any, value: string | undefined): unknown {
    return value === undefined ? null : value;
}

export function optAddress(tx: any, value: string | undefined): unknown {
    return value === undefined ? null : value;
}

export function optAddressVec(tx: any, values: string[] | undefined): unknown {
    if (!values || values.length === 0) return null;
    return values;
}

export function optStringVec(tx: any, values: string[] | undefined): unknown {
    if (!values || values.length === 0) return null;
    return values;
}
