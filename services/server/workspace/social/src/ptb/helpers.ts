import type { SocialChainConfig } from "../types.js";

export const MYSO_CLOCK =
    "0x0000000000000000000000000000000000000000000000000000000000000006";

/**
 * The shared `Random` object. Hard-coded, never a parameter: a draw must read the network's
 * randomness and nothing a caller supplies.
 */
export const MYSO_RANDOM =
    "0x0000000000000000000000000000000000000000000000000000000000000008";

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
    return tx.pure("option<bool>", value ?? null);
}

export function optString(tx: any, value: string | undefined): unknown {
    return tx.pure("option<string>", value ?? null);
}

export function optAddress(tx: any, value: string | undefined): unknown {
    return tx.pure("option<address>", value ?? null);
}

export function optAddressVec(tx: any, values: string[] | undefined): unknown {
    return tx.pure(
        "option<vector<address>>",
        values && values.length > 0 ? values : null,
    );
}

export function optStringVec(tx: any, values: string[] | undefined): unknown {
    return tx.pure(
        "option<vector<string>>",
        values && values.length > 0 ? values : null,
    );
}

export function optU8(tx: any, value: number | undefined): unknown {
    return tx.pure("option<u8>", value ?? null);
}

export function optU64(tx: any, value: number | undefined): unknown {
    return tx.pure("option<u64>", value ?? null);
}
