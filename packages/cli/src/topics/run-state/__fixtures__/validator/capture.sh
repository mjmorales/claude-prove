#!/usr/bin/env bash
# Capture validator-engine parity output against the Python source.
#
# Flow:
#   1. Define a fixed set of inputs (spec + data per case).
#   2. Run tools/run_state/_validator.py over each input -> python-captures/<name>.json
#   3. Run packages/cli/src/topics/run-state/validator-engine.ts over the SAME
#      inputs via a bun inline harness -> ts-captures/<name>.json
#   4. Tests assert ts-captures == python-captures byte-for-byte.
#
# Each capture file is JSON:
#   { "name": "<case>", "errors": ["  ERROR: ...", "  WARN: ..."] }
#
# Rerun after any change to _validator.py or validator-engine.ts:
#   bash packages/cli/src/topics/run-state/__fixtures__/validator/capture.sh

set -euo pipefail

FIXTURES_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$FIXTURES_DIR/../../../../../../.." && pwd)"
PY_CAP="$FIXTURES_DIR/python-captures"
TS_CAP="$FIXTURES_DIR/ts-captures"

mkdir -p "$PY_CAP" "$TS_CAP"

# --- Shared cases --------------------------------------------------------------
# Stored as a JSON array at $cases_file so both Python and TS harnesses read the
# same inputs. Each case: { name, spec, data }.

cases_file="$FIXTURES_DIR/cases.json"
cat > "$cases_file" <<'JSON'
[
  {
    "name": "wrong_type_str",
    "spec": {
      "kind": "t", "version": "1",
      "fields": {
        "title": { "type": "str", "required": true }
      }
    },
    "data": { "title": 42 }
  },
  {
    "name": "wrong_type_int",
    "spec": {
      "kind": "t", "version": "1",
      "fields": {
        "count": { "type": "int", "required": true }
      }
    },
    "data": { "count": "not-int" }
  },
  {
    "name": "wrong_type_list",
    "spec": {
      "kind": "t", "version": "1",
      "fields": {
        "tags": { "type": "list", "required": true, "items": { "type": "str" } }
      }
    },
    "data": { "tags": "nope" }
  },
  {
    "name": "required_missing",
    "spec": {
      "kind": "t", "version": "1",
      "fields": {
        "schema_version": { "type": "str", "required": true },
        "kind": { "type": "str", "required": true },
        "tasks": { "type": "list", "required": true, "items": { "type": "str" } }
      }
    },
    "data": {}
  },
  {
    "name": "enum_mismatch",
    "spec": {
      "kind": "t", "version": "1",
      "fields": {
        "status": { "type": "str", "required": true, "enum": ["pending", "running", "completed", "failed", "halted"] }
      }
    },
    "data": { "status": "weird" }
  },
  {
    "name": "unknown_key",
    "spec": {
      "kind": "t", "version": "1",
      "fields": {
        "title": { "type": "str", "required": true }
      }
    },
    "data": { "title": "ok", "extra": 1 }
  },
  {
    "name": "nested_dict",
    "spec": {
      "kind": "t", "version": "1",
      "fields": {
        "scope": {
          "type": "dict",
          "required": true,
          "fields": {
            "in": { "type": "list", "required": true, "items": { "type": "str" } },
            "out": { "type": "list", "required": true, "items": { "type": "str" } }
          }
        }
      }
    },
    "data": { "scope": { "in": ["a"] } }
  },
  {
    "name": "list_items_descent",
    "spec": {
      "kind": "t", "version": "1",
      "fields": {
        "tasks": {
          "type": "list",
          "required": true,
          "items": {
            "type": "dict",
            "fields": {
              "id": { "type": "str", "required": true },
              "wave": { "type": "int", "required": true }
            }
          }
        }
      }
    },
    "data": { "tasks": [ { "id": "1.1", "wave": 1 }, { "id": "1.2", "wave": "oops" } ] }
  },
  {
    "name": "values_spec_descent",
    "spec": {
      "kind": "t", "version": "1",
      "fields": {
        "map": {
          "type": "dict",
          "required": true,
          "values": { "type": "int" }
        }
      }
    },
    "data": { "map": { "a": 1, "b": "not-int" } }
  },
  {
    "name": "default_preserves_user_value",
    "spec": {
      "kind": "t", "version": "1",
      "fields": {
        "name": { "type": "str", "required": true, "default": "FALLBACK" }
      }
    },
    "data": { "name": "user-provided" }
  },
  {
    "name": "roundtrip_ok",
    "spec": {
      "kind": "t", "version": "1",
      "fields": {
        "id": { "type": "str", "required": true },
        "count": { "type": "int", "required": false, "default": 0 }
      }
    },
    "data": { "id": "x" }
  }
]
JSON

# --- Python side --------------------------------------------------------------

python3 - <<PY
import json, sys
from pathlib import Path

sys.path.insert(0, "$REPO_ROOT")
from tools.run_state._validator import validate_config

cases = json.loads(Path("$cases_file").read_text(encoding="utf-8"))
out_dir = Path("$PY_CAP")
for case in cases:
    errors = validate_config(case["data"], case["spec"])
    payload = {
        "name": case["name"],
        "errors": [str(e) for e in errors],
    }
    (out_dir / f"{case['name']}.txt").write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
print(f"wrote {len(cases)} python captures to {out_dir}")
PY

# --- TypeScript side ----------------------------------------------------------

harness="$FIXTURES_DIR/.harness.ts"
cat > "$harness" <<TS
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateConfig, type Schema } from '$REPO_ROOT/packages/cli/src/topics/run-state/validator-engine';

const casesPath = process.argv[2]!;
const outDir = process.argv[3]!;
const cases = JSON.parse(readFileSync(casesPath, 'utf8')) as Array<{
  name: string;
  spec: Schema;
  data: Record<string, unknown>;
}>;

for (const c of cases) {
  const errors = validateConfig(c.data, c.spec);
  const payload = {
    name: c.name,
    errors: errors.map((e) => e.toString()),
  };
  writeFileSync(
    join(outDir, \`\${c.name}.txt\`),
    \`\${JSON.stringify(payload, null, 2)}\n\`,
    'utf8',
  );
}
console.log(\`wrote \${cases.length} ts captures to \${outDir}\`);
TS

(cd "$REPO_ROOT" && bun run "$harness" "$cases_file" "$TS_CAP")
rm -f "$harness"

echo "validator captures regenerated"
