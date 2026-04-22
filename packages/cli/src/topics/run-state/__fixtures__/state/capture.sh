#!/usr/bin/env bash
# Capture state-engine parity output against the Python source.
#
# Flow:
#   1. Define a fixed set of mutator sequences (one per named scenario).
#   2. Run tools/run_state/state.py through each sequence -> python-captures/<name>/
#   3. Run packages/cli/src/topics/run-state/state.ts through the SAME sequence
#      via a bun inline harness -> ts-captures/<name>/
#   4. Tests assert python-captures == ts-captures byte-for-byte per file.
#
# Both sides freeze time via PROVE_STATE_FROZEN_NOW so timestamps match.
#
# Rerun after any change to state.py or state.ts:
#   bash packages/cli/src/topics/run-state/__fixtures__/state/capture.sh

set -euo pipefail

FIXTURES_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$FIXTURES_DIR/../../../../../../.." && pwd)"
PY_CAP="$FIXTURES_DIR/python-captures"
TS_CAP="$FIXTURES_DIR/ts-captures"

rm -rf "$PY_CAP" "$TS_CAP"
mkdir -p "$PY_CAP" "$TS_CAP"

export PROVE_STATE_FROZEN_NOW="2026-04-22T12:00:00Z"

# Shared sequence specifications. Each scenario runs the SAME list of
# mutator calls on both sides; we capture state.json, every report, and
# any error string raised.
sequences_file="$FIXTURES_DIR/sequences.json"
# sequences.json is the shared input; biome formatter owns its on-disk shape.
# We keep the authoritative copy committed and only rewrite it here if missing.
if [ ! -f "$sequences_file" ]; then
  echo "error: $sequences_file missing — commit the canonical sequences fixture" >&2
  exit 1
fi

# --- Python side --------------------------------------------------------

python3 - <<PY
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, "$REPO_ROOT")

import tools.run_state.state as state_mod
from tools.run_state.state import (
    RunPaths, StateError,
    init_run, new_plan, new_prd,
    load_state, start_step, complete_step, fail_step, halt_step,
    set_validator, review_task, record_dispatch, has_dispatched,
    write_report,
)

# Freeze time across the whole module
FROZEN = os.environ["PROVE_STATE_FROZEN_NOW"]
state_mod.utcnow_iso = lambda: FROZEN

def sample_plan():
    return new_plan(tasks=[
        {
            "id": "1.1", "title": "First task", "wave": 1, "deps": [],
            "description": "", "acceptance_criteria": [],
            "worktree": {"path": "", "branch": ""},
            "steps": [
                {"id": "1.1.1", "title": "S1", "description": "", "acceptance_criteria": []},
                {"id": "1.1.2", "title": "S2", "description": "", "acceptance_criteria": []},
            ],
        }
    ], mode="simple")

sequences = json.loads(Path("$sequences_file").read_text(encoding="utf-8"))
root_out = Path("$PY_CAP")

for name, ops in sequences.items():
    tmp = Path(tempfile.mkdtemp(prefix=f"state-py-{name}-"))
    out_dir = root_out / name
    out_dir.mkdir(parents=True, exist_ok=True)
    errors = []
    returns = []
    paths = None

    for op in ops:
        kind = op["op"]
        try:
            if kind == "init":
                paths = init_run(tmp / "runs", "feature", "demo", sample_plan(), prd=new_prd("Demo"))
            elif kind == "stepStart":
                start_step(paths, op["step_id"])
            elif kind == "stepComplete":
                complete_step(paths, op["step_id"], commit_sha=op.get("commit_sha", ""))
            elif kind == "stepFail":
                fail_step(paths, op["step_id"], reason=op.get("reason", ""))
            elif kind == "stepHalt":
                halt_step(paths, op["step_id"], reason=op.get("reason", ""))
            elif kind == "validatorSet":
                set_validator(paths, op["step_id"], op["phase"], op["status"])
            elif kind == "taskReview":
                review_task(paths, op["task_id"], verdict=op["verdict"],
                            notes=op.get("notes", ""), reviewer=op.get("reviewer", ""))
            elif kind == "dispatchRecord":
                ret = record_dispatch(paths, op["key"], op["event"])
                returns.append({"op": "dispatchRecord", "key": op["key"], "ret": ret})
            elif kind == "dispatchHas":
                ret = has_dispatched(paths, op["key"])
                returns.append({"op": "dispatchHas", "key": op["key"], "ret": ret})
            elif kind == "reportWrite":
                write_report(paths, op["report"])
            else:
                raise RuntimeError(f"unknown op {kind}")
        except StateError as e:
            errors.append({"op": kind, "message": str(e)})
            if "expect_error" not in op:
                raise

    # Capture state.json (may be absent if init failed)
    if paths and paths.state.exists():
        (out_dir / "state.json").write_bytes(paths.state.read_bytes())
    # Capture every report file
    if paths and paths.reports_dir.exists():
        reports_out = out_dir / "reports"
        reports_out.mkdir(exist_ok=True)
        for p in sorted(paths.reports_dir.glob("*.json")):
            (reports_out / p.name).write_bytes(p.read_bytes())
    # Capture returns + errors in a deterministic sidecar
    sidecar = {"returns": returns, "errors": errors}
    (out_dir / "sidecar.json").write_text(
        json.dumps(sidecar, indent=2, sort_keys=False) + "\n",
        encoding="utf-8",
    )

