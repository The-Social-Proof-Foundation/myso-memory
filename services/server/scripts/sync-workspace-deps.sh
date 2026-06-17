#!/usr/bin/env bash
# Sync monorepo packages needed by sidecar scripts into services/server/workspace/.
# Re-run after changing packages/sdk or packages/social.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
WS="$ROOT/services/server/workspace"

rm -rf "$WS/sdk" "$WS/social"
mkdir -p "$WS"

rsync -a \
  --exclude node_modules \
  --exclude dist \
  "$ROOT/packages/sdk/" "$WS/sdk/"

rsync -a \
  --exclude node_modules \
  --exclude dist \
  --exclude '*.test.ts' \
  "$ROOT/packages/social/" "$WS/social/"

# npm in Docker cannot resolve pnpm workspace:* references.
if [[ "$(uname)" == "Darwin" ]]; then
  sed -i '' 's|"@socialproof/memory": "workspace:\*"|"@socialproof/memory": "file:../sdk"|' "$WS/social/package.json"
else
  sed -i 's|"@socialproof/memory": "workspace:\*"|"@socialproof/memory": "file:../sdk"|' "$WS/social/package.json"
fi

echo "Synced workspace deps to $WS"
