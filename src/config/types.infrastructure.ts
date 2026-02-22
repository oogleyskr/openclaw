export type SshTunnelMonitorConfig = {
  /** Label for display in health output. */
  label?: string;
  /** Host to check port reachability on (default: localhost). */
  host?: string;
  /** TCP port to probe. */
  port: number;
  /** Optional systemd service name to check status of. */
  serviceName?: string;
  /** Timeout for TCP connection check in ms (default: 5000). */
  timeoutMs?: number;
};

export type GpuMetricsConfig = {
  /** Enable GPU metrics collection (default: false). */
  enabled?: boolean;
  /** Collect from local machine or via SSH to a remote host. */
  mode?: "local" | "remote";
  /** SSH host for remote GPU metrics (required if mode=remote). */
  sshHost?: string;
  /** SSH user for remote GPU metrics. */
  sshUser?: string;
  /** SSH key path for remote GPU metrics. */
  sshKeyPath?: string;
  /** SSH port for remote GPU metrics (default: 22). */
  sshPort?: number;
  /** How often to collect metrics in seconds (default: 30). */
  intervalSeconds?: number;
  /** Override power limit in watts when nvidia-smi reports [N/A]. */
  powerLimitWatts?: number;
};

export type LocalGpuConfig = {
  /** Enable local GPU metrics collection (default: false). */
  enabled?: boolean;
  /** How often to collect metrics in seconds (default: 30). */
  intervalSeconds?: number;
};

export type MultimodalServiceConfig = {
  /** Display label for this service (e.g. "STT", "Vision"). */
  label: string;
  /** Host to check health on (default: localhost). */
  host?: string;
  /** Port the service listens on. */
  port: number;
  /** Health endpoint path (default: /health). */
  healthPath?: string;
};

export type SystemMetricsConfig = {
  /** Enable system metrics collection (default: false). */
  enabled?: boolean;
  /** How often to collect metrics in seconds (default: 10). */
  intervalSeconds?: number;
};

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

export type InfrastructureConfig = {
  /** SSH tunnel endpoints to monitor for connectivity. */
  tunnels?: SshTunnelMonitorConfig[];
  /** GPU metrics collection configuration (remote or primary GPU). */
  gpu?: GpuMetricsConfig;
  /** Local GPU metrics collection (e.g. RTX 3090 alongside remote DGX). */
  localGpu?: LocalGpuConfig;
  /** Multimodal service endpoints to monitor for health. */
  multimodal?: MultimodalServiceConfig[];
  /** System metrics (CPU, RAM, network) for the gateway host. */
  systemMetrics?: SystemMetricsConfig;
  /** Memory Cortex (Radeon VII + middleware) monitoring. */
  memoryCortex?: MemoryCortexConfig;
};
