import fs from "node:fs";
import type { OpenClawConfig } from "../../config/config.js";
import { type SessionEntry, updateSessionStoreEntry } from "../../config/sessions.js";
import type { MemoryCortexConfig } from "../../config/types.infrastructure.js";
import { logVerbose } from "../../globals.js";
import { hybridSearch, ingest, recall, type MemoryCortexFact } from "./memory-cortex-client.js";
import type { FollowupRun } from "./queue.js";

// ── Types ───────────────────────────────────────────────────────────────

export type MemoryCortexRecallResult = {
  memoryContext: string | null;
  factsCount: number;
};

// ── Config helper ───────────────────────────────────────────────────────

function resolveMemoryCortexConfig(cfg: OpenClawConfig): MemoryCortexConfig | undefined {
  const mc = cfg.infrastructure?.memoryCortex;
  if (!mc?.enabled) {
    return undefined;
  }
  return mc;
}

// ── Format helpers ──────────────────────────────────────────────────────

function formatFactsAsContext(
  facts: MemoryCortexFact[],
  maxTokens: number,
  cachedSynthesis?: { response: string; cachedAt: number } | null,
  synthesisCacheTtlMs?: number,
): string {
  if (facts.length === 0 && !cachedSynthesis) {
    return "";
  }

  // Sort: importance desc, then score desc
  const sorted = [...facts].toSorted((a, b) => {
    const impA = a.importance ?? 0;
    const impB = b.importance ?? 0;
    if (impB !== impA) {
      return impB - impA;
    }
    const sA = a.score ?? 0;
    const sB = b.score ?? 0;
    return sB - sA;
  });

  const lines: string[] = ["## Long-Term Memories", ""];

  // Include cached synthesis if fresh
  const ttl = synthesisCacheTtlMs ?? 300_000; // 5 min default
  if (cachedSynthesis?.response && Date.now() - cachedSynthesis.cachedAt < ttl) {
    lines.push(`**Summary (from previous context):** ${cachedSynthesis.response}`);
    lines.push("");
  }

  if (sorted.length > 0) {
    lines.push("**Individual facts:**");
    for (const fact of sorted) {
      const topic = fact.topic ? `[${fact.topic}]` : "[general]";
      const imp = fact.importance !== undefined ? ` (importance: ${fact.importance})` : "";
      const line = `- ${topic} ${fact.fact}${imp}`;
      lines.push(line);
    }
  }

  const block = lines.join("\n");

  // Cap at maxTokens (rough estimate: 4 chars per token)
  const maxChars = maxTokens * 4;
  if (block.length > maxChars) {
    return block.slice(0, maxChars);
  }

  return block;
}

// ── Session message reader ──────────────────────────────────────────────

type SimplifiedMessage = {
  role: string;
  content: string;
  name?: string;
};

function readSessionMessagesForIngestion(sessionFile: string): SimplifiedMessage[] {
  let raw: string;
  try {
    raw = fs.readFileSync(sessionFile, "utf-8");
  } catch {
    logVerbose(`[memory-cortex] could not read session file: ${sessionFile}`);
    return [];
  }

  const messages: SimplifiedMessage[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("type" in parsed) ||
      (parsed as { type: unknown }).type !== "message"
    ) {
      continue;
    }

    const msg = (parsed as { message?: unknown }).message;
    if (typeof msg !== "object" || msg === null) {
      continue;
    }

    const role = (msg as { role?: unknown }).role;
    if (typeof role !== "string") {
      continue;
    }

    const rawContent = (msg as { content?: unknown }).content;
    let content: string;

    if (typeof rawContent === "string") {
      content = rawContent;
    } else if (Array.isArray(rawContent)) {
      // Extract text from content blocks
      content = rawContent
        .filter(
          (block: unknown) =>
            typeof block === "object" &&
            block !== null &&
            (block as { type?: string }).type === "text",
        )
        .map((block: { text?: string }) => block.text ?? "")
        .join("\n");
    } else {
      continue;
    }

    if (!content) {
      continue;
    }

    const name = (msg as { name?: unknown }).name;
    const entry: SimplifiedMessage = { role, content };
    if (typeof name === "string" && name) {
      entry.name = name;
    }
    messages.push(entry);
  }

  return messages;
}

// ── Async synthesis (fire-and-forget for next turn) ─────────────────────

function fireAsyncSynthesis(
  mc: MemoryCortexConfig,
  query: string,
  userId: string | undefined,
  sessionKey: string,
  storePath: string,
): void {
  recall(mc, query, userId)
    .then(async (result) => {
      if (!result?.response) {
        return;
      }

      try {
        await updateSessionStoreEntry({
          storePath,
          sessionKey,
          update: async () => ({
            memoryCortexSynthesis: {
              query,
              response: result.response,
              cachedAt: Date.now(),
            },
          }),
        });
      } catch (err) {
        logVerbose(`[memory-cortex] failed to cache synthesis: ${String(err)}`);
      }
    })
    .catch((err) => {
      logVerbose(`[memory-cortex] async synthesis failed: ${String(err)}`);
    });
}

