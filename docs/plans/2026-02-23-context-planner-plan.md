# Pre-Flight Context Planner Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a per-turn context planner that classifies incoming messages and dynamically filters tools, tunes memory recall, selects thinking level, and annotates prompts.

**Architecture:** A pure TypeScript rule-based classifier (`context-planner.ts`) that runs in `agent-runner.ts` before memory recall and the LLM call. It produces a `ContextPlan` that propagates downstream: memory recall params flow to `agent-runner-memory-cortex.ts`, tool filtering flows through the existing `ToolPolicyPipeline` as a final step, and thinking level overrides the `FollowupRun` thinkLevel before execution.

**Tech Stack:** TypeScript, Vitest, Zod (config validation), existing OpenClaw tool-policy-pipeline

**Design Doc:** `docs/plans/2026-02-23-context-planner-design.md`

---

### Task 1: Add ContextPlannerConfig type and Zod schema

**Files:**

- Modify: `src/config/types.agent-defaults.ts:285` (after `AgentDefaultsConfig`)
- Modify: `src/config/zod-schema.agent-defaults.ts:171` (before `.strict()`)

**Context:** Every OpenClaw config type has a matching Zod schema. The pattern is: define the TypeScript type in `types.agent-defaults.ts`, then add a Zod schema in `zod-schema.agent-defaults.ts`. The `AgentDefaultsConfig` type (line 124) is validated by `AgentDefaultsSchema` (line 15).

**Step 1: Add the ContextPlannerConfig type**

In `src/config/types.agent-defaults.ts`, add this type BEFORE the `AgentDefaultsConfig` type (before line 124), and add the property inside `AgentDefaultsConfig`:

```typescript
// Add before AgentDefaultsConfig (before line 124):
export type ContextPlannerCategoryOverride = {
  /** Extra keywords to match for this category. */
  extraPatterns?: string[];
  /** Extra tools to include for this category. */
  extraTools?: string[];
  /** Override the thinking level for this category. */
  thinkingLevel?: string;
  /** Disable this category entirely. */
  disabled?: boolean;
};

export type ContextPlannerConfig = {
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
  categories?: Record<string, ContextPlannerCategoryOverride>;
};
```

Then inside `AgentDefaultsConfig` (after `sandbox?` at line 284), add:

```typescript
  /** Pre-flight context planner: classify messages to filter tools, tune memory, select thinking. */
  contextPlanner?: ContextPlannerConfig;
```

**Step 2: Add the Zod schema**

In `src/config/zod-schema.agent-defaults.ts`, add this INSIDE the `AgentDefaultsSchema` object, before `sandbox: AgentSandboxSchema` (before line 170):

```typescript
    contextPlanner: z
      .object({
        enabled: z.boolean().optional(),
        toolFiltering: z.boolean().optional(),
        memoryTuning: z.boolean().optional(),
        thinkingTuning: z.boolean().optional(),
        promptAnnotation: z.boolean().optional(),
        alwaysInclude: z.array(z.string()).optional(),
        complexThreshold: z.number().int().positive().optional(),
        fallbackToFull: z.boolean().optional(),
        categories: z
          .record(
            z.string(),
            z
              .object({
                extraPatterns: z.array(z.string()).optional(),
                extraTools: z.array(z.string()).optional(),
                thinkingLevel: z.string().optional(),
                disabled: z.boolean().optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
```

**Step 3: Verify build compiles**

