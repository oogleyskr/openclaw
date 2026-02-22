# Memory Cortex Auto-Wiring Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire Memory Cortex into OpenClaw's conversation flow so conversations are automatically ingested for fact extraction and relevant memories are automatically recalled before each LLM response.

**Architecture:** Agent runner integration — new functions mirror the existing `runMemoryFlushIfNeeded` pattern. Auto-recall runs before the LLM call (raw FTS5+vector facts, <200ms). Auto-ingestion fires after each response (background, debounced). Async synthesis caches for next-turn enrichment. Hybrid search combines FTS5 keyword matching with nomic-embed vector similarity.

**Tech Stack:** TypeScript (OpenClaw), Python 3.12 (middleware), SQLite+FTS5, nomic-embed (port 8105), aiohttp, httpx

**Design Doc:** `docs/plans/2026-02-22-memory-cortex-wiring-design.md`

---

## Task 1: Middleware — Add Embeddings Module

**Files:**

- Create: `middleware/embeddings.py` (in `/home/mferr/billbot-memory-cortex/`)
- Test: Manual curl test against nomic-embed service

**Step 1: Write embeddings.py**

```python
"""Vector embedding client for nomic-embed service (port 8105)."""

import struct
from typing import Optional

import httpx


async def compute_embedding(
    text: str,
    embed_url: str = "http://localhost:8105/embed",
    timeout: float = 10.0,
) -> Optional[list[float]]:
    """Compute embedding vector for a text string.

    Returns None if the embedding service is unavailable.
    """
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(embed_url, json={"text": text})
            response.raise_for_status()
            data = response.json()
            return data.get("embedding") or data.get("data", [{}])[0].get("embedding")
    except Exception:
        return None


async def compute_embeddings_batch(
    texts: list[str],
    embed_url: str = "http://localhost:8105/embed",
    timeout: float = 30.0,
) -> list[Optional[list[float]]]:
    """Compute embeddings for multiple texts. Returns None for any that fail."""
    results = []
    for text in texts:
        emb = await compute_embedding(text, embed_url, timeout)
        results.append(emb)
    return results


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """Compute cosine similarity between two vectors."""
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(x * x for x in b) ** 0.5
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def serialize_embedding(embedding: list[float]) -> bytes:
    """Serialize a float list to bytes for SQLite BLOB storage."""
    return struct.pack(f"{len(embedding)}f", *embedding)


def deserialize_embedding(data: bytes) -> list[float]:
    """Deserialize bytes back to a float list."""
    count = len(data) // 4
    return list(struct.unpack(f"{count}f", data))
```

**Step 2: Verify nomic-embed is reachable**

Run:

```bash
curl -s -X POST http://localhost:8105/embed \
  -H "Content-Type: application/json" \
  -d '{"text": "test embedding"}' | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'dims: {len(d.get(\"embedding\", d.get(\"data\",[{}])[0].get(\"embedding\",[])))}');"
```

Expected: `dims: 768` (nomic-embed-text dimension)

**Step 3: Commit**

```bash
cd /home/mferr/billbot-memory-cortex
git add middleware/embeddings.py
git commit -m "feat: add embeddings module for nomic-embed vector search"
```

---

## Task 2: Middleware — Add Embedding Column to Database

**Files:**

- Modify: `middleware/db.py` (in `/home/mferr/billbot-memory-cortex/`)
- Create: `scripts/backfill-embeddings.py`

**Step 1: Add embedding column and helper functions to db.py**

After the existing `CREATE INDEX` statements (line ~51 in init_db), add migration:

```python
# In init_db(), after existing CREATE INDEX statements:
conn.execute("""
    ALTER TABLE memories ADD COLUMN embedding BLOB
""")
# (Will fail silently if column already exists — wrap in try/except)
```

Wrap the ALTER TABLE in a try/except since SQLite doesn't support IF NOT EXISTS for ALTER:

```python
try:
    conn.execute("ALTER TABLE memories ADD COLUMN embedding BLOB")
except sqlite3.OperationalError:
    pass  # Column already exists
```

Add new functions to db.py:

