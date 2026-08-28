#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
cat docs/phase12_sources.b64.part* | base64 -d | tar xzf -
echo "Extracted Phase 12 sources:"
ls -la src/lib/adapters/google-ads/campaign-builder.ts \
       src/lib/adapters/google-ads/simulator.ts \
       src/lib/adapters/google-ads/client.ts \
       src/lib/adapters/avito/client.ts
