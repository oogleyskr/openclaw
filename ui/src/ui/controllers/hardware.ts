import type { GatewayBrowserClient } from "../gateway.ts";

export type GpuMetrics = {
  name: string;
  index: number;
  temperatureCelsius?: number;
  utilizationPercent?: number;
  memoryUsedMB?: number;
  memoryTotalMB?: number;
  memoryUtilizationPercent?: number;
  powerDrawWatts?: number;
  powerLimitWatts?: number;
};

export type GpuMetricsSnapshot = {
  host: string;
  gpus: GpuMetrics[];
  collectedAt: number;
  error?: string;
};

export type ProviderHealthStatus = {
  provider: string;
  baseUrl: string;
  healthy: boolean;
  lastCheckedAt: number;
  lastHealthyAt?: number;
  latencyMs?: number;
  error?: string;
  consecutiveFailures: number;
};

export type MultimodalServiceStatus = {
  label: string;
  host: string;
  port: number;
  status: "ok" | "loading" | "error";
  model?: string;
  service?: string;
  latencyMs?: number;
  error?: string;
};

export type TunnelResult = {
  label?: string;
  host: string;
  port: number;
  reachable: boolean;
  latencyMs?: number;
  serviceName?: string;
  serviceActive?: boolean;
  error?: string;
};

export type SystemMetricsSnapshot = {
  cpuUsagePercent?: number;
  cpuTemperatureCelsius?: number;
  ramUsedMB?: number;
  ramTotalMB?: number;
  ramUsagePercent?: number;
  networkInKBps?: number;
  networkOutKBps?: number;
  collectedAt: number;
  error?: string;
};

export type InferenceSpeedSnapshot = {
  tokensPerSecond: number;
  averageTokPerSec: number;
  completionCount: number;
  lastMeasuredAt: number;
};

export type InfrastructureData = {
  providers?: {
    providers: Record<string, ProviderHealthStatus>;
    checkedAt: number;
  };
  tunnels?: TunnelResult[];
  gpu?: GpuMetricsSnapshot;
  localGpu?: GpuMetricsSnapshot;
  multimodal?: {
    services: MultimodalServiceStatus[];
    servicesUp: number;
    servicesTotal: number;
    checkedAt: number;
  };
  systemMetrics?: SystemMetricsSnapshot;
  remoteSystemMetrics?: SystemMetricsSnapshot;
  inferenceSpeed?: InferenceSpeedSnapshot;
  collectedAt: number;
};

export type HealthData = {
  ok: boolean;
  ts: number;
  durationMs?: number;
  channels?: Record<string, unknown>;
  channelOrder?: string[];
  sessions?: {
    count: number;
    recent: Array<{ key: string; age: number | null }>;
  };
};

export type HardwareState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  hardwareLoading: boolean;
  hardwareInfra: InfrastructureData | null;
  hardwareHealth: HealthData | null;
  hardwareError: string | null;
};

export async function loadHardware(state: HardwareState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.hardwareLoading) {
    return;
  }

  state.hardwareLoading = true;
  state.hardwareError = null;

  try {
    const [infra, health] = await Promise.all([
      state.client.request("infrastructure", {}),
      state.client.request("health", {}),
    ]);
    state.hardwareInfra = infra as InfrastructureData;
    state.hardwareHealth = health as HealthData;
  } catch (err) {
    state.hardwareError = String(err);
  } finally {
    state.hardwareLoading = false;
  }
}