print(f"wrote {len(sequences)} python captures to {root_out}")
PY

# --- TypeScript side ---------------------------------------------------

harness="$FIXTURES_DIR/.harness.ts"
cat > "$harness" <<TS
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import {
  initRun, newPlan, newPrd,
  stepStart, stepComplete, stepFail, stepHalt,
  validatorSet, taskReview,
  dispatchRecord, dispatchHas,
  reportWrite,
  StateError,
} from '$REPO_ROOT/packages/cli/src/topics/run-state/state';

const sequencesPath = process.argv[2]!;
const outRoot = process.argv[3]!;
const sequences = JSON.parse(readFileSync(sequencesPath, 'utf8')) as Record<string, any[]>;

function samplePlan() {
  return newPlan(
    [
      {
        id: '1.1', title: 'First task', wave: 1, deps: [],
        description: '', acceptance_criteria: [],
        worktree: { path: '', branch: '' },
        steps: [
          { id: '1.1.1', title: 'S1', description: '', acceptance_criteria: [] },
          { id: '1.1.2', title: 'S2', description: '', acceptance_criteria: [] },
        ],
      },
    ],
    'simple',
  );
}

for (const [name, ops] of Object.entries(sequences)) {
  const tmp = mkdtempSync(join(tmpdir(), \`state-ts-\${name}-\`));
  const outDir = join(outRoot, name);
  mkdirSync(outDir, { recursive: true });
  const errors: Array<{ op: string; message: string }> = [];
  const returns: Array<Record<string, unknown>> = [];
  let paths: any = null;

  for (const op of ops) {
    const kind = op.op as string;
    try {
      if (kind === 'init') {
        paths = initRun(join(tmp, 'runs'), 'feature', 'demo', samplePlan(), { prd: newPrd('Demo') });
      } else if (kind === 'stepStart') {
        stepStart(paths, op.step_id);
      } else if (kind === 'stepComplete') {
        stepComplete(paths, op.step_id, { commitSha: op.commit_sha ?? '' });
      } else if (kind === 'stepFail') {
        stepFail(paths, op.step_id, { reason: op.reason ?? '' });
      } else if (kind === 'stepHalt') {
        stepHalt(paths, op.step_id, { reason: op.reason ?? '' });
      } else if (kind === 'validatorSet') {
        validatorSet(paths, op.step_id, op.phase, op.status);
      } else if (kind === 'taskReview') {
        taskReview(paths, op.task_id, {
          verdict: op.verdict,
          notes: op.notes ?? '',
          reviewer: op.reviewer ?? '',
        });
      } else if (kind === 'dispatchRecord') {
        const ret = dispatchRecord(paths, op.key, op.event);
        returns.push({ op: 'dispatchRecord', key: op.key, ret });
      } else if (kind === 'dispatchHas') {
        const ret = dispatchHas(paths, op.key);
        returns.push({ op: 'dispatchHas', key: op.key, ret });
      } else if (kind === 'reportWrite') {
        reportWrite(paths, op.report);
      } else {
        throw new Error(\`unknown op \${kind}\`);
      }
    } catch (e) {
      if (e instanceof StateError) {
        errors.push({ op: kind, message: e.message });
        if (!('expect_error' in op)) throw e;
      } else {
        throw e;
      }
    }
  }

  if (paths && existsSync(paths.state)) {
    copyFileSync(paths.state, join(outDir, 'state.json'));
  }
  if (paths && existsSync(paths.reports_dir)) {
    const reportsOut = join(outDir, 'reports');
    mkdirSync(reportsOut, { recursive: true });
    for (const n of readdirSync(paths.reports_dir).sort()) {
      if (!n.endsWith('.json')) continue;
      copyFileSync(join(paths.reports_dir, n), join(reportsOut, n));
    }
  }
  writeFileSync(
    join(outDir, 'sidecar.json'),
    \`\${JSON.stringify({ returns, errors }, null, 2)}\n\`,
    'utf8',
  );
}

console.log(\`wrote \${Object.keys(sequences).length} ts captures to \${outRoot}\`);
TS

(cd "$REPO_ROOT" && bun run "$harness" "$sequences_file" "$TS_CAP")
rm -f "$harness"

echo "state captures regenerated"
