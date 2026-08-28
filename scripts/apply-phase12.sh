#!/usr/bin/env bash
set -euo pipefail
# Materialize Phase 12 sources from companion package
ROOT="${1:-.}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/../phase12-patches/src/lib/adapters/google-ads/campaign-builder.ts" ]]; then
  PKG="$SCRIPT_DIR/../phase12-patches"
elif [[ -f "./phase12-patches/src/lib/adapters/google-ads/campaign-builder.ts" ]]; then
  PKG="./phase12-patches"
else
  echo "Place phase12-patches next to repo or pass path" >&2
  exit 1
fi
mkdir -p "$ROOT/src/lib/adapters/google-ads" "$ROOT/src/lib/adapters/avito" "$ROOT/tests/unit" "$ROOT/docs"
cp "$PKG/src/lib/adapters/google-ads/campaign-builder.ts" "$ROOT/src/lib/adapters/google-ads/"
cp "$PKG/src/lib/adapters/google-ads/simulator.ts" "$ROOT/src/lib/adapters/google-ads/"
cp "$PKG/src/lib/adapters/google-ads/client.ts" "$ROOT/src/lib/adapters/google-ads/"
cp "$PKG/src/lib/adapters/avito/client.ts" "$ROOT/src/lib/adapters/avito/"
[[ -f "$PKG/tests/unit/google-campaign-builder.test.ts" ]] && cp "$PKG/tests/unit/google-campaign-builder.test.ts" "$ROOT/tests/unit/"
[[ -f "$PKG/docs/BETA.md" ]] && cp "$PKG/docs/BETA.md" "$ROOT/docs/"
echo "Applied phase12 sources into $ROOT"
