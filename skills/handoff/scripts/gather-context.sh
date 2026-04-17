#!/usr/bin/env bash
# gather-context.sh — Deterministically gathers handoff context from git and prove artifacts.
#
# Usage: gather-context.sh <project-root> <plugin-dir>
#
# Outputs structured markdown sections to stdout. No LLM calls.

set -euo pipefail

PROJECT_ROOT="${1:-.}"
PLUGIN_DIR="${2:-}"

cd "$PROJECT_ROOT"

# --- Stale cleanup ---
if [[ -f .prove/handoff.md ]]; then
  rm .prove/handoff.md
  echo "<!-- Stale handoff cleaned -->" >&2
fi

# --- Git State ---
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
LAST_COMMIT=$(git log -1 --format="%h — %s" 2>/dev/null || echo "none")

# Recent commits on this branch (diverged from main)
MAIN_BRANCH="main"
if ! git rev-parse --verify "$MAIN_BRANCH" >/dev/null 2>&1; then
  MAIN_BRANCH="master"
fi
if git rev-parse --verify "$MAIN_BRANCH" >/dev/null 2>&1; then
  MERGE_BASE=$(git merge-base "$MAIN_BRANCH" HEAD 2>/dev/null || echo "")
  if [[ -n "$MERGE_BASE" ]]; then
    RECENT_COMMITS=$(git log --oneline "$MERGE_BASE"..HEAD 2>/dev/null | head -10)
  else
    RECENT_COMMITS=$(git log --oneline -5 2>/dev/null)
  fi
  DIFF_STAT=$(git diff --stat "$MAIN_BRANCH"...HEAD 2>/dev/null | tail -1)
else
  RECENT_COMMITS=$(git log --oneline -5 2>/dev/null)
  DIFF_STAT=""
fi

# Uncommitted changes
UNSTAGED=$(git diff --name-only 2>/dev/null || true)
STAGED=$(git diff --cached --name-only 2>/dev/null || true)

cat <<SECTION_GIT
## State
- **Branch**: \`$BRANCH\`
- **Last commit**: $LAST_COMMIT
SECTION_GIT

if [[ -n "$DIFF_STAT" ]]; then
  echo "- **Changes from $MAIN_BRANCH**: $DIFF_STAT"
fi
echo ""

# --- Files Modified ---
echo "## Files Modified (this session)"
echo ""

if [[ -n "$UNSTAGED" || -n "$STAGED" ]]; then
  if [[ -n "$STAGED" ]]; then
    echo "**Staged:**"
    echo "$STAGED" | head -30 | sed 's/^/- `/' | sed 's/$/`/'
    echo ""
  fi
  if [[ -n "$UNSTAGED" ]]; then
    echo "**Unstaged:**"
    echo "$UNSTAGED" | head -30 | sed 's/^/- `/' | sed 's/$/`/'
    echo ""
  fi
else
  echo "No uncommitted changes."
  echo ""
  # Show files from recent commits instead
  if [[ -n "$MERGE_BASE" ]]; then
    FILES_CHANGED=$(git diff --name-only "$MERGE_BASE"..HEAD 2>/dev/null | head -50)
    if [[ -n "$FILES_CHANGED" ]]; then
      echo "**Changed on this branch:**"
      echo "$FILES_CHANGED" | sed 's/^/- `/' | sed 's/$/`/'
      echo ""
    fi
  fi
fi

# --- Recent Commits ---
if [[ -n "$RECENT_COMMITS" ]]; then
  echo "## Recent Commits"
  echo ""
  echo '```'
  echo "$RECENT_COMMITS"
  echo '```'
  echo ""
fi

# --- Prove Artifacts ---
echo "## Prove Artifacts"
echo ""

FOUND_ARTIFACTS=false

