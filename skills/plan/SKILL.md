---
name: plan
description: Planning for tasks and individual steps. Use to plan a task (discovery-driven requirements gathering producing prd.json + plan.json for the orchestrator), plan implementation, or drill into a numbered plan step for design decisions, edge cases, and test strategy. Triggers on "plan a task", "plan this", "plan implementation", "requirements gathering", "plan step", "Let's work on step 1.2.3", "design decisions", "edge cases", "test strategy", "drill into step".
---

# Plan Skill

Unified planning entry point. Two modes:

- **Task mode** (`--task [description]`) — discovery-driven planning. Explores the codebase, gathers requirements, identifies edge cases, and writes `prd.json` + `plan.json` under `.prove/runs/<branch>/<slug>/` for the orchestrator.
- **Step mode** (`--step <id>`) — interactive drill into a specific numbered step (e.g., `1.2.3`) from the active run's `plan.json`. No code is written; produces requirements, design decisions, and a test strategy.

Default (no args): use `AskUserQuestion` to pick between the two modes.

## Mode Selection

When invoked without `--task` or `--step`:

```
AskUserQuestion:
  question: "What do you want to plan? Task-level discovery produces prd.json + plan.json. Step-level drill refines a single numbered step from the active run."
  header: "Plan"
  options:
    - label: "Task"
      description: "Discovery, requirements, and plan.json for a new task"
    - label: "Step"
      description: "Drill into a numbered step (e.g., 1.2.3) from the active plan.json"
```

Then ask free-form for the task description or step id, and route accordingly.

## Shared Constraints

- Do not write implementation code during planning — surface ambiguity instead of assuming.
- Reference existing code patterns from the codebase when discussing approaches.
- Follow `references/interaction-patterns.md` (project-level) for AskUserQuestion vs free-form decisions.

---

## Mode: Task

Iterative discovery and planning for a task in an existing codebase. Output: `prd.json` + `plan.json` under `.prove/runs/<branch>/<slug>/`.

### Phase 1: Initial Understanding

Gather from the user:
1. **Task description** — current vs. desired behavior, what triggered the need
2. **Success criteria** — measurable outcomes, completion signals
3. **Constraints** — what cannot change, compatibility, performance requirements

### Phase 2: Code Discovery

Delegate to the Explore sub-agent for find, imports, usages, structure, tests, history, todos, and analyze passes — it runs these traversals through its built-in tool surface.

1. Locate relevant files, execution paths, entry points
2. Map architecture, dependencies, integration points
3. Trace data flow — ingress, transformations, storage/output

### Phase 3: Research & Investigation

1. Technical research — approaches, trade-offs, libraries/patterns
2. Code archaeology — git history, related PRs, explanatory comments
3. Dependency analysis — what depends on this code, blast radius of changes

### Phase 4: Edge Case Discovery

Identify edge cases across input boundaries, state conditions, error scenarios. Use `references/edge-cases-checklist.md` by domain.

### Phase 5: Requirements Refinement

1. **Clarify ambiguities** — discrete interpretations: AskUserQuestion with options + "Research & proceed" (see `references/interaction-patterns.md`). Open-ended: free-form discussion.
2. **Uncover hidden requirements** — scaling, audit/compliance, logging
3. **Define boundaries** — explicit in/out of scope, stated assumptions

### Phase 6: Solution Design

1. High-level approach — strategy, key design decisions, architecture changes
2. Implementation strategy — where to change, order of operations, testing
3. Risk mitigation — rollback plan, feature flags, gradual rollout

### Phase 6.5: Scrum Task Link (before writing plan.json)

Link this run to a scrum backlog task so reconciliation (orchestrator completion -> scrum task state) can fire. The link is the optional top-level `task_id` field on `plan.json`.

