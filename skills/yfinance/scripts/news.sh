#!/usr/bin/env bash
# news.sh — Get recent news for a ticker from Yahoo Finance.
# Usage: news.sh <TICKER>

set -euo pipefail

SERVICE_URL="http://localhost:8107"

if [[ "${1:-}" == "" || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    echo "Usage: news.sh <TICKER>" >&2
    echo "Example: news.sh NVDA" >&2
    exit 2
fi

TICKER="$1"

if ! curl -s -m 2 "$SERVICE_URL/health" >/dev/null 2>&1; then
    echo "Error: FinData service not running on $SERVICE_URL" >&2
    echo "Start it with: bash /home/mferr/multimodal/scripts/start-all.sh findata" >&2
    exit 1
fi

curl -sS -X POST "$SERVICE_URL/news" \
    -H 'Content-Type: application/json' \
    -d "{\"ticker\":\"$TICKER\"}"
