#!/usr/bin/env python3
"""run_state CLI — blessed writer for .prove/runs JSON artifacts.

Subcommands::

    python3 -m tools.run_state validate <file> [--kind prd|plan|state|report]
    python3 -m tools.run_state init --branch B --slug S --plan FILE [--prd FILE]
    python3 -m tools.run_state show [--runs-root DIR] [--branch B] [--slug S] [--kind state|plan|prd|report] [--format md|json]
    python3 -m tools.run_state step start <step_id>  ...
    python3 -m tools.run_state step complete <step_id> [--commit SHA]
    python3 -m tools.run_state step fail <step_id> [--reason TEXT]
    python3 -m tools.run_state step halt <step_id> [--reason TEXT]
    python3 -m tools.run_state validator set <step_id> <phase> <status>
    python3 -m tools.run_state task review <task_id> --verdict approved|rejected [--notes TEXT] [--reviewer NAME]
    python3 -m tools.run_state dispatch record <key> <event>
    python3 -m tools.run_state dispatch has <key>
    python3 -m tools.run_state report write <step_id> --status S [--commit SHA] [--json FILE]
    python3 -m tools.run_state migrate [--runs-root DIR] [--dry-run] [--overwrite]
    python3 -m tools.run_state current [--format json|text]

The run is selected via ``--branch`` and ``--slug`` or auto-detected from
``PROVE_RUN_BRANCH`` / ``PROVE_RUN_SLUG`` environment variables. If only
``--slug`` is supplied, ``--branch`` defaults to ``main``.

Exit codes:
    0  success
    1  usage / validation error
    2  schema / state invariant violation (suitable for hook blocking)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# Make ``tools.*`` importable when run as a script from any cwd.
_THIS_DIR = Path(__file__).resolve().parent
_TOOLS_DIR = _THIS_DIR.parent
_REPO_ROOT = _TOOLS_DIR.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from tools.run_state import CURRENT_SCHEMA_VERSION  # noqa: E402
from tools.run_state import migrate as migrate_mod  # noqa: E402
from tools.run_state import render, state as state_mod  # noqa: E402
from tools.run_state.schemas import SCHEMA_BY_KIND, infer_kind  # noqa: E402
from tools.run_state.state import RunPaths, StateError  # noqa: E402
from tools.run_state.validate import validate_data, validate_file  # noqa: E402


# --------------------------------------------------------------------------
# Common arg parsing
# --------------------------------------------------------------------------


def _resolve_paths(args: argparse.Namespace) -> RunPaths:
    runs_root = Path(args.runs_root or _default_runs_root())

    slug = args.slug or os.environ.get("PROVE_RUN_SLUG") or _autodetect_slug()
    if not slug:
        _die(
            "no run slug found. Expected .prove-wt-slug.txt in the worktree root "
            "(written by skills/orchestrator/scripts/manage-worktree.sh create) or PROVE_RUN_SLUG env var. "
            "Run `skills/orchestrator/scripts/manage-worktree.sh create <slug> <task-id>` or set the marker manually.",
            code=2,
        )

    branch = args.branch or os.environ.get("PROVE_RUN_BRANCH") or _autodetect_branch(runs_root, slug)
    if not branch:
        _die(
            f"slug {slug!r} is not registered under {runs_root}. "
            "Expected .prove/runs/<branch>/<slug>/ to exist. "
            "Run `python3 -m tools.run_state init --branch <b> --slug <s> --plan ...` first.",
            code=2,
        )
    return RunPaths.for_run(runs_root, branch, slug)


def _autodetect_slug() -> str | None:
    """Walk from cwd upward looking for .prove-wt-slug.txt or .prove/RUN_SLUG."""
    cur = Path(os.getcwd()).resolve()
    for p in (cur, *cur.parents):
        wt_marker = p / ".prove-wt-slug.txt"
        if wt_marker.is_file():
            text = wt_marker.read_text(encoding="utf-8").strip()
            if text:
                return text
        run_marker = p / ".prove" / "RUN_SLUG"
        if run_marker.is_file():
            text = run_marker.read_text(encoding="utf-8").strip()
            if text:
                return text
        if (p / ".git").exists():
            break  # stop at repo root
    return None


def _autodetect_branch(runs_root: Path, slug: str) -> str | None:
    """Find the branch namespace whose <branch>/<slug>/state.json exists.

    Prefers directories with state.json; falls back to any with plan.json or
    prd.json so `init` can proceed before state.json exists.
    """
    if not runs_root.exists():
        return None
    state_matches = list(runs_root.glob(f"*/{slug}/state.json"))
    if state_matches:
        return state_matches[0].parent.parent.name
    other_matches = list(runs_root.glob(f"*/{slug}/plan.json")) + list(
        runs_root.glob(f"*/{slug}/prd.json")
    )
    if other_matches:
        return other_matches[0].parent.parent.name
    return None


def _default_runs_root() -> Path:
    project = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    return Path(project) / ".prove" / "runs"


def _die(msg: str, code: int = 1) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


def _add_run_selection(p: argparse.ArgumentParser) -> None:
    p.add_argument("--runs-root", help="Override .prove/runs root (default: $CLAUDE_PROJECT_DIR/.prove/runs)")
    p.add_argument("--branch", help="Run branch namespace (default: $PROVE_RUN_BRANCH or 'main')")
    p.add_argument("--slug", help="Run slug (default: $PROVE_RUN_SLUG)")


# --------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------


def cmd_validate(args: argparse.Namespace) -> None:
    data, errors = validate_file(args.file, kind=args.kind, strict=args.strict)
    for e in errors:
        print(str(e), file=sys.stderr)
    hard = [e for e in errors if e.severity == "error"]
    if hard:
        sys.exit(2)
    print(f"ok: {args.file}")


def cmd_init(args: argparse.Namespace) -> None:
    plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))
    prd = json.loads(Path(args.prd).read_text(encoding="utf-8")) if args.prd else None

    # Validate before writing
    plan_errors = validate_data(plan, "plan")
    if any(e.severity == "error" for e in plan_errors):
        for e in plan_errors:
            print(str(e), file=sys.stderr)
        sys.exit(2)
    if prd is not None:
        prd_errors = validate_data(prd, "prd")
        if any(e.severity == "error" for e in prd_errors):
            for e in prd_errors:
                print(str(e), file=sys.stderr)
            sys.exit(2)

    paths = _resolve_paths(args)
    try:
        state_mod.init_run(
            Path(args.runs_root or _default_runs_root()),
            paths.root.parent.name,
            paths.root.name,
            plan,
            prd=prd,
            overwrite=args.overwrite,
        )
    except StateError as e:
        _die(str(e), code=2)
    print(f"initialized: {paths.root}")


def cmd_show(args: argparse.Namespace) -> None:
    paths = _resolve_paths(args)
    kind = args.kind or "state"

    target = {
        "prd": paths.prd,
        "plan": paths.plan,
        "state": paths.state,
    }.get(kind)

    if kind == "report":
        _die("use `report show <step_id>` for report output", code=1)

    if target is None or not target.exists():
        _die(f"artifact missing: {target}", code=1)

    data = json.loads(target.read_text(encoding="utf-8"))
    if args.format == "json":
        print(json.dumps(data, indent=2))
        return

    if kind == "prd":
        sys.stdout.write(render.render_prd(data))
    elif kind == "plan":
        sys.stdout.write(render.render_plan(data))
    else:
        plan = None
        if paths.plan.exists():
            plan = json.loads(paths.plan.read_text(encoding="utf-8"))
        sys.stdout.write(render.render_state(data, plan=plan))


def cmd_step(args: argparse.Namespace) -> None:
    paths = _resolve_paths(args)
    try:
        if args.step_action == "start":
            state = state_mod.start_step(paths, args.step_id)
        elif args.step_action == "complete":
            state = state_mod.complete_step(paths, args.step_id, commit_sha=args.commit or "")
        elif args.step_action == "fail":
            state = state_mod.fail_step(paths, args.step_id, reason=args.reason or "")
        elif args.step_action == "halt":
            state = state_mod.halt_step(paths, args.step_id, reason=args.reason or "")
        else:
            _die(f"unknown step action: {args.step_action}")
    except StateError as e:
        _die(str(e), code=2)
    _print_result(args, state)


def cmd_validator(args: argparse.Namespace) -> None:
    paths = _resolve_paths(args)
    try:
        state = state_mod.set_validator(paths, args.step_id, args.phase, args.status)
    except StateError as e:
        _die(str(e), code=2)
    _print_result(args, state)


def cmd_task(args: argparse.Namespace) -> None:
    paths = _resolve_paths(args)
    try:
        if args.task_action == "review":
            state = state_mod.review_task(
                paths,
                args.task_id,
                verdict=args.verdict,
                notes=args.notes or "",
                reviewer=args.reviewer or "",
            )
        else:
            _die(f"unknown task action: {args.task_action}")
    except StateError as e:
        _die(str(e), code=2)
    _print_result(args, state)


def cmd_dispatch(args: argparse.Namespace) -> None:
    paths = _resolve_paths(args)
    if args.dispatch_action == "record":
        recorded = state_mod.record_dispatch(paths, args.key, args.event)
        print("recorded" if recorded else "duplicate")
        sys.exit(0 if recorded else 3)
    elif args.dispatch_action == "has":
        present = state_mod.has_dispatched(paths, args.key)
        print("yes" if present else "no")
        sys.exit(0 if present else 3)
    else:
        _die(f"unknown dispatch action: {args.dispatch_action}")


def cmd_report(args: argparse.Namespace) -> None:
    paths = _resolve_paths(args)
    if args.report_action == "write":
        report: dict
        if args.json:
            report = json.loads(Path(args.json).read_text(encoding="utf-8"))
        else:
            # Build a minimal report from flags
            plan = json.loads(paths.plan.read_text(encoding="utf-8"))
            task_id = _task_id_for_step(plan, args.step_id)
            report = {
                "schema_version": CURRENT_SCHEMA_VERSION,
                "kind": "report",
                "step_id": args.step_id,
                "task_id": task_id,
                "status": args.status,
                "commit_sha": args.commit or "",
                "started_at": "",
                "ended_at": state_mod.utcnow_iso(),
                "diff_stats": {"files_changed": 0, "insertions": 0, "deletions": 0},
                "validators": [],
                "artifacts": [],
                "notes": args.notes or "",
            }

        errors = validate_data(report, "report")
        if any(e.severity == "error" for e in errors):
            for e in errors:
                print(str(e), file=sys.stderr)
            sys.exit(2)
        target = state_mod.write_report(paths, report)
        print(f"wrote: {target}")
    elif args.report_action == "show":
        report = state_mod.read_report(paths, args.step_id)
        if report is None:
            _die(f"no report for step {args.step_id}", code=1)
        if args.format == "json":
            print(json.dumps(report, indent=2))
        else:
            sys.stdout.write(render.render_report(report))
    else:
        _die(f"unknown report action: {args.report_action}")


def cmd_migrate(args: argparse.Namespace) -> None:
    runs_root = Path(args.runs_root or _default_runs_root())
    results = migrate_mod.migrate_all(
        runs_root, dry_run=args.dry_run, overwrite=args.overwrite
    )
    for r in results:
        tag = "[dry]" if args.dry_run else ""
        print(
            f"{tag} {r.run_dir} — prd={r.prd_written} plan={r.plan_written} "
            f"state={r.state_written} tasks={r.tasks_found} steps={r.steps_found}"
        )
    print(f"\n{len(results)} runs processed")


def cmd_current(args: argparse.Namespace) -> None:
    paths = _resolve_paths(args)
    if not paths.state.exists():
        _die(f"no state.json at {paths.state}", code=1)
    state = state_mod.load_state(paths)
    if args.format == "json":
        print(json.dumps(state, indent=2))
    else:
        plan = None
        if paths.plan.exists():
            plan = json.loads(paths.plan.read_text(encoding="utf-8"))
        sys.stdout.write(render.render_summary(state, plan=plan))


def cmd_step_info(args: argparse.Namespace) -> None:
    """Print JSON describing a step: {task: {...}, step: {...}, state: {...}}."""
    paths = _resolve_paths(args)
    if not paths.plan.exists():
        _die(f"no plan.json at {paths.plan}", code=1)
    plan = json.loads(paths.plan.read_text(encoding="utf-8"))
    state = state_mod.load_state(paths) if paths.state.exists() else None

    for task in plan.get("tasks", []):
        for step in task.get("steps", []):
            if step["id"] == args.step_id:
                step_state = None
                task_state = None
                if state is not None:
                    for ts in state.get("tasks", []):
                        if ts["id"] == task["id"]:
                            task_state = ts
                            for ss in ts.get("steps", []):
                                if ss["id"] == args.step_id:
                                    step_state = ss
                                    break
                            break
                print(
                    json.dumps(
                        {
                            "task": task,
                            "step": step,
                            "task_state": task_state,
                            "step_state": step_state,
                        },
                        indent=2,
                    )
                )
                return
    _die(f"step not found in plan: {args.step_id}")


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def _task_id_for_step(plan: dict, step_id: str) -> str:
    for t in plan.get("tasks", []):
        for s in t.get("steps", []):
            if s["id"] == step_id:
                return t["id"]
    _die(f"step {step_id} not found in plan")
    return ""


def _print_result(args: argparse.Namespace, state: dict) -> None:
    if args.format == "json":
        print(json.dumps(state, indent=2))
    else:
        plan_path = _resolve_paths(args).plan
        plan = None
        if plan_path.exists():
            plan = json.loads(plan_path.read_text(encoding="utf-8"))
        sys.stdout.write(render.render_summary(state, plan=plan))


# --------------------------------------------------------------------------
# Arg parser
# --------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="run_state", description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="command", required=True)

    # validate
    pv = sub.add_parser("validate", help="Validate a JSON artifact against its schema")
    pv.add_argument("file")
    pv.add_argument("--kind", choices=sorted(SCHEMA_BY_KIND.keys()), help="Override schema kind")
    pv.add_argument("--strict", action="store_true", help="Treat warnings as errors")
    pv.set_defaults(func=cmd_validate)

    # init
    pi = sub.add_parser("init", help="Initialize a new run directory from plan + prd JSON")
    _add_run_selection(pi)
    pi.add_argument("--plan", required=True, help="Path to plan.json input file")
    pi.add_argument("--prd", help="Path to prd.json input file (optional)")
    pi.add_argument("--overwrite", action="store_true")
    pi.set_defaults(func=cmd_init)

    # show
    ps = sub.add_parser("show", help="Render artifact as markdown or JSON")
    _add_run_selection(ps)
    ps.add_argument("--kind", choices=["prd", "plan", "state"], default="state")
    ps.add_argument("--format", choices=["md", "json"], default="md")
    ps.set_defaults(func=cmd_show)

    # step <action>
    pstep = sub.add_parser("step", help="Step lifecycle mutations")
    _add_run_selection(pstep)
    pstep.add_argument("--format", choices=["md", "json"], default="md")
    pstep_sub = pstep.add_subparsers(dest="step_action", required=True)

    for action in ("start", "complete", "fail", "halt"):
        pa = pstep_sub.add_parser(action)
        pa.add_argument("step_id")
        if action == "complete":
            pa.add_argument("--commit", help="Git SHA of the completing commit")
        if action in ("fail", "halt"):
            pa.add_argument("--reason", help="Reason captured in step.halt_reason")
    pstep.set_defaults(func=cmd_step)

    # validator set
    pval = sub.add_parser("validator", help="Validator summary mutations")
    _add_run_selection(pval)
    pval.add_argument("--format", choices=["md", "json"], default="md")
    pval_sub = pval.add_subparsers(dest="validator_action", required=True)
    pvs = pval_sub.add_parser("set")
    pvs.add_argument("step_id")
    pvs.add_argument("phase", choices=["build", "lint", "test", "custom", "llm"])
    pvs.add_argument("status", choices=["pending", "pass", "fail", "skipped"])
    pval.set_defaults(func=cmd_validator)

    # task review
    ptask = sub.add_parser("task", help="Task-level mutations")
    _add_run_selection(ptask)
    ptask.add_argument("--format", choices=["md", "json"], default="md")
    ptask_sub = ptask.add_subparsers(dest="task_action", required=True)
    ptr = ptask_sub.add_parser("review")
    ptr.add_argument("task_id")
    ptr.add_argument("--verdict", required=True, choices=["approved", "rejected", "pending", "n/a"])
    ptr.add_argument("--notes")
    ptr.add_argument("--reviewer")
    ptask.set_defaults(func=cmd_task)

    # dispatch
    pdisp = sub.add_parser("dispatch", help="Reporter dispatch ledger")
    _add_run_selection(pdisp)
    pdisp_sub = pdisp.add_subparsers(dest="dispatch_action", required=True)
    pdr = pdisp_sub.add_parser("record")
    pdr.add_argument("key")
    pdr.add_argument("event")
    pdh = pdisp_sub.add_parser("has")
    pdh.add_argument("key")
    pdisp.set_defaults(func=cmd_dispatch)

    # report
    prep = sub.add_parser("report", help="Per-step report operations")
    _add_run_selection(prep)
    prep.add_argument("--format", choices=["md", "json"], default="md")
    prep_sub = prep.add_subparsers(dest="report_action", required=True)
    prw = prep_sub.add_parser("write")
    prw.add_argument("step_id")
    prw.add_argument("--status", required=True, choices=["completed", "failed", "halted", "skipped"])
    prw.add_argument("--commit")
    prw.add_argument("--notes")
    prw.add_argument("--json", help="Path to full report JSON (overrides flag-built content)")
    prs = prep_sub.add_parser("show")
    prs.add_argument("step_id")
    prep.set_defaults(func=cmd_report)

    # migrate
    pmig = sub.add_parser("migrate", help="Convert legacy md-based runs to JSON-first layout")
    pmig.add_argument("--runs-root", help="Override .prove/runs root")
    pmig.add_argument("--dry-run", action="store_true")
    pmig.add_argument("--overwrite", action="store_true")
    pmig.set_defaults(func=cmd_migrate)

    # current
    pcur = sub.add_parser("current", help="Print one-screen summary of active run")
    _add_run_selection(pcur)
    pcur.add_argument("--format", choices=["json", "text"], default="text")
    pcur.set_defaults(func=cmd_current)

    # step-info
    psi = sub.add_parser("step-info", help="Print plan+state info for a single step as JSON")
    _add_run_selection(psi)
    psi.add_argument("step_id")
    psi.set_defaults(func=cmd_step_info)

    return p


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