```python
def store_embedding(db_path: str, memory_id: int, embedding_blob: bytes) -> None:
    """Store a serialized embedding for a memory."""
    conn = get_connection(db_path)
    conn.execute(
        "UPDATE memories SET embedding = ? WHERE id = ?",
        (embedding_blob, memory_id),
    )
    conn.commit()
    conn.close()


def get_memories_with_embeddings(
    db_path: str, user_id: Optional[str] = None, limit: int = 500
) -> list[dict]:
    """Get all memories that have embeddings stored."""
    conn = get_connection(db_path)
    if user_id:
        rows = conn.execute(
            "SELECT id, user_id, topic, fact, importance, created_at, "
            "source_session, source_channel, embedding "
            "FROM memories WHERE embedding IS NOT NULL AND user_id = ? "
            "ORDER BY created_at DESC LIMIT ?",
            (user_id, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT id, user_id, topic, fact, importance, created_at, "
            "source_session, source_channel, embedding "
            "FROM memories WHERE embedding IS NOT NULL "
            "ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    conn.close()
    return [dict(row) for row in rows]


def get_memories_without_embeddings(db_path: str) -> list[dict]:
    """Get all memories that need embeddings computed."""
    conn = get_connection(db_path)
    rows = conn.execute(
        "SELECT id, user_id, topic, fact FROM memories WHERE embedding IS NULL"
    ).fetchall()
    conn.close()
    return [dict(row) for row in rows]
```

**Step 2: Write backfill script**

Create `scripts/backfill-embeddings.py`:

```python
#!/usr/bin/env python3
"""One-time script to compute embeddings for all existing memories."""

import asyncio
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from middleware.db import get_memories_without_embeddings, store_embedding
from middleware.embeddings import compute_embedding, serialize_embedding


async def backfill(
    db_path: str = "/home/mferr/.openclaw/memory-cortex/memories.db",
    embed_url: str = "http://localhost:8105/embed",
):
    memories = get_memories_without_embeddings(db_path)
    print(f"Found {len(memories)} memories without embeddings")

    for mem in memories:
        text = f"{mem['topic']}: {mem['fact']}"
        embedding = await compute_embedding(text, embed_url)
        if embedding:
            blob = serialize_embedding(embedding)
            store_embedding(db_path, mem["id"], blob)
            print(f"  [{mem['id']}] Embedded: {mem['fact'][:60]}...")
        else:
            print(f"  [{mem['id']}] FAILED: {mem['fact'][:60]}...")

    print("Backfill complete")


if __name__ == "__main__":
    asyncio.run(backfill())
```

**Step 3: Run backfill on existing 9 memories**

Run:

```bash
cd /home/mferr/billbot-memory-cortex
python3 scripts/backfill-embeddings.py
```

Expected: `Found 9 memories without embeddings` + 9 success lines + `Backfill complete`

**Step 4: Commit**

```bash
cd /home/mferr/billbot-memory-cortex
git add middleware/db.py scripts/backfill-embeddings.py
git commit -m "feat: add embedding column and backfill script for vector search"
```

---

## Task 3: Middleware — Add /hybrid-search Endpoint

**Files:**

- Modify: `middleware/server.py` (in `/home/mferr/billbot-memory-cortex/`)

**Step 1: Add hybrid search handler to server.py**

Add import at top of server.py:

```python
from middleware.embeddings import (
    compute_embedding,
    cosine_similarity,
    deserialize_embedding,
    serialize_embedding,
)
from middleware.db import get_memories_with_embeddings
```

Add new handler function (before the `create_app` function):

