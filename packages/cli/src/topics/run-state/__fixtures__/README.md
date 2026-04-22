# run-state parity fixtures

Reference captures for the `run-state` topic. The TS port must match the
retired `tools/run_state/` Python source byte-for-byte on stringified
validator findings — the guard/validate hooks pipe these to stderr and
agents read them.

## Layout

```
__fixtures__/
  README.md                 <- this file
  validator/
    capture.sh              <- regenerates validator captures
    cases.json              <- shared input set for both sides
    python-captures/<n>.json
    ts-captures/<n>.json
  schemas/
    capture.sh              <- regenerates schema-level captures
    cases.json              <- shared input set for both sides
    python-captures/<n>.json
    ts-captures/<n>.json
  state/
    capture.sh              <- regenerates state-engine captures
    sequences.json          <- shared mutator-sequence specs
    python-captures/<name>/ <- state.json, reports/*, sidecar.json
    ts-captures/<name>/     <- mirrors python-captures, asserted byte-equal
  render/
    capture.sh              <- regenerates render markdown/JSON captures
    cases.json              <- view/format/input mapping
    cases/*.json            <- canonical PRD/plan/state/report inputs
    python-captures/<n>.md  <- markdown captures
    python-captures/<n>.txt <- JSON captures (.txt skirts biome formatter)
    ts-captures/<n>.md
    ts-captures/<n>.txt
  integration/
    capture.sh              <- regenerates CLI integration captures
    cases.json              <- shared CLI-subcommand scenario specs
    python-captures/<name>/ <- final state.json + reports/* for each scenario
    ts-captures/<name>/     <- mirrors python-captures, asserted byte-equal
  hooks/
    capture.sh              <- regenerates hook stdout/stderr/exit captures
    cases.json              <- per-hook payload + optional fs setup
    python-captures/<name>/ <- stdout, stderr, exit for each case
    ts-captures/<name>/     <- mirrors python-captures, asserted byte-equal
```

## Regeneration

```bash
bash packages/cli/src/topics/run-state/__fixtures__/validator/capture.sh
bash packages/cli/src/topics/run-state/__fixtures__/schemas/capture.sh
bash packages/cli/src/topics/run-state/__fixtures__/state/capture.sh
bash packages/cli/src/topics/run-state/__fixtures__/render/capture.sh
bash packages/cli/src/topics/run-state/__fixtures__/integration/capture.sh
bash packages/cli/src/topics/run-state/__fixtures__/hooks/capture.sh
```

Each script:

1. Reads the shared `cases.json` (or scenarios spec).
2. Runs the Python source against each case, serializing output into
   `python-captures/<name>/...`.
3. Runs the TS port against each case, writing `ts-captures/<name>/...`.

Tests assert `python-captures/` and `ts-captures/` are byte-identical
per case — regeneration must be deterministic.

## Coverage

Validator engine (`validator/`) exercises each of the seven error
categories required by the task:

| Case                          | Category                          |
| ----------------------------- | --------------------------------- |
| `wrong_type_str`              | wrong-type (str)                  |
| `wrong_type_int`              | wrong-type (int)                  |
| `wrong_type_list`             | wrong-type (list)                 |
| `required_missing`            | required-missing                  |
| `enum_mismatch`               | enum-mismatch                     |
| `unknown_key`                 | unknown-key warning               |
| `nested_dict`                 | nested-dict descent               |
| `list_items_descent`          | list-items descent                |
| `values_spec_descent`         | value-spec descent (dict values)  |
| `default_preserves_user_value`| default does not overwrite user   |
| `roundtrip_ok`                | clean pass (no errors)            |

Schema captures (`schemas/`) exercise each `SCHEMA_BY_KIND` schema on a
canonical and a boundary case:

- `prd_valid`, `prd_missing_title`
- `plan_valid_minimal`, `plan_wave_wrong_type`
- `state_valid_empty_tasks`, `state_bad_run_status`, `state_dispatch_missing_fields`
- `report_valid_minimal`, `report_bad_status`
- `unknown_kind`

State-engine captures (`state/`) exercise mutator sequences end-to-end.
Timestamps are frozen via `PROVE_STATE_FROZEN_NOW` so both sides produce
identical output. Scenarios:

