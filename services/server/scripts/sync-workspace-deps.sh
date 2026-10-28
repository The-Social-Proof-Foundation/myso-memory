#!/usr/bin/env bash
# Sync monorepo packages needed by sidecar scripts into services/server/workspace/.
# Re-run after changing packages/sdk or packages/sub-agents. The sidecar scripts import the
# sub-agents package under its old name, @socialproof/social, so the copy is renamed below.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
WS="$ROOT/services/server/workspace"

mkdir -p "$WS/sdk" "$WS/social"

rsync -a --delete \
  --exclude node_modules \
  --exclude dist \
  "$ROOT/packages/sdk/" "$WS/sdk/"

rsync -a --delete \
  --exclude node_modules \
  --exclude dist \
  --exclude '*.test.ts' \
  "$ROOT/packages/sub-agents/" "$WS/social/"

# npm in Docker cannot resolve pnpm workspace:* references or the registry copy of the SDK, so the
# copy points at the sibling SDK mirror and keeps the name the sidecar scripts import.
node --input-type=module -e '
import fs from "node:fs";
const file = process.argv[1];
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
pkg.name = "@socialproof/social";
pkg.dependencies["@socialproof/memory"] = "file:../sdk";
fs.writeFileSync(file, JSON.stringify(pkg, null, 4) + "\n");
' "$WS/social/package.json"

echo "Synced workspace deps to $WS"
