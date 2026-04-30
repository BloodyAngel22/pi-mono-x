#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "==> Building pi-x..."

npm run build --prefix "$ROOT/packages/tui"
npm run build --prefix "$ROOT/packages/ai"
npm run build --prefix "$ROOT/packages/agent"
npm run build --prefix "$ROOT/packages/coding-agent"

echo "==> Done! Run 'pi' to use the updated build."
