/**
 * Memory CLIENT — Server-side Memory SDK wrapper
 *
 * Creates per-request Memory instances using the authenticated user's
 * delegate key (from tRPC context). Falls back to env vars for backward
 * compatibility.
 */

import { Memory } from "@socialproof/memory";

/**
 * Create a Memory client for a specific user's delegate key.
 * Called per-request with credentials from tRPC context.
 */
export function createMemoryClient(key: string, accountId: string): Memory {
  return Memory.create({
    key,
    accountId,
    serverUrl: process.env.MEMORY_SERVER_URL || "http://localhost:8000",
  });
}

/**
 * Get a Memory client using provided credentials or env var fallback.
 * Throws if no key is available.
 */
export function getMemoryClient(
  key?: string | null,
  accountId?: string | null,
): Memory {
  const resolvedKey = key || process.env.MEMORY_KEY;
  const resolvedAccountId = accountId || process.env.MEMORY_ACCOUNT_ID;

  if (!resolvedKey) {
    throw new Error("[Memory] No key configured — sign in with Enoki or set MEMORY_KEY in .env");
  }
  if (!resolvedAccountId) {
    throw new Error("[Memory] No accountId configured — sign in with Enoki or set MEMORY_ACCOUNT_ID in .env");
  }

  return createMemoryClient(resolvedKey, resolvedAccountId);
}

/** Extract memories from text using Memory analyze endpoint. */
export async function extractMemories(
  _userId: string,
  text: string,
  key?: string | null,
  accountId?: string | null,
): Promise<string[]> {
  try {
    const memory = getMemoryClient(key, accountId);
    const result = await memory.analyze(text);
    return (result.facts ?? []).map((f) => f.text);
  } catch (error) {
    console.error("[extractMemories] Error:", error);
    return [];
  }
}

/** Remember a single text — server handles embed + encrypt + store. */
export async function rememberText(
  text: string,
  key?: string | null,
  accountId?: string | null,
) {
  const memory = getMemoryClient(key, accountId);
  return memory.remember(text);
}

/** Recall memories similar to a query — server handles search + decrypt. */
export async function recallMemories(
  query: string,
  limit = 10,
  key?: string | null,
  accountId?: string | null,
) {
  const memory = getMemoryClient(key, accountId);
  return memory.recall(query, limit);
}
