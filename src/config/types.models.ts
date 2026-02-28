import type { SecretInput } from "./types.secrets.js";

export const MODEL_APIS = [
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "google-generative-ai",
  "github-copilot",
  "bedrock-converse-stream",
  "ollama",
] as const;

export type ModelApi = (typeof MODEL_APIS)[number];

export type ModelCompatConfig = {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean;
  supportsStrictMode?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  thinkingFormat?: "openai" | "zai" | "qwen";
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean;
  requiresMistralToolIds?: boolean;
  /**
   * Configurable patterns for parsing non-standard tool call formats from model output.
   * Each pattern has a `tag` (XML tag name) and optional `format` hint.
   * Example: [{ "tag": "tool_call" }, { "tag": "tools" }]
   */
  toolCallPatterns?: Array<{ tag: string; format?: "json" | "name-arguments" }>;
};

export type ModelProviderAuthMode = "api-key" | "aws-sdk" | "oauth" | "token";

export type ModelDefinitionConfig = {
  id: string;
  name: string;
  api?: ModelApi;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: ModelCompatConfig;
};

export type ModelProviderConfig = {
  baseUrl: string;
  apiKey?: SecretInput;
  auth?: ModelProviderAuthMode;
  api?: ModelApi;
  injectNumCtxForOpenAICompat?: boolean;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models: ModelDefinitionConfig[];
  /** Health check configuration for the provider endpoint. */
  healthCheck?: {
    enabled?: boolean;
    /** Endpoint path to check (default: "/health"). */
    endpoint?: string;
    /** Interval in seconds between checks. */
    intervalSeconds?: number;
  };
  /** Retry configuration for failed requests to this provider. */
  retry?: {
    /** Maximum number of retry attempts. */
    attempts?: number;
    /** Minimum delay between retries in milliseconds. */
    minDelayMs?: number;
    /** Maximum delay between retries in milliseconds. */
    maxDelayMs?: number;
  };
};

export type BedrockDiscoveryConfig = {
  enabled?: boolean;
  region?: string;
  providerFilter?: string[];
  refreshInterval?: number;
  defaultContextWindow?: number;
  defaultMaxTokens?: number;
};

export type ModelsConfig = {
  mode?: "merge" | "replace";
  providers?: Record<string, ModelProviderConfig>;
  bedrockDiscovery?: BedrockDiscoveryConfig;
};
