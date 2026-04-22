#!/usr/bin/env bash
# Regenerate Python baseline captures for the collapse round port.
#
# For every `<case>.input.json` under python-captures/, runs
# `tools/pcd/collapse.collapse_manifest(input, 8000)` and writes the result
# as `<case>.output.json` with `indent=2` and a trailing newline (json.dump
# defaults, matching the original dataflow).
#
# The case list must stay in sync with the `cases` array inside
# `collapse.test.ts`.
#
# IMPORTANT: Fixtures must provide explicit `cluster_id` on every card that
# will collapse — Python's directory-fallback uses `hash(str) % 10000`,
# which is non-deterministic (PEP 456). Integer cluster_ids keep the
# captures stable across interpreter runs.
#
# Usage (from anywhere):
#   bash packages/cli/src/topics/pcd/__fixtures__/collapse/capture.sh

set -euo pipefail

FIXTURES_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$FIXTURES_DIR/../../../../../../.." && pwd)"
PY_CAP="$FIXTURES_DIR/python-captures"

mkdir -p "$PY_CAP"

CASES=(
  "all-clean"
  "all-critical"
  "boundary-risk-low-conf-3"
  "boundary-risk-low-conf-4"
  "boundary-risk-medium-conf-5"
  "mixed"
  "empty-manifest"
)

for name in "${CASES[@]}"; do
  input_path="$PY_CAP/$name.input.json"
  out_path="$PY_CAP/$name.output.json"
  if [[ ! -f "$input_path" ]]; then
    echo "missing input: $input_path" >&2
    exit 1
  fi
  python3 - "$input_path" "$out_path" <<PY
import json
import sys

sys.path.insert(0, "$REPO_ROOT/tools")

from pcd.collapse import collapse_manifest  # noqa: E402

input_path = sys.argv[1]
out_path = sys.argv[2]
with open(input_path, "r", encoding="utf-8") as fh:
    manifest = json.load(fh)
result = collapse_manifest(manifest, 8000)
with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(result, fh, indent=2)
    fh.write("\n")
PY
done

echo "wrote ${#CASES[@]} python capture pairs to $PY_CAP"
