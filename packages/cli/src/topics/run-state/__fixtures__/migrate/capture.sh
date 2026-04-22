#!/usr/bin/env bash
# Capture legacy-md → JSON parity output against the Python source.
#
# Each case feeds a fixed markdown corpus through both migrate engines
# (tools/run_state/migrate.py and packages/cli/src/topics/run-state/migrate.ts)
# and writes an envelope-shaped JSON capture:
#
#   { "name": "<case>", "artifact": "<prd|plan|state>", "data": <migrated> }
#
# The migrate.test.ts parity block reads python-captures/<case>.json and
# asserts byte equality against the TS side for every case. Rerun after
# migrate.py or migrate.ts change:
#
#   bash packages/cli/src/topics/run-state/__fixtures__/migrate/capture.sh

set -euo pipefail

FIXTURES_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$FIXTURES_DIR/../../../../../../.." && pwd)"
PY_CAP="$FIXTURES_DIR/python-captures"
TS_CAP="$FIXTURES_DIR/ts-captures"

mkdir -p "$PY_CAP" "$TS_CAP"

FROZEN_TS="2026-04-22T00:00:00Z"

# --- Python side --------------------------------------------------------------

python3 - <<PY
import json, sys
from pathlib import Path

sys.path.insert(0, "$REPO_ROOT")

# Freeze the clock BEFORE importing the module that captures utcnow_iso.
import tools.run_state.state as state_mod
state_mod.utcnow_iso = lambda: "$FROZEN_TS"

from tools.run_state.migrate import (
    parse_prd_md,
    parse_plan_md,
    derive_state_from_progress,
)
# migrate.py binds utcnow_iso at import — rebind in both modules.
import tools.run_state.migrate as migrate_mod
migrate_mod.utcnow_iso = lambda: "$FROZEN_TS"
from tools.run_state.state import new_prd, new_plan, new_state

PRD_MD = """# Example PRD

## Context

Reasons for this run.

## Goals

- Deliver A
- Deliver B

## Scope

### In
- foo
- bar

## Acceptance Criteria

- All tests pass
- No regressions

## Test Strategy

Run pytest and manually verify edge cases.
"""

PLAN_MD = """# Task Plan: Example

## Implementation Steps

### Task 1.1: First task

**Worktree:** /tmp/wt1
**Branch:** orch/demo-1

Do the first thing.

#### Step 1.1.1: Edit files
Edit the files.

#### Step 1.1.2: Run tests
Run the tests.

### Task 2.1: Second task

**Worktree:** /tmp/wt2

Do the second thing (single implicit step).
"""

PROGRESS_MD = """# Progress

- [x] Task 1.1: First task
- [~] Task 2.1: Second task
"""

PROGRESS_ALL_MD = "# Progress\n- [x] Task 1.1\n- [x] Task 2.1\n"

cases = []

cases.append({
    "name": "prd_from_md",
    "artifact": "prd",
    "data": parse_prd_md(PRD_MD),
})

cases.append({
    "name": "plan_from_md",
    "artifact": "plan",
    "data": parse_plan_md(PLAN_MD),
})

plan = parse_plan_md(PLAN_MD)
cases.append({
    "name": "state_from_progress",
    "artifact": "state",
    "data": derive_state_from_progress(PROGRESS_MD, plan, slug="demo", branch="feature"),
})

plan2 = parse_plan_md(PLAN_MD)
cases.append({
    "name": "state_all_completed",
    "artifact": "state",
    "data": derive_state_from_progress(PROGRESS_ALL_MD, plan2, slug="demo", branch="feature"),
})

cases.append({
    "name": "new_prd_defaults",
    "artifact": "prd",
    "data": new_prd(title="Seed title"),
})

cases.append({
    "name": "new_plan_empty",
    "artifact": "plan",
    "data": new_plan(tasks=[], mode="simple"),
})

empty_plan = new_plan(tasks=[], mode="simple")
cases.append({
    "name": "new_state_empty_plan",
    "artifact": "state",
    "data": new_state(slug="s", branch="b", plan=empty_plan),
})

out_dir = Path("$PY_CAP")
for case in cases:
    text = json.dumps(case, indent=2, ensure_ascii=False) + "\n"
    (out_dir / f"{case['name']}.json").write_text(text, encoding="utf-8")

print(f"wrote {len(cases)} python captures to {out_dir}")
PY

# --- TypeScript side ----------------------------------------------------------

harness="$FIXTURES_DIR/.harness.ts"
cat > "$harness" <<TS
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  _clock,
  parsePrdMd,
  parsePlanMd,
  deriveStateFromProgress,
  newPrd,
  newPlan,
  newState,
} from '$REPO_ROOT/packages/cli/src/topics/run-state/migrate';

_clock.now = () => '$FROZEN_TS';

const PRD_MD = \`# Example PRD

## Context

Reasons for this run.

## Goals

- Deliver A
- Deliver B

## Scope

### In
- foo
- bar

## Acceptance Criteria

- All tests pass
- No regressions

## Test Strategy

Run pytest and manually verify edge cases.
\`;

const PLAN_MD = \`# Task Plan: Example

## Implementation Steps

### Task 1.1: First task

**Worktree:** /tmp/wt1
**Branch:** orch/demo-1

Do the first thing.

#### Step 1.1.1: Edit files
Edit the files.

#### Step 1.1.2: Run tests
Run the tests.

### Task 2.1: Second task

**Worktree:** /tmp/wt2

Do the second thing (single implicit step).
\`;

const PROGRESS_MD = \`# Progress

- [x] Task 1.1: First task
- [~] Task 2.1: Second task
\`;

const PROGRESS_ALL_MD = \`# Progress\n- [x] Task 1.1\n- [x] Task 2.1\n\`;

const outDir = process.argv[2]!;

const plan = parsePlanMd(PLAN_MD);
const plan2 = parsePlanMd(PLAN_MD);
const emptyPlan = newPlan([], 'simple');

const cases = [
  { name: 'prd_from_md', artifact: 'prd', data: parsePrdMd(PRD_MD) },
  { name: 'plan_from_md', artifact: 'plan', data: parsePlanMd(PLAN_MD) },
  {
    name: 'state_from_progress',
    artifact: 'state',
    data: deriveStateFromProgress(PROGRESS_MD, plan, 'demo', 'feature'),
  },
  {
    name: 'state_all_completed',
    artifact: 'state',
    data: deriveStateFromProgress(PROGRESS_ALL_MD, plan2, 'demo', 'feature'),
  },
  { name: 'new_prd_defaults', artifact: 'prd', data: newPrd('Seed title') },
  { name: 'new_plan_empty', artifact: 'plan', data: newPlan([], 'simple') },
  {
    name: 'new_state_empty_plan',
    artifact: 'state',
    data: newState('s', 'b', emptyPlan),
  },
];

for (const c of cases) {
  writeFileSync(
    join(outDir, \`\${c.name}.json\`),
    \`\${JSON.stringify(c, null, 2)}\n\`,
    'utf8',
  );
}
console.log(\`wrote \${cases.length} ts captures to \${outDir}\`);
TS

(cd "$REPO_ROOT" && bun run "$harness" "$TS_CAP")
rm -f "$harness"

echo "migrate captures regenerated"
