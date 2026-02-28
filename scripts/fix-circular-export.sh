#!/bin/bash
# Fix circular __exportAll import in all chunks after tsdown build.
set -e
PATCHED=0
HELPER='var __defProp = Object.defineProperty;\nvar __exportAll = (all, no_symbols) => {\n\tlet target = {};\n\tfor (var name in all) {\n\t\t__defProp(target, name, { get: all[name], enumerable: true });\n\t}\n\tif (!no_symbols) {\n\t\t__defProp(target, Symbol.toStringTag, { value: "Module" });\n\t}\n\treturn target;\n};'

for f in dist/*.js; do
    if grep -q 'import.*__exportAll.*gateway-cli' "$f" 2>/dev/null; then
        # Remove the circular import line and prepend helper
        sed -i '/import.*__exportAll.*gateway-cli/d' "$f"
        TMPF=$(mktemp)
        printf '%b\n' "$HELPER" | cat - "$f" > "$TMPF" && mv "$TMPF" "$f"
        PATCHED=$((PATCHED + 1))
    fi
done

echo "[fix-circular] Patched $PATCHED files"
