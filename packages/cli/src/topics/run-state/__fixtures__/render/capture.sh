#!/usr/bin/env bash
# Capture render parity output against the Python source.
#
# Flow:
#   1. cases.json maps each named case to (view, format, input, plan?).
#   2. Run tools/run_state/render.py functions for every case -> python-captures/<name>.<format>
#   3. Run packages/cli/src/topics/run-state/render.ts for every case via bun -> ts-captures/<name>.<format>
#   4. Tests assert python-captures == ts-captures byte-for-byte per file.
#
# Rerun after any change to render.py or render.ts:
#   bash packages/cli/src/topics/run-state/__fixtures__/render/capture.sh

set -euo pipefail

FIXTURES_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$FIXTURES_DIR/../../../../../../.." && pwd)"
CASES_DIR="$FIXTURES_DIR/cases"
CASES_FILE="$FIXTURES_DIR/cases.json"
PY_CAP="$FIXTURES_DIR/python-captures"
TS_CAP="$FIXTURES_DIR/ts-captures"

rm -rf "$PY_CAP" "$TS_CAP"
mkdir -p "$PY_CAP" "$TS_CAP"

# --- Python side -------------------------------------------------------------

python3 - <<PY
import json, sys
from pathlib import Path

sys.path.insert(0, "$REPO_ROOT")
from tools.run_state import render as render_mod

cases_dir = Path("$CASES_DIR")
cases = json.loads(Path("$CASES_FILE").read_text(encoding="utf-8"))
out_dir = Path("$PY_CAP")

for case in cases:
    name = case["name"]
    view = case["view"]
    fmt = case["format"]
    inp = json.loads((cases_dir / case["input"]).read_text(encoding="utf-8"))
    plan = None
    if "plan" in case:
        plan = json.loads((cases_dir / case["plan"]).read_text(encoding="utf-8"))

    if fmt == "json":
        # Mirror cmd_show / cmd_current JSON path: print(json.dumps(data, indent=2))
        # -> stringified with trailing newline from print().
        output = json.dumps(inp, indent=2) + "\n"
    elif view == "prd":
        output = render_mod.render_prd(inp)
    elif view == "plan":
        output = render_mod.render_plan(inp)
    elif view == "state":
        output = render_mod.render_state(inp, plan=plan)
    elif view == "report":
        output = render_mod.render_report(inp)
    elif view == "summary":
        output = render_mod.render_summary(inp, plan=plan)
    elif view == "current":
        # cmd_current text branch delegates to render_summary.
        output = render_mod.render_summary(inp, plan=plan)
    else:
        raise RuntimeError(f"unknown view: {view}")

    # JSON captures use .txt to avoid biome re-formatting fixture outputs.
    # Markdown captures keep .md.
    ext = "md" if fmt == "md" else "txt"
    (out_dir / f"{name}.{ext}").write_text(output, encoding="utf-8")

print(f"wrote {len(cases)} python captures to {out_dir}")
PY

# --- TypeScript side ---------------------------------------------------------

harness="$FIXTURES_DIR/.harness.ts"
cat > "$harness" <<TS
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  renderCurrent,
  renderPlan,
  renderPrd,
  renderReport,
  renderState,
  renderSummary,
} from '$REPO_ROOT/packages/cli/src/topics/run-state/render';

const casesDir = process.argv[2]!;
const casesFile = process.argv[3]!;
const outDir = process.argv[4]!;
const cases = JSON.parse(readFileSync(casesFile, 'utf8')) as Array<{
  name: string;
  view: 'prd' | 'plan' | 'state' | 'report' | 'summary' | 'current';
  format: 'md' | 'json';
  input: string;
  plan?: string;
}>;

for (const c of cases) {
  const input = JSON.parse(readFileSync(join(casesDir, c.input), 'utf8'));
  const plan = c.plan ? JSON.parse(readFileSync(join(casesDir, c.plan), 'utf8')) : null;

  let output: string;
  if (c.view === 'prd') {
    output = renderPrd(input, { format: c.format });
  } else if (c.view === 'plan') {
    output = renderPlan(input, { format: c.format });
  } else if (c.view === 'state') {
    output = renderState(input, { format: c.format, plan });
  } else if (c.view === 'report') {
    output = renderReport(input, { format: c.format });
  } else if (c.view === 'summary') {
    output = renderSummary(input, { plan });
  } else if (c.view === 'current') {
    output = renderCurrent(input, { format: c.format, plan });
  } else {
    throw new Error(\`unknown view: \${(c as { view: string }).view}\`);
  }

  // JSON captures use .txt to avoid biome re-formatting fixture outputs.
  const ext = c.format === 'md' ? 'md' : 'txt';
  writeFileSync(join(outDir, \`\${c.name}.\${ext}\`), output, 'utf8');
}

console.log(\`wrote \${cases.length} ts captures to \${outDir}\`);
TS

(cd "$REPO_ROOT" && bun run "$harness" "$CASES_DIR" "$CASES_FILE" "$TS_CAP")
rm -f "$harness"

echo "render captures regenerated"
