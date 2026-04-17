"""Tests for reconciliation logic + Stop/SubagentStop hooks."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from tools.run_state.state import (
    RunPaths,
    complete_step,
    find_inprogress_steps,
    init_run,
    load_state,
    new_plan,
    reconcile,
    start_step,
)


REPO = Path(__file__).resolve().parents[2]


def _sample_plan() -> dict:
    return new_plan(
        tasks=[
            {
                "id": "1.1",
                "title": "t",
                "wave": 1,
                "deps": [],
                "description": "",
                "acceptance_criteria": [],
                "worktree": {"path": "", "branch": ""},
                "steps": [
                    {"id": "1.1.1", "title": "s1", "description": "", "acceptance_criteria": []},
                    {"id": "1.1.2", "title": "s2", "description": "", "acceptance_criteria": []},
                ],
            }
        ]
    )


@pytest.fixture
def run(tmp_path: Path) -> RunPaths:
    return init_run(tmp_path / "runs", "feature", "demo", _sample_plan())


# --- reconcile() ---


def test_reconcile_no_inprogress_is_noop(run: RunPaths) -> None:
    assert reconcile(run) == []


def test_reconcile_halts_inprogress_without_commit(run: RunPaths) -> None:
    start_step(run, "1.1.1")
    changes = reconcile(run, reason_on_halt="timed out")
    assert len(changes) == 1
    assert changes[0]["step_id"] == "1.1.1"
    assert changes[0]["action"] == "halted"
    assert changes[0]["detail"] == "timed out"

    state = load_state(run)
    assert state["tasks"][0]["steps"][0]["status"] == "halted"
    assert state["tasks"][0]["steps"][0]["halt_reason"] == "timed out"
    assert state["run_status"] == "halted"


def test_reconcile_completes_inprogress_with_commit(run: RunPaths) -> None:
    start_step(run, "1.1.1")
    changes = reconcile(run, worktree_latest_commit="abc123def456")
    assert len(changes) == 1
    assert changes[0]["action"] == "completed"

    state = load_state(run)
    assert state["tasks"][0]["steps"][0]["status"] == "completed"
    assert state["tasks"][0]["steps"][0]["commit_sha"] == "abc123def456"


def test_reconcile_respects_scope(run: RunPaths) -> None:
    start_step(run, "1.1.1")
    # Start second step by completing first, then starting second
    complete_step(run, "1.1.1")
    start_step(run, "1.1.2")
    assert len(find_inprogress_steps(load_state(run))) == 1
    # Scope to a step that ISN'T in_progress — no change
    changes = reconcile(run, scope_step_ids={"1.1.1"})
    assert changes == []
    # State still has 1.1.2 in_progress
    assert load_state(run)["tasks"][0]["steps"][1]["status"] == "in_progress"


def test_reconcile_idempotent(run: RunPaths) -> None:
    start_step(run, "1.1.1")
    reconcile(run)
    changes = reconcile(run)  # second pass: everything terminal already
    assert changes == []


# --- hook_stop.py ---


def _run_hook(script: str, payload: dict) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(REPO) + os.pathsep + env.get("PYTHONPATH", "")
    return subprocess.run(
        [sys.executable, str(REPO / "tools" / "run_state" / script)],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        env=env,
        check=False,
    )


def test_stop_hook_halts_lingering_steps(tmp_path: Path) -> None:
    # Build a run inside tmp_path/.prove/runs
    project = tmp_path / "project"
    project.mkdir()
    runs_root = project / ".prove" / "runs"
    paths = init_run(runs_root, "feature", "demo", _sample_plan())
    start_step(paths, "1.1.1")

    result = _run_hook("hook_stop.py", {"cwd": str(project)})
    assert result.returncode == 0, result.stderr
    # Hook emits notice via systemMessage (Stop does not support hookSpecificOutput)
    out = json.loads(result.stdout)
    assert "reconciled" in out["systemMessage"]
    assert "hookSpecificOutput" not in out

    # State is now halted
    data = json.loads(paths.state.read_text())
    assert data["tasks"][0]["steps"][0]["status"] == "halted"
    assert data["run_status"] == "halted"


def test_stop_hook_silent_when_clean(tmp_path: Path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    runs_root = project / ".prove" / "runs"
    init_run(runs_root, "feature", "demo", _sample_plan())

    result = _run_hook("hook_stop.py", {"cwd": str(project)})
    assert result.returncode == 0
    assert result.stdout.strip() == ""


def test_stop_hook_ignores_completed_runs(tmp_path: Path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    runs_root = project / ".prove" / "runs"
    paths = init_run(runs_root, "feature", "demo", _sample_plan())

    # Complete the whole run
    for sid in ("1.1.1", "1.1.2"):
        start_step(paths, sid)
        complete_step(paths, sid)
    assert load_state(paths)["run_status"] == "completed"

    result = _run_hook("hook_stop.py", {"cwd": str(project)})
    assert result.returncode == 0
    assert result.stdout.strip() == ""


# --- hook_subagent_stop.py ---


def _make_git_worktree(root: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.email", "t@x"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.name", "t"], cwd=root, check=True)
    (root / "README").write_text("seed")
    subprocess.run(["git", "add", "."], cwd=root, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "seed"], cwd=root, check=True)


def test_subagent_stop_no_slug_is_noop(tmp_path: Path) -> None:
    _make_git_worktree(tmp_path)
    result = _run_hook("hook_subagent_stop.py", {"cwd": str(tmp_path)})
    assert result.returncode == 0
    assert result.stdout.strip() == ""


def test_subagent_stop_halts_without_new_commit(tmp_path: Path) -> None:
    _make_git_worktree(tmp_path)
    (tmp_path / ".prove-wt-slug.txt").write_text("demo\n")
    runs_root = tmp_path / ".prove" / "runs"
    paths = init_run(runs_root, "feature", "demo", _sample_plan())
    start_step(paths, "1.1.1")

    # Bump started_at far in the future so git HEAD doesn't beat it
    import datetime as dt

    state = load_state(paths)
    future = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=1)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    state["tasks"][0]["steps"][0]["started_at"] = future
    paths.state.write_text(json.dumps(state))

    result = _run_hook("hook_subagent_stop.py", {"cwd": str(tmp_path)})
    assert result.returncode == 0, result.stderr

    data = json.loads(paths.state.read_text())
    assert data["tasks"][0]["steps"][0]["status"] == "halted"


def test_subagent_stop_auto_completes_when_new_commit(tmp_path: Path) -> None:
    _make_git_worktree(tmp_path)
    (tmp_path / ".prove-wt-slug.txt").write_text("demo\n")
    runs_root = tmp_path / ".prove" / "runs"
    paths = init_run(runs_root, "feature", "demo", _sample_plan())
    start_step(paths, "1.1.1")

    # Create a new commit AFTER starting the step
    (tmp_path / "file.txt").write_text("work")
    subprocess.run(["git", "add", "."], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "work"], cwd=tmp_path, check=True)

    result = _run_hook("hook_subagent_stop.py", {"cwd": str(tmp_path)})
    assert result.returncode == 0, result.stderr

    data = json.loads(paths.state.read_text())
    step = data["tasks"][0]["steps"][0]
    assert step["status"] == "completed"
    assert step["commit_sha"]  # non-empty SHA recorded
