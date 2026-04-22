#!/usr/bin/env bash
# Capture Python and TS CLI output for each schema fixture.
#
# For each of v0.json..v3.json and the repo's real .claude/.prove.json:
#   - Copy the fixture to a temp dir as .prove.json (so auto-detection fires
#     and the filename in the CLI output is deterministic).
#   - Run `validate`, `migrate --dry-run`, and `diff` against that temp copy.
#   - Substitute the actual temp path with the sentinel <FIXTURE_PATH> so the
#     capture is reproducible across invocations.
#
# Emits captures to python-captures/ and ts-captures/ beside this script.
# The integration test uses the same temp-copy + sentinel-substitution flow
# at runtime to compare live CLI output to the captured reference.
#
# Rerun after any schema / diff / validate / migrate logic change:
#   bash packages/cli/src/topics/schema/__fixtures__/capture.sh

set -euo pipefail

FIXTURES_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$FIXTURES_DIR/../../../../../.." && pwd)"
PY_CAP="$FIXTURES_DIR/python-captures"
TS_CAP="$FIXTURES_DIR/ts-captures"
CLI_ENTRY="$REPO_ROOT/packages/cli/bin/run.ts"

mkdir -p "$PY_CAP" "$TS_CAP"

SENTINEL='<FIXTURE_PATH>'

capture() {
  local fixture="$1"        # absolute path to v?.json
  local label="$2"          # e.g. "v0"
  local tmp
  tmp="$(mktemp -d)"
  local target="$tmp/.prove.json"
  cp "$fixture" "$target"

  # Python captures
  (cd "$REPO_ROOT" && PYTHONPATH="$REPO_ROOT" python3 -m tools.schema validate --file "$target" 2>&1) \
    | sed "s|$target|$SENTINEL|g" > "$PY_CAP/validate_$label.txt" || true
  # Re-copy before migrate so dry-run state mirrors initial fixture
  cp "$fixture" "$target"
  (cd "$REPO_ROOT" && PYTHONPATH="$REPO_ROOT" python3 -m tools.schema migrate --file "$target" --dry-run 2>&1) \
    | sed "s|$target|$SENTINEL|g" > "$PY_CAP/migrate_dry_$label.txt" || true
  cp "$fixture" "$target"
  (cd "$REPO_ROOT" && PYTHONPATH="$REPO_ROOT" python3 -m tools.schema diff --file "$target" 2>&1) \
    | sed "s|$target|$SENTINEL|g" > "$PY_CAP/diff_$label.txt" || true

  # TS captures
  cp "$fixture" "$target"
  (cd "$REPO_ROOT" && bun run "$CLI_ENTRY" schema validate --file "$target" 2>&1) \
    | sed "s|$target|$SENTINEL|g" > "$TS_CAP/validate_$label.txt" || true
  cp "$fixture" "$target"
  (cd "$REPO_ROOT" && bun run "$CLI_ENTRY" schema migrate --file "$target" --dry-run 2>&1) \
    | sed "s|$target|$SENTINEL|g" > "$TS_CAP/migrate_dry_$label.txt" || true
  cp "$fixture" "$target"
  (cd "$REPO_ROOT" && bun run "$CLI_ENTRY" schema diff --file "$target" 2>&1) \
    | sed "s|$target|$SENTINEL|g" > "$TS_CAP/diff_$label.txt" || true

  rm -rf "$tmp"
}

for label in v0 v1 v2 v3; do
  capture "$FIXTURES_DIR/$label.json" "$label"
done

# Real repo config — summary only (exercises both prove + settings paths).
# Runs from REPO_ROOT so both files exist under .claude/.
(cd "$REPO_ROOT" && PYTHONPATH="$REPO_ROOT" python3 -m tools.schema summary 2>&1) > "$PY_CAP/summary_repo.txt" || true
(cd "$REPO_ROOT" && bun run "$CLI_ENTRY" schema summary 2>&1) > "$TS_CAP/summary_repo.txt" || true

echo "captures written to $PY_CAP and $TS_CAP"
