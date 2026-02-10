import { html, nothing } from "lit";
import type {
  InfrastructureData,
  HealthData,
  GpuMetricsSnapshot,
  ProviderHealthStatus,
  MultimodalServiceStatus,
  TunnelResult,
  SystemMetricsSnapshot,
  InferenceSpeedSnapshot,
} from "../controllers/hardware.ts";

export type HardwareProps = {
  loading: boolean;
  infra: InfrastructureData | null;
  health: HealthData | null;
  error: string | null;
  onRefresh: () => void;
};

function statusChip(status: "ok" | "degraded" | "error" | "loading" | "unknown") {
  const colors: Record<string, string> = {
    ok: "var(--green, #3fb950)",
    degraded: "var(--yellow, #d29922)",
    error: "var(--red, #f85149)",
    loading: "var(--yellow, #d29922)",
    unknown: "var(--muted, #8b949e)",
  };
  const color = colors[status] ?? colors.unknown;
  return html`<span class="chip" style="background: ${color}; color: #fff; font-weight: 600;">${status.toUpperCase()}</span>`;
}

function progressBar(value: number, max: number, label: string) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const color =
    pct >= 90
      ? "var(--red, #f85149)"
      : pct >= 70
        ? "var(--yellow, #d29922)"
        : "var(--green, #3fb950)";
  return html`
    <div style="margin: 4px 0;">
      <div style="display: flex; justify-content: space-between; font-size: 0.85em; margin-bottom: 2px;">
        <span>${label}</span>
        <span>${pct}%</span>
      </div>
      <div style="background: var(--surface-raised, #21262d); border-radius: 4px; height: 8px; overflow: hidden;">
        <div style="width: ${pct}%; height: 100%; background: ${color}; border-radius: 4px; transition: width 0.3s;"></div>
      </div>
    </div>
  `;
}

function metric(label: string, value: string | number | undefined, unit = "") {
  const display = value != null ? `${value}${unit}` : "n/a";
  return html`
    <div style="display: flex; justify-content: space-between; padding: 4px 0; font-size: 0.9em;">
      <span class="muted">${label}</span>
      <span>${display}</span>
    </div>
  `;
}

function formatAge(ms: number) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function cToF(celsius: number | undefined): number | undefined {
  if (celsius == null) {
    return undefined;
  }
  return Math.round((celsius * 9) / 5 + 32);
}

function formatKBps(kbps: number | undefined): string {
  if (kbps == null) {
    return "n/a";
  }
  if (kbps >= 1024) {
    return `${(kbps / 1024).toFixed(1)} MB/s`;
  }
  return `${kbps} KB/s`;
}

function gpuStatus(gpu: GpuMetricsSnapshot): "ok" | "degraded" | "error" {
  if (gpu.error || gpu.gpus.length === 0) {
    return "error";
  }
  const g = gpu.gpus[0];
  if ((g.utilizationPercent ?? 0) > 95 || (g.temperatureCelsius ?? 0) > 90) {
    return "degraded";
  }
  return "ok";
}

