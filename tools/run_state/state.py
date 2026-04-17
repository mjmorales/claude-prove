"""State mutations for .prove/runs/<branch>/<slug>/state.json.

The run_state CLI is the sole blessed writer for ``state.json``. All
mutations funnel through the functions here so invariants (status
transitions, monotonic timestamps, dispatch dedup) hold uniformly.

File locking uses ``fcntl.flock`` on ``state.json.lock``. Atomic writes go
through a temp file + ``os.replace``.
"""

from __future__ import annotations

import contextlib
import dataclasses
import datetime as _dt
import errno
import fcntl
import json
import os
from pathlib import Path
from typing import Any, Iterator

from tools.run_state import CURRENT_SCHEMA_VERSION
from tools.run_state.schemas import (
    PLAN_SCHEMA,
    PRD_SCHEMA,
    RUN_STATUSES,
    STATE_SCHEMA,
    STEP_STATUSES,
    TASK_STATUSES,
    VALIDATOR_PHASES,
    VALIDATOR_STATUSES,
)

# --------------------------------------------------------------------------
# Time utilities — centralized so tests can monkeypatch.
# --------------------------------------------------------------------------


def utcnow_iso() -> str:
    """ISO-8601 UTC timestamp with Z suffix (second precision)."""
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------
# Path helpers
# --------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class RunPaths:
    """Resolved filesystem layout for a single run."""

    root: Path
    prd: Path
    plan: Path
    state: Path
    state_lock: Path
    reports_dir: Path

    @classmethod
    def for_run(cls, runs_root: Path, branch: str, slug: str) -> "RunPaths":
        root = runs_root / branch / slug
        return cls(
            root=root,
            prd=root / "prd.json",
            plan=root / "plan.json",
            state=root / "state.json",
            state_lock=root / "state.json.lock",
            reports_dir=root / "reports",
        )


# --------------------------------------------------------------------------
# Low-level JSON I/O with lock + atomic write
# --------------------------------------------------------------------------


