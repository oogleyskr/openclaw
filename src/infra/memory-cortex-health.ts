import type { MemoryCortexConfig } from "../config/types.infrastructure.js";

export type MemoryCortexSnapshot = {
  /** Overall status: ok if both llm and middleware are healthy. */
  status: "ok" | "degraded" | "error";
  /** llama-server health status. */
  llmStatus: "ok" | "error";
  /** llama-server host:port. */
  llmEndpoint: string;
  /** Model name from /props or /v1/models. */
  modelName?: string;
  /** GPU name (hardcoded for now since AMD has no monitoring API). */
  gpuName: string;
  /** VRAM total in MB (known from hardware specs). */
  vramTotalMB: number;
  /** Approximate VRAM used in MB (model size + KV cache estimate). */
  vramUsedMB?: number;
  /** Generation speed in tokens/second (computed from metrics delta). */
  generationTokPerSec?: number;
  /** Prompt processing speed in tokens/second. */
  promptTokPerSec?: number;
  /** KV cache usage ratio (0-1). */
  kvCacheUsageRatio?: number;
  /** Number of cached tokens in KV cache. */
  kvCacheTokens?: number;
  /** Number of active/processing requests. */
  requestsProcessing?: number;
  /** Middleware health status. */
  middlewareStatus: "ok" | "error";
  /** Middleware host:port. */
  middlewareEndpoint: string;
  /** Total memories stored in the database. */
  memoriesCount?: number;
  /** Middleware latency in ms. */
  middlewareLatencyMs?: number;
  /** llama-server latency in ms. */
  llmLatencyMs?: number;
  /** Timestamp of collection. */
  collectedAt: number;
  /** Error message if any. */
  error?: string;
  /** GPU temperature (edge/junction) in Celsius from LibreHardwareMonitor. */
  gpuTemperatureCelsius?: number;
  /** GPU hot spot temperature in Celsius. */
  gpuHotSpotCelsius?: number;
  /** GPU core clock in MHz. */
  gpuCoreClockMHz?: number;
  /** GPU memory clock in MHz. */
  gpuMemoryClockMHz?: number;
  /** GPU utilization percentage (0-100). */
  gpuUtilizationPercent?: number;
  /** GPU fan speed in RPM. */
  gpuFanRPM?: number;
  /** GPU fan speed percentage. */
  gpuFanPercent?: number;
  /** GPU power draw in watts. */
  gpuPowerDrawWatts?: number;
  /** LibreHardwareMonitor status. */
  hwMonitorStatus?: "ok" | "error";
  /** LibreHardwareMonitor fetch latency in ms. */
  hwMonitorLatencyMs?: number;
  /** List of available sensor categories. */
  hwSensorsAvailable?: string[];
};

// Previous metrics totals for computing delta-based tokens/sec.
let prevPredictedTokens: number | null = null;
let prevPredictedSeconds: number | null = null;
let prevPromptTokens: number | null = null;
let prevPromptSeconds: number | null = null;

/**
 * Parse Prometheus-format metrics from llama-server's /metrics endpoint.
 */
function parsePrometheusMetrics(text: string): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || line.trim() === "") {
      continue;
    }
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) {
      const val = parseFloat(parts[1]);
      if (Number.isFinite(val)) {
        metrics[parts[0]] = val;
      }
    }
  }
  return metrics;
}

// ── LibreHardwareMonitor JSON types and parser ──

/** Node in LHM's data.json tree. */
type LhmNode = {
  id: number;
  Text: string;
  Min?: string;
  Value?: string;
  Max?: string;
  ImageURL?: string;
  Children?: LhmNode[];
};

/** Strip units from LHM sensor values like "64,0 °C" → 64.0 */
function parseLhmValue(raw: string | undefined): number | undefined {
  if (!raw || raw === "-") {
    return undefined;
  }
  // LHM uses comma as decimal separator in some locales
  const cleaned = raw
    .replace(/,/g, ".")
    .replace(/[^0-9.-]/g, "")
    .trim();
  const val = parseFloat(cleaned);
  return Number.isFinite(val) ? val : undefined;
}

/** Find a child node by partial text match (case-insensitive). */
function findLhmChild(node: LhmNode, text: string): LhmNode | undefined {
  return node.Children?.find((c) => c.Text.toLowerCase().includes(text.toLowerCase()));
}

