#!/usr/bin/env bash
# Capture end-to-end CLI parity output between `python3 -m tools.run_state`
# and `bun run packages/cli/bin/run.ts run-state`.
#
# For each scenario in cases.json we drive the SAME subcommand sequence
# against both implementations against a fresh tmpdir, then capture the
# final state.json and any report files written. Tests assert
# python-captures/ == ts-captures/ byte-for-byte.
#
# Timestamps are frozen via PROVE_STATE_FROZEN_NOW so both sides emit
# identical ISO-8601 strings. Python's `utcnow_iso` already reads that
# variable when present; see also state.ts `_clock.now`.
#
# Rerun after any change to the CLI wiring, state.ts, or the Python
# CLI:
#
#   bash packages/cli/src/topics/run-state/__fixtures__/integration/capture.sh

set -euo pipefail

FIXTURES_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$FIXTURES_DIR/../../../../../../.." && pwd)"
PY_CAP="$FIXTURES_DIR/python-captures"
TS_CAP="$FIXTURES_DIR/ts-captures"
CASES="$FIXTURES_DIR/cases.json"

rm -rf "$PY_CAP" "$TS_CAP"
mkdir -p "$PY_CAP" "$TS_CAP"

export PROVE_STATE_FROZEN_NOW="2026-04-22T12:00:00Z"

# Runner written in Python — builds tmp dirs, drives both CLIs, captures.
# Heredoc is QUOTED ('PY') so bash does NOT expand $vars inside; Python
# reads the paths from environment variables we export below.
export RUN_STATE_REPO="$REPO_ROOT"
export RUN_STATE_CASES="$CASES"
export RUN_STATE_PY_CAP="$PY_CAP"
export RUN_STATE_TS_CAP="$TS_CAP"

python3 - <<'PY'
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(os.environ["RUN_STATE_REPO"])
CASES = Path(os.environ["RUN_STATE_CASES"])
PY_CAP = Path(os.environ["RUN_STATE_PY_CAP"])
TS_CAP = Path(os.environ["RUN_STATE_TS_CAP"])

SAMPLE_PLAN = {
    "schema_version": "1",
    "kind": "plan",
    "mode": "simple",
    "tasks": [
        {
            "id": "1.1",
            "title": "First task",
            "wave": 1,
            "deps": [],
            "description": "",
            "acceptance_criteria": [],
            "worktree": {"path": "", "branch": ""},
            "steps": [
                {"id": "1.1.1", "title": "S1", "description": "", "acceptance_criteria": []},
                {"id": "1.1.2", "title": "S2", "description": "", "acceptance_criteria": []},
            ],
        }
    ],
}

SAMPLE_PRD = {
    "schema_version": "1",
    "kind": "prd",
    "title": "Integration Parity",
    "context": "",
    "goals": [],
    "scope": {"in": [], "out": []},
    "acceptance_criteria": [],
    "test_strategy": "",
    "body_markdown": "",
}


PY_WRAPPER = REPO / "packages/cli/src/topics/run-state/__fixtures__/integration/.py_runner.py"
PY_WRAPPER.write_text(
    "import os, sys\n"
    "sys.path.insert(0, os.environ['RUN_STATE_REPO'])\n"
    "import tools.run_state.state as _state\n"
    "_FROZEN = os.environ['PROVE_STATE_FROZEN_NOW']\n"
    "_state.utcnow_iso = lambda: _FROZEN\n"
    "from tools.run_state.__main__ import main\n"
    "main(sys.argv[1:])\n"
)


def py_cmd(args, cwd):
    env = os.environ.copy()
    env["PYTHONPATH"] = str(REPO) + os.pathsep + env.get("PYTHONPATH", "")
    env["RUN_STATE_REPO"] = str(REPO)
    env.pop("PROVE_RUN_SLUG", None)
    env.pop("PROVE_RUN_BRANCH", None)
    return subprocess.run(
        [sys.executable, str(PY_WRAPPER)] + args,
        cwd=str(cwd), env=env, capture_output=True, text=True, check=False,
    )