// ── runMemoryCortexRecall (called BEFORE LLM call) ──────────────────────

export async function runMemoryCortexRecall(params: {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  isHeartbeat: boolean;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  commandBody: string;
}): Promise<MemoryCortexRecallResult> {
  const noResult: MemoryCortexRecallResult = {
    memoryContext: null,
    factsCount: 0,
  };

  // Guard: config enabled + autoRecall
  const mc = resolveMemoryCortexConfig(params.cfg);
  if (!mc?.autoRecall) {
    return noResult;
  }

  // Guard: skip heartbeat unless explicitly allowed
  if (params.isHeartbeat && mc.skipHeartbeat !== false) {
    return noResult;
  }

  // Guard: skip empty / trivially short queries
  const query = params.commandBody?.trim() ?? "";
  if (query.length < 3) {
    return noResult;
  }

  // Perform hybrid search with configured timeout
  const searchResult = await hybridSearch(
    mc,
    query,
    params.followupRun.run.senderName,
    mc.recallMaxFacts ?? 15,
    mc.recallTimeoutMs ?? 200,
  );

  const facts = searchResult?.results ?? [];
  const factsCount = facts.length;

  if (factsCount === 0) {
    logVerbose("[memory-cortex] recall returned 0 facts, skipping context injection");
  }

  // Check for cached synthesis from previous turn
  const cachedSynthesis = params.sessionEntry?.memoryCortexSynthesis ?? null;

  // Format facts as context block
  const memoryContext =
    factsCount > 0 || cachedSynthesis
      ? formatFactsAsContext(
          facts,
          mc.recallMaxTokens ?? 500,
          cachedSynthesis,
          mc.synthesisCacheTtlMs,
        )
      : null;

  // Fire async synthesis in background for next turn (don't await)
  if (params.sessionKey && params.storePath && query.length >= 10) {
    fireAsyncSynthesis(
      mc,
      query,
      params.followupRun.run.senderName,
      params.sessionKey,
      params.storePath,
    );
  }

  // Update session entry with recall metadata
  if (params.storePath && params.sessionKey) {
    try {
      await updateSessionStoreEntry({
        storePath: params.storePath,
        sessionKey: params.sessionKey,
        update: async () => ({
          memoryCortexRecalledAt: Date.now(),
          memoryCortexFactsInjected: factsCount,
        }),
      });
    } catch (err) {
      logVerbose(`[memory-cortex] failed to persist recall metadata: ${String(err)}`);
    }
  }

  return {
    memoryContext: memoryContext || null,
    factsCount,
  };
}

// ── runMemoryCortexIngestionIfNeeded (called AFTER response) ────────────

export async function runMemoryCortexIngestionIfNeeded(params: {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  isHeartbeat: boolean;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  storePath?: string;
}): Promise<void> {
  // Guard: config enabled + autoIngest
  const mc = resolveMemoryCortexConfig(params.cfg);
  if (!mc?.autoIngest) {
    return;
  }

  // Guard: skip heartbeat unless explicitly allowed
  if (params.isHeartbeat && mc.skipHeartbeat !== false) {
    return;
  }

  // Need session file to read conversation history
  const sessionFile = params.sessionEntry?.sessionFile;
  if (!sessionFile) {
    logVerbose("[memory-cortex] no session file for ingestion, skipping");
    return;
  }

  // Read the full conversation from the session JSONL file
  const messages = readSessionMessagesForIngestion(sessionFile);
  if (messages.length === 0) {
    logVerbose("[memory-cortex] no messages to ingest, skipping");
    return;
  }

  // Fire-and-forget: POST to /ingest — NEVER block the caller
  ingest(
    mc,
    messages,
    params.followupRun.run.sessionId,
    params.followupRun.run.groupChannel ?? params.sessionEntry?.channel,
    params.followupRun.run.senderName,
  ).catch((err) => {
    logVerbose(`[memory-cortex] ingest fire-and-forget error: ${String(err)}`);
  });

  // Update session entry with ingest timestamp (also fire-and-forget)
  if (params.storePath && params.sessionKey) {
    updateSessionStoreEntry({
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      update: async () => ({
        memoryCortexIngestedAt: Date.now(),
      }),
    }).catch((err) => {
      logVerbose(`[memory-cortex] failed to persist ingest metadata: ${String(err)}`);
    });
  }
}
