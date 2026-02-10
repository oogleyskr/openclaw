import type { OpenClawConfig } from "../config/config.js";
import type { InfrastructureConfig } from "../config/types.infrastructure.js";
import {
  type GpuMetricsSnapshot,
  collectLocalGpuMetrics,
  collectRemoteGpuMetrics,
} from "./gpu-metrics.js";
import { type MultimodalHealthSnapshot, checkMultimodalHealth } from "./multimodal-health.js";
import {
  type ProviderHealthSnapshot,
  checkAllProviders,
  getProviderHealthSnapshot,
  stopProviderHealthMonitor,
} from "./provider-health.js";
import { type TunnelMonitorResult, checkTunnelHealth } from "./tunnel-monitor.js";

export type InfrastructureSnapshot = {
  providers?: ProviderHealthSnapshot;
  tunnels?: TunnelMonitorResult[];
  gpu?: GpuMetricsSnapshot;
  localGpu?: GpuMetricsSnapshot;
  multimodal?: MultimodalHealthSnapshot;
  collectedAt: number;
};

// Polling timers for each subsystem. `.unref()` prevents them from keeping
// the Node process alive when the gateway is shutting down.
let gpuInterval: ReturnType<typeof setInterval> | null = null;
let localGpuInterval: ReturnType<typeof setInterval> | null = null;
let tunnelInterval: ReturnType<typeof setInterval> | null = null;
let providerInterval: ReturnType<typeof setInterval> | null = null;
let multimodalInterval: ReturnType<typeof setInterval> | null = null;

// Cached results from the most recent polling cycle. The gateway's RPC
// handler reads these via getInfrastructureSnapshot() without triggering
// new probes, so dashboard clients get fast responses.
let cachedGpu: GpuMetricsSnapshot | null = null;
let cachedLocalGpu: GpuMetricsSnapshot | null = null;
let cachedTunnels: TunnelMonitorResult[] | null = null;
let cachedMultimodal: MultimodalHealthSnapshot | null = null;

/** Refresh GPU metrics from local or remote nvidia-smi and cache the result. */
async function refreshGpuMetrics(infraCfg: InfrastructureConfig): Promise<void> {
  const gpuCfg = infraCfg.gpu;
  if (!gpuCfg?.enabled) {
    return;
  }

  if (gpuCfg.mode === "remote" && gpuCfg.sshHost) {
    cachedGpu = await collectRemoteGpuMetrics({
      sshHost: gpuCfg.sshHost,
      sshUser: gpuCfg.sshUser,
      sshKeyPath: gpuCfg.sshKeyPath,
      sshPort: gpuCfg.sshPort,
    });
  } else {
    cachedGpu = await collectLocalGpuMetrics();
  }

  // Apply configured power limit override for GPUs that report [N/A]
  if (gpuCfg.powerLimitWatts != null && cachedGpu) {
    for (const gpu of cachedGpu.gpus) {
      if (gpu.powerLimitWatts == null) {
        gpu.powerLimitWatts = gpuCfg.powerLimitWatts;
      }
    }
  }
}

/** Refresh local GPU metrics via nvidia-smi and cache the result. */
async function refreshLocalGpuMetrics(): Promise<void> {
  cachedLocalGpu = await collectLocalGpuMetrics();
}

/** Check all configured multimodal services and cache the results. */
async function refreshMultimodal(infraCfg: InfrastructureConfig): Promise<void> {
  const configs = infraCfg.multimodal;
  if (!configs || configs.length === 0) {
    return;
  }
  cachedMultimodal = await checkMultimodalHealth(configs);
}

/** Check all configured tunnels in parallel and cache the results. */
async function refreshTunnels(infraCfg: InfrastructureConfig): Promise<void> {
  const tunnelConfigs = infraCfg.tunnels;
  if (!tunnelConfigs || tunnelConfigs.length === 0) {
    return;
  }

  const results = await Promise.all(
    tunnelConfigs.map((tc) =>
      checkTunnelHealth({
        host: tc.host,
        port: tc.port,
        serviceName: tc.serviceName,
        timeoutMs: tc.timeoutMs,
      }),
    ),
  );

  cachedTunnels = results;
}

/**
 * Get the current infrastructure snapshot without triggering new probes.
 */
export function getInfrastructureSnapshot(): InfrastructureSnapshot {
  return {
    providers: getProviderHealthSnapshot(),
    tunnels: cachedTunnels ?? undefined,
    gpu: cachedGpu ?? undefined,
    localGpu: cachedLocalGpu ?? undefined,
    multimodal: cachedMultimodal ?? undefined,
    collectedAt: Date.now(),
  };
}

