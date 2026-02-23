# Pre-Flight Context Planner — Design Document

**Date:** 2026-02-23
**Author:** Claude Opus 4.6 + Oogley
**Status:** Approved

## Problem

Every BillBot interaction assembles the same context regardless of the message. A greeting, a crypto trade, a coding request, and a complex research task all receive:

- The same ~30 native tools in the LLM tool catalog
- The same memory recall parameters (15 facts, 500 tokens, 200ms timeout)
- The same thinking level (`low`)
- The same system prompt with all skill descriptions

gpt-oss-120b scores ~67-68% on BFCL-v3 (function calling). Fewer, more relevant tools directly improves that hit rate. Smaller context directly improves inference speed (20-27 tok/s at 12K vs degrading at higher contexts). This is the "context engineering" paradigm identified by Anthropic, ACE (ICLR 2026), and the ElizaOS pre-evaluator pattern.

## Solution

A new module `context-planner.ts` that classifies each incoming message and produces a `ContextPlan` used to:

1. **Filter the tool catalog** — remove irrelevant tools before they reach the LLM
2. **Tune memory recall** — adjust fact count, token budget, or skip entirely
3. **Select thinking level** — match reasoning effort to task complexity
4. **Annotate the prompt** — prepend a brief task-type hint for the LLM

## Architecture

### Classifier: Rule-Based with Weighted Scoring

Not an LLM call. A deterministic classifier using keyword patterns, message structure analysis, and weighted category scoring. Runs in <1ms. No external dependencies.

Each category has:

- **Keyword patterns**: regex-based, case-insensitive
- **Structural signals**: message length, presence of code blocks, URLs, file paths, attachments
- **Weight**: accumulated score from matched patterns
- **Threshold**: minimum score to activate the category

A message can match **multiple categories** (e.g., "search for Solana DEX fee comparison" matches both `research` and `crypto`). The final tool set is the **union** of all matched categories' tool sets.

If **no category** reaches its threshold, or if the `complex` category fires, the full tool set passes through unchanged (safe fallback).

### Categories

````
Category     | Patterns                                            | Tool Subset
─────────────┼─────────────────────────────────────────────────────┼──────────────────────────────────
casual       | greetings, <20 chars, emoji-only, "how are you",    | message
             | "hey", "yo", "sup", "thanks", single-word msgs      |
─────────────┼─────────────────────────────────────────────────────┼──────────────────────────────────
research     | "search", "find", "look up", "what is", "who is",  | exec, web_fetch, web_search,
             | "explain", "compare", URLs, "?",  question words    | message, read
