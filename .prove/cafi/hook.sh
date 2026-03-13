#!/usr/bin/env bash
# CAFI SessionStart Hook
# Checks file index cache, runs incremental update if needed,
# and outputs additionalContext for Claude Code.
set -eo pipefail

# --- Locate project root (directory containing .prove/) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# .prove/cafi/hook.sh → project root is two levels up
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CAFI_DIR="$PROJECT_ROOT/.prove/cafi"
CACHE_FILE="$PROJECT_ROOT/.prove/file-index.json"
LOG_FILE="$CAFI_DIR/hook.log"

# --- Guard: exit silently if prerequisites are missing ---
[ -d "$CAFI_DIR" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

# Redirect stderr to log file for debugging
exec 2>>"$LOG_FILE"
echo "--- hook.sh $(date -u '+%Y-%m-%dT%H:%M:%SZ') ---" >&2

PYTHON_CMD="python3 $CAFI_DIR/__main__.py --project-root $PROJECT_ROOT"

# --- First run: no cache exists yet ---
if [ ! -f "$CACHE_FILE" ]; then
    echo "No cache file found; suggesting initial index." >&2
    HINT="# Project File Index\n\nNo file index found yet. Run \`/prove:index\` to build the initial index."
    printf '{"hookSpecificOutput":{"additionalContext":"%s"}}\n' "$HINT"
    exit 0
fi

# --- Check status for stale/new files ---
echo "Checking index status..." >&2
STATUS_JSON=$($PYTHON_CMD status) || {
    echo "Status command failed; serving stale cache." >&2
    STATUS_JSON='{"new":0,"stale":0}'
}

NEW_COUNT=$(echo "$STATUS_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('new',0))" 2>/dev/null || echo 0)
STALE_COUNT=$(echo "$STATUS_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('stale',0))" 2>/dev/null || echo 0)

# --- Incremental update if needed ---
if [ "$NEW_COUNT" -gt 0 ] || [ "$STALE_COUNT" -gt 0 ]; then
    echo "Found $NEW_COUNT new, $STALE_COUNT stale files; running incremental index..." >&2
    $PYTHON_CMD index >&2 || echo "Incremental index failed; continuing with stale cache." >&2
fi

# --- Output context ---
echo "Generating context output..." >&2
CONTEXT=$($PYTHON_CMD context) || {
    echo "Context command failed." >&2
    exit 0
}

if [ -z "$CONTEXT" ]; then
    echo "Empty context; skipping output." >&2
    exit 0
fi

# Escape the context string for JSON embedding
CONTEXT_JSON=$(python3 -c "
import sys, json
text = sys.stdin.read()
print(json.dumps(text), end='')
" <<< "$CONTEXT") || {
    echo "JSON encoding failed." >&2
    exit 0
}

printf '{"hookSpecificOutput":{"additionalContext":%s}}\n' "$CONTEXT_JSON"
echo "Hook completed successfully." >&2
