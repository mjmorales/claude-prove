#!/usr/bin/env bash
# update-progress.sh — Update PROGRESS.md with task/wave status changes
#
# Usage:
#   update-progress.sh <PROGRESS_PATH> <EVENT> <TASK_ID> [DETAIL]
#
# Events:
#   task-start      Mark task as started
#   task-complete   Mark task as completed
#   task-validated  Mark task as validated
#   task-review     Log review verdict (DETAIL = "APPROVED" or "CHANGES_REQUIRED")
#   merge           Log merge result (DETAIL = "clean" or "conflict")
#   wave-complete   Mark wave as complete (TASK_ID = wave number)
#   issue           Log an issue (DETAIL = description)
#   final-tests     Log final test results (DETAIL = "PASS" or "FAIL")
#
# Creates PROGRESS.md if it doesn't exist.

set -eo pipefail

PROGRESS_PATH="${1:?Usage: update-progress.sh <PROGRESS_PATH> <EVENT> <TASK_ID> [DETAIL]}"
EVENT="${2:?Missing EVENT}"
TASK_ID="${3:?Missing TASK_ID}"
DETAIL="${4:-}"
TIMESTAMP="$(date '+%H:%M')"

# --- Initialize PROGRESS.md if missing ---

init_progress() {
  local dir
  dir="$(dirname "$PROGRESS_PATH")"
  mkdir -p "$dir"

  cat > "$PROGRESS_PATH" <<'EOF'
# Orchestrator Progress

**Status**: In Progress
**Started**: $(date -u '+%Y-%m-%dT%H:%M:%SZ')

## Task Status

(No tasks started yet)

## Review Log

| Time | Task | Verdict | Detail |
|------|------|---------|--------|

## Merge Log

| Time | Task | Result |
|------|------|--------|

## Issues

(None)

## Test Results

(Pending)
EOF

  # Fix the date placeholder
  local now
  now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  sed -i '' "s/\$(date -u '+%Y-%m-%dT%H:%M:%SZ')/$now/" "$PROGRESS_PATH" 2>/dev/null || \
  sed -i "s/\$(date -u '+%Y-%m-%dT%H:%M:%SZ')/$now/" "$PROGRESS_PATH" 2>/dev/null || true
}

[[ -f "$PROGRESS_PATH" ]] || init_progress

# --- Append to a section ---

# Appends a line after the last non-empty line in a section (between two ## headers)
append_to_section() {
  local section_header="$1"
  local line="$2"
  local tmpfile
  tmpfile="$(mktemp)"

  awk -v header="$section_header" -v newline="$line" '
    BEGIN { found=0; inserted=0 }
    {
      if ($0 ~ "^## " && found && !inserted) {
        print newline
        print ""
        inserted=1
      }
      if ($0 == header) {
        found=1
      }
      print
    }
    END {
      if (found && !inserted) {
        print newline
      }
    }
  ' "$PROGRESS_PATH" > "$tmpfile"
  mv "$tmpfile" "$PROGRESS_PATH"
}

# Replace placeholder text in a section
replace_placeholder() {
  local placeholder="$1"
  local replacement="$2"
  if grep -qF "$placeholder" "$PROGRESS_PATH"; then
    local tmpfile
    tmpfile="$(mktemp)"
    sed "s|${placeholder}|${replacement}|" "$PROGRESS_PATH" > "$tmpfile"
    mv "$tmpfile" "$PROGRESS_PATH"
  fi
}

# --- Handle events ---

case "$EVENT" in
  task-start)
    replace_placeholder "(No tasks started yet)" ""
    append_to_section "## Task Status" "- [ ] Task ${TASK_ID}: started ($TIMESTAMP)"
    echo "progress: task $TASK_ID started"
    ;;

  task-complete)
    # Update the task line from [ ] to [~] (complete but not yet validated)
    tmpfile="$(mktemp)"
    sed "s/- \[ \] Task ${TASK_ID}: started/- [~] Task ${TASK_ID}: completed/" "$PROGRESS_PATH" > "$tmpfile"
    mv "$tmpfile" "$PROGRESS_PATH"
    echo "progress: task $TASK_ID completed"
    ;;

  task-validated)
    # Update from [~] to [v] (validated)
    tmpfile="$(mktemp)"
    sed "s/- \[~\] Task ${TASK_ID}: completed/- [v] Task ${TASK_ID}: validated/" "$PROGRESS_PATH" > "$tmpfile"
    mv "$tmpfile" "$PROGRESS_PATH"
    echo "progress: task $TASK_ID validated"
    ;;

  task-review)
    # Update task status based on verdict
    if [[ "$DETAIL" == "APPROVED" ]]; then
      tmpfile="$(mktemp)"
      sed "s/- \[.\] Task ${TASK_ID}:.*/- [x] Task ${TASK_ID}: APPROVED ($TIMESTAMP)/" "$PROGRESS_PATH" > "$tmpfile"
      mv "$tmpfile" "$PROGRESS_PATH"
    fi
    # Append to review log
    append_to_section "## Review Log" "| $TIMESTAMP | $TASK_ID | ${DETAIL:-pending} | — |"
    echo "progress: task $TASK_ID review: $DETAIL"
    ;;

  merge)
    append_to_section "## Merge Log" "| $TIMESTAMP | $TASK_ID | ${DETAIL:-unknown} |"
    echo "progress: task $TASK_ID merge: $DETAIL"
    ;;

  wave-complete)
    append_to_section "## Task Status" ""
    append_to_section "## Task Status" "**Wave $TASK_ID complete** ($TIMESTAMP)"
    echo "progress: wave $TASK_ID complete"
    ;;

  issue)
    replace_placeholder "(None)" ""
    append_to_section "## Issues" "- [$TIMESTAMP] Task $TASK_ID: ${DETAIL:-unknown issue}"
    echo "progress: issue logged for task $TASK_ID"
    ;;

  final-tests)
    replace_placeholder "(Pending)" "${DETAIL:-unknown} ($TIMESTAMP)"
    echo "progress: final tests: $DETAIL"
    ;;

  *)
    echo "Unknown event: $EVENT" >&2
    echo "Valid events: task-start, task-complete, task-validated, task-review, merge, wave-complete, issue, final-tests" >&2
    exit 1
    ;;
esac
