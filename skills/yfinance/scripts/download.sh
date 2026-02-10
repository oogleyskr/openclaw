#!/usr/bin/env bash
# download.sh — Batch download prices for multiple tickers.
# Usage: download.sh "AAPL,MSFT,GOOGL" [--period 5d] [--interval 1d]

set -euo pipefail

SERVICE_URL="http://localhost:8107"

if [[ "${1:-}" == "" || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    echo "Usage: download.sh \"AAPL,MSFT,GOOGL\" [--period 5d] [--interval 1d]" >&2
    exit 2
fi

TICKERS="$1"
shift
PERIOD="5d"
INTERVAL="1d"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --period) PERIOD="${2:-5d}"; shift 2 ;;
        --interval) INTERVAL="${2:-1d}"; shift 2 ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
done

if ! curl -s -m 2 "$SERVICE_URL/health" >/dev/null 2>&1; then
    echo "Error: FinData service not running on $SERVICE_URL" >&2
    echo "Start it with: bash /home/mferr/multimodal/scripts/start-all.sh findata" >&2
    exit 1
fi

curl -sS -X POST "$SERVICE_URL/download" \
    -H 'Content-Type: application/json' \
    -d "{\"tickers\":\"$TICKERS\",\"period\":\"$PERIOD\",\"interval\":\"$INTERVAL\"}"
