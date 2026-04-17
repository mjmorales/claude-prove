#!/usr/bin/env bash
# cleanup.sh — Archive and remove .prove task artifacts
#
# Usage:
#   cleanup.sh --dry-run [task-slug]   List what would be cleaned (no changes)
#   cleanup.sh [task-slug]             Archive and remove artifacts for a task
#   cleanup.sh --all                   Archive and remove ALL task artifacts
#   cleanup.sh --auto [task-slug]      Non-interactive mode (for orchestrator post-merge)
#
# When no task-slug is given (without --all), scans and lists all artifacts.
#
# Outputs JSON-like structured text so the calling skill can parse results.
# Does NOT generate SUMMARY.md — that requires LLM context; the skill handles it.

set -eo pipefail
shopt -s nullglob

PROJECT_ROOT="${PROJECT_ROOT:-.}"
PROVE_DIR="$PROJECT_ROOT/.prove"
TODAY=$(date +%Y-%m-%d)

DRY_RUN=false
ALL=false
AUTO=false
TASK_SLUG=""

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --all)     ALL=true; shift ;;
    --auto)    AUTO=true; shift ;;
    *)         TASK_SLUG="$1"; shift ;;
  esac
done

# --- Scan for artifacts ---

found_runs=()
found_plans=()
found_context=()
found_branches=()
found_worktrees=()

scan_artifacts() {
  local slug="$1"

  if [[ -n "$slug" ]]; then
    # Scan for specific task — runs live under .prove/runs/<branch>/<slug>/
    for d in "$PROVE_DIR"/runs/*/"$slug"/; do
      [[ -d "$d" ]] && found_runs+=("$(basename "$(dirname "$d")")/$slug")
    done
    for d in "$PROVE_DIR"/plans/plan_*/; do
      [[ -d "$d" ]] && found_plans+=("$(basename "$d")")
    done
    [[ -d "$PROVE_DIR/context/$slug" ]] && found_context+=("$slug") || true
    if git branch --list "orchestrator/$slug" 2>/dev/null | grep -q .; then
      found_branches+=("orchestrator/$slug")
    fi
    local wt_path=".claude/worktrees/orchestrator-$slug"
    [[ -d "$wt_path" ]] && found_worktrees+=("$wt_path") || true
  else
    # Scan for all artifacts
    for d in "$PROVE_DIR"/runs/*/*/; do
      [[ -d "$d" ]] && found_runs+=("$(basename "$(dirname "$d")")/$(basename "$d")")
    done
    for d in "$PROVE_DIR"/plans/plan_*/; do
      [[ -d "$d" ]] && found_plans+=("$(basename "$d")")
    done
    for d in "$PROVE_DIR"/context/*/; do
      [[ -d "$d" ]] && found_context+=("$(basename "$d")")
    done
    while IFS= read -r branch; do
      branch=$(echo "$branch" | xargs)
      [[ -n "$branch" ]] && found_branches+=("$branch")
    done < <(git branch --list 'orchestrator/*' 2>/dev/null)
    for d in .claude/worktrees/orchestrator-*/; do
      [[ -d "$d" ]] && found_worktrees+=("$d")
    done
  fi
}

# --- Print scan results ---

