#!/usr/bin/env bash
# init-config.sh — Detect project tech stack and output .claude/.prove.json
#
# Usage: init-config.sh [--merge] [project-root]
#
# Outputs JSON to stdout.
#   --merge: If .claude/.prove.json exists in project-root, replace only the
#            validators section and preserve all other sections (scopes,
#            reporters, index, etc.)

set -euo pipefail

MERGE=false
PROJECT_ROOT="."

while [[ $# -gt 0 ]]; do
  case "$1" in
    --merge) MERGE=true; shift ;;
    *)       PROJECT_ROOT="$1"; shift ;;
  esac
done

validators="[]"

add_validator() {
  local name="$1" command="$2" phase="$3"
  validators=$(printf '%s' "$validators" | python3 -c "
import json, sys
v = json.load(sys.stdin)
v.append({'name': '$name', 'command': '$command', 'phase': '$phase'})
json.dump(v, sys.stdout)
")
}

# Go
if [[ -f "$PROJECT_ROOT/go.mod" ]]; then
  add_validator "build" "go build ./..." "build"
  add_validator "lint" "go vet ./..." "lint"
  add_validator "tests" "go test ./..." "test"
fi

# Rust
if [[ -f "$PROJECT_ROOT/Cargo.toml" ]]; then
  add_validator "check" "cargo check" "build"
  add_validator "clippy" "cargo clippy -- -D warnings" "lint"
  add_validator "tests" "cargo test" "test"
fi

# Python
if [[ -f "$PROJECT_ROOT/pyproject.toml" ]] || [[ -f "$PROJECT_ROOT/setup.py" ]] || [[ -f "$PROJECT_ROOT/requirements.txt" ]]; then
  if command -v ruff &>/dev/null; then
    add_validator "lint" "ruff check ." "lint"
  elif command -v mypy &>/dev/null; then
    add_validator "lint" "mypy ." "lint"
  fi
  add_validator "tests" "pytest" "test"
fi

# Node/TypeScript
if [[ -f "$PROJECT_ROOT/package.json" ]]; then
  if [[ -f "$PROJECT_ROOT/tsconfig.json" ]]; then
    add_validator "build" "tsc --noEmit" "build"
  fi
  if [[ -f "$PROJECT_ROOT/.eslintrc.json" ]] || [[ -f "$PROJECT_ROOT/.eslintrc.js" ]] || [[ -f "$PROJECT_ROOT/eslint.config.js" ]] || [[ -f "$PROJECT_ROOT/eslint.config.mjs" ]]; then
    add_validator "lint" "npx eslint ." "lint"
  fi
  add_validator "tests" "npm test" "test"
fi

# Godot/GDScript
if [[ -f "$PROJECT_ROOT/project.godot" ]]; then
  if [[ -d "$PROJECT_ROOT/addons/gut" ]]; then
    add_validator "tests" "godot --headless -s addons/gut/gut_cmdln.gd" "test"
  fi
fi

# Makefile fallback
if [[ -f "$PROJECT_ROOT/Makefile" ]]; then
  if grep -q '^test:' "$PROJECT_ROOT/Makefile" 2>/dev/null; then
    # Only add if no test validator detected yet
    if ! printf '%s' "$validators" | python3 -c "import json,sys; v=json.load(sys.stdin); exit(0 if any(x['phase']=='test' for x in v) else 1)" 2>/dev/null; then
      add_validator "tests" "make test" "test"
    fi
  fi
  if grep -q '^lint:' "$PROJECT_ROOT/Makefile" 2>/dev/null; then
    if ! printf '%s' "$validators" | python3 -c "import json,sys; v=json.load(sys.stdin); exit(0 if any(x['phase']=='lint' for x in v) else 1)" 2>/dev/null; then
      add_validator "lint" "make lint" "lint"
    fi
  fi
fi

# Output final JSON
PROVE_JSON="$PROJECT_ROOT/.claude/.prove.json"

if $MERGE && [[ -f "$PROVE_JSON" ]]; then
  # Merge: replace validators in existing config, preserve everything else
  python3 -c "
import json, sys

with open(sys.argv[1]) as f:
    config = json.load(f)

config['validators'] = json.loads(sys.argv[2])
print(json.dumps(config, indent=2))
" "$PROVE_JSON" "$validators"
else
  python3 -c "
import json, sys
validators = json.loads(sys.argv[1])
config = {'validators': validators}
print(json.dumps(config, indent=2))
" "$validators"
fi
