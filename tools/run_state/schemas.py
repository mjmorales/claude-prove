"""Schema definitions for .prove/runs/<branch>/<slug>/ artifact files.

Schemas use the field-spec DSL vendored in ``tools/run_state/_validator.py``:
  - type: "str" | "int" | "bool" | "list" | "dict" | "any"
  - required: bool (default False)
  - items: field spec for list items
  - fields: dict of field specs (known keys)
  - values: field spec for arbitrary dict values
  - enum: list of allowed literal values
  - description: human-readable description
  - default: default value (used by migrator / initializer)

Kind labels (``prd``, ``plan``, ``state``, ``report``) select which schema
applies to a given file path.
"""

from __future__ import annotations

from tools.run_state import CURRENT_SCHEMA_VERSION

STEP_STATUSES = [
    "pending",
    "in_progress",
    "completed",
    "failed",
    "skipped",
    "halted",
]

TASK_STATUSES = [
    "pending",
    "in_progress",
    "completed",
    "failed",
    "halted",
]

RUN_STATUSES = [
    "pending",
    "running",
    "completed",
    "failed",
    "halted",
]

REVIEW_VERDICTS = [
    "pending",
    "approved",
    "rejected",
    "n/a",
]

VALIDATOR_PHASES = ["build", "lint", "test", "custom", "llm"]
VALIDATOR_STATUSES = ["pending", "pass", "fail", "skipped"]


# --- prd.json ---

PRD_SCHEMA = {
    "kind": "prd",
    "version": CURRENT_SCHEMA_VERSION,
    "fields": {
        "schema_version": {
            "type": "str",
            "required": True,
            "description": "Schema version for migration tracking",
            "default": CURRENT_SCHEMA_VERSION,
        },
        "kind": {
            "type": "str",
            "required": True,
            "enum": ["prd"],
            "description": "Discriminator — must be 'prd'",
            "default": "prd",
        },
        "title": {
            "type": "str",
            "required": True,
            "description": "Short human-readable title for the run",
        },
        "context": {
            "type": "str",
            "required": False,
            "description": "Problem framing: why this run exists",
            "default": "",
        },
        "goals": {
            "type": "list",
            "required": False,
            "items": {"type": "str"},
            "description": "Concrete outcomes this run aims to deliver",
            "default": [],
        },
        "scope": {
            "type": "dict",
            "required": False,
            "fields": {
                "in": {
                    "type": "list",
                    "items": {"type": "str"},
                    "description": "Work included in this run",
                    "default": [],
                },
                "out": {
                    "type": "list",
                    "items": {"type": "str"},
                    "description": "Work explicitly deferred",
                    "default": [],
                },
            },
            "description": "In-scope and out-of-scope boundaries",
            "default": {"in": [], "out": []},
        },
        "acceptance_criteria": {
            "type": "list",
            "required": False,
            "items": {"type": "str"},
            "description": "Testable criteria that must hold for the run to succeed",
            "default": [],
        },
        "test_strategy": {
            "type": "str",
            "required": False,
            "description": "High-level testing approach",
            "default": "",
        },
        "body_markdown": {
            "type": "str",
            "required": False,
            "description": "Free-form markdown body (longer narrative sections)",
            "default": "",
        },
    },
}


# --- plan.json ---

_STEP_PLAN_SCHEMA = {
    "type": "dict",
    "fields": {
        "id": {
            "type": "str",
            "required": True,
            "description": "Dotted step id (e.g., '1.2.3' — task_id + step seq)",
        },
        "title": {
            "type": "str",
            "required": True,
            "description": "Short step title",
        },
        "description": {
            "type": "str",
            "required": False,
            "description": "What this step does and why",
            "default": "",
        },
        "acceptance_criteria": {
            "type": "list",
            "items": {"type": "str"},
            "required": False,
            "description": "Criteria this step must satisfy before completion",
            "default": [],
        },
    },
}

_TASK_PLAN_SCHEMA = {
    "type": "dict",
    "fields": {
        "id": {
            "type": "str",
            "required": True,
            "description": "Dotted task id (e.g., '1.2' — wave + seq)",
        },
        "title": {
            "type": "str",
            "required": True,
            "description": "Short task title",
        },
        "wave": {
            "type": "int",
            "required": True,
            "description": "Parallel execution wave (integer >= 1)",
        },
        "deps": {
            "type": "list",
            "items": {"type": "str"},
            "required": False,
            "description": "Task ids this task depends on",
            "default": [],
        },
        "description": {
            "type": "str",
            "required": False,
            "description": "What this task accomplishes",
            "default": "",
        },
        "acceptance_criteria": {
            "type": "list",
            "items": {"type": "str"},
            "required": False,
            "description": "Criteria the task must satisfy before review",
            "default": [],
        },
        "worktree": {
            "type": "dict",
            "required": False,
            "fields": {
                "path": {
                    "type": "str",
                    "required": False,
                    "description": "Absolute path to the task's git worktree",
                    "default": "",
                },
                "branch": {
                    "type": "str",
                    "required": False,
                    "description": "Branch name for this task's worktree",
                    "default": "",
                },
            },
            "description": "Worktree assignment (full-mode parallel orchestration)",
        },
        "steps": {
            "type": "list",
            "required": True,
            "items": _STEP_PLAN_SCHEMA,
            "description": "Ordered steps that make up this task",
        },
    },
}

