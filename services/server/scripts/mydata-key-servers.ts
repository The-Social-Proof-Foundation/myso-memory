/**
 * Resolves the MYDATA key-server object ids the sidecar encrypts and decrypts against.
 *
 * `MYDATA_KEY_SERVERS` is an operator pin, and a pin goes stale whenever a local chain is
 * regenesised: the object id no longer exists, so every encrypt fails with
 * `ObjectError: Object 0x… does not exist`. This mirrors the relayer's chain discovery
 * (`src/chain_discovery.rs`): a pin is kept while the fullnode proves it live, and only on
 * localnet is a stale pin replaced from GraphQL. Remote networks keep pins authoritative and
 * fail closed, so an indexer response can never silently redirect where keys are fetched from.
 */

/** `key_server::KeyServer` lives in the `mydata` framework package, published at 0xda7a locally. */
export const DEFAULT_MYDATA_PACKAGE_ID = "0xda7a";

export function normalizeObjectId(id: string): string {
    const hex = id.trim().toLowerCase().replace(/^0x/, "");
    return `0x${hex.padStart(64, "0")}`;
}

export function isKeyServerType(actual: string | null | undefined, packageId: string): boolean {
    if (!actual) return false;
    const [pkg, module, name, ...rest] = actual.split("::");
    return (
        rest.length === 0 &&
        module === "key_server" &&
        name === "KeyServer" &&
        normalizeObjectId(pkg) === normalizeObjectId(packageId)
    );
}

export function keyServerDiscoveryQuery(packageId: string): string {
    return `query MydataKeyServerDiscovery { keyServers: objects(filter: { type: "${normalizeObjectId(
        packageId,
    )}::key_server::KeyServer" }, last: 10) { nodes { address } } }`;
}

export interface KeyServerResolverDeps {
    /** Move type of the object, or null when it does not exist on the fullnode. */
    getObjectType: (objectId: string) => Promise<string | null>;
    /** POST a GraphQL query and return the parsed `data` object. */
    queryGraphql: (url: string, query: string) => Promise<unknown>;
}

export interface ResolveKeyServersOptions {
    configured: string[];
    network: string;
    graphqlUrl?: string;
    packageId?: string;
}

export interface ResolvedKeyServers {
    ids: string[];
    source: "configured" | "discovered";
    /** Configured pins the fullnode could not find (or that are the wrong type). */
    stale: string[];
}

export async function resolveKeyServers(
    options: ResolveKeyServersOptions,
    deps: KeyServerResolverDeps,
): Promise<ResolvedKeyServers> {
    const packageId = options.packageId || DEFAULT_MYDATA_PACKAGE_ID;
    const live: string[] = [];
    const stale: string[] = [];
    for (const id of options.configured) {
        const type = await deps.getObjectType(id).catch(() => null);
        (isKeyServerType(type, packageId) ? live : stale).push(id);
    }
    if (live.length > 0) return { ids: live, source: "configured", stale };

    // Nothing pinned is live. Only a local chain may re-resolve: after a regenesis the old ids
    // are provably gone, whereas on a remote network a missing pin is a misconfiguration.
    if (options.network !== "localnet" || !options.graphqlUrl) {
        return { ids: options.configured, source: "configured", stale };
    }

    const data = (await deps.queryGraphql(options.graphqlUrl, keyServerDiscoveryQuery(packageId))) as {
        keyServers?: { nodes?: { address?: string }[] };
    } | null;
    const candidates = [
        ...new Set(
            (data?.keyServers?.nodes ?? [])
                .map((node) => node.address)
                .filter((a): a is string => typeof a === "string")
                .map(normalizeObjectId),
        ),
    ];
    const discovered: string[] = [];
    for (const id of candidates) {
        const type = await deps.getObjectType(id).catch(() => null);
        if (isKeyServerType(type, packageId)) discovered.push(id);
    }
    if (discovered.length === 0) {
        return { ids: options.configured, source: "configured", stale };
    }
    return { ids: discovered, source: "discovered", stale };
}