print_found() {
  local count=0

  if [[ ${#found_runs[@]} -gt 0 ]]; then
    for r in "${found_runs[@]}"; do
      echo "  run: .prove/runs/$r/"
      ((count++)) || true
    done
  fi
  if [[ ${#found_plans[@]} -gt 0 ]]; then
    for p in "${found_plans[@]}"; do
      echo "  plan: .prove/plans/$p/"
      ((count++)) || true
    done
  fi
  if [[ ${#found_context[@]} -gt 0 ]]; then
    for c in "${found_context[@]}"; do
      echo "  context: .prove/context/$c/"
      ((count++)) || true
    done
  fi
  if [[ ${#found_worktrees[@]} -gt 0 ]]; then
    for w in "${found_worktrees[@]}"; do
      echo "  worktree: $w"
      ((count++)) || true
    done
  fi
  if [[ ${#found_branches[@]} -gt 0 ]]; then
    for b in "${found_branches[@]}"; do
      echo "  branch: $b"
      ((count++)) || true
    done
  fi

  if [[ $count -eq 0 ]]; then
    echo "  (none found)"
  fi
  echo ""
  echo "total: $count"
}

# --- Check if branch is merged to main ---

branch_merged() {
  local branch="$1"
  local main_branch
  main_branch=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "main")

  # Check if the branch tip is an ancestor of main (handles both merge and squash)
  if git merge-base --is-ancestor "$branch" "$main_branch" 2>/dev/null; then
    return 0
  fi
  # Fallback: check if git diff between branch and main is empty (squash-merge case)
  if git diff "$main_branch...$branch" --quiet 2>/dev/null; then
    return 0
  fi
  return 1
}

# --- Archive artifacts ---

archive_slug() {
  local slug="$1"
  local archive_dir="$PROVE_DIR/archive/${TODAY}_${slug}"
  mkdir -p "$archive_dir"

  # Archive run directory (branched layout: .prove/runs/<branch>/<slug>/)
  if [[ "$slug" == "all" ]]; then
    for d in "$PROVE_DIR"/runs/*/*/; do
      if [[ -d "$d" ]]; then
        local branch_name rname
        rname=$(basename "$d")
        branch_name=$(basename "$(dirname "$d")")
        cp -r "$d" "$archive_dir/run-${branch_name}-${rname}/"
        echo "  archived: runs/${branch_name}/${rname}/ -> archive/${TODAY}_${slug}/"
      fi
    done
  else
    for d in "$PROVE_DIR"/runs/*/"$slug"/; do
      if [[ -d "$d" ]]; then
        local branch_name
        branch_name=$(basename "$(dirname "$d")")
        cp -r "$d" "$archive_dir/run/"
        echo "  archived: runs/${branch_name}/${slug}/ -> archive/${TODAY}_${slug}/"
        break
      fi
    done
  fi

  # Archive plans (copy key files from any matching plan dirs)
  for d in "$PROVE_DIR"/plans/plan_*/; do
    if [[ -d "$d" ]]; then
      [[ -f "$d/02_design_decisions.md" ]] && \
        cp "$d/02_design_decisions.md" "$archive_dir/design-decisions.md"
      [[ -f "$d/01_requirements.md" ]] && \
        cp "$d/01_requirements.md" "$archive_dir/requirements.md"
      echo "  archived: plans/$(basename "$d")/ -> archive/${TODAY}_${slug}/"
    fi
  done

  # Archive handoff context
  if [[ -d "$PROVE_DIR/context/$slug" ]]; then
    [[ -f "$PROVE_DIR/context/$slug/handoff-log.md" ]] && \
      cp "$PROVE_DIR/context/$slug/handoff-log.md" "$archive_dir/handoff-log.md"
    echo "  archived: context/$slug/ -> archive/${TODAY}_${slug}/"
  fi

  # Capture diff stat if branch exists
  if git rev-parse --verify "orchestrator/$slug" &>/dev/null; then
    local main_branch
    main_branch=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "main")
    git diff --stat "$main_branch...orchestrator/$slug" > "$archive_dir/files-changed.txt" 2>/dev/null || true
  fi

  echo "$archive_dir"
}

# --- Remove artifacts ---

remove_artifacts() {
  local slug="$1"
  local remove_all=false
  [[ "$slug" == "all" ]] && remove_all=true

  # Remove run directories (branched layout)
  if $remove_all; then
    for d in "$PROVE_DIR"/runs/*/*/; do
      if [[ -d "$d" ]]; then
        local bn sn
        sn=$(basename "$d")
        bn=$(basename "$(dirname "$d")")
        rm -rf "$d"
        echo "  removed: .prove/runs/${bn}/${sn}/"
      fi
    done
    # Clean up now-empty branch dirs
    for d in "$PROVE_DIR"/runs/*/; do
      rmdir "$d" 2>/dev/null && echo "  removed: $d (empty)" || true
    done
  else
    for d in "$PROVE_DIR"/runs/*/"$slug"/; do
      if [[ -d "$d" ]]; then
        local bn
        bn=$(basename "$(dirname "$d")")
        rm -rf "$d"
        echo "  removed: .prove/runs/${bn}/${slug}/"
        rmdir "$PROVE_DIR/runs/$bn" 2>/dev/null || true
      fi
    done
  fi
  rmdir "$PROVE_DIR/runs" 2>/dev/null && echo "  removed: .prove/runs/ (empty)" || true

  # Remove plans
  for d in "$PROVE_DIR"/plans/plan_*/; do
    if [[ -d "$d" ]]; then
      rm -rf "$d"
      echo "  removed: .prove/plans/$(basename "$d")/"
    fi
  done
  rmdir "$PROVE_DIR/plans" 2>/dev/null && echo "  removed: .prove/plans/ (empty)" || true

  # Remove context
  if $remove_all; then
    for d in "$PROVE_DIR"/context/*/; do
      [[ -d "$d" ]] && rm -rf "$d" && echo "  removed: .prove/context/$(basename "$d")/"
    done
  elif [[ -d "$PROVE_DIR/context/$slug" ]]; then
    rm -rf "$PROVE_DIR/context/$slug"
    echo "  removed: .prove/context/$slug/"
  fi
  rmdir "$PROVE_DIR/context" 2>/dev/null && echo "  removed: .prove/context/ (empty)" || true

  # Remove orchestrator worktrees
  if $remove_all; then
    for d in .claude/worktrees/orchestrator-*/; do
      if [[ -d "$d" ]]; then
        git worktree remove "$d" --force 2>/dev/null && echo "  removed worktree: $d" || echo "  SKIPPED worktree: $d (remove failed)"
      fi
    done
  elif [[ -n "$slug" ]]; then
    local wt_path=".claude/worktrees/orchestrator-$slug"
    if [[ -d "$wt_path" ]]; then
      git worktree remove "$wt_path" --force 2>/dev/null && echo "  removed worktree: $wt_path" || echo "  SKIPPED worktree: $wt_path (remove failed)"
    fi
  fi
}

# --- Delete branches ---

delete_branches() {
  for branch in "${found_branches[@]}"; do
    if branch_merged "$branch"; then
      git branch -D "$branch" 2>/dev/null
      echo "  deleted: $branch (merged)"
    else
      echo "  SKIPPED: $branch (not merged to main — verify manually)"
    fi
  done
}

# === Main ===

if [[ ! -d "$PROVE_DIR" ]]; then
  echo "No .prove/ directory found."
  exit 0
fi

if $ALL; then
  scan_artifacts ""
elif [[ -n "$TASK_SLUG" ]]; then
  scan_artifacts "$TASK_SLUG"
else
  # No slug, no --all: just scan and report
  scan_artifacts ""
  echo "=== Artifacts Found ==="
  print_found
  exit 0
fi

if $DRY_RUN; then
  echo "=== Dry Run ==="
  print_found
  exit 0
fi

# Derive a slug for the archive directory name
if [[ -n "$TASK_SLUG" ]]; then
  ARCHIVE_SLUG="$TASK_SLUG"
else
  ARCHIVE_SLUG="all"
fi

echo "=== Archiving ==="
archive_slug "$ARCHIVE_SLUG"

echo ""
echo "=== Removing ==="
remove_artifacts "$ARCHIVE_SLUG"

echo ""
echo "=== Branches ==="
if [[ ${#found_branches[@]} -gt 0 ]]; then
  delete_branches
else
  echo "  (no branches to delete)"
fi

echo ""
echo "=== Done ==="
echo "Archive: .prove/archive/${TODAY}_${ARCHIVE_SLUG}/"
echo "Note: Generate SUMMARY.md in the archive directory to complete cleanup."
