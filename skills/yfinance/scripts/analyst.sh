#!/usr/bin/env bash
# analyst.sh — Get analyst recommendations from Yahoo Finance.
# Usage: analyst.sh <TICKER>

set -euo pipefail

SERVICE_URL="http://localhost:8107"

if [[ "${1:-}" == "" || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    echo "Usage: analyst.sh <TICKER>" >&2
    echo "Example: analyst.sh GOOGL" >&2
    exit 2
fi

TICKER="$1"

if ! curl -s -m 2 "$SERVICE_URL/health" >/dev/null 2>&1; then
    echo "Error: FinData service not running on $SERVICE_URL" >&2
    echo "Start it with: bash /home/mferr/multimodal/scripts/start-all.sh findata" >&2
    exit 1
fi

curl -sS -X POST "$SERVICE_URL/analyst" \
    -H 'Content-Type: application/json' \
    -d "{\"ticker\":\"$TICKER\"}"
