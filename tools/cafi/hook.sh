#!/usr/bin/env bash
# CAFI SessionStart Hook
# Checks file index cache, runs incremental update if needed,
# and outputs additionalContext for Claude Code.
set -eo pipefail

# --- Locate project root (directory containing tools/) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# tools/cafi/hook.sh → project root is two levels up
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CAFI_DIR="$PROJECT_ROOT/tools/cafi"
CACHE_FILE="$PROJECT_ROOT/.prove/file-index.json"
LOG_DIR="$PROJECT_ROOT/.prove"
LOG_FILE="$LOG_DIR/cafi-hook.log"

# --- Guard: exit silently if prerequisites are missing ---
[ -d "$CAFI_DIR" ] || exit 0
mkdir -p "$LOG_DIR"
command -v python3 >/dev/null 2>&1 || exit 0

# --- Lockfile guard: prevent concurrent hook executions ---
LOCKFILE="$LOG_DIR/cafi-hook.lock"
cleanup_lock() { rm -rf "$LOCKFILE"; }

# Use mkdir as an atomic lock (succeeds only if dir doesn't exist)
if ! mkdir "$LOCKFILE" 2>/dev/null; then
    # Check if the lock is stale (older than 120 seconds)
    if [ -f "$LOCKFILE/pid" ]; then
        LOCK_PID=$(cat "$LOCKFILE/pid" 2>/dev/null)
        LOCK_AGE=$(( $(date +%s) - $(stat -f %m "$LOCKFILE/pid" 2>/dev/null || echo 0) ))
        if [ "$LOCK_AGE" -gt 120 ]; then
            echo "Stale lock detected (age=${LOCK_AGE}s, pid=${LOCK_PID}); breaking." >&2
            rm -rf "$LOCKFILE"
            mkdir "$LOCKFILE" 2>/dev/null || { echo "Could not acquire lock after break; exiting." >&2; exit 0; }
        else
            echo "Another hook instance running (pid=${LOCK_PID}, age=${LOCK_AGE}s); skipping." >&2
            exit 0
        fi
    else
        echo "Lock exists but no pid file; skipping." >&2
        exit 0
    fi
fi
echo $$ > "$LOCKFILE/pid"
trap cleanup_lock EXIT

# Redirect stderr to log file for debugging (truncate if > 500 lines)
if [ -f "$LOG_FILE" ] && [ "$(wc -l < "$LOG_FILE")" -gt 500 ]; then
    tail -100 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
fi
exec 2>>"$LOG_FILE"
echo "--- hook.sh $(date -u '+%Y-%m-%dT%H:%M:%SZ') ---" >&2

# Helper: run the CAFI CLI with properly quoted arguments
cafi_cmd() {
    python3 "$CAFI_DIR/__main__.py" --project-root "$PROJECT_ROOT" "$@"
}

# Helper: JSON-encode a string via python
json_encode() {
    python3 -c "import sys, json; print(json.dumps(sys.stdin.read()), end='')"
}

# --- Overall timeout: kill self after 60 seconds ---
( sleep 60 && kill -TERM $$ 2>/dev/null ) &
WATCHDOG_PID=$!
trap 'kill $WATCHDOG_PID 2>/dev/null; cleanup_lock' EXIT

# --- First run: no cache exists yet ---
if [ ! -f "$CACHE_FILE" ]; then
    echo "No cache file found; suggesting initial index." >&2
    HINT="No file index found yet. Run /prove:index to build the initial index."
    HINT_JSON=$(echo "$HINT" | json_encode) || { echo "JSON encoding failed." >&2; exit 0; }
    printf '{"hookSpecificOutput":{"additionalContext":%s}}\n' "$HINT_JSON"
    exit 0
fi

# --- Check status for stale/new files ---
echo "Checking index status..." >&2
STATUS_JSON=$(cafi_cmd status) || {
    echo "Status command failed; serving stale cache." >&2
    STATUS_JSON='{"new":0,"stale":0}'
}

NEW_COUNT=$(echo "$STATUS_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('new',0))" 2>/dev/null || echo 0)
STALE_COUNT=$(echo "$STATUS_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('stale',0))" 2>/dev/null || echo 0)

# --- Incremental update if needed (skip if too many files to avoid CPU spike) ---
TOTAL_PENDING=$((NEW_COUNT + STALE_COUNT))
if [ "$TOTAL_PENDING" -gt 0 ] && [ "$TOTAL_PENDING" -le 20 ]; then
    echo "Found $NEW_COUNT new, $STALE_COUNT stale files; running incremental index..." >&2
    cafi_cmd index >&2 || echo "Incremental index failed; continuing with stale cache." >&2
elif [ "$TOTAL_PENDING" -gt 20 ]; then
    echo "Too many pending files ($TOTAL_PENDING); skipping auto-index. Run /prove:index manually." >&2
fi

# --- Output context ---
echo "Generating context output..." >&2
CONTEXT=$(cafi_cmd context 2>/dev/null) || {
    echo "Context command returned no results." >&2
    exit 0
}

if [ -z "$CONTEXT" ]; then
    echo "Empty context; skipping output." >&2
    exit 0
fi

# Escape the context string for JSON embedding
CONTEXT_JSON=$(echo "$CONTEXT" | json_encode) || {
    echo "JSON encoding failed." >&2
    exit 0
}

printf '{"hookSpecificOutput":{"additionalContext":%s}}\n' "$CONTEXT_JSON"
echo "Hook completed successfully." >&2
