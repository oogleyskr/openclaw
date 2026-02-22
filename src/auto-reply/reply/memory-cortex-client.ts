import type { MemoryCortexConfig } from "../../config/types.infrastructure.js";
import { logVerbose } from "../../globals.js";

// ── Types ──────────────────────────────────────────────────────────────

export type MemoryCortexFact = {
  id: number;
  user_id?: string;
  topic?: string;
  fact: string;
  importance?: number;
  created_at?: number;
  score?: number;
  source?: string;
};

export type HybridSearchResult = {
  results: MemoryCortexFact[];
  count: number;
};

export type RecallResult = {
  response: string;
  memories_searched: number;
  memories_used: number;
};

// ── Helper ─────────────────────────────────────────────────────────────

function buildBaseUrl(config: MemoryCortexConfig): string {
  const host = config.middlewareHost ?? "localhost";
  const port = config.middlewarePort ?? 8300;
  return `http://${host}:${port}`;
}

// ── hybridSearch (critical-path, tight timeout) ────────────────────────

export async function hybridSearch(
  config: MemoryCortexConfig,
  query: string,
  userId?: string,
  limit?: number,
  timeoutMs?: number,
): Promise<HybridSearchResult | null> {
  const url = `${buildBaseUrl(config)}/hybrid-search`;
  const ms = timeoutMs ?? 200;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, user_id: userId, limit }),
      signal: controller.signal,
    });

    if (!res.ok) {
      logVerbose(`[memory-cortex] hybridSearch bad status ${res.status}`);
      return null;
    }

    return (await res.json()) as HybridSearchResult;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logVerbose(`[memory-cortex] hybridSearch failed: ${msg}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── recall (async synthesis, generous timeout) ─────────────────────────

export async function recall(
  config: MemoryCortexConfig,
  query: string,
  userId?: string,
): Promise<RecallResult | null> {
  const url = `${buildBaseUrl(config)}/recall`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, user_id: userId }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      logVerbose(`[memory-cortex] recall bad status ${res.status}`);
      return null;
    }

    return (await res.json()) as RecallResult;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logVerbose(`[memory-cortex] recall failed: ${msg}`);
    return null;
  }
}

// ── ingest (fire-and-forget) ───────────────────────────────────────────

export async function ingest(
  config: MemoryCortexConfig,
  messages: unknown[],
  sessionId?: string,
  channel?: string,
  userId?: string,
): Promise<void> {
  const url = `${buildBaseUrl(config)}/ingest`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        session_id: sessionId,
        channel,
        user_id: userId,
        debounce: true,
      }),
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      logVerbose(`[memory-cortex] ingest bad status ${res.status}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logVerbose(`[memory-cortex] ingest failed: ${msg}`);
  }
}