| Sequence                        | Coverage                               |
| ------------------------------- | -------------------------------------- |
| `happy_path`                    | init → start → validators → complete → report |
| `review_approved`               | taskReview verdict=approved            |
| `review_rejected`               | taskReview verdict=rejected            |
| `dispatch_miss_then_hit`        | dispatchHas miss + dispatchRecord dedup|
| `report_write_twice_overwrites` | reportWrite is overwrite-in-place      |
| `invalid_transition_error`      | StateError byte-parity on illegal FSM  |

Render captures (`render/`) cover every exported view (`renderPrd`,
`renderPlan`, `renderState`, `renderReport`, `renderSummary`,
`renderCurrent`) on canonical fixtures plus edge cases:

| Scenario                 | Coverage                                             |
| ------------------------ | ---------------------------------------------------- |
| `prd_full`               | full PRD with context, goals, scope, AC, body        |
| `prd_minimal`            | PRD with only the required `title`                   |
| `plan_multi_wave`        | multi-wave plan with deps, worktree, AC, steps       |
| `plan_empty`             | empty plan (no tasks) — header-only output           |
| `state_pending`          | fresh run, no timestamps beyond `updated_at`         |
| `state_in_progress`      | active run with validator summary per step           |
| `state_completed`        | completed run with approved review + dispatch ledger |
| `state_halted`           | halted run with rejected review + halt reason        |
| `report_completed`       | completed step report with diff stats + validators   |
| `report_halted`          | halted step with fenced validator output block       |
| `summary_*` / `current_*`| per-state summary text and current JSON/text branch  |

Integration captures (`integration/`) drive the CLI end-to-end from
both `python3 -m tools.run_state` and `bun run packages/cli/bin/run.ts
run-state`. Python patches `utcnow_iso` in-process via a tiny wrapper
script so timestamps frozen by `PROVE_STATE_FROZEN_NOW` match the TS
side. Scenarios:

| Scenario                | Coverage                                         |
| ----------------------- | ------------------------------------------------ |
| `init_only`             | init writes prd.json / plan.json / state.json    |
| `step_start`            | step start transitions step + task + run_status  |
| `validator_set`         | validator set overwrites phase slot              |
| `step_complete`         | step complete records commit_sha + advances      |
| `task_review_approved`  | task review verdict=approved, reviewer recorded  |
| `dispatch_record`       | dispatch record appends to ledger                |
| `step_halt`             | step halt marks task/run halted, captures reason |
| `report_write`          | report write serializes reports/<step_id>.json   |

Hook captures (`hooks/`) drive each Claude Code hook event against both
`tools/run_state/hook_*.py` and `bun run … run-state hook <event>` with
a shared tmpdir layout so `PROJECT` placeholders substitute identically.
Scenarios:

| Scenario                             | Coverage                                |
| ------------------------------------ | --------------------------------------- |
| `guard/block_state`                  | deny Write on `state.json`              |
| `guard/block_state_backslash`        | backslash path normalization            |
| `guard/allow_non_state`              | `plan.json` writes pass                 |
| `guard/multi_edit_state`             | MultiEdit tool also denied              |
| `guard/non_mutating_tool`            | Read/Bash bypass the hook               |
| `guard/malformed_payload`            | silent no-op on non-JSON stdin          |
| `validate/valid_plan`                | valid plan.json → pass                  |
| `validate/invalid_plan`              | missing tasks → block + findings        |
| `validate/valid_prd`                 | valid prd.json → pass                   |
| `validate/invalid_prd`               | missing title → block                   |
| `validate/valid_report`              | reports/*.json schema match             |
| `validate/non_run_state_path`        | ignore non-`.prove/runs/` paths         |
| `validate/non_mutating_tool`         | ignore Bash tool                        |
| `session_start/resume_active_run`    | emits `additionalContext`               |
| `session_start/compact_active_run`   | halted run still surfaced               |
| `session_start/no_active_run`        | silent when no runs exist               |
| `session_start/skips_completed_runs` | completed runs filtered out             |
| `stop/no_active_runs`                | silent when `.prove/runs/` missing      |
| `stop/no_inprogress`                 | no change when nothing in progress      |
| `subagent_stop/no_slug_marker`       | silent when no worktree marker found    |
| `subagent_stop/no_payload`           | silent on empty stdin                   |

## Provenance

- Date captured: 2026-04-22
- Python: `python3` (3.13+ on Darwin arm64)
- Bun: workspace pinned (`bun@1.2.22` per root `package.json`)
- Plugin version at capture: v0.38.0+
- Schema version: `CURRENT_SCHEMA_VERSION = "1"` (`tools/run_state/__init__.py`)
