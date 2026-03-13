#!/usr/bin/env bash
# Launch Claude Code with the prove plugin loaded and permissions skipped.
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"

exec claude --plugin-dir "$PLUGIN_DIR" --dangerously-skip-permissions "$@"
