"""One-shot migrators for legacy .prove/runs layout.

Converts the pre-JSON structure::

    .prove/runs/<branch>/<slug>/
      PRD.md
      TASK_PLAN.md
      PROGRESS.md           (optional)
      dispatch-state.json   (optional)
      reports/              (preserved as-is)

into the JSON-first structure::

    .prove/runs/<branch>/<slug>/
      prd.json
      plan.json
      state.json
      state.json.lock
      reports/              (new JSON reports added alongside legacy files)

Markdown parsing is deliberately tolerant — we extract what we can and
preserve the original body under ``body_markdown`` / ``description`` so
no information is lost. The legacy files are NOT deleted automatically;
the caller decides via ``--prune``.
"""

from __future__ import annotations

import dataclasses
import json
import re
from pathlib import Path
from typing import Iterable

from tools.run_state import CURRENT_SCHEMA_VERSION
from tools.run_state.state import (
    RunPaths,
    new_plan,
    new_prd,
    new_state,
    _write_json_atomic,
    utcnow_iso,
)


# Title line: "# Task Plan: ..." or "# <anything>"
_H1_RE = re.compile(r"^#\s+(.+)$", re.MULTILINE)

# "### Task 1.2: Something"
_TASK_RE = re.compile(
    r"^###\s+Task\s+(\d+(?:\.\d+)+):\s*(.+?)\s*$", re.MULTILINE
)

# "#### Step 1.2.3: Something" (optional sub-steps)
_STEP_RE = re.compile(
    r"^####\s+Step\s+(\d+(?:\.\d+)+):\s*(.+?)\s*$", re.MULTILINE
)

# "**Worktree:** /path/to/worktree"
_WORKTREE_RE = re.compile(r"^\*\*Worktree:\*\*\s*(.+?)\s*$", re.MULTILINE)
_BRANCH_RE = re.compile(r"^\*\*Branch:\*\*\s*(.+?)\s*$", re.MULTILINE)
_DEPS_RE = re.compile(
    r"^\*\*(?:Depends on|Dependencies):\*\*\s*(.+?)\s*$", re.MULTILINE
)


@dataclasses.dataclass
class MigrationResult:
    run_dir: Path
    prd_written: bool
    plan_written: bool
    state_written: bool
    tasks_found: int
    steps_found: int


# --------------------------------------------------------------------------
# PRD
# --------------------------------------------------------------------------


def parse_prd_md(text: str) -> dict:
    """Parse a legacy PRD.md into the prd.json shape (loose heuristics)."""
    title_match = _H1_RE.search(text)
    title = title_match.group(1).strip() if title_match else "Untitled Run"

    sections = _split_sections(text)
    context = _first_present(sections, ("Context", "Problem", "Background", "Summary"))
    goals = _extract_bullets(_first_present(sections, ("Goals", "Objectives")) or "")
    in_scope = _extract_bullets(_first_present(sections, ("In Scope", "Scope / In")) or "")
    out_scope = _extract_bullets(_first_present(sections, ("Out of Scope", "Out-of-Scope")) or "")
    acceptance = _extract_bullets(
        _first_present(sections, ("Acceptance Criteria", "Acceptance")) or ""
    )
    test_strategy = _first_present(sections, ("Test Strategy", "Testing", "Tests")) or ""

    return new_prd(
        title=title,
        context=context or "",
        goals=goals,
        scope={"in": in_scope, "out": out_scope},
        acceptance_criteria=acceptance,
        test_strategy=test_strategy,
        body_markdown=text.strip(),
    )


# --------------------------------------------------------------------------
# Plan
# --------------------------------------------------------------------------


