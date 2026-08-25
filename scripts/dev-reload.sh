#!/usr/bin/env bash
# dev-reload.sh — rebuild the plugin in place for a DSH install that points
# at this repo directory.
#
# Problem it solves: DSH loads the plugin through `lib/index.js` (the tsc
# output). Editing src/ without rebuilding leaves the running plugin on the
# old code, so manual tests exercise two different worlds. This script closes
# the loop: typecheck → build → show what changed → tell the human to restart
# DSH (Node caches the loaded modules; there is no hot reload for the host).
#
# Usage: npm run dev:reload
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== typecheck"
npm run typecheck

echo "== build (src -> lib)"
npm run build

echo
echo "== lib artifacts"
ls -la lib/index.js lib/types/index.d.ts 2>&1 | tail -2 || true

echo
echo "== done"
echo "DSH: plugin source rebuilt. RESTART DSH to load the new lib/ (the host"
echo "caches loaded modules — no hot reload exists for the plugin row)."