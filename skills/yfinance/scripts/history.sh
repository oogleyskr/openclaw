#!/usr/bin/env bash
# history.sh — Get historical price data from Yahoo Finance.
# Usage: history.sh <TICKER> [--period 1mo] [--interval 1d]

set -euo pipefail

SERVICE_URL="http://localhost:8107"

if [[ "${1:-}" == "" || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    echo "Usage: history.sh <TICKER> [--period 1mo] [--interval 1d]" >&2
    echo "Periods: 1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y, 10y, ytd, max" >&2
    echo "Intervals: 1m, 2m, 5m, 15m, 30m, 60m, 90m, 1h, 1d, 5d, 1wk, 1mo, 3mo" >&2
    exit 2
fi

TICKER="$1"
shift
PERIOD="1mo"
INTERVAL="1d"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --period) PERIOD="${2:-1mo}"; shift 2 ;;
        --interval) INTERVAL="${2:-1d}"; shift 2 ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
done

if ! curl -s -m 2 "$SERVICE_URL/health" >/dev/null 2>&1; then
    echo "Error: FinData service not running on $SERVICE_URL" >&2
    echo "Start it with: bash /home/mferr/multimodal/scripts/start-all.sh findata" >&2
    exit 1
fi

curl -sS -X POST "$SERVICE_URL/history" \
    -H 'Content-Type: application/json' \
    -d "{\"ticker\":\"$TICKER\",\"period\":\"$PERIOD\",\"interval\":\"$INTERVAL\"}"
