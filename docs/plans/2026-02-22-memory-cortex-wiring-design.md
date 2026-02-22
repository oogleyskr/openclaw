# Memory Cortex Auto-Wiring Design

**Date:** 2026-02-22
**Status:** Approved
**Approach:** Agent Runner Integration (Approach B)

## Problem

Memory Cortex is a fully built middleware (825 LOC Python, Qwen3-8B on Radeon VII, SQLite+FTS5) that extracts facts from conversations and recalls them on demand. It works — but nothing automatically feeds conversations into it or retrieves memories during responses. Only 9 facts exist from manual testing.

## Decisions

| Decision       | Choice                              | Rationale                                                               |
| -------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| Search type    | FTS5 + vector (hybrid)              | Best of both: keyword precision + semantic understanding                |
| Ingest trigger | After every turn                    | Middleware's 30s debounce handles rapid exchanges                       |
| Recall scope   | Every turn                          | FTS5 is millisecond-fast, vector search ~50-100ms                       |
| Failure mode   | Silent skip                         | Log warning, continue without memory. Non-critical dependency.          |
| Architecture   | Agent runner integration            | Full session context, mirrors existing memory flush pattern             |
| Recall format  | Hybrid: raw facts + async synthesis | Raw facts for current turn (<200ms), LLM synthesis cached for next turn |
| History scope  | Full session history                | Send entire session to /ingest for richer fact extraction               |
| Heartbeat      | Skip                                | Don't ingest/recall for heartbeat/cron sessions                         |

## Architecture

### Auto-Ingestion (after response)

```
Response finalized (assistantTexts[] available)
    |
    v
runMemoryCortexIngestionIfNeeded(sessionEntry, followupRun)
    |
    v
Guards: memoryCortex.enabled? autoIngest? not heartbeat?
    |
    v
Build messages array from FULL session history
  (all user + assistant messages in current session)
    |
    v
Fire-and-forget: POST http://localhost:8300/ingest
  {
    messages: [...full history...],
    session_id: sessionEntry.key,
    channel: followupRun.channelName,
    user_id: followupRun.senderName,
    debounce: true
  }
    |
    v
Update sessionEntry.memoryCortexIngestedAt = Date.now()
Don't await -- 5s timeout, log errors, never block response
```

### Auto-Recall (before LLM call)

#### Immediate Path (<200ms, current turn)

```
User message arrives, session context loaded
    |
    v
runMemoryCortexRecall(sessionEntry, followupRun)
    |
    v
Guards: memoryCortex.enabled? autoRecall? not heartbeat?
    |
    v
POST http://localhost:8300/hybrid-search
  { query: userMessage, user_id: sender, limit: 15 }
    |
    v
Format results as context block:
  "## Long-Term Memories\n\n" +
  facts sorted by score, capped at ~500 tokens
    |
    v
Check: cached synthesis from previous turn?
  If recent (<5 min) and topic-relevant, append it
    |
    v
Inject into conversation as system-level context
    |
    v
200ms hard timeout -- if exceeded, skip silently
```

#### Async Path (next-turn enrichment)

```
After raw facts injected and LLM call starts:
    |
    v
Fire background task:
  POST http://localhost:8300/recall
    { query: userMessage, user_id: sender }
    |
    v
Qwen3-8B synthesizes narrative from matching memories
    |
    v
Cache in session entry:
  sessionEntry.memoryCortexSynthesis = {
    query: userMessage,
    response: "synthesized text...",
    cachedAt: Date.now()
  }
```

Next turn checks for cached synthesis. If recent and topically relevant, includes it alongside new raw facts. Otherwise discards stale cache.

## Vector Search Upgrade (Middleware)

### New Endpoint: POST /hybrid-search

```json
// Request
{
  "query": "what programming languages does oogley use",
  "user_id": "oogley",
  "limit": 10
}

// Response
{
  "results": [
    {
      "id": 42,
      "user_id": "oogley",
      "topic": "preferences",
      "fact": "Prefers Rust for systems programming",
      "importance": 8,
      "score": 0.87,
      "source": "fts5+vector"
    }
  ],
  "count": 5
}
```

### Implementation

1. Add `embedding` BLOB column to `memories` table
2. On `/ingest` (after fact extraction), compute embeddings via nomic-embed (port 8105) and store
3. `/hybrid-search` does:
   - FTS5 keyword search -> normalize scores to 0-1
   - Embed query via nomic-embed -> cosine similarity against stored embeddings -> normalize to 0-1
   - Merge: `final_score = 0.4 * fts5_score + 0.6 * vector_score`
   - Dedupe by memory ID, sort by final_score, return top N
4. Fallback: if nomic-embed is down, fall back to FTS5-only silently

### Backfill

One-time script to embed all existing memories (currently 9).

## Configuration

### openclaw.json (memoryCortex section)

```json
{
  "memoryCortex": {
    "enabled": true,
    "middlewareHost": "localhost",
    "middlewarePort": 8300,
    "autoIngest": true,
    "autoRecall": true,
    "recallTimeoutMs": 200,
    "recallMaxTokens": 500,
    "recallMaxFacts": 15,
    "synthesisCacheTtlMs": 300000,
    "skipHeartbeat": true,
    "embedHost": "localhost",
    "embedPort": 8105,
    "llmHost": "172.17.96.1",
    "llmPort": 8301,
    "hwMonitorHost": "172.17.96.1",
    "hwMonitorPort": 8085,
    "hwMonitorEnabled": true
  }
}
```

### SessionEntry New Fields

```typescript
memoryCortexIngestedAt?: number;
memoryCortexRecalledAt?: number;
memoryCortexSynthesis?: {
  query: string;
  response: string;
  cachedAt: number;
};
memoryCortexFactsInjected?: number;
```

## Files Changed

| Component  | File                                                       | Change                                          |
| ---------- | ---------------------------------------------------------- | ----------------------------------------------- |
| OpenClaw   | `src/auto-reply/reply/agent-runner.ts`                     | Add recall before LLM, ingestion after response |
| OpenClaw   | `src/auto-reply/reply/memory-cortex-client.ts` (NEW)       | HTTP client for middleware                      |
| OpenClaw   | `src/auto-reply/reply/agent-runner-memory-cortex.ts` (NEW) | runMemoryCortexRecall, runMemoryCortexIngest    |
| OpenClaw   | Session entry types                                        | Add memoryCortex fields                         |
| OpenClaw   | Config types                                               | Add autoIngest, autoRecall, etc.                |
| Middleware | `middleware/server.py`                                     | Add /hybrid-search endpoint                     |
| Middleware | `middleware/db.py`                                         | Add embedding column, storage/retrieval         |
| Middleware | `middleware/embeddings.py` (NEW)                           | nomic-embed client, cosine similarity           |
| Middleware | `middleware/ingestion.py`                                  | Compute + store embeddings after extraction     |
| Middleware | `scripts/backfill-embeddings.py` (NEW)                     | One-time embedding backfill                     |

## Failure Handling

- **Middleware down:** Silent skip. Log warning, respond without memory context.
- **nomic-embed down:** Fall back to FTS5-only search. Log warning.
- **Qwen3-8B down:** Ingestion fails silently (logged). Recall raw search still works (no synthesis cached).
- **Timeout (>200ms recall):** Skip memory injection for this turn. Response proceeds normally.
- **Database locked:** SQLite WAL mode handles concurrent reads. Write contention extremely unlikely at this scale.
