#!/usr/bin/env bash
# Capture hook parity between Python (`tools/run_state/hook_*.py`) and the
# TS port (`packages/cli/bin/run.ts run-state hook <event>`).
#
# For each case in cases.json:
#   1. Build a fresh tmpdir and render the optional `setup.write_file` into
#      it (the `PROJECT` placeholder is substituted with the tmpdir path).
#   2. Substitute `PROJECT` placeholders in the payload too.
#   3. Pipe the payload into the Python hook, capture stdout/stderr/exit.
#   4. Repeat against the TS hook.
#   5. Write the three capture files into python-captures/<name>/ and
#      ts-captures/<name>/. Tests assert byte-equality.
#
# Rerun after any change that affects hook I/O:
#   bash packages/cli/src/topics/run-state/__fixtures__/hooks/capture.sh

set -euo pipefail

FIXTURES_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$FIXTURES_DIR/../../../../../../.." && pwd)"
PY_CAP="$FIXTURES_DIR/python-captures"
TS_CAP="$FIXTURES_DIR/ts-captures"
CASES="$FIXTURES_DIR/cases.json"

rm -rf "$PY_CAP" "$TS_CAP"
mkdir -p "$PY_CAP" "$TS_CAP"

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

HOOK_TO_PY_SCRIPT = {
    "guard": "hook_guard.py",
    "validate": "hook_validate.py",
    "session-start": "hook_session_start.py",
    "stop": "hook_stop.py",
    "subagent-stop": "hook_subagent_stop.py",
}


def substitute(value, project):
    if isinstance(value, str):
        return value.replace("PROJECT", str(project))
    if isinstance(value, list):
        return [substitute(v, project) for v in value]
    if isinstance(value, dict):
        return {k: substitute(v, project) for k, v in value.items()}
    return value


def write_setup(setup, project):
    if not setup:
        return
    write_file = setup.get("write_file")
    content_json = setup.get("content_json")
    if write_file and content_json is not None:
        target = Path(substitute(write_file, project))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(content_json))


def run_py(event, stdin_bytes, project):
    script = REPO / "tools" / "run_state" / HOOK_TO_PY_SCRIPT[event]
    env = os.environ.copy()
    env["PYTHONPATH"] = str(REPO) + os.pathsep + env.get("PYTHONPATH", "")
    env["CLAUDE_PROJECT_DIR"] = str(project)
    env.pop("RUN_STATE_ALLOW_DIRECT", None)
    return subprocess.run(
        [sys.executable, str(script)],
        input=stdin_bytes,
        capture_output=True,
        env=env,
        check=False,
    )


def run_ts(event, stdin_bytes, project):
    env = os.environ.copy()
    env["CLAUDE_PROJECT_DIR"] = str(project)
    env.pop("RUN_STATE_ALLOW_DIRECT", None)
    return subprocess.run(
        [
            "bun",
            "run",
            str(REPO / "packages/cli/bin/run.ts"),
            "run-state",
            "hook",
            event,
        ],
        input=stdin_bytes,
        capture_output=True,
        env=env,
        check=False,
    )


def capture(case_name, spec, cap_root, runner, project):
    # Clean previous run's setup so both runners see an identical starting state.
    shutil.rmtree(project, ignore_errors=True)
    project.mkdir(parents=True)
    write_setup(spec.get("setup"), project)

    if "raw_stdin" in spec:
        stdin_bytes = spec["raw_stdin"].encode("utf-8")
    else:
        payload = substitute(spec["payload"], project)
        stdin_bytes = json.dumps(payload).encode("utf-8")

    result = runner(spec["hook"], stdin_bytes, project)

    out_dir = cap_root / case_name
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "stdout").write_bytes(result.stdout)
    (out_dir / "stderr").write_bytes(result.stderr)
    (out_dir / "exit").write_text(str(result.returncode) + "\n")


# Single shared tmpdir per case so the PROJECT placeholder resolves to the
# same path for both Python and TS runs. Required for byte-parity on any
# payload that embeds the file_path.
cases = json.loads(CASES.read_text())
shared_tmp_root = Path(tempfile.mkdtemp(prefix="hook-cap-"))
try:
    for name, spec in cases.items():
        project = shared_tmp_root / name.replace("/", "__")
        capture(name, spec, PY_CAP, run_py, project)
        capture(name, spec, TS_CAP, run_ts, project)
finally:
    shutil.rmtree(shared_tmp_root, ignore_errors=True)

print(f"captured {len(cases)} hook scenarios")
PY

echo "hook captures regenerated"
