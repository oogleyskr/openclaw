#!/usr/bin/env bash
# financials.sh — Get financial statements from Yahoo Finance.
# Usage: financials.sh <TICKER> [--statement income|balance|cashflow]

set -euo pipefail

SERVICE_URL="http://localhost:8107"

if [[ "${1:-}" == "" || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    echo "Usage: financials.sh <TICKER> [--statement income|balance|cashflow]" >&2
    exit 2
fi

TICKER="$1"
shift
STATEMENT="income"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --statement) STATEMENT="${2:-income}"; shift 2 ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
done

if ! curl -s -m 2 "$SERVICE_URL/health" >/dev/null 2>&1; then
    echo "Error: FinData service not running on $SERVICE_URL" >&2
    echo "Start it with: bash /home/mferr/multimodal/scripts/start-all.sh findata" >&2
    exit 1
fi

curl -sS -X POST "$SERVICE_URL/financials" \
    -H 'Content-Type: application/json' \
    -d "{\"ticker\":\"$TICKER\",\"statement\":\"$STATEMENT\"}"
