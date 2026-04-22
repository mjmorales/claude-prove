#!/usr/bin/env bash
# Regenerate Python baseline captures for the import-parser port.
#
# For every `<case>.input` file under python-captures/, runs
# `tools/pcd/import_parser.parse_imports(<source_file>, input)` and writes the
# resulting NamedTuple list as `<case>.entries.json` (objects with the
# NamedTuple field order: source_file, imported_module, import_type,
# raw_line).
#
# The mapping from fixture name -> sourceFile must stay in sync with the
# `cases` array inside `import-parser.test.ts`.
#
# Usage (from anywhere):
#   bash packages/cli/src/topics/pcd/__fixtures__/import-parser/capture.sh

set -euo pipefail

FIXTURES_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$FIXTURES_DIR/../../../../../../.." && pwd)"
PY_CAP="$FIXTURES_DIR/python-captures"

mkdir -p "$PY_CAP"

# fixture-name:source-file
CASES=(
  "python-basic:app.py"
  "python-from:app.py"
  "python-relative:pkg/mod.py"
  "python-multi:app.py"
  "python-inline-comment:app.py"
  "rust-use:src/main.rs"
  "rust-nested-use:src/main.rs"
  "rust-mod:src/lib.rs"
  "go-single:main.go"
  "go-block:main.go"
  "go-aliased:main.go"
  "js-default:app.ts"
  "js-named:app.ts"
  "js-require:app.js"
  "js-dynamic:app.js"
  "js-relative:app.ts"
  "js-side-effect:app.js"
)

for entry in "${CASES[@]}"; do
  name="${entry%%:*}"
  src="${entry##*:}"
  input_path="$PY_CAP/$name.input"
  out_path="$PY_CAP/$name.entries.json"
  if [[ ! -f "$input_path" ]]; then
    echo "missing input: $input_path" >&2
    exit 1
  fi
  python3 - "$src" "$input_path" "$out_path" <<PY
import json
import sys

sys.path.insert(0, "$REPO_ROOT/tools")

from pcd.import_parser import parse_imports  # noqa: E402

src_file = sys.argv[1]
input_path = sys.argv[2]
out_path = sys.argv[3]
with open(input_path, "r", encoding="utf-8") as fh:
    content = fh.read()
entries = parse_imports(src_file, content)
# Preserve NamedTuple field order: source_file, imported_module,
# import_type, raw_line.
payload = [dict(e._asdict()) for e in entries]
with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(payload, fh, indent=2)
    fh.write("\n")
PY
done

echo "wrote $((${#CASES[@]})) python capture pairs to $PY_CAP"
