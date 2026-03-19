#!/usr/bin/env bash
# build-extension.sh — Build and install the ACB VS Code extension
#
# Usage:
#   bash scripts/build-extension.sh          # build + install into Cursor
#   bash scripts/build-extension.sh --code   # build + install into VS Code
#   bash scripts/build-extension.sh --build-only  # build without installing

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EXT_DIR="$PROJECT_ROOT/packages/acb-vscode"
EDITOR="cursor"
BUILD_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --code)       EDITOR="code"; shift ;;
    --build-only) BUILD_ONLY=true; shift ;;
    *)            echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# Check prerequisites
if ! command -v npm &>/dev/null; then
  echo "ERROR: npm not found" >&2
  exit 1
fi

if [[ "$BUILD_ONLY" == false ]] && ! command -v "$EDITOR" &>/dev/null; then
  echo "ERROR: '$EDITOR' not found in PATH" >&2
  echo "Use --cursor for Cursor, or --build-only to skip install" >&2
  exit 1
fi

# Build
echo "Building acb-vscode extension..."
cd "$EXT_DIR"
npm run build

echo "Packaging .vsix..."
npm run package

# Find the .vsix
VSIX=$(ls -t "$EXT_DIR"/*.vsix 2>/dev/null | head -1)
if [[ -z "$VSIX" ]]; then
  echo "ERROR: No .vsix file produced" >&2
  exit 1
fi

echo "Built: $VSIX"

if [[ "$BUILD_ONLY" == true ]]; then
  exit 0
fi

# Install
echo "Installing into $EDITOR..."
"$EDITOR" --install-extension "$VSIX" --force

echo ""
echo "Done. Reload the $EDITOR window to activate."
