#!/bin/bash
# Fix tsdown/rolldown build output: redirect __exportAll imports from
# gateway-cli chunks to the standalone rolldown-runtime chunk.
#
# WHY: tsdown's code-splitting sometimes inlines the __exportAll helper into
# a gateway-cli-*.js chunk instead of the rolldown-runtime-*.js chunk. Other
# chunks then import __exportAll from gateway-cli, creating a circular
# dependency that crashes at startup ("__exportAll is not a function").
#
# This script rewrites those imports to point at rolldown-runtime, which is
# where __exportAll is actually defined. It must be run after every
# `pnpm build` (OPENCLAW_A2UI_SKIP_MISSING=1 pnpm build).

DIST_DIR="${1:-dist}"

# Find the rolldown-runtime chunk (e.g. rolldown-runtime-Ab1Cd2Ef.js)
RUNTIME_FILE=$(ls "$DIST_DIR"/rolldown-runtime-*.js 2>/dev/null | head -1)
if [ -z "$RUNTIME_FILE" ]; then
  echo "No rolldown-runtime chunk found in $DIST_DIR - skipping"
  exit 0
fi

RUNTIME_BASENAME=$(basename "$RUNTIME_FILE")
FIXED=0

for f in "$DIST_DIR"/*.js; do
  [ "$f" = "$RUNTIME_FILE" ] && continue

  # Check if this file imports __exportAll from a gateway-cli chunk (the bug)
  if grep -q 'as __exportAll.*from "./gateway-cli-' "$f" 2>/dev/null; then
    # Rewrite: import { t as __exportAll } from "./gateway-cli-XXX.js"
    #      ->  import { t as __exportAll } from "./rolldown-runtime-XXX.js"
    sed -i "s|import { t as __exportAll } from \"./gateway-cli-[^\"]*\"|import { t as __exportAll } from \"./$RUNTIME_BASENAME\"|g" "$f"
    FIXED=$((FIXED + 1))
  fi
done

if [ "$FIXED" -gt 0 ]; then
  echo "Fixed __exportAll imports in $FIXED files -> $RUNTIME_BASENAME"
else
  echo "No __exportAll import fixes needed"
fi