```python
async def handle_hybrid_search(request):
    """Hybrid search: FTS5 keyword + vector similarity, merged and ranked."""
    config = request.app["config"]
    db_path = config["database"]["path"]
    embed_url = config.get("embeddings", {}).get(
        "url", "http://localhost:8105/embed"
    )

    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    query = body.get("query", "").strip()
    if not query:
        return web.json_response({"error": "No query provided"}, status=400)

    user_id = body.get("user_id")
    limit = body.get("limit", 10)

    # 1. FTS5 keyword search
    fts_results = search_memories(db_path, query, user_id=user_id, limit=limit * 2)

    # Normalize FTS5 ranks to 0-1 (rank is negative, lower = better)
    fts_by_id = {}
    if fts_results:
        min_rank = min(r["rank"] for r in fts_results)
        max_rank = max(r["rank"] for r in fts_results)
        rank_range = max_rank - min_rank if max_rank != min_rank else 1.0
        for r in fts_results:
            score = 1.0 - ((r["rank"] - min_rank) / rank_range)
            fts_by_id[r["id"]] = {**r, "fts5_score": score}

    # 2. Vector search
    vec_by_id = {}
    query_embedding = await compute_embedding(query, embed_url)
    if query_embedding:
        memories_with_emb = get_memories_with_embeddings(
            db_path, user_id=user_id, limit=500
        )
        for mem in memories_with_emb:
            if mem.get("embedding"):
                mem_emb = deserialize_embedding(mem["embedding"])
                sim = cosine_similarity(query_embedding, mem_emb)
                vec_by_id[mem["id"]] = {**mem, "vector_score": sim}
                del vec_by_id[mem["id"]]["embedding"]  # Don't return blob

    # 3. Merge: 0.4 * FTS5 + 0.6 * vector
    all_ids = set(fts_by_id.keys()) | set(vec_by_id.keys())
    merged = []
    for mid in all_ids:
        fts_score = fts_by_id.get(mid, {}).get("fts5_score", 0.0)
        vec_score = vec_by_id.get(mid, {}).get("vector_score", 0.0)
        final_score = 0.4 * fts_score + 0.6 * vec_score

        # Get the full record from whichever source has it
        record = fts_by_id.get(mid) or vec_by_id.get(mid, {})
        merged.append({
            "id": mid,
            "user_id": record.get("user_id"),
            "topic": record.get("topic"),
            "fact": record.get("fact"),
            "importance": record.get("importance"),
            "created_at": record.get("created_at"),
            "score": round(final_score, 4),
            "source": "fts5+vector" if mid in fts_by_id and mid in vec_by_id
                      else "fts5" if mid in fts_by_id
                      else "vector",
        })

    # Sort by score descending, take top N
    merged.sort(key=lambda x: x["score"], reverse=True)
    results = merged[:limit]

    return web.json_response({"results": results, "count": len(results)})
```

Register the route in `create_app()` (after existing routes):

```python
app.router.add_post("/hybrid-search", handle_hybrid_search)
```

Also add `embeddings` section to config.yaml:

```yaml
embeddings:
  url: "http://localhost:8105/embed"
```

**Step 2: Test hybrid search**

Run (restart middleware first):

```bash
bash /home/mferr/billbot-memory-cortex/scripts/stop.sh
bash /home/mferr/billbot-memory-cortex/scripts/start.sh
sleep 2
curl -s -X POST http://localhost:8300/hybrid-search \
  -H "Content-Type: application/json" \
  -d '{"query": "programming languages", "user_id": "oogley", "limit": 5}' | python3 -m json.tool
```

Expected: JSON with results array containing facts with scores and source fields.

**Step 3: Commit**

```bash
cd /home/mferr/billbot-memory-cortex
git add middleware/server.py config/config.yaml
git commit -m "feat: add /hybrid-search endpoint with FTS5 + vector scoring"
```

---

## Task 4: Middleware — Embed Facts on Ingestion

**Files:**

- Modify: `middleware/ingestion.py` (in `/home/mferr/billbot-memory-cortex/`)

**Step 1: Add embedding computation to ingestion pipeline**

Add import at top of ingestion.py:

```python
from middleware.embeddings import compute_embedding, serialize_embedding
from middleware.db import store_embedding
```

In `ingest_conversation()`, after the `store_memories(db_path, facts)` call (around line 170), add:

```python
# Compute and store embeddings for newly extracted facts
embed_url = config.get("embeddings", {}).get("url", "http://localhost:8105/embed") if config else "http://localhost:8105/embed"
for fact_record in facts:
    if fact_record.get("_stored_id"):
        text = f"{fact_record.get('topic', '')}: {fact_record.get('fact', '')}"
        embedding = await compute_embedding(text, embed_url)
        if embedding:
            blob = serialize_embedding(embedding)
            store_embedding(db_path, fact_record["_stored_id"], blob)
```

This requires `store_memories` to return the inserted IDs. Modify `store_memories` in db.py to return a list of inserted row IDs:

```python
def store_memories(db_path: str, memories: list[dict]) -> tuple[int, list[int]]:
    """Store memories and return (count, list_of_ids)."""
    conn = get_connection(db_path)
    count = 0
    ids = []
    for mem in memories:
        cursor = conn.execute(
            "INSERT INTO memories (user_id, topic, fact, source_session, "
            "source_channel, importance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                mem.get("user_id"),
                mem["topic"],
                mem["fact"],
                mem.get("source_session"),
                mem.get("source_channel"),
                mem.get("importance", 5),
                time.time(),
            ),
        )
        ids.append(cursor.lastrowid)
        count += 1
    conn.commit()
    conn.close()
    return count, ids
```

