#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

# ─── Options ──────────────────────────────────────────────────────────────────
CLEAN=false
SKIP_WEB_UI=false

for arg in "$@"; do
  case "$arg" in
    --clean)   CLEAN=true ;;
    --no-web-ui) SKIP_WEB_UI=true ;;
    --help|-h)
      echo "Usage: ./build.sh [--clean] [--no-web-ui]"
      echo "  --clean       Run 'npm run clean' in each package before building"
      exit 0 ;;
  esac
done

# ─── Helpers ──────────────────────────────────────────────────────────────────
SECONDS=0

build_pkg() {
  local name="$1"
  local dir="$ROOT/packages/$name"
  local t=$SECONDS

  if [ "$CLEAN" = true ]; then
    echo "  [clean] $name"
    npm run clean --prefix "$dir" --silent 2>/dev/null || true
  fi

  echo "  [build] $name"
  npm run build --prefix "$dir"

  local elapsed=$(( SECONDS - t ))
  echo "  [done]  $name (${elapsed}s)"
}

# ─── Build ────────────────────────────────────────────────────────────────────
echo ""
echo "Building pi-x (root: $ROOT)"
echo "─────────────────────────────────────────"

# Core packages — strict dependency order
build_pkg tui
#build_pkg ai
build_pkg agent
build_pkg coding-agent
#build_pkg mom
#build_pkg pods
#build_pkg web-ui

echo "─────────────────────────────────────────"
echo "Done in ${SECONDS}s. Run 'pi' to use the updated build."
echo ""