1. Run `claude-prove scrum next-ready --limit 5 --json`. Three branches:

   - **Exit 0 with task list** -> scrum enabled, ready tasks exist. Present options via `AskUserQuestion`:
     ```
     question: "Which scrum task does this run deliver? Pick from the top 5 ready tasks, create a new one, or skip the link."
     header: "Scrum Task"
     options:
       - label: "<task_id>: <title>"  # one per returned task, up to 3
         description: "<task.status> / wave <task.wave>"
       - label: "Create new task"
         description: "Invoke `claude-prove scrum task create` inline and use the returned id"
       - label: "Skip"
         description: "Proceed without task_id (reconciliation is opt-in)"
     ```
     If the operator picks an existing task -> stamp `task_id: "<id>"` on plan.json.
     If they pick "Create new task" -> ask for a title (free-form), run `claude-prove scrum task create --title "<title>" --json`, parse the returned `id`, stamp it on plan.json.
     If they pick "Skip" -> omit `task_id` entirely.

   - **Exit 0 with empty list** -> scrum enabled but no ready tasks. Offer `AskUserQuestion` with "Create new task" and "Skip" (same flow as above, minus the existing-task options).

   - **Non-zero exit** -> scrum not enabled on this project. Omit `task_id` and proceed.

2. When stamping, the field is a free-form non-empty string — no regex validation. Absent is legal; empty string is rejected by the schema validator.

Task 4 (reconciler) consumes this field; setting it here is a no-op until the reconciler lands, but without it the reconciler cannot link runs to scrum tasks.

### Output Artifacts

After discovery, emit two JSON files under `.prove/runs/<branch>/<slug>/` — pick `<branch>` from the intent (`feature`, `fix`, `chore`, `refactor`, ...) and derive `<slug>` from a kebab-cased task name (max 40 chars).

Both files are validated by a PostToolUse hook against `packages/cli/src/topics/run-state/schemas.ts`. Invalid writes block.

#### prd.json

Shape (see `packages/cli/src/topics/run-state/schemas.ts` — `PRD_SCHEMA`):

```json
{
  "schema_version": "1",
  "kind": "prd",
  "title": "Human-readable title",
  "context": "Why this run exists (problem framing).",
  "goals": ["Concrete outcome 1", "Concrete outcome 2"],
  "scope": {
    "in": ["What's in"],
    "out": ["What's explicitly deferred"]
  },
  "acceptance_criteria": [
    "Testable criterion 1",
    "Testable criterion 2"
  ],
  "test_strategy": "High-level approach (unit, integration, manual).",
  "body_markdown": "Optional longer narrative sections (discovery notes, rollback plan, monitoring)."
}
```

#### plan.json

Shape (see `packages/cli/src/topics/run-state/schemas.ts` — `PLAN_SCHEMA`):

```json
{
  "schema_version": "1",
  "kind": "plan",
  "mode": "simple | full",
  "task_id": "SCRUM-42",
  "tasks": [
    {
      "id": "1.1",
      "title": "Setup config",
      "wave": 1,
      "deps": [],
      "description": "What this task accomplishes and why.",
      "acceptance_criteria": ["Criterion A", "Criterion B"],
      "worktree": {"path": "", "branch": ""},
      "steps": [
        {
          "id": "1.1.1",
          "title": "Add schema field",
          "description": "Add `foo` to SchemaX in module Y.",
          "acceptance_criteria": ["`tests/test_schema.py` asserts field present"]
        }
      ]
    }
  ]
}
```

**Task id convention**: `<wave>.<seq>` — wave groups parallelizable tasks, seq orders within a wave. Step id: `<task_id>.<step_seq>`. Orchestrator relies on these dotted ids.

**Mode**: `simple` when total step count is ≤3; `full` otherwise.

**Worktree**: leave empty at plan time; orchestrator fills this in when spawning the wave.

**task_id** (optional, top-level): scrum backlog task id linking this run. Set per Phase 6.5; omit when scrum is disabled or the operator skips the link.

### Initialize the Run

After writing `prd.json` + `plan.json`, initialize `state.json` with:

```bash
scripts/prove-run init \
  --branch <branch> --slug <slug> \
  --plan .prove/runs/<branch>/<slug>/plan.json \
  --prd .prove/runs/<branch>/<slug>/prd.json
```

This creates `state.json` with every task/step in `pending` and seeds an empty dispatch ledger. Required before `/prove:orchestrator` can run.