Update ingest_conversation to use the new return value and pass config:

```python
stored_count, stored_ids = store_memories(db_path, facts)
# Attach IDs back to facts for embedding
for fact, fid in zip(facts, stored_ids):
    fact["_stored_id"] = fid
```

Note: The `ingest_conversation` function signature needs the config dict passed through. Add `config: Optional[dict] = None` parameter and thread it from server.py's `handle_ingest` where `request.app["config"]` is available.

**Step 2: Test ingestion with embeddings**

Run:

```bash
curl -s -X POST http://localhost:8300/ingest \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "name": "testuser", "content": "I really enjoy writing Golang for network services"}, {"role": "assistant", "content": "Thats great! Go is excellent for networking."}], "user_id": "testuser", "debounce": false}' | python3 -m json.tool
```

Wait ~30 seconds for extraction, then verify embedding was stored:

```bash
python3 -c "
import sqlite3
conn = sqlite3.connect('/home/mferr/.openclaw/memory-cortex/memories.db')
rows = conn.execute('SELECT id, fact, embedding IS NOT NULL as has_emb FROM memories ORDER BY id DESC LIMIT 3').fetchall()
for r in rows: print(r)
"
```

Expected: Most recent row(s) should have `has_emb = 1`.

**Step 3: Commit**

```bash
cd /home/mferr/billbot-memory-cortex
git add middleware/ingestion.py middleware/db.py
git commit -m "feat: compute and store embeddings during fact ingestion"
```

---

## Task 5: OpenClaw — Extend Config Types

**Files:**

- Modify: `src/config/types.infrastructure.ts` (in `/home/mferr/openclaw/`)

**Step 1: Add new fields to MemoryCortexConfig**

In `types.infrastructure.ts`, extend the existing `MemoryCortexConfig` type (lines 58-77) with auto-wiring fields:

```typescript
export type MemoryCortexConfig = {
  /** Enable Memory Cortex monitoring (default: false). */
  enabled?: boolean;
  /** Host where the llama-server runs (default: 172.17.96.1 for WSL2→Windows). */
  llmHost?: string;
  /** Port for the llama-server (default: 8301). */
  llmPort?: number;
  /** Host where the middleware runs (default: localhost). */
  middlewareHost?: string;
  /** Port for the middleware (default: 8300). */
  middlewarePort?: number;
  /** How often to collect metrics in seconds (default: 15). */
  intervalSeconds?: number;
  /** Host where LibreHardwareMonitor runs (default: same as llmHost). */
  hwMonitorHost?: string;
  /** Port for LibreHardwareMonitor web server (default: 8085). */
  hwMonitorPort?: number;
  /** Enable hardware monitoring via LibreHardwareMonitor (default: true when memoryCortex is enabled). */
  hwMonitorEnabled?: boolean;
  /** Auto-ingest conversations after each turn (default: false). */
  autoIngest?: boolean;
  /** Auto-recall memories before each LLM call (default: false). */
  autoRecall?: boolean;
  /** Timeout in ms for recall before skipping (default: 200). */
  recallTimeoutMs?: number;
  /** Max tokens of memory context to inject (default: 500). */
  recallMaxTokens?: number;
  /** Max number of facts to inject (default: 15). */
  recallMaxFacts?: number;
  /** TTL in ms for cached synthesis (default: 300000 = 5 min). */
  synthesisCacheTtlMs?: number;
  /** Skip memory operations for heartbeat sessions (default: true). */
  skipHeartbeat?: boolean;
  /** Host for the embeddings service (default: localhost). */
  embedHost?: string;
  /** Port for the embeddings service (default: 8105). */
  embedPort?: number;
};
```

**Step 2: Commit**

```bash
cd /home/mferr/openclaw
git add src/config/types.infrastructure.ts
git commit -m "feat: extend MemoryCortexConfig with auto-ingest and auto-recall fields"
```

---

## Task 6: OpenClaw — Extend SessionEntry Types

**Files:**

- Modify: `src/config/sessions/types.ts` (in `/home/mferr/openclaw/`)

**Step 1: Add Memory Cortex fields to SessionEntry**

After the existing `memoryFlushCompactionCount` field (line ~95), add:

