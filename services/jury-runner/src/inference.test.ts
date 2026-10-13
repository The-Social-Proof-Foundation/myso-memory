import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InferenceError, OpenAiCompatibleClient } from "./inference.js";

function client(fetchImpl: typeof fetch) {
    return new OpenAiCompatibleClient({ url: "https://llm.example.com/v1", apiKey: "k", model: "m", timeoutMs: 1_000, fetchImpl });
}

describe("OpenAiCompatibleClient", () => {
    it("posts a deterministic JSON-mode chat request and returns the content", async () => {
        let seen: { url: string; body: Record<string, unknown>; auth: string | null } | undefined;
        const fetchImpl = (async (url: string, init: RequestInit) => {
            seen = {
                url,
                body: JSON.parse(String(init.body)) as Record<string, unknown>,
                auth: new Headers(init.headers).get("authorization"),
            };
            return Response.json({ choices: [{ message: { content: '{"a":1}' } }] });
        }) as unknown as typeof fetch;
        const out = await client(fetchImpl).completeJson({ system: "S", user: "U" });
        assert.equal(out, '{"a":1}');
        assert.equal(seen?.url, "https://llm.example.com/v1/chat/completions");
        assert.equal(seen?.auth, "Bearer k");
        assert.equal(seen?.body.temperature, 0);
        assert.deepEqual(seen?.body.response_format, { type: "json_object" });
        assert.deepEqual(seen?.body.messages, [
            { role: "system", content: "S" },
            { role: "user", content: "U" },
        ]);
    });

    it("fails on an error status, an empty reply, and a network error", async () => {
        const make = (response: () => Response | Promise<Response>) => client((async () => response()) as unknown as typeof fetch);
        await assert.rejects(make(() => new Response("no", { status: 500 })).completeJson({ system: "", user: "" }), InferenceError);
        await assert.rejects(make(() => Response.json({ choices: [] })).completeJson({ system: "", user: "" }), /no content/);
        await assert.rejects(
            make(() => Response.json({ choices: [{ message: { content: "  " } }] })).completeJson({ system: "", user: "" }),
            /no content/,
        );
        await assert.rejects(
            client((async () => {
                throw new Error("offline");
            }) as unknown as typeof fetch).completeJson({ system: "", user: "" }),
            /offline/,
        );
    });
});
