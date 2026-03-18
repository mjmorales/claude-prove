#!/usr/bin/env bash
# update-progress.sh — Updates PROGRESS.md with task/wave status changes.
#
# Usage: update-progress.sh <progress-path> <action> [args...]
#
# Actions:
#   init <feature-name> <branch> <wave-count> <task-list-json>
#   task-start <task-id>
#   task-complete <task-id>
#   task-fail <task-id> <reason>
#   task-review <task-id> <verdict>       # APPROVED or CHANGES_REQUIRED
#   task-review-pass <task-id> <attempt>
#   wave-complete <wave-num> <test-result>
#   merge <task-id> <status>              # clean, conflict, skip
#   issue <description>
#   final <test-result>
#   status <new-status>                   # Completed, Failed, Paused

set -euo pipefail

sedi() {
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}

PROGRESS="$1"
ACTION="$2"
shift 2

TIMESTAMP=$(date +"%H:%M")
DATE=$(date +"%Y-%m-%d")

case "$ACTION" in
  init)
    FEATURE="$1"
    BRANCH="$2"
    cat > "$PROGRESS" <<EOF
# Progress: $FEATURE

**Started**: $DATE $TIMESTAMP
**Status**: In Progress
**Branch**: $BRANCH

## Overview
| Wave | Tasks | Completed | Reviewed | Status |
|------|-------|-----------|----------|--------|
<!-- waves will be added dynamically -->

## Task Status
<!-- tasks will be added dynamically -->

## Review Log

## Merge Log

## Issues

## Test Results
EOF
    echo "Initialized $PROGRESS"
    ;;

  task-start)
    TASK_ID="$1"
    if grep -q "Task $TASK_ID:" "$PROGRESS" 2>/dev/null; then
      sedi "s/\(Task $TASK_ID:.*\)— .*/\1— In Progress ($TIMESTAMP)/" "$PROGRESS"
    else
      echo "- [ ] Task $TASK_ID — In Progress ($TIMESTAMP)" >> "$PROGRESS"
    fi
    ;;

  task-complete)
    TASK_ID="$1"
    sedi "s/\(Task $TASK_ID:.*\)— .*/\1— Implemented, pending review ($TIMESTAMP)/" "$PROGRESS"
    ;;

  task-fail)
    TASK_ID="$1"
    REASON="$2"
    sedi "s/\(Task $TASK_ID:.*\)— .*/\1— FAILED ($TIMESTAMP)/" "$PROGRESS"
    echo "- $TIMESTAMP: Task $TASK_ID failed: $REASON" >> "$PROGRESS"
    ;;

  task-review)
    TASK_ID="$1"
    VERDICT="$2"
    if [[ "$VERDICT" == "APPROVED" ]]; then
      sedi "s/\(Task $TASK_ID:.*\)— .*/\1— Review APPROVED ($TIMESTAMP)/" "$PROGRESS"
      # Add to review log
      sedi "/^## Review Log/a\\
- $TIMESTAMP Task $TASK_ID: APPROVED" "$PROGRESS"
    else
      sedi "s/\(Task $TASK_ID:.*\)— .*/\1— Review: CHANGES REQUIRED ($TIMESTAMP)/" "$PROGRESS"
      sedi "/^## Review Log/a\\
- $TIMESTAMP Task $TASK_ID: CHANGES_REQUIRED — fixing..." "$PROGRESS"
    fi
    ;;

  task-review-pass)
    TASK_ID="$1"
    ATTEMPT="$2"
    sedi "s/\[ \] \(Task $TASK_ID:.*\)/[x] \1/" "$PROGRESS"
    sedi "s/\(Task $TASK_ID:.*\)— .*/\1— APPROVED after $ATTEMPT review(s) ($TIMESTAMP)/" "$PROGRESS"
    ;;

  merge)
    TASK_ID="$1"
    STATUS="$2"
    sedi "/^## Merge Log/a\\
- $TIMESTAMP Merged task $TASK_ID ($STATUS)" "$PROGRESS"
    ;;

  wave-complete)
    WAVE="$1"
    TEST_RESULT="$2"
    sedi "/^## Test Results/a\\
- Wave $WAVE post-merge: $TEST_RESULT" "$PROGRESS"
    ;;

  issue)
    DESC="$1"
    sedi "/^## Issues/a\\
- $TIMESTAMP: $DESC" "$PROGRESS"
    ;;

  final)
    TEST_RESULT="$1"
    sedi "/^## Test Results/a\\
- Final: $TEST_RESULT ($TIMESTAMP)" "$PROGRESS"
    ;;

  status)
    NEW_STATUS="$1"
    sedi "s/\*\*Status\*\*: .*/\*\*Status\*\*: $NEW_STATUS/" "$PROGRESS"
    ;;

  *)
    echo "Unknown action: $ACTION" >&2
    exit 1
    ;;
esac