```typescript
  /** Timestamp (ms) when Memory Cortex last ingested this session. */
  memoryCortexIngestedAt?: number;
  /** Timestamp (ms) when Memory Cortex last recalled for this session. */
  memoryCortexRecalledAt?: number;
  /** Cached async synthesis from Memory Cortex (one turn behind). */
  memoryCortexSynthesis?: {
    query: string;
    response: string;
    cachedAt: number;
  };
  /** Number of facts injected in the most recent recall. */
  memoryCortexFactsInjected?: number;
```

**Step 2: Commit**

```bash
cd /home/mferr/openclaw
git add src/config/sessions/types.ts
git commit -m "feat: add Memory Cortex fields to SessionEntry type"
```

---

## Task 7: OpenClaw — Create Memory Cortex HTTP Client

**Files:**

- Create: `src/auto-reply/reply/memory-cortex-client.ts` (in `/home/mferr/openclaw/`)

**Step 1: Write the HTTP client**

```typescript
/**
 * HTTP client for Memory Cortex middleware (port 8300).
 * Used by auto-recall and auto-ingestion in agent-runner-memory-cortex.ts.
 */

import type { MemoryCortexConfig } from "../../config/types.infrastructure.js";
import { logVerbose } from "../../globals.js";

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

function buildBaseUrl(config: MemoryCortexConfig): string {
  const host = config.middlewareHost ?? "localhost";
  const port = config.middlewarePort ?? 8300;
  return `http://${host}:${port}`;
}

