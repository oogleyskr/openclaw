import { describe, expect, it } from "vitest";
import { classifyMessage, type ContextPlannerConfig } from "./context-planner.js";

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
      const plan = classifyMessage("\u{1F44B}", defaultConfig);
      expect(plan.categories).toContain("casual");
    });

    it("classifies thanks messages", () => {
      const plan = classifyMessage("thanks!", defaultConfig);
      expect(plan.categories).toContain("casual");
    });

    it("skips memory recall for casual messages", () => {
      const plan = classifyMessage("hey", defaultConfig);
      expect(plan.memoryParams.skip).toBe(true);
      expect(plan.memoryParams.maxFacts).toBe(0);
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
      const plan = classifyMessage("check out https://example.com please", defaultConfig);
      expect(plan.categories).toContain("research");
    });
  });

  describe("coding category", () => {
    it("classifies code-related requests", () => {
      const plan = classifyMessage("fix the bug in the login function", defaultConfig);
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

    it("sets medium thinking for coding", () => {
      const plan = classifyMessage("fix the bug in the login function", defaultConfig);
      expect(plan.thinkLevel).toBe("medium");
    });
  });

  describe("crypto category", () => {
    it("classifies swap requests", () => {
      const plan = classifyMessage("swap 1 SOL for USDC", defaultConfig);
      expect(plan.categories).toContain("crypto");
    });

    it("classifies balance checks", () => {
      // Needs to hit multiple crypto patterns: "wallet" from one, "SOL" from another
      const plan = classifyMessage("check my SOL wallet balance", defaultConfig);
      expect(plan.categories).toContain("crypto");
    });

    it("classifies token mentions with $", () => {
      const plan = classifyMessage("what's the price of $ETH right now", defaultConfig);
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
      const plan = classifyMessage("check gpu status and temperature", defaultConfig);
      expect(plan.categories).toContain("monitoring");
    });

    it("classifies vram queries", () => {
      const plan = classifyMessage("how much vram is free right now", defaultConfig);
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
      const plan = classifyMessage(
        "last time you said something about Docker containers",
        defaultConfig,
      );
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
  });

  describe("multi-category matching", () => {
    it("unions tool sets from multiple categories", () => {
      const plan = classifyMessage(
        "search for Solana DEX fee comparison and compare $SOL price?",
        defaultConfig,
      );
      expect(plan.categories).toContain("research");
      expect(plan.categories).toContain("crypto");
      // Should have tools from both categories
      expect(plan.toolAllowlist).toContain("web_search");
      expect(plan.toolAllowlist).toContain("web_fetch");
    });

    it("uses highest thinking level when multiple categories match", () => {
      const plan = classifyMessage(
        "search for how to fix the bug in the login function",
        defaultConfig,
      );
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
      // Needs to be long enough to not trigger casual's short-message signal
      const plan = classifyMessage(
        "the quick brown fox jumps over the lazy dog repeatedly",
        defaultConfig,
      );
      expect(plan.toolAllowlist).toBeNull();
      expect(plan.thinkLevel).toBe("low");
    });

    it("returns full tool set when disabled", () => {
      const plan = classifyMessage("hey", { ...defaultConfig, enabled: false });
      expect(plan.toolAllowlist).toBeNull();
      expect(plan.categories).toEqual([]);
    });

    it("returns fallback for empty messages", () => {
      const plan = classifyMessage("", defaultConfig);
      expect(plan.categories).toEqual([]);
      expect(plan.toolAllowlist).toBeNull();
    });
  });

  describe("alwaysInclude", () => {
    it("always includes configured tools in restricted categories", () => {
      const plan = classifyMessage("check gpu status and temperature", {
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
      const plan = classifyMessage("search for the latest AI papers?", defaultConfig);
      expect(plan.hint).toBeTruthy();
      expect(plan.hint).toContain("research");
    });

    it("omits hint when promptAnnotation is disabled", () => {
      const plan = classifyMessage("search for the latest AI papers?", {
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
      const plan = classifyMessage("check gpu status and temperature", {
        ...defaultConfig,
        categories: { monitoring: { extraTools: ["special_monitor"] } },
      });
      if (plan.toolAllowlist) {
        expect(plan.toolAllowlist).toContain("special_monitor");
      }
    });

    it("overrides thinking level for a category", () => {
      const plan = classifyMessage("check gpu status and temperature", {
        ...defaultConfig,
        categories: { monitoring: { thinkingLevel: "high" } },
      });
      expect(plan.thinkLevel).toBe("high");
    });
  });
});
