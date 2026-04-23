---
name: task-planner
description: Discovery-driven planning for tasks in existing codebases. Explores code, gathers requirements, identifies edge cases, and produces prd.json + plan.json under .prove/runs/<branch>/<slug>/ for the orchestrator.
---

# Task Planner Skill

Iterative discovery and planning for a task in an existing codebase. Output: `prd.json` + `plan.json` under `.prove/runs/<branch>/<slug>/`.

## Discovery Phases

### Phase 1: Initial Understanding

Gather from the user:
1. **Task description** — current vs. desired behavior, what triggered the need
2. **Success criteria** — measurable outcomes, completion signals
3. **Constraints** — what cannot change, compatibility, performance requirements

### Phase 2: Code Discovery

Explore the codebase using `scripts/code_explorer.py` (find, imports, usages, structure, tests, history, todos, analyze):
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

## Output Artifacts

After discovery, emit two JSON files under `.prove/runs/<branch>/<slug>/` — pick `<branch>` from the intent (`feature`, `fix`, `chore`, `refactor`, ...) and derive `<slug>` from a kebab-cased task name (max 40 chars).

Both files are validated by a PostToolUse hook against `packages/cli/src/topics/run-state/schemas.ts`. Invalid writes block.

### Phase 6.5: Scrum Task Link (before writing plan.json)

Link this run to a scrum backlog task so reconciliation (orchestrator completion -> scrum task state) can fire. The link is the optional top-level `task_id` field on `plan.json`.

1. Run `prove scrum next-ready --limit 5 --json`. Three branches:

   - **Exit 0 with task list** -> scrum enabled, ready tasks exist. Present options via `AskUserQuestion`:
     ```
     question: "Which scrum task does this run deliver? Pick from the top 5 ready tasks, create a new one, or skip the link."
     header: "Scrum Task"
     options:
       - label: "<task_id>: <title>"  # one per returned task, up to 3
         description: "<task.status> / wave <task.wave>"
       - label: "Create new task"
         description: "Invoke `prove scrum task create` inline and use the returned id"
       - label: "Skip"
         description: "Proceed without task_id (reconciliation is opt-in)"
     ```
     If the operator picks an existing task -> stamp `task_id: "<id>"` on plan.json.
     If they pick "Create new task" -> ask for a title (free-form), run `prove scrum task create --title "<title>" --json`, parse the returned `id`, stamp it on plan.json.
     If they pick "Skip" -> omit `task_id` entirely.

   - **Exit 0 with empty list** -> scrum enabled but no ready tasks. Offer `AskUserQuestion` with "Create new task" and "Skip" (same flow as above, minus the existing-task options).

   - **Non-zero exit** -> scrum not enabled on this project. Omit `task_id` and proceed.

2. When stamping, the field is a free-form non-empty string — no regex validation. Absent is legal; empty string is rejected by the schema validator.

Task 4 (reconciler) consumes this field; setting it here is a no-op until the reconciler lands, but without it the reconciler cannot link runs to scrum tasks.

### prd.json

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

### plan.json

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

## Validation Awareness

Check `.claude/.prove.json` for configured validators — use those commands in task acceptance criteria. If absent, the orchestrator auto-detects at runtime. See `references/validation-config.md`.

## Resources

- `scripts/code_explorer.py` — structured code exploration
- `assets/task-planning-prompts.md` — prompt templates for planning sessions
- `references/edge-cases-checklist.md` — edge case checklist by domain
- `references/interaction-patterns.md` — AskUserQuestion vs free-form patterns
- `packages/cli/src/topics/run-state/schemas.ts` — authoritative JSON schemas

## Committing

Delegate to the `commit` skill. Do not create ad-hoc commits.
