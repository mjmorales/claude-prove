"""JIT markdown rendering for run-state artifacts.

Every human-readable view (``/prove:progress``, run summary, handoff
context) is materialized from the underlying JSON. No markdown is
persisted — presentations are derived on demand so the JSON stays the
single source of truth.
"""

from __future__ import annotations

from typing import Any

STATUS_BADGES = {
    "pending": "[ ]",
    "in_progress": "[~]",
    "completed": "[x]",
    "failed": "[!]",
    "halted": "[H]",
    "skipped": "[-]",
    "pass": "PASS",
    "fail": "FAIL",
    "approved": "APPROVED",
    "rejected": "REJECTED",
    "running": "RUNNING",
    "n/a": "N/A",
}


def _badge(status: str) -> str:
    return STATUS_BADGES.get(status, status)


def render_prd(prd: dict) -> str:
    """Render a PRD as markdown."""
    lines: list[str] = []
    lines.append(f"# {prd.get('title', 'Untitled')}")
    lines.append("")
    context = prd.get("context") or ""
    if context:
        lines.append("## Context")
        lines.append("")
        lines.append(context)
        lines.append("")

    goals = prd.get("goals") or []
    if goals:
        lines.append("## Goals")
        lines.append("")
        lines.extend(f"- {g}" for g in goals)
        lines.append("")

    scope = prd.get("scope") or {}
    in_scope = scope.get("in") or []
    out_scope = scope.get("out") or []
    if in_scope or out_scope:
        lines.append("## Scope")
        lines.append("")
        if in_scope:
            lines.append("**In scope**")
            lines.extend(f"- {s}" for s in in_scope)
            lines.append("")
        if out_scope:
            lines.append("**Out of scope**")
            lines.extend(f"- {s}" for s in out_scope)
            lines.append("")

    ac = prd.get("acceptance_criteria") or []
    if ac:
        lines.append("## Acceptance Criteria")
        lines.append("")
        lines.extend(f"- {c}" for c in ac)
        lines.append("")

    ts = prd.get("test_strategy") or ""
    if ts:
        lines.append("## Test Strategy")
        lines.append("")
        lines.append(ts)
        lines.append("")

    body = prd.get("body_markdown") or ""
    if body:
        lines.append(body.rstrip())
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def render_plan(plan: dict) -> str:
    """Render a plan as markdown."""
    lines: list[str] = []
    mode = plan.get("mode", "simple")
    lines.append(f"# Task Plan ({mode} mode)")
    lines.append("")

    tasks = plan.get("tasks") or []
    # Group by wave for readability
    waves: dict[int, list[dict]] = {}
    for t in tasks:
        waves.setdefault(int(t.get("wave", 1)), []).append(t)

    for wave in sorted(waves):
        lines.append(f"## Wave {wave}")
        lines.append("")
        for task in waves[wave]:
            lines.append(f"### Task {task['id']}: {task['title']}")
            deps = task.get("deps") or []
            if deps:
                lines.append(f"**Depends on:** {', '.join(deps)}")
            wt = task.get("worktree") or {}
            if wt.get("path") or wt.get("branch"):
                lines.append(f"**Worktree:** {wt.get('path', '')}")
                if wt.get("branch"):
                    lines.append(f"**Branch:** {wt['branch']}")
            desc = task.get("description") or ""
            if desc:
                lines.append("")
                lines.append(desc)
            ac = task.get("acceptance_criteria") or []
            if ac:
                lines.append("")
                lines.append("**Acceptance Criteria**")
                lines.extend(f"- {c}" for c in ac)
            steps = task.get("steps") or []
            if steps:
                lines.append("")
                lines.append("**Steps**")
                for s in steps:
                    lines.append(f"- `{s['id']}` {s['title']}")
            lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def render_state(state: dict, *, plan: dict | None = None) -> str:
    """Render run state as markdown."""
    lines: list[str] = []
    slug = state.get("slug", "?")
    branch = state.get("branch", "?")
    run_status = state.get("run_status", "pending")
    lines.append(f"# Run: {branch}/{slug}")
    lines.append("")
    lines.append(f"**Status:** {_badge(run_status)} `{run_status}`")
    if state.get("current_step"):
        lines.append(f"**Current step:** `{state['current_step']}`")
    if state.get("started_at"):
        lines.append(f"**Started:** {state['started_at']}")
    if state.get("ended_at"):
        lines.append(f"**Ended:** {state['ended_at']}")
    lines.append(f"**Updated:** {state.get('updated_at', '?')}")
    lines.append("")

    # Build a plan-id lookup for titles when plan is provided
    titles: dict[str, str] = {}
    if plan is not None:
        for t in plan.get("tasks") or []:
            titles[t["id"]] = t.get("title", "")
            for s in t.get("steps") or []:
                titles[s["id"]] = s.get("title", "")

    tasks = state.get("tasks") or []
    for task in tasks:
        tid = task["id"]
        ttitle = titles.get(tid, "")
        lines.append(f"## Task {tid} — {_badge(task['status'])} `{task['status']}`" + (f": {ttitle}" if ttitle else ""))
        review = task.get("review") or {}
        if review.get("verdict") and review["verdict"] != "pending":
            lines.append(f"**Review:** {_badge(review['verdict'])}")
            if review.get("notes"):
                lines.append(f"  _{review['notes']}_")
        lines.append("")
        for step in task.get("steps") or []:
            sid = step["id"]
            stitle = titles.get(sid, "")
            lines.append(f"- `{sid}` {_badge(step['status'])} {stitle}")
            if step.get("halt_reason"):
                lines.append(f"  - halt: {step['halt_reason']}")
            vs = step.get("validator_summary") or {}
            active = [f"{p}={v}" for p, v in vs.items() if v not in ("pending", "skipped")]
            if active:
                lines.append(f"  - validators: {', '.join(active)}")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def render_report(report: dict) -> str:
    """Render a per-step report as markdown."""
    lines: list[str] = []
    lines.append(f"# Step Report: `{report.get('step_id', '?')}`")
    lines.append("")
    lines.append(f"**Task:** `{report.get('task_id', '?')}`")
    lines.append(f"**Status:** {_badge(report.get('status', '?'))}")
    if report.get("commit_sha"):
        lines.append(f"**Commit:** `{report['commit_sha']}`")
    if report.get("started_at"):
        lines.append(f"**Started:** {report['started_at']}")
    if report.get("ended_at"):
        lines.append(f"**Ended:** {report['ended_at']}")
    lines.append("")

    diff = report.get("diff_stats") or {}
    if any(diff.get(k) for k in ("files_changed", "insertions", "deletions")):
        lines.append(
            f"**Diff:** {diff.get('files_changed', 0)} files, "
            f"+{diff.get('insertions', 0)} / -{diff.get('deletions', 0)}"
        )
        lines.append("")

    validators = report.get("validators") or []
    if validators:
        lines.append("## Validators")
        lines.append("")
        for v in validators:
            dur = v.get("duration_s", 0)
            lines.append(
                f"- **{v.get('name', '?')}** ({v.get('phase', '?')}): "
                f"{_badge(v.get('status', '?'))} ({dur}s)"
            )
            if v.get("output") and v.get("status") == "fail":
                lines.append("```")
                lines.append(v["output"].rstrip())
                lines.append("```")
        lines.append("")

    artifacts = report.get("artifacts") or []
    if artifacts:
        lines.append("## Artifacts")
        lines.append("")
        lines.extend(f"- `{a}`" for a in artifacts)
        lines.append("")

    notes = report.get("notes") or ""
    if notes:
        lines.append("## Notes")
        lines.append("")
        lines.append(notes.rstrip())
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def render_summary(state: dict, *, plan: dict | None = None) -> str:
    """One-screen status summary (used by /prove:progress)."""
    tasks = state.get("tasks") or []
    counts: dict[str, int] = {s: 0 for s in ("pending", "in_progress", "completed", "failed", "halted")}
    step_counts: dict[str, int] = dict(counts)
    for t in tasks:
        counts[t["status"]] = counts.get(t["status"], 0) + 1
        for s in t.get("steps") or []:
            step_counts[s["status"]] = step_counts.get(s["status"], 0) + 1

    lines: list[str] = []
    lines.append(f"Run {state.get('branch', '?')}/{state.get('slug', '?')}: {state.get('run_status', '?')}")
    lines.append(
        "Tasks — "
        + ", ".join(f"{k}: {v}" for k, v in counts.items() if v)
    )
    lines.append(
        "Steps — "
        + ", ".join(f"{k}: {v}" for k, v in step_counts.items() if v)
    )
    if state.get("current_step"):
        lines.append(f"Current: {state['current_step']}")
    return "\n".join(lines) + "\n"
