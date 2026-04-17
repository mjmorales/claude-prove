"""run_state — JSON-first run artifact management for .prove/runs/.

Splits run state into four artifact families, partitioned by write frequency:

- prd.json      — write-once (planning phase)
- plan.json     — write-once (structural plan)
- state.json    — hot path, mutated via blessed CLI only
- reports/<step_id>.json — per-step, write-once at step completion

See ``tools/run_state/README.md`` and
``.prove/decisions/2026-04-17-prove-runs-json-first.md`` for the design
rationale.
"""

from __future__ import annotations

CURRENT_SCHEMA_VERSION = "1"