─────────────┼─────────────────────────────────────────────────────┼──────────────────────────────────
coding       | file paths (.*\.\w+), "code", "fix", "debug",      | exec, read, write, edit,
             | "function", "error", "bug", code fences (```),      | apply_patch, process, message
             | "commit", "test", "build", "deploy"                 |
─────────────┼─────────────────────────────────────────────────────┼──────────────────────────────────
crypto       | "$", "sol", "eth", "btc", "swap", "wallet",        | exec, message, web_fetch,
             | "token", "stake", "defi", "nft", "mint",            | web_search
             | "balance", "transfer", chain names                  |
─────────────┼─────────────────────────────────────────────────────┼──────────────────────────────────
media        | "image", "picture", "photo", "draw", "generate",   | exec, message
             | "speak", "say", "transcribe", "listen", "voice",   |
             | image/audio attachments present                     |
─────────────┼─────────────────────────────────────────────────────┼──────────────────────────────────
monitoring   | "status", "health", "gpu", "vram", "services",     | exec, message
             | "temperature", "memory", "disk", "cpu", "uptime"   |
─────────────┼─────────────────────────────────────────────────────┼──────────────────────────────────
memory       | "remember", "recall", "last time", "you said",     | memory_search, memory_get,
             | "we discussed", "earlier", "yesterday", "before"   | message
─────────────┼─────────────────────────────────────────────────────┼──────────────────────────────────
complex      | >300 chars, multiple sentences, "step by step",    | ALL (full tool set)
             | "and then", "first...then", numbered lists,         |
             | 3+ question marks, "plan", "analyze"               |
````

### Integration Point

**Location:** `src/auto-reply/reply/agent-runner.ts`, lines 265-280

The planner runs BEFORE both memory recall and the agent attempt. This is critical because it needs to influence memory recall parameters.

```
agent-runner.ts
  │
  ├─ Line 250: runMemoryFlushIfNeeded()
  │
  ├─ ★ NEW: runContextPlanner(commandBody, config, isHeartbeat)
  │     └─ Returns: ContextPlan { categories, toolAllowlist, memoryParams, thinkLevel, hint }
  │
  ├─ Line 266: runMemoryCortexRecall() ← receives plan.memoryParams
  │
  ├─ Line 282: createFollowupRunner()
  │
  └─ ... runEmbeddedPiAgent() ← receives plan.toolAllowlist, plan.thinkLevel
```

### Tool Filtering

Implemented as the **final step** in the existing `applyToolPolicyPipeline()` in `pi-tools.ts`. This means all security/access policies apply first — the context planner can only REMOVE tools, never ADD tools that were already denied by access control.

```typescript
// In createOpenClawCodingTools(), after existing pipeline steps:
const pipelineSteps = [
  ...buildDefaultToolPolicyPipelineSteps({ ... }),
  { policy: sandbox?.tools, label: "sandbox tools.allow" },
  { policy: subagentPolicy, label: "subagent tools.allow" },
  // ★ NEW: context-aware filtering (last step, only removes)
  ...(contextPlanPolicy ? [{ policy: contextPlanPolicy, label: "context-planner" }] : []),
];
```

The policy is constructed from the plan's `toolAllowlist` — a `{ allow: string[] }` containing only the tools relevant to the classified categories.

### Memory Recall Tuning

The `ContextPlan` overrides memory recall parameters passed to `runMemoryCortexRecall()`:

```
Category     | maxFacts | maxTokens | Behavior
─────────────┼──────────┼───────────┼────────────────────────────────
casual       | 0        | 0         | Skip recall entirely
memory       | 25       | 1000      | Expand — user explicitly asking
research     | 10       | 400       | Moderate — prior context helps
coding       | 5        | 200       | Narrow — only code-relevant
monitoring   | 3        | 150       | Minimal — mostly real-time data
crypto       | 8        | 300       | Moderate — past transactions/prefs
media        | 3        | 150       | Minimal
complex      | 15       | 500       | Full (unchanged from today)
(no match)   | 15       | 500       | Full (safe fallback)
```

When multiple categories match, use the **maximum** of each parameter (most permissive wins).

### Thinking Level Selection

Override the static `thinkingDefault: "low"` per-turn:

```
Category     | Thinking Level | Rationale
─────────────┼────────────────┼──────────────────────────────────
casual       | off            | No reasoning needed for greetings
research     | low            | Standard effort
coding       | medium         | Benefits from step-by-step reasoning
crypto       | medium         | Financial decisions need careful thought
monitoring   | off            | Status checks are straightforward
memory       | low            | Recall + synthesize
media        | off            | Direct tool invocation
complex      | high           | Multi-step tasks need deep reasoning
(no match)   | low            | Safe fallback (today's default)
```

When multiple categories match, use the **highest** thinking level.

### Prompt Annotation

Prepend a brief hint to the user prompt so the LLM has awareness of what the planner decided:

```
[Context: research + crypto task | tools: exec, web_fetch, web_search, message | thinking: medium]
```

This is invisible to the user but helps the LLM calibrate its response strategy.

## Configuration

New section in `agents.defaults`:

```typescript
type ContextPlannerConfig = {
  /** Master switch (default: true when present). */
  enabled?: boolean;
  /** Filter tools based on message classification (default: true). */
  toolFiltering?: boolean;
  /** Tune memory recall parameters per category (default: true). */
  memoryTuning?: boolean;
  /** Adjust thinking level per category (default: true). */
  thinkingTuning?: boolean;
  /** Prepend task-type hint to prompt (default: true). */
  promptAnnotation?: boolean;
  /** Tools that always pass through regardless of classification. */
  alwaysInclude?: string[];
  /** Minimum message length (chars) before complex category can fire (default: 300). */
  complexThreshold?: number;
  /** If true, unclassified messages get full tool set (default: true). */
  fallbackToFull?: boolean;
  /** Category overrides — customize patterns or tool sets per category. */
  categories?: Record<
    string,
    {
      /** Extra keywords to match for this category. */
      extraPatterns?: string[];
      /** Extra tools to include for this category. */
      extraTools?: string[];
      /** Override the thinking level for this category. */
      thinkingLevel?: string;
      /** Disable this category entirely. */
      disabled?: boolean;
    }
  >;
};
```

Default config for BillBot:

```json
{
  "agents": {
    "defaults": {
      "contextPlanner": {
        "enabled": true,
        "toolFiltering": true,
        "memoryTuning": true,
        "thinkingTuning": true,
        "promptAnnotation": true,
        "alwaysInclude": ["message"],
        "complexThreshold": 300,
        "fallbackToFull": true
      }
    }
  }
}
```

## Files Changed

| File                                                 | Change Type | Description                                                |
| ---------------------------------------------------- | ----------- | ---------------------------------------------------------- |
| `src/agents/context-planner.ts`                      | **NEW**     | Classifier, plan builder, category definitions             |
| `src/auto-reply/reply/agent-runner.ts`               | Modify      | Add planner call, pass plan to memory recall and agent run |
| `src/auto-reply/reply/agent-runner-memory-cortex.ts` | Modify      | Accept plan overrides for recall params                    |
| `src/agents/pi-embedded-runner/run.ts`               | Modify      | Accept and pass through context plan                       |
| `src/agents/pi-embedded-runner/run/attempt.ts`       | Modify      | Apply tool filter from context plan                        |
| `src/agents/pi-embedded-runner/run/params.ts`        | Modify      | Add contextPlan to RunEmbeddedPiAgentParams                |
| `src/agents/pi-tools.ts`                             | Modify      | Accept optional context-plan policy step                   |
| `src/config/types.agent-defaults.ts`                 | Modify      | Add ContextPlannerConfig type                              |
| `src/config/zod-schema.agent-defaults.ts`            | Modify      | Add Zod validation for contextPlanner                      |

## What Does NOT Change

- System prompt builder (`system-prompt.ts`) — not modified
- Tool creation logic — tools are still all created, just filtered afterward
- Session management — no changes
- Subagent system — no changes
- Heartbeat — planner skips heartbeat runs (same pattern as memory cortex)
- MCPJungle tools — unaffected (accessed via exec/skill, not native tools)

## Safety

1. **`enabled: false`** disables the entire planner (identical behavior to today)
2. **`fallbackToFull: true`** means unclassified messages get the full tool set
3. **Tool filtering only removes tools** — security policies always apply first
4. **Each sub-feature toggles independently** (toolFiltering, memoryTuning, thinkingTuning)
5. **No external dependencies** — pure TypeScript, no LLM calls, no network requests
6. **Heartbeat runs are skipped** — planner does not interfere with background tasks
7. **Subagent and cron runs are skipped** — planner only applies to direct user messages

## Metrics / Observability

The planner logs its classification result at `info` level:

```
[context-planner] classified: categories=[research,crypto] tools=5/32 memory=8/500 thinking=medium (12ms)
```

The `systemPromptReport` (already built in attempt.ts) will include the context plan metadata for debugging.

## Future Extensions

1. **LLM-based classifier** — swap in a small model (heartbeat or dedicated) for ambiguous messages
2. **Learned category weights** — adjust pattern weights based on observed tool call success rates (MemRL-style)
3. **Skill-level filtering** — dynamically trim skill descriptions from the system prompt
4. **Session-aware classification** — use conversation history to maintain category context across turns
5. **Per-user category profiles** — learn which categories a specific user triggers most often