function renderDgxSparkCard(
  gpu: GpuMetricsSnapshot | undefined,
  speed?: InferenceSpeedSnapshot,
  remoteNet?: SystemMetricsSnapshot,
) {
  if (!gpu) {
    return html`
      <div class="card">
        <div class="card-title">DGX Spark GPU</div>
        <div class="muted" style="margin-top: 8px">No data available.</div>
      </div>
    `;
  }

  const status = gpuStatus(gpu);
  const g = gpu.gpus[0];

  if (!g) {
    return html`
      <div class="card">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div class="card-title">DGX Spark GPU</div>
          ${statusChip("error")}
        </div>
        <div class="muted" style="margin-top: 8px;">${gpu.error ?? "No GPU detected."}</div>
      </div>
    `;
  }

  return html`
    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <div class="card-title">DGX Spark GPU</div>
        ${statusChip(status)}
      </div>
      <div class="card-sub">${g.name} (${gpu.host})</div>
      <div style="margin-top: 12px;">
        ${progressBar(g.utilizationPercent ?? 0, 100, "GPU Utilization")}
        ${progressBar(g.memoryUsedMB ?? 0, g.memoryTotalMB ?? 1, `VRAM ${g.memoryUsedMB ?? 0} / ${g.memoryTotalMB ?? 0} MB`)}
        ${g.powerDrawWatts != null && g.powerLimitWatts != null ? progressBar(g.powerDrawWatts, g.powerLimitWatts, `Power ${g.powerDrawWatts.toFixed(0)} / ${g.powerLimitWatts.toFixed(0)} W`) : g.powerDrawWatts != null ? metric("Power Draw", `${g.powerDrawWatts.toFixed(0)}`, " W") : nothing}
        ${metric("Temperature", cToF(g.temperatureCelsius), "\u00b0F")}
        ${speed ? metric("Speed", `${speed.tokensPerSecond} tok/s (avg ${speed.averageTokPerSec})`) : nothing}
        ${remoteNet?.networkInKBps != null ? metric("Net In", formatKBps(remoteNet.networkInKBps)) : nothing}
        ${remoteNet?.networkOutKBps != null ? metric("Net Out", formatKBps(remoteNet.networkOutKBps)) : nothing}
      </div>
      <div class="muted" style="font-size: 0.8em; margin-top: 8px;">
        Collected ${formatAge(Date.now() - gpu.collectedAt)}
      </div>
    </div>
  `;
}

function renderLocalSystemCard(
  gpu: GpuMetricsSnapshot | undefined,
  sys: SystemMetricsSnapshot | undefined,
) {
  const hasGpu = gpu && gpu.gpus.length > 0 && !gpu.error;
  const hasSys = sys && !sys.error;

  if (!hasGpu && !hasSys) {
    return html`
      <div class="card">
        <div class="card-title">Local System</div>
        <div class="muted" style="margin-top: 8px">No data available.</div>
      </div>
    `;
  }

  const g = gpu?.gpus[0];
  const gpuOk = hasGpu ? gpuStatus(gpu!) : "unknown";
  const cpuHigh = (sys?.cpuUsagePercent ?? 0) > 90;
  const overallStatus: "ok" | "degraded" | "error" =
    gpuOk === "error" || sys?.error ? "error" : gpuOk === "degraded" || cpuHigh ? "degraded" : "ok";

  return html`
    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <div class="card-title">Local System</div>
        ${statusChip(overallStatus)}
      </div>
      ${g ? html`<div class="card-sub">${g.name} (${gpu!.host})</div>` : nothing}
      <div style="margin-top: 12px;">
        ${hasSys && sys!.cpuUsagePercent != null ? progressBar(sys!.cpuUsagePercent, 100, "CPU Usage") : nothing}
        ${hasSys && sys!.cpuTemperatureCelsius != null ? metric("CPU Temp", cToF(sys!.cpuTemperatureCelsius), "\u00b0F") : nothing}
        ${hasSys && sys!.ramUsedMB != null && sys!.ramTotalMB != null ? progressBar(sys!.ramUsedMB, sys!.ramTotalMB, `RAM ${Math.round((sys!.ramUsedMB / 1024) * 10) / 10} / ${Math.round((sys!.ramTotalMB / 1024) * 10) / 10} GB`) : nothing}
        ${g ? progressBar(g.utilizationPercent ?? 0, 100, "GPU Utilization") : nothing}
        ${g ? progressBar(g.memoryUsedMB ?? 0, g.memoryTotalMB ?? 1, `VRAM ${g.memoryUsedMB ?? 0} / ${g.memoryTotalMB ?? 0} MB`) : nothing}
        ${g?.powerDrawWatts != null && g?.powerLimitWatts != null ? progressBar(g.powerDrawWatts, g.powerLimitWatts, `Power ${g.powerDrawWatts.toFixed(0)} / ${g.powerLimitWatts.toFixed(0)} W`) : g?.powerDrawWatts != null ? metric("Power Draw", `${g.powerDrawWatts.toFixed(0)}`, " W") : nothing}
        ${g ? metric("GPU Temp", cToF(g.temperatureCelsius), "\u00b0F") : nothing}
        ${hasSys ? metric("Net In", formatKBps(sys!.networkInKBps)) : nothing}
        ${hasSys ? metric("Net Out", formatKBps(sys!.networkOutKBps)) : nothing}
      </div>
      <div class="muted" style="font-size: 0.8em; margin-top: 8px;">
        Collected ${formatAge(Date.now() - (gpu?.collectedAt ?? sys?.collectedAt ?? Date.now()))}
      </div>
    </div>
  `;
}

