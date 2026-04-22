#!/usr/bin/env bash
# Regenerate Python baseline captures for the batch-former port.
#
# For every `<case>.collapsed.json` + `<case>.structural.json` pair under
# python-captures/, runs `tools/pcd/batch_former.form_batches(collapsed,
# structural, max_files_per_batch)` and writes the result as
# `<case>.output.json` with `indent=2` and a trailing newline.
#
# Each case may supply its own `<case>.max-files.txt` (integer) to override
# the 15-file default; missing file falls back to 15.
#
# The case list must stay in sync with the `cases` array inside
# `batch-former.test.ts`.
#
# All fixture files use non-existent project-relative paths so the token
# estimator falls back to a deterministic 16000-char-per-file budget.
#
# Usage (from anywhere):
#   bash packages/cli/src/topics/pcd/__fixtures__/batch-former/capture.sh

set -euo pipefail

FIXTURES_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$FIXTURES_DIR/../../../../../../.." && pwd)"
PY_CAP="$FIXTURES_DIR/python-captures"

mkdir -p "$PY_CAP"

CASES=(
  "small"
  "oversized"
  "cross-cluster-questions"
  "empty"
  "single-file-cluster"
  "unroutable-question"
)

for name in "${CASES[@]}"; do
  collapsed_path="$PY_CAP/$name.collapsed.json"
  structural_path="$PY_CAP/$name.structural.json"
  out_path="$PY_CAP/$name.output.json"
  max_files_path="$PY_CAP/$name.max-files.txt"

  if [[ ! -f "$collapsed_path" ]]; then
    echo "missing collapsed input: $collapsed_path" >&2
    exit 1
  fi
  if [[ ! -f "$structural_path" ]]; then
    echo "missing structural input: $structural_path" >&2
    exit 1
  fi

  max_files=15
  if [[ -f "$max_files_path" ]]; then
    max_files="$(cat "$max_files_path")"
  fi

  python3 - "$collapsed_path" "$structural_path" "$out_path" "$max_files" <<PY
import json
import sys

sys.path.insert(0, "$REPO_ROOT/tools")

from pcd.batch_former import form_batches  # noqa: E402

collapsed_path = sys.argv[1]
structural_path = sys.argv[2]
out_path = sys.argv[3]
max_files = int(sys.argv[4])

with open(collapsed_path, "r", encoding="utf-8") as fh:
    collapsed = json.load(fh)
with open(structural_path, "r", encoding="utf-8") as fh:
    structural = json.load(fh)

# Use a project_root that doesn't exist so every file falls back to the
# 16000-char estimate — keeps captures deterministic across machines.
result = form_batches(collapsed, structural, max_files, "/nonexistent-root-for-parity")

with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(result, fh, indent=2)
    fh.write("\n")
PY
done

echo "wrote ${#CASES[@]} python capture pairs to $PY_CAP"