/** Find a sensor value inside a category node by partial name match. */
function findLhmSensor(category: LhmNode | undefined, name: string): number | undefined {
  if (!category?.Children) {
    return undefined;
  }
  const sensor = category.Children.find((c) => c.Text.toLowerCase().includes(name.toLowerCase()));
  return parseLhmValue(sensor?.Value);
}

type LhmGpuMetrics = {
  temperatureCelsius?: number;
  hotSpotCelsius?: number;
  coreClockMHz?: number;
  memoryClockMHz?: number;
  utilizationPercent?: number;
  fanRPM?: number;
  fanPercent?: number;
  powerDrawWatts?: number;
  sensorsAvailable: string[];
};

/** Parse LHM data.json and extract AMD GPU metrics. */
function parseLhmGpuMetrics(data: LhmNode): LhmGpuMetrics | undefined {
  // Walk the tree to find the AMD GPU node
  // Structure: root → Computer → Hardware (AMD Radeon VII) → sub-hardware/sensors
  const findGpuNode = (node: LhmNode): LhmNode | undefined => {
    const text = node.Text.toLowerCase();
    if (text.includes("radeon") || (text.includes("amd") && text.includes("gpu"))) {
      return node;
    }
    if (node.Children) {
      for (const child of node.Children) {
        const found = findGpuNode(child);
        if (found) {
          return found;
        }
      }
    }
    return undefined;
  };

  const gpu = findGpuNode(data);
  if (!gpu) {
    return undefined;
  }

  const temps = findLhmChild(gpu, "temperature");
  const clocks = findLhmChild(gpu, "clock");
  const fans = findLhmChild(gpu, "fan");
  const powers = findLhmChild(gpu, "power");
  const loads = findLhmChild(gpu, "load");

  const sensorsAvailable: string[] = [];
  if (temps?.Children?.length) {
    sensorsAvailable.push("temperatures");
  }
  if (clocks?.Children?.length) {
    sensorsAvailable.push("clocks");
  }
  if (fans?.Children?.length) {
    sensorsAvailable.push("fans");
  }
  if (powers?.Children?.length) {
    sensorsAvailable.push("powers");
  }
  if (loads?.Children?.length) {
    sensorsAvailable.push("loads");
  }

  return {
    temperatureCelsius:
      findLhmSensor(temps, "edge") ??
      findLhmSensor(temps, "gpu core") ??
      findLhmSensor(temps, "temperature"),
    hotSpotCelsius: findLhmSensor(temps, "hot spot") ?? findLhmSensor(temps, "junction"),
    coreClockMHz: findLhmSensor(clocks, "core") ?? findLhmSensor(clocks, "gpu"),
    memoryClockMHz: findLhmSensor(clocks, "memory"),
    utilizationPercent: findLhmSensor(loads, "core") ?? findLhmSensor(loads, "gpu"),
    fanRPM: findLhmSensor(fans, "fan"),
    fanPercent: findLhmSensor(fans, "fan") != null ? findLhmSensor(loads, "fan") : undefined,
    powerDrawWatts:
      findLhmSensor(powers, "package") ??
      findLhmSensor(powers, "total") ??
      findLhmSensor(powers, "gpu"),
    sensorsAvailable,
  };
}

/**
 * Collect Memory Cortex health data from the llama-server and middleware.
 */
