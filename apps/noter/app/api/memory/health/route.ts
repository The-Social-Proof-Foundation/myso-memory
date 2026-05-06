/** Memory Health API — checks if Memory is configured and server is reachable. */

import { getMemoryClient } from "@/feature/note/lib/pdw-client";

export async function GET() {
  try {
    // Try with env fallback (no per-user key needed for health check)
    const memory = getMemoryClient();
    try {
      const health = await memory.health();
      return Response.json({ ...health, status: "ok" });
    } catch {
      return Response.json({ status: "ok", server: "unreachable" });
    }
  } catch (error) {
    return Response.json(
      { status: "not_configured", message: error instanceof Error ? error.message : "Memory not configured" },
      { status: 503 },
    );
  }
}