PLAN_SCHEMA = {
    "kind": "plan",
    "version": CURRENT_SCHEMA_VERSION,
    "fields": {
        "schema_version": {
            "type": "str",
            "required": True,
            "description": "Schema version for migration tracking",
            "default": CURRENT_SCHEMA_VERSION,
        },
        "kind": {
            "type": "str",
            "required": True,
            "enum": ["plan"],
            "description": "Discriminator — must be 'plan'",
            "default": "plan",
        },
        "mode": {
            "type": "str",
            "required": False,
            "enum": ["simple", "full"],
            "description": "Orchestrator execution mode: simple (sequential) or full (parallel waves)",
            "default": "simple",
        },
        "tasks": {
            "type": "list",
            "required": True,
            "items": _TASK_PLAN_SCHEMA,
            "description": "All tasks in this run, ordered by id",
        },
    },
}


# --- state.json ---

_VALIDATOR_SUMMARY_SCHEMA = {
    "type": "dict",
    "fields": {
        "build": {"type": "str", "enum": VALIDATOR_STATUSES, "default": "pending"},
        "lint": {"type": "str", "enum": VALIDATOR_STATUSES, "default": "pending"},
        "test": {"type": "str", "enum": VALIDATOR_STATUSES, "default": "pending"},
        "custom": {"type": "str", "enum": VALIDATOR_STATUSES, "default": "pending"},
        "llm": {"type": "str", "enum": VALIDATOR_STATUSES, "default": "pending"},
    },
    "description": "Per-phase validator outcome summary",
}

_STEP_STATE_SCHEMA = {
    "type": "dict",
    "fields": {
        "id": {"type": "str", "required": True, "description": "Step id"},
        "status": {
            "type": "str",
            "required": True,
            "enum": STEP_STATUSES,
            "description": "Current lifecycle status",
            "default": "pending",
        },
        "started_at": {
            "type": "str",
            "required": False,
            "description": "ISO-8601 UTC timestamp when step entered in_progress",
            "default": "",
        },
        "ended_at": {
            "type": "str",
            "required": False,
            "description": "ISO-8601 UTC timestamp when step reached a terminal status",
            "default": "",
        },
        "commit_sha": {
            "type": "str",
            "required": False,
            "description": "Git SHA of the commit that completed this step",
            "default": "",
        },
        "validator_summary": {
            "type": "dict",
            "required": False,
            "fields": _VALIDATOR_SUMMARY_SCHEMA["fields"],
            "description": _VALIDATOR_SUMMARY_SCHEMA["description"],
            "default": {
                "build": "pending",
                "lint": "pending",
                "test": "pending",
                "custom": "pending",
                "llm": "pending",
            },
        },
        "halt_reason": {
            "type": "str",
            "required": False,
            "description": "Reason the step halted (validation failure, manual halt, etc.)",
            "default": "",
        },
    },
}

_TASK_STATE_SCHEMA = {
    "type": "dict",
    "fields": {
        "id": {"type": "str", "required": True, "description": "Task id"},
        "status": {
            "type": "str",
            "required": True,
            "enum": TASK_STATUSES,
            "description": "Task lifecycle status",
            "default": "pending",
        },
        "started_at": {"type": "str", "default": ""},
        "ended_at": {"type": "str", "default": ""},
        "review": {
            "type": "dict",
            "required": False,
            "fields": {
                "verdict": {
                    "type": "str",
                    "enum": REVIEW_VERDICTS,
                    "default": "pending",
                },
                "notes": {"type": "str", "default": ""},
                "reviewer": {"type": "str", "default": ""},
                "reviewed_at": {"type": "str", "default": ""},
            },
            "description": "Principal-architect review outcome (full mode)",
            "default": {"verdict": "pending", "notes": "", "reviewer": "", "reviewed_at": ""},
        },
        "steps": {
            "type": "list",
            "required": True,
            "items": _STEP_STATE_SCHEMA,
            "description": "Per-step state, mirrors plan.json tasks[].steps order",
        },
    },
}

_DISPATCH_ENTRY_SCHEMA = {
    "type": "dict",
    "fields": {
        "key": {"type": "str", "required": True, "description": "Dedup key (event + scope)"},
        "event": {"type": "str", "required": True, "description": "Reporter event name"},
        "timestamp": {"type": "str", "required": True, "description": "ISO-8601 UTC timestamp"},
    },
}

