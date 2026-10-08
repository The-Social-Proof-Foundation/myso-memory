import assert from "node:assert/strict";
import test from "node:test";
import {
    isKeyServerType,
    keyServerDiscoveryQuery,
    normalizeObjectId,
    resolveKeyServers,
    type KeyServerResolverDeps,
} from "./mydata-key-servers.js";

const TYPE = `${normalizeObjectId("0xda7a")}::key_server::KeyServer`;
const OLD = normalizeObjectId("0xd3c0");
const NEW = normalizeObjectId("0xbeef");

function deps(live: Record<string, string>, graphql: string[] = []): KeyServerResolverDeps & { queries: string[] } {
    const queries: string[] = [];
    return {
        queries,
        getObjectType: async (id) => live[normalizeObjectId(id)] ?? null,
        queryGraphql: async (_url, query) => {
            queries.push(query);
            return { keyServers: { nodes: graphql.map((address) => ({ address })) } };
        },
    };
}

test("type check accepts short and padded package ids and rejects other types", () => {
    assert.ok(isKeyServerType("0xda7a::key_server::KeyServer", "0xda7a"));
    assert.ok(isKeyServerType(TYPE, "0xda7a"));
    assert.ok(!isKeyServerType("0xda7a::key_server::KeyServerV1", "0xda7a"));
    assert.ok(!isKeyServerType("0xother::key_server::KeyServer", "0xda7a"));
    assert.ok(!isKeyServerType(null, "0xda7a"));
});

test("a live pin is kept and no discovery query is made", async () => {
    const d = deps({ [OLD]: TYPE }, [NEW]);
    const out = await resolveKeyServers({ configured: [OLD], network: "localnet", graphqlUrl: "http://x" }, d);
    assert.deepEqual(out, { ids: [OLD], source: "configured", stale: [] });
    assert.equal(d.queries.length, 0);
});

test("a stale pin on localnet is replaced by the verified GraphQL result", async () => {
    const d = deps({ [NEW]: TYPE }, [NEW, normalizeObjectId("0xdead")]);
    const out = await resolveKeyServers({ configured: [OLD], network: "localnet", graphqlUrl: "http://x" }, d);
    assert.deepEqual(out, { ids: [NEW], source: "discovered", stale: [OLD] });
    assert.match(d.queries[0], /key_server::KeyServer/);
});

test("an empty pin list on localnet is discovered", async () => {
    const d = deps({ [NEW]: TYPE }, [NEW]);
    const out = await resolveKeyServers({ configured: [], network: "localnet", graphqlUrl: "http://x" }, d);
    assert.deepEqual(out.ids, [NEW]);
});

test("remote networks keep a stale pin authoritative and never query GraphQL", async () => {
    const d = deps({ [NEW]: TYPE }, [NEW]);
    const out = await resolveKeyServers({ configured: [OLD], network: "testnet", graphqlUrl: "http://x" }, d);
    assert.deepEqual(out, { ids: [OLD], source: "configured", stale: [OLD] });
    assert.equal(d.queries.length, 0);
});

test("GraphQL candidates the fullnode cannot verify are ignored", async () => {
    const d = deps({}, [NEW]);
    const out = await resolveKeyServers({ configured: [OLD], network: "localnet", graphqlUrl: "http://x" }, d);
    assert.deepEqual(out.ids, [OLD]);
    assert.equal(out.source, "configured");
});

test("discovery query targets the padded package id", () => {
    assert.ok(keyServerDiscoveryQuery("0xda7a").includes(`${normalizeObjectId("0xda7a")}::key_server::KeyServer`));
});