export async function collectMemoryCortexHealth(
  config: MemoryCortexConfig,
): Promise<MemoryCortexSnapshot> {
  const llmHost = config.llmHost ?? "172.17.96.1";
  const llmPort = config.llmPort ?? 8301;
  const mwHost = config.middlewareHost ?? "localhost";
  const mwPort = config.middlewarePort ?? 8300;

  const result: MemoryCortexSnapshot = {
    status: "error",
    llmStatus: "error",
    llmEndpoint: `${llmHost}:${llmPort}`,
    gpuName: "AMD Radeon VII 16GB HBM2",
    vramTotalMB: 16384,
    middlewareStatus: "error",
    middlewareEndpoint: `${mwHost}:${mwPort}`,
    collectedAt: Date.now(),
  };

  // -- Check llama-server --
  const llmHealthUrl = `http://${llmHost}:${llmPort}/health`;
  const llmMetricsUrl = `http://${llmHost}:${llmPort}/metrics`;
  const llmPropsUrl = `http://${llmHost}:${llmPort}/props`;

  // Health check
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const t0 = Date.now();
    const resp = await fetch(llmHealthUrl, { signal: controller.signal });
    clearTimeout(timeout);
    result.llmLatencyMs = Date.now() - t0;

    if (resp.ok) {
      const body = (await resp.json()) as Record<string, unknown>;
      result.llmStatus = body.status === "ok" ? "ok" : "error";
      if (typeof body.slots_processing === "number") {
        result.requestsProcessing = body.slots_processing;
      }
    }
  } catch {
    // llm unreachable
  }

  // Props (model name)
  if (result.llmStatus === "ok") {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3_000);
      const resp = await fetch(llmPropsUrl, { signal: controller.signal });
      clearTimeout(timeout);

      if (resp.ok) {
        const body = (await resp.json()) as Record<string, unknown>;
        // model_alias is set by llama-server; fall back to model_path
        if (typeof body.model_alias === "string" && body.model_alias) {
          result.modelName = body.model_alias;
        } else if (typeof body.model_path === "string" && body.model_path) {
          result.modelName = body.model_path.split(/[/\\]/).pop() ?? body.model_path;
        }
      }
    } catch {
      // ignore
    }
  }

  // Metrics (tokens/sec, KV cache)
  if (result.llmStatus === "ok") {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3_000);
      const resp = await fetch(llmMetricsUrl, { signal: controller.signal });
      clearTimeout(timeout);

      if (resp.ok) {
        const text = await resp.text();
        const m = parsePrometheusMetrics(text);

        // Helper: metric keys use "llamacpp:" prefix (colon) in newer builds, "llamacpp_" (underscore) in older
        const get = (base: string): number | undefined =>
          m[base.replace("llamacpp_", "llamacpp:")] ?? m[base];

        // KV cache
        const kvRatioVal = get("llamacpp_kv_cache_usage_ratio");
        if (kvRatioVal != null) {
          result.kvCacheUsageRatio = Math.round(kvRatioVal * 1000) / 1000;
        }
        const kvTokensVal = get("llamacpp_kv_cache_tokens");
        if (kvTokensVal != null) {
          result.kvCacheTokens = Math.round(kvTokensVal);
        }

        // Requests
        const reqProc = get("llamacpp_requests_processing");
        if (reqProc != null) {
          result.requestsProcessing = reqProc;
        }

        // Compute generation tokens/sec from delta
        const curPredTokens = get("llamacpp_tokens_predicted_total");
        const curPredSec = get("llamacpp_tokens_predicted_seconds_total");
        if (
          curPredTokens != null &&
          curPredSec != null &&
          prevPredictedTokens != null &&
          prevPredictedSeconds != null
        ) {
          const dtTokens = curPredTokens - prevPredictedTokens;
          const dtSec = curPredSec - prevPredictedSeconds;
          if (dtSec > 0 && dtTokens > 0) {
            result.generationTokPerSec = Math.round((dtTokens / dtSec) * 10) / 10;
          }
        }
        prevPredictedTokens = curPredTokens ?? null;
        prevPredictedSeconds = curPredSec ?? null;

        // Compute prompt tokens/sec from delta
        const curPromptTokens = get("llamacpp_prompt_tokens_total");
        const curPromptSec = get("llamacpp_prompt_seconds_total");
        if (
          curPromptTokens != null &&
          curPromptSec != null &&
          prevPromptTokens != null &&
          prevPromptSeconds != null
        ) {
          const dtTokens = curPromptTokens - prevPromptTokens;
          const dtSec = curPromptSec - prevPromptSeconds;
          if (dtSec > 0 && dtTokens > 0) {
            result.promptTokPerSec = Math.round((dtTokens / dtSec) * 10) / 10;
          }
        }
        prevPromptTokens = curPromptTokens ?? null;
        prevPromptSeconds = curPromptSec ?? null;

        // Fallback: use the server's own average if delta wasn't computed
        if (result.generationTokPerSec == null) {
          const avgPredicted = get("llamacpp_predicted_tokens_seconds");
          if (avgPredicted != null && avgPredicted > 0) {
            result.generationTokPerSec = Math.round(avgPredicted * 10) / 10;
          }
        }
        if (result.promptTokPerSec == null) {
          const avgPrompt = get("llamacpp_prompt_tokens_seconds");
          if (avgPrompt != null && avgPrompt > 0) {
            result.promptTokPerSec = Math.round(avgPrompt * 10) / 10;
          }
        }

        // Estimate VRAM used: ~8.2GB model + proportional KV cache
        // Qwen3-8B Q8_0 is ~8.2GB, KV cache is the rest of the 16GB
        const modelSizeMB = 8400; // ~8.2GB model weight
        const kvRatio = result.kvCacheUsageRatio ?? 0;
        const kvCapacityMB = result.vramTotalMB - modelSizeMB; // ~7.9GB for KV
        result.vramUsedMB = Math.round(modelSizeMB + kvCapacityMB * kvRatio);
      }
    } catch {
      // ignore
    }
  }

  // -- Check middleware --
  const mwHealthUrl = `http://${mwHost}:${mwPort}/health`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    const t0 = Date.now();
    const resp = await fetch(mwHealthUrl, { signal: controller.signal });
    clearTimeout(timeout);
    result.middlewareLatencyMs = Date.now() - t0;

    if (resp.ok) {
      const body = (await resp.json()) as Record<string, unknown>;
      result.middlewareStatus = body.status === "ok" ? "ok" : "error";
      if (typeof body.memories_count === "number") {
        result.memoriesCount = body.memories_count;
      }
    }
  } catch {
    // middleware unreachable
  }

  // -- Middleware stats for memory count --
  if (result.middlewareStatus === "ok" && result.memoriesCount == null) {
    const mwStatsUrl = `http://${mwHost}:${mwPort}/stats`;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3_000);
      const resp = await fetch(mwStatsUrl, { signal: controller.signal });
      clearTimeout(timeout);

      if (resp.ok) {
        const body = (await resp.json()) as Record<string, unknown>;
        if (typeof body.total_memories === "number") {
          result.memoriesCount = body.total_memories;
        }
      }
    } catch {
      // ignore
    }
  }

  // -- LibreHardwareMonitor (supplementary, does not affect overall status) --
  const hwEnabled = config.hwMonitorEnabled !== false; // default true
  if (hwEnabled) {
    const hwHost = config.hwMonitorHost ?? config.llmHost ?? "172.17.96.1";
    const hwPort = config.hwMonitorPort ?? 8085;
    const hwUrl = `http://${hwHost}:${hwPort}/data.json`;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      const t0 = Date.now();
      const resp = await fetch(hwUrl, { signal: controller.signal });
      clearTimeout(timeout);
      result.hwMonitorLatencyMs = Date.now() - t0;

      if (resp.ok) {
        const data = (await resp.json()) as LhmNode;
        const metrics = parseLhmGpuMetrics(data);
        if (metrics) {
          result.gpuTemperatureCelsius = metrics.temperatureCelsius;
          result.gpuHotSpotCelsius = metrics.hotSpotCelsius;
          result.gpuCoreClockMHz = metrics.coreClockMHz;
          result.gpuMemoryClockMHz = metrics.memoryClockMHz;
          result.gpuUtilizationPercent = metrics.utilizationPercent;
          result.gpuFanRPM = metrics.fanRPM;
          result.gpuFanPercent = metrics.fanPercent;
          result.gpuPowerDrawWatts = metrics.powerDrawWatts;
          result.hwSensorsAvailable = metrics.sensorsAvailable;
          result.hwMonitorStatus = "ok";
        } else {
          result.hwMonitorStatus = "error";
        }
      } else {
        result.hwMonitorStatus = "error";
      }
    } catch {
      result.hwMonitorStatus = "error";
    }
  }

  // -- Compute overall status --
  if (result.llmStatus === "ok" && result.middlewareStatus === "ok") {
    result.status = "ok";
  } else if (result.llmStatus === "ok" || result.middlewareStatus === "ok") {
    result.status = "degraded";
  } else {
    result.status = "error";
    result.error = "Both LLM server and middleware are unreachable";
  }

  return result;
}
