#!/usr/bin/env bash
# Regenerate Python baseline captures for the structural-map port.
#
# For each fixture project under projects/<name>/, runs
# `tools/pcd/structural_map.generate_structural_map(project, scope)` and
# writes the resulting dict (version/summary/modules/clusters/dependency_edges)
# as python-captures/<name>.json.
#
# The TS test (`structural-map.test.ts`, "python parity fixtures" suite)
# regenerates its TS output for the same scope and compares key-for-key
# against these captures. Timestamp is non-deterministic across runs so it
# is normalized to the literal string "CAPTURED" in both sides before diff.
#
# Usage (from anywhere):
#   bash packages/cli/src/topics/pcd/__fixtures__/structural-map/capture.sh

set -euo pipefail

FIXTURES_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$FIXTURES_DIR/../../../../../../.." && pwd)"
PROJECTS_DIR="$FIXTURES_DIR/projects"
PY_CAP="$FIXTURES_DIR/python-captures"

mkdir -p "$PY_CAP"

# Case name -> scope (space-separated project-relative paths).
# small: 3-file python project, one cluster.
# medium: 3 languages (python + TS + rust), multiple clusters.
# edge: single-file python project (isolated cluster).
CASES=(
  "small|app.py helpers.py models.py"
  "medium|py/__init__.py py/app.py py/models.py py/utils.py ts/index.ts ts/math.ts ts/logger.ts rs/src/main.rs rs/src/parser.rs"
  "edge|solo.py"
)

for entry in "${CASES[@]}"; do
  name="${entry%%|*}"
  scope="${entry#*|}"
  project_path="$PROJECTS_DIR/$name"
  out_path="$PY_CAP/$name.json"
  if [[ ! -d "$project_path" ]]; then
    echo "missing project: $project_path" >&2
    exit 1
  fi
  python3 - "$project_path" "$out_path" "$scope" <<PY
import json
import sys

sys.path.insert(0, "$REPO_ROOT/tools")

from pcd.structural_map import generate_structural_map  # noqa: E402

project_path = sys.argv[1]
out_path = sys.argv[2]
scope = sys.argv[3].split() if sys.argv[3] else []
result = generate_structural_map(project_path, scope=scope)
# Normalize non-deterministic fields so byte comparison stays stable.
result["timestamp"] = "CAPTURED"
with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(result, fh, indent=2)
    fh.write("\n")
PY
done

echo "wrote $((${#CASES[@]})) python structural-map captures to $PY_CAP"
