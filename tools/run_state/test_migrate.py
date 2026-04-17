"""Tests for tools/run_state/migrate.py — legacy md → JSON conversion."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tools.run_state.migrate import (
    derive_state_from_progress,
    migrate_all,
    migrate_run,
    parse_plan_md,
    parse_prd_md,
)
from tools.run_state.validate import validate_data


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


def test_parse_prd_md_extracts_sections() -> None:
    prd = parse_prd_md(PRD_MD)
    assert prd["title"] == "Example PRD"
    assert "Reasons for this run" in prd["context"]
    assert prd["goals"] == ["Deliver A", "Deliver B"]
    assert prd["acceptance_criteria"] == ["All tests pass", "No regressions"]
    assert "pytest" in prd["test_strategy"]
    assert prd["body_markdown"].startswith("# Example PRD")


def test_parse_prd_md_validates() -> None:
    prd = parse_prd_md(PRD_MD)
    errors = [e for e in validate_data(prd, "prd") if e.severity == "error"]
    assert errors == []


def test_parse_plan_md_extracts_tasks_and_steps() -> None:
    plan = parse_plan_md(PLAN_MD)
    assert plan["mode"] == "full"  # wave 2 present
    assert len(plan["tasks"]) == 2

    t1 = plan["tasks"][0]
    assert t1["id"] == "1.1"
    assert t1["title"] == "First task"
    assert t1["wave"] == 1
    assert t1["worktree"]["path"] == "/tmp/wt1"
    assert t1["worktree"]["branch"] == "orch/demo-1"
    assert len(t1["steps"]) == 2
    assert t1["steps"][0]["id"] == "1.1.1"

    t2 = plan["tasks"][1]
    assert t2["id"] == "2.1"
    assert t2["wave"] == 2
    assert len(t2["steps"]) == 1  # implicit step
    assert t2["steps"][0]["id"] == "2.1.1"


def test_parse_plan_md_validates() -> None:
    plan = parse_plan_md(PLAN_MD)
    errors = [e for e in validate_data(plan, "plan") if e.severity == "error"]
    assert errors == []


def test_derive_state_from_progress_applies_statuses() -> None:
    plan = parse_plan_md(PLAN_MD)
    state = derive_state_from_progress(PROGRESS_MD, plan, slug="demo", branch="feature")
    assert state["tasks"][0]["status"] == "completed"
    assert state["tasks"][1]["status"] == "in_progress"
    assert state["run_status"] == "running"


def test_derive_state_validates() -> None:
    plan = parse_plan_md(PLAN_MD)
    state = derive_state_from_progress(PROGRESS_MD, plan, slug="demo", branch="feature")
    errors = [e for e in validate_data(state, "state") if e.severity == "error"]
    assert errors == []


# --- Full migration driver ---


def _setup_legacy_run(root: Path, branch: str, slug: str) -> Path:
    run_dir = root / branch / slug
    run_dir.mkdir(parents=True)
    (run_dir / "PRD.md").write_text(PRD_MD)
    (run_dir / "TASK_PLAN.md").write_text(PLAN_MD)
    (run_dir / "PROGRESS.md").write_text(PROGRESS_MD)
    return run_dir


def test_migrate_run_writes_all_three(tmp_path: Path) -> None:
    run_dir = _setup_legacy_run(tmp_path / "runs", "feature", "demo")
    result = migrate_run(run_dir, branch="feature", slug="demo")
    assert result.prd_written
    assert result.plan_written
    assert result.state_written
    assert (run_dir / "prd.json").exists()
    assert (run_dir / "plan.json").exists()
    assert (run_dir / "state.json").exists()


def test_migrate_run_is_idempotent(tmp_path: Path) -> None:
    run_dir = _setup_legacy_run(tmp_path / "runs", "feature", "demo")
    migrate_run(run_dir, branch="feature", slug="demo")
    result = migrate_run(run_dir, branch="feature", slug="demo")  # second pass
    assert result.prd_written is False
    assert result.plan_written is False
    assert result.state_written is False


def test_migrate_run_overwrite_flag(tmp_path: Path) -> None:
    run_dir = _setup_legacy_run(tmp_path / "runs", "feature", "demo")
    migrate_run(run_dir, branch="feature", slug="demo")
    result = migrate_run(run_dir, branch="feature", slug="demo", overwrite=True)
    assert result.prd_written
    assert result.plan_written
    assert result.state_written


def test_migrate_run_folds_dispatch_state(tmp_path: Path) -> None:
    run_dir = _setup_legacy_run(tmp_path / "runs", "feature", "demo")
    (run_dir / "dispatch-state.json").write_text(
        json.dumps({"dispatched": [{"key": "k1", "event": "step-complete", "timestamp": "t"}]})
    )
    migrate_run(run_dir, branch="feature", slug="demo")
    state = json.loads((run_dir / "state.json").read_text())
    assert state["dispatch"]["dispatched"][0]["key"] == "k1"


def test_migrate_all_walks_branches(tmp_path: Path) -> None:
    root = tmp_path / "runs"
    _setup_legacy_run(root, "feature", "one")
    _setup_legacy_run(root, "fix", "two")
    results = migrate_all(root)
    assert len(results) == 2
    assert all(r.state_written for r in results)


def test_migrate_run_dry_run_does_not_write(tmp_path: Path) -> None:
    run_dir = _setup_legacy_run(tmp_path / "runs", "feature", "demo")
    migrate_run(run_dir, branch="feature", slug="demo", dry_run=True)
    assert not (run_dir / "state.json").exists()


def test_migrate_handles_plan_without_progress(tmp_path: Path) -> None:
    run_dir = tmp_path / "runs" / "feature" / "demo"
    run_dir.mkdir(parents=True)
    (run_dir / "TASK_PLAN.md").write_text(PLAN_MD)
    # No PRD.md, no PROGRESS.md, no dispatch-state.json
    result = migrate_run(run_dir, branch="feature", slug="demo")
    assert result.plan_written
    assert result.state_written
    assert not result.prd_written
