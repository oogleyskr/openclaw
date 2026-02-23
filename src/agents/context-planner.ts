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
    return { ...FALLBACK_PLAN };
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
    if (m.cat.memory.maxFacts > maxFacts) {
      maxFacts = m.cat.memory.maxFacts;
    }
    if (m.cat.memory.maxTokens > maxTokens) {
      maxTokens = m.cat.memory.maxTokens;
    }
    if (!m.cat.memory.skip) {
      allSkip = false;
    }
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
      ? `[Context: ${categories.join(" + ")} task | tools: ${toolAllowlist ? toolAllowlist.length : "all"} | thinking: ${thinkLevel}]`
      : null;

  return {
    categories,
    toolAllowlist,
    memoryParams,
    thinkLevel,
    hint,
  };
}