function renderProviderCard(infra: InfrastructureData) {
  const providers = infra.providers?.providers;
  if (!providers || Object.keys(providers).length === 0) {
    return html`
      <div class="card">
        <div class="card-title">Model Provider</div>
        <div class="muted" style="margin-top: 8px">No providers configured.</div>
      </div>
    `;
  }

  const entries = Object.values(providers);

  return html`
    <div class="card">
      <div class="card-title">Model Provider</div>
      <div style="margin-top: 12px;">
        ${entries.map(
          (p: ProviderHealthStatus) => html`
          <div style="margin-bottom: 12px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span style="font-weight: 600;">${p.provider}</span>
              ${statusChip(p.healthy ? "ok" : "error")}
            </div>
            ${metric("Endpoint", p.baseUrl)}
            ${metric("Latency", p.latencyMs != null ? `${p.latencyMs}` : undefined, "ms")}
            ${p.consecutiveFailures > 0 ? metric("Failures", p.consecutiveFailures) : nothing}
            ${p.error ? html`<div class="callout danger" style="margin-top: 4px; font-size: 0.85em;">${p.error}</div>` : nothing}
          </div>
        `,
        )}
      </div>
    </div>
  `;
}

function renderGatewayCard(health: HealthData | null) {
  if (!health) {
    return html`
      <div class="card">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div class="card-title">Gateway</div>
          ${statusChip("unknown")}
        </div>
        <div class="muted" style="margin-top: 8px;">No health data available.</div>
      </div>
    `;
  }

  const sessions = health.sessions;
  const channelOrder = health.channelOrder ?? [];
  const channels = health.channels ?? {};

  return html`
    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <div class="card-title">Gateway</div>
        ${statusChip(health.ok ? "ok" : "error")}
      </div>
      <div style="margin-top: 12px;">
        ${metric("Health Check", health.durationMs != null ? `${health.durationMs}` : undefined, "ms")}
        ${sessions ? metric("Active Sessions", sessions.count) : nothing}
        ${
          channelOrder.length > 0
            ? html`
            <div style="margin-top: 8px;">
              <div class="muted" style="font-size: 0.85em; margin-bottom: 4px;">Channels</div>
              <div class="chip-row">
                ${channelOrder.map((ch) => {
                  const chData = channels[ch] as Record<string, unknown> | undefined;
                  const ok = chData?.ok === true;
                  return html`<span class="chip" style="background: ${ok ? "var(--green, #3fb950)" : "var(--red, #f85149)"}; color: #fff;">${ch}</span>`;
                })}
              </div>
            </div>
          `
            : nothing
        }
      </div>
    </div>
  `;
}

