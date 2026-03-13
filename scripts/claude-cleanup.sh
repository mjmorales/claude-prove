#!/usr/bin/env bash
# claude-cleanup.sh — Kill all Claude Code processes and clean session data
set -euo pipefail

CLAUDE_DIR="${HOME}/.claude"
DRY_RUN=false
SKIP_CONFIRM=false

usage() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Kill all Claude Code processes and clean up session/cache data.

Options:
  -n, --dry-run     Show what would be done without doing it
  -y, --yes         Skip confirmation prompt
  -h, --help        Show this help
EOF
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -n|--dry-run) DRY_RUN=true; shift ;;
        -y|--yes)     SKIP_CONFIRM=true; shift ;;
        -h|--help)    usage ;;
        *)            echo "Unknown option: $1"; usage ;;
    esac
done

# --- 1. Kill processes ---
echo "=== Claude Code Process Cleanup ==="

# Collect PIDs: claude CLI, node processes spawned by claude, MCP servers
CLAUDE_PIDS=$(pgrep -f '(^claude |/claude )' 2>/dev/null || true)
NODE_PIDS=$(pgrep -f 'claude.*node|node.*claude' 2>/dev/null || true)
ALL_PIDS=$(echo -e "${CLAUDE_PIDS}\n${NODE_PIDS}" | sort -u | grep -v '^$' || true)

# Exclude our own PID and parent shell
SELF=$$
PARENT=$PPID
FILTERED_PIDS=""
for pid in $ALL_PIDS; do
    if [[ "$pid" != "$SELF" && "$pid" != "$PARENT" ]]; then
        FILTERED_PIDS="${FILTERED_PIDS} ${pid}"
    fi
done
FILTERED_PIDS=$(echo "$FILTERED_PIDS" | xargs)

if [[ -z "$FILTERED_PIDS" ]]; then
    echo "No Claude Code processes found."
else
    echo "Found processes to kill:"
    for pid in $FILTERED_PIDS; do
        ps -p "$pid" -o pid=,command= 2>/dev/null || true
    done
    echo ""

    if [[ "$DRY_RUN" == true ]]; then
        echo "[dry-run] Would kill PIDs: $FILTERED_PIDS"
    else
        echo "Sending SIGKILL to: $FILTERED_PIDS"
        kill -9 $FILTERED_PIDS 2>/dev/null || true
        echo "Done."
    fi
fi

# --- 2. Clean git worktrees ---
echo ""
echo "=== Git Worktree Cleanup ==="

# Find worktrees in .claude/worktrees/ across all git repos in cwd
WORKTREE_DIR=".claude/worktrees"
if [[ -d "$WORKTREE_DIR" ]]; then
    WORKTREE_COUNT=$(ls -d "$WORKTREE_DIR"/*/ 2>/dev/null | wc -l | xargs)
    if [[ "$WORKTREE_COUNT" -gt 0 ]]; then
        echo "Found $WORKTREE_COUNT orphaned worktrees:"
        ls -d "$WORKTREE_DIR"/*/ 2>/dev/null
        if [[ "$DRY_RUN" == true ]]; then
            echo "[dry-run] Would remove all worktrees and their branches."
        else
            for wt in "$WORKTREE_DIR"/*/; do
                branch=$(git -C "$wt" branch --show-current 2>/dev/null || true)
                git worktree remove "$wt" --force 2>/dev/null || rm -rf "$wt"
                if [[ -n "$branch" ]]; then
                    git branch -D "$branch" 2>/dev/null || true
                fi
            done
            # Also clean any worktree branches that lost their worktree
            git branch -l | grep 'worktree-agent-' | xargs git branch -D 2>/dev/null || true
            echo "Cleaned all worktrees."
        fi
    else
        echo "No orphaned worktrees found."
    fi
else
    echo "No worktree directory found."
fi

# --- 3. Clean session and cache data ---
echo ""
echo "=== Session & Cache Cleanup ==="

DIRS_TO_CLEAN=(
    "${CLAUDE_DIR}/sessions"
    "${CLAUDE_DIR}/cache"
    "${CLAUDE_DIR}/shell-snapshots"
    "${CLAUDE_DIR}/paste-cache"
    "${CLAUDE_DIR}/ide"
    "${CLAUDE_DIR}/session-env"
)

# Collect project session files (*.jsonl and UUID dirs, but NOT memory/)
PROJECT_SESSIONS=()
if [[ -d "${CLAUDE_DIR}/projects" ]]; then
    while IFS= read -r f; do
        PROJECT_SESSIONS+=("$f")
    done < <(find "${CLAUDE_DIR}/projects" -maxdepth 2 \( -name '*.jsonl' -o -type d -name '[0-9a-f]*-[0-9a-f]*-[0-9a-f]*-[0-9a-f]*-[0-9a-f]*' \) 2>/dev/null)
fi

# Calculate sizes
TOTAL_SIZE=0
for dir in "${DIRS_TO_CLEAN[@]}"; do
    if [[ -d "$dir" ]]; then
        size=$(du -sk "$dir" 2>/dev/null | awk '{print $1}')
        TOTAL_SIZE=$((TOTAL_SIZE + size))
        echo "  $(du -sh "$dir" 2>/dev/null | awk '{print $1}')\t$dir"
    fi
done

if [[ ${#PROJECT_SESSIONS[@]} -gt 0 ]]; then
    proj_size=$(printf '%s\n' "${PROJECT_SESSIONS[@]}" | xargs du -sk 2>/dev/null | awk '{s+=$1} END {print s+0}')
    TOTAL_SIZE=$((TOTAL_SIZE + proj_size))
    proj_count=${#PROJECT_SESSIONS[@]}
    echo "  $(echo "${proj_size}" | awk '{printf "%.0fM", $1/1024}')\t${CLAUDE_DIR}/projects/ (${proj_count} session files across all projects)"
fi

TOTAL_MB=$(echo "$TOTAL_SIZE" | awk '{printf "%.1f", $1/1024}')
echo ""
echo "Total reclaimable: ~${TOTAL_MB}M"

if [[ "$DRY_RUN" == true ]]; then
    echo "[dry-run] Would delete all of the above."
    exit 0
fi

if [[ "$SKIP_CONFIRM" == false ]]; then
    echo ""
    read -rp "Delete all session/cache data? [y/N] " answer
    if [[ ! "$answer" =~ ^[Yy] ]]; then
        echo "Aborted."
        exit 0
    fi
fi

for dir in "${DIRS_TO_CLEAN[@]}"; do
    if [[ -d "$dir" ]]; then
        rm -rf "$dir"
        mkdir -p "$dir"
        echo "Cleaned: $dir"
    fi
done

if [[ ${#PROJECT_SESSIONS[@]} -gt 0 ]]; then
    for f in "${PROJECT_SESSIONS[@]}"; do
        rm -rf "$f"
    done
    echo "Cleaned: ${#PROJECT_SESSIONS[@]} session files from projects/"
fi

# Clean stats cache and other temp files
rm -f "${CLAUDE_DIR}/stats-cache.json" 2>/dev/null
rm -f "${CLAUDE_DIR}/mcp-needs-auth-cache.json" 2>/dev/null

echo ""
echo "Cleanup complete."