export async function hybridSearch(
  config: MemoryCortexConfig,
  query: string,
  userId?: string,
  limit = 15,
  timeoutMs = 200,
): Promise<HybridSearchResult | null> {
  const baseUrl = buildBaseUrl(config);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/hybrid-search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, user_id: userId, limit }),
      signal: controller.signal,
    });
    if (!response.ok) {
      logVerbose(`memory-cortex hybrid-search returned ${response.status}`);
      return null;
    }
    return (await response.json()) as HybridSearchResult;
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      logVerbose(`memory-cortex hybrid-search timed out after ${timeoutMs}ms`);
    } else {
      logVerbose(`memory-cortex hybrid-search failed: ${String(err)}`);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function recall(
  config: MemoryCortexConfig,
  query: string,
  userId?: string,
): Promise<RecallResult | null> {
  const baseUrl = buildBaseUrl(config);

  try {
    const response = await fetch(`${baseUrl}/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, user_id: userId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      logVerbose(`memory-cortex recall returned ${response.status}`);
      return null;
    }
    return (await response.json()) as RecallResult;
  } catch (err) {
    logVerbose(`memory-cortex recall failed: ${String(err)}`);
    return null;
  }
}

export async function ingest(
  config: MemoryCortexConfig,
  messages: Array<{ role: string; content: string; name?: string }>,
  sessionId?: string,
  channel?: string,
  userId?: string,
): Promise<void> {
  const baseUrl = buildBaseUrl(config);

  try {
    await fetch(`${baseUrl}/ingest`, {
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
  } catch (err) {
    logVerbose(`memory-cortex ingest failed: ${String(err)}`);
  }
}
```

**Step 2: Commit**

```bash
cd /home/mferr/openclaw
git add src/auto-reply/reply/memory-cortex-client.ts
git commit -m "feat: add Memory Cortex HTTP client for hybrid search, recall, and ingest"
```

---

## Task 8: OpenClaw — Create Agent Runner Memory Cortex Module

**Files:**

- Create: `src/auto-reply/reply/agent-runner-memory-cortex.ts` (in `/home/mferr/openclaw/`)

This is the core integration — mirrors the pattern of `agent-runner-memory.ts`.

**Step 1: Write the module**

```typescript
/**
 * Memory Cortex auto-recall and auto-ingestion for the agent runner.
 * Mirrors the pattern of agent-runner-memory.ts (runMemoryFlushIfNeeded).
 */

import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { updateSessionStoreEntry } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import type { FollowupRun } from "./queue.js";
import { hybridSearch, ingest, recall, type MemoryCortexFact } from "./memory-cortex-client.js";

export type MemoryCortexRecallResult = {
  /** Formatted memory context to inject into the prompt. */
  memoryContext: string | null;
  /** Number of facts found. */
  factsCount: number;
};

/**
 * Resolve the Memory Cortex config from the main config.
 * Returns undefined if not enabled.
 */
function resolveMemoryCortexConfig(cfg: OpenClawConfig) {
  const mc = cfg.infrastructure?.memoryCortex;
  if (!mc?.enabled) return undefined;
  return mc;
}

/**
 * Format retrieved facts into a compact context block for the LLM.
 * Caps output at maxTokens (estimated at 4 chars/token).
 */
function formatFactsAsContext(
  facts: MemoryCortexFact[],
  maxTokens: number,
  cachedSynthesis?: { response: string; cachedAt: number },
  synthesisCacheTtlMs?: number,
): string {
  const maxChars = maxTokens * 4;
  const lines: string[] = ["## Long-Term Memories\n"];

  // Add cached synthesis from previous turn if fresh
  if (cachedSynthesis) {
    const ttl = synthesisCacheTtlMs ?? 300_000;
    const age = Date.now() - cachedSynthesis.cachedAt;
    if (age < ttl) {
      lines.push(`**Summary (from previous context):** ${cachedSynthesis.response}\n`);
      lines.push("**Individual facts:**");
    }
  }

  // Sort by importance descending, then by score descending
  const sorted = [...facts].sort((a, b) => {
    const impDiff = (b.importance ?? 5) - (a.importance ?? 5);
    if (impDiff !== 0) return impDiff;
    return (b.score ?? 0) - (a.score ?? 0);
  });

  let totalChars = lines.join("\n").length;
  for (const fact of sorted) {
    const line = `- [${fact.topic ?? "general"}] ${fact.fact} (importance: ${fact.importance ?? 5})`;
    if (totalChars + line.length + 1 > maxChars) break;
    lines.push(line);
    totalChars += line.length + 1;
  }

  return lines.join("\n");
}

/**
 * Read session messages from the JSONL session file.
 * Returns simplified message objects suitable for Memory Cortex ingestion.
 */
function readSessionMessagesForIngestion(
  sessionFile: string,
): Array<{ role: string; content: string; name?: string }> {
  // Dynamic import to avoid circular deps
  const fs = await import("node:fs");
  if (!fs.existsSync(sessionFile)) return [];

  try {
    const content = fs.readFileSync(sessionFile, "utf-8");
    const lines = content.trim().split("\n");
    const messages: Array<{ role: string; content: string; name?: string }> = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "message" && entry.message) {
          const msg = entry.message;
          const role = msg.role;
          // Extract text content (may be string or array of content blocks)
          let text = "";
          if (typeof msg.content === "string") {
            text = msg.content;
          } else if (Array.isArray(msg.content)) {
            text = msg.content
              .filter((b: { type: string }) => b.type === "text")
              .map((b: { text: string }) => b.text)
              .join("\n");
          }
          if (role && text) {
            messages.push({ role, content: text, ...(msg.name ? { name: msg.name } : {}) });
          }
        }
      } catch {
        // Skip malformed lines
      }
    }
    return messages;
  } catch {
    return [];
  }
}

/**
 * Auto-recall: query Memory Cortex for relevant memories before the LLM call.
 * Returns formatted context string to inject, or null if skipped.
 *
 * Called BEFORE runAgentTurnWithFallback in agent-runner.ts.
 */
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
  const mc = resolveMemoryCortexConfig(params.cfg);
  if (!mc || !mc.autoRecall) return { memoryContext: null, factsCount: 0 };
  if (params.isHeartbeat && mc.skipHeartbeat !== false) {
    return { memoryContext: null, factsCount: 0 };
  }

  const timeoutMs = mc.recallTimeoutMs ?? 200;
  const maxTokens = mc.recallMaxTokens ?? 500;
  const maxFacts = mc.recallMaxFacts ?? 15;

  const query = params.commandBody;
  if (!query || query.trim().length < 3) {
    return { memoryContext: null, factsCount: 0 };
  }

  const userId = params.followupRun.run.senderName ?? undefined;

  // Hybrid search with timeout
  const searchResult = await hybridSearch(mc, query, userId, maxFacts, timeoutMs);
  if (!searchResult || searchResult.count === 0) {
    return { memoryContext: null, factsCount: 0 };
  }

  // Get cached synthesis from previous turn
  const cachedSynthesis = params.sessionEntry?.memoryCortexSynthesis;

  const context = formatFactsAsContext(
    searchResult.results,
    maxTokens,
    cachedSynthesis,
    mc.synthesisCacheTtlMs,
  );

  // Fire async synthesis for NEXT turn (don't await)
  fireAsyncSynthesis(mc, query, userId, params.sessionKey, params.storePath).catch(() => {});

  // Update session entry with recall metadata
  if (params.storePath && params.sessionKey) {
    updateSessionStoreEntry({
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      update: async () => ({
        memoryCortexRecalledAt: Date.now(),
        memoryCortexFactsInjected: searchResult.count,
      }),
    }).catch((err) => {
      logVerbose(`failed to persist memory-cortex recall metadata: ${String(err)}`);
    });
  }

  return { memoryContext: context, factsCount: searchResult.count };
}

/**
 * Fire-and-forget async synthesis via /recall endpoint.
 * Caches the result in the session entry for next-turn enrichment.
 */
async function fireAsyncSynthesis(
  mc: NonNullable<ReturnType<typeof resolveMemoryCortexConfig>>,
  query: string,
  userId?: string,
  sessionKey?: string,
  storePath?: string,
): Promise<void> {
  const result = await recall(mc, query, userId);
  if (!result || !result.response) return;

  if (storePath && sessionKey) {
    try {
      await updateSessionStoreEntry({
        storePath: storePath,
        sessionKey: sessionKey,
        update: async () => ({
          memoryCortexSynthesis: {
            query,
            response: result.response,
            cachedAt: Date.now(),
          },
        }),
      });
    } catch (err) {
      logVerbose(`failed to cache memory-cortex synthesis: ${String(err)}`);
    }
  }
}

/**
 * Auto-ingest: send full session history to Memory Cortex after response.
 * Fire-and-forget — never blocks response delivery.
 *
 * Called AFTER buildReplyPayloads in agent-runner.ts.
 */
export async function runMemoryCortexIngestionIfNeeded(params: {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  isHeartbeat: boolean;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  storePath?: string;
}): Promise<void> {
  const mc = resolveMemoryCortexConfig(params.cfg);
  if (!mc || !mc.autoIngest) return;
  if (params.isHeartbeat && mc.skipHeartbeat !== false) return;

  const sessionFile = params.sessionEntry?.sessionFile;
  if (!sessionFile) return;

  const messages = readSessionMessagesForIngestion(sessionFile);
  if (messages.length === 0) return;

  const userId = params.followupRun.run.senderName ?? undefined;
  const channel = params.sessionEntry?.channel ?? undefined;

  // Fire and forget — do NOT await in the caller
  ingest(mc, messages, params.sessionKey, channel, userId).catch((err) => {
    logVerbose(`memory-cortex ingestion fire-and-forget failed: ${String(err)}`);
  });

  // Update session entry
  if (params.storePath && params.sessionKey) {
    updateSessionStoreEntry({
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      update: async () => ({
        memoryCortexIngestedAt: Date.now(),
      }),
    }).catch((err) => {
      logVerbose(`failed to persist memory-cortex ingest metadata: ${String(err)}`);
    });
  }
}
```

Note: The `readSessionMessagesForIngestion` function uses a top-level `await import()`. This needs to be refactored to use a regular import since the function isn't async. Change it to use `node:fs` imported at the top of the file:

```typescript
import fs from "node:fs";
```

And make `readSessionMessagesForIngestion` a regular (non-async) function using `fs.existsSync` and `fs.readFileSync`.

**Step 2: Commit**

```bash
cd /home/mferr/openclaw
git add src/auto-reply/reply/agent-runner-memory-cortex.ts
git commit -m "feat: add Memory Cortex auto-recall and auto-ingestion module"
```

---

## Task 9: OpenClaw — Wire Into Agent Runner

**Files:**

- Modify: `src/auto-reply/reply/agent-runner.ts` (in `/home/mferr/openclaw/`)

This is the final integration step — adding the calls to the agent runner.

**Step 1: Add imports**

At the top of agent-runner.ts, add:

```typescript
import {
  runMemoryCortexRecall,
  runMemoryCortexIngestionIfNeeded,
} from "./agent-runner-memory-cortex.js";
```

**Step 2: Add auto-recall before LLM call**

After `runMemoryFlushIfNeeded` (line ~259) and before `runAgentTurnWithFallback` (line ~357), add:

```typescript
// Memory Cortex: recall relevant memories before LLM call
const memoryCortexRecall = await runMemoryCortexRecall({
  cfg,
  followupRun,
  isHeartbeat,
  sessionEntry: activeSessionEntry,
  sessionStore: activeSessionStore,
  sessionKey,
  storePath,
  commandBody,
});
```

Then find where `commandBody` or the system prompt is assembled for the LLM call. The `memoryCortexRecall.memoryContext` needs to be injected. Look for where `extraSystemPrompt` or `commandBody` is used in the `runAgentTurnWithFallback` params.

The most robust injection point is to prepend the memory context to the `commandBody` that gets passed to the agent:

```typescript
// Inject memory context into the command body if available
const enrichedCommandBody = memoryCortexRecall.memoryContext
  ? `${memoryCortexRecall.memoryContext}\n\n---\n\n${commandBody}`
  : commandBody;
```

Then use `enrichedCommandBody` instead of `commandBody` in the `runAgentTurnWithFallback` call (line 358).

**Step 3: Add auto-ingestion after response**

After `buildReplyPayloads` returns (line ~514) and before the final return, add:

```typescript
// Memory Cortex: ingest session history (fire-and-forget, non-blocking)
runMemoryCortexIngestionIfNeeded({
  cfg,
  followupRun,
  isHeartbeat,
  sessionEntry: activeSessionEntry,
  sessionKey,
  storePath,
});
```

Note: Do NOT `await` this call — it's fire-and-forget.

**Step 4: Build and verify**

```bash
cd /home/mferr/openclaw
OPENCLAW_A2UI_SKIP_MISSING=1 pnpm build
```

Expected: Build succeeds with no type errors.

**Step 5: Commit**

```bash
cd /home/mferr/openclaw
git add src/auto-reply/reply/agent-runner.ts
git commit -m "feat: wire Memory Cortex auto-recall and auto-ingestion into agent runner"
```

---

## Task 10: Update Config and Deploy

**Files:**

- Modify: `~/.openclaw/openclaw.json`

**Step 1: Update openclaw.json**

Add the new fields to the existing `memoryCortex` section:

```json
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
```

**Step 2: Run post-build fix and restart services**

```bash
# Build OpenClaw
cd /home/mferr/openclaw
OPENCLAW_A2UI_SKIP_MISSING=1 pnpm build
bash /home/mferr/openclaw/scripts/fix-runtime-imports.sh /home/mferr/openclaw/dist

# Restart Memory Cortex middleware
bash /home/mferr/billbot-memory-cortex/scripts/stop.sh
bash /home/mferr/billbot-memory-cortex/scripts/start.sh

# Restart OpenClaw gateway (kill existing, then start)
# Find PID: ps aux | grep "entry.js gateway"
# kill <PID>
cd /home/mferr/openclaw && node dist/entry.js gateway stop
nohup node dist/entry.js gateway run --verbose > /tmp/openclaw-fork.log 2>&1 &
```

**Step 3: Verify end-to-end**

Send a test message to BillBot via Discord or Telegram. Then check:

```bash
# Check Memory Cortex received ingestion
curl -s http://localhost:8300/stats | python3 -m json.tool

# Check gateway logs for memory-cortex activity
tail -50 /tmp/openclaw-fork.log | grep -i "memory-cortex"
```

Expected: Stats show increasing `total_memories`. Logs show recall and ingest activity.

**Step 4: Commit config**

Do NOT commit openclaw.json to git (it contains secrets). Instead, document the config change.

---

## Task 11: Push Changes to GitHub

**Step 1: Push Memory Cortex middleware changes**

```bash
cd /home/mferr/billbot-memory-cortex
git push origin main
```

**Step 2: Push OpenClaw changes**

```bash
cd /home/mferr/openclaw
git push origin main
```

---

## Summary of All Commits

| Order | Repo                  | Commit Message                                                              |
| ----- | --------------------- | --------------------------------------------------------------------------- |
| 1     | billbot-memory-cortex | `feat: add embeddings module for nomic-embed vector search`                 |
| 2     | billbot-memory-cortex | `feat: add embedding column and backfill script for vector search`          |
| 3     | billbot-memory-cortex | `feat: add /hybrid-search endpoint with FTS5 + vector scoring`              |
| 4     | billbot-memory-cortex | `feat: compute and store embeddings during fact ingestion`                  |
| 5     | openclaw              | `feat: extend MemoryCortexConfig with auto-ingest and auto-recall fields`   |
| 6     | openclaw              | `feat: add Memory Cortex fields to SessionEntry type`                       |
| 7     | openclaw              | `feat: add Memory Cortex HTTP client for hybrid search, recall, and ingest` |
| 8     | openclaw              | `feat: add Memory Cortex auto-recall and auto-ingestion module`             |
| 9     | openclaw              | `feat: wire Memory Cortex auto-recall and auto-ingestion into agent runner` |