for run_dir in .prove/runs/*/; do
  if [[ -d "$run_dir" ]]; then
    run_slug=$(basename "$run_dir")
    [[ -f "$run_dir/TASK_PLAN.md" ]] && echo "- \`.prove/runs/$run_slug/TASK_PLAN.md\` — Implementation plan" && FOUND_ARTIFACTS=true
    [[ -f "$run_dir/PRD.md" ]] && echo "- \`.prove/runs/$run_slug/PRD.md\` — Product requirements" && FOUND_ARTIFACTS=true
  fi
done
for run_dir in .prove/runs/*/; do
  if [[ -d "$run_dir" ]]; then
    run_slug=$(basename "$run_dir")
    echo "- \`.prove/runs/$run_slug/\` — Orchestrator run state"
    FOUND_ARTIFACTS=true
  fi
done
if [[ -d .prove/plans ]]; then
  PLAN_COUNT=$(find .prove/plans -maxdepth 1 -type d | tail -n +2 | wc -l | tr -d ' ')
  if [[ "$PLAN_COUNT" -gt 0 ]]; then
    echo "- \`.prove/plans/\` — $PLAN_COUNT step-level plan(s)"
    FOUND_ARTIFACTS=true
  fi
fi
if [[ -d .prove/decisions ]]; then
  DECISION_COUNT=$(find .prove/decisions -name '*.md' | wc -l | tr -d ' ')
  if [[ "$DECISION_COUNT" -gt 0 ]]; then
    echo "- \`.prove/decisions/\` — $DECISION_COUNT decision record(s)"
    FOUND_ARTIFACTS=true
  fi
fi
if [[ -d .prove/context ]]; then
  echo "- \`.prove/context/\` — Handoff context from orchestrator"
  FOUND_ARTIFACTS=true
fi
if [[ -d .prove/reports ]]; then
  echo "- \`.prove/reports/\` — Orchestrator run reports"
  FOUND_ARTIFACTS=true
fi

if [[ "$FOUND_ARTIFACTS" = false ]]; then
  echo "No prove artifacts found. Context is git-only."
fi
echo ""

# --- Discovery Block ---
# Try to generate compose_subagent_context() output
if [[ -n "$PLUGIN_DIR" && -f "$PLUGIN_DIR/skills/claude-md/composer.py" ]]; then
  DISCOVERY=$(PYTHONPATH="$PLUGIN_DIR/skills/claude-md" python3 -c "
import sys
sys.path.insert(0, '$PLUGIN_DIR/skills/claude-md')
from scanner import scan_project
from composer import compose_subagent_context
scan = scan_project('$PROJECT_ROOT', '$PLUGIN_DIR')
print(compose_subagent_context(scan, '$PLUGIN_DIR'))
" 2>/dev/null || true)

  if [[ -n "$DISCOVERY" ]]; then
    echo "## Discovery"
    echo ""
    echo "$DISCOVERY"
  fi
elif [[ -f .claude/.prove.json ]]; then
  # Fallback: extract validators directly from .claude/.prove.json
  echo "## Discovery"
  echo ""
  VALIDATORS=$(python3 -c "
import json
with open('.claude/.prove.json') as f:
    cfg = json.load(f)
for v in cfg.get('validators', []):
    print(f\"- {v['phase']}: \`{v['command']}\`\")
" 2>/dev/null || true)
  if [[ -n "$VALIDATORS" ]]; then
    echo "**Validation**: Run before committing:"
    echo "$VALIDATORS"
    echo ""
  fi
fi

# --- Task Plan Summary ---
# Extract step status from every active run via run_state CLI
for state in .prove/runs/*/*/state.json; do
  [[ -f "$state" ]] || continue
  run_dir="$(dirname "$state")"
  slug="$(basename "$run_dir")"
  branch="$(basename "$(dirname "$run_dir")")"
  echo "## Task Plan Steps ($branch/$slug)"
  echo ""
  PROVE_RUN_BRANCH="$branch" PROVE_RUN_SLUG="$slug" \
    python3 -m tools.run_state show --format md 2>/dev/null || true
  echo ""
done