/**
 * Perform a full infrastructure probe (providers + tunnels + GPU + local GPU + multimodal).
 */
export async function probeInfrastructure(cfg: OpenClawConfig): Promise<InfrastructureSnapshot> {
  const infraCfg = cfg.infrastructure;

  const tasks: Promise<void>[] = [];

  // Provider health
  tasks.push(checkAllProviders(cfg).then(() => {}));

  if (infraCfg) {
    // Tunnel checks
    if (infraCfg.tunnels && infraCfg.tunnels.length > 0) {
      tasks.push(refreshTunnels(infraCfg));
    }

    // GPU metrics
    if (infraCfg.gpu?.enabled) {
      tasks.push(refreshGpuMetrics(infraCfg));
    }

    // Local GPU metrics
    if (infraCfg.localGpu?.enabled) {
      tasks.push(refreshLocalGpuMetrics());
    }

    // Multimodal services
    if (infraCfg.multimodal && infraCfg.multimodal.length > 0) {
      tasks.push(refreshMultimodal(infraCfg));
    }
  }

  // allSettled so one failing subsystem doesn't block the others.
  await Promise.allSettled(tasks);

  return getInfrastructureSnapshot();
}

/**
 * Start periodic infrastructure monitoring.
 */
export function startInfrastructureMonitor(cfg: OpenClawConfig): void {
  stopInfrastructureMonitor();

  const infraCfg = cfg.infrastructure;

  // Provider health checks run on their own interval (configured per-provider).
  // We just check if there are providers to monitor.
  const providers = cfg.models?.providers ?? {};
  if (Object.keys(providers).length > 0) {
    // Initial provider check
    void checkAllProviders(cfg);

    // Find shortest provider health check interval
    let providerIntervalSec = 60;
    for (const [, p] of Object.entries(providers)) {
      const configured = p.healthCheck?.intervalSeconds;
      if (typeof configured === "number" && configured > 0) {
        providerIntervalSec = Math.min(providerIntervalSec, configured);
      }
    }

    providerInterval = setInterval(() => {
      void checkAllProviders(cfg);
    }, providerIntervalSec * 1000);
    providerInterval.unref();
  }

  if (!infraCfg) {
    return;
  }

  // GPU metrics
  if (infraCfg.gpu?.enabled) {
    const gpuIntervalSec = infraCfg.gpu.intervalSeconds ?? 30;
    void refreshGpuMetrics(infraCfg);
    gpuInterval = setInterval(() => {
      void refreshGpuMetrics(infraCfg);
    }, gpuIntervalSec * 1000);
    gpuInterval.unref();
  }

  // Local GPU metrics
  if (infraCfg.localGpu?.enabled) {
    const localGpuIntervalSec = infraCfg.localGpu.intervalSeconds ?? 30;
    void refreshLocalGpuMetrics();
    localGpuInterval = setInterval(() => {
      void refreshLocalGpuMetrics();
    }, localGpuIntervalSec * 1000);
    localGpuInterval.unref();
  }

  // Tunnel monitoring (check every 30s)
  if (infraCfg.tunnels && infraCfg.tunnels.length > 0) {
    void refreshTunnels(infraCfg);
    tunnelInterval = setInterval(() => {
      void refreshTunnels(infraCfg);
    }, 30_000);
    tunnelInterval.unref();
  }

  // Multimodal service monitoring (check every 10s)
  if (infraCfg.multimodal && infraCfg.multimodal.length > 0) {
    void refreshMultimodal(infraCfg);
    multimodalInterval = setInterval(() => {
      void refreshMultimodal(infraCfg);
    }, 10_000);
    multimodalInterval.unref();
  }
}

/**
 * Stop all infrastructure monitoring timers.
 */
export function stopInfrastructureMonitor(): void {
  stopProviderHealthMonitor();

  if (gpuInterval) {
    clearInterval(gpuInterval);
    gpuInterval = null;
  }
  if (localGpuInterval) {
    clearInterval(localGpuInterval);
    localGpuInterval = null;
  }
  if (tunnelInterval) {
    clearInterval(tunnelInterval);
    tunnelInterval = null;
  }
  if (providerInterval) {
    clearInterval(providerInterval);
    providerInterval = null;
  }
  if (multimodalInterval) {
    clearInterval(multimodalInterval);
    multimodalInterval = null;
  }

  cachedGpu = null;
  cachedLocalGpu = null;
  cachedTunnels = null;
  cachedMultimodal = null;
}
