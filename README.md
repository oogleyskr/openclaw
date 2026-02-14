# BillBot

<p align="center">
    <img src="assets/billbot-avatar.png" alt="BillBot" width="200">
</p>

A heavily customized fork of [OpenClaw](https://github.com/openclaw/openclaw) — a personal AI assistant running on a multi-GPU homelab stack with a custom Android companion app.

BillBot runs on a **DGX Spark** (gpt-oss-120b, 128GB), an **RTX 3090** (multimodal services), and a **Radeon VII** (long-term memory LLM), connected via Discord and Telegram with a native Android dashboard.

## What's Different From Upstream

This fork adds significant custom infrastructure on top of OpenClaw:

- **DGX Spark Integration** — SSH tunnel monitor, provider health checks, and native SGLang support with FP8 KV cache for gpt-oss-120b (131K context)
- **GPU Metrics & Hardware Monitoring** — Real-time GPU temp/utilization/power/VRAM from all 3 GPUs via LibreHardwareMonitor integration
- **Infrastructure Monitor** — Tracks health of all services across machines with automatic status reporting
- **Memory Cortex** — Long-term memory system with SQLite + FTS5, powered by Qwen3-8B on the Radeon VII via Vulkan
- **Multimodal Services** — STT (faster-whisper), Vision (Qwen2.5-VL-7B), TTS (Kokoro-82M), ImageGen (SDXL-Turbo), Embeddings (nomic-embed), DocUtils, FinData
- **Context Pruning & Compaction** — Aggressive cache-TTL pruning and compaction tuned for self-hosted model performance
- **Security Hardening** — `denyPaths` for path-based access control, per-channel-peer DM session isolation
- **Heartbeat Service** — Lightweight Qwen3-1.7B on CPU for system health pings

## Architecture

```
Discord / Telegram
       |
       v
+------------------+     +---------------------------+
|  OpenClaw Gateway |---->|  DGX Spark (SSH tunnel)   |
|  :18789           |     |  gpt-oss-120b @ :8000     |
+------------------+     +---------------------------+
       |
       +---> RTX 3090 Multimodal Services (:8101-:8107)
       |      STT | Vision | TTS | ImageGen | Embeddings | DocUtils | FinData
       |
       +---> Memory Cortex (:8300 middleware + :8301 LLM)
       |      SQLite + FTS5 | Qwen3-8B on Radeon VII (Vulkan)
       |
       +---> Heartbeat (:8200)
       |      Qwen3-1.7B (CPU-only, ~35 tok/s)
       |
       +---> LibreHardwareMonitor (:8085)
              GPU/CPU/Disk sensors from Windows host
```

## Services & Ports

| Port  | Service                      | Host      | Notes                            |
| ----- | ---------------------------- | --------- | -------------------------------- |
| 8000  | SGLang (gpt-oss-120b)        | DGX Spark | Primary LLM, native tool calling |
| 8001  | SSH tunnel to DGX:8000       | localhost | systemd: dgx-spark-tunnel        |
| 8085  | LibreHardwareMonitor         | Windows   | GPU/CPU/disk sensors             |
| 8101  | STT (faster-whisper)         | localhost | RTX 3090                         |
| 8102  | Vision (Qwen2.5-VL-7B-AWQ)   | localhost | RTX 3090                         |
| 8103  | TTS (Kokoro-82M)             | localhost | RTX 3090                         |
| 8104  | ImageGen (SDXL-Turbo)        | localhost | RTX 3090                         |
| 8105  | Embeddings (nomic-embed)     | localhost | RTX 3090                         |
| 8106  | DocUtils                     | localhost | RTX 3090                         |
| 8107  | FinData (yfinance)           | localhost | RTX 3090                         |
| 8200  | Heartbeat (Qwen3-1.7B)       | localhost | CPU-only                         |
| 8300  | Memory Cortex middleware     | localhost | Python/aiohttp, SQLite+FTS5      |
| 8301  | Memory Cortex LLM (Qwen3-8B) | Windows   | Radeon VII Vulkan                |
| 18789 | OpenClaw Gateway             | localhost | WebSocket + HTTP                 |

## Android Companion App

[BillBot Android](https://github.com/oogleyskr/billbot-android) — a native Kotlin + Jetpack Compose app that connects to the gateway over Tailscale WebSocket.

- Real-time chat with BillBot via Discord/Telegram relay
- Hardware dashboard with per-device GPU cards (DGX Spark, RTX 3090, Radeon VII)
- Cross-device metrics comparison view (temp, utilization, power, VRAM)
- Material Design 3 dark theme
- MVVM + Hilt DI + OkHttp WebSocket + kotlinx.serialization

## Related Repos

| Repo                                                                        | Description                  |
| --------------------------------------------------------------------------- | ---------------------------- |
| [billbot-android](https://github.com/oogleyskr/billbot-android)             | Android companion app        |
| [multimodal-stack](https://github.com/oogleyskr/multimodal-stack)           | RTX 3090 multimodal services |
| [billbot-memory-cortex](https://github.com/oogleyskr/billbot-memory-cortex) | Long-term memory system      |
| [billbot-workspace](https://github.com/oogleyskr/billbot-workspace)         | Workspace files and config   |

## Building From Source

Requires **Node >= 22** and **pnpm**.

```bash
git clone https://github.com/oogleyskr/billbot.git
cd billbot

pnpm install
OPENCLAW_A2UI_SKIP_MISSING=1 pnpm build
bash scripts/fix-runtime-imports.sh dist
```

### Running the Gateway

```bash
nohup node dist/entry.js gateway run --verbose > /tmp/openclaw-fork.log 2>&1 &
```

## Configuration

Config lives at `~/.openclaw/openclaw.json`. Key settings for this fork:

- **Provider**: `spark` (port 8001, SSH tunnel to DGX Spark)
- **Model**: `spark/gpt-oss-120b` (contextWindow: 131072, maxTokens: 16384, reasoning: true)
- **Model compat**: `supportsStore: false`, `supportsStrictMode: false`, `supportsUsageInStreaming: false`
- **Memory Cortex**: enabled with hardware monitoring
- **Context pruning**: cache-TTL strategy with aggressive trim ratios
- **Compaction**: maxHistoryShare=0.35, reserveTokensFloor=16000

## Credits

Built on [OpenClaw](https://github.com/openclaw/openclaw) by Peter Steinberger and the OpenClaw community. Licensed under MIT.
