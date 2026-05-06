import "server-only";

import { Memory } from "@socialproof/memory";
import type { RememberResult } from "@socialproof/memory";
import type { Citation, SourceMeta } from "./types";

function getMemoryClient(key: string, accountId?: string) {
  return Memory.create({
    key,
    accountId: accountId || process.env.MEMORY_ACCOUNT_ID!,
    serverUrl: process.env.MEMORY_SERVER_URL,
  });
}

export async function rememberSprintReport({
  key,
  accountId,
  title,
  content,
  citations,
  sources,
}: {
  key: string;
  accountId?: string;
  title: string;
  content: string;
  citations: Citation[];
  sources: SourceMeta[];
}): Promise<RememberResult> {
  const memory = getMemoryClient(key, accountId);

  const references = citations
    .map(
      (c) =>
        `[${c.refIndex}] ${c.sourceTitle} — ${c.section} (${c.sourceUrl ?? "no url"})`
    )
    .join("\n");

  const sourceList = sources
    .map((s) => `${s.title ?? "Untitled"} (${s.url ?? "no url"})`)
    .join(", ");

  const fullText =
    `Sprint Report: ${title}\n\n` +
    `${content}\n\n` +
    `References:\n${references}\n\n` +
    `Sources: ${sourceList}`;

  console.log(
    `[sprint:memory] Storing sprint report (${fullText.length} chars)`
  );
  const result = await memory.remember(fullText);
  console.log(`[sprint:memory] Stored. blobId=${result.blob_id}`);
  return result;
}

export async function recallFromMemory(
  key: string,
  query: string,
  limit: number = 5,
  accountId?: string
) {
  const memory = getMemoryClient(key, accountId);
  const { results } = await memory.recall(query, limit);
  return results.map((r) => ({
    text: r.text,
    relevance: 1 - r.distance,
  }));
}