def ts_cmd(args, cwd):
    env = os.environ.copy()
    env.pop("PROVE_RUN_SLUG", None)
    env.pop("PROVE_RUN_BRANCH", None)
    return subprocess.run(
        ["bun", "run", str(REPO / "packages/cli/bin/run.ts"), "run-state"] + args,
        cwd=str(cwd), env=env, capture_output=True, text=True, check=False,
    )


def drive(ops, cwd, plan_path, prd_path, cmd):
    runs_root = str(cwd / ".prove" / "runs")
    # Python's argparse nests sub-subparsers, so run-selection flags must
    # come BEFORE the action positional (e.g., `step --slug ... start ID`).
    # The TS CLI accepts both orders; using the Python-compatible order
    # here keeps capture.sh agnostic.
    run_sel = ["--branch", "feature", "--slug", "demo", "--runs-root", runs_root]
    for op in ops:
        kind = op["op"]
        if kind == "init":
            r = cmd([
                "init",
                *run_sel,
                "--plan", str(plan_path),
                "--prd", str(prd_path),
            ], cwd)
            if r.returncode != 0:
                raise RuntimeError(f"init failed: {r.stderr}")
        elif kind == "step":
            cli = ["step", *run_sel, op["action"], op["step_id"]]
            if op.get("commit"):
                cli += ["--commit", op["commit"]]
            if op.get("reason"):
                cli += ["--reason", op["reason"]]
            cmd(cli, cwd)
        elif kind == "validator_set":
            cmd([
                "validator", *run_sel, "set", op["step_id"], op["phase"], op["status"],
            ], cwd)
        elif kind == "task_review":
            cli = ["task", *run_sel, "review", op["task_id"], "--verdict", op["verdict"]]
            if op.get("reviewer"):
                cli += ["--reviewer", op["reviewer"]]
            if op.get("notes"):
                cli += ["--notes", op["notes"]]
            cmd(cli, cwd)
        elif kind == "dispatch_record":
            cmd(["dispatch", *run_sel, "record", op["key"], op["event"]], cwd)
        elif kind == "report_write":
            cli = ["report", *run_sel, "write", op["step_id"], "--status", op["status"]]
            if op.get("commit"):
                cli += ["--commit", op["commit"]]
            cmd(cli, cwd)
        else:
            raise RuntimeError(f"unknown op {kind}")


def capture_scenario(name, ops, cap_root, cmd):
    cwd = Path(tempfile.mkdtemp(prefix=f"int-{name}-"))
    # .git stops slug autodetect at the right root
    (cwd / ".git").mkdir()
    plan_path = cwd / "plan.json"
    plan_path.write_text(json.dumps(SAMPLE_PLAN, indent=2) + "\n")
    prd_path = cwd / "prd.json"
    prd_path.write_text(json.dumps(SAMPLE_PRD, indent=2) + "\n")
    drive(ops, cwd, plan_path, prd_path, cmd)

    out = cap_root / name
    out.mkdir(parents=True, exist_ok=True)
    run_dir = cwd / ".prove" / "runs" / "feature" / "demo"
    if (run_dir / "state.json").exists():
        shutil.copy(run_dir / "state.json", out / "state.json")
    reports_dir = run_dir / "reports"
    if reports_dir.exists():
        (out / "reports").mkdir(exist_ok=True)
        for p in sorted(reports_dir.glob("*.json")):
            shutil.copy(p, out / "reports" / p.name)
    shutil.rmtree(cwd, ignore_errors=True)


scenarios = json.loads(CASES.read_text())
try:
    for name, ops in scenarios.items():
        capture_scenario(name, ops, PY_CAP, py_cmd)
        capture_scenario(name, ops, TS_CAP, ts_cmd)
finally:
    try:
        PY_WRAPPER.unlink()
    except FileNotFoundError:
        pass

print(f"captured {len(scenarios)} integration scenarios")
PY

echo "integration captures regenerated"
