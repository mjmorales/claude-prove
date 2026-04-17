"""Tests for CLI auto-detection of slug and branch."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def _run_cli(args: list[str], *, cwd: Path, env_extras: dict | None = None) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(REPO) + os.pathsep + env.get("PYTHONPATH", "")
    # Strip any inherited slug env so tests are deterministic
    env.pop("PROVE_RUN_SLUG", None)
    env.pop("PROVE_RUN_BRANCH", None)
    if env_extras:
        env.update(env_extras)
    return subprocess.run(
        [sys.executable, "-m", "tools.run_state"] + args,
        cwd=str(cwd),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def _init_run(project: Path, branch: str, slug: str) -> None:
    plan = {
        "schema_version": "1",
        "kind": "plan",
        "mode": "simple",
        "tasks": [
            {
                "id": "1.1",
                "title": "t",
                "wave": 1,
                "deps": [],
                "description": "",
                "acceptance_criteria": [],
                "worktree": {"path": "", "branch": ""},
                "steps": [
                    {"id": "1.1.1", "title": "s", "description": "", "acceptance_criteria": []}
                ],
            }
        ],
    }
    plan_path = project / "plan.json"
    plan_path.write_text(json.dumps(plan))
    result = _run_cli(
        [
            "init",
            "--branch",
            branch,
            "--slug",
            slug,
            "--plan",
            str(plan_path),
            "--runs-root",
            str(project / ".prove" / "runs"),
        ],
        cwd=project,
    )
    assert result.returncode == 0, result.stderr


def test_slug_from_wt_marker(tmp_path: Path) -> None:
    project = tmp_path / "repo"
    project.mkdir()
    (project / ".git").mkdir()  # stop ancestor walk here
    _init_run(project, "feature", "demo")

    # Write marker in the project root — simulates worktree binding
    (project / ".prove-wt-slug.txt").write_text("demo\n")

    # Issue show WITHOUT --slug; auto-detect should kick in
    result = _run_cli(
        ["show", "--runs-root", str(project / ".prove" / "runs"), "--format", "json"],
        cwd=project,
        env_extras={"CLAUDE_PROJECT_DIR": str(project)},
    )
    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["slug"] == "demo"
    assert data["branch"] == "feature"


def test_slug_flag_overrides_marker(tmp_path: Path) -> None:
    project = tmp_path / "repo"
    project.mkdir()
    (project / ".git").mkdir()
    _init_run(project, "feature", "demo")
    _init_run(project, "fix", "other")
    (project / ".prove-wt-slug.txt").write_text("demo\n")

    result = _run_cli(
        [
            "show",
            "--runs-root",
            str(project / ".prove" / "runs"),
            "--slug",
            "other",
            "--format",
            "json",
        ],
        cwd=project,
        env_extras={"CLAUDE_PROJECT_DIR": str(project)},
    )
    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["slug"] == "other"
    assert data["branch"] == "fix"


def test_env_overrides_marker(tmp_path: Path) -> None:
    project = tmp_path / "repo"
    project.mkdir()
    (project / ".git").mkdir()
    _init_run(project, "feature", "demo")
    _init_run(project, "fix", "other")
    (project / ".prove-wt-slug.txt").write_text("demo\n")

    result = _run_cli(
        ["show", "--runs-root", str(project / ".prove" / "runs"), "--format", "json"],
        cwd=project,
        env_extras={
            "CLAUDE_PROJECT_DIR": str(project),
            "PROVE_RUN_SLUG": "other",
        },
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["slug"] == "other"


def test_missing_slug_reports_error(tmp_path: Path) -> None:
    project = tmp_path / "repo"
    project.mkdir()
    (project / ".git").mkdir()

    result = _run_cli(
        ["show", "--runs-root", str(project / ".prove" / "runs")],
        cwd=project,
        env_extras={"CLAUDE_PROJECT_DIR": str(project)},
    )
    assert result.returncode == 2
    assert "no run slug found" in result.stderr


def test_prove_run_slug_marker_fallback(tmp_path: Path) -> None:
    project = tmp_path / "repo"
    project.mkdir()
    (project / ".git").mkdir()
    _init_run(project, "feature", "demo")
    (project / ".prove").mkdir(exist_ok=True)
    (project / ".prove" / "RUN_SLUG").write_text("demo")

    result = _run_cli(
        ["show", "--runs-root", str(project / ".prove" / "runs"), "--format", "json"],
        cwd=project,
        env_extras={"CLAUDE_PROJECT_DIR": str(project)},
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["slug"] == "demo"
