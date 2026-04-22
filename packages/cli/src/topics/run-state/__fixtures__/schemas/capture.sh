#!/usr/bin/env bash
# Capture schema parity output against the Python source.
#
# Each case passes a real run-state payload through the Python
# tools.run_state.validate.validate_data function and through the TS
# validateData. Captured shape:
#
#   { "name": "<case>", "kind": "<kind>", "ok": bool, "errors": ["..."] }
#
# The Python wrapper returns a list[ValidationError]; this harness wraps
# it in the same {ok, kind, version, errors} envelope the TS port uses so
# the two captures are directly comparable.
#
# Rerun after schemas.py or schemas.ts change:
#   bash packages/cli/src/topics/run-state/__fixtures__/schemas/capture.sh

set -euo pipefail

FIXTURES_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$FIXTURES_DIR/../../../../../../.." && pwd)"
PY_CAP="$FIXTURES_DIR/python-captures"
TS_CAP="$FIXTURES_DIR/ts-captures"

mkdir -p "$PY_CAP" "$TS_CAP"

cases_file="$FIXTURES_DIR/cases.json"
cat > "$cases_file" <<'JSON'
[
  {
    "name": "prd_valid",
    "kind": "prd",
    "data": {
      "schema_version": "1",
      "kind": "prd",
      "title": "Port run_state to TS"
    }
  },
  {
    "name": "prd_missing_title",
    "kind": "prd",
    "data": {
      "schema_version": "1",
      "kind": "prd"
    }
  },
  {
    "name": "plan_valid_minimal",
    "kind": "plan",
    "data": {
      "schema_version": "1",
      "kind": "plan",
      "tasks": [
        {
          "id": "1.1",
          "title": "t",
          "wave": 1,
          "steps": [
            { "id": "1.1.1", "title": "first step" }
          ]
        }
      ]
    }
  },
  {
    "name": "plan_wave_wrong_type",
    "kind": "plan",
    "data": {
      "schema_version": "1",
      "kind": "plan",
      "tasks": [
        {
          "id": "1.1",
          "title": "t",
          "wave": "not-int",
          "steps": []
        }
      ]
    }
  },
  {
    "name": "state_valid_empty_tasks",
    "kind": "state",
    "data": {
      "schema_version": "1",
      "kind": "state",
      "run_status": "pending",
      "slug": "x",
      "updated_at": "2026-04-22T00:00:00Z",
      "tasks": []
    }
  },
  {
    "name": "state_bad_run_status",
    "kind": "state",
    "data": {
      "schema_version": "1",
      "kind": "state",
      "run_status": "weird",
      "slug": "x",
      "updated_at": "2026-04-22T00:00:00Z",
      "tasks": []
    }
  },
  {
    "name": "state_dispatch_missing_fields",
    "kind": "state",
    "data": {
      "schema_version": "1",
      "kind": "state",
      "run_status": "pending",
      "slug": "x",
      "updated_at": "2026-04-22T00:00:00Z",
      "tasks": [],
      "dispatch": { "dispatched": [ { "event": "step-complete" } ] }
    }
  },
  {
    "name": "report_valid_minimal",
    "kind": "report",
    "data": {
      "schema_version": "1",
      "kind": "report",
      "step_id": "1.1.1",
      "task_id": "1.1",
      "status": "completed"
    }
  },
  {
    "name": "report_bad_status",
    "kind": "report",
    "data": {
      "schema_version": "1",
      "kind": "report",
      "step_id": "1.1.1",
      "task_id": "1.1",
      "status": "definitely-not-a-status"
    }
  },
  {
    "name": "unknown_kind",
    "kind": "nonexistent",
    "data": { "x": 1 }
  }
]
JSON

# --- Python side --------------------------------------------------------------

python3 - <<PY
import json, sys
from pathlib import Path

sys.path.insert(0, "$REPO_ROOT")
from tools.run_state import CURRENT_SCHEMA_VERSION
from tools.run_state.schemas import SCHEMA_BY_KIND
from tools.run_state.validate import validate_data

cases = json.loads(Path("$cases_file").read_text(encoding="utf-8"))
out_dir = Path("$PY_CAP")
for case in cases:
    errors = validate_data(case["data"], case["kind"])
    hard = [e for e in errors if e.severity == "error"]
    if case["kind"] in SCHEMA_BY_KIND:
        version = SCHEMA_BY_KIND[case["kind"]]["version"]
    else:
        version = CURRENT_SCHEMA_VERSION
    payload = {
        "name": case["name"],
        "kind": case["kind"],
        "version": version,
        "ok": len(hard) == 0,
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
import { validateData } from '$REPO_ROOT/packages/cli/src/topics/run-state/validate';

const casesPath = process.argv[2]!;
const outDir = process.argv[3]!;
const cases = JSON.parse(readFileSync(casesPath, 'utf8')) as Array<{
  name: string;
  kind: string;
  data: unknown;
}>;

for (const c of cases) {
  const r = validateData(c.data, c.kind);
  const payload = {
    name: c.name,
    kind: r.kind,
    version: r.version,
    ok: r.ok,
    errors: r.errors,
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

echo "schemas captures regenerated"