def parse_plan_md(text: str) -> dict:
    """Parse a legacy TASK_PLAN.md into the plan.json shape."""
    # Split into task chunks by _TASK_RE matches; each task chunk spans from
    # its own match.start() to the next task's match.start() (or EOF).
    matches = list(_TASK_RE.finditer(text))
    tasks: list[dict] = []
    for i, m in enumerate(matches):
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        task_id = m.group(1).strip()
        title = m.group(2).strip()
        body = text[start:end].strip()

        wave = int(task_id.split(".")[0])

        wt_match = _WORKTREE_RE.search(body)
        br_match = _BRANCH_RE.search(body)
        deps_match = _DEPS_RE.search(body)
        deps = [
            d.strip()
            for d in (deps_match.group(1).split(",") if deps_match else [])
            if d.strip()
        ]

        # Sub-steps inside the task body (optional)
        step_matches = list(_STEP_RE.finditer(body))
        steps: list[dict] = []
        if step_matches:
            for j, sm in enumerate(step_matches):
                s_start = sm.end()
                s_end = (
                    step_matches[j + 1].start()
                    if j + 1 < len(step_matches)
                    else len(body)
                )
                s_id = sm.group(1).strip()
                s_title = sm.group(2).strip()
                s_desc = body[s_start:s_end].strip()
                steps.append(
                    {
                        "id": s_id,
                        "title": s_title,
                        "description": s_desc,
                        "acceptance_criteria": [],
                    }
                )
        else:
            # One implicit step — whole task body is the step description
            steps.append(
                {
                    "id": f"{task_id}.1",
                    "title": title,
                    "description": body,
                    "acceptance_criteria": [],
                }
            )

        tasks.append(
            {
                "id": task_id,
                "title": title,
                "wave": wave,
                "deps": deps,
                "description": body,
                "acceptance_criteria": [],
                "worktree": {
                    "path": wt_match.group(1).strip() if wt_match else "",
                    "branch": br_match.group(1).strip() if br_match else "",
                },
                "steps": steps,
            }
        )

    mode = "full" if any(int(t["wave"]) > 1 for t in tasks) else "simple"
    return new_plan(tasks=tasks, mode=mode)


# --------------------------------------------------------------------------
# State (from PROGRESS.md checklist + plan)
# --------------------------------------------------------------------------


_CHECK_TASK_RE = re.compile(
    r"^- \[(?P<mark>[ x!H~\-])\]\s+(?:Task\s+)?(?P<id>\d+(?:\.\d+)+)", re.MULTILINE
)


def derive_state_from_progress(progress_text: str, plan: dict, slug: str, branch: str) -> dict:
    """Best-effort translation of a PROGRESS.md checklist into state.json.

    Unmatched tasks keep their default ``pending`` status.
    """
    state = new_state(slug=slug, branch=branch, plan=plan)

    # Parse checkmarks into a {task_id: status} map
    statuses: dict[str, str] = {}
    for m in _CHECK_TASK_RE.finditer(progress_text):
        mark = m.group("mark")
        tid = m.group("id")
        statuses[tid] = _mark_to_status(mark)

    any_in_progress = False
    for task in state.get("tasks", []):
        s = statuses.get(task["id"])
        if not s:
            continue
        task["status"] = s
        # Propagate a sensible default to steps: completed tasks mark steps completed,
        # in_progress leaves steps pending, failed marks first step failed, halted likewise.
        if s == "completed":
            for step in task["steps"]:
                step["status"] = "completed"
                step["ended_at"] = utcnow_iso()
            task["ended_at"] = utcnow_iso()
        elif s == "in_progress":
            any_in_progress = True
            # leave steps pending; caller's hot path will update as it runs
        elif s in ("failed", "halted"):
            task["ended_at"] = utcnow_iso()

    if any_in_progress:
        state["run_status"] = "running"
    elif all(t["status"] == "completed" for t in state["tasks"]) and state["tasks"]:
        state["run_status"] = "completed"
        state["ended_at"] = utcnow_iso()

    return state


def _mark_to_status(mark: str) -> str:
    return {
        " ": "pending",
        "x": "completed",
        "!": "failed",
        "H": "halted",
        "~": "in_progress",
        "-": "skipped",
    }.get(mark, "pending")


# --------------------------------------------------------------------------
# Migration driver
# --------------------------------------------------------------------------


