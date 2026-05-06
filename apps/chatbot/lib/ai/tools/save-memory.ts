import { tool } from "ai";
import { z } from "zod";
import { Memory } from "@socialproof/memory";

export const saveMemory = ({
  memoryKey,
  memoryAccountId,
}: {
  memoryKey?: string;
  memoryAccountId?: string;
}) =>
  tool({
    description:
      "Save information to the user's personal memory on the blockchain. ONLY use this tool when the user EXPLICITLY asks you to save or remember something (e.g., 'remember this', 'save this', 'lưu lại', 'nhớ giùm'). Do NOT use this tool proactively. Save the FULL, DETAILED content — do not summarize or shorten it.",
    inputSchema: z.object({
      text: z
        .string()
        .describe(
          "The full, detailed text to save to memory. Include all relevant details — do not summarize."
        ),
    }),
    execute: async ({ text }) => {
      const key = memoryKey || process.env.MEMORY_KEY;
      const accountId = memoryAccountId || process.env.MEMORY_ACCOUNT_ID;
      const serverUrl = process.env.MEMORY_SERVER_URL || "http://localhost:8000";

      if (!key || !accountId) {
        return {
          saved: false,
          text,
          error: "Memory not configured — MEMORY_KEY or MEMORY_ACCOUNT_ID missing",
        };
      }

      try {
        const memory = Memory.create({ key, accountId, serverUrl });
        await memory.remember(text);
        return { saved: true, text };
      } catch (error) {
        console.error("[Tool] saveMemory error:", error);
        return {
          saved: false,
          text,
          error: error instanceof Error ? error.message : "Failed to save memory",
        };
      }
    },
  });
