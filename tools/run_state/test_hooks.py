"""Tests for run_state hook scripts."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def _run_hook(script: str, payload: dict, env_overrides: dict | None = None) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(REPO) + os.pathsep + env.get("PYTHONPATH", "")
    if env_overrides:
        env.update(env_overrides)
    return subprocess.run(
        [sys.executable, str(REPO / "tools" / "run_state" / script)],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        env=env,
        check=False,
    )


# --- hook_validate ---


def test_validate_hook_blocks_invalid_state(tmp_path: Path) -> None:
    runs = tmp_path / ".prove" / "runs" / "main" / "demo"
    runs.mkdir(parents=True)
    state_path = runs / "state.json"
    # Missing required fields
    state_path.write_text(json.dumps({"schema_version": "1", "kind": "state"}))

    result = _run_hook(
        "hook_validate.py",
        {"tool_name": "Write", "tool_input": {"file_path": str(state_path)}},
    )
    assert result.returncode == 0  # hooks always exit 0; signal via JSON
    out = json.loads(result.stdout)
    assert out["decision"] == "block"
    assert "Schema validation failed" in out["reason"]


def test_validate_hook_passes_on_valid_file(tmp_path: Path) -> None:
    runs = tmp_path / ".prove" / "runs" / "main" / "demo"
    runs.mkdir(parents=True)
    state_path = runs / "state.json"
    state_path.write_text(
        json.dumps(
            {
                "schema_version": "1",
                "kind": "state",
                "run_status": "pending",
                "slug": "demo",
                "updated_at": "2026-04-17T00:00:00Z",
                "tasks": [],
            }
        )
    )

    result = _run_hook(
        "hook_validate.py",
        {"tool_name": "Write", "tool_input": {"file_path": str(state_path)}},
    )
    assert result.returncode == 0
    assert result.stdout.strip() == ""


def test_validate_hook_ignores_non_run_paths(tmp_path: Path) -> None:
    other = tmp_path / "random.json"
    other.write_text('{"foo": "bar"}')
    result = _run_hook(
        "hook_validate.py",
        {"tool_name": "Write", "tool_input": {"file_path": str(other)}},
    )
    assert result.returncode == 0
    assert result.stdout.strip() == ""


def test_validate_hook_ignores_non_write_tools(tmp_path: Path) -> None:
    result = _run_hook(
        "hook_validate.py",
        {"tool_name": "Bash", "tool_input": {"command": "ls"}},
    )
    assert result.returncode == 0
    assert result.stdout.strip() == ""


# --- hook_guard ---


def test_guard_hook_denies_direct_state_edit() -> None:
    fake_path = "/fake/.prove/runs/main/demo/state.json"
    result = _run_hook(
        "hook_guard.py",
        {"tool_name": "Write", "tool_input": {"file_path": fake_path}},
    )
    assert result.returncode == 0
    out = json.loads(result.stdout)
    assert out["hookSpecificOutput"]["permissionDecision"] == "deny"


def test_guard_hook_allows_override() -> None:
    fake_path = "/fake/.prove/runs/main/demo/state.json"
    result = _run_hook(
        "hook_guard.py",
        {"tool_name": "Write", "tool_input": {"file_path": fake_path}},
        env_overrides={"RUN_STATE_ALLOW_DIRECT": "1"},
    )
    assert result.returncode == 0
    assert result.stdout.strip() == ""


def test_guard_hook_allows_prd_and_plan() -> None:
    for name in ("prd.json", "plan.json"):
        result = _run_hook(
            "hook_guard.py",
            {
                "tool_name": "Write",
                "tool_input": {"file_path": f"/fake/.prove/runs/main/demo/{name}"},
            },
        )
        assert result.stdout.strip() == ""


# --- hook_session_start ---


def test_session_start_emits_context(tmp_path: Path) -> None:
    runs = tmp_path / ".prove" / "runs" / "feature" / "demo"
    runs.mkdir(parents=True)
    (runs / "state.json").write_text(
        json.dumps(
            {
                "schema_version": "1",
                "kind": "state",
                "run_status": "running",
                "slug": "demo",
                "branch": "feature",
                "updated_at": "t",
                "current_step": "1.1.1",
                "tasks": [],
            }
        )
    )
    result = _run_hook(
        "hook_session_start.py",
        {"cwd": str(tmp_path)},
    )
    assert result.returncode == 0
    out = json.loads(result.stdout)
    ctx = out["hookSpecificOutput"]["additionalContext"]
    assert "feature/demo" in ctx
    assert "running" in ctx


def test_session_start_silent_when_no_runs(tmp_path: Path) -> None:
    result = _run_hook(
        "hook_session_start.py",
        {"cwd": str(tmp_path)},
    )
    assert result.returncode == 0
    assert result.stdout.strip() == ""