function renderTunnelCard(tunnels: TunnelResult[] | undefined) {
  if (!tunnels || tunnels.length === 0) {
    return nothing;
  }

  return html`
    <div class="card">
      <div class="card-title">SSH Tunnels</div>
      <div style="margin-top: 12px;">
        ${tunnels.map(
          (t) => html`
          <div style="margin-bottom: 12px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span style="font-weight: 600;">${t.label ?? `${t.host}:${t.port}`}</span>
              ${statusChip(t.reachable ? "ok" : "error")}
            </div>
            ${metric("Latency", t.latencyMs != null ? `${t.latencyMs}` : undefined, "ms")}
            ${t.serviceName ? metric("Service", t.serviceActive ? "active" : "inactive") : nothing}
            ${t.error ? html`<div class="callout danger" style="margin-top: 4px; font-size: 0.85em;">${t.error}</div>` : nothing}
          </div>
        `,
        )}
      </div>
    </div>
  `;
}

function multimodalOverallStatus(services: MultimodalServiceStatus[]): "ok" | "degraded" | "error" {
  const up = services.filter((s) => s.status === "ok").length;
  if (up === services.length) {
    return "ok";
  }
  if (up === 0) {
    return "error";
  }
  return "degraded";
}

function renderMultimodalCard(infra: InfrastructureData) {
  const mm = infra.multimodal;
  if (!mm || mm.services.length === 0) {
    return nothing;
  }

  const status = multimodalOverallStatus(mm.services);

  return html`
    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <div class="card-title">Multimodal Services</div>
        <div>
          <span class="muted" style="margin-right: 8px;">${mm.servicesUp}/${mm.servicesTotal} UP</span>
          ${statusChip(status)}
        </div>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px;">
        ${mm.services.map((svc) => {
          const dotColor =
            svc.status === "ok"
              ? "var(--green, #3fb950)"
              : svc.status === "loading"
                ? "var(--yellow, #d29922)"
                : "var(--red, #f85149)";
          return html`
            <div style="padding: 8px; background: var(--surface-raised, #21262d); border-radius: 6px;">
              <div style="display: flex; align-items: center; gap: 6px;">
                <span style="width: 8px; height: 8px; border-radius: 50%; background: ${dotColor}; display: inline-block; flex-shrink: 0;"></span>
                <span style="font-weight: 600; font-size: 0.9em;">${svc.label}</span>
              </div>
              <div class="muted" style="font-size: 0.8em; margin-top: 4px;">
                ${svc.model ? svc.model : svc.status === "error" ? (svc.error ?? "down") : svc.status}
              </div>
              <div class="muted" style="font-size: 0.75em;">
                :${svc.port}${svc.latencyMs != null ? ` \u2022 ${svc.latencyMs}ms` : ""}
              </div>
            </div>
          `;
        })}
      </div>
      <div class="muted" style="font-size: 0.8em; margin-top: 8px;">
        Checked ${formatAge(Date.now() - mm.checkedAt)}
      </div>
    </div>
  `;
}

export function renderHardware(props: HardwareProps) {
  return html`
    <section>
      <div class="row" style="justify-content: space-between; margin-bottom: 16px;">
        <div>
          <div class="card-sub">Real-time infrastructure monitoring. Auto-refreshes every 10s.</div>
        </div>
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? "Loading\u2026" : "Refresh"}
        </button>
      </div>
      ${props.error ? html`<div class="callout danger" style="margin-bottom: 16px;">${props.error}</div>` : nothing}
      ${
        !props.infra && !props.error
          ? html`
              <div class="muted">Waiting for data\u2026</div>
            `
          : nothing
      }
      ${
        props.infra
          ? html`
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px;">
          ${renderDgxSparkCard(props.infra.gpu, props.infra.inferenceSpeed, props.infra.remoteSystemMetrics)}
          ${renderLocalSystemCard(props.infra.localGpu, props.infra.systemMetrics)}
          ${renderProviderCard(props.infra)}
          ${renderGatewayCard(props.health)}
          ${renderTunnelCard(props.infra.tunnels)}
          ${renderMultimodalCard(props.infra)}
        </div>
        <div class="muted" style="font-size: 0.8em; margin-top: 12px; text-align: right;">
          Infrastructure snapshot from ${formatAge(Date.now() - props.infra.collectedAt)}
        </div>
      `
          : nothing
      }
    </section>
  `;
}