STATE_SCHEMA = {
    "kind": "state",
    "version": CURRENT_SCHEMA_VERSION,
    "fields": {
        "schema_version": {
            "type": "str",
            "required": True,
            "description": "Schema version for migration tracking",
            "default": CURRENT_SCHEMA_VERSION,
        },
        "kind": {
            "type": "str",
            "required": True,
            "enum": ["state"],
            "description": "Discriminator — must be 'state'",
            "default": "state",
        },
        "run_status": {
            "type": "str",
            "required": True,
            "enum": RUN_STATUSES,
            "description": "Overall run lifecycle status",
            "default": "pending",
        },
        "slug": {
            "type": "str",
            "required": True,
            "description": "Run slug (matches directory name under .prove/runs/<branch>/)",
        },
        "branch": {
            "type": "str",
            "required": False,
            "description": "Namespace branch under .prove/runs/ (e.g., 'feature', 'fix', 'main')",
            "default": "main",
        },
        "current_task": {
            "type": "str",
            "required": False,
            "description": "Task id currently executing (empty when none active)",
            "default": "",
        },
        "current_step": {
            "type": "str",
            "required": False,
            "description": "Step id currently executing (empty when none active)",
            "default": "",
        },
        "started_at": {"type": "str", "required": False, "default": ""},
        "updated_at": {"type": "str", "required": True, "description": "Last mutation timestamp"},
        "ended_at": {"type": "str", "required": False, "default": ""},
        "tasks": {
            "type": "list",
            "required": True,
            "items": _TASK_STATE_SCHEMA,
            "description": "Per-task execution state",
        },
        "dispatch": {
            "type": "dict",
            "required": False,
            "fields": {
                "dispatched": {
                    "type": "list",
                    "items": _DISPATCH_ENTRY_SCHEMA,
                    "description": "Reporter events already dispatched (dedup ledger)",
                    "default": [],
                }
            },
            "description": "Reporter dispatch ledger (replaces legacy dispatch-state.json)",
            "default": {"dispatched": []},
        },
    },
}


# --- reports/<step_id>.json ---

_VALIDATOR_RESULT_SCHEMA = {
    "type": "dict",
    "fields": {
        "name": {"type": "str", "required": True, "description": "Validator name"},
        "phase": {
            "type": "str",
            "required": True,
            "enum": VALIDATOR_PHASES,
            "description": "Validator phase",
        },
        "status": {
            "type": "str",
            "required": True,
            "enum": VALIDATOR_STATUSES,
            "description": "Outcome",
        },
        "duration_s": {
            "type": "int",
            "required": False,
            "description": "Runtime in seconds (int or float)",
            "default": 0,
        },
        "output": {
            "type": "str",
            "required": False,
            "description": "Truncated stdout/stderr on failure",
            "default": "",
        },
    },
}

REPORT_SCHEMA = {
    "kind": "report",
    "version": CURRENT_SCHEMA_VERSION,
    "fields": {
        "schema_version": {
            "type": "str",
            "required": True,
            "default": CURRENT_SCHEMA_VERSION,
        },
        "kind": {
            "type": "str",
            "required": True,
            "enum": ["report"],
            "default": "report",
        },
        "step_id": {"type": "str", "required": True, "description": "Step id this report covers"},
        "task_id": {"type": "str", "required": True, "description": "Parent task id"},
        "status": {
            "type": "str",
            "required": True,
            "enum": STEP_STATUSES,
            "description": "Terminal status captured in this report",
        },
        "started_at": {"type": "str", "required": False, "default": ""},
        "ended_at": {"type": "str", "required": False, "default": ""},
        "commit_sha": {"type": "str", "required": False, "default": ""},
        "diff_stats": {
            "type": "dict",
            "required": False,
            "fields": {
                "files_changed": {"type": "int", "default": 0},
                "insertions": {"type": "int", "default": 0},
                "deletions": {"type": "int", "default": 0},
            },
            "default": {"files_changed": 0, "insertions": 0, "deletions": 0},
        },
        "validators": {
            "type": "list",
            "required": False,
            "items": _VALIDATOR_RESULT_SCHEMA,
            "description": "Per-validator results for this step",
            "default": [],
        },
        "artifacts": {
            "type": "list",
            "required": False,
            "items": {"type": "str"},
            "description": "Paths to artifacts produced by the step (logs, diffs, etc.)",
            "default": [],
        },
        "notes": {
            "type": "str",
            "required": False,
            "description": "Free-form notes",
            "default": "",
        },
    },
}


SCHEMA_BY_KIND = {
    "prd": PRD_SCHEMA,
    "plan": PLAN_SCHEMA,
    "state": STATE_SCHEMA,
    "report": REPORT_SCHEMA,
}


def infer_kind(filename: str) -> str | None:
    """Return the schema kind for a given filename, or None if unknown.

    Matches on basename — callers pass the file's basename or full path.
    """
    import os

    base = os.path.basename(filename)
    if base == "prd.json":
        return "prd"
    if base == "plan.json":
        return "plan"
    if base == "state.json":
        return "state"
    # reports/<anything>.json
    parent = os.path.basename(os.path.dirname(filename))
    if parent == "reports" and base.endswith(".json"):
        return "report"
    return None