@contextlib.contextmanager
def _locked(lock_path: Path) -> Iterator[None]:
    """Acquire an exclusive flock on ``lock_path`` for the block's duration."""
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    # Open (or create) the lock file; write mode ensures creation, no truncation
    # semantic issues because we only use fd for fcntl.
    fd = os.open(str(lock_path), os.O_RDWR | os.O_CREAT, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def _read_json(path: Path) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _write_json_atomic(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, sort_keys=False)
        f.write("\n")
    os.replace(tmp, path)


# --------------------------------------------------------------------------
# Defaults / factory helpers
# --------------------------------------------------------------------------


def _defaults_from_schema(schema: dict) -> dict:
    """Render a minimal object populated with defaults for every field."""
    out: dict[str, Any] = {}
    for name, spec in schema["fields"].items():
        if "default" in spec:
            out[name] = _copy(spec["default"])
    return out


def _copy(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _copy(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_copy(v) for v in value]
    return value


def new_prd(title: str, **kwargs: Any) -> dict:
    prd = _defaults_from_schema(PRD_SCHEMA)
    prd["schema_version"] = CURRENT_SCHEMA_VERSION
    prd["kind"] = "prd"
    prd["title"] = title
    for k, v in kwargs.items():
        prd[k] = v
    return prd


def new_plan(tasks: list[dict], mode: str = "simple") -> dict:
    plan = _defaults_from_schema(PLAN_SCHEMA)
    plan["schema_version"] = CURRENT_SCHEMA_VERSION
    plan["kind"] = "plan"
    plan["mode"] = mode
    plan["tasks"] = tasks
    return plan


def new_state(slug: str, branch: str, plan: dict) -> dict:
    """Initialize a state.json shell mirroring ``plan`` task/step structure."""
    now = utcnow_iso()
    tasks_state: list[dict] = []
    for task in plan.get("tasks", []):
        steps_state: list[dict] = []
        for step in task.get("steps", []):
            steps_state.append(
                {
                    "id": step["id"],
                    "status": "pending",
                    "started_at": "",
                    "ended_at": "",
                    "commit_sha": "",
                    "validator_summary": {
                        "build": "pending",
                        "lint": "pending",
                        "test": "pending",
                        "custom": "pending",
                        "llm": "pending",
                    },
                    "halt_reason": "",
                }
            )
        tasks_state.append(
            {
                "id": task["id"],
                "status": "pending",
                "started_at": "",
                "ended_at": "",
                "review": {
                    "verdict": "pending",
                    "notes": "",
                    "reviewer": "",
                    "reviewed_at": "",
                },
                "steps": steps_state,
            }
        )

    return {
        "schema_version": CURRENT_SCHEMA_VERSION,
        "kind": "state",
        "run_status": "pending",
        "slug": slug,
        "branch": branch,
        "current_task": "",
        "current_step": "",
        "started_at": "",
        "updated_at": now,
        "ended_at": "",
        "tasks": tasks_state,
        "dispatch": {"dispatched": []},
    }


# --------------------------------------------------------------------------
# High-level operations
# --------------------------------------------------------------------------


class StateError(Exception):
    """Raised when a state mutation violates an invariant."""


def init_run(
    runs_root: Path,
    branch: str,
    slug: str,
    plan: dict,
    prd: dict | None = None,
    *,
    overwrite: bool = False,
) -> RunPaths:
    """Create the run directory and write prd.json, plan.json, state.json.

    Raises ``StateError`` if the run already exists and ``overwrite`` is False.
    """
    paths = RunPaths.for_run(runs_root, branch, slug)
    paths.root.mkdir(parents=True, exist_ok=True)
    paths.reports_dir.mkdir(parents=True, exist_ok=True)

    if paths.state.exists() and not overwrite:
        raise StateError(
            f"run already initialized: {paths.state} (use --overwrite to replace)"
        )

    if prd is None:
        prd = new_prd(title=slug)

    with _locked(paths.state_lock):
        _write_json_atomic(paths.prd, prd)
        _write_json_atomic(paths.plan, plan)
        _write_json_atomic(paths.state, new_state(slug, branch, plan))
    return paths


def load_state(paths: RunPaths) -> dict:
    with _locked(paths.state_lock):
        return _read_json(paths.state)


def save_state(paths: RunPaths, state: dict) -> None:
    state["updated_at"] = utcnow_iso()
    with _locked(paths.state_lock):
        _write_json_atomic(paths.state, state)


@contextlib.contextmanager
def mutate_state(paths: RunPaths) -> Iterator[dict]:
    """Read-modify-write state.json under the file lock.

    Usage::

        with mutate_state(paths) as state:
            _find_step(state, step_id)["status"] = "in_progress"
    """
    with _locked(paths.state_lock):
        state = _read_json(paths.state)
        yield state
        state["updated_at"] = utcnow_iso()
        _write_json_atomic(paths.state, state)


# --------------------------------------------------------------------------
# State-tree helpers
# --------------------------------------------------------------------------


def _find_task(state: dict, task_id: str) -> dict:
    for t in state.get("tasks", []):
        if t["id"] == task_id:
            return t
    raise StateError(f"task not found in state: {task_id!r}")


def _find_step(state: dict, step_id: str) -> tuple[dict, dict]:
    """Return (task, step) matching ``step_id``."""
    for t in state.get("tasks", []):
        for s in t.get("steps", []):
            if s["id"] == step_id:
                return t, s
    raise StateError(f"step not found in state: {step_id!r}")


def _assert_transition(current: str, target: str, allowed: dict[str, set[str]]) -> None:
    if current == target:
        return  # idempotent no-op
    valid = allowed.get(current, set())
    if target not in valid:
        raise StateError(
            f"illegal transition: {current!r} -> {target!r} "
            f"(allowed from {current!r}: {sorted(valid)})"
        )


_STEP_TRANSITIONS: dict[str, set[str]] = {
    "pending": {"in_progress", "skipped"},
    "in_progress": {"completed", "failed", "halted"},
    "completed": set(),
    "failed": {"in_progress"},  # retry
    "halted": {"in_progress"},
    "skipped": set(),
}

_TASK_TRANSITIONS: dict[str, set[str]] = {
    "pending": {"in_progress"},
    "in_progress": {"completed", "failed", "halted"},
    "completed": set(),
    "failed": {"in_progress"},
    "halted": {"in_progress"},
}


# --------------------------------------------------------------------------
# Step-level mutations
# --------------------------------------------------------------------------


def start_step(paths: RunPaths, step_id: str) -> dict:
    with mutate_state(paths) as state:
        task, step = _find_step(state, step_id)
        _assert_transition(step["status"], "in_progress", _STEP_TRANSITIONS)

        now = utcnow_iso()
        step["status"] = "in_progress"
        if not step.get("started_at"):
            step["started_at"] = now
        step["ended_at"] = ""
        step["halt_reason"] = ""

        # Promote task to in_progress if needed
        if task["status"] in ("pending", "failed", "halted"):
            _assert_transition(task["status"], "in_progress", _TASK_TRANSITIONS)
            task["status"] = "in_progress"
            if not task.get("started_at"):
                task["started_at"] = now

        # Promote run to running
        if state["run_status"] == "pending":
            state["run_status"] = "running"
            if not state.get("started_at"):
                state["started_at"] = now

        state["current_task"] = task["id"]
        state["current_step"] = step["id"]
        return _copy(state)


def complete_step(
    paths: RunPaths, step_id: str, *, commit_sha: str = ""
) -> dict:
    with mutate_state(paths) as state:
        task, step = _find_step(state, step_id)
        _assert_transition(step["status"], "completed", _STEP_TRANSITIONS)

        now = utcnow_iso()
        step["status"] = "completed"
        step["ended_at"] = now
        if commit_sha:
            step["commit_sha"] = commit_sha

        _maybe_finalize_task(state, task)
        _maybe_advance_current(state, task, step)
        _maybe_finalize_run(state)
        return _copy(state)


def fail_step(paths: RunPaths, step_id: str, *, reason: str = "") -> dict:
    return _terminate_step(paths, step_id, target="failed", reason=reason)


def halt_step(paths: RunPaths, step_id: str, *, reason: str = "") -> dict:
    return _terminate_step(paths, step_id, target="halted", reason=reason)


def _terminate_step(
    paths: RunPaths, step_id: str, *, target: str, reason: str
) -> dict:
    with mutate_state(paths) as state:
        task, step = _find_step(state, step_id)
        _assert_transition(step["status"], target, _STEP_TRANSITIONS)

        now = utcnow_iso()
        step["status"] = target
        step["ended_at"] = now
        if reason:
            step["halt_reason"] = reason

        if target == "failed":
            if task["status"] != "failed":
                _assert_transition(task["status"], "failed", _TASK_TRANSITIONS)
                task["status"] = "failed"
                task["ended_at"] = now
        else:  # halted
            if task["status"] != "halted":
                _assert_transition(task["status"], "halted", _TASK_TRANSITIONS)
                task["status"] = "halted"
                task["ended_at"] = now

        state["run_status"] = "halted" if target == "halted" else "failed"
        if not state.get("ended_at"):
            state["ended_at"] = now

        state["current_step"] = ""
        return _copy(state)


def set_validator(
    paths: RunPaths, step_id: str, phase: str, status: str
) -> dict:
    if phase not in VALIDATOR_PHASES:
        raise StateError(f"unknown validator phase: {phase!r}")
    if status not in VALIDATOR_STATUSES:
        raise StateError(f"unknown validator status: {status!r}")

    with mutate_state(paths) as state:
        _, step = _find_step(state, step_id)
        summary = step.setdefault(
            "validator_summary",
            {p: "pending" for p in VALIDATOR_PHASES},
        )
        summary[phase] = status
        return _copy(state)


# --------------------------------------------------------------------------
# Task-level mutations
# --------------------------------------------------------------------------


def review_task(
    paths: RunPaths,
    task_id: str,
    *,
    verdict: str,
    notes: str = "",
    reviewer: str = "",
) -> dict:
    if verdict not in ("approved", "rejected", "pending", "n/a"):
        raise StateError(f"invalid review verdict: {verdict!r}")

    with mutate_state(paths) as state:
        task = _find_task(state, task_id)
        review = task.setdefault(
            "review",
            {"verdict": "pending", "notes": "", "reviewer": "", "reviewed_at": ""},
        )
        review["verdict"] = verdict
        review["notes"] = notes
        review["reviewer"] = reviewer
        review["reviewed_at"] = utcnow_iso()
        return _copy(state)


# --------------------------------------------------------------------------
# Dispatch ledger (reporter dedup)
# --------------------------------------------------------------------------


def record_dispatch(paths: RunPaths, key: str, event: str) -> bool:
    """Append a dispatch entry unless ``key`` is already recorded.

    Returns True if the entry was newly recorded, False if it was already
    present (dedup hit).
    """
    with mutate_state(paths) as state:
        dispatch = state.setdefault("dispatch", {"dispatched": []})
        for entry in dispatch.get("dispatched", []):
            if entry.get("key") == key:
                return False
        dispatch["dispatched"].append(
            {"key": key, "event": event, "timestamp": utcnow_iso()}
        )
        return True


def has_dispatched(paths: RunPaths, key: str) -> bool:
    state = load_state(paths)
    for entry in state.get("dispatch", {}).get("dispatched", []):
        if entry.get("key") == key:
            return True
    return False


# --------------------------------------------------------------------------
# Auto-advance / finalize helpers
# --------------------------------------------------------------------------


def _maybe_finalize_task(state: dict, task: dict) -> None:
    """Promote task to completed iff every step is terminal and not failed/halted."""
    statuses = {s["status"] for s in task.get("steps", [])}
    if not statuses:
        return
    terminal = {"completed", "skipped"}
    if statuses <= terminal:
        if task["status"] != "completed":
            _assert_transition(task["status"], "completed", _TASK_TRANSITIONS)
            task["status"] = "completed"
            task["ended_at"] = utcnow_iso()


def _maybe_advance_current(state: dict, task: dict, step: dict) -> None:
    """Move current_step to the next pending step, or clear it."""
    # Find step index in task
    steps = task.get("steps", [])
    try:
        idx = next(i for i, s in enumerate(steps) if s["id"] == step["id"])
    except StopIteration:
        return

    for nxt in steps[idx + 1 :]:
        if nxt["status"] == "pending":
            state["current_step"] = nxt["id"]
            return

    # No more pending steps in this task; look across remaining tasks
    for t in state.get("tasks", []):
        if t["status"] in ("pending",):
            for s in t.get("steps", []):
                if s["status"] == "pending":
                    state["current_task"] = t["id"]
                    state["current_step"] = s["id"]
                    return

    state["current_step"] = ""


def _maybe_finalize_run(state: dict) -> None:
    statuses = {t["status"] for t in state.get("tasks", [])}
    if not statuses:
        return
    if statuses <= {"completed", "skipped"}:
        state["run_status"] = "completed"
        if not state.get("ended_at"):
            state["ended_at"] = utcnow_iso()
        state["current_task"] = ""
        state["current_step"] = ""


# --------------------------------------------------------------------------
# Report I/O
# --------------------------------------------------------------------------


def write_report(paths: RunPaths, report: dict) -> Path:
    step_id = report["step_id"]
    paths.reports_dir.mkdir(parents=True, exist_ok=True)
    # Dots in step ids are filesystem-safe but we normalize for clarity
    filename = f"{step_id.replace('.', '_')}.json"
    target = paths.reports_dir / filename
    _write_json_atomic(target, report)
    return target


def read_report(paths: RunPaths, step_id: str) -> dict | None:
    filename = f"{step_id.replace('.', '_')}.json"
    target = paths.reports_dir / filename
    if not target.exists():
        return None
    return _read_json(target)


# --------------------------------------------------------------------------
# Reconciliation (hook-driven enforcement)
# --------------------------------------------------------------------------


def find_inprogress_steps(state: dict) -> list[tuple[str, str]]:
    """Return (task_id, step_id) for every step currently in_progress."""
    out: list[tuple[str, str]] = []
    for task in state.get("tasks", []):
        for step in task.get("steps", []):
            if step["status"] == "in_progress":
                out.append((task["id"], step["id"]))
    return out


def reconcile(
    paths: RunPaths,
    *,
    worktree_latest_commit: str | None = None,
    scope_step_ids: set[str] | None = None,
    reason_on_halt: str = "no completion recorded before session/subagent ended",
) -> list[dict]:
    """Fix up lingering in_progress steps.

    For each in_progress step (optionally filtered by ``scope_step_ids``):
    - if ``worktree_latest_commit`` is supplied AND differs from the step's
      ``started_at``-era state (there were commits), auto-complete the step
      with that SHA
    - otherwise, halt the step with ``reason_on_halt``

    Returns a list of ``{step_id, action, detail}`` dicts describing each change.
    Safe to call repeatedly — completed/failed/halted steps are ignored.
    """
    changes: list[dict] = []
    with mutate_state(paths) as state:
        targets = find_inprogress_steps(state)
        for task_id, step_id in targets:
            if scope_step_ids is not None and step_id not in scope_step_ids:
                continue
            task = _find_task(state, task_id)
            _, step = _find_step(state, step_id)
            now = utcnow_iso()

            if worktree_latest_commit:
                step["status"] = "completed"
                step["ended_at"] = now
                step["commit_sha"] = worktree_latest_commit
                changes.append(
                    {
                        "step_id": step_id,
                        "action": "completed",
                        "detail": f"auto-completed from latest worktree commit {worktree_latest_commit[:12]}",
                    }
                )
                _maybe_finalize_task(state, task)
            else:
                step["status"] = "halted"
                step["ended_at"] = now
                step["halt_reason"] = reason_on_halt
                if task["status"] != "halted":
                    _assert_transition(task["status"], "halted", _TASK_TRANSITIONS)
                    task["status"] = "halted"
                    task["ended_at"] = now
                state["run_status"] = "halted"
                if not state.get("ended_at"):
                    state["ended_at"] = now
                changes.append(
                    {
                        "step_id": step_id,
                        "action": "halted",
                        "detail": reason_on_halt,
                    }
                )
        _maybe_finalize_run(state)
    return changes


# --------------------------------------------------------------------------
# Direct-write detection (for the PostToolUse hook)
# --------------------------------------------------------------------------

# Re-export for callers that want the constants without importing schemas
__all__ = [
    "CURRENT_SCHEMA_VERSION",
    "RUN_STATUSES",
    "RunPaths",
    "STEP_STATUSES",
    "StateError",
    "TASK_STATUSES",
    "VALIDATOR_PHASES",
    "VALIDATOR_STATUSES",
    "complete_step",
    "fail_step",
    "find_inprogress_steps",
    "halt_step",
    "has_dispatched",
    "init_run",
    "load_state",
    "mutate_state",
    "new_plan",
    "new_prd",
    "new_state",
    "read_report",
    "reconcile",
    "record_dispatch",
    "review_task",
    "save_state",
    "set_validator",
    "start_step",
    "utcnow_iso",
    "write_report",
]