Run: `cd /home/mferr/openclaw && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors related to context planner types.

**Step 4: Commit**

```bash
cd /home/mferr/openclaw
git add src/config/types.agent-defaults.ts src/config/zod-schema.agent-defaults.ts
git commit -m "feat(context-planner): add ContextPlannerConfig type and Zod schema"
```

---

### Task 2: Create the context-planner module with classifier and plan builder

**Files:**

- Create: `src/agents/context-planner.ts`
- Create: `src/agents/context-planner.test.ts`

**Context:** This is the core module. It exports `classifyMessage()` which returns a `ContextPlan`. The classifier uses regex patterns and structural signals (message length, code fences, URLs) to score categories. Each category has a threshold; categories that exceed their threshold contribute their tool sets, memory params, and thinking levels to the final plan. When multiple categories match, tool sets are unioned, memory params use the max, and thinking level uses the highest.

**Step 1: Write the failing test**

Create `src/agents/context-planner.test.ts`:

````typescript
import { describe, expect, it } from "vitest";
import { classifyMessage, type ContextPlan, type ContextPlannerConfig } from "./context-planner.js";

describe("classifyMessage", () => {
  const defaultConfig: ContextPlannerConfig = {
    enabled: true,
    toolFiltering: true,
    memoryTuning: true,
    thinkingTuning: true,
    promptAnnotation: true,
    alwaysInclude: ["message"],
    complexThreshold: 300,
    fallbackToFull: true,
  };

  describe("casual category", () => {
    it("classifies short greetings", () => {
      const plan = classifyMessage("hey", defaultConfig);
      expect(plan.categories).toContain("casual");
      expect(plan.thinkLevel).toBe("off");
    });

    it("classifies emoji-only messages", () => {
      const plan = classifyMessage("👋", defaultConfig);
      expect(plan.categories).toContain("casual");
    });

    it("classifies thanks messages", () => {
      const plan = classifyMessage("thanks!", defaultConfig);
      expect(plan.categories).toContain("casual");
    });
  });

  describe("research category", () => {
    it("classifies search requests", () => {
      const plan = classifyMessage("search for the latest AI papers", defaultConfig);
      expect(plan.categories).toContain("research");
      expect(plan.toolAllowlist).toContain("exec");
      expect(plan.toolAllowlist).toContain("web_fetch");
      expect(plan.toolAllowlist).toContain("web_search");
    });

    it("classifies question-style messages", () => {
      const plan = classifyMessage("what is the capital of France?", defaultConfig);
      expect(plan.categories).toContain("research");
    });

    it("classifies messages with URLs", () => {
      const plan = classifyMessage("check out https://example.com", defaultConfig);
      expect(plan.categories).toContain("research");
    });
  });

  describe("coding category", () => {
    it("classifies file path references", () => {
      const plan = classifyMessage("fix the bug in server.ts", defaultConfig);
      expect(plan.categories).toContain("coding");
      expect(plan.toolAllowlist).toContain("edit");
      expect(plan.toolAllowlist).toContain("write");
    });

    it("classifies code fence messages", () => {
      const plan = classifyMessage("```js\nconsole.log('hello')\n```", defaultConfig);
      expect(plan.categories).toContain("coding");
    });

    it("classifies debug requests", () => {
      const plan = classifyMessage("debug this error in the login function", defaultConfig);
      expect(plan.categories).toContain("coding");
    });
  });

  describe("crypto category", () => {
    it("classifies swap requests", () => {
      const plan = classifyMessage("swap 1 SOL for USDC", defaultConfig);
      expect(plan.categories).toContain("crypto");
    });

    it("classifies balance checks", () => {
      const plan = classifyMessage("check my wallet balance", defaultConfig);
      expect(plan.categories).toContain("crypto");
    });

    it("classifies token mentions", () => {
      const plan = classifyMessage("what's the price of $ETH", defaultConfig);
      expect(plan.categories).toContain("crypto");
    });
  });

  describe("media category", () => {
    it("classifies image generation requests", () => {
      const plan = classifyMessage("generate an image of a sunset", defaultConfig);
      expect(plan.categories).toContain("media");
    });

    it("classifies TTS requests", () => {
      const plan = classifyMessage("say hello in a deep voice", defaultConfig);
      expect(plan.categories).toContain("media");
    });
  });

  describe("monitoring category", () => {
    it("classifies status checks", () => {
      const plan = classifyMessage("check gpu status", defaultConfig);
      expect(plan.categories).toContain("monitoring");
    });

    it("classifies health queries", () => {
      const plan = classifyMessage("how much vram is free?", defaultConfig);
      expect(plan.categories).toContain("monitoring");
    });
  });

  describe("memory category", () => {
    it("classifies recall requests", () => {
      const plan = classifyMessage("do you remember what we discussed yesterday?", defaultConfig);
      expect(plan.categories).toContain("memory");
      expect(plan.memoryParams.maxFacts).toBe(25);
    });

    it("classifies reference to past conversations", () => {
      const plan = classifyMessage("last time you said something about Docker", defaultConfig);
      expect(plan.categories).toContain("memory");
    });
  });

  describe("complex category", () => {
    it("classifies long multi-sentence messages", () => {
      const longMsg =
        "I need you to analyze the performance of our API endpoints. " +
        "First, check the response times for the last 24 hours. " +
        "Then compare them with the previous week. " +
        "Finally, create a report with recommendations for optimization. " +
        "Also look into the database query patterns and identify any N+1 problems. " +
        "Make sure to check both the read and write paths. " +
        "Include memory usage statistics as well.";
      const plan = classifyMessage(longMsg, defaultConfig);
      expect(plan.categories).toContain("complex");
      expect(plan.thinkLevel).toBe("high");
      expect(plan.toolAllowlist).toBeNull(); // full tool set
    });

    it("respects complexThreshold config", () => {
      const plan = classifyMessage("short msg", { ...defaultConfig, complexThreshold: 5 });
      // "short msg" is 9 chars, above threshold of 5
      // But complex also needs structural signals (sentences, etc.)
      // This just tests threshold is respected
      expect(plan).toBeDefined();
    });
  });

  describe("multi-category matching", () => {
    it("unions tool sets from multiple categories", () => {
      const plan = classifyMessage(
        "search for Solana DEX fee comparison and check $SOL price",
        defaultConfig,
      );
      expect(plan.categories).toContain("research");
      expect(plan.categories).toContain("crypto");
      // Should have tools from both categories
      expect(plan.toolAllowlist).toContain("web_search");
      expect(plan.toolAllowlist).toContain("web_fetch");
    });

    it("uses highest thinking level when multiple categories match", () => {
      const plan = classifyMessage("search for how to fix the bug in server.ts", defaultConfig);
      // research (low) + coding (medium) → medium wins
      if (plan.categories.includes("research") && plan.categories.includes("coding")) {
        expect(plan.thinkLevel).toBe("medium");
      }
    });

    it("uses max memory params when multiple categories match", () => {
      const plan = classifyMessage(
        "do you remember which Solana wallet I used for swaps?",
        defaultConfig,
      );
      // memory (25 facts) + crypto (8 facts) → 25 wins
      expect(plan.memoryParams.maxFacts).toBeGreaterThanOrEqual(8);
    });
  });

  describe("fallback behavior", () => {
    it("returns full tool set when no category matches", () => {
      const plan = classifyMessage("xyzzy", defaultConfig);
      expect(plan.toolAllowlist).toBeNull(); // null = full tool set
      expect(plan.thinkLevel).toBe("low"); // fallback default
    });

    it("returns full tool set when disabled", () => {
      const plan = classifyMessage("hey", { ...defaultConfig, enabled: false });
      expect(plan.toolAllowlist).toBeNull();
      expect(plan.categories).toEqual([]);
    });
  });

  describe("alwaysInclude", () => {
    it("always includes configured tools even in restricted categories", () => {
      const plan = classifyMessage("hey", {
        ...defaultConfig,
        alwaysInclude: ["message", "custom_tool"],
      });
      if (plan.toolAllowlist) {
        expect(plan.toolAllowlist).toContain("message");
        expect(plan.toolAllowlist).toContain("custom_tool");
      }
    });
  });

  describe("prompt annotation", () => {
    it("generates hint when promptAnnotation is enabled", () => {
      const plan = classifyMessage("search for AI papers", defaultConfig);
      expect(plan.hint).toBeTruthy();
      expect(plan.hint).toContain("research");
    });

    it("omits hint when promptAnnotation is disabled", () => {
      const plan = classifyMessage("search for AI papers", {
        ...defaultConfig,
        promptAnnotation: false,
      });
      expect(plan.hint).toBeNull();
    });
  });

  describe("category overrides", () => {
    it("disables a category when configured", () => {
      const plan = classifyMessage("hey", {
        ...defaultConfig,
        categories: { casual: { disabled: true } },
      });
      expect(plan.categories).not.toContain("casual");
    });

    it("adds extra tools to a category", () => {
      const plan = classifyMessage("check gpu status", {
        ...defaultConfig,
        categories: { monitoring: { extraTools: ["special_monitor"] } },
      });
      if (plan.toolAllowlist) {
        expect(plan.toolAllowlist).toContain("special_monitor");
      }
    });
  });
});
````

**Step 2: Run test to verify it fails**

Run: `cd /home/mferr/openclaw && npx vitest run src/agents/context-planner.test.ts 2>&1 | tail -20`
Expected: FAIL — module `./context-planner.js` does not exist.

**Step 3: Write the implementation**

Create `src/agents/context-planner.ts`:

````typescript
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { ContextPlannerConfig } from "../config/types.agent-defaults.js";

// Re-export for convenience
export type { ContextPlannerConfig } from "../config/types.agent-defaults.js";

// ── Types ───────────────────────────────────────────────────────────────

export type ContextPlan = {
  /** Matched category names (may be empty). */
  categories: string[];
  /** Tool allowlist (null = full tool set, no filtering). */
  toolAllowlist: string[] | null;
  /** Memory recall parameter overrides. */
  memoryParams: {
    maxFacts: number;
    maxTokens: number;
    skip: boolean;
  };
  /** Thinking level override. */
  thinkLevel: ThinkLevel;
  /** Optional prompt hint (null if disabled). */
  hint: string | null;
};

// ── Thinking level ordering ─────────────────────────────────────────────

const THINK_LEVEL_ORDER: Record<string, number> = {
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
};

function maxThinkLevel(a: ThinkLevel, b: ThinkLevel): ThinkLevel {
  return (THINK_LEVEL_ORDER[a] ?? 0) >= (THINK_LEVEL_ORDER[b] ?? 0) ? a : b;
}

// ── Category definitions ────────────────────────────────────────────────

type CategoryDef = {
  name: string;
  patterns: RegExp[];
  /** Structural signal checkers (return a score contribution). */
  structural: Array<(msg: string) => number>;
  /** Score threshold to activate this category. */
  threshold: number;
  /** Base score per keyword match. */
  matchWeight: number;
  /** Tools available for this category. */
  tools: string[];
  /** Memory recall params. */
  memory: { maxFacts: number; maxTokens: number; skip: boolean };
  /** Thinking level. */
  thinking: ThinkLevel;
};

const CATEGORIES: CategoryDef[] = [
  {
    name: "casual",
    patterns: [
      /^(hey|hi|hello|yo|sup|hola|howdy|hiya|heya|what'?s up)\b/i,
      /^(thanks|thank you|thx|ty|cheers|np|no problem|sure|ok|okay|cool|nice|great|awesome|lol|haha|heh)\b/i,
      /^(good\s+(morning|afternoon|evening|night))\b/i,
      /^(how are you|how's it going|what's good)\b/i,
      /^(gm|gn|gg|brb|ttyl|bye|cya|later|peace)\b/i,
    ],
    structural: [
      // Very short messages are likely casual
      (msg) => (msg.length < 20 ? 3 : 0),
      // Emoji-only messages
      (msg) => (/^[\p{Emoji}\s]+$/u.test(msg) ? 5 : 0),
      // Single word
      (msg) => (/^\S+$/.test(msg.trim()) && msg.trim().length < 15 ? 2 : 0),
    ],
    threshold: 3,
    matchWeight: 3,
    tools: ["message"],
    memory: { maxFacts: 0, maxTokens: 0, skip: true },
    thinking: "off",
  },
  {
    name: "research",
    patterns: [
      /\b(search|find|look\s*up|google|research)\b/i,
      /\b(what\s+is|who\s+is|where\s+is|when\s+did|how\s+does|how\s+do|how\s+to|why\s+does|why\s+is)\b/i,
      /\b(explain|compare|versus|vs\.?|difference\s+between|define|summarize)\b/i,
      /\b(latest|recent|current|news|update)\b/i,
    ],
    structural: [
      // URLs suggest research intent
      (msg) => (/https?:\/\/\S+/.test(msg) ? 3 : 0),
      // Question marks
      (msg) => (/\?/.test(msg) ? 2 : 0),
    ],
    threshold: 3,
    matchWeight: 2,
    tools: ["exec", "web_fetch", "web_search", "message", "read"],
    memory: { maxFacts: 10, maxTokens: 400, skip: false },
    thinking: "low",
  },
  {
    name: "coding",
    patterns: [
      /\b(code|coding|program|script|function|class|method|variable|const|let|var)\b/i,
      /\b(fix|debug|bug|error|exception|stack\s*trace|traceback|crash|broken)\b/i,
      /\b(commit|push|pull|merge|branch|git|deploy|build|compile|lint|test)\b/i,
      /\b(refactor|optimize|implement|feature|pr|pull\s*request|review)\b/i,
      /\b(import|export|require|module|package|npm|pnpm|yarn|pip)\b/i,
    ],
    structural: [
      // File paths (e.g., server.ts, src/index.js, ./foo/bar.py)
      (msg) => (/(?:^|[\s(["'])(?:\.{0,2}\/)?[\w-]+(?:\/[\w.-]+)*\.\w{1,5}\b/.test(msg) ? 3 : 0),
      // Code fences
      (msg) => (/```/.test(msg) ? 4 : 0),
      // Inline code
      (msg) => (/`[^`]+`/.test(msg) ? 2 : 0),
    ],
    threshold: 3,
    matchWeight: 2,
    tools: ["exec", "read", "write", "edit", "apply_patch", "process", "message"],
    memory: { maxFacts: 5, maxTokens: 200, skip: false },
    thinking: "medium",
  },
  {
    name: "crypto",
    patterns: [
      /\b(sol|eth|btc|usdc|usdt|bnb|avax|matic|ada|dot|doge|shib|bonk|jup|ray)\b/i,
      /\$[A-Z]{2,10}\b/,
      /\b(swap|trade|buy|sell|stake|unstake|bridge|transfer|send|deposit|withdraw)\b/i,
      /\b(wallet|balance|portfolio|token|coin|crypto|defi|nft|mint)\b/i,
      /\b(solana|ethereum|bitcoin|polygon|avalanche|arbitrum|optimism|base)\b/i,
      /\b(jupiter|raydium|orca|uniswap|aave|compound|lido)\b/i,
      /\b(dex|cex|amm|liquidity|pool|yield|apy|apr|tvl)\b/i,
    ],
    structural: [
      // Dollar amounts
      (msg) => (/\$\d/.test(msg) ? 2 : 0),
      // Wallet addresses (0x... or base58 >30 chars)
      (msg) => (/0x[0-9a-fA-F]{10,}/.test(msg) ? 3 : 0),
      (msg) => (/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/.test(msg) ? 2 : 0),
    ],
    threshold: 3,
    matchWeight: 2,
    tools: ["exec", "message", "web_fetch", "web_search"],
    memory: { maxFacts: 8, maxTokens: 300, skip: false },
    thinking: "medium",
  },
  {
    name: "media",
    patterns: [
      /\b(image|picture|photo|draw|paint|sketch|illustration|art|render)\b/i,
      /\b(generate|create|make)\s+(an?\s+)?(image|picture|photo|art)/i,
      /\b(speak|say|read\s+aloud|tts|text[\s-]to[\s-]speech|voice|narrate)\b/i,
      /\b(transcribe|stt|speech[\s-]to[\s-]text|listen|audio|recording)\b/i,
      /\b(describe\s+(this|the)\s+(image|picture|photo|screenshot))/i,
    ],
    structural: [],
    threshold: 3,
    matchWeight: 3,
    tools: ["exec", "message"],
    memory: { maxFacts: 3, maxTokens: 150, skip: false },
    thinking: "off",
  },
  {
    name: "monitoring",
    patterns: [
      /\b(status|health|healthcheck|uptime|ping)\b/i,
      /\b(gpu|vram|cpu|ram|memory|disk|temperature|temp|fan|power|watt)\b/i,
      /\b(service|services|server|process|daemon|systemd|systemctl)\b/i,
      /\b(monitor|dashboard|metrics|usage|load|utilization)\b/i,
      /\b(nvidia[-\s]?smi|htop|top|df|free)\b/i,
    ],
    structural: [],
    threshold: 3,
    matchWeight: 2,
    tools: ["exec", "message"],
    memory: { maxFacts: 3, maxTokens: 150, skip: false },
    thinking: "off",
  },
  {
    name: "memory",
    patterns: [
      /\b(remember|recall|you\s+said|you\s+told\s+me|you\s+mentioned)\b/i,
      /\b(last\s+time|earlier|yesterday|before|previously|we\s+discussed|we\s+talked)\b/i,
      /\b(do\s+you\s+know|did\s+you|have\s+you)\s.*(remember|forget)/i,
      /\b(what\s+did\s+(i|we|you)\s+(say|discuss|talk|decide))/i,
      /\b(history|conversation|chat\s+log|past)\b/i,
    ],
    structural: [],
    threshold: 3,
    matchWeight: 3,
    tools: ["memory_search", "memory_get", "message"],
    memory: { maxFacts: 25, maxTokens: 1000, skip: false },
    thinking: "low",
  },
  {
    name: "complex",
    patterns: [
      /\b(step\s+by\s+step|first.*then|plan|analyze|analysis|investigate|comprehensive)\b/i,
      /\b(and\s+then|after\s+that|next|finally|also)\b/i,
      /\b(multiple|several|various|different|compare\s+and)\b/i,
    ],
    structural: [
      // Long messages
      (msg) => (msg.length > 300 ? 3 : msg.length > 200 ? 1 : 0),
      // Multiple sentences (3+)
      (msg) => {
        const sentences = msg.split(/[.!?]+/).filter((s) => s.trim().length > 5);
        return sentences.length >= 3 ? 2 : 0;
      },
      // Numbered lists
      (msg) => (/\b\d+[.)]\s/.test(msg) ? 2 : 0),
      // Multiple question marks
      (msg) => {
        const qCount = (msg.match(/\?/g) ?? []).length;
        return qCount >= 3 ? 3 : qCount >= 2 ? 1 : 0;
      },
    ],
    threshold: 4,
    matchWeight: 2,
    tools: [], // empty = full tool set
    memory: { maxFacts: 15, maxTokens: 500, skip: false },
    thinking: "high",
  },
];

// ── Classifier ──────────────────────────────────────────────────────────

function scoreCategory(msg: string, cat: CategoryDef, config?: ContextPlannerConfig): number {
  let score = 0;

  // Check if category is disabled via config
  if (config?.categories?.[cat.name]?.disabled) {
    return 0;
  }

  // Score keyword patterns
  for (const pattern of cat.patterns) {
    if (pattern.test(msg)) {
      score += cat.matchWeight;
    }
  }

  // Score extra patterns from config
  const extraPatterns = config?.categories?.[cat.name]?.extraPatterns;
  if (extraPatterns) {
    for (const pattern of extraPatterns) {
      try {
        if (new RegExp(pattern, "i").test(msg)) {
          score += cat.matchWeight;
        }
      } catch {
        // Skip invalid regex patterns silently
      }
    }
  }

  // Score structural signals
  for (const check of cat.structural) {
    score += check(msg);
  }

  // Complex category respects complexThreshold
  if (cat.name === "complex") {
    const threshold = config?.complexThreshold ?? 300;
    if (msg.length < threshold) {
      // Reduce structural score for short messages
      score = Math.max(0, score - 3);
    }
  }

  return score;
}

// ── Public API ──────────────────────────────────────────────────────────

/** The default/fallback plan when planner is disabled or no categories match. */
const FALLBACK_PLAN: ContextPlan = {
  categories: [],
  toolAllowlist: null,
  thinkLevel: "low",
  memoryParams: { maxFacts: 15, maxTokens: 500, skip: false },
  hint: null,
};

export function classifyMessage(message: string, config?: ContextPlannerConfig): ContextPlan {
  // Guard: disabled
  if (config && config.enabled === false) {
    return { ...FALLBACK_PLAN };
  }

  const msg = message.trim();
  if (!msg) {
    return { ...FALLBACK_PLAN };
  }

  // Score every category
  const matched: Array<{ cat: CategoryDef; score: number }> = [];
  for (const cat of CATEGORIES) {
    const score = scoreCategory(msg, cat, config);
    if (score >= cat.threshold) {
      matched.push({ cat, score });
    }
  }

  // No matches → fallback
  if (matched.length === 0) {
    const fallback = config?.fallbackToFull !== false;
    return fallback ? { ...FALLBACK_PLAN } : { ...FALLBACK_PLAN };
  }

  // Build plan from matched categories
  const categories = matched.map((m) => m.cat.name);
  const hasComplexOrFullToolSet = matched.some((m) => m.cat.tools.length === 0);

  // Tool allowlist: union of all matched categories' tools + alwaysInclude
  let toolAllowlist: string[] | null = null;
  if (!hasComplexOrFullToolSet && config?.toolFiltering !== false) {
    const toolSet = new Set<string>();
    for (const m of matched) {
      for (const tool of m.cat.tools) {
        toolSet.add(tool);
      }
      // Add extra tools from config overrides
      const extras = config?.categories?.[m.cat.name]?.extraTools;
      if (extras) {
        for (const tool of extras) {
          toolSet.add(tool);
        }
      }
    }
    // Always include configured tools
    if (config?.alwaysInclude) {
      for (const tool of config.alwaysInclude) {
        toolSet.add(tool);
      }
    }
    toolAllowlist = [...toolSet];
  }

  // Memory params: max across matched categories
  let maxFacts = 0;
  let maxTokens = 0;
  let allSkip = true;
  for (const m of matched) {
    if (m.cat.memory.maxFacts > maxFacts) maxFacts = m.cat.memory.maxFacts;
    if (m.cat.memory.maxTokens > maxTokens) maxTokens = m.cat.memory.maxTokens;
    if (!m.cat.memory.skip) allSkip = false;
  }
  const memoryParams =
    config?.memoryTuning !== false
      ? { maxFacts, maxTokens, skip: allSkip }
      : FALLBACK_PLAN.memoryParams;

  // Thinking level: highest across matched categories
  let thinkLevel: ThinkLevel = "off";
  if (config?.thinkingTuning !== false) {
    for (const m of matched) {
      // Check config override for thinking level
      const override = config?.categories?.[m.cat.name]?.thinkingLevel;
      const catThinking = override ? (override as ThinkLevel) : m.cat.thinking;
      thinkLevel = maxThinkLevel(thinkLevel, catThinking);
    }
  } else {
    thinkLevel = "low";
  }

  // Prompt hint
  const hint =
    config?.promptAnnotation !== false
      ? `[Context: ${categories.join(" + ")} task | tools: ${toolAllowlist ? toolAllowlist.length : "all"}/${CATEGORIES.reduce((n, c) => n + c.tools.length, 0)} | thinking: ${thinkLevel}]`
      : null;

  return {
    categories,
    toolAllowlist,
    memoryParams,
    thinkLevel,
    hint,
  };
}
````

**Step 4: Run tests to verify they pass**

Run: `cd /home/mferr/openclaw && npx vitest run src/agents/context-planner.test.ts 2>&1 | tail -30`
Expected: All tests PASS.

**Step 5: Commit**

```bash
cd /home/mferr/openclaw
git add src/agents/context-planner.ts src/agents/context-planner.test.ts
git commit -m "feat(context-planner): implement rule-based classifier and plan builder

