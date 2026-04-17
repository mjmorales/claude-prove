"""Tests for tools/run_state/validate.py — schema validation."""

from __future__ import annotations

import json
from pathlib import Path

from tools.run_state.schemas import infer_kind
from tools.run_state.validate import validate_data, validate_file


def _err_paths(errors: list) -> set[str]:
    return {e.path for e in errors if e.severity == "error"}


def test_infer_kind_from_basename() -> None:
    assert infer_kind("a/b/prd.json") == "prd"
    assert infer_kind("a/b/plan.json") == "plan"
    assert infer_kind("a/b/state.json") == "state"
    assert infer_kind("a/b/reports/1_1_1.json") == "report"
    assert infer_kind("a/b/other.json") is None


def test_validate_data_missing_required() -> None:
    errors = validate_data({}, "plan")
    paths = _err_paths(errors)
    assert "schema_version" in paths
    assert "kind" in paths
    assert "tasks" in paths


def test_validate_data_enum_violation() -> None:
    bad = {
        "schema_version": "1",
        "kind": "state",
        "run_status": "weird",
        "slug": "x",
        "updated_at": "t",
        "tasks": [],
    }
    errors = validate_data(bad, "state")
    assert any("run_status" in e.path for e in errors if e.severity == "error")


def test_validate_data_nested_errors() -> None:
    bad_plan = {
        "schema_version": "1",
        "kind": "plan",
        "tasks": [
            {
                "id": "1.1",
                "title": "t",
                "wave": "not-int",  # wrong type
                "steps": [],
            }
        ],
    }
    errors = validate_data(bad_plan, "plan")
    assert any("wave" in e.path for e in errors if e.severity == "error")


def test_validate_file_roundtrip(tmp_path: Path) -> None:
    p = tmp_path / "state.json"
    p.write_text(
        json.dumps(
            {
                "schema_version": "1",
                "kind": "state",
                "run_status": "pending",
                "slug": "s",
                "updated_at": "t",
                "tasks": [],
            }
        )
    )
    _, errors = validate_file(p)
    assert [e for e in errors if e.severity == "error"] == []


def test_validate_file_bad_json(tmp_path: Path) -> None:
    p = tmp_path / "state.json"
    p.write_text("{not json")
    _, errors = validate_file(p)
    assert any("invalid JSON" in e.message for e in errors)


def test_validate_file_unknown_kind(tmp_path: Path) -> None:
    p = tmp_path / "other.json"
    p.write_text("{}")
    _, errors = validate_file(p)
    assert any("cannot infer schema kind" in e.message for e in errors)


def test_validate_report_ok() -> None:
    r = {
        "schema_version": "1",
        "kind": "report",
        "step_id": "1.1.1",
        "task_id": "1.1",
        "status": "completed",
    }
    errors = [e for e in validate_data(r, "report") if e.severity == "error"]
    assert errors == []