### Validation Awareness

Check `.claude/.prove.json` for configured validators — use those commands in task acceptance criteria. If absent, the orchestrator auto-detects at runtime. See `references/validation-config.md` (project-level).

---

## Mode: Step

Interactive planning for a specific step from the active run's `plan.json`. No code is written during this phase — planning only.

### 1. Parse the Step Reference

Extract the step id from the user's request (e.g., `1.2.3`). Resolve the active run via the worktree marker, then read the step with:

```bash
scripts/prove-run step-info <step-id>
```

Returns JSON: `{task, step, task_state, step_state}`. Use it to extract description, acceptance criteria, dependencies.

### 2. Create Planning Workspace

Scaffold `.prove/plans/plan_<step_id>/` with 8 template files. Substitute `STEP_ID` and `TITLE`, then create each file with its sections:

```bash
STEP_ID="<step-id>"
TITLE="<Task Title>"
TS="$(date +%Y-%m-%d\ %H:%M)"
WORKSPACE=".prove/plans/plan_${STEP_ID}"
mkdir -p "${WORKSPACE}"
```

Files and sections (create each with `cat > "${WORKSPACE}/<name>" <<EOF ... EOF`):

| File | Sections |
|------|----------|
| `00_task_overview.md` | Phase, Size (XS/S/M/L/XL/XXL), Status, Dependencies, Original Task Description, Verification Criteria, Related Tasks |
| `01_requirements.md` | Functional, Non-Functional (perf/errors/logging/security), Acceptance Criteria, Out of Scope |
| `02_design_decisions.md` | Approach Options (pros/cons per option), Selected Approach, Technical Choices, API/Interface Design |
| `03_open_questions.md` | Technical, Design, Requirements — each as `Q:` / `A:` pairs, resolved by filling in answers |
| `04_potential_issues.md` | Technical Risks (risk + mitigation), Edge Cases, Performance Concerns, Integration Points |
| `05_implementation_plan.md` | Prerequisites, Implementation Steps (action/files/validation each), Code Structure, Key Notes |
| `06_test_strategy.md` | Unit Tests, Integration Tests, Edge Case Tests, Manual Testing Steps, Test Coverage Goals |
| `progress.md` | Started (`${TS}`), Current Phase, Planning Checklist (8 items), Discussion Log |

Populate `06_test_strategy.md` with validators from `.claude/.prove.json`. See `references/validation-config.md` (project-level).

### 3. Interactive Planning

1. Present the task + step overview (rendered from plan.json)
2. Probe for missing requirements
3. Present design approaches with tradeoffs
4. Surface risks
5. Update planning files during discussion
6. Keep `progress.md` current (step-mode scratchpad, not state.json)

### 4. Question Patterns

- **Discrete interpretations**: AskUserQuestion with options. Include "Research & proceed" when 3 or fewer options.
- **Open-ended**: free-form ("What should happen when [edge case]?")
- **Validation**: "How will we know this works?" / "What does success look like?"

### 5. Handling Dependencies

Check `plan.json` `tasks[].deps` for prerequisites. If deps unmet, discuss whether to plan despite them, document interface assumptions, and consider mocks for testing.

### 6. Ready for Implementation

Verify: open questions resolved, implementation plan actionable, test strategy covers key scenarios, design decisions documented with rationale.

Use AskUserQuestion with header "Ready" and options: "Begin Implementation" / "Review Plan First".

On proceed: the orchestrator drives step execution — step-mode planning does not mutate `state.json`. Leave that to the orchestrator and its `run_state step start` / `step complete` calls.

---

## Resources

- `references/planning-patterns.md` — risk matrices, requirement patterns, design frameworks, complexity estimation (step mode)
- `references/edge-cases-checklist.md` — edge case checklist by domain (task mode)
- `assets/task-planning-prompts.md` — prompt templates for planning sessions (task mode)
- `packages/cli/src/topics/run-state/schemas.ts` — authoritative JSON schemas

## Committing

Delegate to the `commit` skill. Do not create ad-hoc commits.
