"""Tests for tools/run_state/state.py — state mutations and invariants."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tools.run_state import state as state_mod
from tools.run_state.schemas import STATE_SCHEMA
from tools.run_state.state import (
    RunPaths,
    StateError,
    complete_step,
    fail_step,
    halt_step,
    init_run,
    load_state,
    new_plan,
    new_prd,
    record_dispatch,
    review_task,
    set_validator,
    start_step,
    write_report,
)
from tools.run_state.validate import validate_data


def _sample_plan() -> dict:
    return new_plan(
        mode="simple",
        tasks=[
            {
                "id": "1.1",
                "title": "First task",
                "wave": 1,
                "deps": [],
                "description": "",
                "acceptance_criteria": [],
                "worktree": {"path": "", "branch": ""},
                "steps": [
                    {"id": "1.1.1", "title": "Step A", "description": "", "acceptance_criteria": []},
                    {"id": "1.1.2", "title": "Step B", "description": "", "acceptance_criteria": []},
                ],
            },
            {
                "id": "1.2",
                "title": "Second task",
                "wave": 1,
                "deps": [],
                "description": "",
                "acceptance_criteria": [],
                "worktree": {"path": "", "branch": ""},
                "steps": [
                    {"id": "1.2.1", "title": "Step C", "description": "", "acceptance_criteria": []},
                ],
            },
        ],
    )


@pytest.fixture
def run(tmp_path: Path) -> RunPaths:
    runs_root = tmp_path / "runs"
    paths = init_run(runs_root, "feature", "demo", _sample_plan(), prd=new_prd("Demo"))
    return paths


# --- init_run ---


def test_init_run_creates_all_artifacts(run: RunPaths) -> None:
    assert run.prd.exists()
    assert run.plan.exists()
    assert run.state.exists()
    assert run.reports_dir.is_dir()


def test_init_run_refuses_to_overwrite(run: RunPaths, tmp_path: Path) -> None:
    with pytest.raises(StateError, match="already initialized"):
        init_run(tmp_path / "runs", "feature", "demo", _sample_plan())


def test_init_run_state_validates(run: RunPaths) -> None:
    data = json.loads(run.state.read_text())
    errors = [e for e in validate_data(data, "state") if e.severity == "error"]
    assert errors == []


# --- start_step ---


def test_start_step_promotes_task_and_run(run: RunPaths) -> None:
    state = start_step(run, "1.1.1")
    assert state["run_status"] == "running"
    assert state["current_step"] == "1.1.1"
    assert state["current_task"] == "1.1"
    assert state["tasks"][0]["status"] == "in_progress"
    assert state["tasks"][0]["steps"][0]["status"] == "in_progress"
    assert state["tasks"][0]["steps"][0]["started_at"]


def test_start_step_is_idempotent(run: RunPaths) -> None:
    start_step(run, "1.1.1")
    state = start_step(run, "1.1.1")  # no-op
    assert state["tasks"][0]["steps"][0]["status"] == "in_progress"


def test_start_step_unknown_id_errors(run: RunPaths) -> None:
    with pytest.raises(StateError, match="step not found"):
        start_step(run, "9.9.9")


# --- complete_step ---


def test_complete_step_advances_current(run: RunPaths) -> None:
    start_step(run, "1.1.1")
    state = complete_step(run, "1.1.1", commit_sha="abc123")
    assert state["tasks"][0]["steps"][0]["status"] == "completed"
    assert state["tasks"][0]["steps"][0]["commit_sha"] == "abc123"
    assert state["current_step"] == "1.1.2"


def test_complete_last_step_finalizes_task(run: RunPaths) -> None:
    start_step(run, "1.1.1")
    complete_step(run, "1.1.1")
    start_step(run, "1.1.2")
    state = complete_step(run, "1.1.2")
    assert state["tasks"][0]["status"] == "completed"
    assert state["current_step"] == "1.2.1"


def test_all_steps_completed_finalizes_run(run: RunPaths) -> None:
    for sid in ("1.1.1", "1.1.2", "1.2.1"):
        start_step(run, sid)
        complete_step(run, sid)
    state = load_state(run)
    assert state["run_status"] == "completed"
    assert state["ended_at"]
    assert state["current_step"] == ""


# --- fail / halt ---


def test_fail_step_marks_run_failed(run: RunPaths) -> None:
    start_step(run, "1.1.1")
    state = fail_step(run, "1.1.1", reason="lint exploded")
    assert state["tasks"][0]["status"] == "failed"
    assert state["run_status"] == "failed"
    assert state["tasks"][0]["steps"][0]["halt_reason"] == "lint exploded"


def test_halt_step_marks_run_halted(run: RunPaths) -> None:
    start_step(run, "1.1.1")
    state = halt_step(run, "1.1.1", reason="user halt")
    assert state["run_status"] == "halted"
    assert state["tasks"][0]["status"] == "halted"


def test_retry_after_fail(run: RunPaths) -> None:
    start_step(run, "1.1.1")
    fail_step(run, "1.1.1")
    state = start_step(run, "1.1.1")  # retry
    assert state["tasks"][0]["steps"][0]["status"] == "in_progress"


def test_illegal_transition_rejected(run: RunPaths) -> None:
    # pending → completed (without going through in_progress) should fail
    with pytest.raises(StateError, match="illegal transition"):
        complete_step(run, "1.1.1")


# --- validator_summary ---


def test_set_validator_updates_summary(run: RunPaths) -> None:
    start_step(run, "1.1.1")
    state = set_validator(run, "1.1.1", "build", "pass")
    assert state["tasks"][0]["steps"][0]["validator_summary"]["build"] == "pass"


def test_set_validator_unknown_phase_errors(run: RunPaths) -> None:
    with pytest.raises(StateError, match="unknown validator phase"):
        set_validator(run, "1.1.1", "bogus", "pass")


def test_set_validator_unknown_status_errors(run: RunPaths) -> None:
    with pytest.raises(StateError, match="unknown validator status"):
        set_validator(run, "1.1.1", "build", "banana")


# --- review ---


def test_review_task_records_verdict(run: RunPaths) -> None:
    state = review_task(run, "1.1", verdict="approved", notes="clean", reviewer="arch")
    review = state["tasks"][0]["review"]
    assert review["verdict"] == "approved"
    assert review["notes"] == "clean"
    assert review["reviewer"] == "arch"
    assert review["reviewed_at"]


def test_review_task_rejects_invalid_verdict(run: RunPaths) -> None:
    with pytest.raises(StateError, match="invalid review verdict"):
        review_task(run, "1.1", verdict="maybe")


# --- dispatch ---


def test_record_dispatch_is_idempotent(run: RunPaths) -> None:
    assert record_dispatch(run, "step-complete:1.1.1", "step-complete") is True
    assert record_dispatch(run, "step-complete:1.1.1", "step-complete") is False
    state = load_state(run)
    entries = state["dispatch"]["dispatched"]
    assert len(entries) == 1
    assert entries[0]["event"] == "step-complete"


def test_has_dispatched(run: RunPaths) -> None:
    record_dispatch(run, "k1", "step-complete")
    assert state_mod.has_dispatched(run, "k1") is True
    assert state_mod.has_dispatched(run, "k2") is False


# --- reports ---


def test_write_report_validates_and_persists(run: RunPaths) -> None:
    report = {
        "schema_version": "1",
        "kind": "report",
        "step_id": "1.1.1",
        "task_id": "1.1",
        "status": "completed",
        "commit_sha": "abc",
        "started_at": "2026-04-17T00:00:00Z",
        "ended_at": "2026-04-17T00:00:01Z",
        "diff_stats": {"files_changed": 1, "insertions": 5, "deletions": 2},
        "validators": [],
        "artifacts": [],
        "notes": "",
    }
    target = write_report(run, report)
    assert target.exists()
    data = json.loads(target.read_text())
    errors = [e for e in validate_data(data, "report") if e.severity == "error"]
    assert errors == []


# --- schema round-trip: initial state passes validation ---


def test_new_state_roundtrip_validates() -> None:
    state = state_mod.new_state("slug", "main", _sample_plan())
    errors = [e for e in validate_data(state, "state") if e.severity == "error"]
    assert errors == []
    # updated_at must be present
    assert state["updated_at"]


def test_state_schema_kind_discriminator() -> None:
    bad = {"schema_version": "1", "kind": "plan", "run_status": "pending", "slug": "x", "updated_at": "t", "tasks": []}
    errors = validate_data(bad, "state")
    assert any("kind" in e.path for e in errors if e.severity == "error")