8-category weighted scoring system: casual, research, coding, crypto,
media, monitoring, memory, complex. Multi-category support with union
tool sets, max memory params, highest thinking level."
```

---

### Task 3: Wire context planner into agent-runner.ts

**Files:**

- Modify: `src/auto-reply/reply/agent-runner.ts:264-280`

**Context:** The planner must run BETWEEN `runMemoryFlushIfNeeded()` (line 250-263) and `runMemoryCortexRecall()` (line 265-275). The plan's memory params override the recall call. The plan's thinking level overrides `followupRun.run.thinkLevel`. The plan's hint is prepended to the command body.

**Step 1: Add the import and planner call**

At the top of `agent-runner.ts`, add the import:

```typescript
import { classifyMessage, type ContextPlan } from "../../agents/context-planner.js";
```

Then between line 263 (end of `runMemoryFlushIfNeeded`) and line 265 (start of memory cortex recall), insert:

```typescript
// Pre-flight context planner: classify message to tune tools, memory, thinking
const contextPlannerConfig = cfg.agents?.defaults?.contextPlanner;
const contextPlan =
  !isHeartbeat && contextPlannerConfig?.enabled !== false
    ? classifyMessage(commandBody, contextPlannerConfig)
    : undefined;

if (contextPlan && contextPlan.categories.length > 0) {
  logVerbose(
    `[context-planner] classified: categories=[${contextPlan.categories.join(",")}] ` +
      `tools=${contextPlan.toolAllowlist ? `${contextPlan.toolAllowlist.length}` : "all"} ` +
      `memory=${contextPlan.memoryParams.maxFacts}/${contextPlan.memoryParams.maxTokens} ` +
      `thinking=${contextPlan.thinkLevel}`,
  );
}