def migrate_run(
    run_dir: Path,
    *,
    branch: str,
    slug: str,
    dry_run: bool = False,
    overwrite: bool = False,
) -> MigrationResult:
    """Convert a single run directory to the JSON-first layout."""
    prd_md = run_dir / "PRD.md"
    plan_md = run_dir / "TASK_PLAN.md"
    progress_md = run_dir / "PROGRESS.md"
    dispatch_legacy = run_dir / "dispatch-state.json"

    paths = RunPaths(
        root=run_dir,
        prd=run_dir / "prd.json",
        plan=run_dir / "plan.json",
        state=run_dir / "state.json",
        state_lock=run_dir / "state.json.lock",
        reports_dir=run_dir / "reports",
    )

    # PRD
    prd_written = False
    if prd_md.exists() and (not paths.prd.exists() or overwrite):
        prd = parse_prd_md(prd_md.read_text(encoding="utf-8"))
        if not dry_run:
            _write_json_atomic(paths.prd, prd)
        prd_written = True

    # Plan
    plan: dict | None = None
    plan_written = False
    if plan_md.exists() and (not paths.plan.exists() or overwrite):
        plan = parse_plan_md(plan_md.read_text(encoding="utf-8"))
        if not dry_run:
            _write_json_atomic(paths.plan, plan)
        plan_written = True
    elif paths.plan.exists():
        plan = json.loads(paths.plan.read_text(encoding="utf-8"))

    # State
    state_written = False
    if plan is not None and (not paths.state.exists() or overwrite):
        if progress_md.exists():
            state = derive_state_from_progress(
                progress_md.read_text(encoding="utf-8"),
                plan,
                slug=slug,
                branch=branch,
            )
        else:
            state = new_state(slug=slug, branch=branch, plan=plan)

        # Fold legacy dispatch-state.json into state.dispatch
        if dispatch_legacy.exists():
            try:
                legacy = json.loads(dispatch_legacy.read_text(encoding="utf-8"))
                if isinstance(legacy.get("dispatched"), list):
                    state.setdefault("dispatch", {"dispatched": []})
                    state["dispatch"]["dispatched"].extend(legacy["dispatched"])
            except json.JSONDecodeError:
                pass

        if not dry_run:
            _write_json_atomic(paths.state, state)
        state_written = True

    tasks_found = len(plan["tasks"]) if plan else 0
    steps_found = sum(len(t.get("steps", [])) for t in (plan["tasks"] if plan else []))

    return MigrationResult(
        run_dir=run_dir,
        prd_written=prd_written,
        plan_written=plan_written,
        state_written=state_written,
        tasks_found=tasks_found,
        steps_found=steps_found,
    )


def migrate_all(runs_root: Path, *, dry_run: bool = False, overwrite: bool = False) -> list[MigrationResult]:
    """Walk ``.prove/runs/`` and migrate every leaf run directory found.

    A leaf is any directory containing ``TASK_PLAN.md`` or ``PRD.md``. The
    branch is the first path component below ``runs_root``; the slug is
    the run directory name.
    """
    results: list[MigrationResult] = []
    if not runs_root.exists():
        return results

    for path in sorted(_iter_run_dirs(runs_root)):
        rel = path.relative_to(runs_root).parts
        if len(rel) == 1:
            # legacy top-level run (no branch namespace)
            branch = "main"
            slug = rel[0]
        else:
            branch = rel[0]
            slug = rel[-1]
        results.append(
            migrate_run(path, branch=branch, slug=slug, dry_run=dry_run, overwrite=overwrite)
        )
    return results


def _iter_run_dirs(runs_root: Path) -> Iterable[Path]:
    for entry in runs_root.rglob("*"):
        if entry.is_dir() and (
            (entry / "TASK_PLAN.md").exists() or (entry / "PRD.md").exists()
        ):
            yield entry


# --------------------------------------------------------------------------
# Markdown section helpers
# --------------------------------------------------------------------------


_SECTION_RE = re.compile(r"^##\s+(.+?)\s*$", re.MULTILINE)


def _split_sections(text: str) -> dict[str, str]:
    """Split markdown by ## headings; return {heading: body}."""
    out: dict[str, str] = {}
    matches = list(_SECTION_RE.finditer(text))
    for i, m in enumerate(matches):
        heading = m.group(1).strip()
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        out[heading] = text[start:end].strip()
    return out


def _first_present(sections: dict[str, str], candidates: Iterable[str]) -> str | None:
    for name in candidates:
        if name in sections:
            return sections[name]
    # Case-insensitive fallback
    lower = {k.lower(): v for k, v in sections.items()}
    for name in candidates:
        if name.lower() in lower:
            return lower[name.lower()]
    return None


_BULLET_RE = re.compile(r"^\s*[-*]\s+(.+?)\s*$", re.MULTILINE)


def _extract_bullets(text: str) -> list[str]:
    return [m.group(1).strip() for m in _BULLET_RE.finditer(text)]