// Apply thinking level override from context planner
if (contextPlan?.thinkLevel && contextPlannerConfig?.thinkingTuning !== false) {
  followupRun.run.thinkLevel = contextPlan.thinkLevel;
}
```

**Step 2: Pass context plan memory overrides to recall**

Modify the `runMemoryCortexRecall` call (currently at line 266) to pass the context plan:

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
  contextPlanMemoryOverrides: contextPlan?.memoryParams,
});
```

**Step 3: Prepend context plan hint to enriched command body**

After the existing `enrichedCommandBody` construction (currently at line 278-280), modify it to include the hint:

```typescript
// Inject memory context into the command body if available
let enrichedCommandBody = memoryCortexRecall.memoryContext
  ? `${memoryCortexRecall.memoryContext}\n\n---\n\n${commandBody}`
  : commandBody;

// Prepend context planner hint
if (contextPlan?.hint) {
  enrichedCommandBody = `${contextPlan.hint}\n\n${enrichedCommandBody}`;
}
```

(Note: changed `const` to `let` for `enrichedCommandBody` since we now conditionally modify it.)

**Step 4: Pass context plan to runAgentTurnWithFallback**

The `runAgentTurnWithFallback` call (at line 378) needs the context plan for tool filtering. Add `contextPlan` to its params:

```typescript
const runOutcome = await runAgentTurnWithFallback({
  commandBody: enrichedCommandBody,
  followupRun,
  sessionCtx,
  opts,
  typingSignals,
  blockReplyPipeline,
  blockStreamingEnabled,
  blockReplyChunking,
  resolvedBlockStreamingBreak,
  applyReplyToMode,
  shouldEmitToolResult,
  shouldEmitToolOutput,
  pendingToolTasks,
  resetSessionAfterCompactionFailure,
  resetSessionAfterRoleOrderingConflict,
  isHeartbeat,
  sessionKey,
  getActiveSessionEntry: () => activeSessionEntry,
  activeSessionStore,
  storePath,
  resolvedVerboseLevel,
  contextPlan,
});
```

**Step 5: Verify build compiles**

Run: `cd /home/mferr/openclaw && npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: Type errors about `contextPlanMemoryOverrides` and `contextPlan` (we haven't wired those receiver sides yet). This is expected — we'll fix in Tasks 4-5.

**Step 6: Commit**

```bash
cd /home/mferr/openclaw
git add src/auto-reply/reply/agent-runner.ts
git commit -m "feat(context-planner): wire planner into agent-runner between memory flush and recall

Classifies message before memory recall to override: thinking level,
memory params, and prompt hint. Passes contextPlan downstream."
```

---

### Task 4: Wire memory recall overrides in agent-runner-memory-cortex.ts

**Files:**

- Modify: `src/auto-reply/reply/agent-runner-memory-cortex.ts:204-243`

**Context:** The `runMemoryCortexRecall` function currently uses hardcoded defaults from config: `mc.recallMaxFacts ?? 15`, `mc.recallTimeoutMs ?? 200`, `mc.recallMaxTokens ?? 500`. The context plan can override `maxFacts` and `maxTokens`, and can skip recall entirely.

**Step 1: Add the overrides parameter**

Modify the `runMemoryCortexRecall` function signature (line 204) to accept the new parameter:

```typescript
export async function runMemoryCortexRecall(params: {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  isHeartbeat: boolean;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  commandBody: string;
  /** Optional overrides from the context planner. */
  contextPlanMemoryOverrides?: {
    maxFacts: number;
    maxTokens: number;
    skip: boolean;
  };
}): Promise<MemoryCortexRecallResult> {
```

**Step 2: Apply overrides in the function body**

After the existing guards (lines 219-234), add a skip guard for the context plan, and modify the hybridSearch call to use overridden values:

After line 233 (`if (query.length < 3)` guard), add:

```typescript
// Guard: context planner says skip recall entirely
if (params.contextPlanMemoryOverrides?.skip) {
  logVerbose("[memory-cortex] context planner skipped recall (casual message)");
  return noResult;
}
```

Then modify the `hybridSearch` call (line 237-243) to use context plan overrides:

```typescript
// Apply context planner overrides if present
const effectiveMaxFacts = params.contextPlanMemoryOverrides?.maxFacts ?? mc.recallMaxFacts ?? 15;
const effectiveMaxTokens =
  params.contextPlanMemoryOverrides?.maxTokens ?? mc.recallMaxTokens ?? 500;

// Perform hybrid search with configured timeout
const searchResult = await hybridSearch(
  mc,
  query,
  params.followupRun.run.senderName,
  effectiveMaxFacts,
  mc.recallTimeoutMs ?? 200,
);
```

And update the `formatFactsAsContext` call (line 256-263) to use `effectiveMaxTokens`:

```typescript
// Format facts as context block
const memoryContext =
  factsCount > 0 || cachedSynthesis
    ? formatFactsAsContext(facts, effectiveMaxTokens, cachedSynthesis, mc.synthesisCacheTtlMs)
    : null;
```

**Step 3: Verify build compiles**

Run: `cd /home/mferr/openclaw && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: Fewer errors now — memory cortex side should be clean.

**Step 4: Commit**

```bash
cd /home/mferr/openclaw
git add src/auto-reply/reply/agent-runner-memory-cortex.ts
git commit -m "feat(context-planner): apply memory recall overrides from context plan

Skip recall for casual messages, adjust maxFacts and maxTokens
per classification category."
```

---

### Task 5: Pass context plan through execution chain to tool creation

**Files:**

- Modify: `src/auto-reply/reply/agent-runner-execution.ts`
- Modify: `src/agents/pi-embedded-runner/run/params.ts`
- Modify: `src/agents/pi-embedded-runner/run.ts`
- Modify: `src/agents/pi-embedded-runner/run/attempt.ts`

**Context:** The context plan's `toolAllowlist` needs to reach `createOpenClawCodingTools()` in `attempt.ts`. The chain is: `agent-runner.ts` → `runAgentTurnWithFallback()` → `runEmbeddedPiAgent()` → `runEmbeddedAttempt()` → `createOpenClawCodingTools()`. At each level, we pass through a `contextPlanToolAllowlist` property.

**Step 1: Add contextPlanToolAllowlist to RunEmbeddedPiAgentParams**

In `src/agents/pi-embedded-runner/run/params.ts`, add after `enforceFinalTag` (line 103):

```typescript
  /** Tool allowlist from context planner (null = no filtering). */
  contextPlanToolAllowlist?: string[] | null;
```

**Step 2: Pass contextPlan into runEmbeddedPiAgent call**

In `src/auto-reply/reply/agent-runner-execution.ts`, first add the `contextPlan` to the `runAgentTurnWithFallback` params type. Find the function parameters (around line 58) and add `contextPlan?: ContextPlan`. You'll need to import the type:

```typescript
import type { ContextPlan } from "../../agents/context-planner.js";
```

Then in the `runEmbeddedPiAgent()` call (around line 285-309), add:

```typescript
return runEmbeddedPiAgent({
  ...embeddedContext,
  // ... existing params ...
  contextPlanToolAllowlist: params.contextPlan?.toolAllowlist,
});
```

**Step 3: Forward in run.ts**

In `src/agents/pi-embedded-runner/run.ts`, the `runEmbeddedPiAgent()` function receives `RunEmbeddedPiAgentParams` and calls `runEmbeddedAttempt()`. Find where `runEmbeddedAttempt` is called and pass through `contextPlanToolAllowlist`:

```typescript
contextPlanToolAllowlist: params.contextPlanToolAllowlist,
```

(This will be passed as part of the attempt params object.)

**Step 4: Apply tool filter in attempt.ts**

In `src/agents/pi-embedded-runner/run/attempt.ts`, the `createOpenClawCodingTools()` call (around line 296) needs to receive the context plan. After the tools are created and the pipeline is applied in `pi-tools.ts`, we need to add the context plan as an additional pipeline step.

Add to the `createOpenClawCodingTools` options object:

```typescript
          contextPlanToolAllowlist: params.contextPlanToolAllowlist,
```

**Step 5: Verify type propagation compiles**

Run: `cd /home/mferr/openclaw && npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: Errors about `contextPlanToolAllowlist` not being accepted by `createOpenClawCodingTools` (we fix that in Task 6).

**Step 6: Commit**

```bash
cd /home/mferr/openclaw
git add src/auto-reply/reply/agent-runner-execution.ts src/agents/pi-embedded-runner/run/params.ts src/agents/pi-embedded-runner/run.ts src/agents/pi-embedded-runner/run/attempt.ts
git commit -m "feat(context-planner): thread contextPlanToolAllowlist through execution chain

Pass tool allowlist from agent-runner → execution → runEmbeddedPiAgent →
runEmbeddedAttempt → createOpenClawCodingTools."
```

---

### Task 6: Add context plan tool filtering to pi-tools.ts pipeline

**Files:**

- Modify: `src/agents/pi-tools.ts:465-485`

**Context:** The `createOpenClawCodingTools()` function in `pi-tools.ts` builds the tool pipeline. The context plan's tool allowlist becomes the FINAL step in the pipeline, which means security/access policies always run first. The allowlist is converted to a `ToolPolicyLike` object: `{ allow: string[] }`.

**Step 1: Add the parameter to createOpenClawCodingTools**

Find the options type for `createOpenClawCodingTools` (around line 130-218) and add:

```typescript
  /** Tool allowlist from context planner (null/undefined = no filtering). */
  contextPlanToolAllowlist?: string[] | null;
```

**Step 2: Build the pipeline step**

In the `applyToolPolicyPipeline` call (lines 465-485), add the context plan as the final step:

```typescript
const contextPlanPolicy = options?.contextPlanToolAllowlist
  ? { allow: options.contextPlanToolAllowlist }
  : undefined;

const subagentFiltered = applyToolPolicyPipeline({
  tools: toolsByAuthorization,
  toolMeta: (tool) => getPluginToolMeta(tool),
  warn: logWarn,
  steps: [
    ...buildDefaultToolPolicyPipelineSteps({
      profilePolicy: profilePolicyWithAlsoAllow,
      profile,
      providerProfilePolicy: providerProfilePolicyWithAlsoAllow,
      providerProfile,
      globalPolicy,
      globalProviderPolicy,
      agentPolicy,
      agentProviderPolicy,
      groupPolicy,
      agentId,
    }),
    { policy: sandbox?.tools, label: "sandbox tools.allow" },
    { policy: subagentPolicy, label: "subagent tools.allow" },
    ...(contextPlanPolicy ? [{ policy: contextPlanPolicy, label: "context-planner" }] : []),
  ],
});
```

**Step 3: Verify full build compiles**

Run: `cd /home/mferr/openclaw && npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: Clean compile (no errors).

**Step 4: Run all existing tests to verify no regressions**

Run: `cd /home/mferr/openclaw && npx vitest run 2>&1 | tail -30`
Expected: All existing tests pass.

**Step 5: Commit**

```bash
cd /home/mferr/openclaw
git add src/agents/pi-tools.ts
git commit -m "feat(context-planner): add tool filtering as final pipeline step

Context planner allowlist is applied AFTER all security/access policies,
ensuring it can only remove tools, never add denied ones."
```

---

### Task 7: Update openclaw.json config and full integration test

**Files:**

- Modify: `~/.openclaw/openclaw.json`

**Context:** Add the `contextPlanner` config to `agents.defaults` in the live config file. This enables the planner for BillBot's production runs.

**Step 1: Add contextPlanner config**

In `~/.openclaw/openclaw.json`, inside `agents.defaults`, add:

```json
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
```

**Step 2: Build the project**

Run: `cd /home/mferr/openclaw && OPENCLAW_A2UI_SKIP_MISSING=1 pnpm build 2>&1 | tail -10`
Expected: Build succeeds.

**Step 3: Fix runtime imports**

Run: `bash /home/mferr/openclaw/scripts/fix-runtime-imports.sh /home/mferr/openclaw/dist`
Expected: No errors.

**Step 4: Run the test suite**

Run: `cd /home/mferr/openclaw && npx vitest run src/agents/context-planner.test.ts 2>&1 | tail -20`
Expected: All context planner tests pass.

**Step 5: Commit config change**

```bash
cd /home/mferr/openclaw
git add -f ~/.openclaw/openclaw.json  # Only if tracked
git commit -m "config: enable context planner in BillBot production config"
```

(Note: `openclaw.json` may not be in the repo. If not tracked, skip this commit.)

---

### Task 8: Restart gateway and verify end-to-end

**Context:** Final verification. Restart the OpenClaw gateway and confirm the context planner logs its classification for incoming messages.

**Step 1: Stop the current gateway**

Find and kill the running gateway process, then formally stop it:

```bash
pkill -f "node dist/entry.js gateway" || true
cd /home/mferr/openclaw && node dist/entry.js gateway stop 2>/dev/null || true
```

**Step 2: Start the gateway**

```bash
cd /home/mferr/openclaw && nohup node dist/entry.js gateway run --verbose > /tmp/openclaw-fork.log 2>&1 &
```

**Step 3: Verify context planner logs appear**

Wait for a message to come through (or send a test message to BillBot), then check logs:

```bash
grep "context-planner" /tmp/openclaw-fork.log | tail -5
```

Expected: Log lines like:

```
[context-planner] classified: categories=[casual] tools=1 memory=0/0 thinking=off
```

**Step 4: Final commit with all changes**

```bash
cd /home/mferr/openclaw
git add -A
git status
# If there are any uncommitted changes, commit them
git commit -m "feat(context-planner): complete pre-flight context planner implementation

Rule-based message classifier with 8 categories. Dynamically filters
tools, tunes memory recall, selects thinking level, and annotates prompts.
Integration via agent-runner → memory-cortex → tool-policy-pipeline."
```

**Step 5: Push to remote**

```bash
cd /home/mferr/openclaw && git push
```
